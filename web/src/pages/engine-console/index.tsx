import { useEffect, useState } from "react";

/**
 * 画布自己的工作流页面已下线：工作流、模型、RunningHub、实例全部由执行引擎 `comfyui2api` 管理。
 * 这里只做一个跳转页，避免旧书签落到 404。
 */
const ENGINE_CONSOLE_URL = "http://127.0.0.1:8300/";

export function EngineConsolePage() {
    const [engineUrl, setEngineUrl] = useState(ENGINE_CONSOLE_URL);

    useEffect(() => {
        // 引擎地址可能改过（本地/局域网），先问后端拿一次，拿不到就用默认值。
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch("/api/engine/console");
                if (!response.ok) return;
                const body = (await response.json()) as { url?: string };
                if (!cancelled && body.url) setEngineUrl(body.url);
            } catch {
                /* 后端没起来就用默认地址 */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-start justify-center gap-6 px-6 py-12">
            <div className="space-y-2">
                <h1 className="text-2xl font-semibold">工作流已迁移到执行引擎</h1>
                <p className="text-sm text-muted-foreground">
                    工作流库、字段映射、RunningHub 档案和 ComfyUI 实例现在都由 <code>comfyui2api</code> 引擎统一管理。
                    画布只负责编排与生成，不再自带工作流管理页。
                </p>
            </div>

            <div className="w-full rounded-lg border border-border bg-card px-4 py-3">
                <div className="text-xs text-muted-foreground">引擎控制台</div>
                <div className="mt-1 break-all font-mono text-sm">{engineUrl}</div>
            </div>

            <div className="flex flex-wrap gap-3">
                <a
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                    href={engineUrl}
                    target="_blank"
                    rel="noreferrer"
                >
                    打开引擎控制台
                </a>
                <a className="rounded-md border border-border px-4 py-2 text-sm" href={engineUrl.replace(/\/$/, "") + "/models"}>
                    模型清单
                </a>
                <a className="rounded-md border border-border px-4 py-2 text-sm" href={engineUrl.replace(/\/$/, "") + "/tasks"}>
                    任务与日志
                </a>
            </div>

            <p className="text-xs text-muted-foreground">
                生成仍然在画布里进行：图片、视频、音频节点直接用渠道里 <code>engine-local</code> 的模型即可。
            </p>
        </div>
    );
}

export default EngineConsolePage;
