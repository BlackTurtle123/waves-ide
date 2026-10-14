import * as React from 'react';
import { IAccount } from '@stores';
import Select from '@src/components/Select';
import Button from '@src/components/Button';
import styles from './styles.less';
import classNames from 'classnames';
import Input from '@components/Input';
import { LedgerAccount } from '@utils/ledger.transaction';
import { ledgerUnavailableReason } from '@utils/ledger';

interface ITransactionSigningFormProps {
    signType: 'account' | 'seed' | 'wavesKeeper' | 'exchange' | 'ledger';
    ledgerAccounts: LedgerAccount[];
    ledgerAccount?: LedgerAccount;
    ledgerStatus: string;
    onLedgerAddressChange: (value: string) => void;
    onLedgerLoadMore: () => void;
    onLedgerVerify: () => void;
    onLedgerDisconnect: () => void;
    onLedgerConnect: () => void;
    onSignTypeChange: (v: string) => void;
    seed: string;
    availableProofIndexes: number[];
    proofIndex: number;
    accounts: IAccount[];
    selectedAccount: number;
    signDisabled: boolean;
    onSign: () => Promise<boolean>;
    onProofNChange: (v: string) => void;
    onSeedChange: (v: string) => void;
    onAccountChange: (v: string) => void;
    disableAwaitingConfirmation: () => void;
    isAwaitingConfirmation: boolean;
    deleteProof: () => void;
}

export default class TransactionSigningFormComponent extends React.Component<ITransactionSigningFormProps> {

    state = {
        justSigned: false
    };

    onSign = async () => {
        if (await this.props.onSign()) this.setState({justSigned: true});
    };

    onSeedChange = (e: React.ChangeEvent<HTMLInputElement>) => this.props.onSeedChange(e.target.value);


