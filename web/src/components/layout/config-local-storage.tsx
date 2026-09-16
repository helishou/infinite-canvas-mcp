import { Button, Input } from "antd";
import { App } from "antd";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchDataDir, saveDataDir } from "@/services/backend-api";

export function ConfigLocalStorage({ active }: { active: boolean }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [dataDir, setDataDir] = useState("");
    const [dataDirLoading, setDataDirLoading] = useState(false);

    const loadDataDir = useCallback(async () => {
        try {
            const result = await fetchDataDir();
            setDataDir(result.configuredDataDir ?? "");
        } catch { /* ignore */ }
    }, []);

    const saveBackendDataDir = useCallback(async (value: string) => {
        setDataDirLoading(true);
        try {
            await saveDataDir(value.trim());
            message.success(t("config.localStorage.dataDirSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.localStorage.dataDirSaveFailed"));
        } finally {
            setDataDirLoading(false);
        }
    }, [t, message]);

    useEffect(() => {
        if (active) {
            void loadDataDir();
        }
    }, [active, loadDataDir]);

    return (
        <div className="space-y-3">
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <FolderOpen className="size-4" />
                            {t("config.localStorage.dataDir")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.localStorage.dataDirDescription")}</div>
                    </div>
                </div>
                <div className="mt-3">
                    <Input
                        placeholder={t("config.localStorage.dataDirPlaceholder")}
                        value={dataDir}
                        onChange={(e) => setDataDir(e.target.value)}
                        onBlur={(e) => void saveBackendDataDir(e.target.value)}
                        onPressEnter={(e) => void saveBackendDataDir((e.target as HTMLInputElement).value)}
                        suffix={
                            <Button
                                type="text"
                                size="small"
                                icon={<RefreshCw className="size-3" />}
                                loading={dataDirLoading}
                                onClick={() => void saveBackendDataDir(dataDir)}
                            />
                        }
                    />
                    <div className="mt-1.5 text-[11px] text-stone-400">{t("config.localStorage.dataDirHint")}</div>
                </div>
            </section>
            <section className="rounded-lg border border-stone-200 p-4 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">
                {t("config.localStorage.backendStorageDescription")}
            </section>
        </div>
    );
}
