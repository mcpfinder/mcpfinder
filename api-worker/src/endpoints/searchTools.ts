import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Bindings } from '../types';

interface ToolSummary {
    id: string;
    name: string;
    description: string;
    url: string;
    tags?: string[];
}

function toSummary(manifest: any): ToolSummary {
    return {
        id: manifest._id,
        name: manifest.name,
        description: manifest.description,
        url: manifest.url,
        tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    };
}

const MAX_SCAN_ITEMS = 5000;
const BATCH_SIZE = 1000;

export const searchTools = async (c: Context<{ Bindings: Bindings }>) => {
    const query = c.req.query('q')?.toLowerCase();
    const tag = c.req.query('tag')?.toLowerCase();
    let limit = parseInt(c.req.query('limit') || '50', 10);
    const HARD_LIMIT = 100;

    if (isNaN(limit) || limit <= 0) {
        limit = 50;
        if (parseInt(c.req.query('limit') || 'ignored', 10) <= 0) {
            throw new HTTPException(400, { message: 'Invalid limit parameter: must be positive' });
        }
    }
    limit = Math.min(limit, HARD_LIMIT);

    try {
        if (!query && !tag) {
            const listResult = await c.env.MCP_TOOLS_KV.list({
                prefix: 'tool:',
                limit,
            });

            const tools = await Promise.all(
                listResult.keys.map((key) => c.env.MCP_TOOLS_KV.get(key.name))
            );

            const results: ToolSummary[] = [];
            for (const manifestJson of tools) {
                if (!manifestJson) continue;
                try {
                    const manifest = JSON.parse(manifestJson as string);
                    results.push(toSummary(manifest));
                    if (results.length >= limit) break;
                } catch { /* skip malformed */ }
            }

            c.header('Cache-Control', 'public, max-age=300');
            return c.json(results);
        }

        const results: (ToolSummary & { score: number })[] = [];
        let cursor: string | undefined;
        let scannedItems = 0;

        const queryWords = query ? query.split(/\s+/).filter(Boolean) : [];

        while (results.length < limit && scannedItems < MAX_SCAN_ITEMS) {
            const listResult = await c.env.MCP_TOOLS_KV.list({
                prefix: 'tool:',
                limit: BATCH_SIZE,
                cursor,
            });

            if (listResult.keys.length === 0) break;

            const batchPromises = listResult.keys.map(async (key) => {
                const manifestJson = await c.env.MCP_TOOLS_KV.get(key.name);
                if (!manifestJson) return null;

                try {
                    const manifest = JSON.parse(manifestJson);
                    let score = 0;
                    let matches = false;

                    if (queryWords.length > 0) {
                        const nameLower = manifest.name?.toLowerCase() || '';
                        const descLower = manifest.description?.toLowerCase() || '';
                        const tagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                        const toolsArray = (manifest.capabilities && Array.isArray(manifest.capabilities))
                            ? manifest.capabilities
                            : (manifest.tools && Array.isArray(manifest.tools))
                                ? manifest.tools
                                : [];
                        const toolDescriptionsLower = toolsArray.map((tool: any) => tool.description?.toLowerCase() || '');

                        queryWords.forEach((word) => {
                            if (nameLower.includes(word)) { score += 3; matches = true; }
                            if (descLower.includes(word)) { score += 1; matches = true; }
                            if (tagsLower.some((t) => t.includes(word))) { score += 2; matches = true; }
                            if (toolDescriptionsLower.some((desc) => desc.includes(word))) { score += 1; matches = true; }
                        });
                    } else {
                        matches = true;
                    }

                    if (tag && matches) {
                        const currentTagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                        if (!currentTagsLower.includes(tag)) matches = false;
                    }

                    return matches ? { ...toSummary(manifest), score } : null;
                } catch (e) {
                    console.error(`Error parsing manifest for key ${key.name}:`, e);
                    return null;
                }
            });

            const batchResults = (await Promise.all(batchPromises))
                .filter((r): r is ToolSummary & { score: number } => r !== null);

            results.push(...batchResults);
            scannedItems += listResult.keys.length;
            cursor = listResult.cursor;

            if (!cursor) break;
        }

        results.sort((a, b) => b.score - a.score);
        const finalResults = results.slice(0, limit).map(({ score, ...summary }) => summary);

        c.header('Cache-Control', 'public, max-age=60');
        return c.json(finalResults);
    } catch (error: any) {
        console.error('Error searching tools:', error);
        throw new HTTPException(500, { message: 'Failed to search tools', cause: error.message });
    }
};
