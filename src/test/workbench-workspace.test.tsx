import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchWorkspace } from '../components/WorkbenchWorkspace';
import { useTrackManager } from '../features/tracks/useTrackManager';
import type { TrackManagerActions } from '../features/tracks/managerControls';
import type { PanelMode } from '../features/session/appShareState';

let narrow = false;
const listeners = new Set<() => void>();
const mounts = vi.fn();
const actions: TrackManagerActions = { onToggle: vi.fn(), onMove: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onBulkToggle: vi.fn(), onBulkDelete: vi.fn(), onBulkScale: vi.fn(), onBulkDisplay: vi.fn(), onBulkScaleShape: vi.fn() };
const items = [{ id: 'data', name: 'Signal', enabled: true, order: 0, kind: 'signal' as const }];
function Viewport() { useEffect(() => { mounts(); }, []); return <div data-testid="scientific-viewport">Sequence and tracks</div>; }
function Harness() {
  const controller = useTrackManager(items, 'all');
  const [panel, setPanel] = useState<PanelMode>('none');
  const [libraryOpen, setLibraryOpen] = useState(true);
  return <><button onClick={() => setLibraryOpen((open) => !open)}>Toggle library</button>
    <WorkbenchWorkspace controller={controller} actions={actions} groupColors={new Map()} models={new Map()} activePanel={panel} onPanelChange={setPanel} onFitModel={vi.fn()} onRemoveModel={vi.fn()}
      libraryOpen={libraryOpen} onLibraryOpenChange={setLibraryOpen}
      inspectedPlot={{ id: 'data', name: 'Signal', kind: 'signal', height: 80, color: '#446688', source: { type: 'mock' } }}
      tools={<button onClick={() => setPanel('none')}>Close tool</button>}>
      {(inspect) => <><Viewport /><button onClick={() => { controller.setSelectedIds(['data']); inspect(); }}>Inspect example plot</button></>}
    </WorkbenchWorkspace></>;
}
beforeEach(() => {
  narrow = false;
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener: (_: string, callback: () => void) => listeners.add(callback), removeEventListener: (_: string, callback: () => void) => listeners.delete(callback) }));
  // jsdom has no native dialog lifecycle; browser checks cover modal focus.
  HTMLDialogElement.prototype.show = function () { this.open = true; };
  HTMLDialogElement.prototype.showModal = function () { this.open = true; this.setAttribute('data-modal', 'true'); };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.removeAttribute('data-modal'); };
});
afterEach(() => { cleanup(); listeners.clear(); vi.unstubAllGlobals(); });

describe('Workbench workspace', () => {
  it('uses the selected library item as the real property action target', () => {
    render(<Harness />);
    fireEvent.click(within(screen.getByRole('region', { name: 'Tracks' })).getByRole('button', { name: 'Signal' }));
    const inspector = screen.getByRole('region', { name: 'Properties' });
    fireEvent.click(within(inspector).getByRole('button', { name: 'Hide' }));
    fireEvent.click(within(inspector).getByRole('button', { name: 'DNA height' }));
    fireEvent.change(within(inspector).getByRole('combobox', { name: 'Scale transform' }), { target: { value: 'log' } });
    expect(actions.onBulkToggle).toHaveBeenCalledWith(['data'], false);
    expect(actions.onBulkDisplay).toHaveBeenCalledWith(['data'], 'sequence');
    expect(actions.onBulkScaleShape).toHaveBeenCalledWith(['data'], 'log');
  });

  it('retains the viewport and selection while docking, opening tools and resizing', () => {
    render(<Harness />);
    const viewport = screen.getByTestId('scientific-viewport');
    const library = screen.getByRole('region', { name: 'Tracks' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Signal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close tracks' }));
    expect(library.hasAttribute('open')).toBe(false);
    expect(within(screen.getByRole('region', { name: 'Properties' })).getByRole('heading', { name: 'Signal' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle library' }));
    expect(screen.getByRole('region', { name: 'Tracks' })).toBe(library);
    act(() => { narrow = true; listeners.forEach((listener) => listener()); });
    fireEvent.click(screen.getByRole('button', { name: 'Properties 1' }));
    expect(within(screen.getByRole('dialog', { name: 'Properties' })).getByRole('heading', { name: 'Signal' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tracks 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close tracks' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace tools' })).getByRole('button', { name: 'Models' }));
    expect(screen.getByRole('dialog', { name: 'Models' }).getAttribute('data-modal')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close tool' }));
    act(() => { narrow = false; listeners.forEach((listener) => listener()); });
    expect(within(screen.getByRole('region', { name: 'Properties' })).getByRole('heading', { name: 'Signal' })).toBeDefined();
    expect(screen.getByTestId('scientific-viewport')).toBe(viewport);
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('opens Properties directly from a plot on mobile', () => {
    narrow = true;
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect example plot' }));
    expect(within(screen.getByRole('dialog', { name: 'Properties' })).getByRole('heading', { name: 'Signal' })).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Tracks' })).toBeNull();
  });
});
