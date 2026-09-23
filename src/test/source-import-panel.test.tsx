import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SourceImportPanel } from '../components/SourceImportPanel';

describe('SourceImportPanel', () => {
  afterEach(cleanup);

  it('accepts ordinary data URLs and app-relative paths', async () => {
    const onSubmitSource = vi.fn().mockResolvedValue(true);
    render(<SourceImportPanel onSubmitSource={onSubmitSource} />);

    const input = screen.getByRole('textbox', { name: /remote url or app-relative path/i });
    const add = screen.getByRole('button', { name: /add track/i });

    fireEvent.change(input, { target: { value: 'https://example.org/tracks/signal.bw' } });
    fireEvent.click(add);
    await waitFor(() => expect(onSubmitSource).toHaveBeenNthCalledWith(1, 'https://example.org/tracks/signal.bw'));

    fireEvent.change(input, { target: { value: './tracks/annotation.bigBed' } });
    fireEvent.click(add);
    await waitFor(() => expect(onSubmitSource).toHaveBeenNthCalledWith(2, './tracks/annotation.bigBed'));
  });

  it('shows actionable validation and routes model packs to Models', () => {
    const onSubmitSource = vi.fn();
    render(<SourceImportPanel onSubmitSource={onSubmitSource} />);

    const input = screen.getByRole('textbox', { name: /remote url or app-relative path/i });
    const add = screen.getByRole('button', { name: /add track/i });

    fireEvent.change(input, { target: { value: 'tracks/signal.bam' } });
    fireEvent.click(add);
    expect(screen.getByRole('alert').textContent).toMatch(/bigwig and bigbed/i);

    fireEvent.change(input, { target: { value: 'models/puffin.czpack' } });
    fireEvent.click(add);
    expect(screen.getByRole('alert').textContent).toMatch(/from models/i);
    expect(onSubmitSource).not.toHaveBeenCalled();
  });

  it('trims successful input and clears it after the import resolves', async () => {
    const onSubmitSource = vi.fn().mockResolvedValue(true);
    render(<SourceImportPanel onSubmitSource={onSubmitSource} />);

    const input = screen.getByRole('textbox', { name: /remote url or app-relative path/i }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  ./tracks/annotation.bigWig  ' } });
    fireEvent.click(screen.getByRole('button', { name: /add track/i }));

    await waitFor(() => expect(onSubmitSource).toHaveBeenCalledWith('./tracks/annotation.bigWig'));
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('passes multiple local files in one selection', async () => {
    const onLocalFiles = vi.fn().mockResolvedValue(true);
    render(<SourceImportPanel onSubmitSource={() => {}} onLocalFiles={onLocalFiles} />);

    const first = new File(['a'], 'signal.bw');
    const second = new File(['b'], 'peaks.bigBed');
    fireEvent.change(screen.getByLabelText('Choose local data track files'), {
      target: { files: [first, second] },
    });

    await waitFor(() => expect(onLocalFiles).toHaveBeenCalledWith([first, second]));
  });

  it('shows the loaded-source ledger and opens Tracks for styling', () => {
    const onOpenTracks = vi.fn();
    render(
      <SourceImportPanel
        onSubmitSource={() => {}}
        onOpenTracks={onOpenTracks}
        sources={[
          { id: 'a', name: 'Signal A', format: 'BW', source: '/data/a.bw', enabled: true },
          { id: 'b', name: 'Peaks B', format: 'BB', source: '/data/b.bb', enabled: false },
        ]}
      />,
    );

    expect(screen.getByText('Signal A')).toBeDefined();
    expect(screen.getByText('Peaks B')).toBeDefined();
    expect(screen.getByText(/1 shown · 2 total/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /arrange and style tracks/i }));
    expect(onOpenTracks).toHaveBeenCalledTimes(1);
  });
});
