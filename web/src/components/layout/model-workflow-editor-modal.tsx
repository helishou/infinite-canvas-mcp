// 渠道模型的工作流配置：一个对外暴露的模型可以挂多个 ComfyUI 工作流，
// 并按输入场景（文生 / 单图 / 多图）分别指定走哪个工作流、以及该工作流的参数；
// 只挂一个工作流时三份活都用它，不希望某个场景可用时该场景选「不支持」。
import { App, Button, Checkbox, Input, Modal, Segmented, Select } from "antd";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { WorkflowCustomFields } from "@/components/workflow-custom-fields";
import { fetchWorkflowDetail, fetchWorkflows, isWorkflowImageField, type WorkflowDetail, type WorkflowField, type WorkflowItem } from "@/services/api/workflows";
import {
    effectiveWorkflowRouting,
    MODEL_INPUT_SCENARIOS,
    MODEL_SCENARIO_LABELS,
    normalizeModelWorkflowParams,
    WORKFLOW_ROUTE_UNSUPPORTED,
    type ChannelModel,
    type ModelCapability,
    type ModelInputScenario,
    type ModelWorkflowParams,
    type ModelWorkflowRouting,
} from "@/stores/use-config-store";

const CAPABILITIES: ModelCapability[] = ["image", "video", "text", "audio"];
const CAPABILITY_LABELS: Record<ModelCapability, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
const UNSUPPORTED_LABEL = "不支持";

/** 面板里展示的字段：非参考图输入、非提示词（与生成侧的取字段口径一致）。 */
function editableFields(detail: WorkflowDetail | null) {
    return (detail?.config?.fields || []).filter((field) => !isWorkflowImageField(field, detail?.workflow) && !field.isPrompt);
}

/** 字段默认值：下拉必须命中 options，否则 ComfyUI 会报 value_not_in_list。 */
function defaultFieldValue(field: WorkflowField) {
    if (field.type === "dropdown") {
        const options = field.options || [];
        return options.includes(String(field.default ?? "")) ? field.default : (options[0] ?? "");
    }
    return field.default ?? (field.type === "boolean" ? false : field.type === "number" || field.type === "slider" ? 0 : "");
}

