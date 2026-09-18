import type { BackendDatabase } from "../db.js";
import type { McpObservabilityStore } from "./types.js";

export function createMcpObservabilityStore(db: BackendDatabase): McpObservabilityStore {
    return {
        record: (input) => db.createMcpObservabilityEvent(input),
        trace: (traceId) => db.listMcpObservabilityEvents(traceId),
        report: () => db.getMcpObservabilityReport(),
    };
}
