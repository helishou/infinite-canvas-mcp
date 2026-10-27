// Safe source-snapshot fixture: extracted verbatim from image/index.tsx for presentation QA.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Tooltip } from "antd";
import { ArrowLeft, ArrowRight, Download, FolderPlus, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MediaImage } from "../src/components/media/media-image";
import { backendMediaUrl } from "../src/services/backend-api";
import { formatBytes, formatDuration } from "../src/lib/image-utils";
import { getAntThemeConfig } from "../src/lib/app-theme";
import i18n from "../src/i18n";
import "../src/styles/globals.css";
type GeneratedImage = { id:string; dataUrl:string; storageKey?:string; width:number; height:number; bytes:number; durationMs:number };
const RESULT_ACTION_BUTTON_CLASS = "ui-result-action min-w-0 [&_.ant-btn-icon]:shrink-0";
function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card lg:flex lg:h-full lg:min-h-0 lg:flex-col">
            <MediaImage src={image.storageKey ? backendMediaUrl(image.storageKey) : image.dataUrl} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square w-full bg-muted/40 object-contain lg:aspect-auto lg:h-full lg:min-h-0 lg:flex-1" />
            <div className="space-y-2 border-t border-border px-3 py-3 lg:shrink-0">
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,108px),1fr))] gap-2" role="group" aria-label={t("workbench.groups.resultActions")}>
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-4" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-4" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-4" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    const { t } = useTranslation();
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-0.5 bottom-1 flex justify-between">
            <Button
                size="small"
                className="!h-11 !w-11 !min-w-11 sm:!h-8 sm:!w-8 sm:!min-w-8 !rounded-md !border-border !bg-background/90 !p-0 !text-foreground"
                aria-label={t("workbench.groups.moveReferenceEarlier", { count: index + 1 })}
                icon={<ArrowLeft className="size-4" />}
                disabled={index <= 0}
                onClick={() => onMove(-1)}
            />
            <Button
                size="small"
                className="!h-11 !w-11 !min-w-11 sm:!h-8 sm:!w-8 sm:!min-w-8 !rounded-md !border-border !bg-background/90 !p-0 !text-foreground"
                aria-label={t("workbench.groups.moveReferenceLater", { count: index + 1 })}
                icon={<ArrowRight className="size-4" />}
                disabled={index >= total - 1}
                onClick={() => onMove(1)}
            />
        </div>
    );
}

function Fixture(){const [dark,setDark]=useState(false);const [receipt,setReceipt]=useState("No action");const [width,setWidth]=useState(220);const [index,setIndex]=useState(0);
const image={id:"mock-result",dataUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="%23687959"/><circle cx="128" cy="128" r="70" fill="%23c1cfa3"/></svg>',width:1024,height:1024,bytes:122880,durationMs:7200};
return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main className={`${dark?"dark":""} ui-controls min-h-screen bg-background p-4 text-foreground`}><p className="ui-body">Safe fixture: no generation, downloads, writes or uploads</p><div className="flex flex-wrap gap-2 py-3"><Button onClick={()=>setDark(!dark)}>Theme</Button><Button onClick={()=>void i18n.changeLanguage(i18n.language==='en-US'?'zh-CN':'en-US')}>Language</Button><select aria-label="Card width" value={width} onChange={e=>setWidth(Number(e.target.value))}>{[220,300,390].map(n=><option key={n}>{n}</option>)}</select></div><output>{receipt}</output><div style={{width}} className="mt-3"><ResultImageCard image={image} index={0} onEdit={()=>setReceipt("edit:mock-result:0")} onSaveAsset={()=>setReceipt("save:mock-result:0")} onDownload={()=>setReceipt("download:mock-result:0")}/></div><div className="relative mt-4 h-32 w-24 border sm:h-28 sm:w-20"><ReferenceOrderButtons index={index} total={3} onMove={n=>setIndex(index+n)}/></div><p>Reference position: {index+1}</p><div data-testid="authored-text" className="font-mono" style={{fontSize:21,lineHeight:'35px'}}>Authored text 文字 21px (CSS inheritance probe, not a canvas node)</div></main></App></ConfigProvider>}
createRoot(document.getElementById("root")!).render(<Fixture/>);
