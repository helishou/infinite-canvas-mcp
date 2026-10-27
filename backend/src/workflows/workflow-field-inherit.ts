/**
 * 从 RunningHub 下载本地副本时的字段合并规则。
 *
 * 上传只带节点图，云端档案的字段是平台自动发现的；下载回来若直接用那批字段，
 * 用户在本地改过的名称、类型、默认值、提示词标记就全没了。
 * 所以：以「同一云端档案对应的本地工作流」配置为准，云端新发现、本地没有的字段追加在后面。
 *
 * 配对键用 `node::input`（云端与本地都来自同一份 ComfyUI 工作流，节点 id 和输入名一致），
 * 不用 field.id —— 本地字段 id 可能是用户自定的，跨副本不稳定。
 */
import type { WorkflowField } from "../db.js";

export function workflowFieldKey(field: WorkflowField): string {
    return `${String(field.node || "")}::${String(field.input || "")}`;
}

export function mergeInheritedFields(inherited: WorkflowField[], discovered: WorkflowField[]): WorkflowField[] {
    const seen = new Set(inherited.map(workflowFieldKey));
    return [...inherited, ...discovered.filter((field) => !seen.has(workflowFieldKey(field)))];
}
