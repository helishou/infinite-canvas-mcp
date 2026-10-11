import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
const equal = (a: unknown, b: unknown) => canonicalProduction(a) === canonicalProduction(b);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Arrays are editable units; object fields can merge independently. */
export function draftFieldConflicts(base: unknown, local: unknown, remote: unknown, path = ""): string[] {
    if (equal(base, local) || equal(base, remote) || equal(local, remote)) return [];
    if (object(base) && object(local) && object(remote)) return [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])]
        .flatMap(key => draftFieldConflicts(base[key], local[key], remote[key], path ? `${path}.${key}` : key));
    return [path || "value"];
}

/** Used automatically only without conflicts, or after an explicit keep-my-edit action. */
export function mergeDraftFields(base: unknown, local: unknown, remote: unknown): any {
    if (equal(base, local)) return structuredClone(remote);
    if (object(base) && object(local) && object(remote)) {
        const merged: Record<string, unknown> = {};
        for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
            if (!Object.hasOwn(local, key) && Object.hasOwn(base, key)) continue;
            const value = mergeDraftFields(base[key], local[key], remote[key]);
            if (value !== undefined || Object.hasOwn(local, key) || Object.hasOwn(remote, key)) merged[key] = value;
        }
        return merged;
    }
    return structuredClone(local);
}
