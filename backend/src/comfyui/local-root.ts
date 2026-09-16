import fs from "node:fs";
import path from "node:path";
import { copyFile, mkdir, realpath } from "node:fs/promises";

export function resolveComfyRoot(value: string) {
    if (!value.trim()) throw new Error("请输入 ComfyUI 根目录或绘世安装目录");
    const selected = path.resolve(value.trim());
    const root = fs.existsSync(path.join(selected, "main.py")) ? selected : path.join(selected, "ComfyUI");
    if (!fs.existsSync(path.join(root, "main.py")) || !fs.statSync(path.join(root, "main.py")).isFile()
        || !fs.existsSync(path.join(root, "input")) || !fs.statSync(path.join(root, "input")).isDirectory()) {
        throw new Error(`ComfyUI 目录无效，需要包含 main.py 和 input：${selected}`);
    }
    return root;
}

function isInside(directory: string, file: string) {
    const relative = path.relative(directory, file);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertIndependentMediaRoot(mediaDir: string, comfyRoot: string) {
    const media = fs.realpathSync(mediaDir), comfy = fs.realpathSync(comfyRoot);
    if (media === comfy || isInside(comfy, media) || isInside(media, comfy)) {
        throw new Error("画布媒体目录必须独立于 ComfyUI 安装目录，请先将媒体库迁出");
    }
}

export function comfyInputName(file: string, mediaDir: string) {
    const source = path.resolve(file), media = path.resolve(mediaDir);
    if (!isInside(media, source)) throw new Error(`H3 本地输入只接受运行媒体文件：${file}`);
    return `infinite-canvas-cache/${path.relative(media, source).split(path.sep).join("/")}`;
}

/** ComfyUI 只持有执行副本；删除输入缓存后可从独立媒体库重新复制。 */
export async function copyComfyInput(file: string, mediaDir: string, comfyRoot: string) {
    assertIndependentMediaRoot(mediaDir, comfyRoot);
    const name = comfyInputName(file, mediaDir);
    const source = await realpath(file);
    if (!isInside(await realpath(mediaDir), source)) throw new Error("运行媒体文件不可链接到媒体库之外");
    const input = await realpath(path.join(comfyRoot, "input"));
    assertIndependentMediaRoot(mediaDir, input);
    const target = path.join(input, name);
    await mkdir(path.dirname(target), { recursive: true });
    if (!isInside(input, await realpath(path.dirname(target))) || (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())) {
        throw new Error("ComfyUI 输入缓存不可链接到外部目录或文件");
    }
    await copyFile(source, target);
    return name;
}
