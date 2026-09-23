import { fromDisplayPosition } from '../../lib/genomeMath';

export interface JumpLocus {
  chr: string;
  /** Internal: 0-based, half-open. What a person types is 1-based inclusive. */
  start: number;
  end: number;
  bpPerPx?: number;
}

export interface ParseJumpLocusOptions {
  fallbackChr?: string;
}

const INTEGER_TOKEN_RE = /^\d[\d,]*$/;
const BP_PER_PX_TOKEN_RE = /^(?:\d+\.?\d*|\.\d+)$/;

function parseIntegerToken(token: string): number | null {
  if (!INTEGER_TOKEN_RE.test(token)) {
    return null;
  }

  const value = Number.parseInt(token.replaceAll(',', ''), 10);
  return Number.isFinite(value) ? value : null;
}

function parseBpPerPxToken(token: string): number | null {
  if (!BP_PER_PX_TOKEN_RE.test(token)) {
    return null;
  }

  const value = Number.parseFloat(token);
  return value > 0 ? value : null;
}

export function parseJumpLocus(input: string, options: ParseJumpLocusOptions = {}): JumpLocus | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }

  let chr: string | undefined;
  let coordinatePart = raw;

  const colonIndex = raw.indexOf(':');
  if (colonIndex >= 0) {
    chr = raw.slice(0, colonIndex).trim();
    coordinatePart = raw.slice(colonIndex + 1).trim();
  } else {
    chr = options.fallbackChr?.trim();
  }

  if (!chr || coordinatePart.length === 0) {
    return null;
  }

  const atIndex = coordinatePart.indexOf('@');
  const positionPart = atIndex >= 0 ? coordinatePart.slice(0, atIndex).trim() : coordinatePart;
  const bpPerPxToken = atIndex >= 0 ? coordinatePart.slice(atIndex + 1).trim() : undefined;
  if (positionPart.length === 0) {
    return null;
  }

  let start: number;
  let end: number;

  const dashIndex = positionPart.indexOf('-');
  if (dashIndex >= 0) {
    const startToken = positionPart.slice(0, dashIndex).trim();
    const endToken = positionPart.slice(dashIndex + 1).trim();
    const parsedStart = parseIntegerToken(startToken);
    const parsedEnd = parseIntegerToken(endToken);
    if (parsedStart === null || parsedEnd === null) {
      return null;
    }
    // Typed coordinates are 1-based inclusive, as every browser prints them;
    // internally a range is 0-based half-open, so only the start moves.
    start = fromDisplayPosition(Math.min(parsedStart, parsedEnd));
    end = Math.max(parsedStart, parsedEnd);
  } else {
    const parsedPos = parseIntegerToken(positionPart);
    if (parsedPos === null) {
      return null;
    }
    start = fromDisplayPosition(parsedPos);
    end = start;
  }

  let bpPerPx: number | undefined;
  if (bpPerPxToken !== undefined) {
    if (bpPerPxToken.length === 0) {
      return null;
    }

    const parsedBpPerPx = parseBpPerPxToken(bpPerPxToken);
    if (parsedBpPerPx === null) {
      return null;
    }
    bpPerPx = parsedBpPerPx;
  }

  return bpPerPx !== undefined ? { chr, start, end, bpPerPx } : { chr, start, end };
}