export function ModelWorkflowEditorModal({ open, model, onSave, onClose }: { open: boolean; model: ChannelModel | null; onSave: (model: ChannelModel) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const [name, setName] = useState("");
    const [capability, setCapability] = useState<ModelCapability>("image");
    const [available, setAvailable] = useState<string[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [routing, setRouting] = useState<ModelWorkflowRouting>({});
    const [params, setParams] = useState<ModelWorkflowParams>({});
    const [paramScenario, setParamScenario] = useState<ModelInputScenario | null>(null);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(model?.name || "");
        setCapability(model?.capability || "image");
        setSelected(model?.workflows || []);
        setRouting(model?.workflowRouting || {});
        setParams(model?.workflowParams || {});
        setParamScenario(null);
        setSearch("");
        setLoading(true);
        fetchWorkflows()
            .then((data) => setAvailable(data.workflows.map((item: WorkflowItem) => item.name)))
            .catch((error) => message.error(error instanceof Error ? error.message : "加载模型实现失败"))
            .finally(() => setLoading(false));
    }, [open, model]);

    // 列表带上去重，已选但已不在后端列表里的工作流仍显示，避免配置静默丢失。
    const list = useMemo(() => {
        const names = [...available, ...selected].filter((item, index, all) => all.indexOf(item) === index);
        const keyword = search.trim().toLowerCase();
        return keyword ? names.filter((item) => item.toLowerCase().includes(keyword)) : names;
    }, [available, selected, search]);

    // 展示口径与保存口径一致：未显式配置的场景实际就是「回落用第一个工作流」。
    const effectiveRouting: ModelWorkflowRouting = selected.length ? effectiveWorkflowRouting(selected, routing) : {};
    const labels = MODEL_SCENARIO_LABELS[capability];

    const toggle = (workflow: string, checked: boolean) => {
        const workflows = checked ? [...selected, workflow] : selected.filter((item) => item !== workflow);
        const nextRouting = effectiveWorkflowRouting(workflows, routing);
        setSelected(workflows);
        setRouting(nextRouting);
        // 该场景实际走的工作流变了（含变成「不支持」/无工作流）→ 上一个工作流的参数作废，避免张冠李戴。
        setParams((current) => {
            const next: ModelWorkflowParams = {};
            for (const scenario of MODEL_INPUT_SCENARIOS) {
                const routed = nextRouting[scenario];
                if (routed && routed !== WORKFLOW_ROUTE_UNSUPPORTED && routed === effectiveRouting[scenario] && current[scenario]) next[scenario] = current[scenario];
            }
            return next;
        });
    };

    const save = () => {
        const trimmed = name.trim();
        if (!trimmed) {
            message.warning("请填写对外暴露的模型名");
            return;
        }
        const finalRouting = selected.length ? effectiveWorkflowRouting(selected, routing) : undefined;
        const workflowParams = selected.length ? normalizeModelWorkflowParams(params, selected, routing) : undefined;
        onSave({ name: trimmed, capability, workflows: selected, workflowRouting: finalRouting, workflowParams });
        onClose();
    };

    const unsupportedScenarios = MODEL_INPUT_SCENARIOS.filter((scenario) => effectiveRouting[scenario] === WORKFLOW_ROUTE_UNSUPPORTED);

    return (
        <Modal
            open={open}
            width={760}
            centered
            onCancel={onClose}
            title={model?.name ? `配置模型：${model.name}` : "添加模型"}
            styles={{ body: { maxHeight: "64vh", overflowY: "auto" } }}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    取消
                </Button>,
                <Button key="save" type="primary" onClick={save}>
                    保存
                </Button>,
            ]}
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">模型名（对外暴露）</span>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 krea2" />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">能力</span>
                    <Segmented className="w-full" value={capability} options={CAPABILITIES.map((value) => ({ label: CAPABILITY_LABELS[value], value }))} onChange={(value) => setCapability(value as ModelCapability)} />
                </label>
            </div>

            <div className="mt-5 mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold">
                    内部实现 <span className="ml-1 text-xs font-normal text-stone-500">已选 {selected.length} 个</span>
                </span>
                <Input className="w-56" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索内部实现" prefix={<Search className="size-4 text-stone-400" />} allowClear />
            </div>

            <div className="max-h-56 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {list.length ? (
                    <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
                        {list.map((workflow) => (
                            <Checkbox key={workflow} checked={selected.includes(workflow)} onChange={(event) => toggle(workflow, event.target.checked)}>
                                <span className="truncate" title={workflow}>
                                    {workflow}
                                </span>
                            </Checkbox>
                        ))}
                    </div>
                ) : (
                    <div className="py-8 text-center text-sm text-stone-500">{loading ? "加载中…" : "暂无本地实现，请先在模型页导入模型"}</div>
                )}
            </div>

            <div className="mt-5 text-sm font-semibold">输入场景路由与参数</div>
            <div className="mt-0.5 text-xs text-stone-500">
                单图 / 多图指本次携带 1 张 / 多张参考（视频、文本、音频同理按参考数量区分）；一个内部实现支持全部场景时三个场景选同一个即可。某个场景不需要对外可用，就选「{UNSUPPORTED_LABEL}」。每个场景还能单独配置参数。
            </div>
            <div className="mt-2 space-y-2">
                {MODEL_INPUT_SCENARIOS.map((scenario) => {
                    const routed = effectiveRouting[scenario];
                    const usable = Boolean(routed) && routed !== WORKFLOW_ROUTE_UNSUPPORTED;
                    const count = params[scenario] ? Object.keys(params[scenario] || {}).length : 0;
                    return (
                        <div key={scenario} className="flex flex-wrap items-center gap-2">
                            <span className="w-20 shrink-0 text-xs font-medium text-stone-500">{labels[scenario]}</span>
                            <Select
                                className="min-w-0 flex-1"
                                disabled={!selected.length}
                                value={routed || undefined}
                                placeholder={selected.length ? "选择内部实现" : "先选内部实现"}
                                options={[...selected.map((workflow) => ({ label: workflow, value: workflow })), { label: UNSUPPORTED_LABEL, value: WORKFLOW_ROUTE_UNSUPPORTED }]}
                                onChange={(value) => {
                                    if (value === routed) return;
                                    setRouting((current) => ({ ...current, [scenario]: value }));
                                    // 工作流换了 → 旧参数属于旧工作流的字段，直接丢弃。
                                    setParams((current) => {
                                        if (!current[scenario]) return current;
                                        const next = { ...current };
                                        delete next[scenario];
                                        return next;
                                    });
                                }}
                            />
                            <Button size="small" disabled={!usable} onClick={() => setParamScenario(scenario)}>
                                参数{count ? ` ${count}` : ""}
                            </Button>
                        </div>
                    );
                })}
            </div>
            {unsupportedScenarios.length ? (
                <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">已标记不支持：{unsupportedScenarios.map((scenario) => labels[scenario]).join(" / ")}；用该模型做这类生成时会直接提示不支持，不会回落到其它实现。</div>
            ) : selected.length === 1 ? (
                <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">当前只挂了一个内部实现，文生 / 单图 / 多图都会使用它（参数仍可按场景分别配置）。</div>
            ) : null}

            <ScenarioWorkflowParamsModal
                open={Boolean(paramScenario)}
                workflow={paramScenario ? effectiveRouting[paramScenario] || "" : ""}
                scenarioLabel={paramScenario ? labels[paramScenario] : ""}
                value={paramScenario ? params[paramScenario] : undefined}
                onSave={(next) => {
                    if (!paramScenario) return;
                    setParams((current) => {
                        const merged = { ...current };
                        if (next && Object.keys(next).length) merged[paramScenario] = next;
                        else delete merged[paramScenario];
                        return merged;
                    });
                }}
                onClose={() => setParamScenario(null)}
            />
        </Modal>
    );
}

