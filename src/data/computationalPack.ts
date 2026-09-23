/**
 * Floor for a declared track height. A plot still has to leave room for its
 * baseline, value labels and hover readout once the canvas padding is taken
 * out, so packs cannot shrink a row to nothing.
 */
const MIN_COMPUTATIONAL_TRACK_HEIGHT_PX = 20;

import { OPT_IN_SIGNAL_SCALE_SHAPES, isOptInSignalScaleShape } from '../lib/signalScaleShape';
import { timedFetch } from './timedFetch';
import type {
  OptInSignalScaleShape,
  ComputationalMutagenesisSpec,
  ComputationalPackManifest,
  ComputationalPlotGroupSpec,
  ComputationalSubtrackSpec,
  TrackKind,
} from '../types';

/** The only `.czpack` schema version this build understands. */
export const CZPACK_SCHEMA_VERSION = 1;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid computational pack: "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function asHexColor(value: unknown, field: string): string {
  const color = asNonEmptyString(value, field);
  if (!HEX_COLOR.test(color)) {
    throw new Error(`Invalid computational pack: "${field}" must be a hex color like "#77b6ff".`);
  }
  return color;
}

function asTrackKind(value: unknown, field: string): TrackKind {
  if (value === 'signal' || value === 'annotation') {
    return value;
  }
  throw new Error(`Invalid computational pack: "${field}" must be "signal" or "annotation".`);
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid computational pack: "${field}" must be a finite number.`);
  }
  return value;
}

function asUniqueStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid computational pack: "${field}" must be a non-empty string array.`);
  }
  const items = value.map((item, index) => asNonEmptyString(item, `${field}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new Error(`Invalid computational pack: "${field}" must not contain duplicates.`);
  }
  return items;
}

function normalizeSubtrack(raw: unknown, index: number): ComputationalSubtrackSpec {
  if (!isObject(raw)) {
    throw new Error(`Invalid computational pack: subtrack[${index}] must be an object.`);
  }

  const id = asNonEmptyString(raw.id, `subtracks[${index}].id`);
  const name = asNonEmptyString(raw.name, `subtracks[${index}].name`);
  const kind = asTrackKind(raw.kind, `subtracks[${index}].kind`);
  const color = asHexColor(raw.color, `subtracks[${index}].color`);
  const height = Math.max(
    MIN_COMPUTATIONAL_TRACK_HEIGHT_PX,
    Math.round(asFiniteNumber(raw.height, `subtracks[${index}].height`)),
  );
  const outputName = asNonEmptyString(raw.outputName, `subtracks[${index}].outputName`);
  const channelIndex =
    raw.channelIndex === undefined ? undefined : Math.max(0, Math.floor(asFiniteNumber(raw.channelIndex, `subtracks[${index}].channelIndex`)));
  const transform = raw.transform;
  const groupId =
    raw.groupId === undefined ? undefined : asNonEmptyString(raw.groupId, `subtracks[${index}].groupId`);
  const groupLabel =
    raw.groupLabel === undefined ? undefined : asNonEmptyString(raw.groupLabel, `subtracks[${index}].groupLabel`);
  const plotGroupId =
    raw.plotGroupId === undefined ? undefined : asNonEmptyString(raw.plotGroupId, `subtracks[${index}].plotGroupId`);
  const plotGroupLabel =
    raw.plotGroupLabel === undefined ? undefined : asNonEmptyString(raw.plotGroupLabel, `subtracks[${index}].plotGroupLabel`);
  const lineStyle = raw.lineStyle;
  const defaultVisible = raw.defaultVisible;
  const role = raw.role;
  const scaleMode = raw.scaleMode;
  const defaultSignalDisplay = raw.defaultSignalDisplay;
  const stableMarginBp = raw.stableMarginBp === undefined
    ? undefined
    : Math.max(0, Math.floor(asFiniteNumber(raw.stableMarginBp, `subtracks[${index}].stableMarginBp`)));

  let fixedScale: { min: number; max: number } | undefined;
  if (raw.fixedScale !== undefined) {
    if (!isObject(raw.fixedScale)) {
      throw new Error(`Invalid computational pack: "subtracks[${index}].fixedScale" must be an object.`);
    }
    const min = asFiniteNumber(raw.fixedScale.min, `subtracks[${index}].fixedScale.min`);
    const max = asFiniteNumber(raw.fixedScale.max, `subtracks[${index}].fixedScale.max`);
    if (!(max > min)) {
      throw new Error(
        `Invalid computational pack: "subtracks[${index}].fixedScale.max" must be greater than "min".`,
      );
    }
    // A signed output is centred on zero and unbounded in both directions; pinning it
    // to a range clips whichever half falls outside. Reject the combination at import
    // rather than silently rendering a truncated track.
    if (scaleMode === 'signed') {
      throw new Error(
        `Invalid computational pack: "subtracks[${index}]" declares fixedScale with scaleMode "signed"; ` +
          'a signed output cannot be pinned without clipping.',
      );
    }
    fixedScale = { min, max };
  }

  // A mutagenesis row is declared on the output it mutates; the browser derives
  // it, so nothing about it is read from the graph. Defaults are the ones the
  // splice packs use, so a manifest can say `"mutagenesis": {}`.
  let mutagenesis: ComputationalMutagenesisSpec | undefined;
  if (raw.mutagenesis !== undefined) {
    if (!isObject(raw.mutagenesis)) {
      throw new Error(`Invalid computational pack: "subtracks[${index}].mutagenesis" must be an object.`);
    }
    const contextBp = raw.mutagenesis.contextBp === undefined
      ? 500
      : Math.max(0, Math.floor(asFiniteNumber(raw.mutagenesis.contextBp, `subtracks[${index}].mutagenesis.contextBp`)));
    const maxSpanBp = raw.mutagenesis.maxSpanBp === undefined
      ? 400
      : Math.max(1, Math.floor(asFiniteNumber(raw.mutagenesis.maxSpanBp, `subtracks[${index}].mutagenesis.maxSpanBp`)));
    mutagenesis = { contextBp, maxSpanBp };
  }

  const renderStyle = raw.renderStyle;
  if (renderStyle !== undefined && renderStyle !== 'bars' && renderStyle !== 'line') {
    throw new Error(`Invalid computational pack: "subtracks[${index}].renderStyle" must be "bars" or "line".`);
  }

  // −log10(1 − p) is a probability's axis. An output enables it by name, and
  // only an output that is a probability by construction -- a signal pinned
  // inside [0, 1] -- may: on anything else its nines mean nothing.
  let scaleShapes: OptInSignalScaleShape[] | undefined;
  if (raw.scaleShapes !== undefined) {
    if (!Array.isArray(raw.scaleShapes) || !raw.scaleShapes.every((shape) => isOptInSignalScaleShape(shape))) {
      throw new Error(
        `Invalid computational pack: "subtracks[${index}].scaleShapes" may only list ` +
          `${OPT_IN_SIGNAL_SCALE_SHAPES.map((shape) => `"${shape}"`).join(', ')}.`,
      );
    }
    if (kind !== 'signal' || !fixedScale || fixedScale.min < 0 || fixedScale.max > 1) {
      throw new Error(
        `Invalid computational pack: "subtracks[${index}]" enables "complement-log", which is −log(1−p) and ` +
          'needs a probability: a signal output with a fixedScale inside [0, 1].',
      );
    }
    scaleShapes = [...new Set(raw.scaleShapes as OptInSignalScaleShape[])];
  }

  if (transform !== undefined && transform !== 'identity' && transform !== 'abs' && transform !== 'relu') {
    throw new Error(
      `Invalid computational pack: "subtracks[${index}].transform" must be "identity", "abs", or "relu".`,
    );
  }
  if (defaultVisible !== undefined && typeof defaultVisible !== 'boolean') {
    throw new Error(`Invalid computational pack: "subtracks[${index}].defaultVisible" must be a boolean.`);
  }
  if (
    role !== undefined &&
    role !== 'prediction' &&
    role !== 'activation' &&
    role !== 'effect' &&
    role !== 'contribution'
  ) {
    throw new Error(
      `Invalid computational pack: "subtracks[${index}].role" must be "prediction", "activation", "effect", or "contribution".`,
    );
  }
  if (scaleMode !== undefined && scaleMode !== 'positive' && scaleMode !== 'signed') {
    throw new Error(
      `Invalid computational pack: "subtracks[${index}].scaleMode" must be "positive" or "signed".`,
    );
  }
  if (lineStyle !== undefined && lineStyle !== 'solid' && lineStyle !== 'dashed') {
    throw new Error(
      `Invalid computational pack: "subtracks[${index}].lineStyle" must be "solid" or "dashed".`,
    );
  }
  if (
    defaultSignalDisplay !== undefined &&
    defaultSignalDisplay !== 'signal' &&
    defaultSignalDisplay !== 'sequence'
  ) {
    throw new Error(
      `Invalid computational pack: "subtracks[${index}].defaultSignalDisplay" must be "signal" or "sequence".`,
    );
  }
  if (defaultSignalDisplay === 'sequence' && kind !== 'signal') {
    throw new Error(
      `Invalid computational pack: "subtracks[${index}].defaultSignalDisplay" can be "sequence" only for signal tracks.`,
    );
  }

  return {
    id,
    name,
    kind,
    color,
    height,
    outputName,
    channelIndex,
    transform,
    groupId,
    groupLabel,
    plotGroupId,
    plotGroupLabel,
    lineStyle,
    defaultVisible,
    role,
    scaleMode,
    defaultSignalDisplay,
    stableMarginBp,
    mutagenesis,
    fixedScale,
    renderStyle,
    scaleShapes,
  };
}

function normalizePlotGroup(raw: unknown, index: number): ComputationalPlotGroupSpec {
  if (!isObject(raw)) {
    throw new Error(`Invalid computational pack: plotGroups[${index}] must be an object.`);
  }

  const id = asNonEmptyString(raw.id, `plotGroups[${index}].id`);
  const label = asNonEmptyString(raw.label, `plotGroups[${index}].label`);
  const subtrackIds = asUniqueStringArray(raw.subtrackIds, `plotGroups[${index}].subtrackIds`);
  const groupIds = asUniqueStringArray(raw.groupIds, `plotGroups[${index}].groupIds`);
  const dashedSubtrackIds = asUniqueStringArray(
    raw.dashedSubtrackIds,
    `plotGroups[${index}].dashedSubtrackIds`,
  );
  const dashedGroupIds = asUniqueStringArray(raw.dashedGroupIds, `plotGroups[${index}].dashedGroupIds`);
  const height = raw.height === undefined
    ? undefined
    : Math.max(
        MIN_COMPUTATIONAL_TRACK_HEIGHT_PX,
        Math.round(asFiniteNumber(raw.height, `plotGroups[${index}].height`)),
      );

  if (!subtrackIds && !groupIds) {
    throw new Error(
      `Invalid computational pack: plotGroups[${index}] must declare "subtrackIds" or "groupIds".`,
    );
  }

  const comparesEdits = raw.comparesEdits;
  if (comparesEdits !== undefined && typeof comparesEdits !== 'boolean') {
    throw new Error(`Invalid computational pack: "plotGroups[${index}].comparesEdits" must be a boolean.`);
  }

  return {
    id,
    label,
    subtrackIds,
    groupIds,
    dashedSubtrackIds,
    dashedGroupIds,
    height,
    ...(comparesEdits === undefined ? {} : { comparesEdits }),
  };
}

export function normalizeComputationalPack(raw: unknown): ComputationalPackManifest {
  if (!isObject(raw)) {
    throw new Error('Invalid computational pack: payload must be an object.');
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== CZPACK_SCHEMA_VERSION) {
    throw new Error(
      `Invalid computational pack: "schemaVersion" must be ${CZPACK_SCHEMA_VERSION} (got ${JSON.stringify(schemaVersion)}).`,
    );
  }

  const id = asNonEmptyString(raw.id, 'id');
  const name = asNonEmptyString(raw.name, 'name');
  const description =
    typeof raw.description === 'string' && raw.description.trim().length > 0 ? raw.description.trim() : undefined;
  const assemblyId =
    typeof raw.assemblyId === 'string' && raw.assemblyId.trim().length > 0 ? raw.assemblyId.trim() : undefined;

  const sequenceProvider = raw.sequenceProvider;
  if (!isObject(sequenceProvider) || sequenceProvider.type !== 'ucsc') {
    throw new Error('Invalid computational pack: sequenceProvider.type must be "ucsc".');
  }
  const genome = asNonEmptyString(sequenceProvider.genome, 'sequenceProvider.genome');

  const model = raw.model;
  if (!isObject(model) || model.format !== 'onnx') {
    throw new Error('Invalid computational pack: model.format must be "onnx".');
  }
  const modelUrl = asNonEmptyString(model.url, 'model.url');
  const inputName = typeof model.inputName === 'string' && model.inputName.trim().length > 0 ? model.inputName.trim() : undefined;
  const fixedInputs: Record<string, number> = {};
  if (model.fixedInputs !== undefined) {
    if (!isObject(model.fixedInputs)) {
      throw new Error('Invalid computational pack: model.fixedInputs must be an object.');
    }
    for (const [key, value] of Object.entries(model.fixedInputs)) {
      fixedInputs[key] = asFiniteNumber(value, `model.fixedInputs.${key}`);
    }
  }

  let flankBp: number | undefined;
  let maxWindowBp: number | undefined;
  let maxResolutionBp: number | undefined;
  let transcriptPadding: { bp: number } | undefined;
  if (raw.inference !== undefined) {
    if (!isObject(raw.inference)) {
      throw new Error('Invalid computational pack: inference must be an object.');
    }
    if (raw.inference.flankBp !== undefined) {
      flankBp = Math.max(0, Math.floor(asFiniteNumber(raw.inference.flankBp, 'inference.flankBp')));
    }
    if (raw.inference.maxWindowBp !== undefined) {
      maxWindowBp = Math.max(1, Math.floor(asFiniteNumber(raw.inference.maxWindowBp, 'inference.maxWindowBp')));
    }
    if (raw.inference.maxResolutionBp !== undefined) {
      maxResolutionBp = Math.max(
        1,
        Math.floor(asFiniteNumber(raw.inference.maxResolutionBp, 'inference.maxResolutionBp')),
      );
    }
    if (raw.inference.transcriptPadding !== undefined) {
      if (!isObject(raw.inference.transcriptPadding)) {
        throw new Error('Invalid computational pack: inference.transcriptPadding must be an object.');
      }
      const bp = Math.floor(asFiniteNumber(raw.inference.transcriptPadding.bp, 'inference.transcriptPadding.bp'));
      if (bp < 1) {
        throw new Error('Invalid computational pack: inference.transcriptPadding.bp must be at least 1.');
      }
      transcriptPadding = { bp };
    }
  }

  const subtracksRaw = raw.subtracks;
  if (!Array.isArray(subtracksRaw) || subtracksRaw.length === 0) {
    throw new Error('Invalid computational pack: subtracks must be a non-empty array.');
  }
  const subtracks = subtracksRaw.map((item, index) => normalizeSubtrack(item, index));

  const seenSubtrackIds = new Set<string>();
  const seenGroupIds = new Set<string>();
  for (const subtrack of subtracks) {
    if (seenSubtrackIds.has(subtrack.id)) {
      throw new Error(`Invalid computational pack: duplicate subtrack id "${subtrack.id}".`);
    }
    seenSubtrackIds.add(subtrack.id);
    if (subtrack.groupId) {
      seenGroupIds.add(subtrack.groupId);
    }
  }

  let plotGroups: ComputationalPlotGroupSpec[] | undefined;
  if (raw.plotGroups !== undefined) {
    if (!Array.isArray(raw.plotGroups) || raw.plotGroups.length === 0) {
      throw new Error('Invalid computational pack: "plotGroups" must be a non-empty array.');
    }
    plotGroups = raw.plotGroups.map((item, index) => normalizePlotGroup(item, index));
    const seenPlotGroupIds = new Set<string>();
    const assignedSubtrackIds = new Set<string>();
    for (const [index, plotGroup] of plotGroups.entries()) {
      if (seenPlotGroupIds.has(plotGroup.id)) {
        throw new Error(`Invalid computational pack: duplicate plot group id "${plotGroup.id}".`);
      }
      seenPlotGroupIds.add(plotGroup.id);

      for (const subtrackId of plotGroup.subtrackIds ?? []) {
        if (!seenSubtrackIds.has(subtrackId)) {
          throw new Error(
            `Invalid computational pack: plotGroups[${index}] references unknown subtrack "${subtrackId}".`,
          );
        }
        if (assignedSubtrackIds.has(subtrackId)) {
          throw new Error(
            `Invalid computational pack: subtrack "${subtrackId}" belongs to more than one plot group.`,
          );
        }
        assignedSubtrackIds.add(subtrackId);
      }
      for (const groupId of plotGroup.groupIds ?? []) {
        if (!seenGroupIds.has(groupId)) {
          throw new Error(
            `Invalid computational pack: plotGroups[${index}] references unknown output group "${groupId}".`,
          );
        }
      }
      for (const subtrackId of plotGroup.dashedSubtrackIds ?? []) {
        if (!seenSubtrackIds.has(subtrackId)) {
          throw new Error(
            `Invalid computational pack: plotGroups[${index}] references unknown dashed subtrack "${subtrackId}".`,
          );
        }
      }
      for (const groupId of plotGroup.dashedGroupIds ?? []) {
        if (!plotGroup.groupIds?.includes(groupId)) {
          throw new Error(
            `Invalid computational pack: dashed group "${groupId}" must also appear in plotGroups[${index}].groupIds.`,
          );
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    id,
    name,
    description,
    assemblyId,
    sequenceProvider: {
      type: 'ucsc',
      genome,
    },
    model: {
      format: 'onnx',
      url: modelUrl,
      inputName,
      fixedInputs: Object.keys(fixedInputs).length > 0 ? fixedInputs : undefined,
    },
    inference:
      flankBp === undefined && maxWindowBp === undefined && maxResolutionBp === undefined && transcriptPadding === undefined
        ? undefined
        : {
            flankBp,
            maxWindowBp,
            maxResolutionBp,
            transcriptPadding,
          },
    plotGroups,
    subtracks,
  };
}

export type CzpackValidation =
  | { ok: true; pack: ComputationalPackManifest }
  | { ok: false; error: string };

/**
 * Non-throwing validation for tooling and editor integrations. `normalizeComputationalPack`
 * remains the throwing entry point used on the import path.
 */
export function validateComputationalPack(raw: unknown): CzpackValidation {
  try {
    return { ok: true, pack: normalizeComputationalPack(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveBaseUrl(urlOrPath: string): string {
  if (typeof window === 'undefined') {
    return urlOrPath;
  }
  return new URL(urlOrPath, window.location.href).toString();
}

function resolveModelUrl(packUrl: string, modelUrl: string): string {
  if (typeof window === 'undefined') {
    return modelUrl;
  }

  return new URL(modelUrl, resolveBaseUrl(packUrl)).toString();
}

export async function loadComputationalPack(packUrl: string): Promise<ComputationalPackManifest> {
  const resolvedPackUrl = resolveBaseUrl(packUrl);
  const response = await timedFetch(resolvedPackUrl);
  if (!response.ok) {
    throw new Error(`Failed to load computational pack (${response.status}) from ${packUrl}`);
  }

  const payload = await response.json();
  const normalized = normalizeComputationalPack(payload);
  return {
    ...normalized,
    model: {
      ...normalized.model,
      url: resolveModelUrl(resolvedPackUrl, normalized.model.url),
    },
  };
}
