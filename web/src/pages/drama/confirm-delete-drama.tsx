import { App, Checkbox } from "antd";
import type { TFunction } from "i18next";

import { fetchBackendAssets } from "@/services/backend-api";

type AppApi = ReturnType<typeof App.useApp>;

export type DeleteDramaConfirmInput = {
    modal: AppApi["modal"];
    message: AppApi["message"];
    t: TFunction;
    drama: { id: string; name: string };
    /** 真删动作交给调用方的 store，勾选结果通过 deleteAssets 传下去。 */
    onDelete: (options: { deleteAssets: boolean }) => Promise<void>;
    onDeleted?: () => void;
};

/** 剧目资产条目数：内部 drama-file（封面等）随剧目必删，不计入用户可见数量。 */
async function countDramaAssets(dramaId: string): Promise<number | null> {
    try {
        const result = await fetchBackendAssets({ dramaId });
        return (result.assets || []).filter((asset) => (asset as { kind?: string }).kind !== "drama-file").length;
    } catch {
        return null;
    }
}

/**
 * 删除剧目的二次确认：剧目卡片和剧目资料面板共用同一套文案与资产选项。
 * 资产默认保留（归属回落「未归属」），只有勾选「同时删除该剧目的资产」才一起清掉。
 */
export async function confirmDeleteDrama({ modal, message, t, drama, onDelete, onDeleted }: DeleteDramaConfirmInput) {
    const assetCount = await countDramaAssets(drama.id);
    // modal.confirm 读不到子组件状态，勾选结果放在闭包里，Checkbox 自己维护显示。
    const choice = { deleteAssets: false };
    modal.confirm({
        title: t("drama.deleteProject"),
        okText: t("drama.deleteProjectConfirm"),
        okType: "danger",
        cancelText: t("common.cancel"),
        content: (
            <div className="space-y-3">
                <p>{t("drama.deleteProjectDescription", { name: drama.name })}</p>
                {assetCount === 0 ? <p className="text-xs text-muted-foreground">{t("drama.deleteProjectNoAssets")}</p> : (
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox className="mt-0.5" onChange={(event) => { choice.deleteAssets = event.target.checked; }} />
                        <span>
                            {assetCount === null
                                ? t("drama.deleteProjectAssetsOption")
                                : t("drama.deleteProjectAssetsOptionCount", { count: assetCount })}
                            <span className="mt-1 block text-xs text-muted-foreground">{t("drama.deleteProjectAssetsHint")}</span>
                        </span>
                    </label>
                )}
            </div>
        ),
        onOk: async () => {
            try {
                await onDelete({ deleteAssets: choice.deleteAssets });
                message.success(t("drama.deleted"));
                onDeleted?.();
            } catch (error) {
                message.error(error instanceof Error ? error.message : String(error));
            }
        },
    });
}
