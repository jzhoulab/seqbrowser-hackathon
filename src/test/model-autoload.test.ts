import { describe, expect, it } from 'vitest';

import {
  MODEL_AUTOLOAD_MAX_SPAN_BP,
  shouldAutoMountModel,
} from '../lib/modelAutoload';

const BASE = {
  hostWidth: 1440,
  spanBp: 10_000,
  assemblyId: 'hg38',
  packAssemblyId: 'hg38',
  alreadyFired: false,
};

describe('model auto-load', () => {
  it('mounts once the view is inside the span threshold', () => {
    expect(shouldAutoMountModel(BASE)).toBe(true);
    expect(shouldAutoMountModel({ ...BASE, spanBp: MODEL_AUTOLOAD_MAX_SPAN_BP })).toBe(true);
  });

  it('stays out of the way at wider zooms', () => {
    expect(shouldAutoMountModel({ ...BASE, spanBp: MODEL_AUTOLOAD_MAX_SPAN_BP + 1 })).toBe(false);
    expect(shouldAutoMountModel({ ...BASE, spanBp: 18_000_000 })).toBe(false);
  });

  it('waits for the viewport to be measured', () => {
    // An unmeasured host reports width 0, and the span derived from it is
    // meaningless -- mounting on it would fire on every cold load.
    expect(shouldAutoMountModel({ ...BASE, hostWidth: 0 })).toBe(false);
  });

  it('fires at most once per session', () => {
    expect(shouldAutoMountModel({ ...BASE, alreadyFired: true })).toBe(false);
  });

  it('does not mount against a reference the model was not trained on', () => {
    expect(shouldAutoMountModel({ ...BASE, assemblyId: 'mm10' })).toBe(false);
    expect(shouldAutoMountModel({ ...BASE, assemblyId: 'hg19' })).toBe(false);
  });

  it('mounts on any assembly when the pack declares none', () => {
    expect(
      shouldAutoMountModel({ ...BASE, assemblyId: 'mm10', packAssemblyId: undefined }),
    ).toBe(true);
  });

  it('ignores a degenerate span', () => {
    expect(shouldAutoMountModel({ ...BASE, spanBp: 0 })).toBe(false);
    expect(shouldAutoMountModel({ ...BASE, spanBp: Number.NaN })).toBe(false);
  });
});
