import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  catalogPackIds,
  resolveModelVariant,
  type ModelCatalogEntry,
} from '../features/models/catalog';

export type ModelActionPhase = 'preparing' | 'failed';

export type ModelActionState = {
  modelId: string;
  phase: ModelActionPhase;
  message?: string;
} | null;

export type ModelOutputGroupState = {
  modelId: string;
  groupId: string;
  shown: number;
  total: number;
  shownIds: readonly string[];
};

export type ModelsPanelProps = {
  models: readonly ModelCatalogEntry[];
  focusPackId?: string;
  installedModelIds: readonly string[];
  activeAssemblyId: string;
  actionState: ModelActionState;
  outputGroupStates?: readonly ModelOutputGroupState[];
  advancedError?: string;
  onTryDemo: (model: ModelCatalogEntry) => void;
  onRunHere: (model: ModelCatalogEntry) => void;
  /** Unmount every track of this model family. Present wherever the model is installed. */
  onRemove?: (model: ModelCatalogEntry) => void;
  onSelectCheckpoint?: (model: ModelCatalogEntry) => void;
  onSetOutputGroup?: (modelId: string, groupId: string, visible: boolean) => void;
  onSetOutput?: (modelId: string, groupId: string, outputId: string, visible: boolean) => void;
  onSubmitPack: (url: string) => void;
  onLocalPack: (file: File) => void;
  onClose: () => void;
};

