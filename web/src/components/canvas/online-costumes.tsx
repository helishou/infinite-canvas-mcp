import { useMemo, useState } from "react";
import { App, Select, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ScanFace, Shirt, PersonStanding } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { COSTUME_SOURCE, POSE_SOURCE, PORTRAIT_SOURCE, loadPortraitCatalog, parseCostumeCatalog, parsePoseCatalog, type OnlineAsset } from "@/lib/canvas/online-catalog";
import { uploadImage } from "@/services/image-storage";
import type { InsertAssetPayload } from "./asset-picker-modal";

export function OnlineCostumes({ keyword, onInsert, theme, kind = "costume" }: { keyword: string; onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme; kind?: "costume" | "pose" | "portrait" }) {
    const isPose = kind === "pose";
    const isPortrait = kind === "portrait";
    const source = isPortrait ? PORTRAIT_SOURCE : isPose ? POSE_SOURCE : COSTUME_SOURCE;
    const label = (key: string) => `canvas.sidePanel.${kind}${key}`;
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState("");
    const [poseType, setPoseType] = useState("");
    const [angle, setAngle] = useState("");
    const [limit, setLimit] = useState(40);
    const [importing, setImporting] = useState<string | null>(null);
    const catalog = useQuery({ queryKey: ["online-catalog", kind], enabled: open, retry: false, queryFn: async () => {
        if (isPortrait) return loadPortraitCatalog();
        const response = await fetch(source);
        if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
        const html = await response.text();
        return isPose ? parsePoseCatalog(html) : parseCostumeCatalog(html);
    } });
    const categories = useMemo(() => Array.from(new Set((catalog.data || []).map(item => item.category))), [catalog.data]);
    const poseTypes = useMemo(() => Array.from(new Set((catalog.data || []).filter(item => !category || item.category === category).map(item => item.poseType).filter((value): value is string => Boolean(value)))), [catalog.data, category]);
    const angles = useMemo(() => Array.from(new Set((catalog.data || []).map(item => item.angle).filter((value): value is string => Boolean(value)))), [catalog.data]);
    const filtered = useMemo(() => {
        const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return (catalog.data || []).filter(item => (!category || item.category === category) && (!poseType || item.poseType === poseType) && (!angle || item.angle === angle) && words.every(word => `${item.id} ${item.category} ${item.keywords}`.toLowerCase().includes(word)));
    }, [catalog.data, category, poseType, angle, keyword]);
    const insert = async (item: OnlineAsset) => {
        setImporting(item.id);
        try {
            const response = await fetch(item.original);
            if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
            const image = await uploadImage(await response.blob(), { category: "library" });
            onInsert({ kind: "image", dataUrl: image.url, storageKey: image.storageKey, title: item.id });
        } catch (error) {
            console.error(error);
            message.error(t(label("InsertError")));
        } finally { setImporting(null); }
    };
    return <div>
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 hover:opacity-100">
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />{isPortrait ? <ScanFace className="size-3.5" /> : isPose ? <PersonStanding className="size-3.5" /> : <Shirt className="size-3.5" />}
            <span>{t(isPortrait ? "canvas.sidePanel.portraits" : isPose ? "canvas.sidePanel.poses" : "canvas.sidePanel.costumes")}</span>{catalog.data && <span className="opacity-50">{filtered.length}</span>}
        </button>
        {open && <div className="space-y-2 px-1 pb-3">
            <a href={source} target="_blank" rel="noreferrer" className="text-xs opacity-70 underline">{t(label("Source"))}</a>
            {catalog.isLoading ? <div className="py-4 text-center text-xs"><Spin size="small" /> {t(label("Loading"))}</div> : catalog.isError ? <div className="text-xs">{t(label("Error"))} <button type="button" className="underline" onClick={() => void catalog.refetch()}>{t(label("Retry"))}</button></div> : <>
                <Select size="small" className="w-full" value={category} onChange={value => { setCategory(value); setPoseType(""); setLimit(40); }} options={[{ value: "", label: t(label("Category")) }, ...categories.map(value => ({ value, label: value }))]} />
                {(isPose || isPortrait) && <div className="flex gap-1">
                    <Select size="small" className={isPose ? "min-w-0 flex-1" : "w-full"} value={poseType} onChange={value => { setPoseType(value); setLimit(40); }} options={[{ value: "", label: t(label("AllTypes")) }, ...poseTypes.map(value => ({ value, label: value }))]} />
                    {isPose && <Select size="small" className="min-w-0 flex-1" value={angle} onChange={value => { setAngle(value); setLimit(40); }} options={[{ value: "", label: t("canvas.sidePanel.poseAllAngles") }, ...angles.map(value => ({ value, label: value }))]} />}
                </div>}
                {!filtered.length ? <div className="py-4 text-center text-xs opacity-60">{t(label("Empty"))}</div> : <div className="grid grid-cols-2 gap-2">
                    {filtered.slice(0, limit).map(item => <button key={item.id} type="button" disabled={Boolean(importing)} onClick={() => void insert(item)} title={`${item.id} · ${item.category}\n${item.keywords}`} className="overflow-hidden rounded-lg border text-left disabled:opacity-50" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                        <img src={item.thumbnail} alt={item.id} loading="lazy" className={cn("w-full object-contain", isPortrait ? "aspect-[4/5]" : "aspect-[2/3]")} />
                        <span className="block px-2 pt-1 text-xs font-semibold">{item.id}{importing === item.id && " …"}</span>
                        <span className="block px-2 pb-2 text-[11px] opacity-65">{item.category} · {item.keywords}</span>
                    </button>)}
                </div>}
                {filtered.length > limit && <button type="button" className="w-full py-2 text-xs underline" onClick={() => setLimit(value => value + 40)}>{t(label("More"))}</button>}
            </>}
        </div>}
    </div>;
}
