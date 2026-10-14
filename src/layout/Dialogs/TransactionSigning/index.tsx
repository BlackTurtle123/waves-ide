import * as React from 'react';
import { inject, observer } from 'mobx-react';
import MonacoEditor from 'react-monaco-editor';
import { RouteComponentProps, withRouter } from 'react-router';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import debounce from 'debounce';
import { range } from '@utils/range';
import { AccountsStore, SettingsStore, SignerStore, UIStore } from '@stores';
import { schemas, schemaTypeMap, validators } from '@waves/tx-json-schemas';
import { broadcast, libs, signTx } from '@waves/waves-transactions';
import { signViaKeeper } from '@utils/waveskeeper';

import Dialog from '@src/components/Dialog';
import Button from '@src/components/Button';
import TransactionSigningForm from './TransactionSigningForm';
import styles from './styles.less';
import { DARK_THEME_ID, DEFAULT_THEME_ID } from '@src/setupMonaco';
import NotificationsStore from '@stores/NotificationsStore';
import { logToTagManager } from '@utils/logToTagManager';
import { signViaExchange } from '@utils/exchange.signer';
import { SuccessMessage } from '@src/layout/Dialogs/TransactionSigning/SuccessMessage';
import { SendingMultipleTransactions } from '@src/layout/Dialogs/SendingMultipleTransactions';
import { stringifyWithTabs } from '@src/layout/Dialogs/TransactionSigning/stringifyWithTabs';
import { LedgerConnection, ledgerError, ledgerUnavailableReason } from '@utils/ledger';
import { LedgerAccount, signLedgerBatch } from '@utils/ledger.transaction';

interface IInjectedProps {
    signerStore?: SignerStore;
    accountsStore?: AccountsStore;
    settingsStore?: SettingsStore;
    notificationsStore?: NotificationsStore;
    uiStore?: UIStore;
}

interface ITransactionEditorProps extends IInjectedProps, RouteComponentProps {
}

interface ITransactionEditorState {
    editorValue: string;
    proofIndex: number;
    seed: string;
    selectedAccount: number;
    signType: 'account' | 'seed' | 'wavesKeeper' | 'exchange' | 'ledger';
    ledgerAccounts: LedgerAccount[];
    ledgerAccount?: LedgerAccount;
    ledgerStatus: string;
    isAwaitingConfirmation: boolean;
    isMultipleSendDialogOpen: boolean;
    signedTxs: any[];
}

@inject('signerStore', 'settingsStore', 'accountsStore', 'notificationsStore', 'uiStore')
@observer
class TransactionSigning extends React.Component<ITransactionEditorProps, ITransactionEditorState> {
    private editor?: monaco.editor.ICodeEditor;
    private model?: monaco.editor.IModel;
    private ledger = new LedgerConnection();
    private ledgerEpoch = 0;
    private ledgerPending = false;
    private unmounted = false;

    private showMessage = (data: JSX.Element | string, opts = {}) =>
        this.props.notificationsStore!.notify(data, {closable: true, duration: 10, ...opts});

    state: ITransactionEditorState = {
        selectedAccount: this.props.accountsStore!.activeAccountIndex,
        editorValue: this.props.signerStore!.txJson,
        proofIndex: 0,
        seed: '',
        signType: 'account',
        ledgerAccounts: [],
        ledgerStatus: '',
        isAwaitingConfirmation: false,
        isMultipleSendDialogOpen: false,
        signedTxs: []
    };

    availableProofs = range(0, 8);

    handleLedgerConnect = async () => {
        if (this.ledgerPending) return;
        this.ledgerPending = true;
        const epoch = ++this.ledgerEpoch;
        this.setState({isAwaitingConfirmation: true, ledgerAccount: undefined, ledgerAccounts: [],
            ledgerStatus: 'Unlock Ledger, open Waves, and select your device to load addresses.'});
        try {
            const chainId = this.props.settingsStore!.defaultNode.chainId.charCodeAt(0);
            const accounts = await this.ledger.connect(chainId, () => epoch !== this.ledgerEpoch || this.unmounted);
            if (epoch !== this.ledgerEpoch || this.unmounted) {
                await this.ledger.disconnect();
                return;
            }
            this.setState({ledgerAccounts: accounts});
        } catch (error) {
            if (!this.unmounted && epoch === this.ledgerEpoch) this.showMessage(ledgerError(error), {type: 'error'});
        } finally {
            this.ledgerPending = false;
            if (!this.unmounted) this.setState({isAwaitingConfirmation: false});
        }
    };

