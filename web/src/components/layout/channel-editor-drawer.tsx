import { App, Button, Drawer, Input, InputNumber, Segmented, Select, Space, Tooltip } from "antd";
import { ListPlus, Network, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultBaseUrlForApiFormat, guessCapability, MODEL_INPUT_SCENARIOS, MODEL_SCENARIO_LABELS, normalizeChannelModels, normalizeModelVideoCapabilities, WORKFLOW_ROUTE_UNSUPPORTED, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { fetchChannelModelItems, fetchChannelModels, type ChannelModelHint } from "@/services/api/image";
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
    const [extraText, setExtraText] = useState("");
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "OpenAI Chat", value: "openai-chat" },
        { label: "Gemini", value: "gemini" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) {
            setDraft(channel);
            setExtraText(channel?.extraBody && Object.keys(channel.extraBody).length ? JSON.stringify(channel.extraBody, null, 2) : "");
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
    /** Codex 与 Hermes 都是原生引擎渠道：不需要 baseUrl/apiKey，模型只能是文本。 */
    const isCodex = draft.kind === "codex-cli" || draft.kind === "hermes";

    const applySelection = async (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        // 对面 /v1/models 带 capability / maxAudios / 视频能力五项就用它（引擎真上报才带），
        // 否则按名字猜。没上报的字段保持缺省，绝不伪造；已登记的手填值在引擎没上报时保留。
        const hints = new Map<string, ChannelModelHint>();
        try {
            for (const item of await fetchChannelModelItems(draft)) hints.set(item.name, item);
        } catch {
            /* 拉不到提示不影响选模型 */
        }
        setModels(names.map((name) => {
            const hint = hints.get(name);
            const existing = map.get(name);
            return {
                name,
                capability: isCodex ? "text" : ((hint?.capability as ModelCapability | undefined) ?? existing?.capability ?? guessCapability(name)),
                ...(hint?.maxAudios !== undefined || existing?.maxAudios !== undefined
                    ? { maxAudios: hint?.maxAudios ?? existing?.maxAudios } : {}),
                ...normalizeModelVideoCapabilities({ ...existing, ...hint }),
            };
        }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setMaxAudios = (name: string, value: number | null) => setModels(draft.models.map((model) => (model.name === name
        ? { ...model, ...(value === null || !Number.isSafeInteger(value) || value < 0 ? { maxAudios: undefined } : { maxAudios: value }) } : model)));
    const setSupportsImages = (name: string, value: "auto" | "yes" | "no") => setModels(draft.models.map((model) => (model.name === name ? { ...model, supportsImages: value === "auto" ? undefined : value === "yes" } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        if (isCodex && draft.models.some(model => model.capability !== "text" || model.script?.trim())) { message.error(t("config.channelEditor.codexModelsOnly")); return; }
        let extraBody: Record<string, unknown> | undefined;
        if (extraText.trim()) {
            try {
                const parsed = JSON.parse(extraText) as unknown;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    message.error("额外参数必须是 JSON 对象");
                    return;
                }
                extraBody = parsed as Record<string, unknown>;
            } catch {
                message.error("额外参数不是合法 JSON");
                return;
            }
        }
        onSave({ ...draft, extraBody, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
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
                    <Select aria-label={t("config.channelEditor.kind")} disabled={lockKind} className="w-full" value={draft.kind || "api"} options={[{ label: t("config.channelEditor.apiKind"), value: "api" }, { label: t("config.channelEditor.localKind"), value: "local" }, { label: "Codex CLI", value: "codex-cli" }, { label: "Hermes", value: "hermes" }]} onChange={(kind) => patch({ kind })} />
                </label>
                {isCodex && <p className="text-sm text-muted-foreground md:col-span-2">{draft.kind === "hermes" ? "Hermes 渠道：模型名直接写 Hermes 的 modelId，形如 opencode-go:deepseek-v4.1-flash。对话由本机 hermes acp 执行，工具、技能、记忆都在 Hermes 侧。" : t("config.channelEditor.codexHint")}</p>}
                {!isCodex && <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    {draft.apiFormat === "openai" && !isCodex ? (
                        <div className="mt-2">
                            <div className="mb-1 text-xs text-muted-foreground">额外参数（JSON，原样并入 /v1/images/generations；本地引擎可传 params / overrides）</div>
                            <Input.TextArea
                                value={extraText}
                                onChange={(event) => setExtraText(event.target.value)}
                                placeholder='{"params": {"加速": true}, "overrides": {"11.megapixels": 2}}'
                                autoSize={{ minRows: 2, maxRows: 6 }}
                                spellCheck={false}
                            />
                        </div>
                    ) : null}
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>}
                {!isCodex && <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>}
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">渠道最大并发数</span>
                    <InputNumber
                        className="w-full"
                        min={1}
                        max={999}
                        precision={0}
                        value={draft.concurrencyLimit}
                        onChange={(value) => patch({ concurrencyLimit: value ?? undefined })}
                        placeholder="留空跟随全局"
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">留空表示使用全局渠道并发上限；1-999。</span>
                </label>
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
                                    {!isCodex && model.capability === "text" && (
                                        <Tooltip title={t("config.channelEditor.visionHint")}>
                                            <Segmented
                                                size="small"
                                                value={model.supportsImages === true ? "yes" : model.supportsImages === false ? "no" : "auto"}
                                                options={[
                                                    { label: t("config.channelEditor.visionAuto"), value: "auto" },
                                                    { label: t("config.channelEditor.visionSupported"), value: "yes" },
                                                    { label: t("config.channelEditor.visionUnsupported"), value: "no" },
                                                ]}
                                                onChange={(value) => setSupportsImages(model.name, value as "auto" | "yes" | "no")}
                                            />
                                        </Tooltip>
                                    )}
                                    <Segmented size="small" value={model.capability} options={isCodex ? capabilityOptions.filter(option => option.value === "text") : capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                    {!isCodex && model.capability === "video" && (
                                        <Tooltip title="单段参考音色上限（影策 MaxAudios）。引擎 /v1/models 暴露真实槽位数时自动填入；本地 H3 原生工作流无该声明时留空按 3 回落。0 = 不提交参考音色。">
                                            <InputNumber aria-label={`${model.name} 参考音色上限`} size="small" min={0} max={9} precision={0} value={model.maxAudios} placeholder="默认3"
                                                onChange={(value) => setMaxAudios(model.name, value)} className="w-24" />
                                        </Tooltip>
                                    )}
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
