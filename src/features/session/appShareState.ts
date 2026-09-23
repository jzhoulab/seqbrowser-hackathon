import { clamp } from '../../lib/genomeMath';

export type PanelMode = 'none' | 'models' | 'import' | 'tracks';

/**
 * A mounted model, small enough to ride in the URL.
 *
 * The pack itself is not embedded -- only where to fetch it and which outputs were
 * shown. `id` is kept alongside `url` so a link cannot silently mount something else
 * if that URL later serves a different pack.
 */
export type PersistedModel = {
  url: string;
  id: string;
  /** Enabled output ids. Omitted means "whatever the manifest defaults to". */
  shown?: string[];
};

export type AppShareState = {
  assemblyId: string;
  chr: string;
  search: string;
  binScale: number;
  activePanel: PanelMode;
  navigatorTrackId: string;
  centerBp?: number;
  bpPerPx?: number;
  /** The strand being read. Omitted means plus, as every link before it did. */
  strand?: '+' | '-';
  /** Mounted models, so a refresh or a shared link does not drop them. */
  models?: PersistedModel[];
};

// A session URL has to stay pasteable. These caps bound its growth without being
// anywhere near what a real session reaches.
export const MAX_PERSISTED_MODELS = 12;
export const MAX_PERSISTED_OUTPUTS_PER_MODEL = 64;

export type NormalizeOptions = {
  defaultAssemblyId: string;
  defaultChr: string;
  defaultSearch: string;
  defaultBinScale: number;
  minBinScale: number;
  maxBinScale: number;
  defaultActivePanel: PanelMode;
  defaultNavigatorTrackId: string;
  minBpPerPx?: number;
  maxBpPerPx?: number;
  chrLengthById?: Record<string, number>;
};

const BIN_SCALE_PRECISION = 4;
const BP_PER_PX_PRECISION = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const asFinitePositive = (value: unknown): number | null => {
  const parsed = asFiniteNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
};

const roundToPrecision = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export function resolvePanelMode(value: unknown, legacyIsPanelOpen?: unknown): PanelMode {
  if (value === 'models' || value === 'import' || value === 'tracks' || value === 'none') {
    return value;
  }

  // The retired diagnostics-only Notes panel was never user-authored content.
  // Legacy links that opened it now land on the unobstructed browser.
  void legacyIsPanelOpen;
  return 'none';
}

function normalizePersistedModels(value: unknown): PersistedModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const models: PersistedModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (models.length >= MAX_PERSISTED_MODELS) {
      break;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const url = asString(entry.url)?.trim();
    const id = asString(entry.id)?.trim();
    if (!url || !id) {
      continue;
    }
    // One instance per (pack, url). Restoring the same model twice would produce
    // indistinguishable duplicate rows.
    const key = `${id}|${url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const shownRaw = Array.isArray(entry.shown) ? entry.shown : null;
    const shown = shownRaw
      ? Array.from(
          new Set(
            shownRaw
              .map((item) => asString(item)?.trim())
              .filter((item): item is string => Boolean(item)),
          ),
        ).slice(0, MAX_PERSISTED_OUTPUTS_PER_MODEL)
      : undefined;

    models.push(shown ? { url, id, shown } : { url, id });
  }

  return models.length > 0 ? models : undefined;
}

export function persistedModelsEqual(
  left: PersistedModel[] | undefined,
  right: PersistedModel[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    if (entry.url !== other.url || entry.id !== other.id) {
      return false;
    }
    const a = entry.shown ?? null;
    const b = other.shown ?? null;
    if (a === null || b === null) {
      return a === b;
    }
    return a.length === b.length && a.every((value, i) => value === b[i]);
  });
}

export function normalizeAppShareState(raw: unknown, options: NormalizeOptions): AppShareState {
  const record = isRecord(raw) ? raw : {};

  const assemblyId = asString(record.assemblyId) || options.defaultAssemblyId;
  const chr = asString(record.chr)?.trim() || options.defaultChr;
  const search = asString(record.search) ?? options.defaultSearch;
  const activePanel = resolvePanelMode(record.activePanel, record.isPanelOpen);
  const navigatorTrackId = asString(record.navigatorTrackId)?.trim() || options.defaultNavigatorTrackId;

  const binScaleCandidate = asFiniteNumber(record.binScale) ?? options.defaultBinScale;
  const binScale = roundToPrecision(
    clamp(binScaleCandidate, options.minBinScale, options.maxBinScale),
    BIN_SCALE_PRECISION,
  );

  const centerBpCandidate = asFinitePositive(record.centerBp);
  const bpPerPxCandidate = asFinitePositive(record.bpPerPx);
  const minBpPerPx = options.minBpPerPx ?? Number.EPSILON;
  const maxBpPerPx = options.maxBpPerPx ?? Number.MAX_SAFE_INTEGER;

  const bpPerPx =
    bpPerPxCandidate === null
      ? undefined
      : roundToPrecision(clamp(bpPerPxCandidate, minBpPerPx, maxBpPerPx), BP_PER_PX_PRECISION);

  const chrLength = options.chrLengthById?.[chr];
  const boundedCenterBp =
    centerBpCandidate === null
      ? undefined
      : Math.round(
          typeof chrLength === 'number' && Number.isFinite(chrLength) && chrLength > 0
            ? clamp(centerBpCandidate, 1, chrLength)
            : centerBpCandidate,
        );

  // Only the minus strand is worth a byte in the URL; plus is what a link
  // without it always meant.
  const strand = record.strand === '-' ? '-' : undefined;

  return {
    assemblyId,
    chr,
    search,
    binScale,
    activePanel: activePanel || options.defaultActivePanel,
    navigatorTrackId,
    centerBp: boundedCenterBp,
    bpPerPx,
    strand,
    models: normalizePersistedModels(record.models),
  };
}

export function appShareStateEquals(left: AppShareState, right: AppShareState): boolean {
  return (
    left.assemblyId === right.assemblyId &&
    left.chr === right.chr &&
    left.search === right.search &&
    left.binScale === right.binScale &&
    left.activePanel === right.activePanel &&
    left.navigatorTrackId === right.navigatorTrackId &&
    left.centerBp === right.centerBp &&
    left.bpPerPx === right.bpPerPx &&
    left.strand === right.strand &&
    persistedModelsEqual(left.models, right.models)
  );
}
