import type { WorkflowField } from "@/types/workflow";
import { workflowDisplayGraph } from "./workflow-source";

/**
 * 扫描节点图，把媒体加载节点（LoadImage / LoadAudio / LoadVideo 系列）自动转成媒体字段。
 * 本地 ComfyUI 导入不会自动识别字段，手动逐个点节点很繁琐；这个函数让「运行页签空白」
 * 的工作流一键补齐参考图/视频/音频输入，从而也能用上媒体拖拽重排。
 * 只产出媒体字段，文本/Prompt 等仍由用户按节点手动勾选，避免噪声。
 */
export function suggestMediaFields(source: unknown): WorkflowField[] {
    const graph = workflowDisplayGraph(source as Record<string, unknown>);
    const counters = { image: 0, video: 0, audio: 0 };
    const fields: WorkflowField[] = [];
    for (const [nodeId, node] of Object.entries(graph)) {
        const classType = String((node as { class_type?: unknown }).class_type || "");
        let type: WorkflowField["type"] | null = null;
        let inputKey = "";
        if (classType === "LoadImage") { type = "image"; inputKey = "image"; }
        else if (classType === "LoadAudio") { type = "audio"; inputKey = "audio"; }
        else if (/(?:^|_)LoadVideo/.test(classType)) { type = "video"; inputKey = "video"; }
        if (!type) continue;
        counters[type as "image" | "video" | "audio"] += 1;
        const label =
            type === "image" ? `参考图 ${counters.image}`
            : type === "video" ? `参考视频 ${counters.video}`
            : `参考音频 ${counters.audio}`;
        fields.push({
            id: `f_auto_${nodeId}_${inputKey}`,
            node: nodeId,
            input: inputKey,
            name: label,
            type,
            default: undefined,
        });
    }
    return fields;
}

/** 把建议字段合并进现有字段，按 node::input 去重；返回新增数量与合并后数组。 */
export function mergeSuggestedFields(existing: WorkflowField[], suggested: WorkflowField[]): { fields: WorkflowField[]; added: number } {
    const seen = new Set(existing.map((f) => `${f.node}::${f.input}`));
    const added = suggested.filter((f) => !seen.has(`${f.node}::${f.input}`));
    return { fields: [...existing, ...added], added: added.length };
}
