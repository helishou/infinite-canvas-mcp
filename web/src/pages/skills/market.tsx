import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Drawer, Empty, Input, Segmented, Select, Spin, Switch, Tag, Upload } from "antd";
import { Bookmark, Boxes, Check, Download, FileArchive, FileText, Heart, Plus, RefreshCw, Search, Trash2, UploadCloud } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";

import {
    fetchMarketSkills, fetchSkillDetail, fileToBase64, installMarketSkill, readSkillFrontmatter, splitSkillFrontmatter,
    uninstallMarketSkill, updateSkillState, type MarketSkill, type SkillCategory, type UploadFileEntry,
} from "@/services/api/skill-market";

const CATEGORIES: SkillCategory[] = ["drama", "ecommerce", "creative", "social", "others"];

type Scope = "all" | "mine" | "created" | "favorites";
type Sort = "popular" | "newest" | "updated";

const categoryTone: Record<SkillCategory, string> = {
    drama: "blue", ecommerce: "gold", creative: "purple", social: "green", others: "default",
};

function accentFor(category: SkillCategory) {
    return categoryTone[category] || "default";
}

function SkillCard({ skill, onOpen, onToggleAdd, onToggleLike }: {
    skill: MarketSkill;
    onOpen: () => void;
    onToggleAdd: () => void;
    onToggleLike: () => void;
}) {
    const { t } = useTranslation();
    return (
        <article className="group relative flex min-h-[172px] flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/60" data-testid="market-skill-card" data-skill={skill.name}>
            <div className="flex items-start gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-lg font-medium text-primary" aria-hidden>{skill.glyph}</span>
                <div className="min-w-0 flex-1">
                    <button type="button" onClick={onOpen} className="line-clamp-1 text-left text-sm font-semibold leading-5 hover:text-primary" data-testid="market-card-title">{skill.title}</button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Tag bordered={false} color={accentFor(skill.tag)} className="!m-0">{t(`skillMarket.category.${skill.tag}`)}</Tag>
                        <span className="text-[11px] text-muted-foreground">{t(`skillMarket.source.${skill.source}`)}</span>
                        {skill.version ? <span className="font-mono text-[10px] text-muted-foreground">v{skill.version}</span> : null}
                    </div>
                </div>
                <button type="button" aria-label={t("skillMarket.card.like")} data-testid="market-card-like" onClick={onToggleLike}
                    className={`grid size-8 shrink-0 place-items-center rounded-full border transition-colors ${skill.liked ? "border-rose-400/50 bg-rose-500/10 text-rose-500" : "border-border text-muted-foreground hover:text-rose-500"}`}>
                    <Heart className={`size-4 ${skill.liked ? "fill-current" : ""}`} />
                </button>
            </div>
            <p className="mt-3 line-clamp-3 flex-1 text-xs leading-5 text-muted-foreground">{skill.description}</p>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><FileText className="size-3.5" />{t("skillMarket.card.files", { count: skill.fileCount })}</span>
                <div className="flex items-center gap-2">
                    <Button type="text" size="small" onClick={onOpen} data-testid="market-card-detail">{t("skillMarket.card.detail")}</Button>
                    {skill.builtin ? (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Check className="size-3.5" />{t("skillMarket.card.added")}</span>
                    ) : (
                        <Button size="small" type={skill.added ? "default" : "primary"} icon={skill.added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />} onClick={onToggleAdd} data-testid="market-card-add">
                            {t(skill.added ? "skillMarket.card.added" : "skillMarket.card.add")}
                        </Button>
                    )}
                </div>
            </div>
        </article>
    );
}

