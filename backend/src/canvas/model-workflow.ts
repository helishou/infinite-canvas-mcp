import { builtinWorkflowName as canvasAgentBuiltinWorkflowName, modelOptionName } from "@basketikun/canvas-agent/model-workflow";

export * from "@basketikun/canvas-agent/model-workflow";

export function builtinWorkflowName(value: string): string {
  // moyou-自动色阶 已迁到引擎（engine-local 渠道），画布不再本地执行。
  return canvasAgentBuiltinWorkflowName(value);
}
