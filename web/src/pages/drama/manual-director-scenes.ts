type Row = Record<string, any>;
type Draft = { blockId: string; sceneId: string; name: string; defaultTimelineName: string };
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

export function createManualScriptScene(source: Row, draft: Draft) {
    const blockId = draft.blockId.trim(), sceneId = draft.sceneId.trim(), name = draft.name.trim();
    if (!blockId || !sceneId || !name) throw new Error("场次、环境 ID 和名称不能为空");
    if (rows(source.script_scenes).some(item => String(item.id || "") === blockId)) throw new Error(`场次 ID 已存在：${blockId}`);
    if (rows(source.scene_registry).some(item => String(item.id || "") === sceneId)) throw new Error(`环境 ID 已存在：${sceneId}`);

    const occurrence = { id: blockId, scene_id: sceneId, scene_name: name, kind: "action", text: "" };
    const environment = { id: sceneId, name, description: "" };
    const ledger = source.ledger && typeof source.ledger === "object" && !Array.isArray(source.ledger) ? source.ledger as Row : {};
    const timelines = rows(ledger.timelines);
    const timelineId = String(timelines[0]?.id || "main");
    const nextSource: Row = {
        ...source,
        script_scenes: [...rows(source.script_scenes), occurrence],
        scene_registry: [...rows(source.scene_registry), environment],
        ledger: { ...ledger, timelines: timelines.length ? timelines : [{ id: "main", name: draft.defaultTimelineName }] },
    };
    return { source: nextSource, occurrence, environment, timelineId };
}
