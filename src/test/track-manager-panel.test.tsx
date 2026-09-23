import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrackManagerPanel, type TrackManagerPanelItem } from '../components/TrackManagerPanel';

const items: TrackManagerPanelItem[] = [
  { id: 'a', name: 'Track A', enabled: true, order: 0, kind: 'signal' },
  { id: 'b', name: 'Track B', enabled: false, order: 1, kind: 'signal' },
];

function renderPanel(overrides: Partial<ComponentProps<typeof TrackManagerPanel>> = {}) {
  const props: ComponentProps<typeof TrackManagerPanel> = {
    items,
    onToggle: vi.fn(),
    onMove: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onBulkToggle: vi.fn(),
    onBulkDelete: vi.fn(),
    onBulkScale: vi.fn(),
    onBulkDisplay: vi.fn(),
    ...overrides,
  };
  render(<TrackManagerPanel {...props} />);
  return props;
}

afterEach(cleanup);

describe('TrackManagerPanel', () => {
  it('defaults to shown tracks and exposes a hidden filter', () => {
    renderPanel();
    expect(screen.getByText('Track A')).toBeDefined();
    expect(screen.queryByText('Track B')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hidden' }));
    expect(screen.getByText('Track B')).toBeDefined();
    expect(screen.queryByText('Track A')).toBeNull();
  });

  it('announces and toggles explicit visibility state', () => {
    const onToggle = vi.fn();
    renderPanel({ onToggle });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Track A' }));
    expect(onToggle).toHaveBeenCalledWith('a');
  });

  it('collapses model collections and toggles grouped plot members together', () => {
    const onBulkToggle = vi.fn();
    const grouped: TrackManagerPanelItem = {
      id: 'puffin-effects',
      name: 'Motif effects',
      memberIds: ['m1', 'm2', 'm3'],
      enabled: false,
      enabledCount: 1,
      totalCount: 3,
      visibility: 'partial',
      order: 0,
      kind: 'signal',
      color: '#7c3aed',
      origin: 'model',
      collectionId: 'model:puffin',
      collectionName: 'Puffin',
      sourceLabel: 'Composite model plot',
      renameable: false,
    };
    renderPanel({ items: [grouped], onBulkToggle });

    const collection = screen.getByRole('button', { name: /Puffin/i });
    expect(collection.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(collection);
    fireEvent.click(screen.getByRole('button', { name: 'Show Motif effects' }));
    expect(onBulkToggle).toHaveBeenCalledWith(['m1', 'm2', 'm3'], true);
  });

  it('searches hidden outputs and expands their model collection', () => {
    const hiddenModel: TrackManagerPanelItem = {
      id: 'yy1',
      name: 'YY1 contribution',
      enabled: false,
      order: 0,
      kind: 'signal',
      origin: 'model',
      collectionId: 'model:puffin',
      collectionName: 'Puffin',
      sourceLabel: 'Base-pair → initiation',
    };
    renderPanel({ items: [hiddenModel] });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByPlaceholderText('Find tracks or outputs'), { target: { value: 'YY1' } });
    expect(screen.getByText('YY1 contribution')).toBeDefined();
  });

  it('moves single rows and disables movement at stack boundaries', () => {
    const onMove = vi.fn();
    renderPanel({ items: items.map((item) => ({ ...item, enabled: true })), onMove });
    expect((screen.getByRole('button', { name: 'Move up Track A' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move down Track A' }));
    expect(onMove).toHaveBeenCalledWith('a', 1);
  });

  it('moves a composite model plot as one member block', () => {
    const onMoveGroup = vi.fn();
    const group: TrackManagerPanelItem = {
      id: 'plot', name: 'Prediction', enabled: true, order: 1, kind: 'signal',
      memberIds: ['plus', 'minus'], enabledCount: 2, totalCount: 2, visibility: 'shown',
      origin: 'data', collectionId: 'data-tracks', collectionName: 'Data tracks',
      sourceLabel: 'Composite model plot', color: '#7c3aed', renameable: false,
    };
    renderPanel({ items: [{ ...items[0], enabled: true }, group], onMoveGroup });
    fireEvent.click(screen.getByRole('button', { name: 'Move up Prediction' }));
    expect(onMoveGroup).toHaveBeenCalledWith(['plus', 'minus'], -1);
  });

  it('edits names only after the explicit Rename action', () => {
    const onRename = vi.fn();
    renderPanel({ onRename });
    expect(screen.queryByRole('textbox', { name: 'Name for Track A' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Track A' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name for Track A' }), { target: { value: 'Renamed A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Track A' }));
    expect(onRename).toHaveBeenCalledWith('a', 'Renamed A');
  });

  it('selects current results and applies visible bulk actions', () => {
    const onBulkToggle = vi.fn();
    const onBulkDelete = vi.fn();
    renderPanel({ items: items.map((item) => ({ ...item, enabled: true })), onBulkToggle, onBulkDelete });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select results' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onBulkToggle).toHaveBeenNthCalledWith(1, ['a', 'b'], false);
    expect(onBulkToggle).toHaveBeenNthCalledWith(2, ['a', 'b'], true);
    expect(onBulkDelete).toHaveBeenCalledWith(['a', 'b']);
  });

  it('applies display and shared/auto scale choices to selected signals', () => {
    const onBulkScale = vi.fn();
    const onBulkDisplay = vi.fn();
    renderPanel({ items: items.map((item) => ({ ...item, enabled: true })), onBulkScale, onBulkDisplay });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select results' }));
    fireEvent.click(screen.getByRole('button', { name: 'DNA height' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shared scale' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto each' }));

    expect(onBulkDisplay).toHaveBeenCalledWith(['a', 'b'], 'sequence');
    expect(onBulkScale).toHaveBeenNthCalledWith(1, ['a', 'b'], { mode: 'linked' });
    expect(onBulkScale).toHaveBeenNthCalledWith(2, ['a', 'b'], { mode: 'auto' });
  });

  it('reveals and validates fixed limits contextually', () => {
    const onBulkScale = vi.fn();
    renderPanel({ items: [{ ...items[0], enabled: true }], onBulkScale });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Track A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fixed limits' }));

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Fixed scale minimum' }), { target: { value: '2' } });
    expect(screen.getByRole('alert').textContent).toMatch(/minimum must be less/i);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Fixed scale minimum' }), { target: { value: '-2' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Fixed scale maximum' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply limits' }));
    expect(onBulkScale).toHaveBeenCalledWith(['a'], { mode: 'fixed', min: -2, max: 3 });
  });

  it('shows scale and DNA provenance without adding it to annotations', () => {
    renderPanel({ items: [
      { ...items[0], enabled: true, yScale: { mode: 'linked', groupId: 'comparison-7' }, signalDisplay: 'sequence' },
      { id: 'genes', name: 'Genes', enabled: true, order: 1, kind: 'annotation' },
    ] });
    expect(screen.getByLabelText('Track A scale: shared').textContent).toBe('SHARED');
    expect(screen.getByText('DNA')).toBeDefined();
    expect(screen.queryByLabelText(/Genes scale:/)).toBeNull();
  });
});
