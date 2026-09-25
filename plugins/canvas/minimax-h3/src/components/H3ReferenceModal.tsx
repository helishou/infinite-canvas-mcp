import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Modal, Select, Switch } from "antd";
import { ImagePlus, Play, Trash2 } from "lucide-react";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3CharacterGroup, H3CharacterGroupEditPatch, H3Ref, H3ReferenceRole, H3ReferenceUsage } from "../types";
import { inferReferenceRole } from "../services/h3-data";
import { H3Icon } from "./H3Icon";

const ROLE_OPTIONS: Array<{ value: H3ReferenceRole; label: string }> = [
    ["character_identity", "人物形象"], ["character_turnaround", "人物四视图"], ["scene", "场景基准"],
    ["blocking", "站位 / 轴线"], ["storyboard", "分镜参考图（可选）"], ["keyframe", "关键帧"],
    ["motion_reference", "动作参考"], ["audio_reference", "音频参考"], ["character_voice", "人物声线"],
    ["style", "风格参考"], ["palette", "色卡"], ["prop", "道具"], ["other", "其他"],
].map(([value, label]) => ({ value: value as H3ReferenceRole, label }));

type Props = {
    ctx: CanvasNodeContext;
    refItem: H3Ref;
    characters: Array<{ id: string; name: string; previewUrl?: string }>;
    group?: H3CharacterGroup;
    onApply: (ref: H3Ref, characterPatch?: H3CharacterGroupEditPatch) => void;
    onReplaceFromCanvas: () => void;
    onRemoveRef: () => void;
    onRemoveStoryboardImage: () => void;
    onDeleteGroup?: () => void;
    onClose: () => void;
};

