import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal, Select } from "antd";
import { Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

export type CanvasVideoCompareItem = { id: string; title: string; url: string; durationMs?: number };
export type CanvasVideoComparison = { source: CanvasVideoCompareItem; candidates: CanvasVideoCompareItem[]; initialSelectedIds?: string[] };

function formatTime(seconds: number) {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function videoDuration(video: HTMLVideoElement, fallback?: number) {
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (fallback || 0) / 1000;
}

export function CanvasVideoCompareModal({ comparison, onClose }: { comparison: CanvasVideoComparison; onClose: () => void }) {
    const { t } = useTranslation();
    const [selectedIds, setSelectedIds] = useState<string[]>(comparison.initialSelectedIds || []);
    const [durations, setDurations] = useState<Record<string, number>>({});
    const [errors, setErrors] = useState<Record<string, boolean>>({});
    const [playing, setPlaying] = useState(false);
    const [time, setTime] = useState(0);
    const timeRef = useRef(0);
    const videosRef = useRef(new Map<string, HTMLVideoElement>());
    const refCallbacks = useRef(new Map<string, (video: HTMLVideoElement | null) => void>());
    const items = useMemo(() => [comparison.source, ...comparison.candidates.filter((item) => selectedIds.includes(item.id))], [comparison, selectedIds]);
    const candidateOptions = useMemo(() => comparison.candidates.map((item) => ({ value: item.id, label: item.title })), [comparison.candidates]);
    const totalDuration = Math.max(0, ...items.map((item) => durations[item.id] || (item.durationMs || 0) / 1000));
    const videoRefFor = (id: string) => {
        let callback = refCallbacks.current.get(id);
        if (!callback) {
            callback = (video) => {
                if (video) videosRef.current.set(id, video);
                else { videosRef.current.get(id)?.pause(); videosRef.current.delete(id); }
            };
            refCallbacks.current.set(id, callback);
        }
        return callback;
    };

    const syncVideo = useCallback((video: HTMLVideoElement, item: CanvasVideoCompareItem, targetTime: number, shouldPlay: boolean, force = false) => {
        const duration = videoDuration(video, item.durationMs);
        const end = duration > 0 ? Math.max(0, duration - 0.04) : targetTime;
        const position = Math.min(targetTime, end);
        if (video.error) return;
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA && (force || Math.abs(video.currentTime - position) > 0.12)) {
            try { video.currentTime = position; } catch { /* Media may still be loading. */ }
        }
        if (shouldPlay && (duration <= 0 || targetTime < end)) {
            if (video.paused) void video.play().catch(() => undefined);
        } else if (!video.paused) video.pause();
    }, []);
    const syncAll = useCallback((targetTime: number, shouldPlay: boolean, force = false) => {
        for (const item of items) {
            const video = videosRef.current.get(item.id);
            if (video) syncVideo(video, item, targetTime, shouldPlay, force);
        }
    }, [items, syncVideo]);

    useEffect(() => {
        syncAll(timeRef.current, playing, true);
    }, [syncAll, playing]);
    useEffect(() => {
        if (totalDuration > 0 && timeRef.current > totalDuration) {
            timeRef.current = totalDuration;
            setTime(totalDuration);
            setPlaying(false);
            syncAll(totalDuration, false, true);
        }
    }, [syncAll, totalDuration]);
    useEffect(() => {
        if (!playing) return;
        let frame = 0;
        let last = performance.now();
        let lastDisplay = last;
        const tick = (now: number) => {
            timeRef.current = Math.min(totalDuration, timeRef.current + Math.max(0, now - last) / 1000);
            last = now;
            syncAll(timeRef.current, true);
            if (now - lastDisplay >= 100 || timeRef.current >= totalDuration) {
                setTime(timeRef.current);
                lastDisplay = now;
            }
            if (timeRef.current >= totalDuration) { setPlaying(false); return; }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, syncAll, totalDuration]);
    useEffect(() => {
        const onHidden = () => { if (document.hidden) setPlaying(false); };
        document.addEventListener("visibilitychange", onHidden);
        return () => {
            document.removeEventListener("visibilitychange", onHidden);
            for (const video of videosRef.current.values()) video.pause();
        };
    }, []);

    const seek = (next: number) => {
        timeRef.current = next;
        setTime(next);
        syncAll(next, playing, true);
    };
    const togglePlayback = () => {
        if (playing) { setPlaying(false); syncAll(timeRef.current, false); return; }
        if (totalDuration <= 0) return;
        if (timeRef.current >= totalDuration) seek(0);
        syncAll(timeRef.current, true, true);
        setPlaying(true);
    };

    return <Modal
        title={t("canvas.videoCompare.title")}
        open
        centered
        width="min(92vw, 1500px)"
        footer={null}
        onCancel={onClose}
        destroyOnHidden
        styles={{ body: { maxHeight: "82vh", overflowY: "auto" } }}
    >
        <div className="flex flex-col gap-4" data-canvas-shortcuts-ignore>
            <label className="flex flex-col gap-2 text-sm">
                <span>{t("canvas.videoCompare.choose")}</span>
                <Select
                    mode="multiple"
                    showSearch
                    allowClear
                    value={selectedIds}
                    onChange={setSelectedIds}
                    options={candidateOptions}
                    placeholder={comparison.candidates.length ? t("canvas.videoCompare.placeholder") : t("canvas.videoCompare.noCandidates")}
                    disabled={!comparison.candidates.length}
                    optionFilterProp="label"
                    className="w-full"
                />
            </label>
            <div className="grid gap-3" style={{ gridTemplateColumns: items.length > 1 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)" }}>
                {items.map((item, index) => <div key={item.id} className="min-w-0 overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
                    <div className="flex items-center gap-2 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate" title={item.title}>{item.title}</span>
                        {index === 0 ? <span className="shrink-0 text-xs opacity-60">{t("canvas.videoCompare.source")}</span> : null}
                    </div>
                    <div className="relative bg-black">
                        <video
                            ref={videoRefFor(item.id)}
                            src={item.url}
                            preload="metadata"
                            playsInline
                            muted={index > 0}
                            className="aspect-video w-full object-contain"
                            data-video-compare-id={item.id}
                            onLoadedMetadata={(event) => {
                                const video = event.currentTarget;
                                const duration = videoDuration(video, item.durationMs);
                                if (duration > 0) setDurations((current) => current[item.id] === duration ? current : { ...current, [item.id]: duration });
                                syncVideo(video, item, timeRef.current, playing, true);
                            }}
                            onError={() => setErrors((current) => ({ ...current, [item.id]: true }))}
                        />
                        {errors[item.id] ? <div className="absolute inset-0 grid place-items-center text-sm text-white">{t("canvas.videoCompare.loadFailed")}</div> : null}
                    </div>
                </div>)}
            </div>
            <div className="flex items-center gap-3">
                <Button type="primary" icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={togglePlayback} disabled={!totalDuration} aria-label={t(playing ? "canvas.videoCompare.pause" : "canvas.videoCompare.play")} />
                <input type="range" className="min-w-0 flex-1 cursor-pointer accent-blue-500 disabled:cursor-not-allowed" min={0} max={totalDuration || 1} step={0.01} value={time} onChange={(event) => seek(Number(event.target.value))} disabled={!totalDuration} aria-label={t("canvas.videoCompare.seek")} />
                <span className="shrink-0 text-xs tabular-nums">{formatTime(time)} / {formatTime(totalDuration)}</span>
            </div>
            <p className="text-xs opacity-60">{t("canvas.videoCompare.hint")}</p>
        </div>
    </Modal>;
}
