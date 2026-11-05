/**
 * MCP 工具参数在传输层的损坏修复。
 *
 * 宿主把模型输出流拼装成工具参数 JSON 时，长中文、大嵌套、单条很大的参数会偶发被
 * 截断后重拼：同一个 ops 数组被整体复制多份，或者某个 op 的 `type` 在重拼时被吞掉
 * （同一参数重试时好时坏，说明不是 schema 问题）。schema 只能把它拦下来，修不回来。
 *
 * 这里只做两种可以无损判定的修复，且都在 schema 校验之前：
 *  1. 数组里逐字相同的对象只保留第一次——同一批写操作重复提交本身是幂等的；
 *  2. 少了 `type` 的对象，只有当数组里存在「除 type 外完全相同」的兄弟条目时按兄弟补回。
 * 任何推断不出唯一答案的情况一律原样放过，交给校验继续报错，绝不猜一个 type 写库。
 */

/** 递归深度上限：参数是 JSON，超过说明形状异常，不再深入。 */
const MAX_DEPTH = 24;

export type McpArgumentRepairs = {
    /** 被折叠掉的重复对象条目数。 */
    duplicateEntries: number;
    /** 按兄弟条目补回的 type 数。 */
    restoredTypes: number;
    /** 发生过修复的路径，用于日志与观测定位。 */
    paths: string[];
};

export type McpArgumentRepairResult<T> = {
    input: T;
    repairs: McpArgumentRepairs;
    /** 是否真的改动过参数；没有改动时返回原对象引用。 */
    changed: boolean;
};

export function repairMcpToolArguments<T>(input: T): McpArgumentRepairResult<T> {
    const repairs: McpArgumentRepairs = { duplicateEntries: 0, restoredTypes: 0, paths: [] };
    const value = visit(input, "", 0, repairs);
    return { input: value as T, repairs, changed: repairs.paths.length > 0 };
}

function visit(value: unknown, path: string, depth: number, repairs: McpArgumentRepairs): unknown {
    if (depth > MAX_DEPTH || !value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        let changed = false;
        const items = value.map((item, index) => {
            const child = visit(item, `${path}[${index}]`, depth + 1, repairs);
            if (child !== item) changed = true;
            return child;
        });
        const repaired = repairObjectEntries(items, path, repairs);
        return repaired === items && !changed ? value : repaired;
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const child = visit(item, path ? `${path}.${key}` : key, depth + 1, repairs);
        if (child !== item) changed = true;
        next[key] = child;
    }
    return changed ? next : value;
}

/** 只在「整数组都是对象」时动手：字符串数组的重复可能是真实内容（同一句台词重复出现）。 */
function repairObjectEntries(items: unknown[], path: string, repairs: McpArgumentRepairs): unknown[] {
    if (items.length < 2 || !items.every(isPlainObject)) return items;
    const restored = restoreMissingTypes(items, repairs);
    const kept = dedupeEntries(restored, repairs);
    if (kept.length === items.length && restored.every((item, index) => item === items[index])) return items;
    if (path) repairs.paths.push(path);
    return kept;
}

/** 丢了 type 的对象，只在数组里存在唯一「除 type 外完全相同」的兄弟时补回。 */
function restoreMissingTypes(items: Array<Record<string, unknown>>, repairs: McpArgumentRepairs): Array<Record<string, unknown>> {
    const typesBySignature = new Map<string, Set<string>>();
    for (const item of items) {
        const type = typeof item.type === "string" ? item.type.trim() : "";
        if (!type) continue;
        const signature = signatureWithoutType(item);
        const types = typesBySignature.get(signature) || new Set<string>();
        types.add(type);
        typesBySignature.set(signature, types);
    }
    if (!typesBySignature.size) return items;
    return items.map((item) => {
        if (typeof item.type === "string" && item.type.trim()) return item;
        // 显式写了非字符串 type 属于调用方错误，不覆盖。
        if (Object.hasOwn(item, "type")) return item;
        const types = typesBySignature.get(signatureWithoutType(item));
        if (!types || types.size !== 1) return item;
        repairs.restoredTypes++;
        return { ...item, type: [...types][0] };
    });
}

/** 逐字相同的对象只留第一份：同一 op 重复应用在语义上等价于应用一次。 */
function dedupeEntries(items: Array<Record<string, unknown>>, repairs: McpArgumentRepairs): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    const kept: Array<Record<string, unknown>> = [];
    for (const item of items) {
        const signature = stableStringify(item);
        if (seen.has(signature)) {
            repairs.duplicateEntries++;
            continue;
        }
        seen.add(signature);
        kept.push(item);
    }
    return kept.length === items.length ? items : kept;
}

function signatureWithoutType(item: Record<string, unknown>) {
    return stableStringify(Object.fromEntries(Object.entries(item).filter(([key]) => key !== "type")));
}

/** 与键顺序无关的签名：重拼出来的对象键序可能改变，值相同仍是同一条 op。 */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
