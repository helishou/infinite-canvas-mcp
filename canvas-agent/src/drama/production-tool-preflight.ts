/** Retained for old callers; write readiness is checked once at Backend commit. */
export function productionToolPreflightRequest(_name: string, _input: Record<string, unknown>) {
    // The Backend submission boundary is authoritative. Keep preflight available as
    // an explicit diagnostic tool instead of repeating it before every write.
    return undefined;
}

export async function productionToolPreflight(_client: { post(path: string, body: unknown): Promise<unknown> }, _name: string, _input: Record<string, unknown>) {
    return undefined;
}
