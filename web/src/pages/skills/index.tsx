import { Children, isValidElement, useMemo, useState, useEffect, type ReactNode } from "react";
import { App, Button, Empty, Input, Modal, Segmented, Switch, Tag } from "antd";
import { Blocks, Clapperboard, FileText, Pencil, Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
// streamdown 样式原来由 bootstrap 全局引入；为了让制作台首屏不加载 streamdown/mermaid，
// 全站样式改为各使用方按需引入（本页是懒加载路由，不影响首屏）。
import "streamdown/styles.css";

import { PageHeader } from "@/components/layout/page-header";
import { request } from "@/services/backend-api";
import { SkillMarket } from "./market";

type SkillFile = { path: string; content: string; revision: string; group: string; title: string; description: string };
type SkillFileResponse = { ok: boolean; path: string; content: string; revision: string };
type RuntimeInfo = { runtimeId: string; commit: string; patchVersion: string; version: string } | null;
type RuntimeModule = { id: string; enabled?: boolean; entry: string; reads: string[]; owns: string[]; checks_with: string[]; check_focus: string };
type RuntimeState = { active: RuntimeInfo; previous: RuntimeInfo; registry: { version: string; modules: RuntimeModule[]; revision: string }; sourceRevision: string };
type ModuleFilter = "all" | "enabled" | "disabled";

function resolveSkillLink(currentPath: string, href: string) {
    const base = currentPath.split("/").slice(0, -1);
    let decodedHref: string;
    try { decodedHref = decodeURIComponent(href); } catch { return ""; }
    for (const segment of decodedHref.split("#", 1)[0].split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") base.pop();
        else base.push(segment);
    }
    return base.join("/");
}

function markdownLinkHref(markdown: string, label: string) {
    const links = markdown.matchAll(/(?<!!)\[([^\]]+)\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g);
    for (const match of links) {
        if (match[1].trim() === label.trim()) return match[2].replace(/^<|>$/g, "");
    }
    return undefined;
}

function markdownText(node: ReactNode): string {
    return Children.toArray(node).map((child) => {
        if (typeof child === "string" || typeof child === "number") return String(child);
        return isValidElement<{ children?: ReactNode }>(child) ? markdownText(child.props.children) : "";
    }).join("").trim();
}

function AchengSkillManager() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [skills, setSkills] = useState<SkillFile[]>([]);
    const [runtime, setRuntime] = useState<RuntimeState>({ active: null, previous: null, registry: { version: "", modules: [], revision: "" }, sourceRevision: "" });
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [moduleFilter, setModuleFilter] = useState<ModuleFilter>("all");
    const [selected, setSelected] = useState<SkillFile | null>(null);
    const [file, setFile] = useState<{ path: string; content: string; revision: string } | null>(null);
    const [fileHistory, setFileHistory] = useState<Array<{ path: string; content: string; revision: string }>>([]);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [rollingBack, setRollingBack] = useState(false);
    const [busyModule, setBusyModule] = useState("");
    const [moduleUpdateStatus, setModuleUpdateStatus] = useState("");
    const load = async () => {
        setLoading(true);
        try {
            const response = await request<{ ok: boolean; data: SkillFile[] }>("GET", "/api/acheng-skills");
            setSkills(response.data || []);
            const runtimeResponse = await request<{ ok: boolean; data: RuntimeState }>("GET", "/api/acheng-skills/runtime");
            setRuntime(runtimeResponse.data);
        } catch (error) { message.error(error instanceof Error ? error.message : t("achengSkillManager.loadFailed")); }
        finally { setLoading(false); }
    };
    useEffect(() => { void load(); }, []);
    const items = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        return skills.filter((skill) => !keyword || `${skill.title} ${skill.description} ${skill.group} ${skill.path}`.toLocaleLowerCase().includes(keyword));
    }, [query, skills]);
    const moduleItems = runtime.registry.modules.flatMap((module) => {
        if (moduleFilter === "enabled" && module.enabled === false || moduleFilter === "disabled" && module.enabled !== false) return [];
        const skill = skills.find((candidate) => candidate.path === `.agents/skills/acheng-director/${module.entry}`);
        if (!skill) return [];
        const searchable = `${skill.title} ${skill.description} ${module.id} ${module.check_focus} ${module.reads.join(" ")} ${module.owns.join(" ")} ${module.checks_with.join(" ")}`.toLocaleLowerCase();
        return !query.trim() || searchable.includes(query.trim().toLocaleLowerCase()) ? [{ module, skill }] : [];
    });
    const moduleEntryPaths = new Set(runtime.registry.modules.map((module) => `.agents/skills/acheng-director/${module.entry}`));
    const otherItems = items.filter((skill) => !moduleEntryPaths.has(skill.path));
    const groups = [...new Set(otherItems.map((skill) => skill.group))];
    const visibleCount = moduleItems.length + otherItems.length;
    const openSkill = async (skill: SkillFile) => {
        setSelected(skill);
        setFileHistory([]);
        setEditing(false);
        try {
            const response = await request<SkillFileResponse>("GET", `/api/acheng-skills/file?path=${encodeURIComponent(skill.path)}`);
            setFile({ path: response.path, content: response.content, revision: response.revision });
        } catch (error) { message.error(error instanceof Error ? error.message : t("achengSkillManager.fileLoadFailed")); }
    };
    const openLinkedFile = async (href: string) => {
        if (!file || /^(?:[a-z]+:|\/\/|#)/i.test(href)) return;
        const [relative, fragment] = href.split("#", 2);
        const target = resolveSkillLink(file.path.split("#")[0], relative);
        if (!target.startsWith(".agents/skills/acheng-director/") && !target.startsWith(".agents/skills/canvas-video-production-sop/")) {
            message.warning(t("achengSkillManager.outsidePath"));
            return;
        }
        try {
            const response = await request<SkillFileResponse>("GET", `/api/acheng-skills/file?path=${encodeURIComponent(target)}`);
            setFileHistory((history) => file ? [...history, file] : history);
            setFile({ path: response.path + (fragment ? `#${fragment}` : ""), content: response.content, revision: response.revision });
            setEditing(false);
        } catch (error) { message.error(error instanceof Error ? error.message : t("achengSkillManager.linkFailed")); }
    };
    const backToPreviousFile = () => {
        const previous = fileHistory[fileHistory.length - 1];
        if (!previous) return;
        setFileHistory((history) => history.slice(0, -1));
        setFile(previous);
        setEditing(false);
    };
    const saveFile = async () => {
        if (!file) return;
        setSaving(true);
        try {
            const response = await request<SkillFileResponse>("PUT", "/api/acheng-skills/file", { path: file.path.split("#")[0], content: draft, expectedRevision: file.revision });
            setFile({ path: response.path, content: response.content, revision: response.revision });
            setEditing(false);
            await load();
            message.success(t("achengSkillManager.saved"));
        } catch (error) { message.error(error instanceof Error ? error.message : t("achengSkillManager.saveFailed")); }
        finally { setSaving(false); }
    };
    const rollbackRuntime = async () => {
        setRollingBack(true);
        try {
            const response = await request<{ ok: boolean; data: RuntimeState }>("POST", "/api/acheng-skills/runtime/rollback");
            setRuntime(response.data);
            message.success("已切换到上一验证版本");
        } catch (error) { message.error(error instanceof Error ? error.message : "回滚 Acheng 运行版本失败"); }
        finally { setRollingBack(false); }
    };
    const setModuleEnabled = async (module: RuntimeModule, enabled: boolean) => {
        setBusyModule(module.id);
        setModuleUpdateStatus(`正在${enabled ? "启用" : "禁用"} ${module.id}：更新注册表并验证 Acheng 运行包…`);
        try {
            const response = await request<{ ok: boolean; data: RuntimeState }>("POST", `/api/acheng-skills/modules/${encodeURIComponent(module.id)}/enabled`, { enabled, expectedRevision: runtime.sourceRevision });
            setRuntime(response.data);
            message.success(enabled ? `${module.id} 已启用并激活` : `${module.id} 已禁用并激活`);
        } catch (error) { message.error(error instanceof Error ? error.message : "更新模块启用状态失败"); }
        finally { setBusyModule(""); setModuleUpdateStatus(""); }
    };

    return (
        <div className="bg-background text-foreground">
            <main className="px-4 py-6 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-[1440px]">
                    <PageHeader
                        title={<span className="inline-flex items-center gap-2"><Sparkles className="size-5 text-primary" />{t("achengSkillManager.title")}</span>}
                        description={t("achengSkillManager.description")}
                        className="border-b border-border pb-5"
                        actions={<><Input allowClear value={query} onChange={(event) => setQuery(event.target.value)} prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("achengSkillManager.search")} className="w-full sm:w-72" /><Button onClick={() => void load()} loading={loading}>{t("achengSkillManager.refresh")}</Button></>}
                    />
                    <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <Tag bordered={false} color="gold">{t("achengSkillManager.count", { count: visibleCount })}</Tag>
                        <span>{t("achengSkillManager.source")} <code>.agents/skills/acheng-director</code> · <code>canvas-video-production-sop</code></span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
                        <div><span className="font-medium">当前激活 Acheng 运行版本：{runtime.active?.version || "未安装"}</span><span className="ml-2 font-mono text-xs text-muted-foreground">{runtime.active?.runtimeId || ""}</span><span className="ml-3 text-xs text-muted-foreground">模块注册表 v{runtime.registry.version} · {runtime.registry.modules.filter((module) => module.enabled !== false).length} 个启用模块</span></div>
                        {runtime.previous ? <Button size="small" loading={rollingBack} onClick={() => void rollbackRuntime()}>回滚到上一验证版本 {runtime.previous.version}</Button> : <span className="text-xs text-muted-foreground">暂无上一验证版本</span>}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2" aria-label="筛选模块启用状态">
                            <span className="mr-1 text-xs text-muted-foreground">模块状态</span>
                            {([
                                ["all", `全部 ${runtime.registry.modules.length}`],
                                ["enabled", `已启用 ${runtime.registry.modules.filter((module) => module.enabled !== false).length}`],
                                ["disabled", `已停用 ${runtime.registry.modules.filter((module) => module.enabled === false).length}`],
                            ] as const).map(([filter, label]) => <Button key={filter} size="small" type={moduleFilter === filter ? "primary" : "default"} onClick={() => setModuleFilter(filter)}>{label}</Button>)}
                        </div>
                        <span className="text-xs text-muted-foreground">切换模块会运行验证并生成新运行版本，等待期间可继续查看页面。</span>
                    </div>
                    {moduleUpdateStatus ? <div role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary"><span className="size-2 animate-pulse rounded-full bg-primary" />{moduleUpdateStatus}</div> : null}
                    {loading ? <div className="py-20 text-center text-sm text-muted-foreground">{t("achengSkillManager.loading")}</div> : moduleItems.length || otherItems.length ? <>
                        {moduleItems.length ? <section className="mt-7" aria-label="Acheng 七个创作模块">
                            <h2 className="mb-1 flex items-center gap-2 text-base font-semibold"><Clapperboard className="size-4 text-primary" />七个创作模块<span className="text-xs font-normal text-muted-foreground">{moduleItems.length} / {runtime.registry.modules.length}</span></h2>
                            <p className="mb-3 text-xs text-muted-foreground">按模块注册表启停。切换后会验证并激活一份新的 Acheng 运行版本。</p>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {moduleItems.map(({ module, skill }) => (
                                    <article key={module.id} className={`flex min-h-48 flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 ${module.enabled === false ? "opacity-60" : ""}`}>
                                        <div className="flex items-start gap-3">
                                        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><FileText className="size-5" /></span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-start justify-between gap-2"><span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{module.id}</span><Tag bordered={false} color={module.enabled === false ? "default" : "green"}>{module.enabled === false ? "已停用" : "已启用"}</Tag></div>
                                            <button type="button" onClick={() => void openSkill(skill)} className="mt-1 line-clamp-2 text-left text-sm font-semibold leading-5 hover:text-primary">{skill.title}</button>
                                        </div>
                                        </div>
                                        <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description}</p>
                                        <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">读取 {module.reads.length} 份关联规范{module.checks_with.length ? ` · 协同 ${module.checks_with.join("、")}` : ""}</p>
                                        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
                                            <span className="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="small" checked={module.enabled !== false} loading={busyModule === module.id} disabled={Boolean(busyModule) || rollingBack} onChange={(checked) => void setModuleEnabled(module, checked)} />启用模块</span>
                                            <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => void openSkill(skill)}>{t("achengSkillManager.edit")}</Button>
                                        </div>
                                    </article>
                                ))}
                            </div>
                        </section> : null}
                        {groups.map((group) => (
                            <section key={group} className="mt-8" aria-label={group}>
                                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Clapperboard className="size-4 text-primary" />{group}<span className="text-xs font-normal text-muted-foreground">{otherItems.filter((skill) => skill.group === group).length}</span></h2>
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                                    {otherItems.filter((skill) => skill.group === group).map((skill) => (
                                        <article key={skill.path} className="group flex min-h-40 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50">
                                            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><FileText className="size-5" /></span>
                                            <span className="min-w-0 flex-1">
                                                <button type="button" onClick={() => void openSkill(skill)} className="line-clamp-2 text-left font-semibold leading-5 hover:text-primary">{skill.title}</button>
                                                <span className="mt-2 line-clamp-3 block text-xs leading-5 text-muted-foreground">{skill.description}</span>
                                                <span className="mt-3 block truncate font-mono text-[10px] text-muted-foreground/80">{skill.path.replace(/^.*?\.agents\/skills\//, ".agents/skills/")}</span>
                                                <span className="mt-3 flex items-center justify-end border-t border-border pt-2"><Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => void openSkill(skill)}>{t("achengSkillManager.edit")}</Button></span>
                                            </span>
                                        </article>
                                    ))}
                                </div>
                            </section>
                        ))}
                    </> : <Empty className="py-20" description={query ? t("achengSkillManager.noMatch") : t("achengSkillManager.empty")} />}
                </div>
            </main>
            <Modal title={file?.path || selected?.title} open={Boolean(selected)} onCancel={() => { setSelected(null); setFile(null); setFileHistory([]); setEditing(false); }} width={960} styles={{ body: { maxHeight: "72vh", overflow: "auto" } }} footer={file ? <div className="flex justify-between"><span className="flex gap-2"><Button disabled={!fileHistory.length} onClick={backToPreviousFile}>返回上个文件</Button><Button onClick={() => { setEditing((current) => !current); setDraft(file.content); }}>{editing ? t("achengSkillManager.cancelEdit") : t("achengSkillManager.editFile")}</Button></span><span className="flex gap-2">{editing ? <><Button onClick={() => { setEditing(false); setDraft(file.content); }}>{t("achengSkillManager.discard")}</Button><Button type="primary" loading={saving} onClick={() => void saveFile()}>{t("achengSkillManager.save")}</Button></> : <Button onClick={() => setSelected(null)}>{t("achengSkillManager.done")}</Button>}</span></div> : null}>
                {file && !editing ? <div className="acheng-skill-markdown rounded-lg border border-border bg-card p-5"><Streamdown urlTransform={(url) => url} components={{ a: ({ href, children, ...props }) => {
                    const linkHref = markdownLinkHref(file.content, markdownText(children)) || href;
                    return <a {...props} href={href} onClick={(event) => { if (linkHref && !/^(?:[a-z]+:|\/\/|#)/i.test(linkHref)) { event.preventDefault(); void openLinkedFile(linkHref); } }} className="text-primary underline underline-offset-2">{children}</a>;
                } }}>{file.content}</Streamdown></div> : null}
                {file && editing ? <Input.TextArea value={draft} onChange={(event) => setDraft(event.target.value)} autoSize={{ minRows: 22 }} className="font-mono text-xs leading-5" /> : null}
            </Modal>
        </div>
    );
}

export default function SkillsPage() {
    const { t } = useTranslation();
    const [view, setView] = useState<"market" | "acheng">("market");
    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            <div className="shrink-0 border-b border-border px-4 pt-4 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-[1440px]">
                    <Segmented value={view} onChange={(value) => setView(value as "market" | "acheng")}
                        options={[{ label: <span className="inline-flex items-center gap-1.5"><Blocks className="size-3.5" />{t("skillMarket.title")}</span>, value: "market" }, { label: <span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5" />{t("achengSkillManager.title")}</span>, value: "acheng" }]}
                        data-testid="skills-view-switch" />
                </div>
            </div>
            <main className="min-h-0 flex-1 overflow-y-auto">
                {view === "market" ? <SkillMarket /> : <AchengSkillManager />}
            </main>
        </div>
    );
}
