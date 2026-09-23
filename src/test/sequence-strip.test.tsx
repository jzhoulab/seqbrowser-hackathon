import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceStrip } from '../components/SequenceStrip';
import { compositionBinStyle } from '../lib/sequenceComposition';
import type { ViewportState } from '../types';

function sequenceForRange({ start, end }: { start: number; end: number }): string {
  const span = Math.max(1, Math.floor(end) - Math.floor(start));
  return 'ACGT'.repeat(Math.ceil(span / 4)).slice(0, span);
}

const { fetchGenomeSequenceMock } = vi.hoisted(() => ({
  fetchGenomeSequenceMock: vi.fn(),
}));

vi.mock('../data/sequenceDataSource', () => {
  return {
    fetchGenomeSequence: fetchGenomeSequenceMock,
    fetchGenomeSequenceWindow: async (range: { start: number; end: number }) => ({
      sequence: await fetchGenomeSequenceMock(range),
      start: Math.max(0, Math.floor(range.start)),
      end: Math.max(Math.floor(range.start) + 1, Math.floor(range.end)),
    }),
    normalizeBase: (base: string) => {
      const upper = base.toUpperCase();
      return upper === 'A' || upper === 'C' || upper === 'G' || upper === 'T' ? upper : 'N';
    },
    sequenceCoordinateLabel: (chr: string, start: number, end: number) =>
      `${chr}:${Math.round(start)}-${Math.round(end)}`,
  };
});

beforeEach(() => {
  fetchGenomeSequenceMock.mockReset();
  fetchGenomeSequenceMock.mockImplementation(async (range: { start: number; end: number }) =>
    sequenceForRange(range),
  );
});

afterEach(cleanup);

function makeViewport(span: number, widthPx = 1000, center = 20_000): ViewportState {
  return {
    chr: 'chr1',
    chrLength: 100_000,
    widthPx,
    centerBp: center,
    bpPerPx: span / widthPx,
    range: {
      start: center - span / 2,
      end: center + span / 2,
      span,
    },
  };
}

