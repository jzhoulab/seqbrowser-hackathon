import { resolveComputationalPlotGroup } from './computationalPlotGroups';
import type { SequenceEdit, TrackSpec } from '../types';

export type SequenceVariant = {
  id: string;
  edits: SequenceEdit[];
};

/**
 * How an edited sequence is laid out.
 *
 * The row the user types into IS the sequence -- it carries the edits -- and the
 * original drops beneath it as a reference track. That is how a text editor
 * reads: you change the document; the unchanged copy is what you compare
 * against. The earlier layout kept the reference pinned and spawned a
 * "Modified N" row per edit, which made the thing you were editing the copy.
 *
 * Which tracks follow which sequence is not a choice:
 *
 *  - Computational tracks follow the EDITED sequence. A model scores whatever
 *    bases it is given, so every model output shown on the reference -- plots
 *    and ISM rows alike -- is re-run on the edit and sits under the variant. The
 *    same outputs still run on the reference, beneath, so the two answers can be
 *    read against each other. Which outputs to mirror is not decided here: the
 *    default is all of them, and the user hides any one on the edited sequence
 *    from its row (`hiddenOnEdited`, by the reference track's id). Mirroring only
 *    a manifest-chosen "comparison plot" was tried first and left the ISM rows
 *    with no edited counterpart, with no way to ask for one.
 *
 *  - Data and annotation tracks follow the REFERENCE only. A bigWig value or a
 *    GENCODE exon is a fact about a genomic coordinate; there is no such fact
 *    about a base the user just typed. They draw once, under the reference.
 *
 * With no edits there is no variant and nothing moves.
 */

// The row is the sequence and nothing else: one line of bases plus the hairline
// that separates it from the next row.
const SEQUENCE_ROW_HEIGHT_PX = 18;

/** The original sequence, shown beneath the variant once edits exist. */
export function makeReferenceSequenceTrack(): TrackSpec {
  return {
    id: 'sequence-reference',
    name: 'Reference sequence',
    kind: 'annotation',
    color: '#64748b',
    height: SEQUENCE_ROW_HEIGHT_PX,
    source: { type: 'sequence-variant', variantId: '__reference__', edits: [] },
  };
}

function cloneAsEditedTrack(track: TrackSpec, variant: SequenceVariant): TrackSpec | null {
  if (track.source.type !== 'computational') {
    return null;
  }
  if (track.source.editRole === 'edited') {
    return null;
  }

  const instanceId = track.source.instanceId ?? track.source.pack.id;
  const pack = track.source.pack;
  // The plot group this track draws from becomes a group of its own on the
  // edit, so the edited copy is a distinct plot; an output outside any group
  // (an ISM row) needs no such rename.
  const sourceGroupId = resolveComputationalPlotGroup(pack, track.source.subtrack)?.id ?? null;
  const plotGroupId = `${sourceGroupId ?? 'plot'}-edited-${variant.id}`;
  const plotGroups = pack.plotGroups
    ? sourceGroupId
      ? pack.plotGroups.map((group) => (group.id === sourceGroupId ? { ...group, id: plotGroupId } : group))
      : pack.plotGroups
    : [
        {
          id: plotGroupId,
          label: track.name,
          subtrackIds: track.source.seriesSubtrackIds ?? [track.source.subtrack.id],
        },
      ];

  return {
    ...track,
    id: `${track.id}:edited:${variant.id}`,
    // Same name as the reference plot: it IS that plot, run on the edited
    // sequence. Its position under the variant says which sequence it scored.
    name: track.name,
    source: {
      ...track.source,
      instanceId: `${instanceId}:edited:${variant.id}`,
      sequenceEdits: [...variant.edits],
      editRole: 'edited',
      sequenceVariantId: variant.id,
      editedFrom: track.id,
      pack: { ...pack, plotGroups },
    },
  };
}

/**
 * Order the track list for the current edit state.
 *
 * No variant: the tracks as given. With a variant: every model output re-run
 * on the edit comes FIRST (under the pinned, editable sequence row), except the
 * ones the user hid there, then the reference sequence row, then every track as
 * given -- model outputs on the reference and all data/annotation tracks.
 */
export function layoutTracksForEdits(
  tracks: readonly TrackSpec[],
  variant: SequenceVariant | null,
  /** Reference track ids the user does not want mirrored onto the edit. */
  hiddenOnEdited: ReadonlySet<string> = new Set(),
): TrackSpec[] {
  if (!variant || variant.edits.length === 0) {
    return [...tracks];
  }

  const onVariant: TrackSpec[] = [];
  for (const track of tracks) {
    if (hiddenOnEdited.has(track.id)) {
      continue;
    }
    const edited = cloneAsEditedTrack(track, variant);
    if (edited) {
      onVariant.push(edited);
    }
  }

  return [...onVariant, makeReferenceSequenceTrack(), ...tracks];
}
