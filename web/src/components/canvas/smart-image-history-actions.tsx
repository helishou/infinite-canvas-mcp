import { useState } from "react";
import { App, Button, Dropdown } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CanvasNodeContext } from "@/types/canvas-plugin";
import type { CanvasNodeImage } from "@/types/canvas";
import { smartImageSettingsPatch } from "./smart-image-history";

export function SmartImageHistoryActions({ ctx, image }: { ctx: CanvasNodeContext; image?: CanvasNodeImage }) {
    const { t } = useTranslation(), { message } = App.useApp();
    const [saving, setSaving] = useState(false);
    const policy = ctx.node.metadata?.smartImageReferenceSelection;
    const run = async (action: string) => {
        if (saving) return;
        setSaving(true);
        try {
            if (action === "restore") {
                const latestImage = ctx.getNode(ctx.node.id)?.metadata?.images?.find(item => item.id === image?.id);
                const patch = latestImage && smartImageSettingsPatch(latestImage);
                if (!patch) throw new Error(t("director.atomic.historySnapshotMissing"));
                const target = { nodeId: ctx.node.id, field: "composerContent" as const }, session = ctx.textDocument(target);
                await session.flush();
                const documentId = session.getDocumentId();
                const snapshot = session.getSnapshot();
                if (!snapshot.ready || snapshot.blocked || !documentId || !await ctx.replaceText(target, documentId, snapshot.text, String(patch.prompt))) throw new Error(t("director.atomic.historyTextConflict"));
                ctx.updateMetadata(patch);
            } else {
                if (action !== "latest" && !image) throw new Error(t("director.workspace.noActivePicture"));
                const selection = action === "latest" ? { mode: "latest_success" as const } : { mode: "selected_result" as const, resultId: image!.id };
                ctx.applyOps([{ type: "update_node", id: ctx.node.id, metadata: { smartImageReferenceSelection: selection } }]);
            }
            await ctx.flush();
            message.success(t(action === "restore" ? "director.atomic.historySettingsRestored" : "director.atomic.historyReferenceSaved"));
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
        finally { setSaving(false); }
    };
    return <Dropdown trigger={["click"]} menu={{ items: [
        { key: "pin", label: t("director.atomic.useImageReference"), disabled: image?.status !== "success" || !image.storageKey },
        { key: "latest", label: t("director.workspace.followLatest") },
        { type: "divider" },
        { key: "restore", label: t("director.atomic.restoreImageSettings"), disabled: !image?.generationSnapshot },
    ], onClick: ({ key }) => void run(key) }}><Button size="small" type="text" loading={saving} disabled={saving} style={{ color: ctx.theme.node.text }} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{t(policy?.mode === "selected_result" ? "director.atomic.nodeReferencePinned" : "director.atomic.nodeReferenceLatest")}<ChevronDown className="size-3" /></Button></Dropdown>;
}
