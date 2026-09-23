import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocusSearchBox } from '../components/LocusSearchBox';
import type { GeneMatch } from '../data/geneSearchSource';

const MATCHES: GeneMatch[] = [
  // Internal coordinates; the rows below render them as the 1-based loci UCSC shows.
  { symbol: 'BRCA1', chr: 'chr17', start: 43044294, end: 43125364, source: 'mane', description: 'BRCA1 DNA repair associated' },
  { symbol: 'BRCA2', chr: 'chr13', start: 32315507, end: 32400268, source: 'mane' },
];

function renderBox(overrides: Partial<React.ComponentProps<typeof LocusSearchBox>> = {}) {
  const onSelectGene = vi.fn();
  const onSubmitLocus = vi.fn();

  render(
    <LocusSearchBox
      value="BRCA"
      onValueChange={() => {}}
      placeholder="chr1:1"
      matches={MATCHES}
      status="ready"
      isLocus={false}
      onSubmitLocus={onSubmitLocus}
      onSelectGene={onSelectGene}
      {...overrides}
    />,
  );

  return { input: screen.getByRole('combobox'), onSelectGene, onSubmitLocus };
}

describe('locus search box', () => {
  afterEach(cleanup);

  it('lists gene matches once the field is focused', () => {
    const { input } = renderBox();
    fireEvent.focus(input);

    expect(screen.getByRole('option', { name: /BRCA1/ })).toBeTruthy();
    expect(screen.getByText('chr13:32,315,508-32,400,268')).toBeTruthy();
  });

  it('keeps the list closed for text that is already a locus', () => {
    const { input } = renderBox({ value: 'chr17:43044295-43125364', isLocus: true });
    fireEvent.focus(input);

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects the highlighted match on Enter instead of submitting a locus', () => {
    const { input, onSelectGene, onSubmitLocus } = renderBox();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectGene).toHaveBeenCalledWith(MATCHES[1]);
    expect(onSubmitLocus).not.toHaveBeenCalled();
  });

  it('submits the typed locus on Enter when no list is open', () => {
    const { input, onSubmitLocus, onSelectGene } = renderBox({
      value: 'chr17:7668421-7687490',
      isLocus: true,
    });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmitLocus).toHaveBeenCalledTimes(1);
    expect(onSelectGene).not.toHaveBeenCalled();
  });

  it('wraps arrow navigation around the list', () => {
    const { input, onSelectGene } = renderBox();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectGene).toHaveBeenCalledWith(MATCHES[1]);
  });

  it('selects a clicked match', () => {
    const { input, onSelectGene } = renderBox();
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole('option', { name: /BRCA1/ }));

    expect(onSelectGene).toHaveBeenCalledWith(MATCHES[0]);
  });

  it('closes on Escape', () => {
    const { input } = renderBox();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reports progress and empty results without a list of stale rows', () => {
    const { input } = renderBox({ matches: [], status: 'searching' });
    fireEvent.focus(input);

    expect(screen.getByText('Searching UCSC…')).toBeTruthy();
  });

  it('surfaces a failed lookup', () => {
    const { input } = renderBox({ matches: [], status: 'error' });
    fireEvent.focus(input);

    expect(screen.getByText('Gene search unavailable')).toBeTruthy();
  });
});
