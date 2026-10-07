import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Modal, theme } from "antd";
import { ContinuityPanel } from "../src/pages/drama/continuity-panel";
import type { ProductionContinuity } from "../src/services/backend-api";
import i18n from "../src/i18n";
import "../src/styles/globals.css";

const facts = [
    { id: "F_GRIP", object_kind: "character", object_id: "C_CUI", display_name: "抓握状态", allowed_values: ["not holding", "holding the child's arm", "released"], display_values: { "not holding": "尚未抓住顺子的手臂", "holding the child's arm": "左手握住顺子的右上臂", released: "已松开顺子的手臂" } },
    { id: "F_DAY", object_kind: "scene", object_id: "ENV_YARD", display_name: "时间", allowed_values: ["first day", "second day"], display_values: ["蒙太奇的第一天", "蒙太奇的第二天"] },
    { id: "F_EGGS", object_kind: "asset", object_id: "PROP_BASKET", display_name: "鸡蛋存量", allowed_values: ["original eggs", "fewer eggs"], display_values: { "original eggs": "篮中保留原有鸡蛋，不指定数量", "fewer eggs": "与第一天相比，篮中的鸡蛋更少" } },
];
const ledger = {
    contract_version: 2, facts, timelines: [{ id: "SC02_REPAIR", description: "第二场 · 顺叙时间线" }],
    initial: facts.map((fact) => ({ timeline_id: "SC02_REPAIR", fact_id: fact.id, value: fact.allowed_values[0] })),
    events: [{ id: "EV_GRIP", timeline_id: "SC02_REPAIR", fact_id: "F_GRIP", shot_id: "SH01", frame: 24, before: "not holding", after: "holding the child's arm", reason: "翠子伸出左手，抓住顺子的右上臂。", source_anchor: { block_id: "B01" } }],
    requirements: [{ id: "R_HOLD", timeline_id: "SC02_REPAIR", fact_id: "F_EGGS", shot_id: "SH01", kind: "hold", value: "original eggs", source_anchor: { block_id: "B01" } }],
    coverage: [{ id: "COV1", timeline_id: "SC02_REPAIR", evidence_kind: "explicit_change", fact_ids: ["F_GRIP"], event_ids: ["EV_GRIP"], shot_ids: ["SH01"], source_anchor: { block_id: "B01" }, source_digest: "fixture-hash" }],
};
const shots = [{ id: "SH01", title: "翠子伸手抓住顺子", scene_id: "SC02", story_order: 0, start_frame: 0, end_frame: 96 }, { id: "SH02", title: "顺子回头看向翠子", scene_id: "SC02", story_order: 1, start_frame: 96, end_frame: 192 }];
const report = { snapshot: "draft", status: "blocked", checkedAt: "2026-10-06T04:00:00Z", report: {
    selectedTargets: ["SEG01", "SEG02"], semanticDiscovery: "not_performed",
    diagnostics: [{ code: "CONTINUITY_STATE_MISMATCH", factId: "F_GRIP", targetId: "SH02", affectedTargets: ["SEG02"], severity: "error", message: "F_GRIP 在 SH01 与 SH02 之间出现无依据的变化。", expected: "holding the child's arm", actual: "not holding", sourceBlockId: "B01", path: "source.ledger.F_GRIP" }],
    trajectories: { SH01: { timelineId: "SC02_REPAIR", storyOrder: 0, start: { F_GRIP: "not holding", F_EGGS: "original eggs" }, end: { F_GRIP: "holding the child's arm", F_EGGS: "original eggs" } }, SH02: { timelineId: "SC02_REPAIR", storyOrder: 1, start: { F_GRIP: "not holding" }, end: { F_GRIP: "released" } } },
} } as unknown as ProductionContinuity;

function Harness() {
    const [dark, setDark] = useState(false), [english, setEnglish] = useState(false), [readonly, setReadonly] = useState(false);
    const [saved, setSaved] = useState<Record<string, any>>(ledger);
    const [evidence, setEvidence] = useState<Record<string, any>>({ saves: [], locations: [], handoffs: [], boundaries: [] });
    useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
    const capture = (key: string, value: unknown) => setEvidence((previous) => ({ ...previous, [key]: [...previous[key], value] }));
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App>
        <Modal open title="当前对象 · 连续性" width={1100} onCancel={() => {}} styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 8 } }} footer={<div className="flex flex-wrap justify-end gap-2"><Button onClick={() => setDark((value) => !value)}>Theme</Button><Button onClick={() => { setEnglish(!english); void i18n.changeLanguage(english ? "zh-CN" : "en-US"); }}>Language</Button><Button onClick={() => setReadonly((value) => !value)}>Readonly</Button></div>}>
            <ContinuityPanel ledger={saved} sourceHash="fixture-source" scenes={[{ id: "SC02", scene_id: "SC02", scene_name: "第二场 · 院子", blocks: [{ id: "B01", kind: "action", text: "翠子抓住顺子的手臂，篮中的鸡蛋保持原有数量。" }] }]} locations={[{ id: "ENV_YARD", name: "院子" }]} characters={[{ id: "C_CUI", name: "翠子" }]} assets={[{ id: "PROP_BASKET", name: "鸡蛋篮" }]} shots={shots} segments={[{ id: "SEG01", shot_ids: ["SH01"] }, { id: "SEG02", shot_ids: ["SH02"] }]} boundaries={[{ from: "SEG01", to: "SEG02", tailFrame: false, motionContext: false, reason: "确认人物位置和手臂接触关系后再切镜。" }]} report={{ ...report, snapshot: readonly ? "published" : "draft" }} busy={false} editable={!readonly}
                onSave={async (next) => { capture("saves", structuredClone(next)); setSaved(structuredClone(next)); return true; }} onPreviewUpgrade={async () => ({})} onCheck={async () => {}} onLocate={(kind, id) => capture("locations", { kind, id })} onAskDirector={(scope) => capture("handoffs", scope)} onBoundary={(value) => capture("boundaries", value)} />
        </Modal><output hidden data-testid="continuity-evidence">{JSON.stringify(evidence)}</output>
    </App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