describe('SequenceStrip', () => {
  it('keeps using buffered sequence for small pans and refetches after leaving buffer', async () => {
    const initialViewport = makeViewport(160);
    const { rerender, container } = render(<SequenceStrip viewport={initialViewport} genome="hg38" />);

    await waitFor(() => {
      expect(fetchGenomeSequenceMock).toHaveBeenCalledTimes(1);
      const seq = container.querySelector('.sequence-strip-seq');
      expect(seq?.textContent).toBeTruthy();
    });

    const smallPanViewport: ViewportState = {
      ...initialViewport,
      centerBp: initialViewport.centerBp - 24,
      range: {
        start: initialViewport.range.start - 24,
        end: initialViewport.range.end - 24,
        span: initialViewport.range.span,
      },
    };
    rerender(<SequenceStrip viewport={smallPanViewport} genome="hg38" />);

    await waitFor(() => {
      expect(fetchGenomeSequenceMock).toHaveBeenCalledTimes(1);
    });

    const largePanViewport: ViewportState = {
      ...initialViewport,
      centerBp: initialViewport.centerBp + 640,
      range: {
        start: initialViewport.range.start + 640,
        end: initialViewport.range.end + 640,
        span: initialViewport.range.span,
      },
    };
    rerender(<SequenceStrip viewport={largePanViewport} genome="hg38" />);

    await waitFor(() => {
      expect(fetchGenomeSequenceMock.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('keeps covered sequence visible while a replacement buffer is pending', async () => {
    let resolveReplacement: (() => void) | undefined;
    fetchGenomeSequenceMock
      .mockImplementationOnce(async (range: { start: number; end: number }) => sequenceForRange(range))
      .mockImplementationOnce(
        ({ start, end }: { start: number; end: number }) =>
          new Promise<string>((resolve) => {
            resolveReplacement = () => resolve(sequenceForRange({ start, end }));
          }),
      );

    const initialViewport = makeViewport(160);
    const { rerender, container } = render(<SequenceStrip viewport={initialViewport} genome="hg38" />);
    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base')).toHaveLength(160);
    });

    const coveredPanViewport: ViewportState = {
      ...initialViewport,
      centerBp: initialViewport.centerBp + 250,
      range: {
        start: initialViewport.range.start + 250,
        end: initialViewport.range.end + 250,
        span: initialViewport.range.span,
      },
    };
    rerender(<SequenceStrip viewport={coveredPanViewport} genome="hg38" />);

    await waitFor(() => {
      expect(fetchGenomeSequenceMock).toHaveBeenCalledTimes(2);
    });
    expect(container.querySelector('.sequence-strip-window')?.textContent).toBe('chr1:20170-20330');
    expect(container.querySelector('.sequence-strip-seq')?.textContent).toMatch(/^[ACGT]{160}$/);

    resolveReplacement?.();
  });

  it('renders viewport-aligned sequence coordinates and per-base cells', async () => {
    const { container } = render(<SequenceStrip viewport={makeViewport(160)} genome="hg38" />);

    await waitFor(() => {
      const windowLabel = container.querySelector('.sequence-strip-window');
      expect(windowLabel?.textContent).toBe('chr1:19920-20080');
    });
    const firstBase = container.querySelector('.sequence-base');
    // The cell holds internal 19,920, which a reader sees as 19,921.
    expect(firstBase?.getAttribute('title')).toContain('chr1:19,921');
    expect(container.querySelector('.sequence-strip-seq-focus')).toBeNull();
  });

  it('switches from color cells to readable letters at 6.5 pixels per base', async () => {
    const { container, rerender } = render(
      <SequenceStrip viewport={makeViewport(100, 649)} genome="hg38" />,
    );

    await waitFor(() => {
      expect(container.querySelector('.sequence-strip-seq')?.getAttribute('data-mode')).toBe('cells');
    });

    rerender(<SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" />);

    await waitFor(() => {
      expect(container.querySelector('.sequence-strip-seq')?.getAttribute('data-mode')).toBe('letters');
      expect(container.querySelectorAll('.sequence-base')).toHaveLength(100);
    });
    expect(container.querySelector('.sequence-strip-kind')?.textContent).toBe('bases');
  });

  it('flips the window to the minus strand on request', async () => {
    const { container, rerender } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base')).toHaveLength(100);
    });
    const forward = [...container.querySelectorAll('.sequence-base')].map((node) => node.textContent);

    rerender(<SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" reversed />);

    const pairs: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
    const reverse = [...container.querySelectorAll('.sequence-base')].map((node) => node.textContent);

    // The REVERSE complement: the minus strand read 5'->3', which runs right to
    // left in genomic coordinates. Complementing in place (the old behaviour)
    // showed the minus strand written 3'->5' -- a donor's GT came out as AC.
    expect(reverse).toEqual([...forward].reverse().map((base) => pairs[base ?? 'N']));
  });

  it('keeps genomic coordinates on every cell when flipped', async () => {
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" reversed />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base')).toHaveLength(100);
    });

    const starts = [...container.querySelectorAll('.sequence-base')].map((node) =>
      Number(node.getAttribute('data-start')),
    );

    // Every cell keeps its own genomic coordinate -- nothing is relabelled --
    // but the row now runs DESCENDING, because the minus strand reads that way.
    expect(starts[0]).toBeGreaterThan(starts[starts.length - 1]);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('renders compact color cells without dropping the underlying bases', async () => {
    const { container } = render(<SequenceStrip viewport={makeViewport(400, 600)} genome="hg38" />);

    await waitFor(() => {
      expect(container.querySelector('.sequence-strip-seq')?.getAttribute('data-mode')).toBe('cells');
      expect(container.querySelectorAll('.sequence-base')).toHaveLength(400);
    });
    expect(container.querySelector('.sequence-strip-seq')?.textContent).toMatch(/^[ACGT]{400}$/);
    expect(container.querySelectorAll('.sequence-composition-bin')).toHaveLength(0);
  });

  it('renders position-aligned composition bins farther out', async () => {
    const { container } = render(<SequenceStrip viewport={makeViewport(2400, 800)} genome="hg38" />);

    await waitFor(() => {
      expect(container.querySelector('.sequence-strip-seq')?.getAttribute('data-mode')).toBe('composition');
      expect(container.querySelectorAll('.sequence-composition-bin').length).toBeGreaterThan(0);
    });
    expect(container.querySelector('.sequence-strip-kind')?.textContent).toBe('A/C/G/T mix');

    const bins = container.querySelectorAll('.sequence-composition-bin');
    expect(bins.length).toBeLessThanOrEqual(Math.floor(800 / 3));
    expect(container.querySelectorAll('.sequence-base')).toHaveLength(0);
    const first = bins[0];
    expect(first.getAttribute('data-start')).toBe('18800');
    expect(first.getAttribute('data-end')).toBe('18810');
    expect(first.getAttribute('data-a')).toBe('3');
    expect(first.getAttribute('data-c')).toBe('3');
    expect(first.getAttribute('data-g')).toBe('2');
    expect(first.getAttribute('data-t')).toBe('2');
  });

  it('shows the zoom-in placeholder and skips fetching beyond the composition limit', () => {
    const { container } = render(<SequenceStrip viewport={makeViewport(12_001)} genome="hg38" />);

    expect(container.querySelector('.sequence-strip-seq')?.getAttribute('data-mode')).toBe('hidden');
    expect(container.querySelector('.sequence-strip-window')?.textContent).toBe('zoom in to <= 12,000 bp');
    expect(fetchGenomeSequenceMock).not.toHaveBeenCalled();
  });

  it('does not show viewport highlight when sequence and track cover same span', async () => {
    const { container } = render(<SequenceStrip viewport={makeViewport(420)} genome="hg38" />);

    await waitFor(() => {
      const windowLabel = container.querySelector('.sequence-strip-window');
      expect(windowLabel?.textContent).toMatch(/^chr1:/);
      expect(windowLabel?.textContent).not.toContain('· view');
    });
    expect(container.querySelector('.sequence-strip-seq-focus')).toBeNull();
  });

  it('selects bases by click or drag, and a selection is the whole affordance', async () => {
    const onEditsChange = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEditsChange={onEditsChange} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const bases = container.querySelectorAll('.sequence-base');
    const first = bases[0];
    const third = bases[2];
    if (!first || !third) {
      throw new Error('Expected per-base sequence cells.');
    }

    fireEvent.pointerDown(first, { button: 0, bubbles: true });
    expect(container.querySelector('.sequence-base.is-selected')?.getAttribute('data-start')).toBe(
      first.getAttribute('data-start'),
    );

    fireEvent.pointerDown(first, { button: 0, bubbles: true });
    fireEvent.pointerMove(third, { button: 0, bubbles: true });
    fireEvent.pointerUp(third, { button: 0, bubbles: true });
    expect(container.querySelectorAll('.sequence-base.is-selected')).toHaveLength(3);

    // No menu. The row behaves like a text field, so selecting is all the UI
    // there is: the keys say what happens next. A menu of "insert before /
    // substitute / delete" used to open here and only restated the keys.
    fireEvent.contextMenu(first);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.textContent).not.toContain('Insert before');
    expect(container.textContent).not.toContain('Substitute');

    fireEvent.keyDown(document, { key: 'Delete' });
    expect(onEditsChange).toHaveBeenCalledWith([
      { kind: 'delete', start: 19950, end: 19953 },
    ]);
  });

  it('deletes the highlighted bases on the Delete key', async () => {
    const onEdit = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const base = container.querySelectorAll('.sequence-base')[10];
    fireEvent.pointerDown(base, { button: 0, clientX: 10, clientY: 5 });
    fireEvent.pointerUp(base, { clientX: 10, clientY: 5 });
    fireEvent.keyDown(document, { key: 'Delete' });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toMatchObject({ kind: 'delete' });
  });

  it('substitutes the highlighted bases when a base key is typed', async () => {
    const onEdit = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const base = container.querySelectorAll('.sequence-base')[4];
    fireEvent.pointerDown(base, { button: 0, clientX: 4, clientY: 5 });
    fireEvent.pointerUp(base, { clientX: 4, clientY: 5 });
    fireEvent.keyDown(document, { key: 'g' });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toMatchObject({ kind: 'substitute', sequence: 'G' });
  });

  it('leaves a draft row to own its own keystrokes', async () => {
    const onEdit = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const base = container.querySelectorAll('.sequence-base')[4];
    fireEvent.pointerDown(base, { button: 0, clientX: 4, clientY: 5 });
    fireEvent.pointerUp(base, { clientX: 4, clientY: 5 });

    // A key struck inside a modified row must not reach the reference row's
    // document-level shortcut, or typing in a draft edits the reference instead.
    const draft = document.createElement('div');
    draft.setAttribute('data-inline-editing', 'true');
    document.body.append(draft);
    fireEvent.keyDown(draft, { key: 'g' });
    draft.remove();

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('leaves other keys to the viewport', async () => {
    const onEdit = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const base = container.querySelectorAll('.sequence-base')[4];
    fireEvent.pointerDown(base, { button: 0, clientX: 4, clientY: 5 });
    fireEvent.pointerUp(base, { clientX: 4, clientY: 5 });
    fireEvent.keyDown(document, { key: 'd' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('substitutes the selected base by typing over it, no dialog', async () => {
    const onEditsChange = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEditsChange={onEditsChange} />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const first = container.querySelector('.sequence-base');
    if (!first) {
      throw new Error('Expected a sequence base.');
    }
    fireEvent.pointerDown(first, { button: 0 });
    fireEvent.keyDown(document, { key: 't' });

    expect(container.querySelector('#sequence-edit-draft')).toBeNull();
    expect(onEditsChange).toHaveBeenCalledWith([
      { kind: 'substitute', start: 19950, end: 19951, sequence: 'T' },
    ]);
  });

  it('reports a single new edit when onEdit is provided', async () => {
    const onEdit = vi.fn();
    const { container } = render(
      <SequenceStrip viewport={makeViewport(100, 650)} genome="hg38" onEdit={onEdit} />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.sequence-base').length).toBe(100);
    });

    const first = container.querySelector('.sequence-base');
    if (!first) {
      throw new Error('Expected a sequence base.');
    }
    fireEvent.pointerDown(first, { button: 0 });
    fireEvent.keyDown(document, { key: 'Delete' });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ kind: 'delete', start: 19950, end: 19951 });
  });

  it('opens a gap where another row inserted bases', async () => {
    // The reference row carries no edits of its own, but is told about the
    // insertion on screen so its columns still line up with the modified row.
    const { container } = render(
      <SequenceStrip
        viewport={makeViewport(100, 650)}
        genome="hg38"
        columnEdits={[{ kind: 'insert', start: 19952, sequence: 'ATG' }]}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-layer="gap"]')).toHaveLength(3);
    });

    const cells = Array.from(container.querySelectorAll('.sequence-base'));
    expect(cells).toHaveLength(103);
    // The gaps sit together, in front of the base they precede.
    const gapIndexes = cells
      .map((cell, index) => (cell.getAttribute('data-layer') === 'gap' ? index : -1))
      .filter((index) => index >= 0);
    expect(gapIndexes[2] - gapIndexes[0]).toBe(2);
    expect(cells[gapIndexes[2] + 1]?.getAttribute('data-start')).toBe('19952');
  });

  it('gives inserted bases their own columns in front of the insertion site', async () => {
    const { container } = render(
      <SequenceStrip
        viewport={makeViewport(100, 650)}
        genome="hg38"
        edits={[{ kind: 'insert', start: 19952, sequence: 'ATG' }]}
        onEditsChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-layer="insertion"]')).toHaveLength(3);
    });

    const inserted = Array.from(container.querySelectorAll('[data-layer="insertion"]'));
    expect(inserted.map((node) => node.textContent).join('')).toBe('ATG');
    // All three belong to the insertion site rather than being painted over the
    // coordinates to its left.
    expect(inserted.every((node) => node.getAttribute('data-insert-before') === '19952')).toBe(true);

    // The reference base at the site keeps its own column, and the row is one
    // column longer per inserted base.
    expect(container.querySelector('[data-layer="reference"][data-start="19952"]')?.textContent).toMatch(
      /^[ACGT]$/,
    );
    expect(container.querySelectorAll('.sequence-base')).toHaveLength(103);
    expect(container.querySelector('.sequence-strip-kind')?.textContent).toBe('ref + insert');
  });
});

describe('composition gradient offsets', () => {
  it('accumulates in the stacking order G, C, A, T so the warm block is GC content', () => {
    // 20 bases: 4 G, 6 C, 5 A, 5 T -> GC 50%.
    const style = compositionBinStyle({ startOffset: 0, endOffset: 20, a: 5, c: 6, g: 4, t: 5, n: 0 } as never) as Record<string, string>;
    expect(style['--sequence-g-end']).toBe('20%');
    expect(style['--sequence-c-end']).toBe('50%'); // warm block ends at GC content
    expect(style['--sequence-a-end']).toBe('75%');
    expect(style['--sequence-t-end']).toBe('100%');
  });
});