    handleLedgerAddresses = async (address?: string) => {
        if (this.ledgerPending) return;
        const chosen = address ? this.state.ledgerAccounts.find(account => account.address === address) : undefined;
        if (address && !chosen) return;
        this.ledgerPending = true;
        const epoch = ++this.ledgerEpoch;
        const cancelled = () => epoch !== this.ledgerEpoch || this.unmounted;
        this.setState({isAwaitingConfirmation: true,
            ledgerAccount: chosen ? undefined : this.state.ledgerAccount,
            ledgerStatus: chosen ? 'Confirm the selected address on Ledger.' : 'Loading more Ledger addresses…'});
        try {
            const chainId = this.props.settingsStore!.defaultNode.chainId.charCodeAt(0);
            if (chosen) {
                const account = await this.ledger.selectAccount(chosen.index, chainId);
                if (account.address !== chosen.address) throw new Error('Ledger address changed. Reconnect and select your address again.');
                if (!cancelled()) this.setState({ledgerAccount: account});
            } else {
                const accounts = await this.ledger.discoverAccounts(this.state.ledgerAccounts.length, chainId, cancelled);
                if (!cancelled()) this.setState({ledgerAccounts: [...this.state.ledgerAccounts, ...accounts]});
            }
        } catch (error) {
            if (!cancelled()) this.showMessage(ledgerError(error), {type: 'error'});
        } finally {
            this.ledgerPending = false;
            if (cancelled()) {
                await this.ledger.disconnect();
                if (!this.unmounted) this.setState({ledgerAccount: undefined, ledgerAccounts: []});
            }
            if (!this.unmounted) this.setState({isAwaitingConfirmation: false});
        }
    };

    handleLedgerSign = async (): Promise<boolean> => {
        if (!this.editor || this.ledgerPending) return false;
        this.ledgerPending = true;
        const epoch = ++this.ledgerEpoch;
        const {editorValue, proofIndex} = this.state;
        const node = this.props.settingsStore!.defaultNode;
        const cancelled = () => epoch !== this.ledgerEpoch || this.unmounted;
        this.setState({isAwaitingConfirmation: true, ledgerStatus: 'Review and approve the transaction on Ledger.'});
        this.editor.updateOptions({readOnly: true});
        try {
            const input = libs.marshall.json.parseTx(editorValue);
            const transactions = Array.isArray(input) ? input : [input];
            const signed = await signLedgerBatch(transactions,
                tx => this.ledger.sign(tx, node.url, node.chainId.charCodeAt(0), proofIndex, cancelled), cancelled);
            if (cancelled()) return false;
            const value = stringifyWithTabs(Array.isArray(input) ? signed : signed[0]);
            this.editor.getModel()!.setValue(value);
            this.setState({editorValue: value, signedTxs: signed, proofIndex: Math.min(proofIndex + 1, 7)});
            return true;
        } catch (error) {
            if (!cancelled()) this.showMessage(ledgerError(error), {type: 'error'});
            return false;
        } finally {
            this.ledgerPending = false;
            if (this.unmounted) await this.ledger.disconnect();
            else {
                this.setState({isAwaitingConfirmation: false});
                this.editor.updateOptions({readOnly: false});
            }
        }
    };

    cancelConfirmation = () => {
        if (this.ledgerPending) {
            ++this.ledgerEpoch;
            this.setState({ledgerStatus: 'Cancelled. Dismiss the browser prompt or reject on Ledger to finish.'});
        } else this.setState({isAwaitingConfirmation: false});
    };

