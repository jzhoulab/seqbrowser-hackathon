/**
 * Lane geometry for an annotation row, and whether its lanes can carry labels.
 *
 * Individual feature labels need enough lane pitch to avoid their neighbours.
 * Gene names use a separate header above the transcript stack, so crowded lanes
 * and clipped transcript ends do not hide the gene's identity.
 */
export const ANNOTATION_LABEL_FONT_PX = 11;

export type AnnotationGeneLabel = { name: string; startPx: number; endPx: number };

/** One name per visible gene, anchored inside the view even when its ends are outside it. */
export function layoutAnnotationGeneLabels(
  transcripts: readonly AnnotationGeneLabel[],
  widthPx: number,
  measure: (name: string) => number,
  reversed = false,
  rightInsetPx = 4,
): { name: string; x: number; width: number }[] {
  const genes = new Map<string, AnnotationGeneLabel>();
  for (const transcript of transcripts) {
    if (transcript.endPx <= 0 || transcript.startPx >= widthPx) continue;
    const existing = genes.get(transcript.name);
    if (existing) {
      existing.startPx = Math.min(existing.startPx, transcript.startPx);
      existing.endPx = Math.max(existing.endPx, transcript.endPx);
    } else {
      genes.set(transcript.name, { ...transcript });
    }
  }
  const screenGenes = [...genes.values()].map((gene) => ({
    name: gene.name,
    left: Math.max(0, reversed ? widthPx - gene.endPx : gene.startPx),
    right: Math.min(widthPx, reversed ? widthPx - gene.startPx : gene.endPx),
  })).sort((left, right) => left.left - right.left || right.right - left.right);
  const labels: { name: string; x: number; width: number }[] = [];
  let lastRight = -4;
  for (const gene of screenGenes) {
    const width = measure(gene.name);
    const x = Math.max(4, lastRight + 8, Math.min(gene.left, widthPx - rightInsetPx - width));
    if (x + width > widthPx - rightInsetPx || x > gene.right) continue;
    labels.push({ name: gene.name, x: reversed ? widthPx - x - width : x, width });
    lastRight = x + width;
  }
  return labels;
}

export function annotationLanesFitLabels(laneSpanPx: number): boolean {
  return laneSpanPx >= ANNOTATION_LABEL_FONT_PX + 1;
}

export function annotationLaneGeometry(
  heightPx: number,
  laneCount: number,
  verticalPaddingPx = 8,
): { laneSpan: number; laneHeight: number; firstLaneY: number } {
  const lanes = Math.max(1, laneCount);
  const availableHeight = Math.max(12, heightPx - verticalPaddingPx * 2);
  const laneSpan = availableHeight / lanes;
  const laneHeight = Math.min(12, Math.max(6, laneSpan * 0.68));
  const firstLaneY = (heightPx - laneSpan * lanes) * 0.5 + (laneSpan - laneHeight) * 0.5;
  return { laneSpan, laneHeight, firstLaneY };
}

/**
 * Row height as a reader can set it.
 *
 * The annotation row is the one row where height decides what data EXISTS on
 * screen rather than how large it is drawn: transcripts pack into lanes, the
 * lanes are capped, and the rest are hidden behind a "+N hidden" note. At the
 * 96px default that note hides most of what a gene-dense locus holds (ACTB, the
 * demo, needs 62 lanes and shows 8). So the row can be dragged taller, and the
 * note itself grows the row to fit -- the row already knows how many lanes it
 * needs, so a reader should not have to find out by dragging.
 */
export const TRACK_MIN_HEIGHT_PX = 40;

/** A tall row still has to leave the rest of the browser on screen. */
export const TRACK_MAX_HEIGHT_FRACTION_OF_VIEWPORT = 0.55;
export const TRACK_MAX_HEIGHT_FLOOR_PX = 240;

/** The lane pitch "fit" aims for: enough for a transcript and its label. */
export const ANNOTATION_FIT_LANE_PITCH_PX = 16;

export function maxTrackHeightPx(viewportHeightPx: number): number {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) {
    return TRACK_MAX_HEIGHT_FLOOR_PX;
  }
  return Math.max(TRACK_MAX_HEIGHT_FLOOR_PX, Math.round(viewportHeightPx * TRACK_MAX_HEIGHT_FRACTION_OF_VIEWPORT));
}

export function clampTrackHeightPx(heightPx: number, viewportHeightPx: number): number {
  if (!Number.isFinite(heightPx)) {
    return TRACK_MIN_HEIGHT_PX;
  }
  return Math.round(Math.min(maxTrackHeightPx(viewportHeightPx), Math.max(TRACK_MIN_HEIGHT_PX, heightPx)));
}

/**
 * The height that shows every lane at a readable pitch, or as many as the cap
 * allows. The inverse of `annotationLaneGeometry`: that divides a height into
 * lanes, this asks what height a lane count wants.
 */
export function annotationHeightForLanes(
  laneCount: number,
  geneHeaderPx: number,
  viewportHeightPx: number,
  verticalPaddingPx = 8,
): number {
  const lanes = Math.max(1, laneCount);
  const wanted = geneHeaderPx + verticalPaddingPx * 2 + lanes * ANNOTATION_FIT_LANE_PITCH_PX;
  return clampTrackHeightPx(wanted, viewportHeightPx);
}

/**
 * How many lanes fit a row at a readable pitch, and so how many it draws once
 * it has been grown: past the height cap the row keeps a lane window instead
 * of growing further, and the wheel over it moves that window.
 */
export function annotationLanesThatFit(heightPx: number, geneHeaderPx: number, verticalPaddingPx = 8): number {
  const available = heightPx - geneHeaderPx - verticalPaddingPx * 2;
  return Math.max(1, Math.floor(available / ANNOTATION_FIT_LANE_PITCH_PX));
}

/** The first lane a row draws, clamped so the window never runs past the last lane. */
export function clampLaneOffset(offset: number, laneCount: number, drawnLanes: number): number {
  const maxOffset = Math.max(0, laneCount - drawnLanes);
  return Math.min(maxOffset, Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0)));
}
