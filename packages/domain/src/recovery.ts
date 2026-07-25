export const shouldWriteRecoveryReceipt = (outcome: 'succeeded' | 'failed' | 'pending'): boolean => outcome === 'succeeded';
