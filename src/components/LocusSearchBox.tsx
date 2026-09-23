import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GeneMatch } from '../data/geneSearchSource';
import type { GeneSearchStatus } from '../hooks/useGeneSearch';
import {
  formatLocus,
} from '../lib/genomeMath';

export type LocusSearchBoxProps = {
  value: string;
  onValueChange: (next: string) => void;
  placeholder: string;
  matches: readonly GeneMatch[];
  status: GeneSearchStatus;
  /** True when the text already reads as a locus, so no gene list is offered. */
  isLocus: boolean;
  onSubmitLocus: () => void;
  onSelectGene: (match: GeneMatch) => void;
};

function spanLabel(match: GeneMatch): string {
  const strand = match.strand ? ` ${match.strand === '-' ? '−' : '+'}` : '';
  return `${formatLocus(match.chr, match.start, match.end)}${strand}`;
}

/**
 * The locus box: a gene symbol or a `chr:start-end` locus, in one field.
 *
 * A locus resolves locally and instantly; a symbol goes to UCSC, so the two
 * paths are kept visibly separate -- the suggestion list only opens for text
 * that is not already a locus, and Enter on a locus never waits on the network.
 */
export function LocusSearchBox({
  value,
  onValueChange,
  placeholder,
  matches,
  status,
  isLocus,
  onSubmitLocus,
  onSelectGene,
}: LocusSearchBoxProps) {
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const blurTimerRef = useRef<number | null>(null);

  // The header card clips its own overflow to keep its rounded corners, so the
  // list is portalled to the body and positioned against the input instead.
  const measureAnchor = useCallback(() => {
    const element = inputRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    // Clamped to the window. The list is 320px at its narrowest and was placed
    // at the input's left edge, so on a phone -- where that edge is most of the
    // way across a 390px screen -- it hung off the side and the matches could
    // not be read, let alone tapped.
    const margin = 8;
    const available = Math.max(240, window.innerWidth - margin * 2);
    const width = Math.min(Math.max(rect.width + 20, 320), available);
    const left = Math.min(Math.max(margin, rect.left - 10), Math.max(margin, window.innerWidth - width - margin));
    const maxHeight = Math.max(160, window.innerHeight - rect.bottom - 24);
    setAnchor({ top: rect.bottom + 8, left, width, maxHeight });
  }, []);

  const hasQuery = value.trim().length >= 2;
  const open = focused && !isLocus && hasQuery;
  const showList = open && (matches.length > 0 || status === 'searching' || status === 'ready' || status === 'error');

  // Editing the query invalidates the highlighted row; adjusting during render is
  // the supported way to reset derived state without an extra effect pass.
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setActiveIndex(0);
  }

  useEffect(() => () => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!focused) {
      return;
    }

    window.addEventListener('resize', measureAnchor);
    window.addEventListener('scroll', measureAnchor, true);
    return () => {
      window.removeEventListener('resize', measureAnchor);
      window.removeEventListener('scroll', measureAnchor, true);
    };
  }, [focused, measureAnchor]);

  const selectMatch = (match: GeneMatch) => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setFocused(false);
    onSelectGene(match);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setFocused(false);
      return;
    }

    if (event.key === 'Enter') {
      // Explicit rather than relying on implicit form submission: Enter means
      // "take the highlighted gene" when the list is open and "go to this locus"
      // otherwise, and both need to beat the browser default.
      event.preventDefault();
      const match = open ? matches[activeIndex] : undefined;
      if (match) {
        selectMatch(match);
        return;
      }
      onSubmitLocus();
      return;
    }

    if (!open || matches.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % matches.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
      return;
    }

  };

  return (
    <form
      className="hf-inline-field hf-locus-jump"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmitLocus();
      }}
    >
      <span className="hf-field-caption">Jump</span>
      <div className="hf-locus-search">
        <input
          id="jump"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          ref={inputRef}
          onFocus={() => {
            measureAnchor();
            setFocused(true);
          }}
          onBlur={() => {
            // Let a click on a suggestion land before the list unmounts.
            blurTimerRef.current = window.setTimeout(() => setFocused(false), 120);
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && matches[activeIndex] ? `${listId}-${activeIndex}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
        />

        {showList && anchor
          ? createPortal(
          <div
            className="hf-locus-results"
            id={listId}
            role="listbox"
            aria-label="Gene matches"
            style={{ top: anchor.top, left: anchor.left, width: anchor.width, maxHeight: anchor.maxHeight }}
          >
            {matches.map((match, index) => (
              <button
                key={`${match.symbol}-${match.chr}-${match.start}`}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`hf-locus-result${index === activeIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMatch(match)}
              >
                <span className="hf-locus-result__symbol">{match.symbol}</span>
                <span className="hf-locus-result__span">{spanLabel(match)}</span>
                {match.description ? (
                  <span className="hf-locus-result__desc">{match.description}</span>
                ) : null}
              </button>
            ))}

            {status === 'searching' ? (
              <p className="hf-locus-note">Searching UCSC…</p>
            ) : null}
            {status === 'ready' && matches.length === 0 ? (
              <p className="hf-locus-note">No genes match “{value.trim()}”</p>
            ) : null}
            {status === 'error' ? (
              <p className="hf-locus-note hf-locus-note--error">Gene search unavailable</p>
            ) : null}
          </div>,
          document.body,
            )
          : null}
      </div>
    </form>
  );
}
