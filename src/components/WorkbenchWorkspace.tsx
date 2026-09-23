import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { PanelMode } from '../features/session/appShareState';
import type { TrackManagerActions } from '../features/tracks/managerControls';
import type { TrackManagerController } from '../features/tracks/useTrackManager';
import type { ModelGroupStatus } from './ModelStatusRail';
import { TrackLibrary } from './TrackLibrary';
import { TrackProperties } from './TrackProperties';
import type { TrackSpec } from '../types';
import type { PlotGroupingActionKind } from '../lib/userPlotGroups';

const mobileQuery = '(max-width: 900px)';
function subscribeMobile(onChange: () => void) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
function isMobile() { return window.matchMedia(mobileQuery).matches; }

function containModalFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab' || !event.currentTarget.matches(':modal')) return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => {
    if (element.getClientRects().length === 0) return false;
    // Closed details may retain layout boxes, although their controls cannot focus.
    for (let parent = element.parentElement; parent && parent !== event.currentTarget; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector('summary') !== element) return false;
    }
    return true;
  });
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus();
  }
}

/** The same mounted panel is a desktop region or a native modal sheet on mobile. */
function Dock({ name, className, mobile, open, inlineOpen = true, onClose, children }: {
  name: string; className: string; mobile: boolean; open: boolean; inlineOpen?: boolean; onClose(): void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const mode = mobile ? (open ? 'modal' : 'closed') : inlineOpen ? 'inline' : 'closed';
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Native dialogs must close before changing between modal and nonmodal.
    if (dialog.open) dialog.close();
    if (mode === 'modal') dialog.showModal();
    else if (mode === 'inline') {
      const previousFocus = document.activeElement;
      dialog.show();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }
  }, [mode]);
  return <dialog id={name === 'Tracks' ? 'tracks-dock' : undefined} ref={ref} className={`wb-dock ${className}`} role={mobile ? 'dialog' : 'region'} aria-label={name} onKeyDown={containModalFocus}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}

function ModelInspector({ model, onFit, onRemove, onSettings }: {
  model: ModelGroupStatus; onFit(id: string): void; onRemove(id: string): void; onSettings(): void;
}) {
  return <div className="wb-model-inspector">
    <div><h3>{model.name}</h3><p>{model.assemblyId ?? 'Active reference'} · {model.visibleOutputCount} of {model.availableOutputCount} outputs shown</p></div>
    <p role="status">{model.stateLabel}</p>
    <div className="track-manager-selection-actions">
      <button type="button" onClick={onSettings}>Outputs and checkpoints</button>
      {(model.state === 'fit-window' || model.state === 'requires-assembly') && <button type="button" onClick={() => onFit(model.instanceId)}>{model.state === 'requires-assembly' ? `Switch to ${model.assemblyId}` : 'Fit model window'}</button>}
      <button type="button" onClick={() => onRemove(model.instanceId)}>Remove model</button>
    </div>
  </div>;
}

function TrackIdentity({ controller }: { controller: TrackManagerController }) {
  const { selectedItems, selectedMemberIds } = controller;
  const item = selectedItems.length === 1 ? selectedItems[0] : undefined;
  return <div className="wb-track-identity">
    <div>
      <h3>{item?.name ?? `${selectedItems.length} tracks selected`}</h3>
      <p>{item ? [item.collectionName, item.subgroupLabel].filter(Boolean).join(' / ') : 'Properties apply to the tracks listed below.'}</p>
      <details className="wb-provenance">
        <summary>{selectedMemberIds.length === 1 ? 'Source details' : `${selectedMemberIds.length} outputs · source details`}</summary>
        <ul>{selectedItems.flatMap((selected) => selected.members.map((member) => <li key={`${selected.id}:${member.id}`}>
          <span className="wb-member-dot" style={{ background: member.color }} />
          <span><strong>{member.name}</strong><small>{member.sourceLabel ?? selected.collectionName}</small></span>
        </li>))}</ul>
      </details>
    </div>
  </div>;
}

function TrackArrangement({ controller, actions }: { controller: TrackManagerController; actions: TrackManagerActions }) {
  const { selectedItems, selectedMemberIds, allIds } = controller;
  const item = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item?.name ?? '');
  const index = item ? allIds.indexOf(item.id) : -1;
  const move = (delta: number) => {
    if (selectedMemberIds.length > 1) actions.onMoveGroup?.(selectedMemberIds, delta);
    else actions.onMove(selectedMemberIds[0], delta);
  };
  return item ? <div className="wb-item-actions">
      <button type="button" aria-label={`Move up ${item.name}`} disabled={index <= 0} onClick={() => move(-1)}>Move up</button>
      <button type="button" aria-label={`Move down ${item.name}`} disabled={index >= allIds.length - 1} onClick={() => move(1)}>Move down</button>
      {item.renameable && <button type="button" onClick={() => setRenaming((value) => !value)}>Rename</button>}
      {renaming && <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) { actions.onRename(selectedMemberIds[0], name.trim()); setRenaming(false); } }}>
        <input aria-label="Track name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        <button type="submit" disabled={!name.trim()}>Save name</button>
      </form>}
    </div> : null;
}

