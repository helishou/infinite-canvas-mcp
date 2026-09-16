import { useEffect, useState } from "react";
import { Button, Input, Modal, Select } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3ReferenceRole, H3ReferenceUsage } from "../types";
import { inferReferenceRole } from "../services/h3-data";

const ROLE_OPTIONS: Array<{ value: H3ReferenceRole; label: string }> = [
    ["character_identity", "人物形象"], ["character_turnaround", "人物四视图"], ["scene", "场景基准"],
    ["blocking", "站位 / 轴线"], ["storyboard", "分镜图"], ["keyframe", "关键帧"],
    ["motion_reference", "动作参考"], ["audio_reference", "音频参考"], ["character_voice", "人物声线"],
    ["style", "风格参考"], ["palette", "色卡"], ["prop", "道具"], ["other", "其他"],
].map(([value, label]) => ({ value: value as H3ReferenceRole, label }));

export function H3ReferenceModal({ ctx, refItem, onApply, onClose }: { ctx: CanvasNodeContext; refItem: H3Ref; onApply: (ref: H3Ref) => void; onClose: () => void }) {
    const [role, setRole] = useState<H3ReferenceRole>(inferReferenceRole(refItem));
    const [usage, setUsage] = useState<H3ReferenceUsage>(refItem.usage || "reference");
    const [tags, setTags] = useState((refItem.tags || []).join("，"));
    const [analyzing, setAnalyzing] = useState(false);
    const [analysis, setAnalysis] = useState("");
    useEffect(() => { setRole(inferReferenceRole(refItem)); setUsage(refItem.usage || "reference"); setTags((refItem.tags || []).join("，")); setAnalysis(""); }, [refItem]);
    const parsedTags = tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    const apply = async () => {
        const next = { ...refItem, role, usage, tags: parsedTags, enabled: true };
        onApply(next);
        if (next.assetId) await ctx.references.upsert({ id: next.assetId, label: next.name, mediaType: next.type, role, tags: parsedTags, url: next.url, storageKey: next.storageKey, mimeType: next.mimeType, sourceNodeId: next.nodeId, subjectId: next.subjectId }).catch(() => undefined);
        onClose();
    };
    const analyze = async () => {
        setAnalyzing(true);
        try {
            const result = await ctx.ai.generateText([
                "分析这份视频生成参考素材，只返回 JSON：",
                '{"role":"角色枚举","tags":["标签"],"summary":"一句话说明素材职责"}',
                `角色枚举：${ROLE_OPTIONS.map((item) => item.value).join(", ")}`,
                `素材名：${refItem.name}；媒体类型：${refItem.type}。不要编造画面中看不到的信息。`,
            ].join("\n"), { references: refItem.type === "image" && refItem.url ? [{ url: refItem.url, name: refItem.name }] : undefined });
            const value = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { role?: H3ReferenceRole; tags?: string[]; summary?: string };
            if (ROLE_OPTIONS.some((item) => item.value === value.role)) setRole(value.role!);
            if (Array.isArray(value.tags)) setTags(value.tags.join("，"));
            setAnalysis(String(value.summary || "分析完成"));
        } catch (error) {
            setAnalysis(error instanceof Error ? error.message : String(error));
        } finally { setAnalyzing(false); }
    };
    return <Modal open title="参考素材职责" onCancel={onClose} onOk={() => void apply()} okText="应用到当前 Clip" cancelText="取消" width={560} destroyOnHidden>
        <div style={{ display: "grid", gridTemplateColumns: "144px 1fr", gap: 18, paddingTop: 8 }}>
            <div style={{ border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 8, overflow: "hidden", background: ctx.theme.node.panel, minHeight: 110 }}>
                {refItem.type === "image" ? <img src={refItem.url} alt={refItem.name} style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} /> : <div style={{ display: "grid", placeItems: "center", height: 110, fontSize: 12, opacity: 0.65 }}>{refItem.type === "video" ? "视频参考" : "音频参考"}</div>}
                <div style={{ padding: "7px 8px", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{refItem.name}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}><span style={{ opacity: 0.65 }}>主要职责</span><Select value={role} options={ROLE_OPTIONS} onChange={setRole} /></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}><span style={{ opacity: 0.65 }}>提交用途</span><Select value={usage} onChange={setUsage} options={[{ value: "reference", label: "普通参考" }, { value: "first_frame", label: "首帧" }, { value: "last_frame", label: "尾帧" }]} /></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}><span style={{ opacity: 0.65 }}>标签（逗号分隔）</span><Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：苏晚、雾蓝开衫、哭泣" /></label>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Button type="text" loading={analyzing} onClick={() => void analyze()}>用模型分析</Button><span style={{ minWidth: 0, fontSize: 11, opacity: 0.6 }}>{analysis}</span></div>
            </div>
        </div>
    </Modal>;
}
