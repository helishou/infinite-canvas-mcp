import { useEffect, useState } from "@infinite-canvas/plugin-sdk";

// 视频输出参数的标准档位：与主项目「视频参数」面板（web/src/components/video-settings-panel.tsx）同源，
// 保证画布 H3 节点与节点视频参数弹层给出同一套清晰度/尺寸/秒数档位。
export const H3_STANDARD_SIZES = [
    { label: "横屏", w: 1280, h: 720 },
    { label: "竖屏", w: 720, h: 1280 },
    { label: "方形", w: 1024, h: 1024 },
    { label: "宽屏", w: 1792, h: 1024 },
    { label: "长图", w: 1024, h: 1792 },
];
export const H3_PRESET_SECONDS = [6, 10, 12, 15];
const H3_PRESET_QUALITIES = [720, 480];
const H3_SIZE_PREVIEW_EDGE = 26;

type Props = {
    width?: number;
    height?: number;
    seconds?: number;
    secondsMax?: number;
    showSize?: boolean;
    showSeconds?: boolean;
    onSize: (width: number, height: number) => void;
    onSeconds: (seconds: number) => void;
};

const clampDimension = (value: number) => Math.max(1, Math.round(value));

function H3SizePreview({ width, height }: { width: number; height: number }) {
    const longSide = Math.max(width, height);
    return <span className="nfh3-size-preview" aria-hidden="true" style={{ width: Math.max(10, Math.round((width / longSide) * H3_SIZE_PREVIEW_EDGE)), height: Math.max(10, Math.round((height / longSide) * H3_SIZE_PREVIEW_EDGE)) }} />;
}

/**
 * 标准化「视频参数」分组：清晰度 → 尺寸 → 秒数 → 精确尺寸（折叠）。
 * 顺序、分组标题、pill/尺寸卡片形态与主项目视频参数面板一致；H3 面板不再自造方角按钮。
 */
export function H3VideoOutputParams({ width, height, seconds, secondsMax = 15, showSize = true, showSeconds = true, onSize, onSeconds }: Props) {
    const hasSize = showSize && Number(width) > 0 && Number(height) > 0;
    const sizeWidth = hasSize ? Number(width) : 1280;
    const sizeHeight = hasSize ? Number(height) : 720;
    const quality = hasSize ? Math.min(sizeWidth, sizeHeight) : undefined;
    const [qualityDraft, setQualityDraft] = useState(String(quality ?? ""));
    const [secondsDraft, setSecondsDraft] = useState(seconds == null ? "" : String(seconds));
    useEffect(() => { setQualityDraft(String(quality ?? "")); }, [quality]);
    useEffect(() => { setSecondsDraft(seconds == null ? "" : String(seconds)); }, [seconds]);
    // 清晰度按短边缩放，保持当前宽高比；输入框失焦/回车才提交，避免打字过程中被反复取整。
    const writeQuality = (value: number) => {
        if (!hasSize) return;
        const next = clampDimension(value);
        const scale = next / Math.min(sizeWidth, sizeHeight);
        onSize(clampDimension(sizeWidth * scale), clampDimension(sizeHeight * scale));
    };
    const commitQualityDraft = () => {
        const next = Number(qualityDraft);
        if (Number.isFinite(next) && next > 0) writeQuality(next);
        else setQualityDraft(String(quality ?? ""));
    };
    const commitSecondsDraft = () => {
        const next = Number(secondsDraft);
        if (Number.isFinite(next) && next >= 1) onSeconds(Math.min(secondsMax, next));
        else setSecondsDraft(seconds == null ? "" : String(seconds));
    };
    const writeEdge = (edge: "w" | "h", value: number) => {
        const next = clampDimension(Number.isFinite(value) ? value : 0);
        onSize(edge === "w" ? next : sizeWidth, edge === "h" ? next : sizeHeight);
    };
    return <div className="nfh3-video-params">
        {showSize ? <div className="nfh3-video-group">
            <span className="nfh3-video-group-title">清晰度</span>
            <div className="nfh3-video-pills">
                {H3_PRESET_QUALITIES.map((value) => <button
                    key={`quality-${value}`} type="button" aria-pressed={quality === value}
                    className={`nfh3-pill${quality === value ? " is-active" : ""}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => writeQuality(value)}
                >{value}p</button>)}
                <label className="nfh3-pill-input">
                    <input
                        type="number" min={1} aria-label="自定义清晰度" placeholder="自定义"
                        value={qualityDraft}
                        onMouseDown={(event) => event.stopPropagation()}
                        onChange={(event) => setQualityDraft(event.target.value)}
                        onBlur={commitQualityDraft}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitQualityDraft(); } }}
                    />
                    <span>p</span>
                </label>
            </div>
        </div> : null}
        {showSize ? <div className="nfh3-video-group">
            <span className="nfh3-video-group-title">尺寸</span>
            <div className="nfh3-video-sizes">
                {H3_STANDARD_SIZES.map((size) => <button
                    key={`size-${size.w}x${size.h}`} type="button"
                    aria-pressed={sizeWidth === size.w && sizeHeight === size.h}
                    title={`${size.w}×${size.h}`}
                    className={`nfh3-size-card${sizeWidth === size.w && sizeHeight === size.h ? " is-active" : ""}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => onSize(size.w, size.h)}
                ><H3SizePreview width={size.w} height={size.h} /><span>{size.label}</span></button>)}
            </div>
        </div> : null}
        {showSeconds ? <div className="nfh3-video-group">
            <span className="nfh3-video-group-title">秒数</span>
            <div className="nfh3-video-pills">
                {H3_PRESET_SECONDS.map((value) => <button
                    key={`seconds-${value}`} type="button" aria-pressed={seconds === value}
                    className={`nfh3-pill${seconds === value ? " is-active" : ""}`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => onSeconds(value)}
                >{value}s</button>)}
                <label className="nfh3-pill-input">
                    <input
                        type="number" min={1} max={secondsMax} step={0.1} aria-label="自定义秒数" placeholder="自定义"
                        value={secondsDraft}
                        onMouseDown={(event) => event.stopPropagation()}
                        onChange={(event) => setSecondsDraft(event.target.value)}
                        onBlur={commitSecondsDraft}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitSecondsDraft(); } }}
                    />
                    <span>s</span>
                </label>
            </div>
        </div> : null}
        {showSize ? <details className="nfh3-video-precise">
            <summary onMouseDown={(event) => event.stopPropagation()}>精确尺寸<small>{sizeWidth}×{sizeHeight}</small></summary>
            <div className="nfh3-video-dims">
                <label>W<input type="number" min={1} aria-label="宽度" value={sizeWidth} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => writeEdge("w", Number(event.target.value))} /></label>
                <span>↔</span>
                <label>H<input type="number" min={1} aria-label="高度" value={sizeHeight} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => writeEdge("h", Number(event.target.value))} /></label>
            </div>
        </details> : null}
    </div>;
}
