import { useEffect, useMemo, useState } from "react";
import { Button, Select } from "antd";
import { useTranslation } from "react-i18next";
import { ensureCanvasProjectLoaded, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { imageChoiceKey, smartImageChoices, type ImageNodeChoice } from "./smart-image-node-options";

type Row = Record<string, any>;
export function SmartImageNodePicker({ canvasId, canvasNodes, assets = {}, assetPlan = [], value, onChange, onUnavailable, exclude = [], disabled, placeholder }: {
    canvasId: string; canvasNodes: Row[]; assets?: Record<string, Row>; assetPlan?: Row[];
    value?: { projectId?: string; nodeId?: string }; onChange: (choice: ImageNodeChoice) => void;
    onUnavailable?: () => void;
    exclude?: Array<{ projectId?: string; nodeId?: string }>; disabled?: boolean; placeholder?: string;
}) {
    const { t } = useTranslation();
    const [opened, setOpened] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [retry, setRetry] = useState(0);
    const projects = useCanvasStore(state => state.projects);
    const idsKey = JSON.stringify([...new Set(Object.values(assets).flatMap(asset => asset.sharedSource?.sourceProjectId && asset.sharedSource.sourceProjectId !== canvasId ? [String(asset.sharedSource.sourceProjectId)] : []))].sort());
    useEffect(() => {
        if (!opened) return;
        let active = true; setLoading(true); setError("");
        void Promise.all((JSON.parse(idsKey) as string[]).map(id => ensureCanvasProjectLoaded(id))).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [opened, idsKey, retry]);
    const choices = useMemo(() => smartImageChoices(canvasId, canvasNodes, assets, projects.filter(project => !project.summary), assetPlan), [canvasId, canvasNodes, assets, projects, assetPlan]);
    const selected = imageChoiceKey(value), excluded = new Set(exclude.map(imageChoiceKey));
    useEffect(() => {
        const known = value?.projectId === canvasId || projects.some(project => project.id === value?.projectId && !project.summary);
        if (opened && selected && known && !loading && !choices.some(choice => imageChoiceKey(choice) === selected)) onUnavailable?.();
    }, [opened, selected, value?.projectId, canvasId, projects, loading, choices, onUnavailable]);
    const available = choices.filter(choice => !excluded.has(imageChoiceKey(choice)) || imageChoiceKey(choice) === selected);
    const options = available.map(choice => ({ value: imageChoiceKey(choice)!, label: `${choice.title || t("director.crud.imageNode")} · ${t(choice.shared ? "director.nodePicker.shared" : "director.nodePicker.current")}` }));
    if (selected && !options.some(option => option.value === selected)) options.push({ value: selected, label: t("director.crud.boundImage") });
    return <div className="min-w-0 flex-1 space-y-1">
        <Select className="w-full" showSearch optionFilterProp="label" value={selected} disabled={disabled} placeholder={placeholder} loading={loading} options={options} onOpenChange={open => { if (open) setOpened(true); }} onChange={key => { const choice = choices.find(choice => imageChoiceKey(choice) === key); if (choice) onChange(choice); }} />
        {opened && Boolean(JSON.parse(idsKey).length) && <p className="text-[11px] text-muted-foreground">{t("director.nodePicker.scopeHint")}</p>}
        {error && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("director.nodePicker.readFailed")}</summary><p className="mt-1 break-words">{error}</p><Button type="text" size="small" onClick={() => setRetry(value => value + 1)}>{t("director.atomic.retry")}</Button></details>}
    </div>;
}