    handleSign = async () => {
        if (this.state.signType === 'ledger') return this.handleLedgerSign();
        if (!this.editor) return false;
        const accounts = this.props.accountsStore!.accounts;
        const {proofIndex, selectedAccount, signType, seed, editorValue} = this.state;

        const txOrTxs = libs.marshall.json.parseTx(editorValue);

        const signTxFromEditor = async (tx: any) => {
            if (!tx.chainId) tx.chainId = this.props.settingsStore!.defaultNode!.chainId.charCodeAt(0);
            let signedTx: any;
            const proofsBeforeSigning = tx.proofs as string[];
            tx.proofs = [];

            if (signType === 'wavesKeeper') {
                this.setState({isAwaitingConfirmation: true});
                this.editor?.updateOptions({readOnly: true});
                try {
                    signedTx = await signViaKeeper(tx);
                } catch (e) {
                    console.error(e);
                    this.setState({isAwaitingConfirmation: false});
                    this.editor?.updateOptions({readOnly: false});
                    return tx;
                }
                this.setState({isAwaitingConfirmation: false});
                this.editor?.updateOptions({readOnly: false});
            } else if (signType === 'exchange') {
                this.setState({isAwaitingConfirmation: true});
                this.editor?.updateOptions({readOnly: true});
                try {
                    signedTx = await signViaExchange(tx, this.props.settingsStore!.defaultNode.url);
                } catch (e) {
                    console.error(e);
                    // this.props.notificationsStore!.notify(e, {type: 'error'});
                    this.setState({isAwaitingConfirmation: false});
                    this.editor?.updateOptions({readOnly: false});
                    return tx;
                }
                this.setState({isAwaitingConfirmation: false});
                this.editor?.updateOptions({readOnly: false});
            } else {
                signedTx = signTx(tx, {[0]: signType === 'seed' ? seed : accounts[selectedAccount].seed});
            }

            if (signedTx.proofs.length) {
                const proof = signedTx.proofs[0];
                const newProofs = Array(proofIndex).join('.').split('.');
                if (proofsBeforeSigning && proofsBeforeSigning.length) {
                    proofsBeforeSigning.forEach((x, i) => newProofs[i] = x);
                }
                newProofs[proofIndex] = proof;
                signedTx.proofs = newProofs;
            }
            return signedTx;
        };

        let newEditorValue;
        if (Array.isArray(txOrTxs)) {
            let txs = [] as object[];
            const promises = txOrTxs.map(tx => signTxFromEditor(tx));
            Promise.all(promises).then(signedTxs => {
                signedTxs.forEach((tx, i) => {
                    if (tx.proofs && tx.proofs.length) {
                        txs = [...txs, tx];
                    } else {
                        txs = [...txs, txOrTxs[i]];
                    }
                });
                this.setState({signedTxs: txs});
                newEditorValue = `[${txs.map(tx => stringifyWithTabs(tx))}]`;
                this.setState({isAwaitingConfirmation: false});

                const model = this.editor?.getModel();
                if (model) {
                    model.setValue(newEditorValue);
                }
                this.setState({
                    editorValue: newEditorValue,
                    proofIndex: ++this.state.proofIndex
                });
            });
        } else {
            newEditorValue = await signTxFromEditor(txOrTxs).then(x => {
                if (x) {
                    return stringifyWithTabs(x);
                } else {
                    return libs.marshall.json.stringifyTx(txOrTxs);
                }
            });

            const model = this.editor.getModel();
            if (model) {
                model.setValue(newEditorValue);
            }
            this.setState({editorValue: newEditorValue, proofIndex: ++this.state.proofIndex});
        }
        return true;
    };


    handleSend = (txJson: string) => () => {
        const txOrTxs = libs.marshall.json.parseTx(txJson);
        const settingsStore = this.props.settingsStore!;
        const apiBase = settingsStore.defaultNode!.url;
        const nodeRequestOptions = settingsStore.nodeRequestOptions;

        const broadcastTx = (tx: any) => broadcast(tx, apiBase, nodeRequestOptions)
            .then(tx => {
                this.onClose();
                this.showMessage(<SuccessMessage id={tx.id}
                                                 node={this.props.settingsStore?.defaultNode}/>, {type: 'success'});

                // If setScript tx log event to tag manager
                if ([13, 15].includes(tx.type)) {
                    logToTagManager({
                        event: 'ideContractDeploy',
                        scriptType: tx.type === 13 ? 'account' : 'asset'
                    });
                }
            })
            .catch(e => {
                try {
                    const tx = libs.marshall.json.parseTx(txJson);
                    delete tx.proofs;
                    const newEditorValue = stringifyWithTabs(tx);
                    const model = this.editor!.getModel();
                    if (model) {
                        model.setValue(newEditorValue);
                    }

                    this.setState({
                        editorValue: newEditorValue,
                        proofIndex: 0
                    });

                    this.showMessage(
                        `Error occured.\n ERROR: ${JSON.stringify({...e, tx: undefined}, null, 4)}`,
                        {type: 'error'}
                    );
                } catch (e) {
                    this.showMessage('Error', {type: 'error'});
                }
            });

        if (Array.isArray(txOrTxs)) {
            this.setState({isMultipleSendDialogOpen: true});
        } else {
            broadcastTx(txOrTxs);
        }
    };

