export type ConfigImportDomain = "config" | "webdav" | "prompts";
export class ConfigImportFailure extends Error {
    constructor(readonly completed: ConfigImportDomain[], readonly pending: ConfigImportDomain[], readonly changedDuringImport = false) {
        super("Configuration import incomplete");
    }
}

/** Independent endpoints have no transaction. Report acknowledgements, never pretend rollback. */
export async function commitConfigImport(steps: { domain: ConfigImportDomain; save: () => Promise<void> }[]) {
    const completed: ConfigImportDomain[] = [];
    for (const [index, step] of steps.entries()) {
        try { await step.save(); }
        catch (error) { throw new ConfigImportFailure(completed, steps.slice(index).map(item => item.domain), error instanceof Error && error.message === "CONFIG_CHANGED_DURING_IMPORT"); }
        completed.push(step.domain);
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Check every domain before issuing any write; normalization still belongs to its store. */
export function validateConfigImport(value: unknown, configDefaults: Record<string, unknown>, webdavDefaults: Record<string, unknown>) {
    if (!isRecord(value) || value.app !== "infinite-canvas" || value.version !== 1 || !isRecord(value.config) || !isRecord(value.webdav) || !isRecord(value.promptSources)) return false;
    for (const [input, defaults] of [[value.config, configDefaults], [value.webdav, webdavDefaults]]) {
        for (const [key, sample] of Object.entries(defaults)) {
            if (!(key in input)) continue;
            const item = input[key];
            if (Array.isArray(sample) ? !Array.isArray(item) : typeof item !== typeof sample || item === null) return false;
        }
    }
    const config = value.config;
    if (config.models !== undefined && (!Array.isArray(config.models) || !config.models.every(item => typeof item === "string"))) return false;
    if (config.channels !== undefined) {
        if (!Array.isArray(config.channels)) return false;
        const ids = new Set<string>();
        for (const channel of config.channels) {
            if (!isRecord(channel) || !["id", "name", "baseUrl", "apiKey", "apiFormat"].every(key => typeof channel[key] === "string") || !Array.isArray(channel.models)) return false;
            if (!channel.id || ids.has(channel.id as string)) return false;
            ids.add(channel.id as string);
            for (const model of channel.models) {
                if (!isRecord(model) || typeof model.name !== "string" || !["image", "video", "text", "audio"].includes(String(model.capability))) return false;
                if (model.workflows !== undefined && (!Array.isArray(model.workflows) || !model.workflows.every(item => typeof item === "string"))) return false;
                for (const key of ["workflowRouting", "workflowParams", "workflowBindings"]) if (model[key] !== undefined && !isRecord(model[key])) return false;
            }
        }
    }
    const { sources, schedule } = value.promptSources;
    if (!Array.isArray(sources) || !isRecord(schedule) || (schedule.intervalMinutes !== undefined && (typeof schedule.intervalMinutes !== "number" || !Number.isFinite(schedule.intervalMinutes))) || (schedule.lastFetchedAt !== undefined && typeof schedule.lastFetchedAt !== "string")) return false;
    return sources.every(source => isRecord(source) && ["id", "name", "url", "homepage"].every(key => source[key] === undefined || typeof source[key] === "string") && ["enabled", "builtIn"].every(key => source[key] === undefined || typeof source[key] === "boolean"));
}
