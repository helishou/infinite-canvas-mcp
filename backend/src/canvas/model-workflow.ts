import { builtinWorkflowName as canvasAgentBuiltinWorkflowName, modelOptionName } from "@basketikun/canvas-agent/model-workflow";

export * from "@basketikun/canvas-agent/model-workflow";

export function builtinWorkflowName(value: string): string {
  if (/^moyou-自动色阶$/i.test(modelOptionName(value).trim()))
    return "custom/moyou-自动色阶.json";
  return canvasAgentBuiltinWorkflowName(value);
}
