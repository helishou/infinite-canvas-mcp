import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, Tooltip, message } from "antd";
import { LoaderCircle, Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveMediaUrl } from "@/services/file-storage";
import type { AudioAsset } from "@/stores/use-asset-store";

type VoicePreview = { id?: string; url?: string; storageKey?: string; name?: string };

export function VoiceAssetSelect({ assets, value, preview, placeholder, allowClear = false, onChange }: { assets: AudioAsset[]; value?: string; preview?: VoicePreview; placeholder: string; allowClear?: boolean; onChange: (asset?: AudioAsset) => void }) {
    const { t } = useTranslation();
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [previewingId, setPreviewingId] = useState("");
    const [loadingId, setLoadingId] = useState("");
    const options = useMemo(() => assets.map((asset) => ({ label: asset.title, value: asset.id })), [assets]);

    const stopPreview = () => {
        audioRef.current?.pause();
        audioRef.current = null;
        setPreviewingId("");
    };

    useEffect(() => stopPreview, []);

    const togglePreview = async (item: VoicePreview) => {
        const id = item.id || item.storageKey || item.url || "";
        if (previewingId === id) {
            stopPreview();
            return;
        }
        stopPreview();
        setLoadingId(id);
        try {
            const src = await resolveMediaUrl(item.storageKey, item.url);
            if (!src) throw new Error("missing audio source");
            const audio = new Audio(src);
            audioRef.current = audio;
            audio.onended = stopPreview;
            audio.onerror = () => {
                stopPreview();
                message.error(t("assets.character.voicePreviewFailed"));
            };
            await audio.play();
            setPreviewingId(id);
        } catch {
            stopPreview();
            message.error(t("assets.character.voicePreviewFailed"));
        } finally {
            setLoadingId("");
        }
    };

    const previewButton = (item: VoicePreview, compact = false) => {
        const id = item.id || item.storageKey || item.url || "";
        const playing = previewingId === id;
        const loading = loadingId === id;
        return (
            <Tooltip title={t(playing ? "assets.character.stopVoicePreview" : "assets.character.previewVoice")}>
                <button
                    type="button"
                    aria-label={t(playing ? "assets.character.stopVoicePreview" : "assets.character.previewVoice")}
                    className={compact ? "grid size-7 shrink-0 place-items-center rounded text-stone-500 hover:bg-black/5 hover:text-stone-900 dark:hover:bg-white/10 dark:hover:text-stone-100" : ""}
                    onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onClick={(event) => { event.stopPropagation(); void togglePreview(item); }}
                >
                    {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </button>
            </Tooltip>
        );
    };

    return (
        <div className="flex gap-2">
            <Select
                className="min-w-0 flex-1"
                allowClear={allowClear}
                placeholder={placeholder}
                options={options}
                value={value || undefined}
                onChange={(id) => onChange(assets.find((asset) => asset.id === id))}
                onClear={() => onChange(undefined)}
                optionRender={(option) => {
                    const asset = assets.find((candidate) => candidate.id === option.value);
                    return (
                        <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {asset ? previewButton({ id: asset.id, url: asset.data.url, storageKey: asset.data.storageKey, name: asset.title }, true) : null}
                        </div>
                    );
                }}
            />
            {preview?.url || preview?.storageKey ? (
                <Tooltip title={t(previewingId === (preview.id || preview.storageKey || preview.url) ? "assets.character.stopVoicePreview" : "assets.character.previewVoice")}>
                    <Button icon={loadingId === (preview.id || preview.storageKey || preview.url) ? <LoaderCircle className="size-3.5 animate-spin" /> : previewingId === (preview.id || preview.storageKey || preview.url) ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => void togglePreview(preview)} />
                </Tooltip>
            ) : null}
        </div>
    );
}
