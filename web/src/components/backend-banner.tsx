import { useEffect, useState } from "react";
import i18n from "@/i18n";
import { useBackendStore } from "@/stores/use-backend-store";
import { useConfigStore } from "@/stores/use-config-store";
import { AlertCircle, LoaderCircle, RotateCw } from "lucide-react";

/** 总后台连接状态的全局悬浮提示。 */
export function BackendBanner() {
    const connected = useBackendStore((s) => s.connected);
    const checking = useBackendStore((s) => s.checking);
    const error = useBackendStore((s) => s.error);
    const businessError = useBackendStore((s) => s.businessError);
    const [requestError, setRequestError] = useState("");
    useEffect(() => {
        const unavailable = (event: Event) => {
            setRequestError((event as CustomEvent<{ message?: string }>).detail?.message || "");
        };
        const clear = () => {
            setRequestError("");
        };
        window.addEventListener("backend-unavailable", unavailable);
        window.addEventListener("backend-connected", clear);
        window.addEventListener("backend-retry", clear);
        return () => {
            window.removeEventListener("backend-unavailable", unavailable);
            window.removeEventListener("backend-connected", clear);
            window.removeEventListener("backend-retry", clear);
        };
    }, []);

    if (connected && !businessError && !requestError) return null;
    const connecting = checking && !connected;
    const retry = async () => {
        const wasConnected = useBackendStore.getState().connected;
        await useBackendStore.getState().checkConnection();
        if (wasConnected && useBackendStore.getState().connected) window.dispatchEvent(new Event("backend-retry"));
    };

    return (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[1000] flex justify-center px-3">
            <div role={connecting ? "status" : "alert"} aria-live="polite" className="pointer-events-auto flex w-full max-w-3xl items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 text-sm text-amber-900 shadow-lg shadow-black/10 backdrop-blur dark:border-amber-800 dark:bg-amber-950/95 dark:text-amber-100">
                {connecting ? <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" /> : <AlertCircle aria-hidden="true" className="size-4 shrink-0" />}
                <div className="min-w-0 flex-1">
                    <div>{connecting ? i18n.t("backend.connecting") : requestError ? i18n.t("backend.temporarilyUnavailable") : connected ? businessError : i18n.t("backend.disconnected")}</div>
                    {!connecting && (requestError || (!connected ? error : "")) ? <div className="mt-0.5 break-all text-xs opacity-75">{requestError || error}</div> : null}
                </div>
                {!connecting ? <div className="flex shrink-0 items-center gap-3">
                    <button type="button" className="inline-flex items-center gap-1 font-medium underline underline-offset-2" onClick={() => void retry()}><RotateCw aria-hidden="true" className="size-3.5" />{i18n.t("backend.retry")}</button>
                    <button type="button" className="font-medium underline underline-offset-2" onClick={() => useConfigStore.getState().openConfigDialog(false, "connection")}>{i18n.t("backend.settings")}</button>
                </div> : null}
            </div>
        </div>
    );
}