type WorkbenchWorkspaceProps = {
  children: ReactNode | ((inspect: () => void) => ReactNode);
  controller: TrackManagerController;
  actions: TrackManagerActions;
  groupColors: ReadonlyMap<string, string>;
  models: ReadonlyMap<string, ModelGroupStatus>;
  activePanel: PanelMode;
  onPanelChange(panel: PanelMode): void;
  onFitModel(id: string): void;
  onRemoveModel(id: string): void;
  tools: ReactNode;
  libraryOpen?: boolean;
  onLibraryOpenChange?(open: boolean): void;
  inspectedPlot?: TrackSpec;
  onPlotGroupingChange?(track: TrackSpec, action: PlotGroupingActionKind): void;
};

/** Presentation only: no loaders, inference state or scientific mutations live here. */
export function WorkbenchWorkspace({ children, controller, actions, groupColors, models, activePanel, onPanelChange, onFitModel, onRemoveModel, tools, libraryOpen = true, onLibraryOpenChange, inspectedPlot, onPlotGroupingChange }: WorkbenchWorkspaceProps) {
  const mobile = useSyncExternalStore(subscribeMobile, isMobile, () => false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [focusRequest, requestInspectorFocus] = useState(0);
  const toolsRef = useRef<HTMLDialogElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRequest > 0 && !mobile) inspectorRef.current?.focus();
  }, [focusRequest, mobile]);
  const model = controller.selectedModelId ? models.get(controller.selectedModelId) : undefined;
  const toolOpen = activePanel === 'models' || activePanel === 'import';
  useEffect(() => {
    const dialog = toolsRef.current;
    if (toolOpen && dialog && !dialog.open) dialog.showModal();
    if (!toolOpen && dialog?.open) dialog.close();
  }, [toolOpen]);
  const inspect = () => {
    onPanelChange('none');
    if (mobile) setPropertiesOpen(true);
    else requestInspectorFocus((request) => request + 1);
  };
  const openPanel = (panel: PanelMode) => { setPropertiesOpen(false); onPanelChange(panel); };
  const libraryVisible = libraryOpen || activePanel === 'tracks';
  const closeLibrary = () => { if (!mobile) onLibraryOpenChange?.(false); onPanelChange('none'); };
  return <div className="wb-workspace" data-library-open={libraryVisible}>
    <Dock name="Tracks" className="wb-library" mobile={mobile} open={activePanel === 'tracks'} inlineOpen={libraryVisible} onClose={closeLibrary}>
      <header className="wb-region-header">
        <div><h2>Tracks</h2><p>{controller.shownViewCount} plots shown · {models.size} {models.size === 1 ? 'model' : 'models'}</p></div>
        <button className="wb-dock-close" type="button" onClick={closeLibrary} aria-label="Close tracks">×</button>
      </header>
      <div id="track-manager-panel" className="wb-library-content">
        <TrackLibrary controller={controller} actions={actions} groupColors={groupColors} compact onInspect={inspect} onInspectModel={(id) => { controller.selectModel(id); openPanel('models'); }} />
      </div>
    </Dock>
    {typeof children === 'function' ? children(inspect) : children}
    <Dock name="Properties" className="wb-properties" mobile={mobile} open={propertiesOpen && !toolOpen && activePanel !== 'tracks'} onClose={() => setPropertiesOpen(false)}>
      <header className="wb-region-header">
        <h2>Properties</h2>
        <button className="wb-mobile-close" type="button" onClick={() => setPropertiesOpen(false)} aria-label="Close properties">×</button>
      </header>
      <div ref={inspectorRef} tabIndex={-1} className="wb-properties-content">
        {model ? <ModelInspector model={model} onFit={onFitModel} onRemove={onRemoveModel} onSettings={() => openPanel('models')} /> : controller.selectedItems.length > 0 ? <>
          <TrackIdentity controller={controller} />
          <TrackProperties controller={controller} actions={actions} workbench plot={inspectedPlot} onPlotGroupingChange={onPlotGroupingChange}
            arrangement={<TrackArrangement key={controller.selectedItems.map((item) => item.id).join('|')} controller={controller} actions={actions} />} />
        </> : <p className="wb-selection-hint">Select an item in Tracks or its name beside a plot to inspect its source and adjust its display.</p>}
      </div>
    </Dock>
    <nav className="wb-mobile-nav" aria-label="Workspace tools">
      <button type="button" aria-expanded={activePanel === 'tracks'} aria-controls="tracks-dock" onClick={() => openPanel('tracks')}>Tracks <span>{controller.shownViewCount}</span></button>
      <button type="button" aria-expanded={activePanel === 'models'} onClick={() => openPanel('models')}>Models</button>
      <button type="button" aria-expanded={activePanel === 'import'} onClick={() => openPanel('import')}>Data</button>
      <button type="button" aria-expanded={propertiesOpen} onClick={() => { onPanelChange('none'); setPropertiesOpen(true); }}>Properties <span>{controller.selectedItems.length || (model ? 1 : '')}</span></button>
    </nav>
    <dialog ref={toolsRef} className="wb-tools-dialog" aria-label={activePanel === 'models' ? 'Models' : 'Data sources'} onKeyDown={containModalFocus} onCancel={(event) => { event.preventDefault(); onPanelChange('none'); }}>
      {tools}
    </dialog>
  </div>;
}
