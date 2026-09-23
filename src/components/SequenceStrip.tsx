import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  clamp,
  clampRangeToChromosome,
  formatLocus,
  formatPosition,
} from '../lib/genomeMath';
import { normalizeBase, sequenceCoordinateLabel } from '../data/sequenceDataSource';
import {
  displayCellsForWindow,
  sanitizeDna,
  complementBase,
  type SequenceDisplayCell,
} from '../features/sequence/edits';
import {
  backspaceAtCaret,
  clampCaret,
  deleteAtCaret,
  deleteRange,
  replaceRangeWithBase,
  typeBaseAtCaret,
} from '../features/sequence/inlineEditing';
import { buildSequenceColumnLayout, MIN_PX_PER_COLUMN } from '../lib/sequenceColumnLayout';
import { useReferenceSequenceWindow } from '../hooks/useReferenceSequenceWindow';
import type { SequenceEdit, ViewportState } from '../types';
import { compositionBinStyle } from '../lib/sequenceComposition';

type SequenceStripProps = {
  /**
   * Edit like a text field -- caret, typing, backspace -- instead of the
   * reference row's select-then-act. Used by the modified rows, which are drafts.
   */
  inlineEditing?: boolean;
  /**
   * Insertions from every row on screen. A row opens a gap wherever another row
   * inserted bases, so the rows stay column-aligned and can be read against each
   * other.
   */
  columnEdits?: readonly SequenceEdit[];
  /**
   * Take focus on mount and open with the caret here. Set on a draft row that
   * was just spawned by an edit on the reference, so the next keystroke
   * continues that draft instead of spawning another one.
   */
  autoFocusCaret?: number | null;
  /** Called once the row has taken focus, so the request is not replayed. */
  onAutoFocused?: () => void;
  /** Read the window on the minus strand: complemented and right-to-left. */
  reversed?: boolean;
  /** Rendered as the orientation toggle; only the reference strip supplies it. */
  viewport: ViewportState;
  genome: string;
  edits?: readonly SequenceEdit[];
  /** Render these edits; defaults to `edits`. Use `[]` to keep a clean reference row. */
  displayEdits?: readonly SequenceEdit[];
  onEditsChange?: (edits: SequenceEdit[]) => void;
  /** Commit one new edit without accumulating on this strip (spawns a new variant). */
  onEdit?: (edit: SequenceEdit) => void;
  onReset?: () => void;
  showReset?: boolean;
  resetLabel?: string;
  /** Outputs the user hid on the edited sequence, offered back from its row. */
  hiddenOutputCount?: number;
  onShowHiddenOutputs?: () => void;
  /** Start another modified row. Shown on the reference once at least one exists. */
  onAddVariant?: () => void;
  appearance?: 'default' | 'modified';
  embedded?: boolean;
  title?: string;
  ariaLabel?: string;
};

type SequenceStripRenderMode = 'letters' | 'cells' | 'composition' | 'hidden';

type GenomicSelection = {
  start: number;
  end: number;
};

type SequenceMenuState = {
  x: number;
  y: number;
  selection: GenomicSelection;
};

type SequenceDialogKind = 'insert' | 'substitute';

type SequenceDialogState = {
  kind: SequenceDialogKind;
  selection: GenomicSelection;
  x: number;
  y: number;
};

/** Existing DNA-button target. Render-mode selection itself is pixel based. */
export const SEQUENCE_STRIP_MAX_SPAN_BP = 420;
const SEQUENCE_STRIP_COMPOSITION_MAX_SPAN_BP = 12_000;
const SEQUENCE_STRIP_LETTER_MIN_PX_PER_BASE = 6.5;
const SEQUENCE_STRIP_CELL_MIN_PX_PER_BASE = MIN_PX_PER_COLUMN;

const SEQUENCE_BUFFER_MULTIPLIER = 3;
const MIN_SEQUENCE_BUFFER_BP = SEQUENCE_STRIP_MAX_SPAN_BP * 2;
const MIN_SEQUENCE_STRIDE_BP = 48;
const COMPOSITION_BIN_TARGET_WIDTH_PX = 3;

type SequenceCompositionBin = import('../lib/sequenceComposition').SequenceCompositionBin;

