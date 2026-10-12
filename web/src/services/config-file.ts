import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { defaultConfig, defaultWebdavSyncConfig, importConfigConfirmed, importWebdavConfirmed, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { importPromptSourcesConfirmed, usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

import { commitConfigImport, validateConfigImport } from "./config-import-operation";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    const before = useConfigStore.getState();
    const beforePrompts = usePromptSourceStore.getState();
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (!validateConfigImport(data, defaultConfig, defaultWebdavSyncConfig)) throw new Error(i18n.t("config.invalidFile"));
    await commitConfigImport([
        { domain: "config", save: () => importConfigConfirmed(data.config, before.config) },
        { domain: "webdav", save: () => importWebdavConfirmed(data.webdav, before.webdav) },
        { domain: "prompts", save: () => importPromptSourcesConfirmed(data.promptSources, beforePrompts) },
    ]);
}
