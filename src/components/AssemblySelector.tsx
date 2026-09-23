type AssemblyOption = {
  id: string;
  label: string;
};

type AssemblySelectorProps = {
  assemblyId: string;
  options: AssemblyOption[];
  onAssemblyChange: (id: string) => void;
  id?: string;
};

export function AssemblySelector({ assemblyId, options, onAssemblyChange, id }: AssemblySelectorProps) {
  const selectId = id ?? 'assembly';

  return (
    <label className="hf-inline-field" htmlFor={selectId}>
      <span className="hf-field-caption">Assembly</span>
      <select id={selectId} value={assemblyId} onChange={(event) => onAssemblyChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
