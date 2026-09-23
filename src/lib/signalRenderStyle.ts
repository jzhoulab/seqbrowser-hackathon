import type { TrackSpec } from '../types';

/**
 * Bars or a curve, as the output declares.
 *
 * Per-base bars are how a splice model's output should read: one value per
 * base, and joining those points draws interpolation it never produced. That is
 * a property of the OUTPUT, so it lives on the subtrack (`renderStyle`) rather
 * than being inferred from the model's id -- this used to test for an
 * name prefix, which a third-party pack could trip by accident and a model
 * under another name could never opt into.
 *
 * For a composite plot, any bar-style member makes the plot bars: mixing the two
 * in one plot would put a curve through a bar chart.
 */
export function signalRenderStyle(track: TrackSpec): 'bars' | 'line' {
  if (track.source.type === 'group') {
    return track.source.members.some((member) => signalRenderStyle(member) === 'bars') ? 'bars' : 'line';
  }
  if (track.source.type !== 'computational') {
    return 'line';
  }
  const { pack, subtrack, seriesSubtrackIds } = track.source;
  const members = seriesSubtrackIds
    ? pack.subtracks.filter((candidate) => seriesSubtrackIds.includes(candidate.id))
    : [subtrack];
  return members.some((member) => member.renderStyle === 'bars') ? 'bars' : 'line';
}
