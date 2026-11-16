import { App, Button, Input, Select, Tag } from "antd";
import { Check, ClipboardCopy, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Asset } from "@/stores/use-asset-store";
import { fetchAssetSpec, updateAssetSpec, type AssetSpec, type AssetSpecKind } from "@/services/backend-api";
import { PlanningEmpty, PlanningSection, PlanningToolbar } from "./planning-ui";
import { AssetSpecFields, SPEC_KINDS } from "./asset-spec-fields";

/**
 * 角色 / 场景 / 道具设定卡：字段与导演大师一致，三类各用一套技能与提示词骨架。
 * 数据落在资产自身（asset.metadata.assetSpec），这里只负责编辑与预览。
 */

type SpecState = {
    spec: AssetSpec | null;
    prompt: string;
    missing: string[];
    skill: string;
    imageKind: string;
    loading: boolean;
    saving: boolean;
};

const emptyState = (): SpecState => ({ spec: null, prompt: "", missing: [], skill: "", imageKind: "", loading: false, saving: false });

function titleOf(asset: Asset) {
    const data = asset.data as { name?: string } | undefined;
    return data?.name || asset.title || asset.id;
}

function kindOf(asset: Asset): AssetSpecKind | null {
    const kind = String(asset.kind);
    return (SPEC_KINDS as string[]).includes(kind) ? kind as AssetSpecKind : null;
}

function patchField(spec: AssetSpec | null, kind: AssetSpecKind, key: string, value: string): AssetSpec {
    const base = (spec || { kind }) as AssetSpec;
    const bucket = { ...((base as Record<string, unknown>)[kind] as Record<string, unknown> | undefined) };
    bucket[key] = value;
    return { ...base, kind, [kind]: bucket } as AssetSpec;
}

