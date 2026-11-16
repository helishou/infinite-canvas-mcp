export type CanvasExecutorId =
  | "direct-text"
  | "direct-image"
  | "engine-image"
  | "engine-video"
  | "comfy-workflow"
  | "runninghub-workflow"
  | "h3"
  | "local-style-transfer"
  | "plugin";

export type CanvasModelDeclaration = {
  id: string;
  modes: Array<"text" | "image" | "video" | "audio">;
  inputRoles: string[];
  executor: CanvasExecutorId;
  matches?: (model: string, preset?: string) => boolean;
};

export type CanvasExecutionRequest = {
  mode: "text" | "image" | "video" | "audio";
  model?: string;
  preset?: string;
};

const modelRegistry: CanvasModelDeclaration[] = [
  {
    id: "gpt-image-*",
    modes: ["image"],
    inputRoles: ["prompt", "image"],
    executor: "direct-image",
    matches: (model) => /^gpt-image(?:-|$)/i.test(model),
  },
  {
    id: "local-style-transfer",
    modes: ["image"],
    inputRoles: ["image"],
    executor: "local-style-transfer",
    matches: (model) => /^local-style-transfer$/i.test(model),
  },
];

export function registerCanvasModel(declaration: CanvasModelDeclaration) {
  const index = modelRegistry.findIndex((item) => item.id === declaration.id);
  if (index >= 0) modelRegistry[index] = declaration;
  else modelRegistry.push(declaration);
}

export function listCanvasModels(): CanvasModelDeclaration[] {
  return modelRegistry.map(({ matches: _matches, ...declaration }) => ({
    ...declaration,
  }));
}

/** 统一模型到执行器的唯一分发规则；新增模型只需注册匹配项，不新增 MCP 工具。 */
export function resolveCanvasExecutor(
  request: CanvasExecutionRequest,
  directImageSupports = false,
): CanvasExecutorId {
  const model =
    String(request.model || "")
      .split("::")
      .pop()
      ?.trim() || "";
  const preset = String(request.preset || "").trim();
  for (const declaration of modelRegistry) {
    if (
      !declaration.modes.includes(request.mode) ||
      !declaration.matches?.(model, preset)
    )
      continue;
    if (declaration.executor === "direct-image" && !directImageSupports)
      continue;
    return declaration.executor;
  }
  if (request.mode === "text" && model) return "direct-text";
  if (preset) return "plugin";
  throw new Error(`没有可用的画布执行器：${model || request.mode}`);
}
