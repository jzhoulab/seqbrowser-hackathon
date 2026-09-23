/**
 * Below this visible span a site's auto-mount model mounts on its own, so its
 * scores are simply present once a locus is in view. Whether they are
 * *computed* at a given width remains the inference budget's call.
 */
export const MODEL_AUTOLOAD_MAX_SPAN_BP = 20_000;

/** How long the zoom must hold before the pack fetch and WASM warm-up start. */
export const MODEL_AUTOLOAD_SETTLE_MS = 300;

export type ModelAutoloadInput = {
  /** Measured width of the viewport host, in CSS pixels. */
  hostWidth: number;
  /** Visible span in base pairs. */
  spanBp: number;
  assemblyId: string;
  /** Assembly the model's catalog entry declares, when it declares one. */
  packAssemblyId?: string;
  /** True once this session has already auto-mounted (or declined to). */
  alreadyFired: boolean;
};

/**
 * Whether a zoom level should pull the site's model in by itself.
 *
 * The viewport-width check is load-bearing, not defensive: until the host is
 * measured its width falls back to a single pixel, which makes every zoom level
 * report a ~20 kb span and would mount the model on every cold load.
 */
export function shouldAutoMountModel({
  hostWidth,
  spanBp,
  assemblyId,
  packAssemblyId,
  alreadyFired,
}: ModelAutoloadInput): boolean {
  if (alreadyFired || hostWidth <= 0) {
    return false;
  }

  if (!Number.isFinite(spanBp) || spanBp <= 0 || spanBp > MODEL_AUTOLOAD_MAX_SPAN_BP) {
    return false;
  }

  return !packAssemblyId || packAssemblyId === assemblyId;
}
