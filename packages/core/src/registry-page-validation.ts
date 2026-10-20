import type {
  GlamaListResponse,
  RegistryListResponse,
} from './types.js';

export function validateOfficialPage(data: unknown): asserts data is RegistryListResponse {
  if (!data || typeof data !== 'object') throw new Error('Registry API: response must be an object');
  const page = data as Partial<RegistryListResponse>;
  if (!Array.isArray(page.servers)) throw new Error('Registry API: servers must be an array');
  if (!page.metadata || typeof page.metadata !== 'object') {
    throw new Error('Registry API: metadata must be an object');
  }
  if (!Number.isInteger(page.metadata.count) || page.metadata.count < 0) {
    throw new Error('Registry API: metadata.count must be a non-negative integer');
  }
  if (page.metadata.count !== page.servers.length) {
    throw new Error(
      `Registry API: metadata.count ${page.metadata.count} does not match ` +
        `${page.servers.length} servers on this page`,
    );
  }
  const cursor = page.metadata.nextCursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new Error('Registry API: metadata.nextCursor must be a string, null, or omitted');
  }
}

export function validateGlamaPage(data: unknown): asserts data is GlamaListResponse {
  if (!data || typeof data !== 'object') throw new Error('Glama API: response must be an object');
  const page = data as Partial<GlamaListResponse>;
  if (!Array.isArray(page.servers)) throw new Error('Glama API: servers must be an array');
  if (!page.pageInfo || typeof page.pageInfo !== 'object') {
    throw new Error('Glama API: pageInfo must be an object');
  }
  if (typeof page.pageInfo.hasNextPage !== 'boolean') {
    throw new Error('Glama API: pageInfo.hasNextPage must be boolean');
  }
  if (
    page.pageInfo.hasNextPage &&
    (typeof page.pageInfo.endCursor !== 'string' || page.pageInfo.endCursor.length === 0)
  ) {
    throw new Error('Glama API: pageInfo.endCursor is required when hasNextPage is true');
  }
}

