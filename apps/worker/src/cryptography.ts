import { decodeText, encodeText, fromBase64Url, randomToken, toArrayBuffer, toBase64Url } from './encoding';

export interface CipherEnvelope {
  algorithm: 'A256GCM';
  iv: string;
  ciphertext: string;
}

export interface WrappedAccountKey {
  masterKeyVersion: string;
  envelope: CipherEnvelope;
}

const importAesKey = async (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

const additionalData = (value: string): Uint8Array => encodeText(value);

export const encrypt = async (
  plaintext: string,
  key: CryptoKey,
  context: string,
): Promise<CipherEnvelope> => {
  const iv = fromBase64Url(randomToken(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData(context)), tagLength: 128 },
    key,
    toArrayBuffer(encodeText(plaintext)),
  );
  return { algorithm: 'A256GCM', iv: toBase64Url(iv), ciphertext: toBase64Url(encrypted) };
};

export const decrypt = async (
  envelope: CipherEnvelope,
  key: CryptoKey,
  context: string,
): Promise<string> => {
  if (envelope.algorithm !== 'A256GCM') throw new Error('Unsupported credential envelope.');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(fromBase64Url(envelope.iv)),
      additionalData: toArrayBuffer(additionalData(context)),
      tagLength: 128,
    },
    key,
    toArrayBuffer(fromBase64Url(envelope.ciphertext)),
  );
  return decodeText(plaintext);
};

export const masterKey = async (base64UrlKey: string): Promise<CryptoKey> => {
  const raw = fromBase64Url(base64UrlKey);
  if (raw.byteLength !== 32) throw new Error('CREDENTIAL_MASTER_KEY must be a base64url-encoded 32-byte key.');
  return importAesKey(raw);
};

export const createAccountKey = async (
  key: CryptoKey,
  masterKeyVersion: string,
  accountId: string,
): Promise<WrappedAccountKey> => {
  const raw = fromBase64Url(randomToken(32));
  const envelope = await encrypt(toBase64Url(raw), key, `organization-key:${accountId}`);
  return { masterKeyVersion, envelope };
};

export const unwrapAccountKey = async (
  wrapped: WrappedAccountKey,
  key: CryptoKey,
  accountId: string,
): Promise<CryptoKey> => {
  const raw = fromBase64Url(await decrypt(wrapped.envelope, key, `organization-key:${accountId}`));
  return importAesKey(raw);
};
