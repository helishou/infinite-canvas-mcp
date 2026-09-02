import { Input, Select } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";

type Props = {
    ctx: CanvasNodeContext;
    metadata: Record<string, unknown>;
    uploads: H3Ref[];
    onUpload: (file: File, index: number) => void;
    onRemove: (index: number) => void;
    onReorder: (from: number, to: number) => void;
};

export function SmartStoryboardFields({ ctx, metadata, uploads, onUpload, onRemove, onReorder }: Props) {
    const handleDrop = (event: React.DragEvent<HTMLLabelElement>, to: number) => {
        event.preventDefault();
        event.stopPropagation();
        const from = Number(event.dataTransfer.getData("application/x-smart-storyboard-slot"));
        if (Number.isInteger(from) && from >= 0 && from < uploads.length) onReorder(from, to);
    };
    return <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label>H3 官方模式<Select value={String(metadata.smartStoryboardMode || "ref2va")} onChange={(value) => ctx.updateMetadata({ smartStoryboardMode: value })} options={[{ value: "ref2va", label: "多参 Ref2VA" }, { value: "i2va", label: "图生视频 I2VA" }, { value: "t2va", label: "文生视频 T2VA" }, { value: "fl2va", label: "首尾帧 FL2VA" }]} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
        <label>选择 Skill<Select value={String(metadata.smartStoryboardSkill || "regular_storyboard")} onChange={(value) => ctx.updateMetadata({ smartStoryboardSkill: value })} options={[{ value: "regular_storyboard", label: "常规提示词分镜" }, { value: "ns_storyboard", label: "NS提示词分镜" }]} style={{ display: "block", width: "100%", marginTop: 4 }} /></label>
        <label>整体创意<Input.TextArea rows={5} value={String(metadata.prompt || "")} onChange={(event) => ctx.updateMetadata({ prompt: event.target.value })} placeholder="描述人物、动作、镜头、场景和节奏" /></label>
        <div><div style={{ marginBottom: 5, fontWeight: 700 }}>参考图片</div><div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>{Array.from({ length: Math.max(8, uploads.length) }, (_, index) => { const ref = uploads[index]; return <label key={index} draggable={Boolean(ref)} onDragStart={(event) => { if (!ref) return; event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-smart-storyboard-slot", String(index)); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => handleDrop(event, index)} style={{ position: "relative", flex: "0 0 86px", height: 86, border: `1px solid ${ctx.theme.node.stroke}`, borderRadius: 6, overflow: "hidden", cursor: ref ? "grab" : "pointer", background: ctx.theme.node.panel, display: "flex", alignItems: "center", justifyContent: "center" }}>{ref ? <><img src={ref.url} alt={`图片${index + 1}`} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }} /><span style={{ position: "absolute", left: 4, bottom: 4, padding: "1px 4px", background: "rgba(0,0,0,.72)", color: "#fff", fontSize: 11 }}>图片{index + 1}</span><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRemove(index); }} style={{ position: "absolute", right: 3, top: 3, width: 20, height: 20, padding: 0 }}>×</button></> : <><span style={{ fontSize: 25, color: ctx.theme.node.muted }}>＋</span><span style={{ position: "absolute", bottom: 4, fontSize: 11, color: ctx.theme.node.muted }}>图片{index + 1}</span></>}<input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file, index); event.currentTarget.value = ""; }} style={{ display: "none" }} /></label>; })}</div><div style={{ marginTop: 4, color: ctx.theme.node.muted, fontSize: 12 }}>点击空槽上传，点击已有图片可替换；拖动已上传图片可调整槽位顺序，图片编号按槽位固定。</div></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><label>生成段数<Select value={Number(metadata.smartStoryboardCount || 3)} onChange={(value) => ctx.updateMetadata({ smartStoryboardCount: value })} options={Array.from({ length: 12 }, (_, index) => index + 1).map((value) => ({ value, label: `${value} 段` }))} style={{ display: "block", width: "100%", marginTop: 4 }} /></label><label>每段时长（秒）<Input type="number" min={1} max={15} value={Number(metadata.duration || 5)} onChange={(event) => ctx.updateMetadata({ duration: Number(event.target.value) })} style={{ display: "block", marginTop: 4 }} /></label></div>
    </div>;
}
