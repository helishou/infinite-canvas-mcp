import { inputHash } from './canvas-inputs.js';

/** Three-way merge of whole editorial fields; related structures move together. */
export function mergeDirectorInput(current: Record<string, any>, next: Record<string, any>, baseline: Record<string, string> | undefined,
    groups: string[][]) {
    const merged = { ...next }, conflicts: string[] = [], manualFields: string[] = [];
    for (const fields of groups) {
        const manual = fields.some(key => baseline ? baseline[key] !== inputHash(current[key]) : current[key] !== undefined && inputHash(current[key]) !== inputHash(next[key]));
        const equal = fields.every(key => inputHash(current[key]) === inputHash(next[key]));
        if (!manual || equal) continue;
        for (const key of fields) {
            if (Object.hasOwn(current, key)) merged[key] = current[key]; else delete merged[key];
            manualFields.push(key);
        }
        if (!baseline || fields.some(key => baseline[key] !== inputHash(next[key]))) conflicts.push(...fields);
    }
    return { merged, conflicts, manualFields };
}

export function adoptedDirectorFields(current: Record<string, any>, projection: Record<string, any>, requested: string[]) {
    const next = projection.nextValues;
    if (!next) throw new Error('当前没有可采用的导演版本');
    const groups: string[][] = projection.fieldGroups || Object.keys(next).map(key => [key]);
    const allowed = new Set(groups.flat());
    if (!requested.length || requested.some(field => !allowed.has(field))) throw new Error('采用字段不在导演输入范围内');
    const fields = [...new Set(groups.filter(group => group.some(key => requested.includes(key))).flat())];
    const patch = Object.fromEntries(fields.filter(key => Object.hasOwn(next, key)).map(key => [key, next[key]]));
    const patchDelete = fields.filter(key => !Object.hasOwn(next, key) && Object.hasOwn(current, key));
    return { patch, patchDelete };
}
