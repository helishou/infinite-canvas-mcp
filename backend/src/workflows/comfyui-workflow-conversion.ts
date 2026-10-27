type Row = Record<string, any>;

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
  if (isComfyApiWorkflow(value)) return value;
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
  for (const node of nodes) {
    if (!node || node.id === undefined || typeof node.type !== "string" || !node.type) continue;
    const id = String(node.id);
    if (api[id]) throw new Error(`ComfyUI 工作流包含重复节点 ID：${id}`);
    const inputs: Record<string, unknown> = {};
    const nodeInputs = Array.isArray(node.inputs) ? node.inputs.map(row).filter((item): item is Row => Boolean(item)) : [];
    const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const widgetObject = row(node.widgets_values);
    let widgetIndex = 0;

    for (const input of nodeInputs) {
      const inputName = typeof input.name === "string" ? input.name : "";
      if (!inputName) continue;
      if (input.link !== null && input.link !== undefined) {
        const link = links.get(String(input.link));
        if (!link) throw new Error(`节点 ${id} 的输入 ${inputName} 引用了缺失连线`);
        inputs[inputName] = [link.originId, link.originSlot];
      }
      if (input.widget) {
        const widget = row(input.widget);
        const widgetName = typeof widget?.name === "string" ? widget.name : inputName;
        const value = widgetObject ? widgetObject[widgetName] : widgetValues[widgetIndex];
        widgetIndex += 1;
        if ((input.link === null || input.link === undefined) && value !== undefined) inputs[inputName] = value;
      }
    }
    api[id] = { class_type: node.type, inputs };
  }

  if (!Object.keys(api).length) throw new Error("ComfyUI 工作流中没有可转换的节点");
  for (const link of links.values()) {
    if (!api[link.originId] || !api[link.targetId]) throw new Error(`工作流连线引用了不存在的节点：${link.originId} → ${link.targetId}`);
    const target = nodes.find((node) => String(node?.id) === link.targetId);
    const targetInput = (Array.isArray(target?.inputs) ? target.inputs : []).find((input: Row) => Number(input?.slot_index ?? input?.slotIndex ?? (Array.isArray(target?.inputs) ? target.inputs.indexOf(input) : -1)) === link.targetSlot);
    const name = typeof targetInput?.name === "string" ? targetInput.name : "";
    if (name) api[link.targetId].inputs[name] = [link.originId, link.originSlot];
  }
  return api;
}
