export const CURRENT_SESSION_STATE_VERSION = 1;

export type SessionState = Record<string, unknown>;

type SessionStateEnvelope = {
  v: number;
  state: SessionState;
};

export type SessionStateCodecErrorCode = 'INVALID_PAYLOAD' | 'UNSUPPORTED_VERSION';

export class SessionStateCodecError extends Error {
  readonly code: SessionStateCodecErrorCode;

  constructor(code: SessionStateCodecErrorCode, message: string) {
    super(message);
    this.name = 'SessionStateCodecError';
    this.code = code;
  }
}

export const encodeSessionState = (state: SessionState): string => {
  if (!isObjectRecord(state)) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: "state" must be an object.',
    );
  }

  const envelope: SessionStateEnvelope = {
    v: CURRENT_SESSION_STATE_VERSION,
    state,
  };

  return encodeBase64Url(JSON.stringify(envelope));
};

export const decodeSessionState = (encoded: string): SessionState => {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: encoded value must be a non-empty string.',
    );
  }

  const parsed = parseEnvelope(encoded);
  if (parsed.v !== CURRENT_SESSION_STATE_VERSION) {
    throw new SessionStateCodecError(
      'UNSUPPORTED_VERSION',
      `Unsupported session state version: ${parsed.v}. Supported version is ${CURRENT_SESSION_STATE_VERSION}.`,
    );
  }

  if (!Object.hasOwn(parsed, 'state')) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: missing required "state" field.',
    );
  }

  if (!isObjectRecord(parsed.state)) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: "state" must be an object.',
    );
  }

  return parsed.state;
};

const parseEnvelope = (encoded: string): SessionStateEnvelope => {
  let decodedJson = '';

  try {
    decodedJson = decodeBase64Url(encoded);
  } catch {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: unable to decode base64url string.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedJson);
  } catch {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: decoded value is not valid JSON.',
    );
  }

  if (!isObjectRecord(parsed)) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: decoded JSON must be an object.',
    );
  }

  if (!Object.hasOwn(parsed, 'v')) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: missing required "v" version field.',
    );
  }

  if (typeof parsed.v !== 'number' || !Number.isInteger(parsed.v) || parsed.v < 1) {
    throw new SessionStateCodecError(
      'INVALID_PAYLOAD',
      'Invalid session state payload: "v" must be a positive integer.',
    );
  }

  return parsed as SessionStateEnvelope;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const encodeBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const decodeBase64Url = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url characters.');
  }

  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddedBase64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(paddedBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
};
