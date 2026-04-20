import type { Context } from "hono";
export interface Bindings {
	/** R2 bucket holding the pre-built DB snapshot (optional). */
	MCP_DB_SNAPSHOTS?: R2Bucket;
}
export type AppContext = Context<{ Bindings: Bindings }>;
