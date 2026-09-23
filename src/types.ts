import type { GenomicRange } from './lib/genomeMath';
import type { TrackScaleConfig } from './lib/signalScale';

export type Chromosome = {
  id: string;
  length: number;
};

export type IdeogramBand = {
  start: number;
  end: number;
  name: string;
  stain: string;
};

export type TrackKind = 'signal' | 'annotation';
export type SignalDisplayMode = 'signal' | 'sequence';

export type FeatureStrand = '+' | '-' | '.';
export type FeatureRenderMode = 'interval' | 'density';

export type ComputationalPlotGroupSpec = {
  id: string;
  label: string;
  /** Explicit outputs combined into this plot, in display order. */
  subtrackIds?: string[];
  /** Whole output collections appended to this plot, in display order. */
  groupIds?: string[];
  /** Collections rendered with dashed curves, for example an opposite strand. */
  dashedGroupIds?: string[];
  /** Individual outputs rendered with dashed curves. */
  dashedSubtrackIds?: string[];
  height?: number;
  /**
   * Accepted for older manifests, no longer consulted: every output shown on
   * the reference is re-run on an edited sequence, and the user hides any of
   * them there from its row.
   */
  comparesEdits?: boolean;
};

export type ComputationalPackManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  assemblyId?: string;
  sequenceProvider: {
    type: 'ucsc';
    genome: string;
  };
  model: {
    format: 'onnx';
    url: string;
    inputName?: string;
    fixedInputs?: Record<string, number>;
  };
  inference?: {
    flankBp?: number;
    maxWindowBp?: number;
    maxResolutionBp?: number;
    /**
     * A transcript model trained on transcripts flanked by this many N on each
     * end: the browser feeds N for bases within that distance outside a
     * same-strand canonical transcript, as training did.
     */
    transcriptPadding?: { bp: number };
  };
  /** Optional display composition; inference collections remain independently addressable. */
  plotGroups?: ComputationalPlotGroupSpec[];
  subtracks: ComputationalSubtrackSpec[];
};

/**
 * An attribution row derived by exact in silico saturation mutagenesis of a
 * prediction output, computed by the browser rather than read from the graph.
 * For each base on screen the model is re-run three times, once per
 * substitution, on the whole request window; the row's value is the summed
 * absolute change in probability within `contextBp` of the base, averaged
 * over the three substitutions. Unsigned: a base the calls depend on and a
 * base whose mutation would create a call both read high.
 */
export type ComputationalMutagenesisSpec = {
  /** Absolute changes within this many bases of the mutated base are summed. */
  contextBp: number;
  /** Computed only while the view is at most this wide; wider views say so. */
  maxSpanBp: number;
};

export type ComputationalSubtrackSpec = {
  id: string;
  name: string;
  kind: TrackKind;
  color: string;
  height: number;
  outputName: string;
  channelIndex?: number;
  /** Present on a row that is a mutagenesis of `outputName`/`channelIndex`, not a read of it. */
  mutagenesis?: ComputationalMutagenesisSpec;
  transform?: 'identity' | 'abs' | 'relu';
  /** Optional output collection used by model-native visibility controls. */
  groupId?: string;
  groupLabel?: string;
  /** Per-series fallback when the pack does not define a matching plot group. */
  plotGroupId?: string;
  plotGroupLabel?: string;
  lineStyle?: 'solid' | 'dashed';
  /** Hidden collections remain available without flooding the initial viewport. */
  defaultVisible?: boolean;
  role?: 'prediction' | 'activation' | 'effect' | 'contribution';
  /** Signed signals render around a centered zero baseline. */
  scaleMode?: 'positive' | 'signed';
  /** Preferred initial visualization; users can change it without changing data identity. */
  defaultSignalDisplay?: SignalDisplayMode;
  /** Keep the visible range this far inside a computed output to avoid model-edge seams. */
  stableMarginBp?: number;
  /**
   * Pin this output's y-axis to a known range, for outputs whose units are fixed by
   * construction -- a probability is always [0, 1], and auto-scaling one makes a flat
   * region look as tall as a confident peak.
   *
   * Declared per subtrack rather than inferred, because it is a property of the output,
   * not of the model. A signed contribution in the same pack must NOT inherit it: its
   * negative half would be clipped away.
   */
  fixedScale?: { min: number; max: number };
  /**
   * How to draw this output's values. 'bars' is one mark per base, for a model
   * that emits one value per base (a splice-site caller): joining those points
   * draws interpolation it never produced. 'line' (the default) joins them, for
   * continuous signal. A property of the output, declared here, not inferred
   * from the model's name.
   */
  renderStyle?: 'bars' | 'line';
  /**
   * Y-axis shapes this output enables beyond linear, power and log, which every
   * signal has. `complement-log` draws −log10(1 − p), giving each nine the same
   * height; it needs a probability, so the loader accepts it only on an output
   * pinned inside [0, 1] by `fixedScale`.
   */
  scaleShapes?: OptInSignalScaleShape[];
};

/** Local DNA edits applied to the reference before computational inference. */
export type SequenceEdit =
  | { kind: 'insert'; start: number; sequence: string }
  | { kind: 'delete'; start: number; end: number }
  | {
      kind: 'substitute';
      start: number;
      end: number;
      sequence: string;
      /**
       * While a selection is being typed over base by base, where the typed
       * bases sit: at `start` (typed on the plus strand, left to right in
       * genomic order) or at `end` (typed on the minus strand, where left to
       * right runs down the coordinates). Irrelevant once the range is full.
       */
      anchor?: 'end';
    };

