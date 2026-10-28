import { z } from "zod";

const identityFields = ["id", "asset_id", "shot_id", "segment_id", "fact_id", "timeline_id"];
const field = z.string().trim().min(1).refine(value => !["__proto__", "constructor", "prototype"].includes(value) && !/[.\[\]]/.test(value), "fields 只接受顶层字段名，不支持路径或原型字段");
export const productionSourceFieldsSchema = z.array(field).min(1).transform(fields => [...new Set(fields)].sort()).optional()
    .describe("只读指定顶层字段并保留稳定 ID；去重排序，不附带其他正文或画布运行上下文。仅 source 视图配合 sourceSection 使用，部分结果不能整稿覆盖");

export function validateProductionSourceFields(input: { fields?: string[]; view?: string; sourceSection?: string }) {
    if (input.fields && (input.view !== "source" || !input.sourceSection)) throw Object.assign(new Error("fields 必须与 view=source 和明确 sourceSection 一起使用"), { code: "INVALID_INPUT" });
}

export function projectProductionSourceFields(value: unknown, fields: string[], offset = 0) {
    const missingFields: Array<{ targetId?: string; index?: number; fields: string[] }> = [];
    const one = (value: unknown, index?: number) => {
        if (value == null) { missingFields.push({ ...(index === undefined ? {} : { index }), fields }); return value; }
        if (typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("fields 仅支持源稿对象或对象列表；原始内容可省略 fields 读取"), { code: "INVALID_INPUT" });
        const row = value as Record<string, unknown>;
        const missing = fields.filter(key => !Object.hasOwn(row, key) || row[key] === undefined);
        const identity = identityFields.find(key => Object.hasOwn(row, key) && row[key] != null);
        if (missing.length) missingFields.push({ ...(identity ? { targetId: String(row[identity]) } : {}), ...(index === undefined ? {} : { index }), fields: missing });
        return Object.fromEntries([...new Set([...identityFields, ...fields])].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    };
    return { value: Array.isArray(value) ? value.map((row, index) => one(row, offset + index)) : one(value), missingFields };
}

/** A mismatched/old Backend must not silently return full source for a projected request. */
export function assertProductionSourceFields<T>(result: T, input: { fields?: unknown }): T {
    const fields = productionSourceFieldsSchema.parse(input.fields);
    if (!fields) return result;
    const response = result as any;
    const body = response?.production || response?.version?.snapshot || response?.version || response;
    if (body?.partialSource === true && JSON.stringify(body.sourceFields) === JSON.stringify(fields)) return result;
    throw Object.assign(new Error("SOURCE_FIELDS_UNSUPPORTED: Backend 未确认字段投影；本次不返回完整源稿。更新 Backend 后再读，或明确省略 fields 使用原读取契约。"), { code: "SOURCE_FIELDS_UNSUPPORTED" });
}