/** 单个输入场景的工作流参数：按该场景实际走的工作流拉字段，填的覆盖值随模型一起保存。 */
function ScenarioWorkflowParamsModal({
    open,
    workflow,
    scenarioLabel,
    value,
    onSave,
    onClose,
}: {
    open: boolean;
    workflow: string;
    scenarioLabel: string;
    value?: Record<string, unknown>;
    onSave: (value?: Record<string, unknown>) => void;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const [detail, setDetail] = useState<WorkflowDetail | null>(null);
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [loading, setLoading] = useState(false);
    const fields = editableFields(detail);

    useEffect(() => {
        if (!open || !workflow) return;
        let cancelled = false;
        setLoading(true);
        setValues({});
        fetchWorkflowDetail(workflow)
            .then((next) => {
                if (cancelled) return;
                setDetail(next);
                const initial: Record<string, unknown> = {};
                for (const field of editableFields(next)) initial[field.id] = defaultFieldValue(field);
                setValues({ ...initial, ...(value || {}) });
            })
            .catch((error) => {
                if (cancelled) return;
                setDetail(null);
                message.error(error instanceof Error ? error.message : "读取模型实现失败");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // value 只在弹窗打开时取初值，后续编辑不再被外部覆盖。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, workflow]);

    const applied = value ? Object.keys(value).length : 0;

    return (
        <Modal
            open={open}
            centered
            width={560}
            title={`${scenarioLabel}参数 · ${workflow}`}
            onCancel={onClose}
            styles={{ body: { maxHeight: "60vh", overflowY: "auto" } }}
            footer={[
                applied ? (
                    <Button
                        key="clear"
                        danger
                        type="text"
                        onClick={() => {
                            onSave(undefined);
                            onClose();
                        }}
                    >
                        清除该场景参数
                    </Button>
                ) : null,
                <Button key="cancel" onClick={onClose}>
                    取消
                </Button>,
                <Button
                    key="save"
                    type="primary"
                    onClick={() => {
                        onSave(values);
                        onClose();
                    }}
                >
                    保存
                </Button>,
            ]}
        >
            {loading ? (
                <div className="py-8 text-center text-sm text-stone-500">加载中…</div>
            ) : fields.length ? (
                <WorkflowCustomFields fields={fields} values={values} onChange={(id, next) => setValues((current) => ({ ...current, [id]: next }))} />
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">该模型实现没有可配置的参数（参考图与提示词由生成时自动注入）。</div>
            )}
        </Modal>
    );
}
