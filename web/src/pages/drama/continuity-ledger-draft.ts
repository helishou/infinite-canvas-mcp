import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";
type Row = Record<string, any>;
const collections = ["facts", "timelines", "initial", "events", "requirements", "coverage"] as const;
const valid = (value: any): value is Row => value?.contract_version === 2 && collections.every(key => Array.isArray(value[key]) && value[key].every((entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)));
export function readContinuityLedgerDraft(raw: string | undefined, source: Row) {
    if (raw) try {
        const draft = JSON.parse(raw);
        if (draft.version !== 1 || !valid(draft.base) || !valid(draft.value)) throw new Error();
        if (!continuityLedgerConflicts(draft.base, draft.value, source).length) return { base: structuredClone(source), value: rebaseContinuityLedger(draft.base, draft.value, source), invalid: false };
        return { base: draft.base as Row, value: draft.value as Row, invalid: false };
    } catch { return { base: structuredClone(source), value: structuredClone(source), invalid: true }; }
    return { base: structuredClone(source), value: structuredClone(source), invalid: false };
}
const entryKey = (collection: string, row: Row) => String(row.id || (collection === "initial" ? `${row.timeline_id}:${row.fact_id}` : ""));
export function continuityLedgerConflicts(base: Row, local: Row, remote: Row): string[] {
    return collections.flatMap(collection => {
        const maps = [base, local, remote].map(ledger => new Map<string, Row>(ledger[collection].map((row: Row) => [entryKey(collection, row), row])));
        return [...new Set(maps.flatMap(map => [...map.keys()]))].flatMap(key => draftFieldConflicts(maps[0].get(key), maps[1].get(key), maps[2].get(key), `${collection}.${key}`));
    });
}
/** Explicit review retains local entry edits while keeping unrelated remote entries and fields. */
export function rebaseContinuityLedger(base: Row, local: Row, remote: Row): Row {
    const result = structuredClone(remote);
    for (const collection of collections) {
        for (const ledger of [base, local, remote]) {
            const keys = ledger[collection].map((row: Row) => entryKey(collection, row));
            if (keys.some((key: string) => !key) || new Set(keys).size !== keys.length) throw new Error("LEDGER_DRAFT_ID_MISSING");
        }
        const old = new Map<string, Row>(base[collection].map((row: Row) => [entryKey(collection, row), row]));
        const edited = new Map<string, Row>(local[collection].map((row: Row) => [entryKey(collection, row), row]));
        const merged = new Map<string, Row>(remote[collection].map((row: Row) => [entryKey(collection, row), row]));
        if ([...old.keys(), ...edited.keys(), ...merged.keys()].some(key => !key)) throw new Error("LEDGER_DRAFT_ID_MISSING");
        for (const [key, row] of old) {
            if (!edited.has(key)) merged.delete(key);
            else if (canonicalProduction(row) !== canonicalProduction(edited.get(key))) {
                const next = mergeDraftFields(row, edited.get(key), merged.get(key) || row);
                merged.set(key, next);
            }
        }
        for (const [key, row] of edited) if (!old.has(key)) merged.set(key, row);
        result[collection] = [...merged.values()];
    }
    return result;
}
