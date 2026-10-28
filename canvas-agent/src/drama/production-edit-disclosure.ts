import { z } from "zod";
import { productionOperationSchema } from "./production-contract.js";
import { productionToolSchemas } from "./production-tools.js";

export const MCP_SCHEMA_MODES = ["full", "compact"] as const;
export type McpSchemaMode = typeof MCP_SCHEMA_MODES[number];
export const DEFAULT_MCP_SCHEMA_MODE: McpSchemaMode = "compact";
export const isMcpSchemaMode = (value: unknown): value is McpSchemaMode => typeof value === "string" && (MCP_SCHEMA_MODES as readonly string[]).includes(value);

/** Disclosure only: every submission still passes productionToolSchemas.production_edit. */
function discloseField(schema: z.ZodTypeAny): z.ZodTypeAny {
    let result: z.ZodTypeAny;
    if (schema instanceof z.ZodOptional) result = discloseField(schema.unwrap()).optional();
    else if (schema instanceof z.ZodNullable) result = discloseField(schema.unwrap()).nullable();
    else if (schema instanceof z.ZodDefault) result = new z.ZodDefault({ ...schema._def, innerType: discloseField(schema.removeDefault()) });
    else if (schema instanceof z.ZodEffects) result = discloseField(schema.innerType());
    else if (schema instanceof z.ZodObject || schema instanceof z.ZodRecord) result = z.object({}).passthrough();
    else if (schema instanceof z.ZodArray) result = new z.ZodArray({ ...schema._def, type: discloseField(schema.element) });
    else result = schema;
    return schema.description ? result.describe(schema.description) : result;
}

const operationShapes = productionOperationSchema.options.map(operation => operation.extend(Object.fromEntries(
    Object.entries(operation.shape).map(([field, schema]) => [field, discloseField(schema as z.ZodTypeAny)]),
)));
const operations = z.discriminatedUnion("type", operationShapes as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]]);

export const compactProductionEditSchema = productionToolSchemas.production_edit.extend({
    ops: new z.ZodArray({ ...productionToolSchemas.production_edit.shape.ops._def, type: operations }),
});

export const COMPACT_EDIT_DESCRIPTION = "精简声明：以 kind/id、operationId/expectedRevision 原子编辑制作稿。操作名、必填字段与标量约束在此声明；嵌套对象及对象数组只声明容器形状，提交仍执行原完整严格校验。复杂操作详情未知时用 production_get_contract(operationType) 按需查询，patch_director_source 可附 includePatchFields；同引擎与合同版本已读信息直接复用。结果未知沿原 operationId 恢复，不新增预检或媒体授权。";

export function compactEditOperationForIssue(input: Record<string, unknown>, path: Array<string | number>): string | undefined {
    if (path[0] !== "ops" || typeof path[1] !== "number" || path.length < 3 || !Array.isArray(input.ops)) return;
    const type = input.ops[path[1]]?.type;
    return typeof type === "string" && productionOperationSchema.optionsMap.has(type) ? type : undefined;
}
