import { App, Button, Drawer, Input, Segmented, Select, Space, Tooltip } from "antd";
import { ListPlus, Network, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultBaseUrlForApiFormat, guessCapability, MODEL_INPUT_SCENARIOS, MODEL_SCENARIO_LABELS, normalizeChannelModels, WORKFLOW_ROUTE_UNSUPPORTED, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { fetchChannelModels } from "@/services/api/image";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose, lockKind = false }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void; lockKind?: boolean }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [testingModels, setTestingModels] = useState<string[]>([]);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "OpenAI Chat", value: "openai-chat" },
        { label: "Gemini", value: "gemini" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) {
            setDraft(channel);
            setTestingModels([]);
        }
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const testConnectivity = async (modelName: string) => {
        setTestingModels((current) => [...current, modelName]);
        try {
            const models = await fetchChannelModels(draft);
            if (!models.includes(modelName)) {
                message.error(t("config.channelEditor.modelUnavailable", { model: modelName }));
                return;
            }
            message.success(t("config.channelEditor.connectionSuccess", { model: modelName }));
        } catch (error) {
            message.error(t("config.channelEditor.connectionFailed", { error: error instanceof Error ? error.message : String(error) }));
        } finally {
            setTestingModels((current) => current.filter((name) => name !== modelName));
        }
    };

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };
    const isCodex = draft.kind === "codex-cli";

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: isCodex ? "text" : guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        if (isCodex && draft.models.some(model => model.capability !== "text" || model.script?.trim())) { message.error(t("config.channelEditor.codexModelsOnly")); return; }
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                {!isCodex && <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>}
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.kind")}</span>
                    <Select aria-label={t("config.channelEditor.kind")} disabled={lockKind} className="w-full" value={draft.kind || "api"} options={[{ label: t("config.channelEditor.apiKind"), value: "api" }, { label: t("config.channelEditor.localKind"), value: "local" }, { label: "Codex CLI", value: "codex-cli" }]} onChange={(kind) => patch({ kind })} />
                </label>
                {isCodex && <p className="text-sm text-muted-foreground md:col-span-2">{t("config.channelEditor.codexHint")}</p>}
                {!isCodex && <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>}
                {!isCodex && <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>}
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                <Space>
                    <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                        {t("config.channelEditor.selectModels")}
                    </Button>
                </Space>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-2 ">
                {draft.models.length ? (
                    draft.models.map((model) => {
                        // 被标记为「不支持」的输入场景，列表里直接标注，避免要靠点开弹窗才知道。
                        const unsupported = MODEL_INPUT_SCENARIOS.filter((scenario) => model.workflowRouting?.[scenario] === WORKFLOW_ROUTE_UNSUPPORTED);
                        return (
                            <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60 dark:hover:bg-muted/40">
                                <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                    {model.name}
                                </span>
                                <Tooltip title={t("config.channelEditor.testConnectivity")}>
                                    <Button size="small" icon={<Network className="size-3.5" />} loading={testingModels.includes(model.name)} onClick={() => void testConnectivity(model.name)}>
                                        {t("config.channelEditor.test")}
                                    </Button>
                                </Tooltip>
                                {unsupported.length ? (
                                    <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                                        不支持：{unsupported.map((scenario) => MODEL_SCENARIO_LABELS[model.capability][scenario]).join(" / ")}
                                    </span>
                                ) : null}
                                <div className="flex shrink-0 items-center gap-2">
                                    <Segmented size="small" value={model.capability} options={isCodex ? capabilityOptions.filter(option => option.value === "text") : capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                    {!isCodex && <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                        {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                    </Button>}
                                    <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-muted-foreground">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />

        </Drawer>
    );
}
