export declare const H3_VIDEO_MEGAPIXELS: number[];
export declare const H3_VIDEO_RATIOS: Record<string, readonly [number, number]>;
/** Matches the native V15 node's V8.1 decimal-MP and latent-grid calculation. */
export declare function h3VideoDimensions(aspectRatio: string, megapixels: number, latentAlign?: number): {
    width: number;
    height: number;
};
/** The native first-frame "original ratio" path uses binary MP, a 1920 cap, and Python rounding. */
export declare function h3OriginalVideoDimensions(width: number, height: number, megapixels: number): {
    width: number;
    height: number;
};
//# sourceMappingURL=video-settings.d.ts.map