export function AssetSpecPanel({ assets }: { assets: Asset[] }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const candidates = assets.filter((asset) => kindOf(asset));
    const [openId, setOpenId] = useState<string | null>(null);
    const [states, setStates] = useState<Record<string, SpecState>>({});

    const stateOf = (id: string) => states[id] || emptyState();
    const patchState = (id: string, patch: Partial<SpecState>) => setStates((current) => ({ ...current, [id]: { ...(current[id] || emptyState()), ...patch } }));

    const load = useCallback(async (asset: Asset) => {
        patchState(asset.id, { loading: true });
        try {
            const result = await fetchAssetSpec(asset.id);
            patchState(asset.id, { spec: result.spec, prompt: result.prompt || "", missing: result.missing || [], skill: result.readiness?.skill?.path || "", imageKind: result.readiness?.skill?.imageKind || "", loading: false });
        } catch (error) {
            patchState(asset.id, { loading: false });
            message.error(error instanceof Error ? error.message : String(error));
        }
    }, [message]);

    const open = (asset: Asset) => {
        const next = openId === asset.id ? null : asset.id;
        setOpenId(next);
        if (next && !states[asset.id]?.spec) void load(asset);
    };

    const save = async (asset: Asset, kind: AssetSpecKind) => {
        const state = stateOf(asset.id);
        if (!state.spec) return;
        patchState(asset.id, { saving: true });
        try {
            const bucket = (state.spec as Record<string, unknown>)[kind] as Record<string, unknown> | undefined;
            const result = await updateAssetSpec(asset.id, { kind, spec: bucket || {}, wantPrompt: true });
            patchState(asset.id, { spec: result.spec, prompt: result.prompt || "", missing: result.missing || [], saving: false });
            message.success(t("assetSpec.saved"));
        } catch (error) {
            patchState(asset.id, { saving: false });
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    const copyPrompt = async (text: string) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            message.success(t("assetSpec.copied"));
        } catch {
            message.error(t("assetSpec.copyFailed"));
        }
    };

    if (!candidates.length) {
        return <div className="pt-1" data-planning-asset-spec="empty">
            <PlanningEmpty text={t("assetSpec.empty")} />
        </div>;
    }

    const readyCount = candidates.filter((asset) => {
        const state = stateOf(asset.id);
        return state.spec && state.missing.length === 0;
    }).length;

    return <div className="space-y-3 pt-1" data-planning-asset-spec>
        <PlanningToolbar>
            <span className="text-[13px] font-semibold">{t("assetSpec.title")}</span>
            <span className="text-[11px] text-muted-foreground">{t("assetSpec.progress", { ready: readyCount, total: candidates.length })}</span>
            <span className="min-w-0 flex-1" />
            {SPEC_KINDS.map((kind) => <span key={kind} className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t(`assetSpec.kind.${kind}`)} {candidates.filter((asset) => kindOf(asset) === kind).length}
            </span>)}
        </PlanningToolbar>

        {SPEC_KINDS.map((kind) => {
            const list = candidates.filter((asset) => kindOf(asset) === kind);
            if (!list.length) return null;
            return <PlanningSection key={kind} title={t(`assetSpec.kind.${kind}`)} hint={t(`assetSpec.kindHint.${kind}`)} part={`spec-${kind}`}>
                <div className="space-y-2">
                    {list.map((asset) => {
                        const state = stateOf(asset.id);
                        const expanded = openId === asset.id;
                        const done = Boolean(state.spec) && state.missing.length === 0;
                        return <div key={asset.id} className={`overflow-hidden rounded-xl border transition-colors ${expanded ? "border-primary/40 bg-muted/[0.14]" : "border-border/70 bg-muted/[0.06] hover:bg-muted/[0.12]"}`}
                            data-asset-spec-row={asset.id} data-state={done ? "done" : state.spec ? "partial" : "empty"}>
                            <button type="button" onClick={() => open(asset)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
                                <span className={`grid size-5 shrink-0 place-items-center rounded-full border ${done ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : "border-border text-muted-foreground"}`}>
                                    {done ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-muted-foreground/50" />}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{titleOf(asset)}</span>
                                {state.missing.length ? <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">{t("assetSpec.missingCount", { count: state.missing.length })}</span>
                                    : state.spec ? <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">{t("assetSpec.ready")}</span> : null}
                            </button>

                            {expanded ? <div className="space-y-3 border-t border-border/60 px-3 py-3">
                                {state.loading ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("assetSpec.loading")}</div> : null}
                                {!state.loading ? <>
                                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                        <Tag className="!m-0 !text-[10px]" color="processing">{state.imageKind || t(`assetSpec.imageKind.${kind}`)}</Tag>
                                        <span className="truncate font-mono" data-asset-spec-skill>{state.skill}</span>
                                        <span className="min-w-0 flex-1" />
                                        <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} onClick={() => void load(asset)}>{t("assetSpec.reload")}</Button>
                                        <Button size="small" icon={<ClipboardCopy className="size-3.5" />} disabled={!state.prompt} onClick={() => void copyPrompt(state.prompt)} data-asset-spec-copy>{t("assetSpec.copyPrompt")}</Button>
                                        <Button size="small" type="primary" loading={state.saving} icon={<Check className="size-3.5" />} onClick={() => void save(asset, kind)} data-asset-spec-save>{t("assetSpec.save")}</Button>
                                    </div>

                                    {state.missing.length ? <div className="flex flex-wrap gap-1.5" data-asset-spec-missing>
                                        {state.missing.map((field) => <span key={field} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">{t("assetSpec.missingField", { field })}</span>)}
                                    </div> : null}

                                    <AssetSpecFields kind={kind} spec={state.spec} onChange={(next) => patchState(asset.id, { spec: next })} />
                                    <p className="text-[11px] text-muted-foreground">{t("assetSpec.saveHint")}</p>

                                    {state.prompt ? <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
                                        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Sparkles className="size-3" />{t("assetSpec.promptPreview")}</div>
                                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80" data-asset-spec-prompt>{state.prompt}</pre>
                                    </div> : null}
                                </> : null}
                            </div> : null}
                        </div>;
                    })}
                </div>
            </PlanningSection>;
        })}
    </div>;
}
