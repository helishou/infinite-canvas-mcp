import { Modal } from "antd";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";
import {
  generateSmartStoryboard,
  readStoryboardUpload,
} from "../services/smart-storyboard";
import { SmartStoryboardFields } from "./SmartStoryboardFields";

export function SmartStoryboardModal({
  ctx,
  metadata,
  upstream,
  open,
  uploads,
  setUploads,
  onClose,
}: {
  ctx: CanvasNodeContext;
  metadata: Record<string, unknown>;
  upstream: H3Ref[];
  open: boolean;
  uploads: H3Ref[];
  setUploads: React.Dispatch<React.SetStateAction<H3Ref[]>>;
  onClose: () => void;
}) {
  const generating = String(metadata.smartStoryboardStatus || "") === "loading";
  const uploadAt = async (file: File, index: number) => {
    const next = { ...(await readStoryboardUpload(file)), slot: index + 1 };
    setUploads((current) => {
      const result = [...current];
      result[index] = next;
      return result;
    });
  };
  const submit = () => {
    if (generating) return;
    onClose();
    const formImages = uploads.filter((item) => item?.type === "image");
    // fallback 必须是图片 refs，不能把上游 video/audio 也当成"分镜参考"塞进去：
    // 上游 video/audio 是上一段生成结果，强行继承会导致新分镜莫名其妙把上一段
    // 当成参考，并且新段执行时也会把上一段视频当 video ref 传出去。
    // const upstreamImages = upstream.filter((ref) => ref.type === "image");
    // console.log("SmartStoryboardModal submit", { formImages, upstreamImages });
    void generateSmartStoryboard(
      ctx,
       formImages
    );
  };
  const pickCanvasAt = async (index: number) => {
    const image = await ctx.openAssetPicker({ kind: "image" });
    if (!image) return;
    setUploads((current) => {
      const result = [...current];
      result[index] = {
        url: image.dataUrl,
        storageKey: image.storageKey,
        name: image.title,
        type: "image",
        slot: index + 1,
      };
      return result;
    });
  };
  const reorder = (from: number, to: number) =>
    setUploads((current) => {
      if (from === to || !current[from]) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  return (
    <Modal
      title="智能分镜 & 提示词"
      open={open}
      onCancel={generating ? undefined : onClose}
      onOk={submit}
      confirmLoading={generating}
      okButtonProps={{ disabled: generating }}
      okText={generating ? "生成中…" : "生成分镜"}
      cancelText="取消"
      width={460}
    >
      <SmartStoryboardFields
        ctx={ctx}
        metadata={metadata}
        uploads={uploads}
        onUpload={(file, index) => {
          void uploadAt(file, index);
        }}
        onPickCanvas={(index) => {
          void pickCanvasAt(index);
        }}
        onRemove={(index) =>
          setUploads((current) =>
            current.filter((_, itemIndex) => itemIndex !== index),
          )
        }
        onReorder={reorder}
      />
      <div style={{ marginTop: 10, color: ctx.theme.node.muted, fontSize: 11, lineHeight: 1.5 }}>
        看图 API、语言模型和 Skill 沿用当前默认配置；未上传图片时 fallback
        使用当前节点上游图片（
        {upstream.filter((ref) => ref.type === "image").length}{" "}
        张），不会把上一段生成的视频当参考。
      </div>
    </Modal>
  );
}