function InstallModal({ open, onClose, onInstalled }: { open: boolean; onClose: () => void; onInstalled: (skill: MarketSkill) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [mode, setMode] = useState<"markdown" | "zip">("markdown");
    const [fileList, setFileList] = useState<any[]>([]);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [tag, setTag] = useState<SkillCategory>("creative");
    const [installing, setInstalling] = useState(false);

    useEffect(() => {
        if (!open) return;
        setMode("markdown"); setFileList([]); setName(""); setDescription(""); setTag("creative");
    }, [open]);

    const pickFile = async (file: File) => {
        if (file.size > 20 * 1024 * 1024) { message.error(t("skillMarket.installModal.tooLarge")); return; }
        const meta = /\.md$/i.test(file.name) ? readSkillFrontmatter(await file.text()) : {};
        setName(meta.name || file.name.replace(/\.(md|markdown|zip)$/i, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase());
        if (meta.description) setDescription(meta.description);
        setFileList([file]);
    };

    const install = async () => {
        const file = fileList[0] as File | undefined;
        if (!file) { message.warning(t("skillMarket.installModal.needFile")); return; }
        setInstalling(true);
        try {
            const files: UploadFileEntry[] = [];
            if (mode === "markdown") {
                files.push({ path: "SKILL.md", contentBase64: await fileToBase64(file) });
            } else {
                const { unzipSync, strFromU8 } = await import("fflate");
                const bytes = new Uint8Array(await file.arrayBuffer());
                const entries = unzipSync(bytes);
                for (const [entryPath, content] of Object.entries(entries)) {
                    if (entryPath.endsWith("/")) continue;
                    files.push({ path: entryPath, contentBase64: btoa(strFromU8(content, true)) });
                }
            }
            const skill = await installMarketSkill({ name: name.trim(), source: mode, tag, files });
            message.success(t("skillMarket.installModal.success"));
            onInstalled(skill);
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("skillMarket.installModal.failed"));
        } finally { setInstalling(false); }
    };

    return (
        <Drawer open={open} onClose={onClose} title={t("skillMarket.installModal.title")} width={520} destroyOnHidden
            footer={<div className="flex justify-end gap-2"><Button onClick={onClose}>{t("achengSkillManager.cancelEdit")}</Button><Button type="primary" loading={installing} onClick={() => void install()} data-testid="market-install-confirm">{t("skillMarket.install")}</Button></div>}>
            <p className="mb-4 text-xs leading-6 text-muted-foreground">{t("skillMarket.installModal.hint")}</p>
            <Segmented block value={mode} onChange={(value) => { setMode(value as "markdown" | "zip"); setFileList([]); }}
                options={[{ label: t("skillMarket.installModal.markdown"), value: "markdown" }, { label: t("skillMarket.installModal.zip"), value: "zip" }]} data-testid="market-install-mode" />
            <div className="mt-5">
                <Upload.Dragger accept={mode === "zip" ? ".zip" : ".md,.markdown"} maxCount={1} fileList={fileList.map(file => ({ uid: file.name, name: file.name, status: "done" }))}
                    beforeUpload={(file) => { void pickFile(file as File); return false; }}
                    onChange={({ fileList: next }) => { if (!next.length) setFileList([]); }} onRemove={() => { setFileList([]); return true; }}>
                    {mode === "zip" ? <FileArchive className="mx-auto mb-2 size-8 text-muted-foreground" /> : <UploadCloud className="mx-auto mb-2 size-8 text-muted-foreground" />}
                    <div className="text-sm font-medium">{t(mode === "zip" ? "skillMarket.installModal.dropZip" : "skillMarket.installModal.dropMd")}</div>
                </Upload.Dragger>
            </div>
            <div className="mt-5 grid gap-4">
                <label className="block"><span className="mb-1 block text-xs text-muted-foreground">{t("skillMarket.installModal.name")}</span>
                    <Input value={name} onChange={event => setName(event.target.value)} placeholder={t("skillMarket.installModal.nameHint")} data-testid="market-install-name" /></label>
                <label className="block"><span className="mb-1 block text-xs text-muted-foreground">{t("skillMarket.installModal.description")}</span>
                    <Input value={description} onChange={event => setDescription(event.target.value)} placeholder={t("skillMarket.installModal.descriptionHint")} /></label>
                <label className="block"><span className="mb-1 block text-xs text-muted-foreground">{t("skillMarket.installModal.category")}</span>
                    <Select value={tag} onChange={setTag} className="w-full" data-testid="market-install-category"
                        options={CATEGORIES.map(category => ({ value: category, label: t(`skillMarket.category.${category}`) }))} /></label>
            </div>
        </Drawer>
    );
}

function SkillDetailDrawer({ skill, onClose, onChanged }: { skill: MarketSkill | null; onClose: () => void; onChanged: (skill: MarketSkill, revision: string) => void }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const [detail, setDetail] = useState<{ content: string; files: string[] } | null>(null);
    const [sourceView, setSourceView] = useState(false);

    useEffect(() => {
        if (!skill) { setDetail(null); return; }
        let cancelled = false;
        void fetchSkillDetail(skill.name).then(result => { if (!cancelled) setDetail({ content: result.content, files: result.files }); })
            .catch(error => message.error(error instanceof Error ? error.message : t("achengSkillManager.fileLoadFailed")));
        return () => { cancelled = true; };
    }, [skill, message, t]);

    const patch = async (update: Partial<Pick<MarketSkill, "liked" | "added" | "autoUpdate">>) => {
        if (!skill) return;
        try {
            const list = await fetchMarketSkills();
            const result = await updateSkillState({ name: skill.name, revision: list.revision, patch: update });
            onChanged({ ...skill, ...update } as MarketSkill, result.revision);
        } catch (error) { message.error(error instanceof Error ? error.message : t("skillMarket.stateFailed")); }
    };

    const uninstall = () => {
        if (!skill) return;
        modal.confirm({
            title: t("skillMarket.detail.uninstall"), content: t("skillMarket.detail.uninstallConfirm"), okType: "danger",
            onOk: async () => {
                try { await uninstallMarketSkill(skill.name); message.success(t("skillMarket.uninstallSuccess")); onClose(); }
                catch (error) { message.error(error instanceof Error ? error.message : t("skillMarket.stateFailed")); }
            },
        });
    };

    return (
        <Drawer open={Boolean(skill)} onClose={onClose} title={skill?.title || t("skillMarket.detail.title")} width={760}
            extra={skill ? <div className="flex items-center gap-2">
                <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void patch({ added: true })} data-testid="market-detail-add">{t(skill.added ? "skillMarket.detail.installed" : "skillMarket.detail.notInstalled")}</Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={skill.builtin} title={skill.builtin ? t("skillMarket.detail.uninstallBuiltin") : undefined} onClick={uninstall} data-testid="market-detail-uninstall">{t("skillMarket.card.uninstall")}</Button>
            </div> : null}>
            {skill ? <>
                <p className="mb-4 text-sm leading-6 text-muted-foreground">{skill.description}</p>
                <div className="mb-4 flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
                    <span className="text-muted-foreground">{t("skillMarket.detail.autoUpdate")} · {t("skillMarket.detail.autoUpdateHint")}</span>
                    <Switch size="small" checked={skill.autoUpdate} onChange={checked => void patch({ autoUpdate: checked })} data-testid="market-detail-auto" />
                </div>
                <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium">{t("skillMarket.detail.files")}</span>
                    <Segmented size="small" value={sourceView ? "source" : "preview"} onChange={value => setSourceView(value === "source")}
                        options={[{ label: t("skillMarket.detail.preview"), value: "preview" }, { label: t("skillMarket.detail.source"), value: "source" }]} />
                </div>
                {detail ? <>
                    <div className="mb-3 flex flex-wrap gap-1.5">{detail.files.map(file => <Tag key={file} bordered={false} className="!m-0 font-mono text-[10px]"><FileText className="mr-1 inline size-3" />{file}</Tag>)}</div>
                    {sourceView ? <pre className="max-h-[52vh] overflow-auto rounded-lg border border-border bg-muted/30 p-4 font-mono text-[11px] leading-5" data-testid="market-detail-source">{detail.content}</pre>
                        : <div className="skill-market-markdown max-h-[52vh] overflow-auto rounded-lg border border-border bg-card p-5" data-testid="market-detail-preview"><Streamdown urlTransform={(url) => url}>{splitSkillFrontmatter(detail.content).body}</Streamdown></div>}
                </> : <div className="grid place-items-center py-16"><Spin /></div>}
            </> : null}
        </Drawer>
    );
}

