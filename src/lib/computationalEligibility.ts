import { effectiveComputationalMaxWindowBp } from './computationalLimits';
import { clampRangeToChromosome } from './genomeMath';
import type { ComputationalPackManifest, ComputationalSubtrackSpec, ViewportState } from '../types';

export type ComputationalEligibilityReason = 'requires-assembly' | 'window' | 'resolution' | 'mutagenesis-span';

export type ComputationalEligibility = {
  eligible: boolean;
  reason: ComputationalEligibilityReason | null;
  maxWindowBp: number;
  maxResolutionBp?: number;
  /** Set with reason 'mutagenesis-span': the widest view the row is computed for. */
  maxSpanBp?: number;
};

/**
 * One shared eligibility contract for model loading, track hints, and the model UI.
 * Keeping this centralized prevents the interface from promising work the loader
 * will decline (or, more importantly, running a fixed-reference model elsewhere).
 *
 * With a `subtrack`, the answer is for that one row: a mutagenesis row is paid
 * per base on screen and declares how wide a view it is computed for.
 */
export function deriveComputationalEligibility(
  pack: ComputationalPackManifest,
  viewport: ViewportState,
  resolutionBp: number,
  subtrack?: ComputationalSubtrackSpec,
): ComputationalEligibility {
  const maxWindowBp = effectiveComputationalMaxWindowBp(pack);
  const maxResolutionBp = pack.inference?.maxResolutionBp;

  if (pack.assemblyId && viewport.assemblyId && pack.assemblyId !== viewport.assemblyId) {
    return {
      eligible: false,
      reason: 'requires-assembly',
      maxWindowBp,
      maxResolutionBp,
    };
  }

  const clampedRange = clampRangeToChromosome(viewport.range, viewport.chrLength);
  if (Math.max(1, clampedRange.span) > maxWindowBp) {
    return {
      eligible: false,
      reason: 'window',
      maxWindowBp,
      maxResolutionBp,
    };
  }

  if (maxResolutionBp && resolutionBp > maxResolutionBp) {
    return {
      eligible: false,
      reason: 'resolution',
      maxWindowBp,
      maxResolutionBp,
    };
  }

  const mutagenesis = subtrack?.mutagenesis;
  if (mutagenesis && Math.max(1, clampedRange.span) > mutagenesis.maxSpanBp) {
    return {
      eligible: false,
      reason: 'mutagenesis-span',
      maxWindowBp,
      maxResolutionBp,
      maxSpanBp: mutagenesis.maxSpanBp,
    };
  }

  return {
    eligible: true,
    reason: null,
    maxWindowBp,
    maxResolutionBp,
  };
}
