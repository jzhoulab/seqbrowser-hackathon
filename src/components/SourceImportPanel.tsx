import { useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { validateSourceImport } from '../features/sources/importValidation';

export type DataSourcePanelItem = {
  id: string;
  name: string;
  format: 'BW' | 'BB' | 'DATA';
  source: string;
  enabled: boolean;
};

export type SourceImportPanelProps = {
  onSubmitSource: (input: string) => boolean | void | Promise<boolean | void>;
  onLocalFiles?: (files: File[]) => boolean | void | Promise<boolean | void>;
  onOpenTracks?: () => void;
  onClose?: () => void;
  sources?: DataSourcePanelItem[];
  lastError?: string;
};

function messageForInvalidInput(input: string): string {
  const validation = validateSourceImport(input);

  if (validation.isValid) {
    return validation.extension === 'czpack'
      ? 'Add .czpack sequence models from Models, not Data.'
      : '';
  }

  switch (validation.reason) {
    case 'empty-input':
      return 'Enter a remote URL or app-relative path.';
    case 'invalid-url':
      return 'Enter a valid URL starting with http:// or https://.';
    case 'missing-extension':
      return 'Data tracks must end in .bw, .bigWig, .bb, or .bigBed.';
    case 'unsupported-extension': {
      const extension = validation.extension ?? 'unknown';
      return `Unsupported extension "${extension}". Data accepts BigWig and BigBed tracks.`;
    }
    default:
      return 'This data source cannot be added.';
  }
}

function compactSourceLabel(source: string): string {
  if (source.startsWith('blob:')) {
    return 'Local file';
  }
  try {
    const url = new URL(source, window.location.href);
    return url.origin === window.location.origin ? url.pathname : `${url.host}${url.pathname}`;
  } catch {
    return source;
  }
}

export function SourceImportPanel({
  onSubmitSource,
  onLocalFiles,
  onOpenTracks,
  onClose,
  sources = [],
  lastError,
}: SourceImportPanelProps) {
  const [input, setInput] = useState('');
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [isAddingFiles, setIsAddingFiles] = useState(false);

  const visibleError = useMemo(() => validationMessage ?? lastError ?? null, [lastError, validationMessage]);
  const shownCount = sources.filter((source) => source.enabled).length;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedInput = input.trim();
    const message = messageForInvalidInput(trimmedInput);
    if (message) {
      setValidationMessage(message);
      return;
    }

    setValidationMessage(null);
    setIsAddingUrl(true);
    try {
      const succeeded = await onSubmitSource(trimmedInput);
      if (succeeded !== false) {
        setInput('');
      }
    } finally {
      setIsAddingUrl(false);
    }
  };

  const handleLocalFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0 || !onLocalFiles) {
      return;
    }

    setValidationMessage(null);
    setIsAddingFiles(true);
    try {
      await onLocalFiles(files);
    } finally {
      setIsAddingFiles(false);
      event.target.value = '';
    }
  };

  return (
    <section className="hf-data-panel" id="data-sources-panel" aria-labelledby="data-panel-title">
      <header className="hf-workspace-panel-header hf-data-panel__header">
        <div>
          <p className="hf-workspace-panel-eyebrow">Genomic data</p>
          <h2 id="data-panel-title">Data sources</h2>
          <p>Add measurements and annotations beside model output.</p>
        </div>
        {onClose ? (
          <button className="hf-workspace-panel-close" type="button" onClick={onClose} aria-label="Close Data sources">
            ×
          </button>
        ) : null}
      </header>

      <div className="hf-data-panel__body">
        <section className="hf-data-source-card local" aria-labelledby="local-data-title">
          <div className="hf-data-source-card__number" aria-hidden="true">01</div>
          <div className="hf-data-source-card__content">
            <h3 id="local-data-title">From this device</h3>
            <p>Open one or several indexed tracks without uploading them.</p>
            <label className={`hf-local-data-picker${isAddingFiles ? ' loading' : ''}`}>
              <span>{isAddingFiles ? 'Adding files…' : 'Choose BigWig or BigBed files'}</span>
              <input
                type="file"
                accept=".bw,.bigWig,.bb,.bigBed,.BIGWIG,.BIGBED"
                multiple
                disabled={isAddingFiles || !onLocalFiles}
                onChange={(event) => void handleLocalFiles(event)}
                aria-label="Choose local data track files"
              />
            </label>
          </div>
        </section>

        <section className="hf-data-source-card remote" aria-labelledby="remote-data-title">
          <div className="hf-data-source-card__number" aria-hidden="true">02</div>
          <div className="hf-data-source-card__content">
            <h3 id="remote-data-title">From a URL</h3>
            <p>Remote servers must allow CORS and HTTP byte-range requests.</p>
            <form className="source-import-form" onSubmit={(event) => void handleSubmit(event)}>
              <label className="source-import-label" htmlFor="source-import-input">
                Remote URL or app-relative path
              </label>
              <div className="source-import-row">
                <input
                  id="source-import-input"
                  type="text"
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                    setValidationMessage(null);
                  }}
                  placeholder="https://host.org/signal.bigWig"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button type="submit" disabled={isAddingUrl}>
                  {isAddingUrl ? 'Checking…' : 'Add track'}
                </button>
              </div>
            </form>
          </div>
        </section>

        {visibleError ? (
          <p className="source-import-error" role="alert" aria-live="polite">
            {visibleError}
          </p>
        ) : null}

        <section className="hf-data-ledger" aria-labelledby="loaded-data-title">
          <div className="hf-data-ledger__header">
            <div>
              <p className="hf-workspace-panel-eyebrow">Current workspace</p>
              <h3 id="loaded-data-title">Loaded data</h3>
            </div>
            <span>{shownCount} shown · {sources.length} total</span>
          </div>

          {sources.length > 0 ? (
            <ul className="hf-data-ledger__list">
              {sources.slice(0, 8).map((source) => (
                <li key={source.id}>
                  <span className={`hf-data-format ${source.format.toLowerCase()}`}>{source.format}</span>
                  <span className="hf-data-ledger__identity">
                    <strong>{source.name}</strong>
                    <span title={source.source}>{compactSourceLabel(source.source)}</span>
                  </span>
                  <span className={`hf-data-ledger__state${source.enabled ? ' shown' : ''}`}>
                    {source.enabled ? 'Shown' : 'Hidden'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hf-data-ledger__empty">Add a BigWig signal or BigBed annotation to start comparing data.</p>
          )}

          {sources.length > 8 ? <p className="hf-data-ledger__more">+{sources.length - 8} more sources</p> : null}
          {onOpenTracks && sources.length > 0 ? (
            <button className="hf-data-ledger__manage" type="button" onClick={onOpenTracks}>
              Arrange and style tracks
            </button>
          ) : null}
        </section>
      </div>
    </section>
  );
}

export default SourceImportPanel;
