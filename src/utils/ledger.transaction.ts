import { libs, makeTxBytes } from '@waves/waves-transactions';

export interface LedgerAccount {
    address: string;
    publicKey: string;
    index: number;
    chainId: number;
}

export interface LedgerSigningData {
    dataBuffer: Uint8Array;
    dataType: number;
    dataVersion: number;
    amountPrecision: number;
    amount2Precision: number;
    feePrecision: number;
}

export async function signLedgerTransaction(
    original: any,
    account: LedgerAccount,
    chainId: number,
    proofIndex: number,
    sign: (data: LedgerSigningData) => Promise<string>,
    decimals: (assetId?: string | null) => Promise<number>,
    cancelled: () => boolean = () => false
): Promise<any> {
    if (!Number.isInteger(proofIndex) || proofIndex < 0 || proofIndex > 7) {
        throw new Error('Select a proof index between 1 and 8.');
    }
    if (account.chainId !== chainId || (original.chainId != null && original.chainId !== chainId)) {
        throw new Error('The transaction, Ledger account and selected network must match. Reconnect Ledger after changing networks.');
    }
    // Keep Long values and nested fields intact; only change top-level chainId/proofs.
    const tx = {...original};
    if (!tx.senderPublicKey || !tx.timestamp || tx.fee == null || !tx.version) {
        throw new Error('Prepare the transaction senderPublicKey, timestamp, fee and version before signing with Ledger.');
    }
    if (!Number.isInteger(tx.type) || tx.type < 3 || tx.type > 17) {
        throw new Error('This transaction type is not supported for Ledger signing.');
    }
    tx.chainId = chainId;
    const bytes = makeTxBytes(tx);
    let amountPrecision = 8;
    let amount2Precision = 8;
    if (tx.type === 3) amountPrecision = tx.decimals;
    if ([4, 5, 6, 11].includes(tx.type)) amountPrecision = await decimals(tx.assetId);
    if (tx.type === 16) {
        if ((tx.payment || []).length > 2) throw new Error('Ledger signing supports at most two invoke payments.');
        if (tx.payment && tx.payment[0]) amountPrecision = await decimals(tx.payment[0].assetId);
        if (tx.payment && tx.payment[1]) amount2Precision = await decimals(tx.payment[1].assetId);
    }
    const feePrecision = await decimals(tx.feeAssetId);
    if (cancelled()) throw new Error('Ledger signing cancelled.');
    const signature = await sign({
        dataBuffer: bytes, dataType: tx.type, dataVersion: tx.version,
        amountPrecision, amount2Precision, feePrecision
    });
    if (cancelled()) throw new Error('Ledger signing cancelled.');
    if (!libs.crypto.verifySignature(account.publicKey, bytes, signature)) {
        throw new Error('Ledger returned a signature that does not match this transaction. No proof was added.');
    }
    const proofs = (tx.proofs || []).slice();
    while (proofs.length <= proofIndex) proofs.push('');
    proofs[proofIndex] = signature;
    return {...tx, proofs};
}

// Do not publish partial results if a later approval is rejected or cancelled.
export async function signLedgerBatch(
    txs: any[], sign: (tx: any) => Promise<any>, cancelled: () => boolean
): Promise<any[]> {
    const result = [];
    for (const tx of txs) {
        if (cancelled()) throw new Error('Ledger signing cancelled.');
        result.push(await sign(tx));
    }
    if (cancelled()) throw new Error('Ledger signing cancelled.');
    return result;
}
