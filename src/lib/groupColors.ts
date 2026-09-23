/**
 * Colours for track groups.
 *
 * A mounted model is a group; its output collections (a splice model's
 * predictions and its attributions) are subgroups within it. Every mounted
 * model gets a hue of its own, in mount order, and each subgroup a shade of its
 * parent's hue -- close enough to read as the same family, far enough apart to
 * tell the subgroups from one another. The same colours mark the group headers
 * in the track list, the rails on the rows beneath them, and the collections in
 * the Tracks panel, so one glance says which rows belong together.
 *
 * Hex strings rather than CSS variables: they are assigned per instance at
 * runtime and flow into inline `--group-color` custom properties.
 */

/**
 * The two sequence sections the list splits into once the sequence is edited:
 * the plots re-run on the edited sequence, and everything scored on or aligned
 * to the reference. Amber is the edit colour the sequence row already uses for
 * a substituted base; slate is the reference strip's own colour.
 */
export const SEQUENCE_SECTION_COLORS = { edited: '#d97706', reference: '#64748b' } as const;

/** Model hues in mount order. The first is the violet the app has always used for models. */
export const MODEL_GROUP_PALETTE: readonly string[] = [
  '#7c3aed', // violet
  '#0f766e', // teal
  '#b45309', // amber
  '#be185d', // rose
  '#4d7c0f', // olive
  '#1d4ed8', // blue
];

export function modelGroupColor(index: number): string {
  return MODEL_GROUP_PALETTE[((index % MODEL_GROUP_PALETTE.length) + MODEL_GROUP_PALETTE.length) % MODEL_GROUP_PALETTE.length]!;
}

/** One colour per model instance, in order of first appearance. */
export function assignModelGroupColors(instanceIds: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const instanceId of instanceIds) {
    if (!colors.has(instanceId)) {
      colors.set(instanceId, modelGroupColor(colors.size));
    }
  }
  return colors;
}

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1]!, 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return { h: 0, s: 0, l };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return { h: ((h * 60) + 360) % 360, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

const SUBGROUP_HUE_SPREAD_DEG = 30;
const SUBGROUP_LIGHTNESS_SPREAD = 0.1;

/**
 * The shade for subgroup `index` of `count` within a group of colour `parent`:
 * the parent's hue turned a little one way or the other, and its lightness
 * moved the opposite way, so neighbouring subgroups differ in two dimensions.
 * A lone subgroup is its parent's colour.
 */
export function subgroupColor(parent: string, index: number, count: number): string {
  if (count <= 1) {
    return parent;
  }
  const hsl = hexToHsl(parent);
  if (!hsl) {
    return parent;
  }
  const t = index / (count - 1) - 0.5;
  return hslToHex({
    h: (hsl.h + t * SUBGROUP_HUE_SPREAD_DEG + 360) % 360,
    s: hsl.s,
    l: Math.min(0.72, Math.max(0.28, hsl.l - t * SUBGROUP_LIGHTNESS_SPREAD)),
  });
}
