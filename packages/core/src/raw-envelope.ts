export const RAW_SOURCE_ORDER = ['official', 'glama'] as const;
export type RawSource = (typeof RAW_SOURCE_ORDER)[number];

/**
 * Sources MCPfinder no longer syncs. Older local catalogs still name them in
 * `sources` (and keep their slice in raw_data); merges drop them so a refresh
 * from a live source rebuilds the row instead of treating it as incomplete.
 */
export const RETIRED_SOURCES: readonly string[] = ['smithery'];

export interface RawEnvelope {
  primarySource: string;
  primary: unknown;
  bySource: Record<string, unknown>;
}

/**
 * Normalize plain payloads plus both legacy and current envelopes in memory.
 * Legacy envelopes duplicated the primary payload under bySource. When both
 * copies exist, bySource wins because it is the copy refreshed by later merges.
 */
export function normalizeRawEnvelope(value: unknown, sourceHint: string): RawEnvelope | null {
  if (isEnvelopeLike(value)) {
    const legacy = value as Record<string, unknown>;
    const declaredPrimarySource = typeof legacy.primarySource === 'string' && legacy.primarySource
      ? legacy.primarySource
      : sourceHint;
    if (!declaredPrimarySource) return null;
    const bySource = { ...(legacy.bySource as Record<string, unknown>) };
    let primary: unknown = legacy.primary ?? null;
    if (Object.prototype.hasOwnProperty.call(bySource, declaredPrimarySource)) {
      primary = bySource[declaredPrimarySource];
      delete bySource[declaredPrimarySource];
    }
    return { primarySource: declaredPrimarySource, primary, bySource };
  }
  if (value === null || value === undefined || !sourceHint) return null;
  return { primarySource: sourceHint, primary: value, bySource: {} };
}

export function parseRawEnvelope(rawData: unknown, sourceHint: string): RawEnvelope | null {
  try {
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    return normalizeRawEnvelope(parsed, sourceHint);
  } catch {
    return null;
  }
}

export function rawPayloadForSource(
  envelope: RawEnvelope,
  source: string,
): unknown | undefined {
  return envelope.primarySource === source ? envelope.primary : envelope.bySource[source];
}

export function rawPayloads(envelope: RawEnvelope): unknown[] {
  return [envelope.primary, ...Object.values(envelope.bySource)];
}

export function mergeRawEnvelope(
  existingRaw: unknown,
  incomingRaw: unknown,
  incomingSource: string,
  existingSource: string,
): RawEnvelope | null {
  let incomingParsed: unknown;
  try {
    incomingParsed = typeof incomingRaw === 'string' ? JSON.parse(incomingRaw) : incomingRaw;
  } catch {
    return null;
  }
  if (incomingParsed === null || incomingParsed === undefined) return null;
  const incomingEnvelope = normalizeRawEnvelope(incomingParsed, incomingSource);
  if (!incomingEnvelope) return null;
  const incomingPayload = rawPayloadForSource(incomingEnvelope, incomingSource);
  // mergeServerData may receive another stored row (for example enrichment).
  // Only the payload belonging to the declared incoming source may be merged;
  // nesting an entire envelope would hide its fields from every consumer.
  if (incomingPayload === null || incomingPayload === undefined) return null;

  const envelope = parseRawEnvelope(existingRaw, existingSource) ?? {
    primarySource: incomingSource,
    primary: incomingPayload,
    bySource: {},
  };
  if (envelope.primarySource === incomingSource) {
    envelope.primary = incomingPayload;
  } else {
    envelope.bySource[incomingSource] = incomingPayload;
  }
  delete envelope.bySource[envelope.primarySource];
  return envelope;
}

function isEnvelopeLike(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'bySource' in value &&
      (value as { bySource?: unknown }).bySource &&
      typeof (value as { bySource?: unknown }).bySource === 'object' &&
      !Array.isArray((value as { bySource?: unknown }).bySource),
  );
}
