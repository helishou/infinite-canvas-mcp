export const H3_VIDEO_MEGAPIXELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1, 1.2, 1.5, 1.8, 2];
export const H3_VIDEO_RATIOS: Record<string, readonly [number, number]> = {
    "1:1 (Square)": [1, 1], "2:3 (Portrait Photo)": [2, 3], "3:2 (Photo)": [3, 2],
    "3:4 (Portrait Standard)": [3, 4], "4:3 (Standard)": [4, 3], "9:16 (Portrait Widescreen)": [9, 16],
    "16:9 (Widescreen)": [16, 9], "21:9 (Ultrawide)": [21, 9],
};

/** Matches the native V15 node's V8.1 decimal-MP and latent-grid calculation. */
export function h3VideoDimensions(aspectRatio: string, megapixels: number, latentAlign = 2) {
    const [w, h] = H3_VIDEO_RATIOS[aspectRatio] || [16, 9];
    const scale = Math.sqrt(megapixels * 1_000_000 / (w * h));
    const align = Math.max(1, Math.trunc(latentAlign));
    return { width: Math.ceil(Math.ceil(w * scale / 16) / align) * align * 16, height: Math.ceil(Math.ceil(h * scale / 16) / align) * align * 16 };
}

/** The native first-frame "original ratio" path uses binary MP, a 1920 cap, and Python rounding. */
export function h3OriginalVideoDimensions(width: number, height: number, megapixels: number) {
    let scale = Math.sqrt(megapixels * 1024 * 1024 / (width * height));
    scale = Math.min(scale, 1920 / Math.max(width, height));
    const round = (value: number) => value % 1 === 0.5 ? 2 * Math.round(value / 2) : Math.round(value);
    return { width: Math.min(1920, Math.max(32, round(width * scale / 32) * 32)), height: Math.min(1920, Math.max(32, round(height * scale / 32) * 32)) };
}
