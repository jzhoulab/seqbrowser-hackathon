import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { KeyboardEvent } from 'react';
import type { ListRange } from 'react-virtuoso';
import { RulerCanvas } from './components/RulerCanvas';
import { TrackList } from './components/TrackList';
import { BrushNavigator } from './components/BrushNavigator';
import { AssemblySelector } from './components/AssemblySelector';
import { SourceImportPanel, type DataSourcePanelItem } from './components/SourceImportPanel';
import { WorkbenchWorkspace } from './components/WorkbenchWorkspace';
import { useTrackManager } from './features/tracks/useTrackManager';
import { managerSelectionForTrack, renderedTrackMemberIds } from './features/tracks/managerSelection';
import {
  ModelsPanel,
  type ModelActionState,
  type ModelOutputGroupState,
} from './components/ModelsPanel';
import type { ModelGroupStatus, ModelRailSegment } from './components/ModelStatusRail';
import { buildTrackListRows } from './features/tracks/listRows';
import { SEQUENCE_SECTION_COLORS, assignModelGroupColors } from './lib/groupColors';
import { LoadStateBadge } from './components/LoadStateBadge';
import { SequenceStrip, SEQUENCE_STRIP_MAX_SPAN_BP } from './components/SequenceStrip';
import { trackDataLoader, deriveWindowSpec, buildTrackWindowCacheKey } from './data/trackDataLoader';
import { trackSourceKey } from './data/bbiDataSource';
import { detectGenomeAssembly, loadIdeogramBands } from './data/ideogramCatalog';
import { loadComputationalPack } from './data/computationalPack';
import { warmupComputationalModel } from './data/computationalDataSource';
import {
  INFERENCE_BUDGET_MS,
  effectiveComputationalMaxWindowBp,
  getInferenceCostVersion,
  getInferenceMsPerBp,
  subscribeInferenceCost,
} from './lib/computationalLimits';
import { setViewportDark } from './lib/viewportTheme';
import { SITE_VIEW } from './features/site/profile';
import {
  DEMO_ASSEMBLY_ID,
  DEMO_TRACK_URLS,
  MANE_SELECT_BIGBED_URL,
  gencodeV50Url,
} from './features/genome/demoData';
import { deriveComputationalEligibility } from './lib/computationalEligibility';
import { MODEL_AUTOLOAD_SETTLE_MS, shouldAutoMountModel } from './lib/modelAutoload';
import { layoutTracksForEdits, type SequenceVariant } from './lib/editedSequenceTracks';
import { orientTracksForStrand } from './lib/modelStrand';
import { buildComputationalTrack, replaceComputationalFamilyTracks } from './lib/computationalFamily';
import {
  applyPlotGroupingAction,
  coalesceUserPlotTracks,
  groupTracks,
  renameUserGroup,
  ungroupTracks,
  type PlotGroupingActionKind,
} from './lib/userPlotGroups';
import {
  coalesceComputationalPlotTracks,
  resolveComputationalPlotGroup,
  resolveComputationalTrackSubtracks,
} from './lib/computationalPlotGroups';
import type { TrackScaleRequest } from './lib/signalScale';
import { resolveGestureSource, type WheelGestureLatch, type WheelSample } from './lib/wheelSource';
import { gestureZoomFactor, type TrackpadGestureEvent } from './lib/gestureZoom';
import { useElementWidth } from './hooks/useElementWidth';
import { useGeneSearch } from './hooks/useGeneSearch';
import { useGenomeViewport } from './hooks/useGenomeViewport';
import { useSessionUrlState } from './hooks/useSessionUrlState';
import { BUILTIN_ASSEMBLY_IDS, getAssembly, normalizeChromosomeName } from './features/genome/registry';
import { LocusSearchBox } from './components/LocusSearchBox';
import type { GeneMatch } from './data/geneSearchSource';
import { switchAssemblyState } from './features/genome/switching';
import {
  appShareStateEquals,
  MAX_PERSISTED_MODELS,
  type PersistedModel,
  normalizeAppShareState,
  type AppShareState,
  type PanelMode,
} from './features/session/appShareState';
import {
  deleteTrack,
  normalizeTrackOrder,
  renameTrack,
  reorderTrack,
  toggleTrack,
  type TrackManagerItem,
} from './features/tracks/manager';
import { buildTrackManagerView } from './features/tracks/managerView';
import { validateSourceImport } from './features/sources/importValidation';
import { MODEL_CATALOG, catalogFamilyId, isPackInCatalogFamily, orderCatalogForView, resolveModelVariant, type ModelCatalogEntry, type ModelDemoLocus } from './features/models/catalog';
import { classifyTrackLoadState, type TrackLoadState } from './features/ui/loadStates';
import {
  clamp,
  clampRangeToChromosome,
  formatLocus,
  formatPosition,
  fromDisplayPosition,
} from './lib/genomeMath';
import { deriveComputationalNeighborSpecs, deriveTrackWindowSpec } from './lib/trackWindowSpec';
import type {
  SignalScaleShape,
  Chromosome,
  ComputationalPackManifest,
  DataWindowSpec,
  IdeogramBand,
  SequenceEdit,
  SignalDisplayMode,
  TrackSource,
  TrackSpec,
  TrackWindowData,
  ViewportState,
} from './types';
import './App.css';
import './Workbench.css';

// Only reachable if the assembly registry lookup fails. hg38 lengths, to match the
// app's default assembly -- these were previously hg19 builds, one registry outage
// away from drawing every track against the wrong coordinate system.
const FALLBACK_CHROMOSOMES: Chromosome[] = [
  { id: 'chr1', length: 248_956_422 },
  { id: 'chr2', length: 242_193_529 },
  { id: 'chr7', length: 159_345_973 },
  { id: 'chr11', length: 135_086_622 },
  { id: 'chr17', length: 83_257_441 },
  { id: 'chr21', length: 46_709_983 },
  { id: 'chrX', length: 156_040_895 },
];

/** A gene is framed with 15% of its own length as breathing room on each side. */
const GENE_JUMP_SPAN_PADDING = 1.3;
const GENE_JUMP_MIN_SPAN_BP = 400;

const MIN_BP_PER_PX = 0.15;
const MAX_BP_PER_PX = 2_700_000;
const INITIAL_BP_PER_PX = 18_000;
const ZOOM_IN_FACTOR = 0.72;
const ZOOM_OUT_FACTOR = 1.38;
// Must match --label-width in App.css: it is subtracted from the scene width to get
// the genomic canvas width, and used to anchor cursor-relative zoom.
const DESKTOP_LABEL_WIDTH_PX = 238;
// One per entry in `templates` below. These must stay in step: buildTracks cycles
// `templates[index % templates.length]`, so a count below the template count
// silently drops the trailing templates from the default session.
const DEFAULT_TRACK_COUNT = 5;
const STRESS_TRACK_COUNT = 180;
const MIN_BIN_SCALE = 0.5;
const MAX_BIN_SCALE = 6;
const DEFAULT_BIN_SCALE = 2.4;
/** Brand artwork. Missing is fine: the header falls back to its CSS mark. */
// Identity comes from the VIEW: the build's profile as served at this path, so
// A product's view path on the preview host is that product; `/` is the shared browser.
const BRAND = SITE_VIEW.brand;
// The Models panel lists the view's lead model first: a product's own model on its site.
const VIEW_CATALOG = orderCatalogForView(MODEL_CATALOG, SITE_VIEW.models.leadModelId);
// The model the site mounts on its own (see SiteModels.autoMountModelId), if any.
const AUTO_MOUNT_MODEL_ID = SITE_VIEW.models.autoMountModelId;

const NAV_IGRAM_VALUE = '__ideogram__';
/**
 * Resolved at render to the first data track, or the ideogram when there is
 * none. The navigator covers ±100 kb, a span that usually falls inside a single
 * cytoband, so an annotation track is the more useful default content.
 */
const NAV_AUTO_VALUE = '__auto__';

const palette = ['#fb7185', '#22d3ee', '#34d399', '#a78bfa', '#fbbf24', '#60a5fa', '#f472b6'];

function buildTracks(count: number): TrackSpec[] {
  const templates: Array<Omit<TrackSpec, 'id' | 'color' | 'height'> & { height?: number }> = [
    {
      name: 'GENCODE V50',
      kind: 'annotation',
      height: 96,
      source: {
        type: 'bigbed',
        url: gencodeV50Url(),
        // Zoomed-out views fall back to density summaries from the bigBed zoom index.
        visibilityWindowBp: 8_000_000,
        maneUrl: MANE_SELECT_BIGBED_URL,
      },
    },
    {
      name: 'H3K27ac GM12878',
      kind: 'signal',
      source: { type: 'bigwig', url: DEMO_TRACK_URLS.h3k27ac },
    },
    {
      name: 'H3K4me3 GM12878',
      kind: 'signal',
      source: { type: 'bigwig', url: DEMO_TRACK_URLS.h3k4me3 },
    },
    {
      name: 'H3K4me1 GM12878',
      kind: 'signal',
      source: { type: 'bigwig', url: DEMO_TRACK_URLS.h3k4me1 },
    },
    {
      name: 'ENCODE cCREs',
      kind: 'annotation',
      source: {
        type: 'bigbed',
        url: DEMO_TRACK_URLS.ccre,
        visibilityWindowBp: 18_000_000,
      },
    },
  ];

  return Array.from({ length: count }, (_, index) => {
    const template = templates[index % templates.length];
    const cycle = Math.floor(index / templates.length) + 1;
    return {
      ...template,
      id: `track_${index + 1}`,
      // Number a track only once the same template repeats, so the default session
      // reads "H3K27ac GM12878" while ?preset=stress still gets distinct names.
      name: `${template.name}${cycle > 1 ? ` ${cycle}` : ''}`,
      color: palette[index % palette.length],
      height: template.height ?? (template.kind === 'annotation' ? 74 : 76),
    };
  });
}

const ASSEMBLY_LABELS: Record<string, string> = {
  hg38: 'Human GRCh38 (hg38)',
  hg19: 'Human GRCh37 (hg19)',
  mm10: 'Mouse GRCm38 (mm10)',
};

const UCSC_GENOME_BY_ASSEMBLY: Record<string, string> = {
  hg38: 'hg38',
  hg19: 'hg19',
  mm10: 'mm10',
};

// Derived from the demo tracks rather than picked independently. When these two
// disagreed, the browser drew hg19 files on an hg38 coordinate system and labelled
// the result hg38 -- wrong positions, with nothing on screen to say so.
const DEFAULT_ASSEMBLY_ID = getAssembly(DEMO_ASSEMBLY_ID)
  ? DEMO_ASSEMBLY_ID
  : (BUILTIN_ASSEMBLY_IDS[0] ?? 'hg38');

type ManagedTrack = {
  spec: TrackSpec;
  enabled: boolean;
  order: number;
};

type TrackDataLoaderView = {
  cache: Map<string, TrackWindowData>;
  inFlight: Map<string, Promise<TrackWindowData>>;
};

type ComputationalSlotState = 'ready' | 'shared-ready' | 'loading' | 'shared-loading' | 'missing';

type ComputationalBufferSlot = {
  label: 'L' | 'C' | 'R';
  state: ComputationalSlotState;
  startBp: number;
  endBp: number;
  rangeLabel: string;
};

type ComputationalBufferBarState = 'ready' | 'shared-ready' | 'loading' | 'shared-loading' | 'missing';

type ComputationalBufferBarSegment = {
  startBp: number;
  endBp: number;
  state: ComputationalBufferBarState;
};

type ComputationalBufferRow = {
  trackId: string;
  trackName: string;
  requestRangeLabel: string;
  resolutionLabel: string;
  bufferStartBp: number;
  bufferEndBp: number;
  currentStartBp: number;
  currentEndBp: number;
  readySlots: number;
  totalSlots: number;
  slots: ComputationalBufferSlot[];
  barSegments: ComputationalBufferBarSegment[];
};

type ComputationalBufferDebugHud = {
  viewportRangeLabel: string;
  visibleTrackCount: number;
  totalTrackCount: number;
  fillPercent: number;
  readySlots: number;
  totalSlots: number;
  activeVisibleJobs: number;
  activeGlobalJobs: number;
  computingRanges: string[];
  rows: ComputationalBufferRow[];
  budgetMs: number;
  packBudgets: ComputationalPackBudget[];
};

type ComputationalPackBudget = {
  packId: string;
  name: string;
  maxWindowBp: number;
  calibrated: boolean;
};

type CachedWindowRange = {
  startBp: number;
  endBp: number;
};

function toTrackWindowLoaderKey(track: TrackSpec, chr: string, spec: DataWindowSpec): string {
  return buildTrackWindowCacheKey(track, chr, spec);
}

function toTrackPrefix(track: TrackSpec, chr: string, resolutionBp: number): string {
  const resolution = Math.max(1, Math.floor(resolutionBp));
  return `${trackSourceKey(track)}|${track.kind}|${chr}|comp:r${resolution}`;
}

function computationalPackKey(track: TrackSpec): string | null {
  if (track.source.type !== 'computational') {
    return null;
  }
  return `${track.source.pack.id}|${track.source.packUrl}`;
}

const COMPUTATIONAL_BAR_STATE_PRIORITY: Record<ComputationalBufferBarState, number> = {
  loading: 5,
  'shared-loading': 4,
  ready: 3,
  'shared-ready': 2,
  missing: 1,
};

function toMergedBarSegments(slots: ComputationalBufferSlot[]): ComputationalBufferBarSegment[] {
  if (slots.length === 0) {
    return [];
  }

  const boundaries = Array.from(
    new Set(
      slots.flatMap((slot) => [slot.startBp, slot.endBp]).filter((value) => Number.isFinite(value)),
    ),
  ).sort((left, right) => left - right);

  if (boundaries.length < 2) {
    return [];
  }

  const merged: ComputationalBufferBarSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startBp = boundaries[index];
    const endBp = boundaries[index + 1];
    if (endBp <= startBp) {
      continue;
    }

    const coveringSlots = slots.filter((slot) => slot.startBp < endBp && slot.endBp > startBp);
    let state: ComputationalBufferBarState = 'missing';
    for (const slot of coveringSlots) {
      if (COMPUTATIONAL_BAR_STATE_PRIORITY[slot.state] > COMPUTATIONAL_BAR_STATE_PRIORITY[state]) {
        state = slot.state;
      }
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.state === state && previous.endBp === startBp) {
      previous.endBp = endBp;
      continue;
    }

    merged.push({ startBp, endBp, state });
  }

  return merged;
}

function parseLoaderRangeKey(key: string): { prefix: string; startBp: number; endBp: number; tag: string } | null {
  const segments = key.split('|');
  if (segments.length < 4) {
    return null;
  }

  const locus = segments[2] ?? '';
  const firstColon = locus.indexOf(':');
  if (firstColon <= 0) {
    return null;
  }

  const chr = locus.slice(0, firstColon);
  const bounds = locus.slice(firstColon + 1).split(':');
  if (bounds.length < 2) {
    return null;
  }

  const startBp = Number(bounds[0]);
  const endBp = Number(bounds[1]);
  if (!Number.isFinite(startBp) || !Number.isFinite(endBp)) {
    return null;
  }

  return {
    prefix: `${segments[0]}|${segments[1]}|${chr}`,
    startBp,
    endBp,
    tag: segments[3] ?? '',
  };
}

const EMPTY_COVERAGE_INDEX: Map<string, CachedWindowRange[]> = new Map();

function buildComputationalCoverageIndex(keys: Iterable<string>): Map<string, CachedWindowRange[]> {
  const index = new Map<string, CachedWindowRange[]>();

  for (const key of keys) {
    const parsed = parseLoaderRangeKey(key);
    if (!parsed || !parsed.tag.startsWith('comp:r')) {
      continue;
    }

    const coverageKey = `${parsed.prefix}|${parsed.tag}`;

    const existing = index.get(coverageKey);
    if (existing) {
      existing.push({ startBp: parsed.startBp, endBp: parsed.endBp });
    } else {
      index.set(coverageKey, [{ startBp: parsed.startBp, endBp: parsed.endBp }]);
    }
  }

  return index;
}

