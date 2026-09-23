import { siteExtension } from "virtual:site-extension";

export type ModelDemoLocus = {
  label: string;
  chr: string;
  centerBp: number;
  spanBp: number;
  /** The gene's strand: the demo opens reading it, so a transcript model scores it as trained. */
  strand?: '+' | '-';
};

/** One checkpoint/pack selectable inside a catalog family. */
export type ModelCatalogVariant = {
  id: string;
  label: string;
  url: string;
  detail?: string;
};

export type ModelCatalogEntry = {
  id: string;
  name: string;
  eyebrow: string;
  description: string;
  assemblyId: string;
  url: string;
  outputLabels: readonly string[];
  availableOutputCount?: number;
  chartOutputCount?: number;
  attributionChannelCount?: number;
  outputGroups?: readonly ModelOutputGroup[];
  homepage?: string;
  featured?: boolean;
  demo?: ModelDemoLocus;
  /** Optional checkpoint picker; `id`/`url` on the entry are the family defaults. */
  variants?: readonly ModelCatalogVariant[];
};

export type ModelOutputOption = {
  id: string;
  label: string;
  color: string;
};

export type ModelOutputPicker = {
  label: string;
  options: readonly ModelOutputOption[];
};

export type ModelOutputGroup = {
  id: string;
  label: string;
  count: number;
  description: string;
  outputPicker?: ModelOutputPicker;
};

const PUFFIN_MOTIFS = [
  { label: "YY1+", color: "#1F77B4" },
  { label: "TATA+", color: "#E41A1C" },
  { label: "U1 snRNP+", color: "#9F9F9F" },
  { label: "YY1−", color: "#C2D5E8" },
  { label: "ETS+", color: "#19D3F3" },
  { label: "NFY+", color: "#00CC96" },
  { label: "ETS−", color: "#19E4F3" },
  { label: "NFY−", color: "#00CC5F" },
  { label: "CREB+", color: "#FF6692" },
  { label: "CREB−", color: "#FF66C2" },
  { label: "ZNF143+", color: "#17A4CF" },
  { label: "SP+", color: "#FF7F0E" },
  { label: "SP−", color: "#FF930E" },
  { label: "NRF1−", color: "#B663FA" },
  { label: "NRF1+", color: "#AB63FA" },
  { label: "ZNF143−", color: "#17BECF" },
  { label: "TATA−", color: "#FFC6BA" },
  { label: "U1 snRNP−", color: "#CFCFCF" },
] as const;

function puffinAttributionOptions(
  kind: "initiation" | "motif",
): readonly ModelOutputOption[] {
  return PUFFIN_MOTIFS.map((motif, index) => ({
    id:
      kind === "initiation"
        ? `puffin-bp-initiation-contribution-${index + 1}`
        : `puffin-bp-motif-contribution-${index + 1}`,
    label: motif.label,
    color: motif.color,
  }));
}

const ALL_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: "seqbro2-puffin",
    name: "Puffin",
    eyebrow: "Transcription initiation",
    description:
      "Predict initiation at base-pair resolution and reveal the sequence contribution around each site.",
    assemblyId: "hg38",
    url: "/computational/packs/seqbro2-puffin.czpack",
    outputLabels: ["Prediction (+)", "Prediction (−)", "Total sequence effect"],
    availableOutputCount: 100,
    chartOutputCount: 64,
    attributionChannelCount: 36,
    outputGroups: [
      {
        id: "overview",
        label: "Overview",
        count: 3,
        description:
          "Both-strand prediction in one plot, plus total sequence effect.",
      },
      {
        id: "motif-activations",
        label: "Motif activations",
        count: 18,
        description: "18 color-coded, nonnegative motif curves in one plot.",
      },
      {
        id: "motif-effects",
        label: "Motif effects",
        count: 18,
        description: "18 solid curves on one shared signed axis.",
      },
      {
        id: "opposite-motif-effects",
        label: "Opposite-strand motif effects",
        count: 18,
        description: "Adds 18 dotted curves to the motif-effect plot.",
      },
      {
        id: "effect-components",
        label: "Effect components",
        count: 7,
        description:
          "Motif, initiator, and trinucleotide sums on one shared signed axis.",
      },
      {
        id: "bp-initiation-contributions",
        label: "Base-pair → initiation",
        count: 18,
        description:
          "Signed per-base contributions in the + genomic orientation to Puffin’s forward initiation output. No reverse-attribution output is exported.",
        outputPicker: {
          label: "Choose motif contribution tracks",
          options: puffinAttributionOptions("initiation"),
        },
      },
      {
        id: "bp-motif-contributions",
        label: "Base-pair → motif activation",
        count: 18,
        description:
          "Signed per-base contributions to reference-orientation motif activation. No reverse-attribution output is exported.",
        outputPicker: {
          label: "Choose motif activation tracks",
          options: puffinAttributionOptions("motif"),
        },
      },
    ],
    homepage: "https://puffin.zhoulab.io/",
    featured: true,
    demo: {
      label: "ACTB promoter",
      chr: "chr7",
      centerBp: 5_530_600,
      spanBp: 2_400,
      strand: "-",
    },
  },
  {
    id: "vibe-motifmatch",
    name: "MotifMatch",
    eyebrow: "Sequence motif activity",
    description:
      "Score learned human and mouse motif activity as locally computed signal tracks.",
    assemblyId: "hg38",
    url: "/computational/packs/vibe-motifmatch.czpack",
    outputLabels: ["Human activity 1", "Human activity 2", "Mouse activity 1"],
    availableOutputCount: 3,
  },
] as const;

