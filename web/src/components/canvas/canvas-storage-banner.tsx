import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, theme } from "antd";
import { saveAs } from "file-saver";
import { canvasDraftPersistence } from "@/lib/canvas/canvas-draft-persistence";

export function CanvasStorageBanner() {
    const failures = useSyncExternalStore(canvasDraftPersistence.subscribe, canvasDraftPersistence.getSnapshot);
    const { token } = theme.useToken();
    const [busy, setBusy] = useState(false);
    const [leaseError, setLeaseError] = useState("");
    useEffect(() => {
        const lost = (event: Event) => setLeaseError((event as CustomEvent<{ message?: string }>).detail?.message || "本机草稿已由另一窗口接管，当前窗口已停止写入。");
        window.addEventListener("canvas-draft-lease-lost", lost);
        return () => window.removeEventListener("canvas-draft-lease-lost", lost);
    }, []);
    useEffect(() => {
        if (!failures.length) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [failures.length]);
    if (!failures.length && !leaseError) return null;
    return <>
        {leaseError ? <div role="alert" aria-label="本机草稿租约失效" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs" style={{ background: token.colorErrorBg, borderColor: token.colorErrorBorder, color: token.colorText }}>
            <div className="min-w-0 flex-1">{leaseError}</div>
            <Button type="text" size="small" onClick={() => window.location.reload()}>刷新并重新认领</Button>
        </div> : null}
        {failures.length ? <div role="alert" aria-label="本机草稿保存失败" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs" style={{ background: token.colorWarningBg, borderColor: token.colorWarningBorder, color: token.colorText }}>
        <div className="min-w-0 flex-1">
            <div>有 {failures.length} 项本机草稿保存失败，请勿直接刷新或关闭页面。</div>
            <div className="mt-1 break-words" style={{ color: token.colorTextSecondary }}>{[...new Set(failures.map((item) => item.label))].join("、")}：{failures[0].error}。内存备份仅保存恢复记录，不包含媒体文件。</div>
        </div>
        <Button type="text" size="small" loading={busy} onClick={async () => {
            setBusy(true);
            try { await canvasDraftPersistence.retry(); window.dispatchEvent(new Event("canvas-storage-recovered")); } catch { /* 未成功项保留在持续提示中。 */ }
            finally { setBusy(false); }
        }}>重试保存</Button>
        <Button type="text" size="small" onClick={() => saveAs(new Blob([JSON.stringify(canvasDraftPersistence.exportBackup(), null, 2)], { type: "application/json" }), "canvas-unsaved-memory.json")}>导出内存备份</Button>
        </div> : null}
    </>;
}
