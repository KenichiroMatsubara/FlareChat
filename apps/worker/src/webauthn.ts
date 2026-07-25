import { decodeText, fromBase64Url, sha256, toArrayBuffer, toBase64Url } from './encoding';

interface CborMap extends Map<number, CborValue> {}
type CborValue = number | string | Uint8Array | CborMap | CborValue[] | boolean | null;

interface RegistrationResponse {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
}

export interface AuthenticationResponse {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  };
}

interface ClientData {
  type?: string;
  challenge?: string;
  origin?: string;
}

export interface RegisteredPasskey {
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  signCount: number;
  transports: string[];
}

export interface StoredPasskey {
  credentialId: string;
  publicKeyJwk: JsonWebKey;
  signCount: number;
}

const readLength = (bytes: Uint8Array, offset: number, additional: number): { length: number; next: number } => {
  if (additional < 24) return { length: additional, next: offset };
  if (additional === 24) return { length: bytes[offset] ?? fail('Unexpected CBOR end.'), next: offset + 1 };
  if (additional === 25) return { length: ((bytes[offset] ?? fail('Unexpected CBOR end.')) << 8) | (bytes[offset + 1] ?? fail('Unexpected CBOR end.')), next: offset + 2 };
  if (additional === 26) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return { length: view.getUint32(0), next: offset + 4 };
  }
  throw new Error('Unsupported CBOR length.');
};

const fail = (message: string): never => { throw new Error(message); };

const decodeCbor = (bytes: Uint8Array, initialOffset = 0): { value: CborValue; next: number } => {
  const head = bytes[initialOffset] ?? fail('Unexpected CBOR end.');
  const major = head >> 5;
  const { length, next } = readLength(bytes, initialOffset + 1, head & 31);
  if (major === 0) return { value: length, next };
  if (major === 1) return { value: -1 - length, next };
  if (major === 2) return { value: bytes.slice(next, next + length), next: next + length };
  if (major === 3) return { value: decodeText(bytes.slice(next, next + length)), next: next + length };
  if (major === 4) {
    const values: CborValue[] = [];
    let cursor = next;
    for (let index = 0; index < length; index += 1) {
      const decoded = decodeCbor(bytes, cursor);
      values.push(decoded.value);
      cursor = decoded.next;
    }
    return { value: values, next: cursor };
  }
  if (major === 5) {
    const map = new Map<number, CborValue>();
    let cursor = next;
    for (let index = 0; index < length; index += 1) {
      const key = decodeCbor(bytes, cursor);
      if (typeof key.value !== 'number') fail('Unsupported CBOR map key.');
      const value = decodeCbor(bytes, key.next);
      map.set(key.value as number, value.value);
      cursor = value.next;
    }
    return { value: map, next: cursor };
  }
  if (major === 7 && (head & 31) === 20) return { value: false, next };
  if (major === 7 && (head & 31) === 21) return { value: true, next };
  if (major === 7 && (head & 31) === 22) return { value: null, next };
  throw new Error('Unsupported CBOR value.');
};

const parseClientData = (encoded: string): ClientData => {
  try {
    return JSON.parse(decodeText(fromBase64Url(encoded))) as ClientData;
  } catch {
    throw new Error('Invalid WebAuthn client data.');
  }
};

const verifyClientData = async (
  encoded: string,
  expectedType: 'webauthn.create' | 'webauthn.get',
  expectedChallengeHash: string,
  origin: string,
): Promise<Uint8Array> => {
  const data = parseClientData(encoded);
  if (data.type !== expectedType || !data.challenge || data.origin !== origin) {
    throw new Error('WebAuthn challenge validation failed.');
  }
  if ((await sha256(data.challenge)) !== expectedChallengeHash) throw new Error('WebAuthn challenge expired or was reused.');
  return fromBase64Url(encoded);
};

const verifyAuthenticatorData = async (authenticatorData: Uint8Array, rpId: string): Promise<number> => {
  if (authenticatorData.byteLength < 37) throw new Error('Invalid authenticator data.');
  const expectedRpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(rpId))));
  const rpHash = authenticatorData.slice(0, 32);
  if (!rpHash.every((byte, index) => byte === expectedRpHash[index])) throw new Error('Passkey is for another relying party.');
  const flags = authenticatorData[32] ?? 0;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new Error('User verification is required.');
  return new DataView(authenticatorData.buffer, authenticatorData.byteOffset + 33, 4).getUint32(0);
};

const coseToJwk = (value: CborValue): JsonWebKey => {
  if (!(value instanceof Map)) throw new Error('Invalid credential public key.');
  const kty = value.get(1);
  const algorithm = value.get(3);
  const curve = value.get(-1);
  const x = value.get(-2);
  const y = value.get(-3);
  if (kty !== 2 || algorithm !== -7 || curve !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error('Only ES256 passkeys are supported.');
  }
  return { kty: 'EC', crv: 'P-256', x: toBase64Url(x), y: toBase64Url(y), ext: true };
};

export const verifyRegistration = async (
  value: RegistrationResponse,
  expectedChallengeHash: string,
  rpId: string,
  origin: string,
): Promise<RegisteredPasskey> => {
  if (value.type !== 'public-key' || value.id !== value.rawId) throw new Error('Invalid passkey response.');
  await verifyClientData(value.response.clientDataJSON, 'webauthn.create', expectedChallengeHash, origin);
  const decoded = decodeCbor(fromBase64Url(value.response.attestationObject));
  if (!(decoded.value instanceof Map)) throw new Error('Invalid passkey attestation.');
  const authData = decoded.value.get(2);
  if (!(authData instanceof Uint8Array)) throw new Error('Passkey attestation is missing authenticator data.');
  const signCount = await verifyAuthenticatorData(authData, rpId);
  const flags = authData[32] ?? 0;
  if ((flags & 0x40) === 0) throw new Error('Passkey attestation is missing credential data.');
  const credentialLength = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0);
  const credentialStart = 55;
  const credentialEnd = credentialStart + credentialLength;
  const credentialId = toBase64Url(authData.slice(credentialStart, credentialEnd));
  if (credentialId !== value.rawId) throw new Error('Passkey credential identifier mismatch.');
  const publicKey = decodeCbor(authData, credentialEnd).value;
  return {
    credentialId,
    publicKeyJwk: coseToJwk(publicKey),
    signCount,
    transports: value.response.transports?.filter((item) => typeof item === 'string') ?? [],
  };
};

export const verifyAuthentication = async (
  value: AuthenticationResponse,
  expectedChallengeHash: string,
  rpId: string,
  origin: string,
  stored: StoredPasskey,
): Promise<number> => {
  if (value.type !== 'public-key' || value.id !== stored.credentialId || value.rawId !== stored.credentialId) {
    throw new Error('Unknown passkey.');
  }
  const clientDataJson = await verifyClientData(value.response.clientDataJSON, 'webauthn.get', expectedChallengeHash, origin);
  const authenticatorData = fromBase64Url(value.response.authenticatorData);
  const signCount = await verifyAuthenticatorData(authenticatorData, rpId);
  if (stored.signCount > 0 && signCount <= stored.signCount) throw new Error('Passkey signature counter did not advance.');
  const key = await crypto.subtle.importKey('jwk', stored.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const signatureBase = new Uint8Array([
    ...authenticatorData,
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(clientDataJson))),
  ]);
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, toArrayBuffer(fromBase64Url(value.response.signature)), toArrayBuffer(signatureBase));
  if (!verified) throw new Error('Passkey signature is invalid.');
  return signCount;
};
