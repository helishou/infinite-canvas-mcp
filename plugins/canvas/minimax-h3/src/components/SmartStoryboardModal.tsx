import { Modal } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";
import { generateSmartStoryboard, readStoryboardUpload } from "../services/smart-storyboard";
import { SmartStoryboardFields } from "./SmartStoryboardFields";

export function SmartStoryboardModal({ ctx, metadata, upstream, open, uploads, setUploads, onClose }: { ctx: CanvasNodeContext; metadata: Record<string, unknown>; upstream: H3Ref[]; open: boolean; uploads: H3Ref[]; setUploads: React.Dispatch<React.SetStateAction<H3Ref[]>>; onClose: () => void }) {
    const uploadAt = async (file: File, index: number) => {
        const next = { ...(await readStoryboardUpload(file)), slot: index + 1 };
        setUploads((current) => { const result = [...current]; result[index] = next; return result; });
    };
    const submit = () => { onClose(); const formImages = uploads.filter((item) => item?.type === "image"); void generateSmartStoryboard(ctx, formImages.length ? formImages : upstream); };
    const reorder = (from: number, to: number) => setUploads((current) => { if (from === to || !current[from]) return current; const next = [...current]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next; });
    return <Modal title="智能分镜 & 提示词" open={open} onCancel={onClose} onOk={submit} okText="生成分镜" cancelText="取消" width={620}>
        <SmartStoryboardFields ctx={ctx} metadata={metadata} uploads={uploads} onUpload={(file, index) => { void uploadAt(file, index); }} onRemove={(index) => setUploads((current) => current.filter((_, itemIndex) => itemIndex !== index))} onReorder={reorder} />
        <div style={{ marginTop: 10, color: ctx.theme.node.muted, fontSize: 12 }}>看图 API、语言模型和 Skill 沿用当前默认配置；将携带当前节点的 {upstream.filter((ref) => ref.type === "image").length} 张参考图片。</div>
    </Modal>;
}
