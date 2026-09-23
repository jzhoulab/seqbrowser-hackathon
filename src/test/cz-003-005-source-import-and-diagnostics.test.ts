import { describe, expect, it } from 'vitest';

import { classifySourceDiagnostic } from '../features/sources/diagnostics';
import { validateSourceImport } from '../features/sources/importValidation';

describe('CZ-003/CZ-004 source import validation', () => {
  it('accepts supported local source extensions', () => {
    expect(validateSourceImport('tracks/signal.bw')).toEqual({
      isValid: true,
      sourceType: 'local',
      extension: 'bw',
    });

    expect(validateSourceImport('./tracks/annotation.bigWig')).toEqual({
      isValid: true,
      sourceType: 'local',
      extension: 'bigWig',
    });

    expect(validateSourceImport('/data/peaks.bb')).toEqual({
      isValid: true,
      sourceType: 'local',
      extension: 'bb',
    });

    expect(validateSourceImport('/data/genes.bigBed')).toEqual({
      isValid: true,
      sourceType: 'local',
      extension: 'bigBed',
    });

    expect(validateSourceImport('/packs/seqbro2-puffin.czpack')).toEqual({
      isValid: true,
      sourceType: 'local',
      extension: 'czpack',
    });
  });

  it('accepts supported URL source extensions', () => {
    expect(validateSourceImport('https://example.org/tracks/signal.bw')).toEqual({
      isValid: true,
      sourceType: 'url',
      extension: 'bw',
    });

    expect(validateSourceImport('https://cdn.example.org/files/annotation.bigWig?token=x')).toEqual({
      isValid: true,
      sourceType: 'url',
      extension: 'bigWig',
    });

    expect(validateSourceImport('http://data.example.org/peaks.bb#view')).toEqual({
      isValid: true,
      sourceType: 'url',
      extension: 'bb',
    });

    expect(validateSourceImport('https://data.example.org/genes.bigBed')).toEqual({
      isValid: true,
      sourceType: 'url',
      extension: 'bigBed',
    });

    expect(validateSourceImport('https://data.example.org/packs/model.czpack')).toEqual({
      isValid: true,
      sourceType: 'url',
      extension: 'czpack',
    });
  });

  it('rejects explicit unsupported source extensions', () => {
    expect(validateSourceImport('tracks/signal.bam')).toEqual({
      isValid: false,
      sourceType: 'local',
      reason: 'unsupported-extension',
      extension: 'bam',
    });

    expect(validateSourceImport('https://example.org/tracks/signal.bedGraph')).toEqual({
      isValid: false,
      sourceType: 'url',
      reason: 'unsupported-extension',
      extension: 'bedGraph',
    });

    expect(validateSourceImport('https://example.org/tracks/signal')).toEqual({
      isValid: false,
      sourceType: 'url',
      reason: 'missing-extension',
    });
  });
});

describe('CZ-005 source diagnostics classifier', () => {
  it('classifies CORS failures', () => {
    expect(
      classifySourceDiagnostic({ message: 'Access to fetch has been blocked by CORS policy.' }),
    ).toBe('cors');
  });

  it('classifies missing range support failures', () => {
    expect(
      classifySourceDiagnostic({ message: 'Server does not support Range requests (Accept-Ranges).' }),
    ).toBe('no-range-support');
  });

  it('classifies authentication/authorization failures', () => {
    expect(classifySourceDiagnostic({ status: 401, message: 'Unauthorized' })).toBe('auth');
    expect(classifySourceDiagnostic({ status: 403, message: 'Forbidden' })).toBe('auth');
  });

  it('classifies not-found failures', () => {
    expect(classifySourceDiagnostic({ status: 404, message: 'Not Found' })).toBe('not-found');
  });

  it('classifies unknown failures when no rule matches', () => {
    expect(classifySourceDiagnostic({ message: 'socket hang up' })).toBe('unknown');
  });
});
