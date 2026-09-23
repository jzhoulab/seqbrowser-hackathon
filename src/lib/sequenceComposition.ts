import type { CSSProperties } from 'react';

export type SequenceCompositionBin = {
  startOffset: number;
  endOffset: number;
  a: number;
  c: number;
  g: number;
  t: number;
  n: number;
};

export function compositionBinStyle(bin: SequenceCompositionBin): CSSProperties {
  const size = Math.max(1, bin.endOffset - bin.startOffset);
  // Cumulative in the ORDER THE GRADIENT STACKS: G, C (the warm block whose
  // height is the bin's GC content), then A, T. When the stops were reordered
  // without these offsets, the G band ran to the a+c+g total -- most of the bar
  // turned warm and the "GC content" reading was fiction.
  const gEnd = (bin.g / size) * 100;
  const cEnd = gEnd + (bin.c / size) * 100;
  const aEnd = cEnd + (bin.a / size) * 100;
  const tEnd = aEnd + (bin.t / size) * 100;

  return {
    flexGrow: size,
    '--sequence-g-end': `${gEnd}%`,
    '--sequence-c-end': `${cEnd}%`,
    '--sequence-a-end': `${aEnd}%`,
    '--sequence-t-end': `${tEnd}%`,
  } as CSSProperties;
}

