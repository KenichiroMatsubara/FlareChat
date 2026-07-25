const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBase64Url = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

export const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error('Invalid base64url value.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const encodeText = (value: string): Uint8Array => encoder.encode(value);
export const decodeText = (value: ArrayBuffer | Uint8Array): string => decoder.decode(value);
export const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

export const randomToken = (bytes = 32): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
};

export const sha256 = async (value: string): Promise<string> =>
  toBase64Url(await crypto.subtle.digest('SHA-256', toArrayBuffer(encodeText(value))));
