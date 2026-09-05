import { Input, Select, Switch } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";

type Props = {
    ctx: CanvasNodeContext;
    metadata: Record<string, unknown>;
    uploads: H3Ref[];
    onUpload: (file: File, index: number) => void;
    onPickCanvas: (index: number) => void;
    onRemove: (index: number) => void;
    onReorder: (from: number, to: number) => void;
};

export function SmartStoryboardFields({ ctx, metadata, uploads, onUpload, onPickCanvas, onRemove, onReorder }: Props) {
    const handleDrop = (event: React.DragEvent<HTMLLabelElement>, to: number) => {
        event.preventDefault();
        event.stopPropagation();
        const from = Number(event.dataTransfer.getData("application/x-smart-storyboard-slot"));
        if (Number.isInteger(from) && from >= 0 && from < uploads.length) onReorder(from, to);
    };
    return <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 12 }}>H3 官方模式</span><Select size="small" value={String(metadata.smartStoryboardMode || "ref2va")} onChange={(value) => ctx.updateMetadata({ smartStoryboardMode: value })} options={[{ value: "ref2va", label: "多参 Ref2VA" }, { value: "i2va", label: "图生视频 I2VA" }, { value: "t2va", label: "文生视频 T2VA" }, { value: "fl2va", label: "首尾帧 FL2VA" }]} style={{ width: "100%" }} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 12 }}>选择 Skill</span><Select size="small" value={String(metadata.smartStoryboardSkill || "regular_storyboard")} onChange={(value) => ctx.updateMetadata({ smartStoryboardSkill: value })} options={[{ value: "regular_storyboard", label: "常规提示词分镜" }, { value: "ns_storyboard", label: "NS提示词分镜" }]} style={{ width: "100%" }} /></label>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12 }}><span>段间接续</span><Switch size="small" checked={metadata.smartStoryboardContinuityEnabled !== false} onChange={(checked) => ctx.updateMetadata({ smartStoryboardContinuityEnabled: checked })} checkedChildren="接续" unCheckedChildren="独立" /></label>
        {/* 整体创意：独立字段，避免覆盖各 Clip 的 prompt。无数据迁移——老数据只有 prompt，编辑后自动创建 smartStoryboardIdea。 */}
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 12 }}>整体创意</span><Input.TextArea rows={3} value={String(metadata.smartStoryboardIdea ?? metadata.prompt ?? "")} onChange={(event) => ctx.updateMetadata({ smartStoryboardIdea: event.target.value })} placeholder="描述人物、动作、镜头、场景和节奏（仅用于本次分镜，不改动各 Clip 提示词）" /></label>
        <div><div style={{ marginBottom: 4, fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}><span>参考图片</span><button type="button" onClick={() => onPickCanvas(Math.max(0, uploads.findIndex((item) => !item)))} style={{ padding: "2px 10px", fontSize: 12 }}>从画布选择</button></div><div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 2 }}>{Array.from({ length: Math.max(8, uploads.length) }, (_, index) => { const ref = uploads[index]; return <label key={index} draggable={Boolean(ref)} onDragStart={(event) => { if (!ref) return; event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-smart-storyboard-slot", String(index)); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => handleDrop(event, index)} style={{ position: "relative", flex: "0 0 64px", height: 64, border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 3, overflow: "hidden", cursor: ref ? "grab" : "pointer", background: ctx.theme.node.panel, display: "flex", alignItems: "center", justifyContent: "center" }}>{ref ? <><img src={ref.url} alt={`图片${index + 1}`} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} /><span style={{ position: "absolute", left: 1, bottom: 1, padding: "0 3px", background: "rgba(0,0,0,.72)", color: "#fff", fontSize: 9, lineHeight: "10px" }}>图片{index + 1}</span><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRemove(index); }} style={{ position: "absolute", right: 1, top: 1, width: 12, height: 12, padding: 0, fontSize: 9, lineHeight: 1 }}>×</button></> : <><span style={{ fontSize: 14, color: ctx.theme.node.muted, lineHeight: 1 }}>＋</span><span style={{ position: "absolute", bottom: 2, fontSize: 10, lineHeight: "12px", color: ctx.theme.node.muted }}>图片{index + 1}</span></>}<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file, index); event.currentTarget.value = ""; }} style={{ display: "none" }} /></label>; })}</div><div style={{ marginTop: 4, color: ctx.theme.node.muted, fontSize: 12 }}>可点击“从画布选择”加入图片，也可点击空槽上传本地文件；拖动已上传图片可调整槽位顺序。</div></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 13 }}><label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}><span>生成段数</span><Select size="small" value={Number(metadata.smartStoryboardCount || 3)} onChange={(value) => ctx.updateMetadata({ smartStoryboardCount: value })} options={Array.from({ length: 12 }, (_, index) => index + 1).map((value) => ({ value, label: `${value} 段` }))} style={{ width: "100%" }} /></label><label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}><span>每段时长（秒）</span><Input type="number" size="small" min={1} max={15} value={Number(metadata.duration || 5)} onChange={(event) => ctx.updateMetadata({ duration: Number(event.target.value) })} style={{ width: "100%" }} /></label></div>
    </div>;
}
