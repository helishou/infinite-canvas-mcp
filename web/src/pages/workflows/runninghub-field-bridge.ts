// 本地工作流的表单值 → 绑定的云端档案表单值。
//
// 两边字段都来自同一份 ComfyUI 工作流（本地跑的是它，上传到 RunningHub 的也是它），
// 所以按 `node::input` 就能对上：本地字段 node=967/input=filename_prefix，
// 云端字段 nodeId=967/fieldName=filename_prefix。对不上的字段不传，云端沿用档案里的值。
import type { WorkflowField } from "@/types/workflow";
import type { RunningHubWorkflowProfile } from "@/services/api/runninghub";

export function bridgeLocalFormToProfile(
    profile: RunningHubWorkflowProfile,
    fields: WorkflowField[],
    values: Record<string, string>,
): Record<string, string> {
    const pool = new Map<string, string>();
    for (const field of fields) {
        const value = values[field.id];
        if (value === undefined || value === null) continue;
        // 一个本地字段可能映射多个节点（逗号分隔），逐个登记，云端命中任一个都能取到值。
        for (const node of String(field.node || "").split(",").map((item) => item.trim()).filter(Boolean)) {
            pool.set(`${node}::${field.input}`, String(value));
        }
    }

    const form: Record<string, string> = {};
    for (const field of profile.fields || []) {
        if (field.enabled === false) continue;
        const key = `${field.nodeId}::${field.fieldName}`;
        const value = pool.get(key);
        if (value !== undefined) form[field.id || key] = value;
    }
    return form;
}
