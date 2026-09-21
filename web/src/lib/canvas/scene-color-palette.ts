import { getImageBlob, resolveImageUrl } from "@/services/image-storage";

export type SceneColorCardSource = { url: string; storageKey?: string; name?: string; mimeType?: string };

const MAX_PALETTE_COLORS = 8;
const COLOR_PROPERTIES = /^(?:fill|stroke|color|stop-color|flood-color|lighting-color|background-color|border-color)$/i;

export function normalizeSceneHexColor(value: string) {
    const input = value.trim().replace(/^#/, "");
    if (/^[\da-f]{3}$/i.test(input)) return `#${[...input].map((digit) => digit + digit).join("").toUpperCase()}`;
    if (/^[\da-f]{6}$/i.test(input)) return `#${input.toUpperCase()}`;
    return null;
}

export function normalizeSceneColorPalette(colors: string[]) {
    return Array.from(new Set(colors.map(normalizeSceneHexColor).filter((color): color is string => Boolean(color))));
}

export async function extractSceneColorPalette(source: SceneColorCardSource) {
    const blob = await loadColorCardBlob(source);
    const isSvg = /svg/i.test(`${blob.type || ""} ${source.mimeType || ""}`) || /\.svg(?:[?#]|$)/i.test(`${source.name || ""} ${source.url}`);
    if (!isSvg) return extractRasterColors(blob);
    const colors = extractSvgColors(await blob.text());
    return colors.length ? colors : extractRasterColors(blob);
}

async function loadColorCardBlob(source: SceneColorCardSource) {
    if (source.storageKey) {
        try {
            const blob = await getImageBlob(source.storageKey);
            if (blob) return blob;
        } catch {
            // Fall through to the resolved URL when the media endpoint cannot return the blob.
        }
    }
    const url = await resolveImageUrl(source.storageKey, source.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`色卡读取失败 (${response.status})`);
    return response.blob();
}

function extractSvgColors(markup: string) {
    const document = new DOMParser().parseFromString(markup, "image/svg+xml");
    if (document.querySelector("parsererror")) throw new Error("SVG 色卡解析失败");
    const counts = new Map<string, number>();
    const addValue = (value: string) => {
        const css = value.replace(/url\([^)]*\)/gi, " ");
        for (const match of css.matchAll(/#([\da-f]{3,8})\b/gi)) {
            const color = hexTokenToColor(match[1]);
            if (color) counts.set(color, (counts.get(color) || 0) + 1);
        }
        for (const match of css.matchAll(/rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)(?:\s*,\s*([\d.]+%?))?\s*\)/gi)) {
            const alpha = match[4] ? parseFloat(match[4]) / (match[4].endsWith("%") ? 100 : 1) : 1;
            if (alpha <= 0) continue;
            const channels = match.slice(1, 4).map((channel) => Math.round(Math.min(255, Math.max(0, parseFloat(channel) * (channel.endsWith("%") ? 2.55 : 1)))));
            const color = toHex(channels[0], channels[1], channels[2]);
            counts.set(color, (counts.get(color) || 0) + 1);
        }
    };
    const addDeclarations = (value: string) => {
        for (const declaration of value.split(";")) {
            const separator = declaration.indexOf(":");
            if (separator < 0) continue;
            if (COLOR_PROPERTIES.test(declaration.slice(0, separator).trim())) addValue(declaration.slice(separator + 1));
        }
    };

    for (const element of Array.from(document.querySelectorAll("*"))) {
        for (const attribute of Array.from(element.attributes)) {
            if (attribute.name.toLowerCase() === "style") addDeclarations(attribute.value);
            else if (COLOR_PROPERTIES.test(attribute.name)) addValue(attribute.value);
        }
        if (element.tagName.toLowerCase() === "style") {
            for (const match of (element.textContent || "").matchAll(/(?:fill|stroke|color|stop-color|flood-color|lighting-color|background-color|border-color)\s*:\s*([^;}]+)/gi)) addValue(match[1]);
        }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, MAX_PALETTE_COLORS).map(([color]) => color);
}

function hexTokenToColor(input: string) {
    if (input.length === 3 || input.length === 4) return `#${[...input.slice(0, 3)].map((digit) => digit + digit).join("").toUpperCase()}`;
    if (input.length === 6 || input.length === 8) return `#${input.slice(0, 6).toUpperCase()}`;
    return null;
}

function extractRasterColors(blob: Blob) {
    const url = URL.createObjectURL(blob);
    return new Promise<string[]>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            try {
                const scale = Math.min(1, 96 / image.naturalWidth, 96 / image.naturalHeight);
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) throw new Error("无法读取色卡像素");
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                const bins = new Map<string, { count: number; red: number; green: number; blue: number }>();
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] < 96) continue;
                    const red = pixels[index];
                    const green = pixels[index + 1];
                    const blue = pixels[index + 2];
                    const key = `${red >> 4},${green >> 4},${blue >> 4}`;
                    const bin = bins.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
                    bin.count++;
                    bin.red += red;
                    bin.green += green;
                    bin.blue += blue;
                    bins.set(key, bin);
                }
                const colors = Array.from(bins.values())
                    .sort((a, b) => b.count - a.count)
                    .map((bin) => toHex(Math.round(bin.red / bin.count), Math.round(bin.green / bin.count), Math.round(bin.blue / bin.count)));
                resolve(Array.from(new Set(colors)).slice(0, MAX_PALETTE_COLORS));
            } catch (error) {
                reject(error);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("色卡图片解码失败"));
        };
        image.src = url;
    });
}

function toHex(red: number, green: number, blue: number) {
    return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
