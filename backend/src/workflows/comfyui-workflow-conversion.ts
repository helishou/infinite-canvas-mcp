type Row = Record<string, any>;

const UI_NOTE_TYPES = new Set(["Note", "MarkdownNote", "孤海注释", "Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)", "Mute / Bypass (rgthree)"]);
const UI_ROUTING_TYPES = new Set(["Reroute", "SetNode", "GetNode"]);

/** 节点是否被 bypass（mode 4）：不执行，第一个输入透传到第一个输出。 */
function isBypassed(node: Row | null | undefined): boolean {
  return node?.mode === 4;
}

/** 节点是否被禁用/never（mode 2）：完全跳过，不参与执行。 */
function isDisabled(node: Row | null | undefined): boolean {
  return node?.mode === 2;
}

/** 节点是否为路由节点（Reroute 或 bypass），需要透传解析。 */
function isRoutingNode(node: Row | null): boolean {
  if (!node) return false;
  if (UI_ROUTING_TYPES.has(String(node.type || ""))) return true;
  return isBypassed(node);
}

/** Remove frontend-only annotations from an execution graph without changing the saved workflow. */
export function removeUiNotes(graph: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(graph).filter(([, node]) => !UI_NOTE_TYPES.has(String(row(node)?.class_type))));
}

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

export function isComfyApiWorkflow(value: unknown): value is Record<string, unknown> {
  const graph = row(value);
  if (!graph) return false;
  const entries = Object.values(graph);
  return entries.length > 0 && entries.every((node) => {
    const item = row(node);
    return typeof item?.class_type === "string" && row(item.inputs) !== null;
  });
}