function hasCoveringRange(
  index: Map<string, CachedWindowRange[]>,
  prefix: string,
  startBp: number,
  endBp: number,
): boolean {
  const ranges = index.get(prefix);
  if (!ranges || ranges.length === 0) {
    return false;
  }

  for (const range of ranges) {
    if (range.startBp <= startBp && range.endBp >= endBp) {
      return true;
    }
  }

  return false;
}

function resolveAssemblyId(value: unknown): string {
  if (typeof value === 'string' && getAssembly(value)) {
    return value;
  }
  return DEFAULT_ASSEMBLY_ID;
}

function toChromosomeListForAssembly(assemblyId: string): Chromosome[] {
  const assembly = getAssembly(assemblyId) ?? getAssembly(DEFAULT_ASSEMBLY_ID);
  if (!assembly) {
    return FALLBACK_CHROMOSOMES;
  }

  const switched = switchAssemblyState({
    nextChromSizes: assembly.chromSizes,
    selectedChr: 'chr1',
    locus: { start: 0, end: 1 },
  });

  if (switched.chromosomes.length === 0) {
    return FALLBACK_CHROMOSOMES;
  }

  return switched.chromosomes.map((id) => ({
    id,
    length: assembly.chromSizes[id] ?? 1,
  }));
}

function resolveInitialChromosome(assemblyId: string, requestedChr: unknown): string {
  const assembly = getAssembly(assemblyId);
  if (!assembly) {
    return FALLBACK_CHROMOSOMES[0].id;
  }

  const normalizedRequested =
    typeof requestedChr === 'string' && requestedChr.length > 0
      ? normalizeChromosomeName(assemblyId, requestedChr)
      : 'chr1';

  const switched = switchAssemblyState({
    nextChromSizes: assembly.chromSizes,
    selectedChr: normalizedRequested,
    locus: { start: 0, end: 1 },
  });

  return switched.selectedChr;
}

function toMutationItems(records: ManagedTrack[]): TrackManagerItem[] {
  return records.map((record) => ({
    id: record.spec.id,
    name: record.spec.name,
    enabled: record.enabled,
    order: record.order,
  }));
}

function applyManagerMutation(
  records: ManagedTrack[],
  mutate: (items: TrackManagerItem[]) => TrackManagerItem[],
): ManagedTrack[] {
  const byId = new Map(records.map((record) => [record.spec.id, record]));
  const nextItems = mutate(toMutationItems(records));
  const result: ManagedTrack[] = [];

  for (const item of nextItems) {
    const existing = byId.get(item.id);
    if (!existing) {
      continue;
    }

    result.push({
      spec: item.name === existing.spec.name ? existing.spec : { ...existing.spec, name: item.name },
      enabled: item.enabled,
      order: item.order,
    });
  }

  return result;
}

function createInitialManagedTracks(): ManagedTrack[] {
  let count = DEFAULT_TRACK_COUNT;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('preset') === 'stress' || params.get('stress') === '1') {
      count = STRESS_TRACK_COUNT;
    }
  }

  return buildTracks(count).map((spec, order) => ({ spec, enabled: true, order }));
}

function computationalInstanceId(track: TrackSpec): string | null {
  if (track.source.type !== 'computational') {
    return null;
  }
  return track.source.instanceId ?? `${track.source.pack.id}|${track.source.packUrl}`;
}

function modelFocusBpPerPx(
  pack: ComputationalPackManifest,
  viewportWidth: number,
  binScale: number,
  preferredSpanBp?: number,
): number {
  const maxWindowBp = effectiveComputationalMaxWindowBp(pack);
  const safeWindowBp = Math.max(1, Math.floor(maxWindowBp * 0.86));
  const targetSpanBp = Math.min(preferredSpanBp ?? safeWindowBp, safeWindowBp);
  const windowBpPerPx = targetSpanBp / Math.max(1, viewportWidth);
  const maxResolutionBp = pack.inference?.maxResolutionBp;
  const resolutionBpPerPx = maxResolutionBp
    ? (maxResolutionBp * 0.86) / Math.max(MIN_BIN_SCALE, binScale)
    : Number.POSITIVE_INFINITY;
  return clamp(Math.min(windowBpPerPx, resolutionBpPerPx), MIN_BP_PER_PX, MAX_BP_PER_PX);
}

function nextTopOrder(records: ManagedTrack[], insertCount = 1): number {
  const safeInsertCount = Math.max(1, Math.floor(insertCount));
  if (records.length === 0) {
    return 0;
  }

  const currentMinOrder = Math.min(...records.map((record) => record.order));
  return currentMinOrder - safeInsertCount;
}