export type TrackSource =
  | { type: 'mock' }
  | { type: 'bigwig'; url: string }
  | {
      type: 'bigbed';
      url: string;
      visibilityWindowBp?: number;
      /**
       * Companion bigBed whose transcript ids mark the representative transcript
       * of each gene (UCSC's MANE track). Present only for gene annotations.
       */
      maneUrl?: string;
    }
  | {
      type: 'computational';
      /** One mounted model instance shared by all of its output tracks. */
      instanceId?: string;
      packUrl: string;
      pack: ComputationalPackManifest;
      subtrack: ComputationalSubtrackSpec;
      /** Ordered series rendered by a synthesized multi-series plot track. */
      seriesSubtrackIds?: string[];
      /** When set, inference uses the edited sequence instead of the reference. */
      sequenceEdits?: SequenceEdit[];
      /**
       * Score the reverse complement of the (edited) window and map the outputs
       * back to genomic order. Set while the browser reads the minus strand, so a
       * strand-specific model sees the strand on screen.
       */
      reverseComplement?: boolean;
      /** Distinguishes the edited-sequence plot from the reference plot. */
      editRole?: 'reference' | 'edited';
      /** Sequence-edit variant this edited plot is bonded to. */
      sequenceVariantId?: string;
      /** The reference track this edited copy was cloned from, so it can be hidden there by id. */
      editedFrom?: string;
    }
  | {
      type: 'sequence-variant';
      variantId: string;
      edits: SequenceEdit[];
    }
  | {
      /**
       * A user-defined combined plot. Each member keeps its own source and is
       * fetched as it would be alone; the row draws them as one series each.
       */
      type: 'group';
      members: TrackSpec[];
    };

/**
 * How a signal's value maps onto its plot height. `complement-log` is
 * −log10(1 − p), which only means something for a probability, so a track's
 * config has to enable it; see src/lib/signalScaleShape.ts.
 */
export type SignalScaleShape = 'linear' | 'power' | 'log' | 'complement-log';

/** The shapes a track's config has to enable. */
export type OptInSignalScaleShape = Extract<SignalScaleShape, 'complement-log'>;

export type TrackSpec = {
  id: string;
  name: string;
  color: string;
  /**
   * Row height in CSS pixels. A reader can drag an annotation row taller (and
   * grow it to fit its lanes from the hidden-count note); the value they chose
   * lives here, so a shared link reproduces it.
   */
  height: number;
  kind: TrackKind;
  source: TrackSource;
  /** Visible-range autoscale, a linked comparison group, or an explicit domain. */
  yScale?: TrackScaleConfig;
  /** Redistribute the plot height between the same endpoints (src/lib/signalScaleShape.ts). */
  scaleShape?: SignalScaleShape;
  /**
   * Opt-in shapes this track's config enables beyond linear, power and log. A
   * model output declares them in its manifest (the subtrack's `scaleShapes`);
   * this is the same switch for any other track.
   */
  scaleShapes?: readonly OptInSignalScaleShape[];
  /** Draw a signal conventionally or encode each true 1-bp value as a DNA base height. */
  signalDisplay?: SignalDisplayMode;
  /**
   * For an output its pack groups into a plot: drawn with that plot (default) or
   * as its own row. On the member, because the combined row is synthesized on
   * every render.
   */
  plotGrouping?: 'combined' | 'split';
  /** A user-defined combined plot: signal tracks sharing an id draw as one row. */
  userGroup?: { id: string; label?: string };
};

export type ViewportState = {
  /** Active reference assembly. Optional for low-level callers and legacy tests. */
  assemblyId?: string;
  chr: string;
  chrLength: number;
  widthPx: number;
  centerBp: number;
  bpPerPx: number;
  range: GenomicRange;
};

export type TrackFeatureExon = {
  start: number;
  end: number;
};

export type TrackFeature = {
  start: number;
  end: number;
  score: number;
  lane?: number;
  label?: string;
  /** The transcript behind a label that shows its gene's symbol. */
  transcriptId?: string;
  strand?: FeatureStrand;
  /** Representative transcript ('primary') vs the alternates around it. */
  emphasis?: 'primary' | 'secondary';
  /**
   * Set on a score that belongs to an inserted base, which has no coordinate of
   * its own: the run sits in front of `insertionBefore`, at `insertionOffset`.
   */
  insertionBefore?: number;
  insertionOffset?: number;
  /**
   * On a mutagenesis row at base resolution: the largest change the mean of
   * this base's three mutants made to the row's channel -- where, in bases from
   * the base along the strand read (+ is to the right on screen), and from what
   * value to what.
   */
  mutantEffect?: { offset: number; reference: number; mutant: number };
  renderMode?: FeatureRenderMode;
  /** Zero-based index into a computational track's ordered series ids. */
  seriesIndex?: number;
  /** Exon intervals for transcript/gene models (introns are the gaps between them). */
  exons?: TrackFeatureExon[];
  /** Coding-sequence bounds within the transcript, when present (bigGenePred cdStart/cdEnd). */
  cdsStart?: number;
  cdsEnd?: number;
};

export type DataWindowSpec = {
  key: string;
  requestStart: number;
  requestEnd: number;
  resolutionBp: number;
  /**
   * The bases a per-base computation should actually visit, for work that is
   * paid per base rather than per window (a mutagenesis row). The whole window
   * is still fetched and scored as context; only this part is mutated.
   */
  focus?: { start: number; end: number };
};

export type TrackWindowData = {
  spec: DataWindowSpec;
  features: TrackFeature[];
  fetchedAt: number;
};
