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
    const [filtersExpanded, setFiltersExpanded] = useState(false);
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
        <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6 lg:px-8 lg:py-8" onScroll={handleListScroll}>
                <div className="mx-auto max-w-[1440px]">
                    <header className="flex flex-wrap items-center justify-between gap-5 border-b border-border pb-6">
                        <div>
                            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t("prompts.library")}</p>
                            <h1 className="mt-2 text-2xl font-medium tracking-tight sm:text-3xl">{t("prompts.title")}</h1>
                            <p className="mt-2 text-xs text-muted-foreground">{t("prompts.total", { count: totalPrompts })}</p>
                        </div>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setDialog({ mode: "add" })}>{t("prompts.custom.addTitle")}</Button>
                    </header>
                    <div className="mt-6 max-w-2xl">
                        <label className="mb-2 block text-xs font-medium text-muted-foreground" htmlFor="prompt-library-search">{t("prompts.workspace.findPrompts")}</label>
                        <Input id="prompt-library-search" size="large" allowClear aria-label={t("prompts.search")} prefix={<Search className="mr-1 size-4 text-muted-foreground" />} value={titleKeyword} placeholder={t("prompts.search")} onChange={(event) => setTitleKeyword(event.target.value)} />
                    </div>
                    <div className="mt-5 grid items-start gap-6 lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-8">
                        <aside className="border-b border-border pb-4 lg:sticky lg:top-0 lg:border-b-0 lg:border-r lg:pb-8 lg:pr-5" data-resource-group="prompt-filters">
                            <button type="button" className="flex w-full items-center justify-between gap-3 text-left text-sm lg:hidden" aria-expanded={filtersExpanded} aria-controls="prompt-library-filters" onClick={() => setFiltersExpanded((value) => !value)}>
                                <span>{t("prompts.workspace.filterScope")}</span><span className="text-xs text-muted-foreground">{t(filtersExpanded ? "prompts.workspace.hideFilters" : "prompts.workspace.showFilters")}</span>
                            </button>
                            <div id="prompt-library-filters" className={cn("thin-scrollbar max-h-72 overflow-y-auto pt-4 lg:max-h-[calc(100dvh-6rem)] lg:pt-0", !filtersExpanded && "hidden lg:block")}>
                            <PromptFilter label={t("prompts.category")} options={promptCategoryOptions} selected={selectedCategory} onChange={setSelectedCategory} />
                            <div className="mt-6">
                                <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t("prompts.tags")}</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {promptTags.map((tag) => {
                                        const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                        return <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>{tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}</Tag.CheckableTag>;
                                    })}
                                </div>
                            </div>
                            </div>
                        </aside>
                        <section className="min-w-0">
                            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                    <span>{t("prompts.workspace.source")}:</span><Tag className="!m-0 max-w-full !whitespace-normal">{selectedCategory === ALL_PROMPTS_OPTION ? t("common.all") : selectedCategory}</Tag>
                                    {selectedTags.map((tag) => <Tag key={tag} closable onClose={() => toggleTag(tag)} className="!m-0 max-w-full !whitespace-normal">{tag}</Tag>)}
                                    <span>{t("prompts.total", { count: totalPrompts })}</span>
                                </div>
                                {titleKeyword || selectedTags.length || selectedCategory !== ALL_PROMPTS_OPTION ? <Button size="small" type="text" onClick={() => { setTitleKeyword(""); setSelectedTags([]); setSelectedCategory(ALL_PROMPTS_OPTION); }}>{t("prompts.workspace.clearFilters")}</Button> : null}
                            </div>
                            {initialLoading ? <div role="status" className="mt-5 flex min-h-80 flex-col items-center justify-center rounded-xl border border-border bg-card/50 text-muted-foreground"><Spin size="large" /><div className="mt-4 text-sm">{t("prompts.loading")}</div></div> : null}
                            {!initialLoading ? <div className="mt-5">
                                {selectedCategory === CUSTOM_PROMPTS_CATEGORY && customPrompts.length > 0 && !titleKeyword && selectedTags.length === 0 ? <div className="mb-4 rounded-lg bg-muted px-4 py-3 text-xs leading-5 text-muted-foreground">{t("prompts.custom.tip", { count: customPrompts.length })}</div> : null}
                                <PromptGrid items={promptItems} onOpen={setSelectedPrompt} renderActions={(item) => <Button type="text" size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>{t("prompts.workspace.saveTextAsset")}</Button>} renderManagement={(item) => isCustomPrompt(item) ? renderCustomActions(item) : null} onCopy={(item) => copyText(item.prompt, t("common.promptCopied"))} emptyText={t("prompts.empty")} />
                            </div> : null}
                            <div className="mt-6 text-center text-xs text-muted-foreground">{query.isFetchingNextPage ? t("prompts.loading") : query.hasNextPage ? t("prompts.loadMore") : promptItems.length > 0 ? t("prompts.end") : null}</div>
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
    return <div>
        <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
        <div className="flex flex-wrap gap-1 lg:flex-col">
            {options.map((option) => <button type="button" key={option} aria-pressed={selected === option} className={cn("rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", selected === option && "bg-muted font-medium text-foreground")} onClick={() => onChange(option)}>{option === ALL_PROMPTS_OPTION ? t("common.all") : option}</button>)}
        </div>
    </div>;
}

function PromptGrid({ items, onOpen, onCopy, renderActions, renderManagement, emptyText }: { items: Prompt[]; onOpen: (item: Prompt) => void; onCopy: (item: Prompt) => void; renderActions: (item: Prompt) => ReactNode; renderManagement: (item: Prompt) => ReactNode; emptyText: string }) {
    const { t } = useTranslation();
    return <div><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => onOpen(item)} onCopy={() => onCopy(item)} actionLabel={t("prompts.workspace.copyText")} extraAction={renderActions(item)} managementAction={renderManagement(item)} />)}</div>{items.length === 0 ? <div className="rounded-xl border border-border bg-card/50"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" /></div> : null}</div>;
}
