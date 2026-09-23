import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_FIT_LANE_PITCH_PX,
  TRACK_MIN_HEIGHT_PX,
  annotationHeightForLanes,
  annotationLaneGeometry,
  annotationLanesFitLabels,
  annotationLanesThatFit,
  clampLaneOffset,
  clampTrackHeightPx,
  layoutAnnotationGeneLabels,
  maxTrackHeightPx,
} from '../lib/annotationLayout';

// Transcript ids rendered half-clipped when a gene's transcripts packed into
// enough lanes that each was shorter than the 11px text. Labels now draw only
// when the lane pitch fits them.

describe('annotation labels vs lane pitch', () => {
  it('a 96px row with 8 lanes cannot carry labels', () => {
    // (96 - 16) / 8 = 10px per lane, under 11px text.
    const { laneSpan } = annotationLaneGeometry(96, 8);
    expect(laneSpan).toBeCloseTo(10, 5);
    expect(annotationLanesFitLabels(laneSpan)).toBe(false);
  });

  it('the same row with 4 lanes can', () => {
    const { laneSpan } = annotationLaneGeometry(96, 4);
    expect(laneSpan).toBeCloseTo(20, 5);
    expect(annotationLanesFitLabels(laneSpan)).toBe(true);
  });

  it('a single lane always fits', () => {
    expect(annotationLanesFitLabels(annotationLaneGeometry(74, 1).laneSpan)).toBe(true);
  });

  it('lane height never collapses below 6px even when pitch does', () => {
    const { laneHeight } = annotationLaneGeometry(40, 8);
    expect(laneHeight).toBe(6);
  });
});

describe('gene names while panning within transcripts', () => {
  const measure = (name: string) => name.length * 7;

  it('keeps one name visible for a crowded gene whose ends are both offscreen', () => {
    const transcripts = Array.from({ length: 8 }, (_, index) => ({ name: 'GENE1', startPx: -500 - index, endPx: 1000 + index }));
    expect(annotationLanesFitLabels(annotationLaneGeometry(96, 8).laneSpan)).toBe(false);
    expect(layoutAnnotationGeneLabels(transcripts, 600, measure)).toEqual([{ name: 'GENE1', x: 4, width: 35 }]);
    expect(layoutAnnotationGeneLabels(transcripts, 600, measure, true)).toEqual([{ name: 'GENE1', x: 561, width: 35 }]);
  });

  it('separates overlapping gene names and keeps them out of the row status', () => {
    const transcripts = [
      { name: 'GENE1', startPx: -100, endPx: 350 },
      { name: 'GENE2', startPx: -50, endPx: 400 },
      { name: 'GENE3', startPx: 370, endPx: 600 },
    ];
    for (const reversed of [false, true]) {
      const labels = layoutAnnotationGeneLabels(transcripts, 500, measure, reversed, 100);
      const screen = labels.map((label) => ({ x: reversed ? 500 - label.x - label.width : label.x, width: label.width })).sort((a, b) => a.x - b.x);
      expect(labels).toHaveLength(3);
      for (const [index, label] of screen.entries()) {
        expect(label.x).toBeGreaterThanOrEqual(index ? screen[index - 1].x + screen[index - 1].width + 8 : 4);
        expect(label.x + label.width).toBeLessThanOrEqual(400);
      }
    }
  });

  it('omits offscreen genes and reserves no labels for unnamed annotation data', () => {
    expect(layoutAnnotationGeneLabels([], 300, measure)).toEqual([]);
    expect(layoutAnnotationGeneLabels([{ name: 'GENE1', startPx: -300, endPx: -1 }, { name: 'GENE2', startPx: 301, endPx: 400 }], 300, measure)).toEqual([]);
  });
});

// The annotation row is the one row where height decides what data is on
// screen: ACTB, the demo locus, needs 62 lanes and a 96px row draws 8. So the
// row can be grown, and the growth is derived from what it needs rather than
// guessed by dragging.
describe('growing an annotation row to its lanes', () => {
  it('asks for a readable pitch per lane, plus the gene-name header and padding', () => {
    const tall = 2000;
    expect(annotationHeightForLanes(8, 16, tall)).toBe(16 + 16 + 8 * ANNOTATION_FIT_LANE_PITCH_PX);
    expect(annotationHeightForLanes(1, 0, tall)).toBe(TRACK_MIN_HEIGHT_PX);
  });

  it('never grows past a fraction of the viewport, and never below the floor', () => {
    expect(annotationHeightForLanes(62, 16, 900)).toBe(maxTrackHeightPx(900));
    expect(maxTrackHeightPx(900)).toBe(495);
    expect(maxTrackHeightPx(300)).toBe(240);
    expect(clampTrackHeightPx(10, 900)).toBe(TRACK_MIN_HEIGHT_PX);
    expect(clampTrackHeightPx(Number.NaN, 900)).toBe(TRACK_MIN_HEIGHT_PX);
    expect(clampTrackHeightPx(5000, 900)).toBe(495);
  });

  it('is the inverse of the lane geometry: a row grown to fit draws every lane', () => {
    for (const lanes of [3, 8, 20]) {
      const height = annotationHeightForLanes(lanes, 16, 2000);
      expect(annotationLanesThatFit(height, 16)).toBeGreaterThanOrEqual(lanes);
    }
  });

  it('keeps a lane window inside the lanes that exist', () => {
    expect(clampLaneOffset(0, 62, 8)).toBe(0);
    expect(clampLaneOffset(10, 62, 8)).toBe(10);
    expect(clampLaneOffset(100, 62, 8)).toBe(54);
    expect(clampLaneOffset(-3, 62, 8)).toBe(0);
    expect(clampLaneOffset(5, 8, 8)).toBe(0);
    expect(clampLaneOffset(Number.NaN, 62, 8)).toBe(0);
  });
});