function chooseSequenceStripRenderMode(spanBp: number, widthPx: number): SequenceStripRenderMode {
  const safeSpanBp = Math.max(1, spanBp);
  if (safeSpanBp > SEQUENCE_STRIP_COMPOSITION_MAX_SPAN_BP) {
    return 'hidden';
  }

  const pixelsPerBase = Math.max(1, widthPx) / safeSpanBp;
  if (pixelsPerBase >= SEQUENCE_STRIP_LETTER_MIN_PX_PER_BASE) {
    return 'letters';
  }
  if (pixelsPerBase >= SEQUENCE_STRIP_CELL_MIN_PX_PER_BASE) {
    return 'cells';
  }
  return 'composition';
}

function binSequenceComposition(sequence: string, maxBins: number): SequenceCompositionBin[] {
  if (sequence.length === 0) {
    return [];
  }

  const boundedBinCount = clamp(Math.floor(maxBins), 1, sequence.length);
  const basesPerBin = Math.max(1, Math.ceil(sequence.length / boundedBinCount));
  const bins: SequenceCompositionBin[] = [];

  for (let startOffset = 0; startOffset < sequence.length; startOffset += basesPerBin) {
    const endOffset = Math.min(sequence.length, startOffset + basesPerBin);
    const bin: SequenceCompositionBin = { startOffset, endOffset, a: 0, c: 0, g: 0, t: 0, n: 0 };

    for (let index = startOffset; index < endOffset; index += 1) {
      const base = normalizeBase(sequence[index] ?? 'N');
      if (base === 'A') {
        bin.a += 1;
      } else if (base === 'C') {
        bin.c += 1;
      } else if (base === 'G') {
        bin.g += 1;
      } else if (base === 'T') {
        bin.t += 1;
      } else {
        bin.n += 1;
      }
    }

    bins.push(bin);
  }

  return bins;
}


function compositionBinTitle(chr: string, displayStart: number, bin: SequenceCompositionBin): string {
  const size = Math.max(1, bin.endOffset - bin.startOffset);
  const percentage = (count: number) => `${Math.round((count / size) * 100)}%`;
  const start = displayStart + bin.startOffset;
  const end = displayStart + bin.endOffset;
  return `${chr}:${start.toLocaleString('en-US')}-${end.toLocaleString('en-US')} · GC ${percentage(bin.g + bin.c)} · G ${percentage(bin.g)} · C ${percentage(bin.c)} · A ${percentage(bin.a)} · T ${percentage(bin.t)}`;
}

function selectionContains(selection: GenomicSelection | null, genomic: number): boolean {
  return Boolean(selection && genomic >= selection.start && genomic < selection.end);
}

function rangeOverlapsSelection(
  selection: GenomicSelection | null,
  start: number,
  end: number,
): boolean {
  return Boolean(selection && start < selection.end && end > selection.start);
}

function genomicRangeFromTarget(target: EventTarget | null): GenomicSelection | null {
  const element = target instanceof Element ? target.closest('[data-start][data-end]') : null;
  if (!element) {
    return null;
  }
  const start = Number(element.getAttribute('data-start'));
  const end = Number(element.getAttribute('data-end'));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { start, end };
}

function genomicRangeFromEvent(event: { target: EventTarget | null; clientX?: number; clientY?: number }): GenomicSelection | null {
  const fromTarget = genomicRangeFromTarget(event.target);
  if (fromTarget) {
    return fromTarget;
  }
  if (typeof document === 'undefined' || event.clientX === undefined || event.clientY === undefined) {
    return null;
  }
  return genomicRangeFromTarget(document.elementFromPoint(event.clientX, event.clientY));
}

function selectionLabel(chr: string, selection: GenomicSelection): string {
  if (selection.end - selection.start === 1) {
    return `${chr}:${formatPosition(selection.start)}`;
  }
  return formatLocus(chr, selection.start, selection.end);
}

function baseCellClassName(
  cell: Extract<SequenceDisplayCell, { kind: 'base' }>,
  selected: boolean,
): string {
  const classes = ['sequence-base', `sequence-base-${cell.displayBase.toLowerCase()}`];
  if (selected) {
    classes.push('is-selected');
  }
  if (cell.deleted) {
    classes.push('is-deleted');
  }
  if (cell.substituted) {
    classes.push('is-substituted');
  }
  return classes.join(' ');
}

