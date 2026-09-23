export type AssemblyId = 'hg38' | 'hg19' | 'mm10';

export type ChromSizes = Record<string, number>;

export type ChromosomeAliasMap = Record<string, string>;

export type AssemblyDefinition = {
  id: AssemblyId;
  chromSizes: ChromSizes;
  aliasToCanonical: ChromosomeAliasMap;
};