/**
 * The catalog: the bundled models, then whatever the site extension offers. An
 * extension's entries are part of this list like any other, so a family, its
 * variants and its assets are resolved the same way wherever they came from.
 * The dev extension also carries a toy model that exists to exercise the
 * machinery a bundled model does not reach (ISM rows, checkpoint families, the
 * probability axis); it is not part of what this repository ships.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [...ALL_MODELS, ...siteExtension.catalog];

/**
 * The catalog as a site view lists it: its lead model first, when it has one
 * and the catalog carries it, and every other entry in catalog order.
 */
export function orderCatalogForView(
  models: readonly ModelCatalogEntry[],
  leadModelId?: string,
): readonly ModelCatalogEntry[] {
  const lead = leadModelId ? models.find((model) => model.id === leadModelId) : undefined;
  return lead ? [lead, ...models.filter((model) => model !== lead)] : models;
}

/** Resolve a catalog family to the concrete pack the user selected. */
export function resolveModelVariant(
  model: ModelCatalogEntry,
  variantId?: string | null,
): ModelCatalogEntry {
  if (!model.variants?.length) {
    return model;
  }
  const variant =
    model.variants.find((candidate) => candidate.id === variantId) ??
    model.variants[0];
  return {
    ...model,
    id: variant.id,
    url: variant.url,
  };
}

export function catalogPackIds(model: ModelCatalogEntry): readonly string[] {
  return model.variants?.map((variant) => variant.id) ?? [model.id];
}

/**
 * Catalog family id shared by interchangeable checkpoints.
 *
 * Membership comes from the catalog: an entry that lists `variants` is a family,
 * and a pack belongs to it if the entry or one of its variants has that id.
 * This used to be a test on a name prefix, which any third-party pack could
 * trip by accident and which knew nothing about what was actually in the
 * catalog.
 */
export function catalogFamilyId(modelOrPackId: string): string {
  for (const entry of MODEL_CATALOG) {
    if (entry.id === modelOrPackId) {
      return entry.id;
    }
    if (entry.variants?.some((variant) => variant.id === modelOrPackId)) {
      return entry.id;
    }
  }
  return modelOrPackId;
}

export function isPackInCatalogFamily(familyId: string, packId: string): boolean {
  return catalogFamilyId(packId) === familyId;
}

export function modelOutputLabel(
  packId: string,
  subtrackId: string,
  fallback: string,
): string {
  const catalogEntry =
    MODEL_CATALOG.find((entry) => entry.id === packId) ??
    MODEL_CATALOG.find((entry) =>
      entry.variants?.some((variant) => variant.id === packId),
    );
  const outputIndex =
    packId === "seqbro2-puffin"
      ? [
          "puffin-pred-plus",
          "puffin-pred-minus",
          "puffin-effects-total",
        ].indexOf(subtrackId)
      : packId === "vibe-motifmatch"
          ? [
              "human-celltype-1",
              "human-celltype-2",
              "mouse-celltype-1",
            ].indexOf(subtrackId)
          : -1;

  return outputIndex >= 0
    ? (catalogEntry?.outputLabels[outputIndex] ?? fallback)
    : fallback;
}