function insertionCellClassName(cell: Extract<SequenceDisplayCell, { kind: 'insertion' }>): string {
  return `sequence-base sequence-insert-cell sequence-base-${cell.base.toLowerCase()}`;
}

export function SequenceStrip({
  viewport,
  genome,
  edits = [],
  displayEdits,
  onEditsChange,
  onEdit,
  onReset,
  showReset,
  resetLabel,
  hiddenOutputCount = 0,
  onShowHiddenOutputs,
  onAddVariant,
  appearance = 'default',
  embedded = false,
  title = 'Sequence',
  ariaLabel,
  autoFocusCaret = null,
  onAutoFocused,
  reversed = false,
  inlineEditing = false,
  columnEdits,
}: SequenceStripProps) {
  const boundedRange = useMemo(
    () => clampRangeToChromosome(viewport.range, viewport.chrLength),
    [viewport.chrLength, viewport.range],
  );
  const displayStart = clamp(Math.round(boundedRange.start), 0, Math.max(0, viewport.chrLength - 1));
  const displayEnd = clamp(Math.round(boundedRange.end), displayStart + 1, viewport.chrLength);
  const spanBp = Math.max(1, displayEnd - displayStart);
  const renderMode = chooseSequenceStripRenderMode(spanBp, viewport.widthPx);
  const showSequence = renderMode !== 'hidden';
  const editingEnabled = Boolean(onEditsChange || onEdit) && showSequence;
  const sequenceWindow = useReferenceSequenceWindow({
    genome,
    chr: viewport.chr,
    chrLength: viewport.chrLength,
    start: displayStart,
    end: displayEnd,
    enabled: showSequence,
    bufferMultiplier: SEQUENCE_BUFFER_MULTIPLIER,
    minBufferBp: MIN_SEQUENCE_BUFFER_BP,
    minStrideBp: MIN_SEQUENCE_STRIDE_BP,
  });
  const displaySliceStart = clamp(displayStart - sequenceWindow.start, 0, sequenceWindow.sequence.length);
  const displaySliceEnd = clamp(displayEnd - sequenceWindow.start, displaySliceStart, sequenceWindow.sequence.length);
  const displaySequence = sequenceWindow.sequence.slice(displaySliceStart, displaySliceEnd);
  const sequenceWindowLabel = sequenceCoordinateLabel(viewport.chr, displayStart, displayEnd);
  const [selection, setSelection] = useState<GenomicSelection | null>(null);
  // Caret sits *before* this coordinate. Null until the row is clicked into --
  // or, for a row spawned by an edit, wherever that edit left off.
  const [caret, setCaret] = useState<number | null>(autoFocusCaret);
  const [menu, setMenu] = useState<SequenceMenuState | null>(null);
  const [dialog, setDialog] = useState<SequenceDialogState | null>(null);
  const [draftSequence, setDraftSequence] = useState('');
  const [uiScopeChr, setUiScopeChr] = useState(viewport.chr);
  if (uiScopeChr !== viewport.chr) {
    setUiScopeChr(viewport.chr);
    setSelection(null);
    setMenu(null);
    setDialog(null);
    setDraftSequence('');
  }
  const dragAnchorRef = useRef<GenomicSelection | null>(null);
  const commitEditRef = useRef<(edit: SequenceEdit) => void>(() => {});
  // Pointer-up can run before the selection state has re-rendered; the ref
  // carries the value the drag just committed.
  const selectionRef = useRef<GenomicSelection | null>(null);
  const commitSelection = (next: GenomicSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
  };
  const stripRef = useRef<HTMLDivElement | null>(null);
  const sequenceRef = useRef<HTMLElement | null>(null);

  const visibleEdits = displayEdits ?? edits;
  const sequenceCells = useMemo(
    () => {
      if (renderMode !== 'letters' && renderMode !== 'cells') {
        return [];
      }
      if (displaySequence.length === 0) {
        return [];
      }
      return displayCellsForWindow(
        sequenceWindow.sequence,
        sequenceWindow.start,
        displayStart,
        displayStart + displaySequence.length,
        visibleEdits,
      );
    },
    [displaySequence.length, displayStart, renderMode, sequenceWindow.sequence, sequenceWindow.start, visibleEdits],
  );
  const compositionBins = useMemo(() => {
    if (renderMode !== 'composition') {
      return [];
    }
    const maxBins = Math.max(1, Math.floor(viewport.widthPx / COMPOSITION_BIN_TARGET_WIDTH_PX));
    return binSequenceComposition(displaySequence, maxBins);
  }, [displaySequence, renderMode, viewport.widthPx]);
  /**
   * Lay this row's cells into the columns every row shares. Where another row
   * inserted bases and this one did not, the column becomes a gap -- which is
   * what keeps the reference readable against a modified copy of it.
   */
  const alignedCells = useMemo(() => {
    if (!columnEdits || columnEdits.length === 0) {
      return sequenceCells;
    }

    const layout = buildSequenceColumnLayout(columnEdits, displayStart, displayEnd);
    if (layout.columns.every((column) => column.kind === 'base')) {
      return sequenceCells;
    }

    const baseByGenomic = new Map<number, SequenceDisplayCell>();
    const insertionByKey = new Map<string, SequenceDisplayCell>();
    for (const cell of sequenceCells) {
      if (cell.kind === 'base') {
        baseByGenomic.set(cell.genomic, cell);
      } else {
        insertionByKey.set(`${cell.before}:${cell.offset}`, cell);
      }
    }

    return layout.columns.map((column): SequenceDisplayCell | null =>
      column.kind === 'base'
        ? baseByGenomic.get(column.genomic) ?? null
        : insertionByKey.get(`${column.before}:${column.offset}`) ?? null,
    );
  }, [columnEdits, displayEnd, displayStart, sequenceCells]);

  const sequenceColumnsStyle = useMemo(
    () =>
      ({
        // Counted from the aligned cells, not this row's own: a row with gaps
        // has more columns than it has bases, and the grid has to know.
        '--sequence-columns': Math.max(1, alignedCells.length),
      }) as CSSProperties,
    [alignedCells.length],
  );
  const hasInsertions = sequenceCells.some((cell) => cell.kind === 'insertion');

  useEffect(() => {
    const endDrag = () => {
      dragAnchorRef.current = null;
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, []);

  // Keyboard editing on a highlighted stretch: Delete removes it, and typing a
  // base replaces it. Both commit straight to a new edited track rather than
  // routing through the menu, because the whole point is not to stop and aim.
  //
  // Capture phase with propagation stopped: the viewport listens for A/D to pan
  // and +/- to zoom, and a selection has to win those keys while it is live.
  useEffect(() => {
    if (!editingEnabled || inlineEditing || !selection || dialog) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          // A draft row owns its own keys: this listener is on the document, so
          // without this it would intercept typing meant for the caret in a
          // modified row and apply it to the reference selection instead.
          target.closest('[data-inline-editing="true"]'))
      ) {
        return;
      }

      const key = event.key;
      if (key === 'Delete' || key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        commitEditRef.current({ kind: 'delete', start: selection.start, end: selection.end });
        return;
      }

      const base = key.toUpperCase();
      if (base === 'A' || base === 'C' || base === 'G' || base === 'T') {
        event.preventDefault();
        event.stopPropagation();
        commitEditRef.current({
          kind: 'substitute',
          start: selection.start,
          end: selection.end,
          sequence: base,
        });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [dialog, editingEnabled, inlineEditing, selection]);

  useEffect(() => {
    if (!menu && !dialog) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null);
        setDialog(null);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = stripRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      setMenu(null);
      setDialog(null);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [dialog, menu]);

  const stopTrackPan = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const updateSelectionFromPointer = (event: ReactPointerEvent<HTMLElement>, isStart: boolean) => {
    const range = genomicRangeFromEvent(event);
    if (!range) {
      return;
    }
    if (isStart) {
      dragAnchorRef.current = range;
      commitSelection(range);
      setMenu(null);
      setDialog(null);
      return;
    }
    const anchor = dragAnchorRef.current;
    if (!anchor) {
      return;
    }
    commitSelection({
      start: Math.min(anchor.start, range.start),
      end: Math.max(anchor.end, range.end),
    });
  };

  const onSequencePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    stopTrackPan(event);
    if (!editingEnabled || event.button > 0) {
      return;
    }

    if (inlineEditing) {
      // Clicking an inserted base puts the caret at the end of its run, so
      // typing continues it rather than starting a second insertion.
      const insertionTarget =
        event.target instanceof Element ? event.target.closest('[data-insert-before]') : null;
      if (insertionTarget) {
        const before = Number(insertionTarget.getAttribute('data-insert-before'));
        if (Number.isFinite(before)) {
          setCaret(before);
          commitSelection(null);
          dragAnchorRef.current = null;
          return;
        }
      }

      // Otherwise the caret lands on the nearer edge of the base, the way a text
      // field puts it on the nearer side of a glyph.
      const range = genomicRangeFromEvent(event);
      if (range) {
        const target = event.target instanceof Element ? event.target.closest('[data-start]') : null;
        const rect = target?.getBoundingClientRect();
        const afterMidpoint = rect ? event.clientX > rect.left + rect.width * 0.5 : false;
        // The nearer side of the glyph, in genomic terms: on the mirrored row
        // the right side of a base is the lower coordinate.
        setCaret(afterMidpoint !== reversed ? range.end : range.start);
      }
      commitSelection(null);
      dragAnchorRef.current = range ?? null;
      return;
    }

    updateSelectionFromPointer(event, true);
  };

  const onSequencePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!editingEnabled || dragAnchorRef.current === null) {
      return;
    }
    updateSelectionFromPointer(event, false);
  };

  const onSequencePointerUp = () => {
    const wasDragging = dragAnchorRef.current !== null;
    dragAnchorRef.current = null;
    if (!editingEnabled || inlineEditing || !wasDragging) {
      return;
    }

    // A selection is the whole affordance. The row behaves like a text field:
    // type a base to substitute, Delete to delete, keep typing to insert. A menu
    // of "insert before / substitute / delete" used to open here; it named what
    // the keys already do and got in the way of the next keystroke.
    setDialog(null);
    setMenu(null);
  };

  /**
   * Text-field keys for a draft row. The caret model lives in
   * `features/sequence/inlineEditing`; this only decides which key means what.
   */
  const onInlineKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!inlineEditing || !onEditsChange) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const minCoordinate = displayStart;
    const maxCoordinate = displayEnd;
    const position = clampCaret(caret ?? minCoordinate, minCoordinate, maxCoordinate);
    const key = event.key;

    // On the minus strand the row is mirrored: left is up the coordinates.
    const leftward = reversed ? 1 : -1;

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      setCaret(clampCaret(position + (key === 'ArrowLeft' ? leftward : -leftward), minCoordinate, maxCoordinate));
      return;
    }

    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      setCaret((key === 'Home') !== reversed ? minCoordinate : maxCoordinate);
      return;
    }

    if (key === 'Backspace' || key === 'Delete') {
      event.preventDefault();
      event.stopPropagation();
      // Over a selection both keys delete the selection, as in any text field.
      // At a bare caret they keep their usual directions -- on the screen, which
      // on the minus strand is the other way round in genomic coordinates.
      const result = selection
        ? deleteRange(edits, selection.start, selection.end)
        : key === 'Backspace'
          ? backspaceAtCaret(edits, position, minCoordinate, reversed, maxCoordinate)
          : deleteAtCaret(edits, position, maxCoordinate, reversed, minCoordinate);
      onEditsChange(result.edits);
      commitSelection(null);
      setCaret(result.caret);
      return;
    }

    const base = key.toUpperCase();
    if (base !== 'A' && base !== 'C' && base !== 'G' && base !== 'T') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const result = selection
      ? replaceRangeWithBase(edits, selection.start, selection.end, base, maxCoordinate, reversed)
      : typeBaseAtCaret(edits, position, base, maxCoordinate, reversed);
    onEditsChange(result.edits);
    commitSelection(null);
    setCaret(result.caret);
  };

  const onSequenceContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!editingEnabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const range = genomicRangeFromTarget(event.target);
    const nextSelection =
      range && selection && range.start >= selection.start && range.end <= selection.end
        ? selection
        : range ?? selection;
    if (!nextSelection) {
      return;
    }
    commitSelection(nextSelection);
    setDialog(null);
    setMenu(null);
  };

  const finishEditUi = () => {
    setMenu(null);
    setDialog(null);
    setDraftSequence('');
  };

  const commitEdit = (edit: SequenceEdit) => {
    if (onEdit) {
      onEdit(edit);
    } else {
      onEditsChange?.([...edits, edit]);
    }
    finishEditUi();
  };

  // A row spawned by an edit takes the caret with it. Without this the edit
  // lands in a new row while focus stays on the reference, so the next
  // keystroke spawns a second row instead of continuing the first.
  //
  // Runs once on mount: the request is one-shot and the owner clears it, so a
  // row that Virtuoso unmounts and remounts on scroll does not steal focus.
  useEffect(() => {
    if (autoFocusCaret === null || !inlineEditing) {
      return;
    }
    sequenceRef.current?.focus();
    onAutoFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, []);

  // Kept current for the keyboard listener, which subscribes once per selection
  // rather than once per render.
  useEffect(() => {
    commitEditRef.current = commitEdit;
  });

  const openDialog = (kind: SequenceDialogKind) => {
    if (!menu) {
      return;
    }
    setDialog({ kind, selection: menu.selection, x: menu.x, y: menu.y });
    setDraftSequence('');
    setMenu(null);
  };

  const onDeleteSelection = () => {
    if (!menu) {
      return;
    }
    commitEdit({ kind: 'delete', start: menu.selection.start, end: menu.selection.end });
    setSelection(null);
  };

  const onSubmitDialog = (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) {
      return;
    }
    const sequence = sanitizeDna(draftSequence);
    if (sequence.length === 0) {
      return;
    }
    if (dialog.kind === 'insert') {
      commitEdit({ kind: 'insert', start: dialog.selection.start, sequence });
    } else {
      commitEdit({
        kind: 'substitute',
        start: dialog.selection.start,
        end: dialog.selection.end,
        sequence,
      });
    }
  };

  // Switching strands complements the bases in place: the window keeps its
  // genomic left-to-right order, so a column still sits under its own coordinate
  // and lines up with the ruler, the tracks and the prediction above it.
  // Mirroring the whole window would decouple the letters from everything else
  // on screen -- reading the minus strand 5'->3' is done by reading right to left.
  // On the minus strand the row reads 5'->3' of THAT strand, which runs
  // right-to-left in genomic coordinates: the cells are reversed and each letter
  // complemented, i.e. the reverse complement. Complementing in place (the
  // previous behaviour) showed the minus strand written 3'->5', which is neither
  // strand -- a donor's GT came out as AC instead of GT.
  const orientedCells = useMemo(
    () => (reversed ? [...alignedCells].reverse() : alignedCells),
    [alignedCells, reversed],
  );
  const orientedCompositionBins = useMemo(
    () =>
      reversed
        ? [...compositionBins].reverse().map((bin) => ({ ...bin, a: bin.t, t: bin.a, c: bin.g, g: bin.c }))
        : compositionBins,
    [compositionBins, reversed],
  );
  const orientedLetter = (letter: string) => (reversed ? complementBase(letter) : letter);
  /**
   * What a cell says it is, when you hover it.
   *
   * The glyph shows the strand being read, so the readout has to show that same
   * letter, and has to say which strand it belongs to. Reporting the plus-strand
   * base under a complemented glyph had the strip drawing T while its own
   * tooltip said A, with nothing to tell you which was which -- and nothing to
   * tell you the plus-strand base either, which is the one you would quote.
   */
  const cellTitle = (coordinate: number, plusBase: string, inserted = false): string => {
    const at = `${viewport.chr}:${formatPosition(coordinate)}`;
    const kind = inserted ? 'inserted ' : '';
    return reversed
      ? `${at} ${kind}${complementBase(plusBase)} on the − strand · ${plusBase} on +`
      : `${at} ${kind}${plusBase}`;
  };
  // The caret sits before coordinate c: between c-1 and c. Drawn on the plus
  // strand at the left edge of cell c; on the mirrored row that gap is at the
  // left edge of cell c-1 (and, past the lowest base, the right edge of the
  // lowest cell), after any run typed there.
  const caretCellClass = (genomic: number): string => {
    if (caret === null) {
      return '';
    }
    if (reversed) {
      if (caret === genomic + 1) return ' is-caret-before';
      if (caret === genomic && genomic <= displayStart) return ' is-caret-after';
      return '';
    }
    if (caret === genomic) return ' is-caret-before';
    if (caret === genomic + 1 && genomic + 1 >= displayEnd) return ' is-caret-after';
    return '';
  };

  const sanitizedDraft = sanitizeDna(draftSequence);
  const sequenceReady = showSequence && !sequenceWindow.loading && !sequenceWindow.error;
  const modified = appearance === 'modified' || title === 'Modified';
  const resetShown = Boolean(onReset || onEditsChange) && Boolean(showReset || edits.length > 0);
  const resolvedResetLabel = resetLabel ?? (modified ? 'Remove' : 'Reset sequence');

  return (
    <div
      ref={stripRef}
      className={`sequence-strip${editingEnabled ? ' sequence-strip--editable' : ''}${
        modified ? ' sequence-strip--modified' : ''
      }${embedded ? ' sequence-strip--embedded' : ''}`}
      aria-label={ariaLabel ?? `${title} preview`}
      onPointerDown={stopTrackPan}
    >
      <div className="sequence-strip-label">
        <span className="sequence-strip-title">{title}</span>
        <span className="sequence-strip-kind">
          {renderMode === 'composition'
            ? 'A/C/G/T mix'
            : renderMode === 'hidden'
              ? 'DNA'
              : hasInsertions
                ? 'ref + insert'
                : 'bases'}
        </span>
        {renderMode !== 'hidden' ? (
          <span
            className="sequence-strip-legend"
            aria-label="Base colours: G orange, C rose, A blue, T teal. Warm area is GC content."
            title="G and C are the warm colours, A and T the cool ones — warm area reads as GC content"
          >
            <b className="legend-g">G</b>
            <b className="legend-c">C</b>
            <b className="legend-a">A</b>
            <b className="legend-t">T</b>
          </span>
        ) : null}
        {onAddVariant && showSequence && showReset ? (
          <button
            type="button"
            className="sequence-strip-add"
            onClick={onAddVariant}
            title="Start another modified copy of the reference. Edits you make on the reference go to the newest one."
          >
            + variant
          </button>
        ) : null}
        {resetShown ? (
          <button
            type="button"
            className="sequence-strip-reset"
            onClick={() => {
              onReset?.();
              onEditsChange?.([]);
              setSelection(null);
              setMenu(null);
              setDialog(null);
            }}
          >
            {resolvedResetLabel}
          </button>
        ) : null}
        {hiddenOutputCount > 0 && onShowHiddenOutputs ? (
          <button
            type="button"
            className="sequence-strip-restore"
            onClick={onShowHiddenOutputs}
            title="Outputs hidden on the edited sequence. Show them again."
          >
            Show {hiddenOutputCount} hidden {hiddenOutputCount === 1 ? 'output' : 'outputs'}
          </button>
        ) : null}
      </div>
      <div className="sequence-strip-content">
        <span className="sequence-strip-window">
          {!showSequence
            ? `zoom in to <= ${SEQUENCE_STRIP_COMPOSITION_MAX_SPAN_BP.toLocaleString('en-US')} bp`
            : sequenceWindow.loading
            ? 'loading…'
            : sequenceWindow.error
              ? 'unavailable'
              : sequenceWindowLabel}
        </span>
        <code
          ref={sequenceRef}
          className={`sequence-strip-seq sequence-strip-seq--${renderMode}${
            hasInsertions ? ' sequence-strip-seq--stacked' : ''
          }`}
          data-mode={renderMode}
          style={sequenceColumnsStyle}
          onPointerDown={onSequencePointerDown}
          onPointerMove={onSequencePointerMove}
          onPointerUp={onSequencePointerUp}
          onPointerCancel={onSequencePointerUp}
          onContextMenu={onSequenceContextMenu}
          onKeyDown={inlineEditing ? onInlineKeyDown : undefined}
          onBlur={inlineEditing ? () => setCaret(null) : undefined}
          tabIndex={inlineEditing ? 0 : undefined}
          data-inline-editing={inlineEditing ? 'true' : undefined}
          role={renderMode === 'composition' ? 'img' : undefined}
          aria-label={renderMode === 'composition' ? 'DNA base composition' : undefined}
        >
          {!sequenceReady
            ? '—'
            : renderMode === 'composition'
              ? orientedCompositionBins.map((bin) => (
                  <span
                    key={bin.startOffset}
                    className={`sequence-composition-bin${
                      rangeOverlapsSelection(
                        selection,
                        displayStart + bin.startOffset,
                        displayStart + bin.endOffset,
                      )
                        ? ' is-selected'
                        : ''
                    }`}
                    style={compositionBinStyle(bin)}
                    title={compositionBinTitle(viewport.chr, displayStart, bin)}
                    data-start={displayStart + bin.startOffset}
                    data-end={displayStart + bin.endOffset}
                    data-a={bin.a}
                    data-c={bin.c}
                    data-g={bin.g}
                    data-t={bin.t}
                    data-n={bin.n}
                    aria-hidden="true"
                  />
                ))
              : (
                <>
                  {orientedCells.map((cell, columnIndex) =>
                    cell === null ? (
                      <span
                        key={`${viewport.chr}:gap:${columnIndex}`}
                        className="sequence-base sequence-gap-cell"
                        aria-hidden="true"
                        data-layer="gap"
                      >
                        –
                      </span>
                    ) : cell.kind === 'insertion' ? (
                      <span
                        key={`${viewport.chr}:ins:${cell.before}:${cell.offset}`}
                        className={insertionCellClassName(cell)}
                        title={cellTitle(cell.before, cell.base, true)}
                        data-insert-before={cell.before}
                        data-layer="insertion"
                      >
                        {orientedLetter(cell.base)}
                      </span>
                    ) : (
                      <span
                        key={`${viewport.chr}:${cell.genomic}`}
                        className={`${baseCellClassName(cell, selectionContains(selection, cell.genomic))}${
                          selection && cell.genomic === selection.start ? ' is-selection-start' : ''
                        }${selection && cell.genomic === selection.end - 1 ? ' is-selection-end' : ''}${caretCellClass(cell.genomic)}`}
                        title={cellTitle(cell.genomic, cell.deleted ? cell.referenceBase : cell.displayBase)}
                        data-start={cell.genomic}
                        data-end={cell.genomic + 1}
                        data-layer="reference"
                        aria-selected={selectionContains(selection, cell.genomic) || undefined}
                      >
                        {orientedLetter(cell.deleted ? cell.referenceBase : cell.displayBase)}
                      </span>
                    ),
                  )}
                </>
              )}
        </code>
      </div>
      {menu ? (
        <div
          className="sequence-edit-menu"
          role="menu"
          aria-label="Edit sequence"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="sequence-edit-menu-label">{selectionLabel(viewport.chr, menu.selection)}</div>
          <button type="button" role="menuitem" onClick={() => openDialog('insert')}>
            Insert before
          </button>
          <button type="button" role="menuitem" onClick={onDeleteSelection}>
            Delete selected
          </button>
          <button type="button" role="menuitem" onClick={() => openDialog('substitute')}>
            Substitute…
          </button>
        </div>
      ) : null}
      {dialog ? (
        <form
          className="sequence-edit-dialog"
          aria-label={dialog.kind === 'insert' ? 'Insert sequence' : 'Substitute sequence'}
          style={{ left: dialog.x, top: dialog.y }}
          onSubmit={onSubmitDialog}
        >
          <label className="sequence-edit-dialog-label" htmlFor="sequence-edit-draft">
            {dialog.kind === 'insert'
              ? `Insert before ${selectionLabel(viewport.chr, dialog.selection)}`
              : `Replace ${selectionLabel(viewport.chr, dialog.selection)}`}
          </label>
          <textarea
            id="sequence-edit-draft"
            className="sequence-edit-dialog-input"
            value={draftSequence}
            onChange={(event) => setDraftSequence(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
            placeholder="Type or paste DNA (A/C/G/T)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            rows={4}
          />
          <div className="sequence-edit-dialog-actions">
            <button type="button" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="submit" disabled={sanitizedDraft.length === 0}>
              Apply
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
