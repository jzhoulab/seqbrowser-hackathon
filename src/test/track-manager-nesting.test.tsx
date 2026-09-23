import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrackManagerPanel } from '../components/TrackManagerPanel';
import { buildTrackManagerView } from '../features/tracks/managerView';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, TrackSpec } from '../types';

// The Tracks panel nests a model's rows under its output collections when the
// pack has more than one, each collection with a heading, and wears the
// model's group colour on the collection.

function subtrack(id: string, groupId: string, groupLabel: string): ComputationalSubtrackSpec {
  return { id, name: id, kind: 'signal', color: '#2563eb', height: 60, outputName: 'pred', groupId, groupLabel };
}

const PACK: ComputationalPackManifest = {
  schemaVersion: 1,
  id: 'splice',
  name: 'Bars model',
  sequenceProvider: { type: 'ucsc', genome: 'hg38' },
  model: { format: 'onnx', url: '/m.onnx' },
  subtracks: [
    subtrack('donor', 'overview', 'Prediction'),
    subtrack('attrib-donor', 'attribution', 'Attribution'),
    subtrack('attrib-acceptor', 'attribution', 'Attribution'),
  ],
};

function record(subtrackId: string, order: number) {
  const sub = PACK.subtracks.find((s) => s.id === subtrackId)!;
  const spec: TrackSpec = {
    id: `splice-1:${subtrackId}`,
    name: sub.name,
    color: sub.color,
    height: 60,
    kind: 'signal',
    source: { type: 'computational', instanceId: 'splice-1', packUrl: '/p.czpack', pack: PACK, subtrack: sub },
  };
  return { spec, enabled: true, order };
}

const noop = () => undefined;

describe('TrackManagerPanel nesting', () => {
  it('lists a model collection with a heading per output collection, in the group colour', () => {
    const items = buildTrackManagerView([record('donor', 0), record('attrib-donor', 1), record('attrib-acceptor', 2)]);
    render(
      <TrackManagerPanel
        items={items}
        groupColors={new Map([['splice-1', '#0f766e']])}
        onToggle={noop}
        onMove={noop}
        onRename={noop}
        onDelete={noop}
        onBulkToggle={noop}
        onBulkDelete={noop}
        onBulkScale={noop}
      />,
    );
    // Model collections start folded; open it.
    fireEvent.click(screen.getByRole('button', { name: /Bars model/ }));
    const headings = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Prediction', 'Attribution']);
    const collection = document.querySelector('.track-manager-collection.model') as HTMLElement;
    expect(collection.style.getPropertyValue('--group-color')).toBe('#0f766e');
    expect(document.querySelectorAll('.track-manager-row[data-subgroup-id="attribution"]')).toHaveLength(2);
  });
});