export function ModelsPanel({
  models,
  focusPackId,
  installedModelIds,
  activeAssemblyId,
  actionState,
  outputGroupStates = [],
  advancedError,
  onTryDemo,
  onRunHere,
  onRemove,
  onSelectCheckpoint,
  onSetOutputGroup,
  onSetOutput,
  onSubmitPack,
  onLocalPack,
  onClose,
}: ModelsPanelProps) {
  const [packUrl, setPackUrl] = useState('');
  const [variantByFamily, setVariantByFamily] = useState<Record<string, string>>({});
  const focusedModelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusPackId) return;
    // The containing dialog opens after this panel mounts.
    const timer = window.setTimeout(() => focusedModelRef.current?.scrollIntoView?.({ block: 'start' }), 0);
    return () => window.clearTimeout(timer);
  }, [focusPackId]);
  const installed = useMemo(() => new Set(installedModelIds), [installedModelIds]);
  const isPreparingAnyModel = actionState?.phase === 'preparing';

  const handleAdvancedSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = packUrl.trim();
    if (trimmed) {
      onSubmitPack(trimmed);
    }
  };

  const handleLocalChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onLocalPack(file);
    }
    event.target.value = '';
  };

  return (
    <section id="model-library-panel" className="hf-models-panel" aria-label="Sequence models">
      <header className="hf-models-panel__header">
        <div>
          <p className="hf-models-panel__eyebrow">Compute on the sequence in view</p>
          <h2>Sequence models</h2>
          <p className="hf-models-panel__intro">
            Add predictions and signed base-pair attributions as ordinary genome tracks. Window sizing, model preparation,
            and caching happen locally.
          </p>
        </div>
        <button className="hf-models-panel__close" type="button" onClick={onClose} aria-label="Close sequence models">
          ×
        </button>
      </header>

      <div className="hf-model-library">
        {models.map((model) => {
          const packIds = catalogPackIds(model);
          const selectedPackId =
            (model.variants?.length
              ? variantByFamily[model.id] ??
                packIds.find((packId) => installed.has(packId)) ??
                model.variants[0]?.id
              : model.id) ?? model.id;
          const resolved = resolveModelVariant(model, selectedPackId);
          const familyInstalled = packIds.some((packId) => installed.has(packId));
          const mountedPackId = packIds.find((packId) => installed.has(packId)) ?? selectedPackId;
          const isPreparing = actionState?.modelId === selectedPackId && actionState.phase === 'preparing';
          const failure =
            actionState?.modelId === selectedPackId && actionState.phase === 'failed'
              ? actionState.message
              : null;
          const switchesAssembly = activeAssemblyId !== model.assemblyId;
          const availableOutputCount = model.availableOutputCount ?? model.outputLabels.length;
          const chartOutputCount = model.chartOutputCount ?? availableOutputCount;
          const groupStates = outputGroupStates.filter((group) => packIds.includes(group.modelId));
          const shownOutputCount = groupStates.reduce((sum, group) => sum + group.shown, 0);
          const selectedVariant = model.variants?.find((variant) => variant.id === selectedPackId);

          return (
            <article
              key={model.id}
              ref={focusPackId && packIds.includes(focusPackId) ? focusedModelRef : undefined}
              className={`hf-model-entry${model.featured ? ' featured' : ''}`}
              data-model-id={model.id}
              data-pack-id={selectedPackId}
            >
              <div className="hf-model-entry__topline">
                <span className="hf-model-entry__eyebrow">{model.eyebrow}</span>
                {familyInstalled ? <span className="hf-model-entry__installed">Added</span> : null}
              </div>
              <div className="hf-model-entry__heading">
                <h3>{model.name}</h3>
                {model.homepage ? (
                  <a href={model.homepage} target="_blank" rel="noreferrer" aria-label={`Open ${model.name} homepage`}>
                    About ↗
                  </a>
                ) : null}
              </div>
              <p className="hf-model-entry__description">{model.description}</p>
              <div className="hf-model-entry__meta" aria-label={`${model.name} compatibility`}>
                <span>{model.assemblyId}</span>
                <span>{availableOutputCount} genomic outputs</span>
                {model.attributionChannelCount ? (
                  <span>
                    {chartOutputCount} chart · {model.attributionChannelCount} base-pair attribution
                  </span>
                ) : null}
                <span>Runs in this browser</span>
              </div>

              {model.variants && model.variants.length > 1 ? (
                <label className="hf-model-variant">
                  <span>Checkpoint</span>
                  <select
                    aria-label={`${model.name} checkpoint`}
                    value={selectedPackId}
                    disabled={isPreparingAnyModel}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      setVariantByFamily((previous) => ({ ...previous, [model.id]: nextId }));
                      const next = resolveModelVariant(model, nextId);
                      (onSelectCheckpoint ?? onRunHere)(next);
                    }}
                  >
                    {model.variants.map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {variant.label}
                      </option>
                    ))}
                  </select>
                  {selectedVariant?.detail ? (
                    <small className="hf-model-variant__detail">{selectedVariant.detail}</small>
                  ) : null}
                </label>
              ) : null}

              {model.outputGroups ? (
                <details className="hf-model-output-collections">
                  <summary>
                    {familyInstalled ? `${shownOutputCount} outputs shown · ` : `${model.outputLabels.length}-output overview · `}
                    {availableOutputCount} available
                  </summary>
                  <p className="hf-model-output-collections__note">
                    Chart collections share one color-coded plot and one honest y-axis. Opposite-strand curves are dotted.
                    {model.attributionChannelCount
                      ? ` ${model.attributionChannelCount} verified attribution outputs can be added individually as signed sequence-height tracks.`
                      : ''}
                  </p>
                  <ul aria-label={`${model.name} output collections`}>
                    {model.outputGroups.map((group) => {
                      const state = groupStates.find((candidate) => candidate.groupId === group.id);
                      const shown = state?.shown ?? (group.id === 'overview' ? group.count : 0);
                      const shownIds = new Set(state?.shownIds ?? []);
                      // The mounted checkpoint decides how many outputs a group
                      // really has (the branchpoint pack carries three per group).
                      const total = state?.total ?? group.count;
                      const isFullyShown = shown === total;
                      return (
                        <li key={group.id} data-output-group={group.id}>
                          <span>
                            <strong>{group.label}</strong>
                            <small>{group.description}</small>
                          </span>
                          <span className="hf-model-output-collections__count">
                            {shown}/{total}
                          </span>
                          {!group.outputPicker && familyInstalled && onSetOutputGroup ? (
                            <button
                              type="button"
                              onClick={() => onSetOutputGroup(mountedPackId, group.id, !isFullyShown)}
                              disabled={isPreparingAnyModel}
                            >
                              {isFullyShown ? 'Hide' : 'Show'}
                            </button>
                          ) : null}
                          {group.outputPicker && familyInstalled && onSetOutput ? (
                            <details className="hf-model-output-picker">
                              <summary>{group.outputPicker.label}</summary>
                              <div role="group" aria-label={`${group.label} tracks`}>
                                {group.outputPicker.options.map((option) => {
                                  const isShown = shownIds.has(option.id);
                                  return (
                                    <button
                                      key={option.id}
                                      type="button"
                                      aria-pressed={isShown}
                                      aria-label={`${isShown ? 'Hide' : 'Show'} ${option.label} ${group.label}`}
                                      onClick={() =>
                                        onSetOutput(mountedPackId, group.id, option.id, !isShown)
                                      }
                                      disabled={isPreparingAnyModel}
                                    >
                                      <span aria-hidden="true" style={{ color: option.color }}>
                                        ●
                                      </span>{' '}
                                      {isShown ? 'Hide' : 'Show'} {option.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </details>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : (
                <ul className="hf-model-entry__outputs" aria-label={`${model.name} outputs`}>
                  {model.outputLabels.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              )}

              {isPreparing ? (
                <p className="hf-model-entry__status preparing" role="status" aria-live="polite">
                  Preparing {model.name} for this device…
                </p>
              ) : null}
              {failure ? (
                <div className="hf-model-entry__error" role="alert">
                  <span>{failure}</span>
                  <button type="button" onClick={() => onRunHere(resolved)}>
                    Retry
                  </button>
                </div>
              ) : null}

              <div className="hf-model-entry__actions">
                {model.demo ? (
                  <button
                    className="hf-model-action primary"
                    type="button"
                    onClick={() => onTryDemo(resolved)}
                    disabled={isPreparingAnyModel}
                  >
                    {isPreparing ? 'Preparing…' : `Try ${model.name} demo`}
                  </button>
                ) : null}
                <button
                  className="hf-model-action secondary"
                  type="button"
                  onClick={() => onRunHere(resolved)}
                  disabled={isPreparingAnyModel}
                >
                  {familyInstalled
                    ? 'Fit model window'
                    : switchesAssembly
                      ? `Switch to ${model.assemblyId} & run`
                      : 'Run at current locus'}
                </button>
                {familyInstalled && onRemove ? (
                  <button
                    className="hf-model-action secondary hf-model-action--remove"
                    type="button"
                    aria-label={`Remove ${model.name}`}
                    onClick={() => onRemove(resolved)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {model.demo ? <p className="hf-model-entry__demo-note">Demo locus · {model.demo.label}</p> : null}
            </article>
          );
        })}
      </div>

      <details className="hf-runtime-details">
        <summary>Add another model</summary>
        <p>Use a hosted computational pack. Local manifests are experimental and may require an absolute model URL.</p>
        <form className="hf-model-pack-form" onSubmit={handleAdvancedSubmit}>
          <label htmlFor="model-pack-url">Model pack URL or path</label>
          <div>
            <input
              id="model-pack-url"
              type="text"
              value={packUrl}
              onChange={(event) => setPackUrl(event.target.value)}
              placeholder="https://example.org/model.czpack"
            />
            <button type="submit">Add model</button>
          </div>
        </form>
        <label className="hf-local-file-field" htmlFor="model-pack-file">
          Local .czpack
          <input id="model-pack-file" type="file" accept=".czpack,.CZPACK" onChange={handleLocalChange} />
        </label>
        {advancedError ? <p className="source-import-error" role="alert">{advancedError}</p> : null}
      </details>
    </section>
  );
}

export default ModelsPanel;
