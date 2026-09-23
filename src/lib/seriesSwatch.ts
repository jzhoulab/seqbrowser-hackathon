/**
 * A colour chip for a row of several series: the members' colours stacked as
 * horizontal stripes, so a combined plot is told apart from a plain track at a
 * glance, in the row label and in the Tracks panel alike.
 */
export function stackedSwatch(colors: readonly string[]): string {
  const stripes = colors.slice(0, 6);
  if (stripes.length <= 1) {
    return stripes[0] ?? 'transparent';
  }
  const step = 100 / stripes.length;
  const stops = stripes.map(
    (color, index) => `${color} ${(index * step).toFixed(1)}% ${((index + 1) * step).toFixed(1)}%`,
  );
  return `linear-gradient(to bottom, ${stops.join(', ')})`;
}
