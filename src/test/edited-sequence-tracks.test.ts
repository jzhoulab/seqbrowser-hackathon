import { describe, expect, it } from 'vitest';
import { layoutTracksForEdits } from '../lib/editedSequenceTracks';
import type { ComputationalPackManifest, TrackSpec } from '../types';

// The row the user edits IS the sequence; the original drops beneath it as a
// reference. Every model output follows the edited sequence (re-run on it,
// shown above the reference) and also runs on the reference beneath, unless the
// user hid it on the edit. Data and annotation tracks are facts about genomic
// coordinates and follow the reference only.

function computationalPlot(id: string, packId = 'demo-bars-2ch', comparesEdits?: boolean): TrackSpec {
  const pack: ComputationalPackManifest = {
    schemaVersion: 1,
    id: packId,
    name: 'Model',
    sequenceProvider: { type: 'ucsc', genome: 'hg38' },
    model: { format: 'onnx', url: '/m.onnx' },
    plotGroups: [
      { id: 'pred', label: 'Prediction', subtrackIds: ['donor'], ...(comparesEdits === undefined ? {} : { comparesEdits }) },
    ],
    subtracks: [{ id: 'donor', name: 'Donor', kind: 'signal', color: '#2563EB', height: 76, outputName: 'out' }],
  };
  return {
    id, name: 'Prediction', kind: 'signal', color: '#2563EB', height: 96,
    source: { type: 'computational', instanceId: 'i1', packUrl: '/p.czpack', pack, subtrack: pack.subtracks[0]!, seriesSubtrackIds: ['donor'] },
  };
}

const bigwig: TrackSpec = { id: 'bw', name: 'H3K27ac', kind: 'signal', color: '#0ff', height: 76, source: { type: 'bigwig', url: 'https://x/y.bw' } };
const gencode: TrackSpec = { id: 'gc', name: 'GENCODE', kind: 'annotation', color: '#f00', height: 96, source: { type: 'bigbed', url: 'https://x/g.bb' } };

const oneEdit = { id: 'edited', edits: [{ kind: 'substitute' as const, start: 100, end: 101, sequence: 'A' }] };

describe('layoutTracksForEdits', () => {
  it('with no edits, returns the tracks untouched and no reference row', () => {
    const out = layoutTracksForEdits([computationalPlot('p'), bigwig, gencode], null);
    expect(out.map((t) => t.id)).toEqual(['p', 'bw', 'gc']);
  });

  it('with edits: edited model plots first, then the reference row, then everything on the reference', () => {
    const out = layoutTracksForEdits([computationalPlot('p'), bigwig, gencode], oneEdit);
    const ids = out.map((t) => t.id);
    expect(ids[0]).toBe('p:edited:edited');
    expect(ids[1]).toBe('sequence-reference');
    expect(ids.slice(2)).toEqual(['p', 'bw', 'gc']);
  });

  it('data and annotation tracks are never duplicated onto the edited sequence', () => {
    const out = layoutTracksForEdits([computationalPlot('p'), bigwig, gencode], oneEdit);
    expect(out.filter((t) => t.source.type === 'bigwig')).toHaveLength(1);
    expect(out.filter((t) => t.source.type === 'bigbed')).toHaveLength(1);
  });

  it('the edited plot carries the edits and keeps its name; its place says what it scored', () => {
    const out = layoutTracksForEdits([computationalPlot('p')], oneEdit);
    const edited = out[0];
    expect(edited.name).toBe('Prediction');
    expect(edited.source.type === 'computational' && edited.source.editRole).toBe('edited');
    expect(edited.source.type === 'computational' && edited.source.sequenceEdits).toEqual(oneEdit.edits);
  });

  it('works for any pack, whatever it is called', () => {
    const out = layoutTracksForEdits([computationalPlot('p', 'seqbro2-puffin')], oneEdit);
    expect(out[0].id).toBe('p:edited:edited');
  });

  it('re-runs every model output, whatever plot group it is in, and skips the ones hidden on the edit', () => {
    const summary = computationalPlot('summary', 'm', false);
    const detail = computationalPlot('detail', 'm', true);
    const ism: TrackSpec = { ...computationalPlot('ism', 'm'), name: 'Donor ISM' };
    const out = layoutTracksForEdits([summary, detail, ism, bigwig], oneEdit);
    const edited = out.filter((t) => t.source.type === 'computational' && t.source.editRole === 'edited');
    expect(edited.map((t) => t.id)).toEqual(['summary:edited:edited', 'detail:edited:edited', 'ism:edited:edited']);
    expect(edited.map((t) => t.source.type === 'computational' && t.source.editedFrom)).toEqual(['summary', 'detail', 'ism']);

    const trimmed = layoutTracksForEdits([summary, detail, ism, bigwig], oneEdit, new Set(['detail', 'ism']));
    expect(trimmed.filter((t) => t.source.type === 'computational' && t.source.editRole === 'edited').map((t) => t.id)).toEqual(['summary:edited:edited']);
    // Hiding on the edit never touches the reference copy.
    expect(trimmed.filter((t) => t.id === 'detail' || t.id === 'ism')).toHaveLength(2);
  });
});
