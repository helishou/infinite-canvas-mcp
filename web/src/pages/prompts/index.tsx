import { FolderPlus, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { type ReactNode, type UIEvent, useEffect, useState } from "react";
import { App, Button, Empty, Input, Popconfirm, Spin, Tag } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { PromptCard } from "@/components/prompts/prompt-card";
import { CustomPromptDialog } from "@/components/prompts/custom-prompt-dialog";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/use-asset-store";
import { CUSTOM_PROMPTS_CATEGORY, useCustomPromptsStore } from "@/stores/use-custom-prompts-store";
import { ALL_PROMPTS_OPTION, isCustomPrompt, type Prompt } from "@/services/api/prompts";

type DialogState = { mode: "add" } | { mode: "edit"; prompt: Prompt } | null;

export default function PromptsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [dialog, setDialog] = useState<DialogState>(null);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const customPrompts = useCustomPromptsStore((state) => state.prompts);
    const removeCustomPrompt = useCustomPromptsStore((state) => state.removePrompt);
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory });
    const initialLoading = query.isPending && !query.data;

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success(t("common.addedToAssets"));
    };

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    const invalidatePrompts = () => {
        void queryClient.invalidateQueries({ queryKey: ["prompts"] });
    };

    const handleDeleteClick = async (item: Prompt) => {
        if (!isCustomPrompt(item)) return;
        try {
            if (!await removeCustomPrompt(item.id)) {
                message.error(t("prompts.custom.deleteFailed"));
                return;
            }
            message.success(t("prompts.custom.deleted"));
            invalidatePrompts();
            if (selectedPrompt?.id === item.id) setSelectedPrompt(null);
        } catch {
            message.error(t("prompts.custom.deleteFailed"));
        }
    };

    const renderCustomActions = (item: Prompt) => (
        <>
            <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setDialog({ mode: "edit", prompt: item })}>{t("common.edit")}</Button>
            <Popconfirm title={t("prompts.custom.deleteConfirm")} okText={t("common.confirm")} cancelText={t("common.cancel")} onConfirm={() => void handleDeleteClick(item)}>
                <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />}>{t("common.delete")}</Button>
            </Popconfirm>
        </>
    );

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 lg:py-8 dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]" onScroll={handleListScroll}>
                <div className="mx-auto max-w-7xl">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                        <div className="text-center sm:text-left">
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("prompts.title")}</h1>
                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("prompts.total", { count: totalPrompts })}</p>
                        </div>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ mode: "add" })}>{t("prompts.custom.addTitle")}</Button>
                    </div>
                    <div className="mt-5 grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-6">
                        <aside className="thin-scrollbar max-h-72 overflow-y-auto border-b border-stone-200 pb-5 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-6rem)] lg:border-b-0 lg:border-r lg:pb-8 lg:pr-5 dark:border-stone-800">
                            <PromptFilter label={t("prompts.category")} options={promptCategoryOptions} selected={selectedCategory} onChange={setSelectedCategory} />
                            <div className="mt-6">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.tags")}</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {promptTags.map((tag) => {
                                        const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                        return <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>{tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}</Tag.CheckableTag>;
                                    })}
                                </div>
                            </div>
                        </aside>
                        <section className="min-w-0">
                            <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} placeholder={t("prompts.search")} onChange={(event) => setTitleKeyword(event.target.value)} />
                            {initialLoading ? <div className="mt-5 flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-stone-200 bg-white/60 text-stone-500 dark:border-stone-800 dark:bg-stone-900/30 dark:text-stone-400"><Spin size="large" /><div className="mt-4 text-sm">{t("prompts.loading")}</div></div> : null}
                            {!initialLoading ? <div className="mt-5">
                                {selectedCategory === CUSTOM_PROMPTS_CATEGORY && customPrompts.length > 0 && !titleKeyword && selectedTags.length === 0 ? <div className="mb-3 rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-900/40 dark:text-stone-400">{t("prompts.custom.tip", { count: customPrompts.length })}</div> : null}
                                <PromptGrid items={promptItems} onOpen={setSelectedPrompt} renderActions={(item) => <><Button type="text" size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>{t("common.addToAssets")}</Button>{isCustomPrompt(item) ? renderCustomActions(item) : null}</>} onCopy={(item) => copyText(item.prompt, t("common.promptCopied"))} emptyText={t("prompts.empty")} />
                            </div> : null}
                            <div className="mt-6 text-center text-xs text-stone-500 dark:text-stone-400">{query.isFetchingNextPage ? t("prompts.loading") : query.hasNextPage ? t("prompts.loadMore") : promptItems.length > 0 ? t("prompts.end") : null}</div>
                        </section>
                    </div>
                </div>
            </main>

            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={savePromptAsset} />
            <CustomPromptDialog open={dialog !== null} mode={dialog?.mode || "add"} initial={dialog?.mode === "edit" ? dialog.prompt : null} onClose={() => setDialog(null)} onSaved={invalidatePrompts} />
        </div>
    );
}

function PromptFilter({ label, options, selected, onChange }: { label: string; options: string[]; selected: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return <div><div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{label}</div><div className="flex flex-wrap gap-1.5">{options.map((option) => <Tag.CheckableTag key={option} checked={selected === option} className={cn("prompt-filter-tag", selected === option && "is-active")} onChange={() => onChange(option)}>{option === ALL_PROMPTS_OPTION ? t("common.all") : option}</Tag.CheckableTag>)}</div></div>;
}

function PromptGrid({ items, onOpen, onCopy, renderActions, emptyText }: { items: Prompt[]; onOpen: (item: Prompt) => void; onCopy: (item: Prompt) => void; renderActions: (item: Prompt) => ReactNode; emptyText: string }) {
    return <div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{items.map((item) => <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => onOpen(item)} onCopy={() => onCopy(item)} extraAction={renderActions(item)} />)}</div>{items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" /> : null}</div>;
}