    updateStoreValue = debounce((newVal: string) => {
        this.props.signerStore!.setTxJson(newVal);
    }, 1000);

    handleEditorChange = (editorValue: string, e?: monaco.editor.IModelContentChangedEvent) => {
        this.setState({editorValue});
        this.updateStoreValue(editorValue);
    };

    parseInput = (value: string) => {
        let result: { error?: string } = {};
        try {
            const txObjOrArray = JSON.parse(value);

            const validateValue = (txOrTxs: any) => {
                const handleErrors = (tx: any) => {
                    const type = tx.type;
                    if (!type) {
                        if (validators.TTx(tx)) {
                            throw new Error(JSON.stringify(validators.TTx.errors));
                        }
                    }

                    const paramsValidator = schemaTypeMap[type] && schemaTypeMap[type].paramsValidator;
                    if (!paramsValidator) {
                        throw new Error(`Invalid TX type ${type}`);
                    }

                    if (!paramsValidator(tx)) {
                        throw new Error(JSON.stringify(paramsValidator.errors));
                    }
                };
                if (Array.isArray(txOrTxs)) {
                    txOrTxs.forEach(tx => {
                        handleErrors(tx);
                    });
                } else {
                    handleErrors(txOrTxs);
                }
            };

            if (Array.isArray(txObjOrArray)) {
                (txObjOrArray as Array<any>).forEach(tx => {
                    validateValue(tx);
                });
            } else {
                validateValue(txObjOrArray);
            }
        } catch (e) {
            // Todo: library should implement custom error field with array of validation errors
            result.error = e.message;
            try {
                result.error = JSON.parse(e.message)
                    .map((msg: string | { message: string, dataPath: string }) => typeof msg === 'string'
                        ? msg
                        : `${msg.dataPath} ${msg.message}`.trim()).join(', ');
            } catch (e) {
            }
        }

        return result;
    };

    editorDidMount = (e: monaco.editor.ICodeEditor, m: typeof monaco) => {
        this.editor = e;
        const modelUri = m.Uri.parse('schemas://transaction.json');
        this.model = m.editor.createModel(this.state.editorValue, 'json', modelUri);
        m.languages.json.jsonDefaults.setDiagnosticsOptions({
            validate: true,
            schemas: [{
                uri: schemas.TTxOrTxArray.$id, // id of the first schema
                fileMatch: [modelUri.toString()], // associate with our model
                schema: schemas.TTxOrTxArray
            }]
        });
        e.setModel(this.model);
        this.props.settingsStore!.theme === 'dark'
            ? m.editor.setTheme(DARK_THEME_ID)
            : m.editor.setTheme(DEFAULT_THEME_ID);
    };

    componentWillUnmount() {
        this.unmounted = true;
        ++this.ledgerEpoch;
        if (!this.ledgerPending) void this.ledger.disconnect();
        this.model && this.model.dispose();
    }

    onClose = () => this.props.history.push('/');

    onCloseMultipleSendDialog = () => this.setState({isMultipleSendDialogOpen: !this.state.isMultipleSendDialogOpen});

    deleteProof = () => {
        const txOrTxs = libs.marshall.json.parseTx(this.state.editorValue || '');
        const {proofIndex} = this.state;
        let result;
        const replaceOrDelete = (tx: any) => {
            if (tx.proofs && tx.proofs.length && proofIndex < tx.proofs.length) {
                if (tx.proofs && tx.proofs.length === (proofIndex + 1)) {
                    tx.proofs.splice(proofIndex, 1);
                } else {
                    tx.proofs[proofIndex] = '';
                }
            }
        };

        if (Array.isArray(txOrTxs)) {
            txOrTxs.forEach(tx => replaceOrDelete(tx));
        } else {
            replaceOrDelete(txOrTxs);
        }
        result = txOrTxs;
        this.setState({editorValue: stringifyWithTabs(result), signedTxs: result});
    };

