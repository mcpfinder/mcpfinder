import { inspect } from 'node:util';

const SOURCE_LABELS = ['Official', 'Glama'] as const;

function fullReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return inspect(reason, { depth: null, breakLength: Number.POSITIVE_INFINITY });
}

/** Report every rejected registry while preserving the resilient zero count. */
export function reportSyncResults(
  results: PromiseSettledResult<number>[],
  write: (message: string) => unknown = (message) => process.stderr.write(message),
): number[] {
  return results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const label = SOURCE_LABELS[index] ?? `Registry ${index + 1}`;
    write(`[mcpfinder] ${label} sync rejected: ${fullReason(result.reason)}\n`);
    return 0;
  });
}
