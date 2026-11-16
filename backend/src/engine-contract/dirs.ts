/**
 * 从执行引擎 `comfyui2api/src/dirs.ts` 落地到画布的类型/纯函数副本。
 * 目的：画布不再 import 引擎 npm 包，双方只通过 HTTP 通信。
 * 同步方式：引擎侧该文件改动时，这里需要手工同步（内容已冻结，不含 I/O）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 引擎数据目录：宿主显式注入；独立服务走 COMFYUI2API_* 环境变量或默认目录。 */
export type EngineDirs = {
    dataDir: string;
    mediaDir: string;
    /** ffmpeg / ffprobe 所在目录；空串表示走 PATH。 */
    mediaToolsDir: string;
};

/**
 * 目录解析优先级：宿主注入 > COMFYUI2API_* > 画布既有 INFINITE_CANVAS_* > 引擎默认目录。
 * 兼容 INFINITE_CANVAS_* 是为了让同一份环境约定对测试、维护脚本和探针继续成立——它们只设这一组
 * 变量，不会先加载 backend config 去打 setEngineDirs。
 */
/** 新旧两套环境变量并存：改名后旧脚本里的 MEDIA_ENGINE_* 仍然生效。 */
function envAny(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name];
        if (value) return value;
    }
    return undefined;
}

/**
 * 数据目录默认值：优先 ~/.comfyui2api；只有新目录不存在、旧目录还在时才回落到
 * ~/.media-engine，避免改名把已有模型/任务库当成空库。
 */
function defaultDataDir(): string {
    const home = os.homedir();
    const current = path.join(home, ".comfyui2api");
    const legacy = path.join(home, ".media-engine");
    if (fs.existsSync(current)) return current;
    if (fs.existsSync(legacy)) return legacy;
    return current;
}

export function resolveEngineDirs(override?: Partial<EngineDirs>): EngineDirs {
    const env = process.env;
    const dataDir = path.resolve(
        override?.dataDir
        ?? envAny("COMFYUI2API_DATA_DIR", "MEDIA_ENGINE_DATA_DIR")
        ?? env.INFINITE_CANVAS_DATA_DIR
        ?? defaultDataDir(),
    );
    const mediaDir = path.resolve(
        override?.mediaDir
        ?? envAny("COMFYUI2API_MEDIA_DIR", "MEDIA_ENGINE_MEDIA_DIR")
        ?? env.INFINITE_CANVAS_MEDIA_DIR
        ?? path.join(dataDir, "runtime-media"),
    );
    const mediaToolsDir = override?.mediaToolsDir ?? envAny("COMFYUI2API_MEDIA_TOOLS_DIR", "MEDIA_ENGINE_MEDIA_TOOLS_DIR") ?? "";
    return { dataDir, mediaDir, mediaToolsDir };
}

let current: EngineDirs | null = null;

/** 宿主启动时注入自己的目录（画布 Backend 传 DATA_DIR / MEDIA_DIR / MEDIA_TOOLS_DIR）。 */
export function setEngineDirs(dirs: EngineDirs): void {
    current = dirs;
}

/** 首次使用时解析（环境变量在 import 之后设置也生效）；宿主注入过的目录始终优先。 */
export function engineDirs(): EngineDirs {
    current ??= resolveEngineDirs();
    return current;
}