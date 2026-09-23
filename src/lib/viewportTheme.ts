/**
 * Colors the track/ruler canvases paint with. The canvases draw imperatively, so
 * they cannot inherit CSS variables — this is their source of truth for theme.
 *
 * `bg` MUST stay in sync with the `--viewport-bg` CSS variable (App.css): the DOM
 * label column sits flush against the canvas, so a mismatch shows a seam.
 */
export type ViewportPalette = {
  bg: string;
  ink: string;
  inkSoft: string;
  axis: string;
  valueLabel: string;
  labelBoxBg: string;
  labelBoxBorder: string;
  error: string;
  gridStrong: string;
  gridWeak: string;
  tickLabel: string;
  /** Chromosome navigator (a canvas, so it cannot inherit CSS variables). */
  navBg: string;
  navStain: Record<string, string>;
  navSynthetic: string[];
  /** DNA identity colors shared by every canvas-based sequence view. */
  base: Record<'A' | 'C' | 'G' | 'T' | 'N', string>;
};

// GC warm (orange, rose), AT cool (blue, teal): complements pair within a
// temperature, so the warm fraction of any stretch is its GC content on either
// strand. Must track the --sequence-*-hue tokens in App.css.
const LIGHT_BASE = {
  A: '#4a7fd4',
  C: '#d95d70',
  G: '#e08a2e',
  T: '#2fa39a',
  N: '#858b93',
};

const DARK_BASE = {
  A: '#7ba4e8',
  C: '#ee8496',
  G: '#f0a955',
  T: '#57c2b8',
  N: '#929aa5',
};

/** Giemsa stain ramp, keyed by UCSC cytoband stain name. */
const LIGHT_STAIN: Record<string, string> = {
  gneg: '#f4f4f4',
  gpos25: '#d8d8d8',
  gpos50: '#b8b8b8',
  gpos75: '#929292',
  gpos100: '#676767',
  gvar: '#e2e2e2',
  stalk: '#b8b3d3',
  acen: '#c77b84',
  default: '#e8e8e8',
};

// Inverted ramp for dark: staining intensity now reads as *lighter*, so the
// banding pattern survives on a dark instrument without glaring.
const DARK_STAIN: Record<string, string> = {
  gneg: '#1a2330',
  gpos25: '#27333f',
  gpos50: '#36434f',
  gpos75: '#4b5865',
  gpos100: '#65727f',
  gvar: '#202a37',
  stalk: '#6b62a8',
  acen: '#8f5560',
  default: '#1e2733',
};

export const VIEWPORT_LIGHT: ViewportPalette = {
  bg: '#ffffff',
  ink: '#141414',
  inkSoft: '#7a7a7a',
  axis: 'rgba(20, 20, 20, 0.32)',
  valueLabel: 'rgba(20, 20, 20, 0.55)',
  labelBoxBg: 'rgba(255, 255, 255, 0.94)',
  labelBoxBorder: 'rgba(0, 0, 0, 0.16)',
  error: '#d36b6b',
  gridStrong: '#727272',
  gridWeak: '#d4d4d4',
  tickLabel: '#333333',
  navBg: '#ffffff',
  navStain: LIGHT_STAIN,
  navSynthetic: ['#f0f0f0', '#e6e6e6', '#dcdcdc', '#d2d2d2'],
  base: LIGHT_BASE,
};

export const VIEWPORT_DARK: ViewportPalette = {
  bg: '#0b1119',
  ink: '#e8ebf1',
  inkSoft: '#8b93a0',
  axis: 'rgba(232, 235, 241, 0.3)',
  valueLabel: 'rgba(232, 235, 241, 0.5)',
  labelBoxBg: 'rgba(16, 21, 29, 0.92)',
  labelBoxBorder: 'rgba(255, 255, 255, 0.18)',
  error: '#ff6b66',
  gridStrong: '#5b6472',
  gridWeak: '#2a313c',
  tickLabel: '#aeb6c2',
  navBg: '#111821',
  navStain: DARK_STAIN,
  navSynthetic: ['#1b2430', '#212b38', '#27323f', '#2d3947'],
  base: DARK_BASE,
};

let dark = false;
const listeners = new Set<() => void>();

/** Set by the app when the effective theme changes. Notifies canvas subscribers. */
export function setViewportDark(next: boolean): void {
  if (next === dark) {
    return;
  }
  dark = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeViewportTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isViewportDark(): boolean {
  return dark;
}

export function getViewportPalette(): ViewportPalette {
  return dark ? VIEWPORT_DARK : VIEWPORT_LIGHT;
}
