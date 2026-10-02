import { useEffect, useRef, useState, type RefObject, type MouseEventHandler } from "react";
import { App, Button, InputNumber, Slider, theme } from "antd";
import { Play, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import { trimCanvasVideo } from "@/services/api/canvas-video-trim";

export function CanvasVideoTrimPreview({ url, name, projectId, videoRef, onContextMenu }: {
    url: string; name: string; projectId?: string; videoRef: RefObject<HTMLVideoElement | null>; onContextMenu: MouseEventHandler<HTMLVideoElement>;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const [duration, setDuration] = useState(0);
    const [start, setStart] = useState<number | null>(0);
    const [end, setEnd] = useState<number | null>(null);
    const [time, setTime] = useState(0);
    const [trimming, setTrimming] = useState(false);
    const [failed, setFailed] = useState(false);
    const previewing = useRef(false);
    const controllerRef = useRef<AbortController | null>(null);
    const valid = !failed && duration > 0 && start !== null && end !== null && start >= 0 && end > start && end <= duration;
    useEffect(() => {
        const video = videoRef.current;
        return () => { controllerRef.current?.abort(); video?.pause(); };
    }, [videoRef]);

    const seek = (value: number) => {
        previewing.current = false;
        const video = videoRef.current;
        if (!video || !duration) return;
        video.pause();
        video.currentTime = Math.max(0, Math.min(duration, value));
        setTime(video.currentTime);
    };
    const preview = () => {
        const video = videoRef.current;
        if (!valid || !video) return;
        video.currentTime = start!;
        previewing.current = true;
        void video.play().catch(() => { previewing.current = false; });
    };
    const trim = async () => {
        if (!valid || !projectId || controllerRef.current) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        setTrimming(true);
        videoRef.current?.pause();
        previewing.current = false;
        try {
            await trimCanvasVideo({ projectId, url, name, start: start!, end: end!, taskId: `canvas-trim-${crypto.randomUUID()}` }, controller.signal);
            if (!controller.signal.aborted) message.success(t("canvas.videoTrim.done"));
        } catch (error) {
            if (!controller.signal.aborted) message.error(t("canvas.videoTrim.failed", { error: error instanceof Error ? error.message : String(error) }));
        } finally {
            controllerRef.current = null;
            setTrimming(false);
        }
    };

    return <div className="flex min-w-0 flex-col gap-3" style={{ width: "min(960px, 88vw)", color: token.colorText }} data-canvas-shortcuts-ignore>
        <video ref={videoRef} src={url} controls playsInline onContextMenu={onContextMenu}
            style={{ width: "100%", maxHeight: "55vh", background: "#000" }}
            onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                const finite = Number.isFinite(value) && value > 0 ? value : 0;
                setDuration(finite); setStart(0); setEnd(finite || null); setFailed(false);
            }}
            onError={() => { setFailed(true); setDuration(0); }}
            onTimeUpdate={(event) => {
                const video = event.currentTarget;
                setTime(video.currentTime);
                if (previewing.current && end !== null && video.currentTime >= end) { video.pause(); previewing.current = false; video.currentTime = end; }
            }}
            onSeeking={(event) => { if (start !== null && end !== null && (event.currentTarget.currentTime < start || event.currentTarget.currentTime > end)) previewing.current = false; }}
        />
        {projectId ? <div className="flex flex-col gap-2 px-1 pb-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: token.colorTextSecondary }}>
                <span>{t("canvas.videoTrim.range")}</span>
                <span>{t("canvas.videoTrim.current", { time: time.toFixed(3), duration: duration.toFixed(3) })}</span>
            </div>
            <Slider range min={0} max={duration || 1} step={0.001} value={[start ?? 0, end ?? duration]} disabled={!duration || trimming}
                tooltip={{ formatter: (value) => `${Number(value).toFixed(3)}s` }}
                onChange={(values) => { const [a, b] = values as number[]; const target = a !== start ? a : b; setStart(a); setEnd(b); seek(target); }} />
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs"><span>{t("canvas.videoTrim.start")}</span>
                    <InputNumber aria-label={t("canvas.videoTrim.start")} value={start} min={0} max={duration} step={0.001} disabled={!duration || trimming}
                        onChange={(value) => { setStart(value); if (value !== null) seek(value); }} />
                </label>
                <Button type="text" size="small" disabled={!duration || trimming} onClick={() => { setStart(videoRef.current?.currentTime ?? time); previewing.current = false; }}>{t("canvas.videoTrim.setStart")}</Button>
                <label className="flex flex-col gap-1 text-xs"><span>{t("canvas.videoTrim.end")}</span>
                    <InputNumber aria-label={t("canvas.videoTrim.end")} value={end} min={0} max={duration} step={0.001} disabled={!duration || trimming}
                        onChange={(value) => { setEnd(value); if (value !== null) seek(value); }} />
                </label>
                <Button type="text" size="small" disabled={!duration || trimming} onClick={() => { setEnd(videoRef.current?.currentTime ?? time); previewing.current = false; }}>{t("canvas.videoTrim.setEnd")}</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button type="text" icon={<Play size={14} />} disabled={!valid || trimming} onClick={preview}>{t("canvas.videoTrim.preview")}</Button>
                <Button type="text" icon={<Scissors size={14} />} loading={trimming} disabled={!valid} onClick={() => void trim()}>{t("canvas.videoTrim.trim")}</Button>
                {trimming ? <Button type="text" onClick={() => controllerRef.current?.abort()}>{t("canvas.videoTrim.cancel")}</Button> : null}
                <span className="text-xs" style={{ color: valid ? token.colorTextSecondary : token.colorError }}>
                    {valid ? t("canvas.videoTrim.selected", { duration: (end! - start!).toFixed(3) }) : t(failed ? "canvas.videoTrim.loadFailed" : !duration ? "canvas.videoTrim.loading" : "canvas.videoTrim.invalid")}
                </span>
            </div>
            <span className="text-xs" style={{ color: token.colorTextSecondary }}>{t("canvas.videoTrim.hint")}</span>
        </div> : null}
    </div>;
}