export function H3ReferenceModal({ ctx, refItem, characters, group, onApply, onReplaceFromCanvas, onRemoveRef, onRemoveStoryboardImage, onDeleteGroup, onClose }: Props) {
    const characterReference = Boolean(group) || Boolean(refItem.nodeId && ctx.getNode(refItem.nodeId)?.type === "character");
    const characterVoice = Boolean(group && refItem.type === "audio");
    const sourceRole = refItem.role || "character_turnaround";
    const [role, setRole] = useState<H3ReferenceRole>(characterReference ? sourceRole : inferReferenceRole(refItem));
    const [usage, setUsage] = useState<H3ReferenceUsage>(characterReference ? "reference" : refItem.usage || "reference");
    const [description, setDescription] = useState(refItem.description || "");
    const [storyboardSubjectIds, setStoryboardSubjectIds] = useState<string[]>(refItem.storyboardSubjectIds || []);
    const [outfitEnabled, setOutfitEnabled] = useState(group?.outfitEnabled ?? Boolean(group?.outfits.some((outfit) => outfit.enabled)));
    const [voiceEnabled, setVoiceEnabled] = useState(group?.voiceEnabled ?? false);
    const [analyzing, setAnalyzing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [analysis, setAnalysis] = useState("");
    const [analysisSummary, setAnalysisSummary] = useState(typeof refItem.analysis?.summary === "string" ? refItem.analysis.summary : "");
    const [analysisMetadata, setAnalysisMetadata] = useState<Record<string, unknown>>(refItem.analysis || {});
    const persistedAnalysis = useRef<Record<string, unknown>>(refItem.analysis || {});

    useEffect(() => {
        setRole(characterReference ? sourceRole : inferReferenceRole(refItem));
        setUsage(characterReference ? "reference" : refItem.usage || "reference");
        setDescription(refItem.description || "");
        setStoryboardSubjectIds(refItem.storyboardSubjectIds || []);
        setOutfitEnabled(group?.outfitEnabled ?? Boolean(group?.outfits.some((outfit) => outfit.enabled)));
        setVoiceEnabled(group?.voiceEnabled ?? false);
        setAnalysis("");
        setSaveError("");
        let cancelled = false;
        void ctx.references.list().then((assets) => {
            const metadata = assets.find((asset) => asset.id === refItem.assetId)?.analysis || refItem.analysis || {};
            if (!cancelled) {
                persistedAnalysis.current = metadata;
                setAnalysisMetadata(metadata);
                setAnalysisSummary(typeof metadata.summary === "string" ? metadata.summary : "");
                setAnalysis(typeof metadata.summary === "string" ? metadata.summary : "");
            }
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [characterReference, ctx.references, group, refItem, sourceRole]);

    const isStoryboardImage = role === "storyboard" && refItem.type === "image";
    const canRemoveStoryboardImage = refItem.type === "image" && inferReferenceRole(refItem) === "storyboard";
    const apply = async () => {
        setSaving(true);
        setSaveError("");
        try {
        const nextAnalysis = analysisSummary.trim() ? { ...analysisMetadata, summary: analysisSummary.trim() } : analysisMetadata;
        const appliedRole = characterReference ? sourceRole : role;
        const appliedUsage = characterReference ? "reference" : usage;
        const next = { ...refItem, role: appliedRole, usage: appliedUsage, description: characterReference ? refItem.description : description.trim() || undefined, enabled: true, ...(Object.keys(nextAnalysis).length ? { analysis: nextAnalysis } : {}) };
        if (appliedRole !== "storyboard" || refItem.type !== "image") delete next.retentionLevel;
        if (appliedRole === "storyboard" && refItem.type === "image") next.storyboardSubjectIds = storyboardSubjectIds.filter((id) => characters.some((character) => character.id === id));
        else delete next.storyboardSubjectIds;
        if (JSON.stringify(nextAnalysis) !== JSON.stringify(persistedAnalysis.current)) {
            if (!next.assetId) throw new Error("参考素材缺少资产 ID，无法保存分析");
            await ctx.flush();
            await ctx.references.upsert({ id: next.assetId, analysis: nextAnalysis });
            persistedAnalysis.current = nextAnalysis;
        }
        // 服装与声线分别开关：只提交总开关，不覆盖逐套服装的 enabled 目录状态。
        const characterPatch = group ? { outfitEnabled, voiceEnabled } : undefined;
        onApply(next, characterPatch);
        onClose();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    const analyze = async () => {
        setAnalyzing(true);
        try {
            const result = await ctx.ai.generateText([
                "分析这份视频生成参考素材，只返回 JSON：",
                '{"role":"角色枚举","description":"一句话说明素材职责与用法"}',
                `角色枚举：${ROLE_OPTIONS.map((item) => item.value).join(", ")}`,
                `素材名：${refItem.name}；媒体类型：${refItem.type}。不要编造画面中看不到的信息。`,
            ].join("\n"), { references: refItem.type === "image" && refItem.url ? [{ url: refItem.url, name: refItem.name }] : undefined });
            const value = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { role?: H3ReferenceRole; description?: string; summary?: string };
            if (!characterReference && ROLE_OPTIONS.some((item) => item.value === value.role)) setRole(value.role!);
            const summary = String(value.description || value.summary || "");
            if (!characterReference && summary && !description.trim()) setDescription(summary);
            setAnalysisSummary(summary);
            if (summary) setAnalysisMetadata((current) => ({ ...current, summary }));
            setAnalysis(summary || "分析完成");
        } catch (error) {
            setAnalysis(error instanceof Error ? error.message : String(error));
        } finally { setAnalyzing(false); }
    };

    // 放大预览走宿主的统一预览弹窗（ctx.openMediaPreview），插件不自带灯箱。
    const openPreview = () => ctx.openMediaPreview({ url: refItem.url, name: refItem.name, type: refItem.type });

    return <>
        <Modal open title="参考素材职责" onCancel={onClose} onOk={() => void apply()} confirmLoading={saving} okText="应用到当前 Clip" cancelText="取消" width={560} destroyOnHidden>
            <div style={{ display: "grid", gridTemplateColumns: "144px 1fr", gap: 18, paddingTop: 8 }}>
                <div style={{ position: "relative", alignSelf: "start", border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 8, overflow: "hidden", background: ctx.theme.node.panel, minHeight: 110 }}>
                    {refItem.type === "image" ? <img src={refItem.url} alt={refItem.name} style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} /> : refItem.type === "video" && refItem.url ? <video src={`${refItem.url}${refItem.url.includes("?") ? "&" : "?"}t=0.001`} preload="metadata" muted playsInline style={{ width: "100%", height: 110, objectFit: "cover", display: "block", background: "#000" }} /> : <div style={{ display: "grid", placeItems: "center", height: 110, fontSize: 12, opacity: 0.65 }}>{refItem.type === "video" ? "视频参考" : "音频参考"}</div>}
                    {refItem.url ? <button type="button" className="minimax-outfit-zoom" title="放大预览" aria-label={`放大预览 ${refItem.name}`} onClick={openPreview}><H3Icon name="zoom" /></button> : null}
                    {canRemoveStoryboardImage ? <button type="button" className="minimax-outfit-remove" title="删除分镜图，保留分镜" aria-label={`删除分镜图 ${refItem.name}，保留分镜`} onClick={onRemoveStoryboardImage}><Trash2 /></button> : null}
                    <div style={{ padding: "7px 8px", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{refItem.name}</div>
                    <div style={{ display: "grid", gap: 6, padding: "0 8px 8px" }}>
                        <Button size="small" block icon={<ImagePlus className="size-3.5" />} onClick={onReplaceFromCanvas}>从画布替换</Button>
                        <Button size="small" block danger icon={<Trash2 className="size-3.5" />} onClick={onRemoveRef}>去除素材</Button>
                    </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {!characterReference ? <label style={{ display: "grid", gap: 5, fontSize: 14 }}><span style={{ opacity: 0.65 }}>主要职责</span><Select value={role} options={ROLE_OPTIONS} onChange={setRole} /></label> : null}
                    {/* 服装与声线是两个独立参考；关闭服装不会删除声线或角色组。 */}
                    {group ? <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6, background: ctx.theme.node.panel }}>
                        <span style={{ fontSize: 12 }}>服装参考</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12, opacity: group.outfits.length ? 0.8 : 0.45 }}>{group.outfits.length ? `${group.outfits.length} 套服装` : "暂无服装，仅使用声线"}</span>
                        <Switch size="small" checked={outfitEnabled && group.outfits.length > 0} disabled={!group.outfits.length} onChange={setOutfitEnabled} />
                    </div> : null}
                    {group?.voice ? <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6, background: ctx.theme.node.panel }}>
                        <span style={{ fontSize: 12 }}>声线</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 12, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.voice.name}</span>
                            {group.voice.description ? <span style={{ display: "block", marginTop: 2, fontSize: 11, opacity: 0.55 }}>{group.voice.description}</span> : null}
                        </span>
                        <Button type="text" size="small" icon={<Play className="size-3.5" />} onClick={() => ctx.openMediaPreview({ url: group.voice!.url, name: group.voice!.name, type: "audio" })}>试听</Button>
                        <Switch size="small" checked={voiceEnabled} onChange={setVoiceEnabled} />
                    </div> : null}
                    {isStoryboardImage ? <div style={{ display: "grid", gap: 6 }}>
                        <span style={{ fontSize: 13, opacity: 0.65 }}>分镜中出现的人物（可多选）</span>
                        {characters.length ? <Checkbox.Group value={storyboardSubjectIds} onChange={(values) => setStoryboardSubjectIds(values.map(String))}>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 6, maxHeight: 156, overflowY: "auto", padding: 8, border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6 }}>
                                {characters.map((character) => <Checkbox key={character.id} value={character.id}>
                                    <span style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 7 }}>
                                        {character.previewUrl ? <img src={character.previewUrl} alt="" style={{ width: 24, height: 24, flex: "0 0 auto", objectFit: "cover", borderRadius: 4 }} /> : null}
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{character.name}</span>
                                    </span>
                                </Checkbox>)}
                            </div>
                        </Checkbox.Group> : <span style={{ fontSize: 13, opacity: 0.6 }}>当前 Clip 尚未引用人物角色</span>}
                        <span style={{ fontSize: 12, opacity: 0.6 }}>列表只显示当前 Clip 已加入引用的人物；勾选后标记为此分镜中出现的人物。</span>
                    </div> : null}
                    {!characterReference ? <>
                        <label style={{ display: "grid", gap: 5, fontSize: 14 }}><span style={{ opacity: 0.65 }}>提交用途</span><Select value={usage} onChange={setUsage} options={[{ value: "reference", label: "普通参考" }, { value: "first_frame", label: "首帧" }, { value: "last_frame", label: "尾帧" }]} /></label>
                        {!isStoryboardImage ? <label style={{ display: "grid", gap: 5, fontSize: 14 }}><span style={{ opacity: 0.65 }}>描述</span><Input.TextArea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述这份参考素材的职责与用法，生成时会作为参考说明进入提示词" autoSize={{ minRows: 2, maxRows: 5 }} /></label> : null}
                    </> : null}
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Button type="text" loading={analyzing} onClick={() => void analyze()}>用模型分析</Button><span style={{ minWidth: 0, fontSize: 13, opacity: 0.6 }}>{analysis}</span></div>
                    {saveError ? <Alert type="error" showIcon message={saveError} /> : null}
                    {group && onDeleteGroup ? <Button type="text" danger size="small" style={{ alignSelf: "flex-start", paddingInline: 0 }} onClick={onDeleteGroup}>从本段移除整组</Button> : null}
                </div>
            </div>
        </Modal>
    </>;
}