export function SkillMarket() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [skills, setSkills] = useState<MarketSkill[]>([]);
    const [revision, setRevision] = useState("");
    const [loading, setLoading] = useState(true);
    const [scope, setScope] = useState<Scope>("all");
    const [category, setCategory] = useState<SkillCategory | "all">("all");
    const [sort, setSort] = useState<Sort>("popular");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<MarketSkill | null>(null);
    const [installOpen, setInstallOpen] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await fetchMarketSkills();
            setSkills(result.skills);
            setRevision(result.revision);
        } catch (error) { message.error(error instanceof Error ? error.message : t("skillMarket.loadFailed")); }
        finally { setLoading(false); }
    }, [message, t]);
    useEffect(() => { void load(); }, [load]);

    const counts = useMemo(() => ({
        all: skills.length,
        mine: skills.filter(skill => skill.added).length,
        created: skills.filter(skill => skill.source === "markdown" || skill.source === "zip").length,
        favorites: skills.filter(skill => skill.liked).length,
    }), [skills]);

    const visible = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        const filtered = skills.filter(skill => {
            if (scope === "mine" && !skill.added) return false;
            if (scope === "created" && skill.source === "builtin") return false;
            if (scope === "favorites" && !skill.liked) return false;
            if (category !== "all" && skill.tag !== category) return false;
            return !keyword || `${skill.title} ${skill.description} ${skill.name}`.toLocaleLowerCase().includes(keyword);
        });
        return filtered.sort((a, b) => {
            if (sort === "newest") return b.name.localeCompare(a.name);
            if (sort === "updated") return b.installedAt.localeCompare(a.installedAt);
            return Number(b.added) - Number(a.added) || Number(b.liked) - Number(a.liked) || a.name.localeCompare(b.name);
        });
    }, [skills, scope, category, sort, query]);

    const changeState = async (skill: MarketSkill, patch: Partial<Pick<MarketSkill, "liked" | "added">>) => {
        try {
            const current = await fetchMarketSkills();
            const result = await updateSkillState({ name: skill.name, revision: current.revision, patch });
            setSkills(previous => previous.map(item => item.name === skill.name ? { ...item, ...patch } : item));
            setRevision(result.revision);
            setSelected(previous => previous && previous.name === skill.name ? { ...previous, ...patch } : previous);
        } catch (error) { message.error(error instanceof Error ? error.message : t("skillMarket.stateFailed")); }
    };

    return (
        <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8" data-testid="skill-market">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-xl font-semibold"><Boxes className="size-5 text-primary" />{t("skillMarket.title")}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">{t("skillMarket.subtitle")}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Input allowClear value={query} onChange={event => setQuery(event.target.value)} prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("skillMarket.search")} className="w-56" data-testid="market-search" />
                    <Select value={sort} onChange={setSort} className="w-32" data-testid="market-sort" options={(["popular", "newest", "updated"] as Sort[]).map(value => ({ value, label: t(`skillMarket.sort.${value}`) }))} />
                    <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void load()} loading={loading} aria-label={t("skillMarket.refresh")} />
                    <Button type="primary" icon={<Plus className="size-3.5" />} onClick={() => setInstallOpen(true)} data-testid="market-install-open">{t("skillMarket.install")}</Button>
                </div>
            </div>

            <div className="mt-5 flex gap-5">
                <aside className="hidden w-44 shrink-0 lg:block" aria-label={t("skillMarket.category.all")}>
                    <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">{t("skillMarket.scope.all")}</p>
                    <nav className="space-y-0.5">
                        {(["all", "mine", "created", "favorites"] as Scope[]).map(value => (
                            <button key={value} type="button" data-testid={`market-scope-${value}`} onClick={() => setScope(value)}
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${scope === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                                <span>{t(`skillMarket.scope.${value}`)}</span><span className="text-[10px]">{counts[value]}</span>
                            </button>
                        ))}
                    </nav>
                    <p className="mb-2 mt-5 text-[11px] uppercase tracking-wide text-muted-foreground">{t("skillMarket.category.all")}</p>
                    <nav className="space-y-0.5">
                        {(["all", ...CATEGORIES] as Array<SkillCategory | "all">).map(value => (
                            <button key={value} type="button" data-testid={`market-category-${value}`} onClick={() => setCategory(value)}
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${category === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                                <span>{t(`skillMarket.category.${value}`)}</span>
                            </button>
                        ))}
                    </nav>
                </aside>

                <section className="min-w-0 flex-1">
                    <div className="mb-3 flex gap-1.5 lg:hidden">
                        <Segmented size="small" value={scope} onChange={value => setScope(value as Scope)}
                            options={(["all", "mine", "created", "favorites"] as Scope[]).map(value => ({ value, label: t(`skillMarket.scope.${value}`) }))} />
                    </div>
                    <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Bookmark className="size-3.5" />{t("skillMarket.count", { count: visible.length })}</div>
                    {loading ? <div className="grid place-items-center py-24"><Spin /></div>
                        : visible.length ? (
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="market-grid">
                                {visible.map(skill => <SkillCard key={skill.name} skill={skill}
                                    onOpen={() => setSelected(skill)}
                                    onToggleAdd={() => void changeState(skill, { added: !skill.added })}
                                    onToggleLike={() => void changeState(skill, { liked: !skill.liked })} />)}
                            </div>
                        ) : <Empty className="py-24" description={t(query ? "skillMarket.card.noMatch" : "skillMarket.card.empty")} />}
                </section>
            </div>

            <InstallModal open={installOpen} onClose={() => setInstallOpen(false)} onInstalled={() => void load()} />
            <SkillDetailDrawer skill={selected} onClose={() => setSelected(null)} onChanged={(updated, nextRevision) => {
                setRevision(nextRevision);
                setSkills(previous => previous.map(item => item.name === updated.name ? updated : item));
            }} />
        </div>
    );
}
