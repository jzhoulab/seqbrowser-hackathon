export type SourceDiagnosticClass =
  | 'cors'
  | 'no-range-support'
  | 'auth'
  | 'not-found'
  | 'unknown';

interface DiagnosticLike {
  message?: unknown;
  status?: unknown;
}

function asDiagnosticLike(input: unknown): DiagnosticLike | null {
  return typeof input === 'object' && input !== null ? (input as DiagnosticLike) : null;
}

function extractMessage(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof Error) {
    return input.message;
  }

  const diagnostic = asDiagnosticLike(input);
  if (diagnostic && typeof diagnostic.message === 'string') {
    return diagnostic.message;
  }

  return '';
}

function extractStatus(input: unknown): number | null {
  const diagnostic = asDiagnosticLike(input);
  if (!diagnostic) {
    return null;
  }

  return typeof diagnostic.status === 'number' ? diagnostic.status : null;
}

export function classifySourceDiagnostic(input: unknown): SourceDiagnosticClass {
  const status = extractStatus(input);
  const message = extractMessage(input).toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    /\bunauth(?:orized|enticated)\b|\bforbidden\b|authentication|authorization/.test(message)
  ) {
    return 'auth';
  }

  if (status === 404 || /\b404\b|\bnot found\b/.test(message)) {
    return 'not-found';
  }

  if (/cors|cross[- ]origin|blocked by cors policy/.test(message)) {
    return 'cors';
  }

  if (/accept-ranges|range requests?|does not support range|range not supported/.test(message)) {
    return 'no-range-support';
  }

  return 'unknown';
}
