import type { BackendDatabase } from "../db.js";
import type { McpObservabilityReportOptions, McpObservabilityStore } from "./types.js";

export function createMcpObservabilityStore(db: BackendDatabase): McpObservabilityStore {
    return {
        record: (input) => db.createMcpObservabilityEvent(input),
        trace: (traceId) => db.listMcpObservabilityEvents(traceId),
        report: (options) => db.getMcpObservabilityReport(options),
        optimizationMarkers: () => db.listMcpOptimizationMarkers(),
        saveOptimizationMarker: (input) => db.saveMcpOptimizationMarker(input as { at?: string; label?: string }),
        deleteOptimizationMarker: (id) => db.deleteMcpOptimizationMarker(id),
    };
}
