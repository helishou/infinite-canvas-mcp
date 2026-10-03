import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Skeleton } from "antd";
import { ArrowRight, Clapperboard, ExternalLink, Images, Plus, RefreshCw, Search } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createBackendProject, fetchBackendProjects } from "@/services/backend-api";

type Project = { id: string; title: string; updatedAt: string };

export default function DirectorPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [projects, setProjects] = useState<Project[]>([]);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [reload, setReload] = useState(0);
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const requestId = useRef("");
    const submittedName = useRef("");
    useEffect(() => {
        let active = true; setLoading(true); setError("");
        void fetchBackendProjects(true).then(result => {
            if (active) setProjects((result.projects || []).map(p => ({ id: String(p.id), title: String(p.title || p.id), updatedAt: String(p.updatedAt || "") })));
        }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [reload]);
    const visible = useMemo(() => projects.filter(p => p.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
        .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), [projects, query]);
    const begin = () => { requestId.current = crypto.randomUUID(); submittedName.current = ""; setName(""); setCreateOpen(true); };
    const create = async () => {
        if (creating || !name.trim()) return;
        setCreating(true);
        if (!submittedName.current) submittedName.current = name.trim();
        try {
            // Stable ID survives a lost response. Reopening the dialog is a new request.
            const result = await createBackendProject({ id: requestId.current, title: submittedName.current, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "" });
            if (!result.project?.id) throw new Error(t("director.createFailed"));
            navigate(`/director/${encodeURIComponent(String(result.project.id))}`);
        } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)); }
        finally { setCreating(false); }
    };
    return <main className="min-h-full bg-background px-4 py-8 text-foreground sm:px-6 lg:px-10" data-testid="director-home">
        <div className="mx-auto max-w-6xl">
            <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
                <div><p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">Acheng Director</p>
                    <h1 className="text-3xl font-semibold tracking-tight">{t("director.title")}</h1>
                    <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{t("director.subtitle")}</p></div>
                <div className="flex flex-wrap gap-2">
                    <Link to="/canvas"><Button icon={<Images className="size-4" />}>{t("director.canvasLibrary")}</Button></Link>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={begin}>{t("director.new")}</Button>
                </div>
            </header>
            <div className="mb-8 grid gap-4 border-y border-border py-5 sm:grid-cols-3">
                {["assets", "film", "episode"].map(kind => <div key={kind}><h2 className="text-sm font-semibold">{t(`director.${kind}`)}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t(`director.${kind}Hint`)}</p></div>)}
            </div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t("director.projects")}</h2>
                <div className="flex gap-2"><Input aria-label={t("director.search")} prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("director.search")} value={query} onChange={e => setQuery(e.target.value)} allowClear />
                    <Button aria-label={t("director.refresh")} icon={<RefreshCw className="size-4" />} onClick={() => setReload(n => n + 1)} disabled={loading} /></div></div>
            {error ? <Alert type="error" showIcon message={t("director.loadFailed")} description={error} /> : loading ? <Skeleton active /> : !visible.length ? <Empty description={query ? t("director.noMatch") : t("director.empty")} /> :
                <div className="divide-y divide-border">{visible.map(project => <article key={project.id} className="flex min-w-0 items-center gap-3 py-3 sm:gap-4">
                    <Link to={`/director/${encodeURIComponent(project.id)}`} className="group flex min-w-0 flex-1 items-center gap-4 py-1 transition-colors hover:text-foreground">
                        <Clapperboard className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><h3 className="truncate font-medium">{project.title}</h3>
                            <p className="mt-1 text-xs text-muted-foreground">{Number.isFinite(Date.parse(project.updatedAt)) ? new Date(project.updatedAt).toLocaleString(i18n.resolvedLanguage) : t("director.ready")}</p></div>
                        <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground group-hover:text-foreground">{t("director.continue")}<ArrowRight className="size-4" /></span>
                    </Link>
                    <Link to={`/canvas/${encodeURIComponent(project.id)}`} aria-label={`${t("director.openCanvas")}: ${project.title}`} title={t("director.openCanvas")} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground">
                        <ExternalLink className="size-4" /><span className="hidden sm:inline">{t("director.openCanvas")}</span>
                    </Link>
                </article>)}</div>}
            <p className="mt-7 text-sm text-muted-foreground">{t("director.sharedData")} <Link className="underline underline-offset-4" to="/production?view=dramas">{t("director.manageDrama")}</Link></p>
        </div>
        <Modal title={t("director.new")} open={createOpen} onCancel={() => { if (!creating) setCreateOpen(false); }} onOk={() => void create()} confirmLoading={creating} okButtonProps={{ disabled: !name.trim() }} okText={t("director.enter")}>
            <p className="mb-4 text-sm text-muted-foreground">{t("director.newHint")}</p>
            <Input aria-label={t("director.name")} placeholder={t("director.name")} value={name} disabled={creating || Boolean(submittedName.current)} onChange={e => setName(e.target.value)} onPressEnter={() => void create()} />
        </Modal>
    </main>;
}
