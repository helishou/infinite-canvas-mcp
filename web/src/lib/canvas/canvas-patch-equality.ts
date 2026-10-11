/** Canvas patches contain JSON data. Shared immutable array entries need no serialization. */
export function hasCanvasPatchChanges(before: Record<string, unknown>, patch: Record<string, unknown>) {
    return Object.keys(patch).some((key) => {
        const previous = before[key], next = patch[key];
        if (previous === next) return false;
        if (Array.isArray(previous) && Array.isArray(next)) {
            if (previous.length !== next.length) return true;
            for (let i = 0; i < next.length; i++) {
                // Wrapping preserves JSON array semantics for holes/undefined/non-finite values.
                if (previous[i] !== next[i] && JSON.stringify([previous[i]]) !== JSON.stringify([next[i]])) return true;
            }
            return false;
        }
        return JSON.stringify(previous) !== JSON.stringify(next);
    });
}
