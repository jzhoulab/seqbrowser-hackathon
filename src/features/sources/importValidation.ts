export type SupportedSourceExtension = 'bw' | 'bigWig' | 'bb' | 'bigBed' | 'czpack';

export type SourceType = 'local' | 'url';

export type SourceImportValidationFailureReason =
  | 'empty-input'
  | 'invalid-url'
  | 'missing-extension'
  | 'unsupported-extension';

export type SourceImportValidationResult =
  | {
      isValid: true;
      sourceType: SourceType;
      extension: SupportedSourceExtension;
    }
  | {
      isValid: false;
      sourceType: SourceType | 'unknown';
      reason: SourceImportValidationFailureReason;
      extension?: string;
    };

const SUPPORTED_EXTENSION_BY_LOWERCASE: Record<string, SupportedSourceExtension> = {
  bw: 'bw',
  bigwig: 'bigWig',
  bb: 'bb',
  bigbed: 'bigBed',
  czpack: 'czpack',
};

function extensionFromPath(pathLike: string): string | null {
  const trimmed = pathLike.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const lastSegment = trimmed.split(/[\\/]/).pop() ?? '';
  if (lastSegment.length === 0) {
    return null;
  }

  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
    return null;
  }

  return lastSegment.slice(dotIndex + 1);
}

function validateExtension(extension: string | null, sourceType: SourceType): SourceImportValidationResult {
  if (extension === null) {
    return {
      isValid: false,
      sourceType,
      reason: 'missing-extension',
    };
  }

  const supportedExtension = SUPPORTED_EXTENSION_BY_LOWERCASE[extension.toLowerCase()];
  if (!supportedExtension) {
    return {
      isValid: false,
      sourceType,
      reason: 'unsupported-extension',
      extension,
    };
  }

  return {
    isValid: true,
    sourceType,
    extension: supportedExtension,
  };
}

export function validateSourceImport(input: string): SourceImportValidationResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      isValid: false,
      sourceType: 'unknown',
      reason: 'empty-input',
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return {
        isValid: false,
        sourceType: 'url',
        reason: 'invalid-url',
      };
    }

    return validateExtension(extensionFromPath(url.pathname), 'url');
  }

  const pathWithoutQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  return validateExtension(extensionFromPath(pathWithoutQuery), 'local');
}