    render() {
        const accounts = this.props.accountsStore!.accounts;
        const {
            editorValue,
            seed,
            proofIndex,
            selectedAccount,
            isAwaitingConfirmation,
            signType,
            isMultipleSendDialogOpen
        } = this.state;
        const {settingsStore} = this.props;
        const {error} = this.parseInput(editorValue);
        const signDisabled = !!error || !this.availableProofs.includes(proofIndex)
            || (signType === 'account' && (selectedAccount < 0 || accounts.length === 0))
            || (seed === '' && signType === 'seed')
            || (signType === 'ledger' && (!this.state.ledgerAccount || !!ledgerUnavailableReason()));


        let sendDisabled = true;
        try {
            const txOrTxs = JSON.parse(editorValue);
            if (Array.isArray(txOrTxs)) {
                sendDisabled = txOrTxs.map(tx => validators.TTx(tx)).some(x => !x);
            } else {
                sendDisabled = !validators.TTx(txOrTxs);
            }
        } catch (e) {
        }

        return (
            <>
                <Dialog
                    width={960}
                    height={800}
                    title="Sign and publish"
                    footer={<>
                        <Button className={styles.btn} onClick={this.onClose}>Cancel</Button>
                        <Button
                            className={styles.btn}
                            disabled={sendDisabled || isAwaitingConfirmation}
                            onClick={this.handleSend(editorValue)}
                            type="action-blue">
                            Publish
                        </Button>
                    </>}
                    onClose={this.onClose}
                    visible={true}
                    className={styles.root}

                >
                    <div className={styles.codeEditor}>
                        <MonacoEditor
                            height={307}
                            width={864}
                            onChange={this.handleEditorChange}
                            editorDidMount={this.editorDidMount}
                            options={{
                                readOnly: isAwaitingConfirmation,
                                scrollBeyondLastLine: false,
                                minimap: {enabled: false},
                                selectOnLineNumbers: true,
                                renderLineHighlight: 'none',
                                contextmenu: false,
                            }}
                            value={this.state.editorValue}
                        />
                    </div>
                    {editorValue
                        ? <div className={styles.errorMsg}>{error}</div>
                        : <div className={styles.errorMsg}>Paste your transaction or array of transactions here 👆</div>
                    }
                    <div className={styles.signing}>
                        <TransactionSigningForm
                            isAwaitingConfirmation={isAwaitingConfirmation}
                            disableAwaitingConfirmation={this.cancelConfirmation}
                            ledgerAccounts={this.state.ledgerAccounts}
                            ledgerAccount={this.state.ledgerAccount}
                            ledgerStatus={this.state.ledgerStatus}
                            onLedgerConnect={this.handleLedgerConnect}
                            onLedgerAddressChange={address => void this.handleLedgerAddresses(address)}
                            onLedgerLoadMore={() => void this.handleLedgerAddresses()}
                            signDisabled={signDisabled}
                            signType={signType}
                            onSignTypeChange={v => this.setState({signType: v as any})}
                            accounts={accounts}
                            selectedAccount={selectedAccount}
                            seed={seed}
                            availableProofIndexes={this.availableProofs}
                            proofIndex={proofIndex}
                            onSign={this.handleSign}
                            onAccountChange={v => this.setState({selectedAccount: +v})}
                            onProofNChange={v => this.setState({proofIndex: +v})}
                            onSeedChange={v => this.setState({seed: v})}
                            deleteProof={this.deleteProof}
                        />
                    </div>
                </Dialog>
                {isMultipleSendDialogOpen
                    ? <SendingMultipleTransactions
                        transactions={libs.marshall.json.parseTx(editorValue).filter((tx: any) => tx.proofs.length)}
                        visible={isMultipleSendDialogOpen}
                        handleClose={this.onCloseMultipleSendDialog}
                        networkOptions={{
                            nodeRequestOptions: settingsStore?.nodeRequestOptions,
                            defaultNode: settingsStore?.defaultNode!,
                        }}/>
                    : null}
            </>
        );
    }
}


export default withRouter(TransactionSigning);