/** Converts the frontend graph JSON saved by ComfyUI into the API prompt graph. */
export function convertComfyWorkflowToApi(value: unknown): Record<string, unknown> {
  if (isComfyApiWorkflow(value)) return removeUiNotes(value);
  const graph = row(value);
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error("文件不是 ComfyUI 工作流图或 API 工作流 JSON");
  }

  const links = new Map<string, { originId: string; originSlot: number; targetId: string; targetSlot: number }>();
  const rawLinks = Array.isArray(graph.links)
    ? graph.links
    : Object.values(row(graph.links) || {});
  for (const rawLink of rawLinks) {
    if (Array.isArray(rawLink) && rawLink.length >= 5) {
      links.set(String(rawLink[0]), { originId: String(rawLink[1]), originSlot: Number(rawLink[2]), targetId: String(rawLink[3]), targetSlot: Number(rawLink[4]) });
      continue;
    }
    const link = row(rawLink);
    if (!link) continue;
    const id = link.id ?? link.link_id;
    const originId = link.origin_id ?? link.originId;
    const originSlot = link.origin_slot ?? link.originSlot;
    const targetId = link.target_id ?? link.targetId;
    const targetSlot = link.target_slot ?? link.targetSlot;
    if (id !== undefined && originId !== undefined && targetId !== undefined) {
      links.set(String(id), { originId: String(originId), originSlot: Number(originSlot), targetId: String(targetId), targetSlot: Number(targetSlot) });
    }
  }

  const api: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  const nodes = graph.nodes.map(row);
  const nodeById = new Map(nodes.filter((node): node is Row => Boolean(node && node.id !== undefined)).map((node) => [String(node.id), node]));
  const incoming = new Map<string, { originId: string; originSlot: number; targetId: string; targetSlot: number }>();
  for (const link of links.values()) incoming.set(`${link.targetId}:${link.targetSlot}`, link);
  const resolveSource = (originId: string, originSlot: number, visited = new Set<string>()): [string, number] | null => {
    const source = nodeById.get(originId);
    if (!source) return [originId, originSlot];
    if (!isRoutingNode(source)) return [originId, originSlot];
    if (visited.has(originId)) return null; // 循环，放弃透传
    visited.add(originId);
    // bypass 节点只透传第一个输入到第一个输出，其他槽位不透传
    if (isBypassed(source) && originSlot !== 0) return [originId, originSlot];
    const rerouteInput = (Array.isArray(source.inputs) ? source.inputs : []).find((input: Row, index: number) => Number(input?.slot_index ?? input?.slotIndex ?? index) === (isBypassed(source) ? 0 : originSlot));
    const upstream = rerouteInput?.link !== null && rerouteInput?.link !== undefined
      ? links.get(String(rerouteInput.link))
      : incoming.get(`${originId}:${originSlot}`);
    if (!upstream) return null; // 上游缺失，放弃透传，保留原节点引用
    return resolveSource(upstream.originId, upstream.originSlot, visited);
  };
  for (const node of nodes) {
    if (!node || node.id === undefined || typeof node.type !== "string" || !node.type) continue;
    if (UI_NOTE_TYPES.has(node.type)) continue;
    if (UI_ROUTING_TYPES.has(node.type)) continue;
    if (isDisabled(node)) continue;
    if (isBypassed(node)) continue;
    const id = String(node.id);
    if (api[id]) throw new Error(`ComfyUI 工作流包含重复节点 ID：${id}`);
    const inputs: Record<string, unknown> = {};
    const nodeInputs = Array.isArray(node.inputs) ? node.inputs.map(row).filter((item): item is Row => Boolean(item)) : [];
    const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const widgetObject = row(node.widgets_values_named) || row(node.widgets_values);
    let widgetIndex = 0;

    for (const input of nodeInputs) {
      const inputName = typeof input.name === "string" ? input.name : "";
      if (!inputName) continue;
      if (input.link !== null && input.link !== undefined) {
        const link = links.get(String(input.link));
        if (!link) throw new Error(`节点 ${id} 的输入 ${inputName} 引用了缺失连线`);
        const resolved = resolveSource(link.originId, link.originSlot);
        if (resolved) inputs[inputName] = resolved;
      }
      if (input.widget) {
        const widget = row(input.widget);
        const widgetName = typeof widget?.name === "string" ? widget.name : inputName;
        const value = widgetObject && Object.hasOwn(widgetObject, widgetName) ? widgetObject[widgetName] : widgetValues[widgetIndex];
        widgetIndex += 1;
        // The frontend stores a seed's control-after-generate widget in the array,
        // although it is not an API input. Do not shift subsequent input values.
        if ((widgetName === "seed" || widgetName === "noise_seed") &&
            ["fixed", "increment", "decrement", "randomize"].includes(widgetValues[widgetIndex])) widgetIndex += 1;
        if ((input.link === null || input.link === undefined) && value !== undefined) inputs[inputName] = value;
      }
    }
    api[id] = { class_type: node.type, inputs };
  }

  if (!Object.keys(api).length) throw new Error("ComfyUI 工作流中没有可转换的节点");
  for (const link of links.values()) {
    const targetNode = nodeById.get(link.targetId);
    if (UI_ROUTING_TYPES.has(String(targetNode?.type || ""))) continue;
    if (isDisabled(targetNode)) continue;
    if (isBypassed(targetNode)) continue;
    if (!api[link.targetId]) throw new Error(`工作流连线引用了不存在的节点：${link.originId} → ${link.targetId}`);
    const [originId, originSlot] = resolveSource(link.originId, link.originSlot) || [link.originId, link.originSlot];
    if (!api[originId]) {
      // UI 注释节点被连线引用时仍应报错，而不是静默跳过
      if (UI_NOTE_TYPES.has(String(nodeById.get(originId)?.type || ""))) {
        throw new Error(`工作流连线引用了不存在的节点：${originId} → ${link.targetId}`);
      }
      continue; // 无法解析的连线跳过，不阻断导入
    }
    const target = nodes.find((node) => String(node?.id) === link.targetId);
    const targetInput = (Array.isArray(target?.inputs) ? target.inputs : []).find((input: Row) => Number(input?.slot_index ?? input?.slotIndex ?? (Array.isArray(target?.inputs) ? target.inputs.indexOf(input) : -1)) === link.targetSlot);
    const name = typeof targetInput?.name === "string" ? targetInput.name : "";
    if (name) api[link.targetId].inputs[name] = [originId, originSlot];
  }
  return api;
}
