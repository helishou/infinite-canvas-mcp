import { useMemo, useState } from "react";
import { App, Select, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Layers, PersonStanding, Plus, ScanFace, Shirt, Sparkles, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { loadOnlineCatalog, ONLINE_CATALOGS, type OnlineAsset, type OnlineCatalogKind } from "@/lib/canvas/online-catalog";
import { uploadImage } from "@/services/image-storage";
import type { InsertAssetPayload } from "./asset-picker-modal";

const LIBRARY_UI: Record<OnlineCatalogKind, { title: string; prefix: string; subcategoryFilter?: string; angleFilter?: string }> = {
    costume: { title: "costumes", prefix: "costume" },
    "costume-anime": { title: "costumeAnime", prefix: "costumeAnime" },
    portrait: { title: "portraits", prefix: "portrait", subcategoryFilter: "AllTypes" },
    pose: { title: "poses", prefix: "pose", subcategoryFilter: "AllTypes", angleFilter: "AllAngles" },
    depth: { title: "depths", prefix: "depth", subcategoryFilter: "AllTypes", angleFilter: "AllAngles" },
    anime: { title: "animes", prefix: "anime", subcategoryFilter: "AllTypes" },
};

const LIBRARY_ICONS: Record<OnlineCatalogKind, LucideIcon> = {
    costume: Shirt,
    "costume-anime": Shirt,
    portrait: ScanFace,
    pose: PersonStanding,
    depth: Layers,
    anime: Sparkles,
};

export function OnlineCostumes({ keyword, onInsert, theme, kind = "costume" }: { keyword: string; onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme; kind?: OnlineCatalogKind }) {
    const ui = LIBRARY_UI[kind];
    const Icon = LIBRARY_ICONS[kind];
    const label = (key: string) => `canvas.sidePanel.${ui.prefix}${key}`;
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState("");
    const [subcategory, setSubcategory] = useState("");
    const [angle, setAngle] = useState("");
    const [limit, setLimit] = useState(40);
    const [importing, setImporting] = useState<string | null>(null);
    const catalog = useQuery({
        queryKey: ["online-catalog", kind],
        enabled: open,
        retry: false,
        staleTime: 0,
        refetchOnWindowFocus: true,
        queryFn: () => loadOnlineCatalog(kind),
    });
    const categories = useMemo(() => Array.from(new Set((catalog.data || []).map(item => item.category))), [catalog.data]);
    const subcategories = useMemo(() => Array.from(new Set((catalog.data || []).filter(item => !category || item.category === category).map(item => item.subcategory).filter((value): value is string => Boolean(value)))), [catalog.data, category]);
    const angles = useMemo(() => Array.from(new Set((catalog.data || []).filter(item => (!category || item.category === category) && (!subcategory || item.subcategory === subcategory)).map(item => item.angle).filter((value): value is string => Boolean(value)))), [catalog.data, category, subcategory]);
    const filtered = useMemo(() => {
        const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return (catalog.data || []).filter(item =>
            (!category || item.category === category) &&
            (!subcategory || item.subcategory === subcategory) &&
            (!angle || item.angle === angle) &&
            words.every(word => `${item.id} ${item.name || ""} ${item.category} ${item.subcategory || ""} ${item.angle || ""} ${item.keywords}`.toLowerCase().includes(word)),
        );
    }, [catalog.data, category, subcategory, angle, keyword]);

    const insert = async (item: OnlineAsset) => {
        setImporting(item.id);
        try {
            const response = await fetch(item.original);
            if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
            const image = await uploadImage(await response.blob(), { category: "library" });
            onInsert({ kind: "image", dataUrl: image.url, storageKey: image.storageKey, title: item.name || item.id });
        } catch (error) {
            console.error(error);
            message.error(t(label("InsertError")));
        } finally {
            setImporting(null);
        }
    };

    return <div>
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 hover:opacity-100">
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            <Icon className="size-3.5" />
            <span>{t(`canvas.sidePanel.${ui.title}`)}</span>{catalog.data && <span className="opacity-50">{filtered.length}</span>}
        </button>
        {open && <div className="space-y-1.5 px-1 pb-2">
            <a href={ONLINE_CATALOGS[kind].pageUrl} target="_blank" rel="noreferrer" className="inline-block text-[11px] leading-4 opacity-55 transition-opacity hover:opacity-90 hover:underline">{t(label("Source"))}</a>
            {catalog.isLoading ? <div className="py-4 text-center text-xs"><Spin size="small" /> {t(label("Loading"))}</div> : catalog.isError ? <div className="text-xs">{t(label("Error"))} <button type="button" className="underline" onClick={() => void catalog.refetch()}>{t(label("Retry"))}</button></div> : <>
                <Select size="small" className="w-full" value={category} onChange={value => { setCategory(value); setSubcategory(""); setAngle(""); setLimit(40); }} options={[{ value: "", label: t(label("Category")) }, ...categories.map(value => ({ value, label: value }))]} />
                {(ui.subcategoryFilter || ui.angleFilter) && <div className="flex gap-1">
                    {ui.subcategoryFilter && <Select size="small" className={ui.angleFilter ? "min-w-0 flex-1" : "w-full"} value={subcategory} onChange={value => { setSubcategory(value); setAngle(""); setLimit(40); }} options={[{ value: "", label: t(label(ui.subcategoryFilter)) }, ...subcategories.map(value => ({ value, label: value }))]} />}
                    {ui.angleFilter && <Select size="small" className="min-w-0 flex-1" value={angle} onChange={value => { setAngle(value); setLimit(40); }} options={[{ value: "", label: t(label(ui.angleFilter)) }, ...angles.map(value => ({ value, label: value }))]} />}
                </div>}
                {!filtered.length ? <div className="py-4 text-center text-xs opacity-60">{t(label("Empty"))}</div> : <div className="grid grid-cols-2 gap-2">
                    {filtered.slice(0, limit).map(item => {
                        const title = item.name || item.id;
                        return <button key={item.id} type="button" disabled={Boolean(importing)} onClick={() => void insert(item)} title={`${item.id} · ${item.category}\n${item.keywords}`} aria-label={`${t("canvas.sidePanel.add")}: ${title}`} aria-busy={importing === item.id} className="group overflow-hidden rounded-lg border text-left transition-opacity hover:opacity-90 active:opacity-75 disabled:opacity-50" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                            <img src={item.thumbnail} alt={title} loading="lazy" className={cn("w-full object-contain", kind === "portrait" ? "aspect-[4/5]" : "aspect-[2/3]")} />
                            <div className="flex min-h-8 items-start gap-1 px-2 pt-1.5">
                                <span className="min-w-0 flex-1 line-clamp-2 text-xs font-semibold leading-4">{title}</span>
                                <span className="grid size-5 shrink-0 place-items-center" style={{ color: theme.toolbar.activeText }}>
                                    {importing === item.id ? <Spin size="small" /> : <Plus aria-hidden="true" className="size-3.5 opacity-55 transition-opacity group-hover:opacity-100" />}
                                </span>
                            </div>
                            {item.summary && <span className="block truncate px-2 text-[11px] leading-4 opacity-60">{item.summary}</span>}
                            {item.displayKeywords && <span className="block line-clamp-1 px-2 pb-2 text-[10px] leading-4 opacity-55">{item.displayKeywords}</span>}
                            {!item.displayKeywords && <span className="block pb-2" />}
                        </button>;
                    })}
                </div>}
                {filtered.length > limit && <button type="button" className="w-full py-2 text-xs underline" onClick={() => setLimit(value => value + 40)}>{t(label("More"))}</button>}
            </>}
        </div>}
    </div>;
}
