import type { ProductionPreflight } from "./production-contract.js";
import { productionOwnerPath } from "./production-owner.js";
import { migrateToolGuidance } from "../canvas/tool-migrations.js";

/** Shared by HTTP MCP and the embedded Agent; a blocked preflight never submits media. */
export function productionToolPreflightRequest(name: string, input: Record<string, unknown>) {
    // Compilation preflight runs in its background worker; do not block submission on Python.
    if (name === "production_compile") return undefined;
    if (name === "production_start_run") {
        const { kind, id, ...request } = input;
        const base = productionOwnerPath({ kind: kind as "episode" | "canvas", id: String(id || "") });
        return { path: `${base}/preflight`, body: { action: "generate", request } };
    }
    return undefined;
}

export async function productionToolPreflight(client: { post(path: string, body: unknown): Promise<unknown> }, name: string, input: Record<string, unknown>) {
    const request = productionToolPreflightRequest(name, input);
    if (!request) return undefined;
    const response = await client.post(request.path, request.body) as { preflight?: ProductionPreflight };
    if (typeof response?.preflight?.valid !== "boolean") throw new Error("Backend returned an invalid production preflight response");
    if (response.preflight.valid) return undefined;
    const unavailable = response.preflight.diagnostics.find(item => ["ENGINE_UNAVAILABLE", "COMPILE_PREFLIGHT_UNAVAILABLE"].includes(item.code));
    if (unavailable) throw new Error(`${unavailable.code}: ${unavailable.message}`);
    return migrateToolGuidance({ ok: true, status: "blocked" as const, action: request.body.action, preflight: response.preflight, mediaSubmitted: false, createdTaskIds: [] });
}
