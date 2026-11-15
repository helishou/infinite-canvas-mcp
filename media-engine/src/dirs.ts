import os from "node:os";
import path from "node:path";

/** 引擎数据目录：宿主显式注入；独立服务走 MEDIA_ENGINE_* 环境变量或默认目录。 */
export type EngineDirs = {
    dataDir: string;
    mediaDir: string;
    /** ffmpeg / ffprobe 所在目录；空串表示走 PATH。 */
    mediaToolsDir: string;
};

/**
 * 目录解析优先级：宿主注入 > MEDIA_ENGINE_* > 画布既有 INFINITE_CANVAS_* > 引擎默认目录。
 * 兼容 INFINITE_CANVAS_* 是为了让同一份环境约定对测试、维护脚本和探针继续成立——它们只设这一组
 * 变量，不会先加载 backend config 去打 setEngineDirs。
 */
export function resolveEngineDirs(override?: Partial<EngineDirs>): EngineDirs {
    const env = process.env;
    const dataDir = path.resolve(
        override?.dataDir
        ?? env.MEDIA_ENGINE_DATA_DIR
        ?? env.INFINITE_CANVAS_DATA_DIR
        ?? path.join(os.homedir(), ".media-engine"),
    );
    const mediaDir = path.resolve(
        override?.mediaDir
        ?? env.MEDIA_ENGINE_MEDIA_DIR
        ?? env.INFINITE_CANVAS_MEDIA_DIR
        ?? path.join(dataDir, "runtime-media"),
    );
    const mediaToolsDir = override?.mediaToolsDir ?? env.MEDIA_ENGINE_MEDIA_TOOLS_DIR ?? "";
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