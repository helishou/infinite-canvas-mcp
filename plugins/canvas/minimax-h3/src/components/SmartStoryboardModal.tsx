import { useEffect } from "react";
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
  // modal 打开时如果带着上次的 error 状态，自动清掉 —— 刷新/重启后 metadata 原样加载，
  // 旧的 error 会一直挂着按钮变红、status 区显示红字，用户无法清除。
  useEffect(() => {
    if (open && String(metadata.smartStoryboardStatus || "") === "error") {
      ctx.updateMetadata({ smartStoryboardStatus: "", smartStoryboardError: "" });
    }
  }, [open]);
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
    // 智能分镜只接收图片参考；没有手动上传时使用上游图片节点，不能把
    // 上游视频/音频结果混进分镜规划或后续 H3 Clip 的参考清单。
    const storyboardRefs = formImages.length ? formImages : upstream.filter((ref) => ref.type === "image");
    void generateSmartStoryboard(
      ctx,
       storyboardRefs
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
        看图 API、语言模型和 Skill 沿用当前默认配置；未上传图片时使用当前节点上游图片（
        {upstream.filter((ref) => ref.type === "image").length} 张），不会把上一段生成的视频当参考。
      </div>
    </Modal>
  );
}
