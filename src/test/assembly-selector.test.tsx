import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssemblySelector } from '../components/AssemblySelector';

afterEach(() => {
  cleanup();
});

describe('AssemblySelector', () => {
  it('renders assembly options and current selection', () => {
    render(
      <AssemblySelector
        assemblyId="hg38"
        options={[
          { id: 'hg38', label: 'Human GRCh38' },
          { id: 'mm10', label: 'Mouse GRCm38' },
        ]}
        onAssemblyChange={() => {}}
      />,
    );

    const select = screen.getByLabelText('Assembly') as HTMLSelectElement;
    expect(select.value).toBe('hg38');

    const optionValues = Array.from(select.options).map((option) => option.value);
    const optionLabels = Array.from(select.options).map((option) => option.textContent);

    expect(optionValues).toEqual(['hg38', 'mm10']);
    expect(optionLabels).toEqual(['Human GRCh38', 'Mouse GRCm38']);
  });

  it('calls onAssemblyChange with selected assembly id', () => {
    const onAssemblyChange = vi.fn();

    render(
      <AssemblySelector
        assemblyId="hg38"
        options={[
          { id: 'hg38', label: 'Human GRCh38' },
          { id: 'mm10', label: 'Mouse GRCm38' },
        ]}
        onAssemblyChange={onAssemblyChange}
      />,
    );

    const select = screen.getByLabelText('Assembly') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'mm10' } });

    expect(onAssemblyChange).toHaveBeenCalledTimes(1);
    expect(onAssemblyChange).toHaveBeenCalledWith('mm10');
  });
});
