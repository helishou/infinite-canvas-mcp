import { WORKFLOW_ROUTE_UNSUPPORTED, type ChannelModel } from "@/stores/use-config-store";
import { exportWorkflowPackage, importWorkflowPackage, type WorkflowPackage } from "./workflows";

export type ModelPackage = {
    format: "infinite-canvas-models";
    version: 1;
    models: ChannelModel[];
    workflows: WorkflowPackage[];
};

const CAPABILITIES = new Set(["image", "video", "text", "audio"]);

export function referencedWorkflowNames(models: ChannelModel[]) {
    const names = new Set<string>();
    for (const model of models) {
        for (const name of model.workflows || []) if (name) names.add(name);
        for (const name of Object.values(model.workflowRouting || {})) {
            if (name && name !== WORKFLOW_ROUTE_UNSUPPORTED) names.add(name);
        }
    }
    return [...names];
}

export async function createModelPackage(models: ChannelModel[]): Promise<ModelPackage> {
    const workflows = await Promise.all(referencedWorkflowNames(models).map(exportWorkflowPackage));
    return { format: "infinite-canvas-models", version: 1, models, workflows };
}

export function parseModelPackage(value: unknown): ModelPackage {
    if (!value || typeof value !== "object") throw new Error("模型包格式不正确");
    const pkg = value as Partial<ModelPackage>;
    if (pkg.format !== "infinite-canvas-models") throw new Error("不是无限画布模型包");
    if (pkg.version !== 1) throw new Error(`不支持的模型包版本：${String(pkg.version)}`);
    if (!Array.isArray(pkg.models) || !pkg.models.length) throw new Error("模型包中没有模型");
    if (!Array.isArray(pkg.workflows)) throw new Error("模型包缺少工作流列表");
    for (const model of pkg.models) {
        if (!model || typeof model !== "object" || typeof model.name !== "string" || !model.name.trim() || !CAPABILITIES.has(model.capability)) {
            throw new Error("模型包包含无效的模型配置");
        }
        if (model.workflows !== undefined && (!Array.isArray(model.workflows) || model.workflows.some((name) => typeof name !== "string"))) {
            throw new Error(`模型「${model.name}」的工作流列表无效`);
        }
        if (model.script !== undefined && typeof model.script !== "string") throw new Error(`模型「${model.name}」的调用脚本无效`);
        if (
            model.workflowRouting !== undefined &&
            (!model.workflowRouting || typeof model.workflowRouting !== "object" || Array.isArray(model.workflowRouting) || Object.values(model.workflowRouting).some((name) => name !== undefined && typeof name !== "string"))
        ) {
            throw new Error(`模型「${model.name}」的工作流路由无效`);
        }
    }
    for (const workflow of pkg.workflows) {
        if (
            !workflow ||
            workflow.format !== "infinite-canvas-workflow" ||
            workflow.version !== 1 ||
            typeof workflow.name !== "string" ||
            !workflow.name.trim() ||
            !workflow.workflow ||
            typeof workflow.workflow !== "object" ||
            !workflow.config ||
            typeof workflow.config.title !== "string" ||
            typeof workflow.config.backend !== "string" ||
            typeof workflow.config.operation !== "string" ||
            typeof workflow.config.description !== "string" ||
            !Array.isArray(workflow.config.fields)
        ) {
            throw new Error("模型包包含无效的工作流");
        }
    }
    const included = new Set(pkg.workflows.map((workflow) => workflow.name));
    const missing = referencedWorkflowNames(pkg.models).filter((name) => !included.has(name));
    if (missing.length) throw new Error(`模型包缺少对应工作流：${missing.join("、")}`);
    return pkg as ModelPackage;
}

export async function restoreModelPackage(pkg: ModelPackage): Promise<ChannelModel[]> {
    const names = new Map<string, string>();
    for (const workflow of pkg.workflows) {
        const result = await importWorkflowPackage(workflow.name, workflow, { exposeModel: false });
        names.set(workflow.name, result.name);
    }
    return pkg.models.map((model) => ({
        ...model,
        workflows: model.workflows?.map((name) => names.get(name) || name),
        workflowRouting: model.workflowRouting
            ? Object.fromEntries(Object.entries(model.workflowRouting).map(([scenario, name]) => [scenario, name ? names.get(name) || name : name]))
            : undefined,
    }));
}