    render(): React.ReactNode {
        const keeperEnabled = typeof window.Waves === 'object';
        const {
            signType, onSignTypeChange, seed, proofIndex, availableProofIndexes, disableAwaitingConfirmation,
            onProofNChange, accounts, selectedAccount, onAccountChange, signDisabled, isAwaitingConfirmation,
            deleteProof
        } = this.props;
        const signOptions = [{value: 'seed', title: 'Seed phrase'}, {
            value: 'account',
            title: 'IDE Account'
        }, {value: 'exchange', title: 'waves.exchange'}, {value: 'ledger', title: 'Ledger (USB)'}];
        if (keeperEnabled) signOptions.push({value: 'wavesKeeper', title: 'Waves Keeper'});
        const {justSigned} = this.state;
        return isAwaitingConfirmation
            ? <WaitForWavesKeeper
                onCancel={disableAwaitingConfirmation}
                message={signType === 'ledger' ? this.props.ledgerStatus : undefined}
            />
            : (
                <div className={styles.signingForm} style={signType === 'ledger' ? {flexWrap: 'wrap'} : undefined}>
                    <div className={styles.signing_field}>
                        <div className={styles.signing_title}>Sign with</div>
                        <Select
                            options={signOptions}
                            name="SignWith"
                            className={styles.signing_select}
                            required={true}
                            value={signType}
                            onChange={onSignTypeChange}
                        />
                    </div>
                    <div className={styles.signing_field} style={signType === 'ledger' ? {display: 'none'} : undefined}>
                        {{
                            account: <>
                                <div className={styles.signing_title}>Account</div>
                                <Select
                                    className={styles.signing_select}
                                    required={true}
                                    value={accounts.length !== 0 ? selectedAccount : undefined}
                                    onChange={onAccountChange}
                                    disabled={availableProofIndexes.length === 0}
                                    options={accounts.map((acc, i) => ({title: acc.label, value: i}))}
                                />
                            </>,
                            seed: <>
                                <div className={styles.signing_title}>Seed to sign</div>
                                <Input
                                    invalid={seed === ''}
                                    value={seed}
                                    onChange={this.onSeedChange}
                                    className={styles.signing_input}
                                />
                            </>,
                            wavesKeeper: <>
                                <div className={styles.signing_title}/>
                                <div className={styles.signing_input}/>
                            </>,
                            ledger: null,
                            exchange: <>
                                <div className={styles.signing_title}/>
                                <div className={styles.signing_input}/>
                            </>
                        }[signType]}
                    </div>
                    <div className={styles.signing_field}>
                        <div className={styles.signing_title}>Proof index</div>
                        <Select options={availableProofIndexes.map((n => ({title: n + 1, value: n})))}
                                onChange={onProofNChange}
                                required={true}
                                name="N"
                                disabled={availableProofIndexes.length === 0}
                                value={proofIndex}
                                className={styles.signing_selectSmall}
                                invalid={
                                    availableProofIndexes.length > 0 && !availableProofIndexes.includes(proofIndex)
                                }
                        />
                    </div>

                    <div className={styles.signing_field}>
                        <div className={styles.signing_title}>Delete proof</div>
                        {<button
                            className={styles.delete_proofs}
                            disabled={signDisabled}
                            onClick={deleteProof}
                        >
                            <div className={styles.delete_icon}/>
                        </button>}
                    </div>

                    <div className={styles.signing_buttonField}>
                        {<button
                            className={styles[`signing_button${justSigned ? '-added' : ''}`]}
                            disabled={signDisabled}
                            onClick={justSigned ? () => this.setState({justSigned: false}) : this.onSign}
                            onBlur={() => this.setState({justSigned: false})}
                        >
                            <div className={justSigned ? styles.check : styles.plus}/>
                            {justSigned ? 'Sign added' : 'Add sign'}
                        </button>}
                    </div>
                    {signType === 'ledger' && <div style={{width: '100%', marginTop: 16}}>
                        <div style={{display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16}}>
                            <Button onClick={this.props.onLedgerConnect} disabled={!!ledgerUnavailableReason()}>
                                {this.props.ledgerAccounts.length ? 'Switch Ledger' : 'Connect Ledger'}
                            </Button>
                            {this.props.ledgerAccounts.length > 0 && <Button onClick={this.props.onLedgerLoadMore}>Load more addresses</Button>}
                            {this.props.ledgerAccount && <Button onClick={this.props.onLedgerVerify}>Verify address</Button>}
                            {this.props.ledgerAccounts.length > 0 && <Button onClick={this.props.onLedgerDisconnect}>Disconnect</Button>}
                        </div>
                        <div style={{marginTop: 12, overflowWrap: 'break-word', userSelect: 'text', WebkitUserSelect: 'text'}}>
                            {this.props.ledgerAccounts.length > 0 && <label>
                                Ledger address
                                <select aria-label="Ledger address" value={this.props.ledgerAccount ? this.props.ledgerAccount.address : ''}
                                        onChange={e => this.props.onLedgerAddressChange(e.target.value)}
                                        style={{display: 'block', width: '100%', padding: 10, marginTop: 6, marginBottom: 8}}>
                                    <option value="" disabled>Select an address</option>
                                    {this.props.ledgerAccounts.map(account => <option key={account.address} value={account.address}>
                                        {account.address}
                                    </option>)}
                                </select>
                            </label>}
                            {ledgerUnavailableReason() || (this.props.ledgerAccount
                                ? <>Public key: {this.props.ledgerAccount.publicKey}<br/>
                                    Ledger addresses and signer choices are remembered in this browser. Transaction sender and proofs are preserved.</>
                                : this.props.ledgerAccounts.length
                                    ? 'Choose your address. New addresses need confirmation once; verified addresses are remembered in this browser.'
                                    : 'Connect by USB, unlock Ledger with your PIN, and open the Waves app to load addresses.')}
                        </div>
                    </div>}
                </div>
            );
    }
}

const WaitForWavesKeeper = ({onCancel, message}: { onCancel: () => void, message?: string }) =>
    <div className={styles.signing_WaitKeeperRoot}>
        <div className={styles.signing_WaitKeeperText}>
            <div className={styles.signing_title_blue}>Waiting for confirmation</div>
            <div className={styles.signing_loading}>{message || 'Loading...'}</div>
        </div>
        <Button className={styles.signing_WaitKeeperBtn} onClick={onCancel}>Cancel</Button>
    </div>;
