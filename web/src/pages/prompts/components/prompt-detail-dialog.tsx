import { Copy, FileText, FolderPlus, Pencil } from "lucide-react";
import { Button, Modal, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import { MediaImage } from "@/components/media/media-image";

export function PromptDetailDialog({ prompt, onClose, onCopy, onSaveAsset, onEdit }: { prompt: Prompt | null; onClose: () => void; onCopy: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void; onEdit?: (prompt: Prompt) => void }) {
    const { i18n, t } = useTranslation();

    return (
        <Modal title={prompt?.title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={720} centered styles={{ body: { height: "min(760px, calc(85dvh - 55px))", overflow: "hidden" } }}>
            {prompt ? (
                <div className="flex h-full min-h-0 flex-col">
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
                        <div className="space-y-3 pb-4">
                            {prompt.coverUrl ? <div className="h-40 w-full overflow-hidden rounded-lg sm:h-56"><MediaImage src={prompt.coverUrl} alt={prompt.title} name={prompt.title} className="h-full w-full object-cover" /></div> : <div className="grid h-40 w-full place-items-center rounded-lg bg-muted text-muted-foreground sm:h-56"><FileText className="size-9" /></div>}
                            {prompt.referenceImageUrls.length > 1 ? <div className="grid grid-cols-6 gap-2">{prompt.referenceImageUrls.filter((url) => url !== prompt.coverUrl).slice(0, 6).map((url, index) => <div key={`${url}-${index}`} className="aspect-square overflow-hidden rounded-md"><MediaImage src={url} alt={prompt.title} className="h-full w-full object-cover" /></div>)}</div> : null}
                        </div>
                        <section className="min-w-0 border-t border-border py-4" data-resource-group="prompt-origin">
                            <h3 className="mb-3 text-xs font-medium text-muted-foreground">{t("prompts.workspace.sourceAndTags")}</h3>
                            <p className="mb-3 break-words text-sm">{prompt.category}</p>
                            <div className="flex flex-wrap gap-1.5">
                                {prompt.tags.map((tag) => (
                                    <Tag key={tag} className="m-0">
                                        {tag}
                                    </Tag>
                                ))}
                            </div>
                        </section>
                        <section className="min-w-0 border-t border-border py-4" data-resource-group="prompt-content">
                            <h3 className="text-xs font-medium text-muted-foreground">{t("prompts.workspace.promptBody")}</h3>
                            {prompt.description ? <p className="mt-4 text-sm leading-6 text-muted-foreground">{prompt.description}</p> : null}
                            {prompt.preview ? <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">{prompt.preview}</pre> : null}
                            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-foreground">{prompt.prompt}</p>
                            {prompt.createdAt || prompt.updatedAt ? <div className="mt-4 text-xs text-muted-foreground">{prompt.createdAt ? t("common.created", { date: formatPromptDate(prompt.createdAt, i18n.resolvedLanguage) }) : null}{prompt.createdAt && prompt.updatedAt ? " · " : null}{prompt.updatedAt ? t("common.updated", { date: formatPromptDate(prompt.updatedAt, i18n.resolvedLanguage) }) : null}</div> : null}
                        </section>
                    </div>
                    <div className="shrink-0 border-t border-border pt-4">
                        <div className="flex flex-wrap gap-2">
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>
                                {t("prompts.workspace.copyText")}
                            </Button>
                            {onSaveAsset ? (
                                <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(prompt)}>
                                    {t("prompts.workspace.saveTextAsset")}
                                </Button>
                            ) : null}
                        </div>
                        {onEdit ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                            <span className="text-xs text-muted-foreground">{t("prompts.workspace.managePrompt")}</span>
                            <Button type="text" icon={<Pencil className="size-4" />} onClick={() => onEdit(prompt)}>{t("common.edit")}</Button>
                        </div> : null}
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
