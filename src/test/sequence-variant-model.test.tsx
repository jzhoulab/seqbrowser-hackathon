import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { SequenceEdit } from '../types';
import { mockWorkspaceBrowser } from './workspaceBrowserMocks';

// The pinned sequence row is the one you edit. With no edits it is the
// reference and nothing else shows. With edits it becomes the edited sequence,
// and the original appears beneath as a reference track. A text field over the
// genome; the earlier model spawned a "Modified N" row per edit instead.

vi.mock('../components/RulerCanvas', () => ({ RulerCanvas: () => null }));
vi.mock('../components/BrushNavigator', () => ({ BrushNavigator: () => null }));
vi.mock('../components/TrackManagerPanel', () => ({ TrackManagerPanel: () => null }));

// The list takes rows (tracks plus the group headers derived from them); only
// the tracks matter here.
vi.mock('../components/TrackList', () => ({
  TrackList: (props: { rows: Array<{ kind: string; track?: { id: string; source: { type: string } } }> }) => (
    <ul aria-label="track rows">
      {props.rows.flatMap((row) => (row.kind === 'track' && row.track ? [row.track] : [])).map((track) => (
        <li key={track.id} data-kind={track.source.type}>{track.id}</li>
      ))}
    </ul>
  ),
}));

// The pinned strip: capture what it is given so the test can edit through it.
const pinned: { title?: string; edits?: SequenceEdit[]; onEditsChange?: (e: SequenceEdit[]) => void; onReset?: () => void } = {};
vi.mock('../components/SequenceStrip', () => ({
  SEQUENCE_STRIP_MAX_SPAN_BP: 12_000,
  SequenceStrip: (props: ComponentProps<'div'> & { title?: string; edits?: SequenceEdit[]; onEditsChange?: (e: SequenceEdit[]) => void; onReset?: () => void; embedded?: boolean }) => {
    if (!props.embedded) {
      pinned.title = props.title;
      pinned.edits = props.edits;
      pinned.onEditsChange = props.onEditsChange;
      pinned.onReset = props.onReset;
    }
    return null;
  },
}));

vi.mock('../data/computationalDataSource', () => ({ warmupComputationalModel: async () => undefined }));
vi.mock('../data/computationalPack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/computationalPack')>();
  return { ...actual, loadComputationalPack: async () => { throw new Error('offline in test'); } };
});

import App from '../App';

const referenceRows = () => screen.getByLabelText('track rows').querySelectorAll('li[data-kind="sequence-variant"]');
const edit = (e: SequenceEdit) => act(() => pinned.onEditsChange!([...(pinned.edits ?? []), e]));

beforeEach(() => {
  mockWorkspaceBrowser();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  pinned.title = undefined; pinned.edits = undefined; pinned.onEditsChange = undefined; pinned.onReset = undefined;
});
afterEach(cleanup);

describe('editing the sequence', () => {
  it('with no edits the pinned row is the reference and no reference track is shown', async () => {
    render(<App />);
    await waitFor(() => expect(pinned.onEditsChange).toBeDefined());
    expect(pinned.title).toBe('Sequence');
    expect(referenceRows()).toHaveLength(0);
  });

  it('the first edit makes the pinned row the edited sequence and shows the reference beneath', async () => {
    render(<App />);
    await waitFor(() => expect(pinned.onEditsChange).toBeDefined());

    await edit({ kind: 'substitute', start: 100, end: 101, sequence: 'A' });

    await waitFor(() => expect(referenceRows()).toHaveLength(1));
    expect(pinned.title).toBe('Edited sequence');
    expect(pinned.edits).toHaveLength(1);
  });

  it('further edits accumulate on the same sequence; there is still one reference', async () => {
    render(<App />);
    await waitFor(() => expect(pinned.onEditsChange).toBeDefined());

    await edit({ kind: 'substitute', start: 100, end: 101, sequence: 'A' });
    await waitFor(() => expect(referenceRows()).toHaveLength(1));
    await edit({ kind: 'delete', start: 110, end: 112 });
    await edit({ kind: 'insert', start: 120, sequence: 'GG' });

    await waitFor(() => expect(pinned.edits).toHaveLength(3));
    expect(referenceRows()).toHaveLength(1);
  });

  it('reset returns to the reference alone', async () => {
    render(<App />);
    await waitFor(() => expect(pinned.onEditsChange).toBeDefined());
    await edit({ kind: 'substitute', start: 100, end: 101, sequence: 'A' });
    await waitFor(() => expect(referenceRows()).toHaveLength(1));

    act(() => pinned.onReset!());

    await waitFor(() => expect(referenceRows()).toHaveLength(0));
    expect(pinned.title).toBe('Sequence');
  });
});