function filenameFromInput(input: string): string {
  const withoutQuery = input.split(/[?#]/, 1)[0] ?? input;
  const segment = withoutQuery.split(/[\\/]/).pop() ?? '';
  const trimmed = segment.trim();
  return trimmed.length > 0 ? trimmed : 'Imported track';
}

function sourceImportErrorMessage(input: string): string {
  const validation = validateSourceImport(input);
  if (validation.isValid) {
    return '';
  }

  switch (validation.reason) {
    case 'empty-input':
      return 'Enter a source URL or file path.';
    case 'invalid-url':
      return 'Enter a valid URL starting with http:// or https://.';
    case 'missing-extension':
      return 'Source must include a file extension (.bw, .bigWig, .bb, .bigBed, .czpack).';
    case 'unsupported-extension':
      return `Unsupported extension "${validation.extension ?? 'unknown'}". Use .bw, .bigWig, .bb, .bigBed, or .czpack.`;
    default:
      return 'Source input is invalid.';
  }
}

function sourceForExtension(extension: 'bw' | 'bigWig' | 'bb' | 'bigBed', sourceUrl: string): TrackSource {
  if (extension === 'bw' || extension === 'bigWig') {
    return { type: 'bigwig', url: sourceUrl };
  }

  return { type: 'bigbed', url: sourceUrl };
}

type ParsedJump = {
  chr: string;
  center: number;
  nextBpPerPx?: number;
};

function parseJumpInput(input: string, currentChr: string, viewportWidth: number): ParsedJump | null {
  const normalized = input.replace(/,/g, '').trim();
  if (!normalized) {
    return null;
  }

  const rangePattern = /^([^:@-]+)(?::(\d+)-(\d+))$/i;
  const zoomPattern = /^([^:@-]+)(?::(\d+)@(\d+(?:\.\d+)?))$/i;
  const positionPattern = /^([^:@-]+)(?::(\d+))$/i;
  const barePositionPattern = /^(\d+)$/;

  const rangeMatch = normalized.match(rangePattern);
  if (rangeMatch) {
    const chr = rangeMatch[1];
    const start = Number(rangeMatch[2]);
    const end = Number(rangeMatch[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    // Typed coordinates are 1-based inclusive; internally a range is 0-based
    // half-open, so the start moves and the end stays put.
    const internalStart = fromDisplayPosition(start);
    return {
      chr,
      center: (internalStart + end) / 2,
      nextBpPerPx: (end - internalStart) / Math.max(100, viewportWidth),
    };
  }

  const zoomMatch = normalized.match(zoomPattern);
  if (zoomMatch) {
    const chr = zoomMatch[1];
    const center = Number(zoomMatch[2]);
    const nextBpPerPx = Number(zoomMatch[3]);
    if (!Number.isFinite(center) || !Number.isFinite(nextBpPerPx)) {
      return null;
    }

    return { chr, center: fromDisplayPosition(center), nextBpPerPx };
  }

  const positionMatch = normalized.match(positionPattern);
  if (positionMatch) {
    const chr = positionMatch[1];
    const center = Number(positionMatch[2]);
    if (!Number.isFinite(center)) {
      return null;
    }
    return { chr, center: fromDisplayPosition(center) };
  }

  const barePositionMatch = normalized.match(barePositionPattern);
  if (barePositionMatch) {
    const center = Number(barePositionMatch[1]);
    if (!Number.isFinite(center)) {
      return null;
    }

    return { chr: currentChr, center: fromDisplayPosition(center) };
  }

  return null;
}

function App() {
  const defaultSessionState = useMemo<AppShareState>(() => {
    const defaultNavigatorTrackId = (() => {
      if (typeof window === 'undefined') {
        return NAV_AUTO_VALUE;
      }

      try {
        return window.localStorage.getItem('seqbrowser:navigatorTrackId') ?? NAV_AUTO_VALUE;
      } catch {
        return NAV_AUTO_VALUE;
      }
    })();

    const defaultBinScale = (() => {
      if (typeof window === 'undefined') {
        return DEFAULT_BIN_SCALE;
      }

      try {
        const stored = Number(window.localStorage.getItem('seqbrowser:binScale'));
        if (Number.isFinite(stored)) {
          return clamp(stored, MIN_BIN_SCALE, MAX_BIN_SCALE);
        }
      } catch {
        // Ignore storage access failures.
      }

      return DEFAULT_BIN_SCALE;
    })();

    return {
      assemblyId: DEFAULT_ASSEMBLY_ID,
      chr: 'chr1',
      search: '',
      binScale: defaultBinScale,
      activePanel: 'none',
      navigatorTrackId: defaultNavigatorTrackId,
    };
  }, []);

  const [rawSessionState, setSessionState] = useSessionUrlState<Record<string, unknown>>(
    'state',
    defaultSessionState,
  );
  const sessionState = useMemo(
    () =>
      normalizeAppShareState(rawSessionState, {
        defaultAssemblyId: defaultSessionState.assemblyId,
        defaultChr: defaultSessionState.chr,
        defaultSearch: defaultSessionState.search,
        defaultBinScale: defaultSessionState.binScale,
        minBinScale: MIN_BIN_SCALE,
        maxBinScale: MAX_BIN_SCALE,
        defaultActivePanel: defaultSessionState.activePanel,
        defaultNavigatorTrackId: defaultSessionState.navigatorTrackId,
        minBpPerPx: MIN_BP_PER_PX,
        maxBpPerPx: MAX_BP_PER_PX,
        chrLengthById:
          getAssembly(resolveAssemblyId((rawSessionState as Record<string, unknown>).assemblyId))
            ?.chromSizes ?? undefined,
      }),
    [defaultSessionState, rawSessionState],
  );

  const initialAssemblyId = resolveAssemblyId(sessionState.assemblyId);
  const [assemblyId, setAssemblyId] = useState(initialAssemblyId);
  const [chrId, setChrId] = useState(() => resolveInitialChromosome(initialAssemblyId, sessionState.chr));
  const [hostElement, setHostElement] = useState<HTMLElement | null>(null);
  const trackScrollerRef = useRef<HTMLElement | null>(null);
  const wheelGestureRef = useRef<WheelGestureLatch | null>(null);
  // A Safari trackpad pinch, between gesturestart and gestureend.
  const pinchGestureRef = useRef({ active: false, scale: 1, anchorPx: 0 });
  const [visibleRange, setVisibleRange] = useState<ListRange>({ startIndex: 0, endIndex: 20 });
  const [loaderEpoch, setLoaderEpoch] = useState(0);
  const [jumpInput, setJumpInput] = useState('');
  const [searchQuery, setSearchQuery] = useState(sessionState.search);
  const [activePanel, setActivePanel] = useState<PanelMode>(sessionState.activePanel);
  // On a phone the strand/zoom/bin row costs a sixth of the screen, and pinch
  // and swipe do the same job; it starts collapsed there behind a line that
  // still reads the strand and the zoom. Ignored above phone width.
  const [transportOpen, setTransportOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(() => {
    try { return localStorage.getItem('seqbrowser:libraryOpen') !== 'false'; } catch { return true; }
  });
  const changeLibraryOpen = (open: boolean) => {
    setLibraryOpen(open);
    try { localStorage.setItem('seqbrowser:libraryOpen', String(open)); } catch { /* Storage is optional. */ }
  };
  const [fps, setFps] = useState(0);
  const [navigatorTrackId, setNavigatorTrackId] = useState(sessionState.navigatorTrackId);
  const [binScale, setBinScale] = useState(sessionState.binScale);
  const [managedTracks, setManagedTracks] = useState<ManagedTrack[]>(createInitialManagedTracks);
  const [dataImportError, setDataImportError] = useState<string | null>(null);
  const [modelImportError, setModelImportError] = useState<string | null>(null);
  const [modelActionState, setModelActionState] = useState<ModelActionState>(null);
  // The sequence the user is editing. Empty means the pinned row IS the reference
  // and nothing else is shown; once it has edits, the original drops beneath it
  // as a reference track and model plots re-run on the edit above it.
  const [sequenceEdits, setSequenceEdits] = useState<SequenceEdit[]>([]);
  // Reference track ids the user chose not to mirror onto the edited sequence.
  // Every shown model output is mirrored by default; this is the opt-out.
  const [hiddenOnEdited, setHiddenOnEdited] = useState<string[]>([]);
  // The strand rides in the session URL like the locus does: a refresh of a
  // minus-strand gene used to come back reading the plus strand.
  const [sequenceReversed, setSequenceReversed] = useState(sessionState.strand === '-');
  // The artwork is transparent, so the CSS fallback mark has to be taken away
  // once it lands rather than left to show through it.
  const [brandArtLoaded, setBrandArtLoaded] = useState(false);
  const sequenceVariantScope = `${assemblyId}:${chrId}`;
  const [activeSequenceVariantScope, setActiveSequenceVariantScope] = useState(sequenceVariantScope);
  if (activeSequenceVariantScope !== sequenceVariantScope) {
    setActiveSequenceVariantScope(sequenceVariantScope);
    setSequenceEdits([]);
  }
  const autoMountEnsureRef = useRef<Promise<void> | null>(null);
  const plotGroupCounterRef = useRef(0);

  const showPerfHud = useMemo(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1' || params.get('perf') === '1') {
      return true;
    }

    try {
      return window.localStorage.getItem('seqbrowser:debug') === '1';
    } catch {
      return false;
    }
  }, []);

  const pendingJumpRef = useRef<ParsedJump | null>(null);
  const didApplySharedViewportRef = useRef(false);
  const sessionWriteTimeoutRef = useRef<number | null>(null);
  // Session model restore is a one-shot: guard against StrictMode's double effect
  // and against later session writes re-triggering it.
  const restoredModelsRef = useRef(false);
  const importCounterRef = useRef(0);
  const scaleGroupCounterRef = useRef(0);
  const objectUrlByTrackIdRef = useRef<Map<string, string>>(new Map());
  const [ideogramBandsByChr, setIdeogramBandsByChr] = useState<Record<string, IdeogramBand[]> | null>(null);

  useEffect(() => {
    return trackDataLoader.subscribe(() => {
      setLoaderEpoch((previous) => previous + 1);
    });
  }, []);

  const assemblyOptions = useMemo(
    () =>
      BUILTIN_ASSEMBLY_IDS.map((id) => ({
        id,
        label: `${id} · ${ASSEMBLY_LABELS[id] ?? id}`,
      })),
    [],
  );
  const ucscGenome = useMemo(() => UCSC_GENOME_BY_ASSEMBLY[assemblyId] ?? assemblyId, [assemblyId]);

  const chromosomes = useMemo(() => toChromosomeListForAssembly(assemblyId), [assemblyId]);
  // Keeps UCSC's alt/random/unplaced contigs out of the suggestion list: the
  // registry only carries primary chromosomes, so nothing else is jumpable.
  const isKnownChromosome = useCallback(
    (chr: string) => chromosomes.some((item) => item.id === chr),
    [chromosomes],
  );

  const orderedManagedTracks = useMemo(() => {
    return [...managedTracks].sort((left, right) => left.order - right.order);
  }, [managedTracks]);

  // What the session URL carries for mounted models: where to re-fetch each pack and
  // which of its outputs were shown. Grouped by instance so mounting the same pack
  // twice round-trips as two entries rather than collapsing into one.
  const persistedModels = useMemo<PersistedModel[] | undefined>(() => {
    const byInstance = new Map<string, PersistedModel>();
    for (const record of orderedManagedTracks) {
      const source = record.spec.source;
      if (source.type !== 'computational') {
        continue;
      }
      const instanceId = computationalInstanceId(record.spec);
      if (!instanceId) {
        continue;
      }
      const existing = byInstance.get(instanceId);
      const entry = existing ?? { url: source.packUrl, id: source.pack.id, shown: [] };
      if (record.enabled) {
        entry.shown?.push(source.subtrack.id);
      }
      byInstance.set(instanceId, entry);
    }
    const models = Array.from(byInstance.values()).slice(0, MAX_PERSISTED_MODELS);
    return models.length > 0 ? models : undefined;
  }, [orderedManagedTracks]);

  const managerItems = useMemo(() => {
    return buildTrackManagerView(orderedManagedTracks);
  }, [orderedManagedTracks]);

  // Every mounted model is a group with a colour of its own, in mount order;
  // the same colour marks its header in the list, the rails of its rows, and
  // its collection in the Tracks panel.
  const mountedInstanceIds = useMemo(
    () => orderedManagedTracks.flatMap((record) => {
      const instanceId = computationalInstanceId(record.spec);
      return instanceId ? [instanceId] : [];
    }),
    [orderedManagedTracks],
  );
  const modelGroupColors = useMemo(() => assignModelGroupColors(mountedInstanceIds), [mountedInstanceIds]);

  const dataSourceItems = useMemo<DataSourcePanelItem[]>(() => {
    return orderedManagedTracks.flatMap((record) => {
      const source = record.spec.source;
      if (source.type === 'computational' || source.type === 'sequence-variant') {
        return [];
      }
      return [{
        id: record.spec.id,
        name: record.spec.name,
        format: source.type === 'bigwig' ? 'BW' as const : source.type === 'bigbed' ? 'BB' as const : 'DATA' as const,
        source:
          source.type === 'bigwig' || source.type === 'bigbed' ? source.url : 'Built-in demonstration data',
        enabled: record.enabled,
      }];
    });
  }, [orderedManagedTracks]);

  const installedModelIds = useMemo(
    () =>
      Array.from(
        new Set(
          orderedManagedTracks.flatMap((record) =>
            record.spec.source.type === 'computational' ? [record.spec.source.pack.id] : [],
          ),
        ),
      ),
    [orderedManagedTracks],
  );

  const modelOutputGroupStates = useMemo<ModelOutputGroupState[]>(() => {
    const states = new Map<
      string,
      { modelId: string; groupId: string; all: Set<string>; shown: Set<string> }
    >();

    for (const record of orderedManagedTracks) {
      if (record.spec.source.type !== 'computational') {
        continue;
      }
      const { pack, subtrack } = record.spec.source;
      if (!subtrack.groupId) {
        continue;
      }

      const key = `${pack.id}|${subtrack.groupId}`;
      const state = states.get(key) ?? {
        modelId: pack.id,
        groupId: subtrack.groupId,
        all: new Set<string>(),
        shown: new Set<string>(),
      };
      state.all.add(subtrack.id);
      if (record.enabled) {
        state.shown.add(subtrack.id);
      }
      states.set(key, state);
    }

    return Array.from(states.values(), (state) => ({
      modelId: state.modelId,
      groupId: state.groupId,
      shown: state.shown.size,
      total: state.all.size,
      shownIds: Array.from(state.shown),
    }));
  }, [orderedManagedTracks]);

  const sequenceVariant = useMemo<SequenceVariant | null>(
    () => (sequenceEdits.length > 0 ? { id: 'edited', edits: sequenceEdits } : null),
    [sequenceEdits],
  );

  const hiddenOnEditedSet = useMemo(() => new Set(hiddenOnEdited), [hiddenOnEdited]);
  const enabledTracks = useMemo(() => {
    // Pack plots first; then the strand on every computational row, so the
    // members a user group captures already carry it; then the user's combined
    // plots; then the edited-sequence layout, which mirrors every model row.
    return layoutTracksForEdits(
      coalesceUserPlotTracks(
        orientTracksForStrand(
          coalesceComputationalPlotTracks(
            orderedManagedTracks.filter((record) => record.enabled).map((record) => record.spec),
          ),
          sequenceReversed,
        ),
      ),
      sequenceVariant,
      hiddenOnEditedSet,
    );
  }, [hiddenOnEditedSet, orderedManagedTracks, sequenceVariant, sequenceReversed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('seqbrowser:binScale', binScale.toString());
    } catch {
      // Ignore storage write failures.
    }
  }, [binScale]);

  const ideogramAssembly = useMemo(() => detectGenomeAssembly(chromosomes), [chromosomes]);

  useEffect(() => {
    if (!ideogramAssembly) {
      return;
    }

    let cancelled = false;
    loadIdeogramBands(ideogramAssembly)
      .then((bandsByChr) => {
        if (cancelled) {
          return;
        }
        setIdeogramBandsByChr(bandsByChr);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setIdeogramBandsByChr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [ideogramAssembly]);

  const hostWidth = useElementWidth(hostElement);
  const labelWidthPx = useMemo(() => {
    // A media-query label-width change also changes the observed host width;
    // reading it keeps this CSS measurement synchronized with responsive layout.
    void hostWidth;
    if (!hostElement || typeof getComputedStyle !== 'function') {
      return DESKTOP_LABEL_WIDTH_PX;
    }
    const cssWidth = Number.parseFloat(getComputedStyle(hostElement).getPropertyValue('--label-width'));
    return Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : DESKTOP_LABEL_WIDTH_PX;
  }, [hostElement, hostWidth]);
  const viewportWidth = Math.max(1, Math.floor(hostWidth - labelWidthPx));

  const effectiveChrId = useMemo(
    () => (chromosomes.some((item) => item.id === chrId) ? chrId : chromosomes[0]?.id ?? FALLBACK_CHROMOSOMES[0].id),
    [chrId, chromosomes],
  );

  const chromosome = useMemo(
    () => chromosomes.find((item) => item.id === effectiveChrId) ?? chromosomes[0] ?? FALLBACK_CHROMOSOMES[0],
    [chromosomes, effectiveChrId],
  );

  const {
    centerBp,
    bpPerPx,
    range,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    zoomByWheel,
    panByPixels,
    zoomByFactor,
    jumpToCenter,
    setExactBpPerPx,
  } = useGenomeViewport({
    chrLength: chromosome.length,
    widthPx: viewportWidth,
    initialCenterBp: chromosome.length / 2,
    initialBpPerPx: INITIAL_BP_PER_PX,
    minBpPerPx: MIN_BP_PER_PX,
    maxBpPerPx: MAX_BP_PER_PX,
    resetToken: `${assemblyId}:${chromosome.id}`,
    // Reading the minus strand mirrors the view, so a drag or swipe to the right
    // must still move what is under the pointer to the right.
    mirrored: sequenceReversed,
  });

  const filteredTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return enabledTracks;
    }

    return enabledTracks.filter((track) => {
      if (track.name.toLowerCase().includes(q) || track.kind.toLowerCase().includes(q)) {
        return true;
      }
      return track.source.type === 'computational'
        ? track.source.pack.name.toLowerCase().includes(q) ||
            track.source.pack.id.toLowerCase().includes(q) ||
            resolveComputationalTrackSubtracks(track.source).some((subtrack) =>
              subtrack.name.toLowerCase().includes(q),
            )
        : false;
    });
  }, [enabledTracks, searchQuery]);

  // The navigator requests an entire chromosome. Live sequence models are
  // deliberately excluded until a persisted coarse summary exists, so choosing a
  // model can never trigger an impossible chromosome-wide inference.
  const navigatorTracks = useMemo(
    () =>
      enabledTracks.filter(
        (track) => track.source.type !== 'computational' && track.source.type !== 'sequence-variant',
      ),
    [enabledTracks],
  );

  const effectiveNavigatorTrackId = useMemo(() => {
    if (navigatorTrackId === NAV_AUTO_VALUE) {
      // A first visit follows the site: a general browser opens on the chromosome
      // ideogram, a gene-centred one on the first annotation track. The user's own
      // pick, once made, is stored and wins over this.
      if (SITE_VIEW.navigator === 'ideogram') {
        return NAV_IGRAM_VALUE;
      }
      return navigatorTracks[0]?.id ?? NAV_IGRAM_VALUE;
    }

    if (navigatorTrackId === NAV_IGRAM_VALUE) {
      return NAV_IGRAM_VALUE;
    }

    if (navigatorTracks.some((track) => track.id === navigatorTrackId)) {
      return navigatorTrackId;
    }

    return NAV_IGRAM_VALUE;
  }, [navigatorTrackId, navigatorTracks]);

  useEffect(() => {
    try {
      window.localStorage.setItem('seqbrowser:navigatorTrackId', effectiveNavigatorTrackId);
    } catch {
      // Ignore storage write failures.
    }
  }, [effectiveNavigatorTrackId]);

  const navigatorTrack = useMemo(() => {
    if (effectiveNavigatorTrackId === NAV_IGRAM_VALUE) {
      return null;
    }

    return navigatorTracks.find((track) => track.id === effectiveNavigatorTrackId) ?? null;
  }, [effectiveNavigatorTrackId, navigatorTracks]);

  const navigatorOptions = useMemo(
    () => [
      {
        id: NAV_IGRAM_VALUE,
        label: ideogramAssembly ? `ideogram (${ideogramAssembly})` : 'ideogram',
      },
      ...navigatorTracks.map((track) => ({
        id: track.id,
        label: track.name,
      })),
    ],
    [ideogramAssembly, navigatorTracks],
  );

  const navigatorIdeogramBands = useMemo(() => {
    if (navigatorTrack || !ideogramAssembly) {
      return null;
    }

    return ideogramBandsByChr?.[chromosome.id] ?? null;
  }, [chromosome.id, ideogramAssembly, ideogramBandsByChr, navigatorTrack]);

  const viewport: ViewportState = useMemo(
    () => ({
      assemblyId,
      chr: chromosome.id,
      chrLength: chromosome.length,
      widthPx: viewportWidth,
      centerBp,
      bpPerPx,
      range,
    }),
    [assemblyId, bpPerPx, centerBp, chromosome.id, chromosome.length, range, viewportWidth],
  );

  const boundedRange = useMemo(
    () => clampRangeToChromosome(viewport.range, viewport.chrLength),
    [viewport.chrLength, viewport.range],
  );

  const windowSpec = useMemo(
    () =>
      deriveWindowSpec(
        viewport.chr,
        viewport.chrLength,
        viewport.centerBp,
        viewport.bpPerPx,
        viewport.widthPx,
        binScale,
      ),
    [binScale, viewport.bpPerPx, viewport.centerBp, viewport.chr, viewport.chrLength, viewport.widthPx],
  );

  const hasComputationalTracks = useMemo(
    () => filteredTracks.some((track) => track.source.type === 'computational'),
    [filteredTracks],
  );

  // Budgeted window caps depend on each model's measured cost; re-derive load
  // status and the buffer HUD when a calibration lands.
  const inferenceCostVersion = useSyncExternalStore(
    subscribeInferenceCost,
    getInferenceCostVersion,
    getInferenceCostVersion,
  );

  // Theme: 'system' follows the OS; 'light'/'dark' pin it via a data attribute the
  // stylesheet keys on. Persisted so a reload keeps the user's choice.
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('seqbrowser:theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
    try {
      if (theme === 'system') {
        localStorage.removeItem('seqbrowser:theme');
      } else {
        localStorage.setItem('seqbrowser:theme', theme);
      }
    } catch {
      // Persistence is best-effort (private mode, test env).
    }
  }, [theme]);

  // Keep the canvas palette store in sync with the effective theme, including live
  // OS changes while on 'system' (CSS handles those via media query; the canvases
  // need to be told).
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') {
      return;
    }
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemPrefersDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const isDark = theme === 'dark' || (theme === 'system' && systemPrefersDark);
  useEffect(() => {
    setViewportDark(isDark);
  }, [isDark]);
  const cycleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  // Building these indexes walks every loader cache key, so it must not sit on the
  // per-frame path. The loader maps only change when `loaderEpoch` ticks, and with
  // no computational tracks mounted nothing reads the result at all.
  const computationalCoverage = useMemo(() => {
    void loaderEpoch;
    if (!hasComputationalTracks) {
      return { cache: EMPTY_COVERAGE_INDEX, inFlight: EMPTY_COVERAGE_INDEX };
    }
    const loaderView = trackDataLoader as unknown as TrackDataLoaderView;
    return {
      cache: buildComputationalCoverageIndex(loaderView.cache.keys()),
      inFlight: buildComputationalCoverageIndex(loaderView.inFlight.keys()),
    };
  }, [hasComputationalTracks, loaderEpoch]);

  const modelGroupStatuses = useMemo<ModelGroupStatus[]>(() => {
    void loaderEpoch;
    void inferenceCostVersion;
    const recordsByInstance = new Map<string, ManagedTrack[]>();

    for (const record of orderedManagedTracks) {
      const instanceId = computationalInstanceId(record.spec);
      if (!instanceId) {
        continue;
      }
      const existing = recordsByInstance.get(instanceId);
      if (existing) {
        existing.push(record);
      } else {
        recordsByInstance.set(instanceId, [record]);
      }
    }

    return Array.from(recordsByInstance, ([instanceId, records]) => {
      const firstTrack = records[0]?.spec;
      if (!firstTrack || firstTrack.source.type !== 'computational') {
        return null;
      }

      const visibleTracks = records.filter((record) => record.enabled).map((record) => record.spec);
      // The same rows the canvas requests, strand included: the readiness check
      // reads the cache by key, and a minus-strand window has its own. (A user
      // group's members are fetched under their own keys, so they are checked
      // as themselves.)
      const renderedVisibleTracks = orientTracksForStrand(coalesceComputationalPlotTracks(visibleTracks), sequenceReversed);

      const pack = firstTrack.source.pack;
      const eligibility = deriveComputationalEligibility(pack, viewport, windowSpec.resolutionBp);
      const currentSpec = deriveTrackWindowSpec(firstTrack, viewport, windowSpec);
      const slotSpecs = [...deriveComputationalNeighborSpecs(firstTrack, viewport, currentSpec), currentSpec].sort(
        (left, right) => left.requestStart - right.requestStart,
      );
      const bufferStart = Math.min(...slotSpecs.map((spec) => spec.requestStart));
      const bufferEnd = Math.max(...slotSpecs.map((spec) => spec.requestEnd));
      const bufferSpan = Math.max(1, bufferEnd - bufferStart);
      // Each rendered row answers for itself. A row paid per base on screen (a
      // mutagenesis row) has a focused window of its own: a wider cached window
      // covering the range is not its work done, so it is read by its exact
      // key, and only for the current slot -- it has no neighbours. Without
      // this the rail said "Ready locally" through the whole mutagenesis.
      const loaderView = trackDataLoader as unknown as TrackDataLoaderView;
      const rowChecks = renderedVisibleTracks.map((track) => {
        const ownSpec = deriveTrackWindowSpec(track, viewport, windowSpec);
        // A mutagenesis row wider than its declared span does not compute at
        // this zoom and says so in its own row; it has no bearing on whether
        // the model has computed the view.
        if (track.source.type === 'computational' && track.source.subtrack.mutagenesis && !ownSpec.focus) {
          return { focused: true, ready: () => true, computing: () => false };
        }
        if (ownSpec.focus) {
          const key = toTrackWindowLoaderKey(track, viewport.chr, ownSpec);
          return {
            focused: true,
            ready: (spec: DataWindowSpec) => spec !== currentSpec || loaderView.cache.has(key),
            computing: (spec: DataWindowSpec) => spec === currentSpec && loaderView.inFlight.has(key),
          };
        }
        const prefix = toTrackPrefix(track, viewport.chr, currentSpec.resolutionBp);
        return {
          focused: false,
          ready: (spec: DataWindowSpec) =>
            hasCoveringRange(computationalCoverage.cache, prefix, spec.requestStart, spec.requestEnd),
          computing: (spec: DataWindowSpec) =>
            hasCoveringRange(computationalCoverage.inFlight, prefix, spec.requestStart, spec.requestEnd),
        };
      });
      // The predictions are done and only the mutagenesis is still running: the
      // tracks are on screen, so the rail names what is left rather than
      // reporting the whole view as computing.
      const onlyMutagenesisComputing =
        rowChecks.some((check) => check.focused && check.computing(currentSpec)) &&
        rowChecks.every((check) => check.focused || check.ready(currentSpec));

      const segments: ModelRailSegment[] = slotSpecs.map((spec, index) => {
        const isReady = rowChecks.length > 0 && rowChecks.every((check) => check.ready(spec));
        const isComputing = rowChecks.some((check) => check.computing(spec));
        return {
          key: `${spec.requestStart}:${spec.requestEnd}:${index}`,
          state: isReady ? 'ready' : isComputing ? 'computing' : 'missing',
          leftPercent: ((spec.requestStart - bufferStart) / bufferSpan) * 100,
          widthPercent: ((spec.requestEnd - spec.requestStart) / bufferSpan) * 100,
        };
      });
      const currentSegment = segments[slotSpecs.findIndex((spec) => spec === currentSpec)] ?? segments[0];
      const currentState = currentSegment?.state ?? 'missing';
      const state: ModelGroupStatus['state'] =
        visibleTracks.length === 0
          ? 'hidden'
          : eligibility.reason === 'requires-assembly'
          ? 'requires-assembly'
          : eligibility.reason === 'window' || eligibility.reason === 'resolution'
            ? 'fit-window'
            : currentState === 'computing'
              ? 'computing'
              : currentState === 'ready'
                ? 'ready'
                : 'preparing';
      const stateLabel =
        state === 'hidden'
          ? 'All outputs hidden'
          : state === 'requires-assembly'
          ? `Requires ${pack.assemblyId}`
          : state === 'fit-window'
            ? eligibility.reason === 'resolution'
              ? `Zoom in to <= ${eligibility.maxResolutionBp?.toLocaleString('en-US')} bp/bin`
              : `Zoom in to <= ${eligibility.maxWindowBp.toLocaleString('en-US')} bp window`
            : state === 'computing'
              ? onlyMutagenesisComputing
                ? 'Computing ISM'
                : 'Computing this view'
              : state === 'ready'
                ? 'Ready locally'
                : 'Ready to compute this view';
      const catalogName =
        MODEL_CATALOG.find((model) => model.id === pack.id)?.name ??
        MODEL_CATALOG.find((model) => model.variants?.some((variant) => variant.id === pack.id))?.name;

      return {
        instanceId,
        packId: pack.id,
        name: catalogName ?? pack.name,
        assemblyId: pack.assemblyId,
        visibleOutputCount: visibleTracks.length,
        availableOutputCount: records.length,
        state,
        stateLabel,
        segments,
        currentLeftPercent: ((currentSpec.requestStart - bufferStart) / bufferSpan) * 100,
        currentWidthPercent: ((currentSpec.requestEnd - currentSpec.requestStart) / bufferSpan) * 100,
      } satisfies ModelGroupStatus;
    }).filter((group): group is NonNullable<typeof group> => group !== null);
  }, [
    computationalCoverage,
    inferenceCostVersion,
    loaderEpoch,
    orderedManagedTracks,
    sequenceReversed,
    viewport,
    windowSpec,
  ]);

  const modelStatusByInstance = useMemo(
    () => new Map(modelGroupStatuses.map((status) => [status.instanceId, status] as const)),
    [modelGroupStatuses],
  );
  // The list as rows: a header above each mounted model, a header above each
  // of its collections, then the tracks. Derived from the tracks on every
  // render, so the headers follow the rows wherever they are.
  const trackListRows = useMemo(
    () => buildTrackListRows(filteredTracks, modelGroupColors, Array.from(modelStatusByInstance.keys())),
    [filteredTracks, modelGroupColors, modelStatusByInstance],
  );
  const openModelsPanel = useCallback(() => setActivePanel('models'), []);

  // The buffer pill earns attention only when a load LINGERS. During ordinary
  // panning windows resolve in well under a second while the previous window is
  // still on screen -- flashing "loading buffer" over a view that looks fine
  // taught the eye to ignore it. Brief loads never surface; the pill appears
  // only after loading has persisted, and clears immediately.
  const [showLoadIndicator, setShowLoadIndicator] = useState(false);

  const visibleLoadStatus = useMemo(() => {
    if (filteredTracks.length === 0) {
      return {
        trackStates: [] as TrackLoadState[],
        showIndicator: false,
        mode: 'loading' as 'loading' | 'computing',
      };
    }

    // Keep load-state derivation in sync with mutable loader maps and the budgeted
    // window caps (which depend on measured inference cost).
    void loaderEpoch;
    void inferenceCostVersion;
    const loaderView = trackDataLoader as unknown as TrackDataLoaderView;
    const computationalCacheCoverage = computationalCoverage.cache;
    const computationalInFlightCoverage = computationalCoverage.inFlight;
    const startIndex = clamp(visibleRange.startIndex, 0, filteredTracks.length - 1);
    const endIndex = clamp(visibleRange.endIndex, startIndex, filteredTracks.length - 1);
    const trackStates: TrackLoadState[] = [];
    let hasLoading = false;
    let hasComputationalLoading = false;

    for (let index = startIndex; index <= endIndex; index += 1) {
      const track = filteredTracks[index];
      if (!track) {
        continue;
      }
      const requestSpec = deriveTrackWindowSpec(track, viewport, windowSpec);
      const key = toTrackWindowLoaderKey(track, viewport.chr, requestSpec);

      if (loaderView.inFlight.has(key)) {
        trackStates.push('loading');
        hasLoading = true;
        if (track.source.type === 'computational') {
          hasComputationalLoading = true;
        }
        continue;
      }

      const cachedWindow = loaderView.cache.get(key);
      if (cachedWindow) {
        trackStates.push(classifyTrackLoadState({ featureCount: cachedWindow.features.length }));
        continue;
      }

      if (track.source.type === 'computational') {
        const prefix = toTrackPrefix(track, viewport.chr, requestSpec.resolutionBp);
        if (hasCoveringRange(computationalCacheCoverage, prefix, requestSpec.requestStart, requestSpec.requestEnd)) {
          trackStates.push('ready');
          continue;
        }
        if (hasCoveringRange(computationalInFlightCoverage, prefix, requestSpec.requestStart, requestSpec.requestEnd)) {
          trackStates.push('loading');
          hasLoading = true;
          hasComputationalLoading = true;
          continue;
        }
      }

      trackStates.push('empty');
    }

    return {
      trackStates,
      showIndicator: hasLoading,
      mode: hasComputationalLoading ? 'computing' as const : 'loading' as const,
    };
  }, [
    computationalCoverage,
    filteredTracks,
    inferenceCostVersion,
    loaderEpoch,
    viewport,
    visibleRange.endIndex,
    visibleRange.startIndex,
    windowSpec,
  ]);

  useEffect(() => {
    // One timer both ways: 600ms to appear, next tick to clear.
    const next = visibleLoadStatus.showIndicator;
    const timer = window.setTimeout(() => setShowLoadIndicator(next), next ? 600 : 0);
    return () => window.clearTimeout(timer);
  }, [visibleLoadStatus.showIndicator]);

  const computationalBufferDebugHud = useMemo<ComputationalBufferDebugHud | null>(() => {
    if (filteredTracks.length === 0 || !hasComputationalTracks) {
      return null;
    }

    // Keep debug state synced with mutable loader maps and the budgeted caps.
    void loaderEpoch;
    void inferenceCostVersion;
    const loaderView = trackDataLoader as unknown as TrackDataLoaderView;
    const computationalCacheCoverage = computationalCoverage.cache;
    const computationalInFlightCoverage = computationalCoverage.inFlight;
    const clampedStartIndex = clamp(visibleRange.startIndex, 0, filteredTracks.length - 1);
    const clampedEndIndex = clamp(visibleRange.endIndex, clampedStartIndex, filteredTracks.length - 1);
    const visibleComputationalTracks: TrackSpec[] = [];
    let totalComputationalTracks = 0;

    for (let index = 0; index < filteredTracks.length; index += 1) {
      const track = filteredTracks[index];
      if (track?.source.type !== 'computational') {
        continue;
      }
      totalComputationalTracks += 1;
      if (index >= clampedStartIndex && index <= clampedEndIndex) {
        visibleComputationalTracks.push(track);
      }
    }

    if (totalComputationalTracks === 0) {
      return null;
    }

    let readySlots = 0;
    let loadingSlots = 0;
    let missingSlots = 0;
    const computingRanges: string[] = [];
    const tracksByComputationalPack = new Map<string, TrackSpec[]>();

    for (const track of filteredTracks) {
      const packKey = computationalPackKey(track);
      if (!packKey) {
        continue;
      }
      const existing = tracksByComputationalPack.get(packKey);
      if (existing) {
        existing.push(track);
      } else {
        tracksByComputationalPack.set(packKey, [track]);
      }
    }

    const rows = visibleComputationalTracks.slice(0, 8).map((track) => {
      const packKey = computationalPackKey(track);
      const packTracks = packKey ? tracksByComputationalPack.get(packKey) ?? [track] : [track];
      const currentSpec = deriveTrackWindowSpec(track, viewport, windowSpec);
      const trackPrefix = toTrackPrefix(track, viewport.chr, currentSpec.resolutionBp);
      const neighborSpecs = deriveComputationalNeighborSpecs(track, viewport, currentSpec);
      const leftSpec =
        neighborSpecs
          .filter((spec) => spec.requestStart < currentSpec.requestStart)
          .sort((left, right) => right.requestStart - left.requestStart)[0] ?? null;
      const rightSpec =
        neighborSpecs
          .filter((spec) => spec.requestStart > currentSpec.requestStart)
          .sort((left, right) => left.requestStart - right.requestStart)[0] ?? null;
      const slotSpecs: Array<{ label: 'L' | 'C' | 'R'; spec: DataWindowSpec }> = [];
      if (leftSpec) {
        slotSpecs.push({ label: 'L', spec: leftSpec });
      }
      slotSpecs.push({ label: 'C', spec: currentSpec });
      if (rightSpec) {
        slotSpecs.push({ label: 'R', spec: rightSpec });
      }

      const slots: ComputationalBufferSlot[] = slotSpecs.map(({ label, spec }) => {
        let state: ComputationalSlotState = 'missing';
        if (hasCoveringRange(computationalCacheCoverage, trackPrefix, spec.requestStart, spec.requestEnd)) {
          state = 'ready';
          readySlots += 1;
        } else if (hasCoveringRange(computationalInFlightCoverage, trackPrefix, spec.requestStart, spec.requestEnd)) {
          state = 'loading';
          loadingSlots += 1;
          computingRanges.push(
            `${track.name} ${formatLocus(viewport.chr, spec.requestStart, spec.requestEnd)}`,
          );
        } else {
          let sharedReady = false;
          let sharedLoading = false;

          for (const siblingTrack of packTracks) {
            if (siblingTrack.id === track.id) {
              continue;
            }
            if (
              track.source.type !== 'computational' ||
              siblingTrack.source.type !== 'computational' ||
              siblingTrack.source.subtrack.groupId !== track.source.subtrack.groupId
            ) {
              continue;
            }

            const siblingPrefix = toTrackPrefix(siblingTrack, viewport.chr, spec.resolutionBp);
            if (hasCoveringRange(computationalCacheCoverage, siblingPrefix, spec.requestStart, spec.requestEnd)) {
              sharedReady = true;
              break;
            }
            if (hasCoveringRange(computationalInFlightCoverage, siblingPrefix, spec.requestStart, spec.requestEnd)) {
              sharedLoading = true;
            }
          }

          if (sharedReady) {
            state = 'shared-ready';
            readySlots += 1;
          } else if (sharedLoading) {
            state = 'shared-loading';
            loadingSlots += 1;
          } else {
            missingSlots += 1;
          }
        }

        return {
          label,
          state,
          startBp: spec.requestStart,
          endBp: spec.requestEnd,
          rangeLabel: formatLocus(viewport.chr, spec.requestStart, spec.requestEnd),
        };
      });

      const rowReadySlots = slots.reduce(
        (count, slot) => count + (slot.state === 'ready' || slot.state === 'shared-ready' ? 1 : 0),
        0,
      );
      const bufferStartBp = Math.min(...slots.map((slot) => slot.startBp));
      const bufferEndBp = Math.max(...slots.map((slot) => slot.endBp));
      return {
        trackId: track.id,
        trackName: track.name,
        requestRangeLabel: formatLocus(viewport.chr, currentSpec.requestStart, currentSpec.requestEnd),
        resolutionLabel: `~${currentSpec.resolutionBp.toLocaleString()} bp`,
        bufferStartBp,
        bufferEndBp,
        currentStartBp: currentSpec.requestStart,
        currentEndBp: currentSpec.requestEnd,
        readySlots: rowReadySlots,
        totalSlots: slots.length,
        slots,
        barSegments: toMergedBarSegments(slots),
      };
    });

    const totalSlots = readySlots + loadingSlots + missingSlots;
    const fillPercent = totalSlots > 0 ? Math.round((readySlots / totalSlots) * 100) : 0;
    let activeGlobalJobs = 0;
    for (const key of loaderView.inFlight.keys()) {
      if (key.startsWith('computational:')) {
        activeGlobalJobs += 1;
      }
    }

    // The window cap each model is allowed to compute, derived from the latency
    // budget and this device's measured cost (see effectiveComputationalMaxWindowBp).
    const packBudgets: ComputationalPackBudget[] = [];
    const seenPackIds = new Set<string>();
    for (const track of visibleComputationalTracks) {
      if (track.source.type !== 'computational') {
        continue;
      }
      const pack = track.source.pack;
      if (seenPackIds.has(pack.id)) {
        continue;
      }
      seenPackIds.add(pack.id);
      packBudgets.push({
        packId: pack.id,
        name: pack.name,
        maxWindowBp: effectiveComputationalMaxWindowBp(pack),
        calibrated: getInferenceMsPerBp(pack.model.url) !== undefined,
      });
    }

    return {
      viewportRangeLabel: formatLocus(viewport.chr, boundedRange.start, boundedRange.end),
      visibleTrackCount: visibleComputationalTracks.length,
      totalTrackCount: totalComputationalTracks,
      fillPercent,
      readySlots,
      totalSlots,
      activeVisibleJobs: loadingSlots,
      activeGlobalJobs,
      computingRanges: Array.from(new Set(computingRanges)).slice(0, 4),
      rows,
      budgetMs: INFERENCE_BUDGET_MS,
      packBudgets,
    };
  }, [
    boundedRange.end,
    boundedRange.start,
    computationalCoverage,
    filteredTracks,
    hasComputationalTracks,
    inferenceCostVersion,
    loaderEpoch,
    viewport,
    visibleRange.endIndex,
    visibleRange.startIndex,
    windowSpec,
  ]);

  useEffect(() => {
    const preventBrowserPinchZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };

    const preventGestureZoom = (event: Event) => {
      event.preventDefault();
    };

    window.addEventListener('wheel', preventBrowserPinchZoom, {
      passive: false,
      capture: true,
    });
    window.addEventListener('gesturestart', preventGestureZoom, { passive: false });
    window.addEventListener('gesturechange', preventGestureZoom, { passive: false });
    window.addEventListener('gestureend', preventGestureZoom, { passive: false });

    return () => {
      window.removeEventListener('wheel', preventBrowserPinchZoom, true);
      window.removeEventListener('gesturestart', preventGestureZoom);
      window.removeEventListener('gesturechange', preventGestureZoom);
      window.removeEventListener('gestureend', preventGestureZoom);
    };
  }, []);

  useEffect(() => {
    if (!hostElement) {
      return;
    }

    // Safari reports a trackpad pinch as gesture events; Chromium and Firefox
    // synthesize a ctrl-key wheel instead, which the wheel handler below zooms
    // on. Taking the default away here (Safari's own page zoom) without zooming
    // the view is what left pinch dead in Safari while it worked everywhere else.
    const anchorOf = (gesture: TrackpadGestureEvent): number | null => {
      const clientX = gesture.clientX;
      if (typeof clientX !== 'number' || !Number.isFinite(clientX)) {
        return null;
      }
      return clientX - hostElement.getBoundingClientRect().left - labelWidthPx;
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const gesture = event as TrackpadGestureEvent;
      pinchGestureRef.current = {
        active: true,
        scale: typeof gesture.scale === 'number' && gesture.scale > 0 ? gesture.scale : 1,
        anchorPx: anchorOf(gesture) ?? viewportWidth * 0.5,
      };
    };

    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as TrackpadGestureEvent;
      const pinch = pinchGestureRef.current;
      if (!pinch.active || typeof gesture.scale !== 'number') {
        return;
      }

      const factor = gestureZoomFactor(pinch.scale, gesture.scale);
      pinch.scale = gesture.scale;
      pinch.anchorPx = anchorOf(gesture) ?? pinch.anchorPx;
      if (factor !== 1) {
        zoomByFactor(factor, pinch.anchorPx);
      }
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      pinchGestureRef.current = { active: false, scale: 1, anchorPx: 0 };
    };

    hostElement.addEventListener('gesturestart', onGestureStart, { passive: false });
    hostElement.addEventListener('gesturechange', onGestureChange, { passive: false });
    hostElement.addEventListener('gestureend', onGestureEnd, { passive: false });

    return () => {
      hostElement.removeEventListener('gesturestart', onGestureStart);
      hostElement.removeEventListener('gesturechange', onGestureChange);
      hostElement.removeEventListener('gestureend', onGestureEnd);
      pinchGestureRef.current = { active: false, scale: 1, anchorPx: 0 };
    };
  }, [hostElement, labelWidthPx, viewportWidth, zoomByFactor]);

  // Wheel routing, by input device:
  //   pinch (browsers set ctrlKey)      -> zoom
  //   mouse wheel                       -> zoom, anchored under the cursor
  //   touchpad two-finger vertical      -> scroll the track list
  //   horizontal                        -> pan the genome
  //   shift + vertical                  -> scroll the track list (mouse escape hatch)
  // Attached natively (non-passive) because React's delegated wheel listener is
  // passive, so preventDefault there cannot stop the list from also scrolling.
  useEffect(() => {
    if (!hostElement) {
      return;
    }

    const scrollTracks = (event: WheelEvent) => {
      const scroller = trackScrollerRef.current;
      if (!scroller) {
        return;
      }
      event.preventDefault();
      const step =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * scroller.clientHeight
            : event.deltaY;
      scroller.scrollTop += step;
    };

    const onWheelNative = (event: WheelEvent) => {
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);

      // Trackpad pinch arrives as a wheel event with ctrlKey synthesized. Always zoom,
      // regardless of which device the surrounding gesture was classified as.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        // A pinch already arriving as gesture events (Safari) must not zoom
        // twice, should an engine ever send both for one gesture.
        if (pinchGestureRef.current.active) {
          return;
        }
        const rect = hostElement.getBoundingClientRect();
        zoomByWheel(event.deltaY, event.deltaMode, event.clientX - rect.left - labelWidthPx);
        return;
      }

      if (absX > absY * 1.1) {
        event.preventDefault();
        const deltaPx =
          event.deltaMode === 1
            ? event.deltaX * 16
            : event.deltaMode === 2
              ? event.deltaX * Math.max(1, viewportWidth)
              : event.deltaX;
        if (Math.abs(deltaPx) > 0.001) {
          panByPixels(deltaPx);
        }
        return;
      }

      if (absY < 0.001) {
        return;
      }

      const sample: WheelSample = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        wheelDeltaY: (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
      };
      const now = performance.now();
      const source = resolveGestureSource(wheelGestureRef.current, sample, now);
      wheelGestureRef.current = { source, lastEventAt: now };

      if (event.shiftKey || source === 'trackpad') {
        scrollTracks(event);
        return;
      }

      event.preventDefault();
      const rect = hostElement.getBoundingClientRect();
      zoomByWheel(event.deltaY, event.deltaMode, event.clientX - rect.left - labelWidthPx);
    };

    hostElement.addEventListener('wheel', onWheelNative, { passive: false });
    return () => hostElement.removeEventListener('wheel', onWheelNative);
  }, [hostElement, labelWidthPx, panByPixels, viewportWidth, zoomByWheel]);

  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.chr !== chromosome.id) {
      return;
    }

    // Zoom first: jumpToCenter clamps the target so the whole window stays on the
    // chromosome, so a gene near a telomere would be shoved half a screen inward
    // if the old, wider zoom were still in force.
    if (pending.nextBpPerPx) {
      setExactBpPerPx(pending.nextBpPerPx);
    }
    jumpToCenter(clamp(pending.center, 1, chromosome.length));
    pendingJumpRef.current = null;
  }, [chromosome.id, chromosome.length, jumpToCenter, setExactBpPerPx]);

  useEffect(() => {
    if (didApplySharedViewportRef.current) {
      return;
    }

    if (sessionState.centerBp !== undefined) {
      jumpToCenter(clamp(sessionState.centerBp, 1, chromosome.length));
    }
    if (sessionState.bpPerPx !== undefined) {
      setExactBpPerPx(sessionState.bpPerPx);
    }
    didApplySharedViewportRef.current = true;
  }, [chromosome.length, jumpToCenter, sessionState.bpPerPx, sessionState.centerBp, setExactBpPerPx]);

  useEffect(() => {
    if (viewportWidth <= 0 || filteredTracks.length === 0) {
      return;
    }

    const from = Math.max(0, visibleRange.startIndex - 8);
    const to = Math.min(filteredTracks.length - 1, visibleRange.endIndex + 8);
    const prefetchSpec = {
      key: windowSpec.key,
      requestStart: windowSpec.requestStart,
      requestEnd: windowSpec.requestEnd,
      resolutionBp: windowSpec.resolutionBp,
    };

    for (let index = from; index <= to; index += 1) {
      const track = filteredTracks[index];
      if (!track || track.source.type === 'computational' || track.source.type === 'sequence-variant') {
        continue;
      }
      trackDataLoader.prefetch(track, viewport.chr, prefetchSpec);
    }
  }, [
    filteredTracks,
    visibleRange.endIndex,
    visibleRange.startIndex,
    viewport.chr,
    viewportWidth,
    windowSpec.key,
    windowSpec.requestEnd,
    windowSpec.requestStart,
    windowSpec.resolutionBp,
  ]);

  useEffect(() => {
    const nextSessionState = normalizeAppShareState(
      {
        assemblyId,
        chr: chromosome.id,
        search: searchQuery,
        binScale,
        activePanel,
        navigatorTrackId: effectiveNavigatorTrackId,
        centerBp,
        bpPerPx,
        strand: sequenceReversed ? '-' : '+',
        models: persistedModels,
      },
      {
        defaultAssemblyId: defaultSessionState.assemblyId,
        defaultChr: chromosome.id,
        defaultSearch: defaultSessionState.search,
        defaultBinScale: defaultSessionState.binScale,
        minBinScale: MIN_BIN_SCALE,
        maxBinScale: MAX_BIN_SCALE,
        defaultActivePanel: defaultSessionState.activePanel,
        defaultNavigatorTrackId: defaultSessionState.navigatorTrackId,
        minBpPerPx: MIN_BP_PER_PX,
        maxBpPerPx: MAX_BP_PER_PX,
        chrLengthById: getAssembly(assemblyId)?.chromSizes,
      },
    );

    if (appShareStateEquals(sessionState, nextSessionState)) {
      if (sessionWriteTimeoutRef.current !== null) {
        window.clearTimeout(sessionWriteTimeoutRef.current);
        sessionWriteTimeoutRef.current = null;
      }
      return;
    }

    if (sessionWriteTimeoutRef.current !== null) {
      window.clearTimeout(sessionWriteTimeoutRef.current);
      sessionWriteTimeoutRef.current = null;
    }

    sessionWriteTimeoutRef.current = window.setTimeout(() => {
      setSessionState(nextSessionState);
      sessionWriteTimeoutRef.current = null;
    }, 120);

    return () => {
      if (sessionWriteTimeoutRef.current !== null) {
        window.clearTimeout(sessionWriteTimeoutRef.current);
        sessionWriteTimeoutRef.current = null;
      }
    };
  }, [
    activePanel,
    assemblyId,
    binScale,
    bpPerPx,
    centerBp,
    chromosome.id,
    defaultSessionState,
    effectiveNavigatorTrackId,
    sequenceReversed,
    persistedModels,
    searchQuery,
    sessionState,
    setSessionState,
  ]);

  useEffect(() => {
    const objectUrlByTrackId = objectUrlByTrackIdRef.current;
    return () => {
      for (const objectUrl of objectUrlByTrackId.values()) {
        URL.revokeObjectURL(objectUrl);
      }
      objectUrlByTrackId.clear();
    };
  }, []);

  const handleAssemblyChange = useCallback(
    (nextAssemblyId: string) => {
      const resolvedAssemblyId = resolveAssemblyId(nextAssemblyId);
      if (resolvedAssemblyId === assemblyId) {
        return;
      }

      const nextAssembly = getAssembly(resolvedAssemblyId);
      if (!nextAssembly) {
        setAssemblyId(resolvedAssemblyId);
        return;
      }

      const switched = switchAssemblyState({
        nextChromSizes: nextAssembly.chromSizes,
        selectedChr: normalizeChromosomeName(resolvedAssemblyId, chromosome.id),
        locus: {
          start: boundedRange.start,
          end: boundedRange.end,
        },
      });

      setAssemblyId(resolvedAssemblyId);
      setChrId(switched.selectedChr);
      setJumpInput('');
      pendingJumpRef.current = null;
    },
    [assemblyId, boundedRange.end, boundedRange.start, chromosome.id],
  );

  const mountComputationalPack = useCallback(
    (
      pack: ComputationalPackManifest,
      sourceUrl: string,
      requestedInstanceId?: string,
      // Restoring a session pins visibility to what was shown then, rather than
      // re-applying manifest defaults over the top of the user's choices.
      shownSubtrackIds?: readonly string[],
    ): string[] => {
      if (pack.assemblyId && pack.assemblyId !== assemblyId && getAssembly(pack.assemblyId)) {
        // Switch first; the shared eligibility guard keeps the model paused until
        // the new reference is active, so no output can be labeled on the old one.
        handleAssemblyChange(pack.assemblyId);
      }

      const now = Date.now();
      importCounterRef.current += 1;
      const instanceId = requestedInstanceId ?? `model_${pack.id}_${now}_${importCounterRef.current}`;
      const additions = pack.subtracks.map((subtrack) => {
        importCounterRef.current += 1;
        const trackId = `import_${pack.id}_${subtrack.id}_${now}_${importCounterRef.current}`;
        const record: ManagedTrack = {
          ...buildComputationalTrack({
            pack,
            sourceUrl,
            instanceId,
            subtrack,
            trackId,
            enabled: shownSubtrackIds ? shownSubtrackIds.includes(subtrack.id) : subtrack.defaultVisible !== false,
          }),
          order: 0,
        };
        return { id: trackId, record };
      });

      setManagedTracks((previous) => {
        let nextOrder = nextTopOrder(previous, additions.length);
        return [
          ...previous,
          ...additions.map(({ record }) => {
            const nextRecord = { ...record, order: nextOrder };
            nextOrder += 1;
            return nextRecord;
          }),
        ];
      });
      setSearchQuery('');
      setModelImportError(null);
      return additions.map(({ id }) => id);
    },
    [assemblyId, handleAssemblyChange],
  );

  // Re-mount models the session was carrying. Runs once: a link or a refresh should
  // bring back what was on screen, but nothing here should fight the user afterwards.
  //
  // Anything that does not resolve is skipped rather than failing the restore -- a
  // pack URL can 404 (an unpublished model on the public site), or now serve a
  // different pack than the one the link recorded. Losing one model is recoverable;
  // losing the whole session because of one is not.
  useEffect(() => {
    if (restoredModelsRef.current) {
      return;
    }
    restoredModelsRef.current = true;

    const models = sessionState.models;
    if (!models || models.length === 0) {
      return;
    }

    // Deliberately not cancelled on cleanup. React StrictMode mounts, unmounts and
    // remounts in development; cancelling on that simulated unmount aborted the only
    // run, while the one-shot ref above blocked the retry, so nothing was ever
    // restored. The ref is what prevents duplicates -- cleanup must not fight it.
    void (async () => {
      for (const entry of models) {
        try {
          const pack = await loadComputationalPack(entry.url);
          if (pack.id !== entry.id) {
            // That URL serves something else now; mounting it would silently
            // substitute a different model for the one the link named.
            continue;
          }
          mountComputationalPack(pack, entry.url, undefined, entry.shown);
          void warmupComputationalModel(pack).catch(() => undefined);
        } catch {
          // Unavailable pack: leave it out and keep restoring the rest.
        }
      }
    })();
  }, [mountComputationalPack, sessionState.models]);

  const appendImportedTrack = useCallback(
    async (
      input: string,
      sourceUrlOverride?: string,
      destination: 'data' | 'model' = 'data',
    ): Promise<string[] | null> => {
      const trimmedInput = input.trim();
      const validation = validateSourceImport(trimmedInput);
      if (!validation.isValid) {
        const message = sourceImportErrorMessage(trimmedInput);
        if (destination === 'model') setModelImportError(message);
        else setDataImportError(message);
        return null;
      }

      if (destination === 'data' && validation.extension === 'czpack') {
        setDataImportError('Add .czpack sequence models from Models, not Data.');
        return null;
      }
      if (destination === 'model' && validation.extension !== 'czpack') {
        setModelImportError('Model packs must use the .czpack extension.');
        return null;
      }

      const sourceUrl = sourceUrlOverride ?? trimmedInput;
      if (validation.extension === 'czpack') {
        let pack;
        try {
          pack = await loadComputationalPack(sourceUrl);
        } catch (error) {
          setModelImportError(error instanceof Error ? error.message : 'Failed to import computational pack');
          return null;
        }

        const importedTrackIds = mountComputationalPack(pack, sourceUrl);
        // Generic import remains non-blocking; the Models flow below offers the
        // guided prepare-then-fit experience.
        void warmupComputationalModel(pack);
        return importedTrackIds;
      }

      importCounterRef.current += 1;
      const trackId = `import_${Date.now()}_${importCounterRef.current}`;
      const kind = validation.extension === 'bw' || validation.extension === 'bigWig' ? 'signal' : 'annotation';
      const colorIndex = importCounterRef.current % palette.length;
      const trackSpec: TrackSpec = {
        id: trackId,
        name: filenameFromInput(trimmedInput),
        kind,
        color: palette[colorIndex],
        height: kind === 'annotation' ? 74 : 76,
        source: sourceForExtension(validation.extension, sourceUrl),
      };

      setManagedTracks((previous) => {
        const nextOrder = nextTopOrder(previous);

        return [
          ...previous,
          {
            spec: trackSpec,
            enabled: true,
            order: nextOrder,
          },
        ];
      });
      setDataImportError(null);
      return [trackId];
    },
    [mountComputationalPack],
  );

  const handleDataSourceSubmit = useCallback(
    async (input: string): Promise<boolean> => {
      const imported = await appendImportedTrack(input, undefined, 'data');
      return Boolean(imported?.length);
    },
    [appendImportedTrack],
  );

  const handleModelSourceSubmit = useCallback(
    async (input: string): Promise<boolean> => {
      const imported = await appendImportedTrack(input, undefined, 'model');
      return Boolean(imported?.length);
    },
    [appendImportedTrack],
  );

  const importLocalFile = useCallback(
    async (file: File, destination: 'data' | 'model'): Promise<boolean> => {
      const objectUrl = URL.createObjectURL(file);
      const importedTrackIds = await appendImportedTrack(file.name, objectUrl, destination);
      if (!importedTrackIds || importedTrackIds.length === 0) {
        URL.revokeObjectURL(objectUrl);
        return false;
      }

      for (const importedTrackId of importedTrackIds) {
        objectUrlByTrackIdRef.current.set(importedTrackId, objectUrl);
      }
      return true;
    },
    [appendImportedTrack],
  );

  const handleLocalDataFiles = useCallback(
    async (files: File[]): Promise<boolean> => {
      const results = await Promise.all(files.map((file) => importLocalFile(file, 'data')));
      return results.some(Boolean);
    },
    [importLocalFile],
  );

  const releaseObjectUrlForTrack = useCallback((trackId: string) => {
    const objectUrlByTrackId = objectUrlByTrackIdRef.current;
    const objectUrl = objectUrlByTrackId.get(trackId);
    if (!objectUrl) {
      return;
    }

    objectUrlByTrackId.delete(trackId);
    const isStillReferenced = Array.from(objectUrlByTrackId.values()).some((value) => value === objectUrl);
    if (!isStillReferenced) {
      URL.revokeObjectURL(objectUrl);
    }
  }, []);

  const handleTrackToggle = useCallback((trackId: string) => {
    setManagedTracks((previous) => applyManagerMutation(previous, (items) => toggleTrack(items, trackId)));
  }, []);

  const handleTrackMove = useCallback((trackId: string, delta: number) => {
    setManagedTracks((previous) =>
      applyManagerMutation(previous, (items) => {
        const normalized = normalizeTrackOrder(items);
        const fromIndex = normalized.findIndex((item) => item.id === trackId);
        if (fromIndex < 0) {
          return normalized;
        }

        return reorderTrack(normalized, trackId, fromIndex + delta);
      }),
    );
  }, []);

  const handleTrackGroupMove = useCallback((trackIds: string[], delta: number) => {
    setManagedTracks((previous) => {
      const view = buildTrackManagerView(previous);
      const requested = new Set(trackIds);
      const fromIndex = view.findIndex((item) =>
        item.memberIds.length === requested.size && item.memberIds.every((id) => requested.has(id)),
      );
      const toIndex = clamp(fromIndex + delta, 0, view.length - 1);
      if (fromIndex < 0 || toIndex === fromIndex) {
        return previous;
      }

      const nextView = [...view];
      const [moving] = nextView.splice(fromIndex, 1);
      nextView.splice(toIndex, 0, moving);
      const recordById = new Map(previous.map((record) => [record.spec.id, record]));

      return nextView.flatMap((item) => item.memberIds).flatMap((id, order) => {
        const record = recordById.get(id);
        return record ? [{ ...record, order }] : [];
      });
    });
  }, []);

  const handleTrackRename = useCallback((trackId: string, name: string) => {
    // Renaming a combined plot names the group; renaming anything else names the track.
    setManagedTracks((previous) =>
      renameUserGroup(previous, trackId, name) ??
      applyManagerMutation(previous, (items) => renameTrack(items, trackId, name)),
    );
  }, []);

  const handleTrackGroup = useCallback((trackIds: string[]) => {
    plotGroupCounterRef.current += 1;
    const groupId = `user-plot-${Date.now()}-${plotGroupCounterRef.current}`;
    setManagedTracks((previous) => groupTracks(previous, trackIds, groupId));
  }, []);

  const handleTrackUngroup = useCallback((trackIds: string[]) => {
    setManagedTracks((previous) => ungroupTracks(previous, trackIds));
  }, []);

  /** A row's split / combine / ungroup button, applied to the members it stands for. */
  const handleRenderedTrackGrouping = useCallback((track: TrackSpec, action: PlotGroupingActionKind) => {
    setManagedTracks((previous) => applyPlotGroupingAction(previous, track, action));
  }, []);

  const handleTrackDelete = useCallback(
    (trackId: string) => {
      releaseObjectUrlForTrack(trackId);

      setManagedTracks((previous) => applyManagerMutation(previous, (items) => deleteTrack(items, trackId)));
      if (navigatorTrackId === trackId) {
        setNavigatorTrackId(NAV_IGRAM_VALUE);
      }
    },
    [navigatorTrackId, releaseObjectUrlForTrack],
  );

  const handleTrackBulkToggle = useCallback((trackIds: string[], nextEnabled: boolean) => {
    if (trackIds.length === 0) {
      return;
    }

    const selectedIdSet = new Set(trackIds);
    setManagedTracks((previous) =>
      applyManagerMutation(previous, (items) =>
        normalizeTrackOrder(items).map((item) =>
          selectedIdSet.has(item.id) ? { ...item, enabled: nextEnabled } : item,
        ),
      ),
    );
  }, []);

  const handleTrackBulkDelete = useCallback(
    (trackIds: string[]) => {
      if (trackIds.length === 0) {
        return;
      }

      const selectedIdSet = new Set(trackIds);
      for (const trackId of selectedIdSet) {
        releaseObjectUrlForTrack(trackId);
      }

      setManagedTracks((previous) =>
        applyManagerMutation(previous, (items) =>
          normalizeTrackOrder(items).filter((item) => !selectedIdSet.has(item.id)),
        ),
      );

      if (selectedIdSet.has(navigatorTrackId)) {
        setNavigatorTrackId(NAV_IGRAM_VALUE);
      }
    },
    [navigatorTrackId, releaseObjectUrlForTrack],
  );

  const handleTrackBulkScale = useCallback((trackIds: string[], request: TrackScaleRequest) => {
    if (trackIds.length === 0) {
      return;
    }

    const selectedIdSet = new Set(trackIds);
    const groupId = request.mode === 'linked'
      ? `linked-scale-${Date.now()}-${++scaleGroupCounterRef.current}`
      : null;
    setManagedTracks((previous) => {
      const selectedPlotKeys = new Set<string>();
      for (const record of previous) {
        if (!selectedIdSet.has(record.spec.id) || record.spec.source.type !== 'computational') {
          continue;
        }
        const plotGroup = resolveComputationalPlotGroup(
          record.spec.source.pack,
          record.spec.source.subtrack,
        );
        const instanceId = computationalInstanceId(record.spec);
        if (plotGroup && instanceId) {
          selectedPlotKeys.add(`${instanceId}|${plotGroup.id}`);
        }
      }

      return previous.map((record) => {
        const source = record.spec.source;
        const plotGroup = source.type === 'computational'
          ? resolveComputationalPlotGroup(source.pack, source.subtrack)
          : null;
        const instanceId = computationalInstanceId(record.spec);
        const belongsToSelectedPlot = Boolean(
          plotGroup && instanceId && selectedPlotKeys.has(`${instanceId}|${plotGroup.id}`),
        );
        if (
          (!selectedIdSet.has(record.spec.id) && !belongsToSelectedPlot) ||
          record.spec.kind !== 'signal'
        ) {
          return record;
        }

        const yScale = request.mode === 'linked'
          ? { mode: 'linked' as const, groupId: groupId as string }
          : request.mode === 'fixed'
            ? { mode: 'fixed' as const, min: request.min, max: request.max }
            : { mode: 'auto' as const };
        return { ...record, spec: { ...record.spec, yScale } };
      });
    });
  }, []);

  const handleTrackBulkDisplay = useCallback((trackIds: string[], signalDisplay: SignalDisplayMode) => {
    if (trackIds.length === 0) {
      return;
    }

    const selectedIdSet = new Set(trackIds);
    setManagedTracks((previous) =>
      previous.map((record) =>
        selectedIdSet.has(record.spec.id) && record.spec.kind === 'signal'
          ? { ...record, spec: { ...record.spec, signalDisplay } }
          : record,
      ),
    );
  }, []);

  const handleRenderedTrackDisplay = useCallback((track: TrackSpec, signalDisplay: SignalDisplayMode) => {
    const renderedInstance = computationalInstanceId(track);
    const representedIds = track.source.type === 'computational'
      ? new Set(track.source.seriesSubtrackIds ?? [track.source.subtrack.id])
      : null;

    setManagedTracks((previous) =>
      previous.map((record) => {
        if (record.spec.kind !== 'signal') {
          return record;
        }
        if (track.source.type !== 'computational') {
          return record.spec.id === track.id
            ? { ...record, spec: { ...record.spec, signalDisplay } }
            : record;
        }
        if (
          record.spec.source.type !== 'computational' ||
          computationalInstanceId(record.spec) !== renderedInstance ||
          !representedIds?.has(record.spec.source.subtrack.id)
        ) {
          return record;
        }
        return { ...record, spec: { ...record.spec, signalDisplay } };
      }),
    );
  }, []);

  /** Same persistence path as the display toggle: the choice lives on the members. */
  /**
   * The reader set a row's height: dragged its edge, or asked it to fit its
   * lanes. Stored on the spec, so the session codec carries it into a link.
   */
  const handleTrackHeightChange = useCallback((track: TrackSpec, heightPx: number) => {
    setManagedTracks((previous) =>
      previous.map((record) =>
        record.spec.id === track.id && record.spec.height !== heightPx
          ? { ...record, spec: { ...record.spec, height: heightPx } }
          : record,
      ),
    );
  }, []);

  const handleRenderedTrackScaleShape = useCallback(
    (track: TrackSpec, scaleShape: SignalScaleShape) => {
      if (track.source.type === 'group') {
        setManagedTracks((previous) => {
          const members = new Set(renderedTrackMemberIds(track, previous));
          return previous.map((record) => members.has(record.spec.id) && record.spec.kind === 'signal'
            ? { ...record, spec: { ...record.spec, scaleShape } } : record);
        });
        return;
      }
      const renderedInstance = computationalInstanceId(track);
      const representedIds = track.source.type === 'computational'
        ? new Set(track.source.seriesSubtrackIds ?? [track.source.subtrack.id])
        : null;

      setManagedTracks((previous) =>
        previous.map((record) => {
          if (record.spec.kind !== 'signal') {
            return record;
          }
          if (track.source.type !== 'computational') {
            return record.spec.id === track.id
              ? { ...record, spec: { ...record.spec, scaleShape } }
              : record;
          }
          if (
            record.spec.source.type !== 'computational' ||
            computationalInstanceId(record.spec) !== renderedInstance ||
            !representedIds?.has(record.spec.source.subtrack.id)
          ) {
            return record;
          }
          return { ...record, spec: { ...record.spec, scaleShape } };
        }),
      );
    },
    [],
  );

  const focusComputationalPack = useCallback(
    (pack: ComputationalPackManifest, demo?: ModelDemoLocus) => {
      const targetAssemblyId = pack.assemblyId && getAssembly(pack.assemblyId) ? pack.assemblyId : assemblyId;
      const targetAssembly = getAssembly(targetAssemblyId);
      const requestedChr = demo?.chr ?? normalizeChromosomeName(targetAssemblyId, chromosome.id);
      const targetChr = targetAssembly?.chromSizes[requestedChr]
        ? requestedChr
        : Object.keys(targetAssembly?.chromSizes ?? {})[0] ?? chromosome.id;
      const targetChrLength = targetAssembly?.chromSizes[targetChr] ?? chromosome.length;
      const targetCenter = clamp(demo?.centerBp ?? centerBp, 1, targetChrLength);
      // The docked Models panel narrows the scene. Focus for the width the genome
      // viewport will have after the panel closes, otherwise the final span grows.
      const expandedViewportWidth = Math.max(
        viewportWidth,
        (hostElement?.parentElement?.clientWidth ?? viewportWidth + labelWidthPx) - labelWidthPx,
      );
      const targetBpPerPx = modelFocusBpPerPx(pack, expandedViewportWidth, binScale, demo?.spanBp);
      const changesReference = targetAssemblyId !== assemblyId;
      const changesChromosome = targetChr !== chromosome.id;

      if (changesReference) {
        handleAssemblyChange(targetAssemblyId);
      }

      if (changesReference || changesChromosome) {
        pendingJumpRef.current = {
          chr: targetChr,
          center: targetCenter,
          nextBpPerPx: targetBpPerPx,
        };
        setChrId(targetChr);
      } else {
        jumpToCenter(targetCenter);
        setExactBpPerPx(targetBpPerPx);
      }

      if (demo?.strand) {
        setSequenceReversed(demo.strand === '-');
      }
      setJumpInput(`${targetChr}:${formatPosition(Math.round(targetCenter))}`);
      setSearchQuery('');
      setActivePanel('none');
      window.requestAnimationFrame(() => hostElement?.focus());
    },
    [
      assemblyId,
      binScale,
      centerBp,
      chromosome.id,
      chromosome.length,
      handleAssemblyChange,
      hostElement,
      jumpToCenter,
      labelWidthPx,
      setExactBpPerPx,
      viewportWidth,
    ],
  );

  const runCatalogModel = useCallback(
    async (model: ModelCatalogEntry, demo?: ModelDemoLocus, options?: { focus?: boolean }) => {
      if (modelActionState?.phase === 'preparing') {
        return;
      }

      const shouldFocus = options?.focus !== false;
      const familyId = catalogFamilyId(model.id);
      const isFamily = (packId: string) => isPackInCatalogFamily(familyId, packId);

      setModelActionState({ modelId: model.id, phase: 'preparing' });
      try {
        const mounted = orderedManagedTracks.find(
          (record) =>
            record.spec.source.type === 'computational' && isFamily(record.spec.source.pack.id),
        );
        let pack: ComputationalPackManifest;
        if (mounted?.spec.source.type === 'computational') {
          if (mounted.spec.source.pack.id === model.id && mounted.spec.source.packUrl === model.url) {
            pack = mounted.spec.source.pack;
          } else {
            pack = await loadComputationalPack(model.url);
            await warmupComputationalModel(pack);
            setManagedTracks((previous) =>
              replaceComputationalFamilyTracks(previous, pack, model.url, isFamily, (subtrack) => {
                importCounterRef.current += 1;
                return `import_${pack.id}_${subtrack.id}_${Date.now()}_${importCounterRef.current}`;
              }),
            );
          }
        } else {
          pack = await loadComputationalPack(model.url);
          await warmupComputationalModel(pack);
          mountComputationalPack(pack, model.url, `catalog_${familyId}`);
        }

        if (shouldFocus) {
          focusComputationalPack(pack, demo);
        }
        setModelActionState(null);
      } catch (error) {
        setModelActionState({
          modelId: model.id,
          phase: 'failed',
          message: error instanceof Error ? error.message : `Couldn’t prepare ${model.name}.`,
        });
      }
    },
    [focusComputationalPack, modelActionState?.phase, mountComputationalPack, orderedManagedTracks],
  );

  const handleTryModelDemo = useCallback(
    (model: ModelCatalogEntry) => {
      void runCatalogModel(model, model.demo);
    },
    [runCatalogModel],
  );

  const handleSelectCheckpoint = useCallback(
    (model: ModelCatalogEntry) => {
      void runCatalogModel(model, undefined, { focus: false });
    },
    [runCatalogModel],
  );

  // The view's landing. A first visit with nothing in the URL opens where the
  // view says: for a model-demo landing, that model's demo -- prepared and
  // mounted, the demo locus on its strand -- so the first screen is the
  // product, not an empty chromosome. A link that carries a session is left
  // alone. One shot, and only once the host is measured, since the demo sizes
  // its window to it.
  const landedRef = useRef(false);
  useEffect(() => {
    const landing = SITE_VIEW.landing;
    if (landedRef.current || landing.kind !== 'model-demo' || hostWidth <= 0) {
      return;
    }
    if (sessionState.centerBp !== undefined || sessionState.models !== undefined) {
      landedRef.current = true;
      return;
    }
    const model = MODEL_CATALOG.find((entry) => entry.id === landing.modelId);
    if (!model?.demo) {
      return;
    }
    // Deferred a tick: the demo is a state change of its own, not part of this
    // render's commit.
    const timer = window.setTimeout(() => {
      if (landedRef.current) {
        return;
      }
      landedRef.current = true;
      handleTryModelDemo(model);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [handleTryModelDemo, hostWidth, sessionState.centerBp, sessionState.models]);

  // The static shell (<title>, favicon) was filled in at build time for the
  // profile; a view served at another path restates them for itself.
  useEffect(() => {
    if (SITE_VIEW.path === '/') {
      return;
    }
    // Plain DOM, not React state: the shell lives outside the root.
    document.title = BRAND.name;
    if (BRAND.logoUrl) {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.type = 'image/png';
      link.href = BRAND.logoUrl;
    }
  }, []);

  const handleRunModelHere = useCallback(
    (model: ModelCatalogEntry) => {
      void runCatalogModel(model);
    },
    [runCatalogModel],
  );

  // Mount the site's auto-mount model, or re-enable its rows if it is mounted
  // and every one of them has been hidden. A no-op on a site without one.
  const ensureAutoMountModel = useCallback(() => {
    const familyId = AUTO_MOUNT_MODEL_ID;
    if (!familyId) {
      return;
    }
    const familyRecords = orderedManagedTracks.filter(
      (record) =>
        record.spec.source.type === 'computational' && isPackInCatalogFamily(familyId, record.spec.source.pack.id),
    );
    if (familyRecords.length > 0) {
      if (!familyRecords.some((record) => record.enabled)) {
        setManagedTracks((previous) =>
          previous.map((record) => {
            if (
              record.spec.source.type !== 'computational' ||
              !isPackInCatalogFamily(familyId, record.spec.source.pack.id)
            ) {
              return record;
            }
            return { ...record, enabled: record.spec.source.subtrack.defaultVisible !== false };
          }),
        );
      }
      return;
    }

    if (autoMountEnsureRef.current) {
      return;
    }

    const family = MODEL_CATALOG.find((model) => model.id === familyId);
    if (!family) {
      return;
    }
    const model = resolveModelVariant(family);
    const task = (async () => {
      const pack = await loadComputationalPack(model.url);
      await warmupComputationalModel(pack);
      mountComputationalPack(pack, model.url, `catalog_${catalogFamilyId(model.id)}`);
    })();
    autoMountEnsureRef.current = task;
    // A background mount that fails (pack 404s, model refuses to load) is not an
    // event the user asked for, so it must not surface as an unhandled rejection.
    // The Models panel still reports the failure if they try explicitly.
    void task
      .catch(() => undefined)
      .finally(() => {
        if (autoMountEnsureRef.current === task) {
          autoMountEnsureRef.current = null;
        }
      });
  }, [mountComputationalPack, orderedManagedTracks]);

  // Auto-mount the site's model once the view is close enough to be worth
  // scoring. Fires at most once per session and never when it is already
  // mounted, so removing the track stays a decision the browser respects rather
  // than undoes.
  //
  // The mount is held back until the zoom settles: it costs a pack fetch and a
  // WASM warm-up, which has no business landing in the middle of a wheel gesture
  // that is only passing through 20 kb on its way somewhere else.
  const autoMountFiredRef = useRef(false);
  useEffect(() => {
    const familyId = AUTO_MOUNT_MODEL_ID;
    if (!familyId) {
      return;
    }
    const eligible = shouldAutoMountModel({
      hostWidth,
      spanBp: boundedRange.span,
      assemblyId,
      packAssemblyId: MODEL_CATALOG.find((model) => model.id === familyId)?.assemblyId,
      alreadyFired: autoMountFiredRef.current,
    });
    if (!eligible) {
      return;
    }

    const timer = window.setTimeout(() => {
      autoMountFiredRef.current = true;
      if (!installedModelIds.some((packId) => isPackInCatalogFamily(familyId, packId))) {
        ensureAutoMountModel();
      }
    }, MODEL_AUTOLOAD_SETTLE_MS);

    return () => window.clearTimeout(timer);
  }, [assemblyId, boundedRange.span, ensureAutoMountModel, hostWidth, installedModelIds]);

  /**
   * Every insertion on screen, from every variant. The rows open a gap wherever
   * one of them inserted bases, which is what lets the reference be read against
   * a modified copy of it column by column.
   */
  /**
   * Every edit on screen, of every kind. Tracks mark where the sequence was
   * changed -- a substitution tints its base, a deletion its bases, an insertion
   * its opened columns -- so an edit reads across the whole browser, not only on
   * the row it was typed into. Geometry still comes from the insertions alone.
   */
  const sharedEdits = sequenceEdits;

  // The pinned row is a text field over the reference. Its edits are the one
  // edited sequence; the first edit makes the original drop beneath it as a
  // reference track and re-runs the comparison plots on the edit above it.
  const handleSequenceEditsChange = useCallback(
    (next: SequenceEdit[]) => {
      setSequenceEdits(next);
      if (next.length > 0) {
        ensureAutoMountModel();
      }
    },
    [ensureAutoMountModel],
  );

  const handleResetSequence = useCallback(() => setSequenceEdits([]), []);

  const handleHideOnEdited = useCallback((track: TrackSpec) => {
    if (track.source.type !== 'computational' || !track.source.editedFrom) {
      return;
    }
    const from = track.source.editedFrom;
    setHiddenOnEdited((previous) => (previous.includes(from) ? previous : [...previous, from]));
  }, []);
  const handleShowAllOnEdited = useCallback(() => setHiddenOnEdited([]), []);

  // Removing a model is one click, like adding it: every track of the instance
  // goes, through the same path the Tracks panel's delete uses.
  const handleRemoveModelInstance = useCallback(
    (instanceId: string) => {
      handleTrackBulkDelete(
        orderedManagedTracks
          .filter((record) => computationalInstanceId(record.spec) === instanceId)
          .map((record) => record.spec.id),
      );
    },
    [handleTrackBulkDelete, orderedManagedTracks],
  );
  const handleRemoveModel = useCallback(
    (model: ModelCatalogEntry) => {
      handleTrackBulkDelete(
        orderedManagedTracks
          .filter(
            (record) =>
              record.spec.source.type === 'computational' &&
              isPackInCatalogFamily(catalogFamilyId(model.id), record.spec.source.pack.id),
          )
          .map((record) => record.spec.id),
      );
    },
    [handleTrackBulkDelete, orderedManagedTracks],
  );

  const handleFitModelInstance = useCallback(
    (instanceId: string) => {
      const mounted = orderedManagedTracks.find((record) => computationalInstanceId(record.spec) === instanceId);
      if (mounted?.spec.source.type === 'computational') {
        focusComputationalPack(mounted.spec.source.pack);
      }
    },
    [focusComputationalPack, orderedManagedTracks],
  );

  const handleSetModelOutputGroup = useCallback(
    (modelId: string, groupId: string, visible: boolean) => {
      setManagedTracks((previous) =>
        previous.map((record) => {
          if (
            record.spec.source.type !== 'computational' ||
            record.spec.source.pack.id !== modelId ||
            record.spec.source.subtrack.groupId !== groupId ||
            record.enabled === visible
          ) {
            return record;
          }
          return { ...record, enabled: visible };
        }),
      );
      if (visible) {
        setSearchQuery('');
      }
    },
    [],
  );

  const handleSetModelOutput = useCallback(
    (modelId: string, groupId: string, outputId: string, visible: boolean) => {
      setManagedTracks((previous) =>
        previous.map((record) => {
          if (
            record.spec.source.type !== 'computational' ||
            record.spec.source.pack.id !== modelId ||
            record.spec.source.subtrack.groupId !== groupId ||
            record.spec.source.subtrack.id !== outputId ||
            record.enabled === visible
          ) {
            return record;
          }
          return { ...record, enabled: visible };
        }),
      );
      if (visible) {
        setSearchQuery('');
        // DNA-height tracks become immediately inspectable rather than appearing
        // as an ordinary binned waveform that still requires a hidden zoom step.
        setExactBpPerPx(MIN_BP_PER_PX);
      }
    },
    [setExactBpPerPx],
  );

  /** Apply a parsed jump, hopping chromosomes first when the target is elsewhere. */
  const applyParsedJump = (parsed: ParsedJump, label?: string) => {
    const normalizedChr = normalizeChromosomeName(assemblyId, parsed.chr);
    const nextChromosome = chromosomes.find((item) => item.id.toLowerCase() === normalizedChr.toLowerCase());
    if (!nextChromosome) {
      return;
    }

    const clampedCenter = clamp(parsed.center, 1, nextChromosome.length);
    const normalizedJump: ParsedJump = {
      chr: nextChromosome.id,
      center: clampedCenter,
      nextBpPerPx: parsed.nextBpPerPx,
    };

    setJumpInput(label ?? `${nextChromosome.id}:${formatPosition(clampedCenter)}`);

    if (nextChromosome.id !== chromosome.id) {
      pendingJumpRef.current = normalizedJump;
      setChrId(nextChromosome.id);
      return;
    }

    if (parsed.nextBpPerPx) {
      setExactBpPerPx(parsed.nextBpPerPx);
    }
    jumpToCenter(clampedCenter);
  };

  /** Frame a gene the way UCSC does: the whole feature, plus a little air. */
  const handleGeneSelect = (match: GeneMatch) => {
    const span = Math.max(GENE_JUMP_MIN_SPAN_BP, (match.end - match.start + 1) * GENE_JUMP_SPAN_PADDING);

    applyParsedJump(
      {
        chr: match.chr,
        center: (match.start + match.end) / 2,
        nextBpPerPx: span / Math.max(100, viewportWidth),
      },
      formatLocus(match.chr, match.start, match.end),
    );
    // A gene is read on its own strand: a minus-strand gene opens minus, so a
    // transcript model scores it the way round it was trained.
    if (match.strand) {
      setSequenceReversed(match.strand === '-');
    }
  };

  const handleLocusSubmit = () => {
    const parsed = parseJumpInput(jumpInput, chromosome.id, viewportWidth);
    if (parsed) {
      applyParsedJump(parsed);
      return;
    }

    // Enter on a symbol takes the top match once UCSC answers.
    const [topMatch] = geneSearch.matches;
    if (topMatch) {
      handleGeneSelect(topMatch);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }

    if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') {
      event.preventDefault();
      panByPixels(-viewport.widthPx * 0.16);
      return;
    }

    if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') {
      event.preventDefault();
      panByPixels(viewport.widthPx * 0.16);
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomByFactor(ZOOM_IN_FACTOR);
      return;
    }

    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomByFactor(ZOOM_OUT_FACTOR);
    }
  };

  const zoomSliderMin = Math.log10(MIN_BP_PER_PX);
  const zoomOutCapBpPerPx = Math.max(
    MIN_BP_PER_PX,
    Math.min(MAX_BP_PER_PX, chromosome.length / Math.max(1, viewport.widthPx)),
  );
  const sequenceActivationBpPerPx = SEQUENCE_STRIP_MAX_SPAN_BP / Math.max(1, viewport.widthPx);
  const zoomToSequenceLevelBpPerPx = clamp(
    sequenceActivationBpPerPx,
    MIN_BP_PER_PX,
    zoomOutCapBpPerPx,
  );
  const zoomToSequenceLevelDisabled = bpPerPx <= zoomToSequenceLevelBpPerPx * 1.01;
  const zoomSliderMax = Math.log10(zoomOutCapBpPerPx);
  const zoomSliderValue = clamp(Math.log10(bpPerPx), zoomSliderMin, zoomSliderMax);
  const zoomLabel = `${bpPerPx.toFixed(bpPerPx < 1 ? 3 : bpPerPx < 100 ? 1 : 0)} bp/px`;
  const binScaleLabel = `${binScale.toFixed(1)}×`;
  const rangeLabel = formatLocus(viewport.chr, boundedRange.start, boundedRange.end);
  // A locus resolves locally; anything else is treated as a gene symbol.
  const parsedLocusJump = useMemo(
    () => parseJumpInput(jumpInput, chromosome.id, viewportWidth),
    [chromosome.id, jumpInput, viewportWidth],
  );
  const geneSearch = useGeneSearch({
    genome: assemblyId,
    term: jumpInput,
    enabled: parsedLocusJump === null,
    isKnownChromosome,
  });

  const centerLabel = `${viewport.chr}:${formatPosition(Math.round(centerBp))}`;

  const visibleFrom =
    filteredTracks.length === 0 ? 0 : Math.min(filteredTracks.length, visibleRange.startIndex + 1);
  const visibleTo = filteredTracks.length === 0 ? 0 : Math.min(filteredTracks.length, visibleRange.endIndex + 1);
  const scrollIndicatorLabel =
    visibleLoadStatus.mode === 'computing'
      ? 'Computing buffer in background…'
      : 'Loading buffer in background…';

  const handleNavigatorRangeChange = useCallback(
    (nextStart: number, nextEnd: number) => {
      const minSpan = Math.max(1, viewport.widthPx * MIN_BP_PER_PX);
      const maxSpan = Math.min(viewport.chrLength, Math.max(1, viewport.widthPx * zoomOutCapBpPerPx));

      const start = clamp(nextStart, 0, viewport.chrLength);
      const end = clamp(nextEnd, start + 1, viewport.chrLength);
      const span = clamp(end - start, minSpan, maxSpan);
      const half = span * 0.5;
      const center =
        span >= viewport.chrLength
          ? viewport.chrLength * 0.5
          : clamp((start + end) * 0.5, half, viewport.chrLength - half);

      setExactBpPerPx(span / Math.max(1, viewport.widthPx));
      jumpToCenter(center);
    },
    [jumpToCenter, setExactBpPerPx, viewport.chrLength, viewport.widthPx, zoomOutCapBpPerPx],
  );

  const handleZoomToSequenceLevel = useCallback(() => {
    if (zoomToSequenceLevelDisabled) {
      return;
    }
    setExactBpPerPx(zoomToSequenceLevelBpPerPx);
  }, [setExactBpPerPx, zoomToSequenceLevelBpPerPx, zoomToSequenceLevelDisabled]);

  useEffect(() => {
    if (!showPerfHud) {
      return;
    }

    let rafId = 0;
    let frameCount = 0;
    let windowStart = performance.now();
    let smoothedFps = 0;

    const tick = (now: number) => {
      frameCount += 1;
      const elapsed = now - windowStart;

      if (elapsed >= 500) {
        const instantFps = (frameCount * 1000) / elapsed;
        smoothedFps = smoothedFps === 0 ? instantFps : smoothedFps * 0.75 + instantFps * 0.25;
        setFps(Math.round(smoothedFps));
        frameCount = 0;
        windowStart = now;
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [showPerfHud]);

  const trackManager = useTrackManager(managerItems, 'all');
  const trackActions = {
    onToggle: handleTrackToggle,
    onMove: handleTrackMove,
    onMoveGroup: handleTrackGroupMove,
    onRename: handleTrackRename,
    onDelete: handleTrackDelete,
    onBulkToggle: handleTrackBulkToggle,
    onBulkDelete: handleTrackBulkDelete,
    onBulkScale: handleTrackBulkScale,
    onBulkDisplay: handleTrackBulkDisplay,
    onBulkScaleShape: (ids: string[], scaleShape: SignalScaleShape) => {
      const selected = new Set(ids);
      setManagedTracks((previous) => previous.map((record) => selected.has(record.spec.id) && record.spec.kind === 'signal'
        ? { ...record, spec: { ...record.spec, scaleShape } } : record));
    },
    onGroup: handleTrackGroup,
    onUngroup: handleTrackUngroup,
  };
  const inspectedPlot = trackManager.selectedItems.length === 1
    ? coalesceUserPlotTracks(coalesceComputationalPlotTracks(orderedManagedTracks
      .filter((record) => trackManager.selectedMemberIds.includes(record.spec.id)).map((record) => record.spec)))[0]
    : undefined;
  const selectedRenderedIds = new Set(filteredTracks.filter((track) =>
    renderedTrackMemberIds(track, orderedManagedTracks).some((id) => trackManager.selectedMemberIds.includes(id)),
  ).map((track) => track.id));
  const workspaceTools = <>
    {activePanel === 'models' ? (
      <ModelsPanel
        models={VIEW_CATALOG}
        focusPackId={trackManager.selectedModelId ? modelStatusByInstance.get(trackManager.selectedModelId)?.packId : undefined}
        installedModelIds={installedModelIds}
        activeAssemblyId={assemblyId}
        actionState={modelActionState}
        outputGroupStates={modelOutputGroupStates}
        advancedError={modelImportError ?? undefined}
        onTryDemo={handleTryModelDemo}
        onRunHere={handleRunModelHere}
        onRemove={handleRemoveModel}
        onSelectCheckpoint={handleSelectCheckpoint}
        onSetOutputGroup={handleSetModelOutputGroup}
        onSetOutput={handleSetModelOutput}
        onSubmitPack={(url) => void handleModelSourceSubmit(url)}
        onLocalPack={(file) => void importLocalFile(file, 'model')}
        onClose={() => setActivePanel('none')}
      />
    ) : null}

    {activePanel === 'import' ? (
      <SourceImportPanel
        onSubmitSource={handleDataSourceSubmit}
        onLocalFiles={handleLocalDataFiles}
        onOpenTracks={() => setActivePanel('tracks')}
        onClose={() => setActivePanel('none')}
        sources={dataSourceItems}
        lastError={dataImportError ?? undefined}
      />
    ) : null}
  </>;

  return (
    <div className="app-shell workbench" data-appearance={isDark ? 'dark' : 'light'}>
      <header className="hf-topbar">
        <div className="hf-topbar-row hf-topbar-primary">
          <div className={!BRAND.logoUrl ? 'hf-brand wb-brand' : brandArtLoaded ? 'hf-brand hf-brand--art' : 'hf-brand'}>
            {/* The site's mark. The CSS mark behind it is the fallback: it
                shows through until the artwork loads, and stays if it never
                does, so the header never breaks on a missing asset. */}
            {BRAND.logoUrl ? (
              <img
                className="hf-brand__logo"
                src={BRAND.logoUrl}
                alt=""
                aria-hidden="true"
                onLoad={() => setBrandArtLoaded(true)}
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
              />
            ) : null}
            {!BRAND.logoUrl ? <><span className="wb-brand-mark" aria-hidden="true"><i /><i /><i /></span><h1 aria-label={BRAND.name}>{BRAND.name.toLowerCase()}</h1><span className="wb-brand-descriptor">browser</span></> : <h1>{BRAND.name}</h1>}
            {BRAND.tagline ? <p>{BRAND.tagline}</p> : null}
          </div>

          {/* Locus reads as one address-bar-style control: assembly ▸ chromosome ▸ position. */}
          <div className="hf-locus">
            <AssemblySelector
              assemblyId={assemblyId}
              options={assemblyOptions}
              onAssemblyChange={handleAssemblyChange}
              id="assembly"
            />

            <label className="hf-inline-field" htmlFor="chr">
              <span className="hf-field-caption">Chr</span>
              <select id="chr" value={chromosome.id} onChange={(event) => setChrId(event.target.value)}>
                {chromosomes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
              </select>
            </label>

            <LocusSearchBox
              value={jumpInput}
              onValueChange={setJumpInput}
              placeholder={centerLabel}
              matches={geneSearch.matches}
              status={geneSearch.status}
              isLocus={parsedLocusJump !== null}
              onSubmitLocus={handleLocusSubmit}
              onSelectGene={handleGeneSelect}
            />
          </div>

          <div className="hf-commandbar">
            <nav className="wb-desktop-tools" aria-label="Browser tools">
              <button type="button" className="wb-tracks-toggle" aria-expanded={libraryOpen || activePanel === 'tracks'} aria-controls="tracks-dock"
                onClick={() => { changeLibraryOpen(!(libraryOpen || activePanel === 'tracks')); if (activePanel === 'tracks') setActivePanel('none'); }}>
                <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M7.5 3v14" /></svg>
                Tracks
              </button>
              <button type="button" aria-haspopup="dialog" onClick={() => setActivePanel('models')}>Models</button>
              <button type="button" aria-haspopup="dialog" onClick={() => setActivePanel('import')}>Data</button>
            </nav>
            <button
              className="hf-icon-btn hf-theme-toggle"
              onClick={cycleTheme}
              title={`Theme: ${theme} — switch to ${isDark ? 'light' : 'dark'}`}
              aria-label="Toggle color theme"
              type="button"
            >
              {isDark ? '☀' : '☾'}
            </button>
          </div>
        </div>

        {/* Transport: how you are looking, separated from where you are looking. */}
        <button
          className="hf-transport-summary"
          type="button"
          aria-expanded={transportOpen}
          aria-controls="view-controls"
          onClick={() => setTransportOpen((previous) => !previous)}
        >
          <span>{`${sequenceReversed ? '−' : '+'} strand · ${zoomLabel} · bin ${binScaleLabel}`}</span>
          <span aria-hidden="true">{transportOpen ? 'hide' : 'edit'}</span>
        </button>

        <div
          className="hf-topbar-row hf-topbar-transport"
          id="view-controls"
          data-open={transportOpen ? 'true' : 'false'}
        >
          {/* Strand is a property of the whole view -- every row reverse-complements
              together -- so it lives here, in its own group: it is a state of the
              view, not a zoom action like DNA beside it. The -/+ zoom buttons it
              replaces were redundant with the slider and pinch. */}
          <div className="hf-transport-group hf-strand-group" role="group" aria-label="Strand">
            <button
              className={sequenceReversed ? 'hf-icon-btn hf-strand-btn is-minus' : 'hf-icon-btn hf-strand-btn'}
              onClick={() => setSequenceReversed((previous) => !previous)}
              aria-pressed={sequenceReversed}
              aria-label={sequenceReversed ? 'Reading the minus strand; switch to plus' : 'Reading the plus strand; switch to minus'}
              title={
                sequenceReversed
                  ? 'Minus strand: the whole view is reverse-complemented. Click for the plus strand.'
                  : 'Plus strand. Click to read the minus strand: every row flips to its reverse complement.'
              }
              type="button"
            >
              <span className="hf-strand-btn__sign" aria-hidden="true">{sequenceReversed ? '−' : '+'}</span>
              <span className="hf-strand-btn__word">strand</span>
            </button>
          </div>
          <label className="hf-inline-field hf-zoom-control hf-zoom-inline" htmlFor="zoom">
            Zoom
            <input
              id="zoom"
              type="range"
              min={zoomSliderMin}
              max={zoomSliderMax}
              step={0.001}
              value={zoomSliderValue}
              onChange={(event) => setExactBpPerPx(10 ** Number(event.target.value))}
            />
            <span>{zoomLabel}</span>
            {/* A preset on the zoom control, not a mode: jump to where bases are
                readable and the sequence models can run. Lives with the slider it
                sets, and says what it does -- "DNA" on its own read as a toggle. */}
            <button
              className="hf-zoom-preset"
              onClick={handleZoomToSequenceLevel}
              title={
                zoomToSequenceLevelDisabled
                  ? 'Already at base resolution'
                  : `Zoom in to base resolution (~${zoomToSequenceLevelBpPerPx.toFixed(zoomToSequenceLevelBpPerPx < 1 ? 3 : 1)} bp/px), where bases are readable and models can run`
              }
              aria-label="Zoom to base resolution"
              type="button"
              disabled={zoomToSequenceLevelDisabled}
            >
              to bases
            </button>
          </label>

          <label className="hf-inline-field hf-zoom-control hf-bin-inline" htmlFor="bin-scale">
            Bin
            <input
              id="bin-scale"
              type="range"
              min={MIN_BIN_SCALE}
              max={MAX_BIN_SCALE}
              step={0.1}
              value={binScale}
              onChange={(event) => setBinScale(clamp(Number(event.target.value), MIN_BIN_SCALE, MAX_BIN_SCALE))}
            />
            <span>{binScaleLabel}</span>
          </label>
        </div>
      </header>

      <WorkbenchWorkspace
        controller={trackManager}
        actions={trackActions}
        libraryOpen={libraryOpen}
        onLibraryOpenChange={changeLibraryOpen}
        inspectedPlot={inspectedPlot}
        onPlotGroupingChange={handleRenderedTrackGrouping}
        groupColors={modelGroupColors}
        models={modelStatusByInstance}
        activePanel={activePanel}
        onPanelChange={setActivePanel}
        onFitModel={handleFitModelInstance}
        onRemoveModel={handleRemoveModelInstance}
        tools={workspaceTools}
      >
        {(inspect) => <section
          className="browser-scene"
          ref={setHostElement}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          role="application"
          aria-label="Genome browser viewport"
        >
          <div className="ruler-row">
            <div className="ruler-label wb-plot-filter" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2 3h12L9.5 8v4.5l-3 1V8z" /></svg>
              <input type="search" aria-label="Filter plotted tracks" placeholder="Filter tracks" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
              {searchQuery ? <button type="button" aria-label="Clear plot filter" onClick={() => setSearchQuery('')}>×</button> : null}
            </div>
            <RulerCanvas
              widthPx={viewport.widthPx}
              heightPx={22}
              bpPerPx={viewport.bpPerPx}
              range={viewport.range}
              chrLength={viewport.chrLength}
              reversed={sequenceReversed}
              edits={sharedEdits}
            />
          </div>

          <div
            className="sequence-strips"
            data-section={sequenceEdits.length > 0 ? 'edited' : undefined}
            style={sequenceEdits.length > 0 ? ({ '--section-color': SEQUENCE_SECTION_COLORS.edited } as CSSProperties) : undefined}
          >
            {/* The pinned row is the sequence you edit. With no edits it shows the
                reference; with edits it shows your version, and the reference
                appears as a track beneath it. A text field over the genome. Once
                edited it is also the marker of the section beneath it: the rows
                re-run on the edit wear its colour. */}
            <SequenceStrip
              viewport={viewport}
              genome={ucscGenome}
              title={sequenceEdits.length > 0 ? 'Edited sequence' : 'Sequence'}
              ariaLabel={sequenceEdits.length > 0 ? 'Edited sequence' : 'Reference sequence'}
              appearance={sequenceEdits.length > 0 ? 'modified' : undefined}
              edits={sequenceEdits}
              onEditsChange={handleSequenceEditsChange}
              onReset={handleResetSequence}
              showReset={sequenceEdits.length > 0}
              resetLabel="Reset to reference"
              hiddenOutputCount={sequenceEdits.length > 0 ? hiddenOnEdited.length : 0}
              onShowHiddenOutputs={handleShowAllOnEdited}
              reversed={sequenceReversed}
              columnEdits={sharedEdits}
              inlineEditing
            />
          </div>

          {showPerfHud && computationalBufferDebugHud ? (
            <aside className="hf-compute-debug" aria-label="Computational buffer debug">
              <div className="hf-compute-debug-title">Live inference</div>
              <div className="hf-compute-debug-legend">
                <span className="hf-compute-debug-legend-item ready">ready</span>
                <span className="hf-compute-debug-legend-item shared-ready">ready*</span>
                <span className="hf-compute-debug-legend-item loading">loading</span>
                <span className="hf-compute-debug-legend-item shared-loading">loading*</span>
                <span className="hf-compute-debug-legend-item missing">missing</span>
              </div>
              <div className="hf-compute-debug-metrics">
                <span>{computationalBufferDebugHud.fillPercent}% filled</span>
                <span>
                  {computationalBufferDebugHud.readySlots}/{computationalBufferDebugHud.totalSlots} slots
                </span>
              </div>
              <div className="hf-compute-debug-metrics">
                <span>
                  tracks {computationalBufferDebugHud.visibleTrackCount}/{computationalBufferDebugHud.totalTrackCount}
                </span>
                <span>
                  running {computationalBufferDebugHud.activeVisibleJobs} visible / {computationalBufferDebugHud.activeGlobalJobs}{' '}
                  total
                </span>
              </div>
              <div className="hf-compute-debug-viewport">{computationalBufferDebugHud.viewportRangeLabel}</div>
              <div className="hf-compute-debug-computing">
                {computationalBufferDebugHud.computingRanges.length > 0
                  ? `now: ${computationalBufferDebugHud.computingRanges.join(' | ')}`
                  : 'now: idle'}
              </div>
              {computationalBufferDebugHud.packBudgets.length > 0 ? (
                <ul className="hf-compute-debug-budgets" aria-label="Inference budget">
                  {computationalBufferDebugHud.packBudgets.map((budget) => (
                    <li
                      key={budget.packId}
                      className="hf-compute-debug-budget"
                      data-pack={budget.packId}
                      data-calibrated={budget.calibrated ? 'true' : 'false'}
                    >
                      <span className="hf-compute-debug-budget-name">{budget.name}</span>
                      <span className="hf-compute-debug-budget-window">
                        &lt;= {budget.maxWindowBp.toLocaleString('en-US')} bp / {computationalBufferDebugHud.budgetMs}ms
                        {budget.calibrated ? '' : ' (est)'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="hf-compute-debug-list">
                {computationalBufferDebugHud.rows.map((row) => (
                  <li key={row.trackId} className="hf-compute-debug-row">
                    <div className="hf-compute-debug-row-head">
                      <span className="hf-compute-debug-name">{row.trackName}</span>
                      <span className="hf-compute-debug-fill">
                        {row.readySlots}/{row.totalSlots}
                      </span>
                    </div>
                    <div className="hf-compute-debug-row-meta">
                      {row.requestRangeLabel} {row.resolutionLabel}
                    </div>
                    <div className="hf-compute-debug-buffer-bar" aria-label="Buffer coverage">
                      {row.barSegments.map((segment) => {
                        const rowSpan = Math.max(1, row.bufferEndBp - row.bufferStartBp);
                        const startOffset = Math.max(0, segment.startBp - row.bufferStartBp);
                        const slotSpan = Math.max(1, segment.endBp - segment.startBp);
                        const leftPercent = (startOffset / rowSpan) * 100;
                        const widthPercent = (slotSpan / rowSpan) * 100;

                        return (
                          <div
                            key={`${row.trackId}:${segment.startBp}:${segment.endBp}:${segment.state}`}
                            className={`hf-compute-debug-buffer-segment ${segment.state}`}
                            style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                            title={`${formatLocus(viewport.chr, segment.startBp, segment.endBp)} ${segment.state}`}
                          />
                        );
                      })}
                      {(() => {
                        const rowSpan = Math.max(1, row.bufferEndBp - row.bufferStartBp);
                        const currentStartOffset = Math.max(0, row.currentStartBp - row.bufferStartBp);
                        const currentSpan = Math.max(1, row.currentEndBp - row.currentStartBp);
                        const leftPercent = (currentStartOffset / rowSpan) * 100;
                        const widthPercent = (currentSpan / rowSpan) * 100;
                        return (
                          <div
                            className="hf-compute-debug-buffer-current"
                            style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                            title={`current window ${formatLocus(viewport.chr, row.currentStartBp, row.currentEndBp)}`}
                          />
                        );
                      })()}
                    </div>
                    <div className="hf-compute-debug-row-meta">
                      {row.slots
                        .map((slot) =>
                          `${slot.label}:${
                            slot.state === 'shared-ready'
                              ? 'ready*'
                              : slot.state === 'shared-loading'
                                ? 'loading*'
                                : slot.state
                          }`,
                        )
                        .join('  ')}
                    </div>
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}

          <div className="tracks-row">
            <div className="hf-track-list-slot">
              {trackListRows.length === 0 ? (
                <div className="hf-empty-state">No tracks match search.</div>
              ) : (
                <TrackList
                  rows={trackListRows}
                  selectedTrackIds={selectedRenderedIds}
                  onSelectTrack={(track) => { trackManager.revealItems(managerSelectionForTrack(track, managerItems, orderedManagedTracks)); inspect(); }}
                  modelStatuses={modelStatusByInstance}
                  onFitModel={handleFitModelInstance}
                  onOpenModels={openModelsPanel}
                  onRemoveModel={handleRemoveModelInstance}
                  onHideOnEdited={handleHideOnEdited}
                  viewport={viewport}
                  windowSpec={windowSpec}
                  genome={ucscGenome}
                  onSignalDisplayChange={handleRenderedTrackDisplay}
                  onSignalScaleShapeChange={handleRenderedTrackScaleShape}
                  onPlotGroupingChange={handleRenderedTrackGrouping}
                  onHeightChange={handleTrackHeightChange}
                  sequenceReversed={sequenceReversed}
                  columnEdits={sharedEdits}
                  onVisibleRangeChange={setVisibleRange}
                  scrollerRef={trackScrollerRef}
                />
              )}
            </div>
          </div>
        </section>}

      </WorkbenchWorkspace>

      <BrushNavigator
        chr={viewport.chr}
        chrLength={viewport.chrLength}
        range={boundedRange}
        navigatorTrackId={effectiveNavigatorTrackId}
        navigatorOptions={navigatorOptions}
        onNavigatorTrackChange={setNavigatorTrackId}
        overviewTrack={navigatorTrack}
        ideogramBands={navigatorIdeogramBands}
        ideogramAssembly={ideogramAssembly}
        resolutionScale={binScale}
        onRangeChange={handleNavigatorRangeChange}
      />

      <footer className="statusbar">
        <span>{rangeLabel}</span>
        <span className="statusbar-meta">
          {/* Background work lives in the status bar, where the model rail's own
              "Computing this view" cannot end up underneath it. It used to float
              over the top of the tracks, which is exactly where the rail sits. */}
          {showLoadIndicator && visibleLoadStatus.showIndicator ? (
            <span
              className={`hf-scroll-indicator ${visibleLoadStatus.mode}`}
              role="status"
              aria-live="polite"
            >
              {scrollIndicatorLabel}
            </span>
          ) : null}
          <LoadStateBadge trackStates={visibleLoadStatus.trackStates} />
          Visible tracks {visibleFrom}-{visibleTo} of {filteredTracks.length}
          {showPerfHud ? ` | FPS ${fps}` : ''}
        </span>
      </footer>
    </div>
  );
}

export default App;
