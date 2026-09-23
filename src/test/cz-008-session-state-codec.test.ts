import { describe, expect, it } from 'vitest';

import {
  CURRENT_SESSION_STATE_VERSION,
  SessionStateCodecError,
  decodeSessionState,
  encodeSessionState,
  type SessionState,
} from '../features/session/stateCodec';

const toBase64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

describe('CZ-008 session state codec', () => {
  it('roundtrips state through URL-safe encoding', () => {
    const original: SessionState = {
      assemblyId: 'hg38',
      locus: { chr: 'chr7', start: 55019017, end: 55211628, bpPerPx: 2.5 },
      tracks: [
        { id: 'genes', kind: 'annotation' },
        { id: 'coverage', kind: 'signal' },
      ],
      ui: { sidebarOpen: true },
    };

    const encoded = encodeSessionState(original);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSessionState(encoded)).toEqual(original);
  });

  it('uses explicit schema versions and rejects unsupported versions', () => {
    const futureVersionPayload = toBase64Url({
      v: CURRENT_SESSION_STATE_VERSION + 1,
      state: { assemblyId: 'hg38' },
    });

    expect(() => decodeSessionState(futureVersionPayload)).toThrowError(SessionStateCodecError);
    expect(() => decodeSessionState(futureVersionPayload)).toThrow(
      /Unsupported session state version/,
    );
  });

  it('returns validation errors for invalid payloads', () => {
    expect(() => decodeSessionState('not-valid***')).toThrowError(SessionStateCodecError);

    const missingStatePayload = toBase64Url({ v: CURRENT_SESSION_STATE_VERSION });

    expect(() => decodeSessionState(missingStatePayload)).toThrowError(SessionStateCodecError);
    expect(() => decodeSessionState(missingStatePayload)).toThrow(/missing required "state"/i);
  });
});
