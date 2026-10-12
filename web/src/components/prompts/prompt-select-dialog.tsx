import { ArrowDownToLine, Search } from "lucide-react";
import { type UIEvent, useEffect, useState } from "react";
import { App, Button, Empty, Input, Modal, Spin, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { ALL_PROMPTS_OPTION } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { PromptCard } from "./prompt-card";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const { query, items, tags: promptTags, categories: promptCategories } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, enabled: open });
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = (prompt: string) => {
        onSelect(prompt);
        onOpenChange(false);
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <Modal title={t("prompts.library")} open={open} onCancel={() => onOpenChange(false)} footer={null} width={880} centered>
            <p className="mb-4 text-xs leading-5 text-muted-foreground">{t("prompts.workspace.insertTextHint")}</p>
            <div className="flex h-[62dvh] min-h-0 flex-col gap-4 sm:grid sm:grid-cols-[180px_minmax(0,1fr)]" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                <aside className="min-h-0 shrink-0 border-b border-border pb-3 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
                    <button type="button" className="flex w-full items-center justify-between gap-3 text-left text-sm sm:hidden" aria-expanded={filtersExpanded} aria-controls="prompt-select-filters" onClick={() => setFiltersExpanded((value) => !value)}>
                        <span>{t("prompts.workspace.filterScope")}</span><span className="text-xs text-muted-foreground">{t(filtersExpanded ? "prompts.workspace.hideFilters" : "prompts.workspace.showFilters")}</span>
                    </button>
                    <div id="prompt-select-filters" className={cn("thin-scrollbar max-h-44 overflow-y-auto pt-3 sm:h-full sm:max-h-none sm:pt-0", !filtersExpanded && "hidden sm:block")}>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("prompts.category")}</div>
                    <div className="flex flex-wrap gap-1.5">
                        {promptCategories.map((category) => (
                            <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>
                                {category === ALL_PROMPTS_OPTION ? t("common.all") : category}
                            </Tag.CheckableTag>
                        ))}
                    </div>
                    <div className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("prompts.tags")}</div>
                    <div className="flex flex-wrap gap-1.5">
                        {promptTags.map((tag) => {
                            const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                            return (
                                <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                    {tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}
                                </Tag.CheckableTag>
                            );
                        })}
                    </div>
                    </div>
                </aside>
                <section className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <Input size="large" allowClear aria-label={t("prompts.searchTitle")} prefix={<Search className="size-4 text-muted-foreground" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("prompts.searchTitle")} />
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{t("prompts.workspace.source")}: {selectedCategory === ALL_PROMPTS_OPTION ? t("common.all") : selectedCategory}</span>
                        {selectedTags.map((tag) => <Tag key={tag} closable onClose={() => toggleTag(tag)} className="!m-0 max-w-full !whitespace-normal">{tag}</Tag>)}
                        {keyword || selectedTags.length || selectedCategory !== ALL_PROMPTS_OPTION ? <Button type="text" size="small" onClick={() => { setKeyword(""); setSelectedTags([]); setSelectedCategory(ALL_PROMPTS_OPTION); }}>{t("prompts.workspace.clearFilters")}</Button> : null}
                    </div>
                    <div className="thin-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                        {query.isLoading ? (
                            <div className="flex h-40 items-center justify-center">
                                <Spin />
                            </div>
                        ) : null}
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                            {items.map((item) => (
                                <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => selectPrompt(item.prompt)} onCopy={() => selectPrompt(item.prompt)} actionLabel={t("prompts.workspace.usePrompt")} actionIcon={<ArrowDownToLine className="size-3.5" />} actionType="primary" compact />
                            ))}
                        </div>
                        {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.empty")} className="py-8" /> : null}
                        {query.isFetchingNextPage ? (
                            <div className="py-4 text-center">
                                <Spin size="small" />
                            </div>
                        ) : null}
                    </div>
                </section>
            </div>
        </Modal>
    );
}
