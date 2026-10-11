// 渠道模型的工作流配置：一个对外暴露的模型可以挂多个内部实现（本地 ComfyUI
// 工作流或 RunningHub 云端工作流档案），并按输入场景（文生 / 单图 / 多图）
// 分别指定走哪个实现、以及该实现的参数；只挂一个实现时三份活都用它，
// 不希望某个场景可用时该场景选「不支持」。
import { App, Button, Checkbox, Input, Modal, Segmented, Select, Tag } from "antd";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { WorkflowCustomFields } from "@/components/workflow-custom-fields";
import { fetchWorkflowDetail, fetchWorkflows, isWorkflowImageField, type WorkflowDetail, type WorkflowField, type WorkflowItem } from "@/services/api/workflows";
import { fetchRunningHubWorkflows, type RunningHubWorkflowProfile } from "@/services/api/runninghub";
import {
    effectiveWorkflowRouting,
    MODEL_INPUT_SCENARIOS,
    MODEL_SCENARIO_LABELS,
    normalizeModelWorkflowParams,
    WORKFLOW_ROUTE_UNSUPPORTED,
    type ChannelModel,
    type ModelCapability,
    type ModelInputScenario,
    type ModelWorkflowBindings,
    type ModelWorkflowParams,
    type ModelWorkflowRouting,
} from "@/stores/use-config-store";

const CAPABILITIES: ModelCapability[] = ["image", "video", "text", "audio"];
const CAPABILITY_LABELS: Record<ModelCapability, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
const UNSUPPORTED_LABEL = "不支持";
const RUNNINGHUB_PREFIX = "runninghub::";
const LOCAL_PREFIX = "local::";

/** 列表里的一项内部实现：本地工作流与 RunningHub 档案共用一套勾选/路由交互。 */
type Implementation = {
    /** 列表与路由使用的稳定键；provider 与标识分开存，改显示名不影响引用。 */
    key: string;
    provider: "comfyui" | "runninghub";
    label: string;
    /** provider=comfyui 时是工作流文件名；runninghub 时是档案 id。 */
    id: string;
};

const localKey = (workflow: string) => `${LOCAL_PREFIX}${workflow}`;
const runningHubKey = (profileId: string) => `${RUNNINGHUB_PREFIX}${profileId}`;

function parseImplementationKey(key: string): { provider: "comfyui" | "runninghub"; id: string } | null {
    if (key.startsWith(RUNNINGHUB_PREFIX)) {
        const profileId = key.slice(RUNNINGHUB_PREFIX.length).trim();
        return profileId ? { provider: "runninghub", id: profileId } : null;
    }
    if (key.startsWith(LOCAL_PREFIX)) {
        const workflow = key.slice(LOCAL_PREFIX.length).trim();
        return workflow ? { provider: "comfyui", id: workflow } : null;
    }
    // 旧配置与 builtin 只有裸文件名，一律按本地工作流解释。
    return key.trim() ? { provider: "comfyui", id: key.trim() } : null;
}

function toBinding(key: string): { provider: "comfyui"; workflow: string } | { provider: "runninghub"; profileId: string } | null {
    const parsed = parseImplementationKey(key);
    if (!parsed) return null;
    return parsed.provider === "runninghub" ? { provider: "runninghub", profileId: parsed.id } : { provider: "comfyui", workflow: parsed.id };
}

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
    const [localWorkflows, setLocalWorkflows] = useState<string[]>([]);
    const [cloudProfiles, setCloudProfiles] = useState<RunningHubWorkflowProfile[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [bindings, setBindings] = useState<ModelWorkflowBindings>({});
    const [routing, setRouting] = useState<ModelWorkflowRouting>({});
    const [params, setParams] = useState<ModelWorkflowParams>({});
    const [paramScenario, setParamScenario] = useState<ModelInputScenario | null>(null);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(model?.name || "");
        setCapability(model?.capability || "image");
        setRouting(model?.workflowRouting || {});
        setParams(model?.workflowParams || {});
        setParamScenario(null);
        setSearch("");
        setLoading(true);
        // 已有绑定的实现即使后端列表里暂时读不到，也要留在列表中，避免保存时静默丢失。
        const legacySelected = (model?.workflows || []).map(localKey);
        setSelected([...new Set([...legacySelected, ...Object.values(model?.workflowBindings || {}).map((binding) => (binding.provider === "runninghub" ? runningHubKey(binding.profileId) : localKey(binding.workflow)))])]);
        setBindings(model?.workflowBindings || {});
        void Promise.allSettled([fetchWorkflows(), fetchRunningHubWorkflows()])
            .then(([local, cloud]) => {
                if (local.status === "fulfilled") setLocalWorkflows(local.value.workflows.map((item: WorkflowItem) => item.name));
                else message.error(local.reason instanceof Error ? local.reason.message : "加载本地工作流失败");
                if (cloud.status === "fulfilled") setCloudProfiles(cloud.value.workflows || []);
                else message.error(cloud.reason instanceof Error ? cloud.reason.message : "加载 RunningHub 工作流失败");
            })
            .finally(() => setLoading(false));
    }, [open, model]);

    /** 本地工作流与 RunningHub 档案合并成一份实现列表。 */
    const implementations = useMemo<Implementation[]>(() => {
        const items: Implementation[] = localWorkflows.map((workflow) => ({ key: localKey(workflow), provider: "comfyui", label: workflow, id: workflow }));
        for (const profile of cloudProfiles) items.push({ key: runningHubKey(profile.id), provider: "runninghub", label: profile.name, id: profile.id });
        return items;
    }, [localWorkflows, cloudProfiles]);

    // 列表带上去重，已选但已不在后端列表里的实现仍显示，避免配置静默丢失。
    const list = useMemo(() => {
        const names = [...implementations.map((item) => item.key), ...selected].filter((item, index, all) => all.indexOf(item) === index);
        const keyword = search.trim().toLowerCase();
        const matched = keyword ? names.filter((key) => (implementations.find((item) => item.key === key)?.label || key).toLowerCase().includes(keyword) || key.toLowerCase().includes(keyword)) : names;
        return matched.map((key) => implementations.find((item) => item.key === key) || { key, provider: parseImplementationKey(key)?.provider || "comfyui", label: parseImplementationKey(key)?.id || key, id: parseImplementationKey(key)?.id || key });
    }, [implementations, selected, search]);

    // 场景的生效实现：「不支持」优先，其次显式绑定，最后沿用旧 routing 回落。
    const effectiveKeys = useMemo<ModelWorkflowRouting>(() => {
        const legacy = effectiveWorkflowRouting((model?.workflows || []), routing);
        const next: ModelWorkflowRouting = {};
        for (const scenario of MODEL_INPUT_SCENARIOS) {
            // 「不支持」是显式声明的场景状态，优先于任何绑定；
            // 否则用户在下拉里选了不支持，会被下面的绑定立刻覆盖回该实现，表现为「点不了」。
            const routed = legacy[scenario];
            const bound = bindings[scenario];
            if (routed === WORKFLOW_ROUTE_UNSUPPORTED) next[scenario] = WORKFLOW_ROUTE_UNSUPPORTED;
            else if (bound) next[scenario] = bound.provider === "runninghub" ? runningHubKey(bound.profileId) : localKey(bound.workflow);
            else next[scenario] = routed ? localKey(routed) : "";
        }
        return next;
    }, [bindings, routing, model?.workflows]);
    const effectiveRouting = effectiveKeys;
    const labels = MODEL_SCENARIO_LABELS[capability];

    const toggle = (key: string, checked: boolean) => {
        const next = checked ? [...selected, key] : selected.filter((item) => item !== key);
        setSelected(next);
        // 取消勾选实现时，同时清掉指向它的场景绑定与旧路由，避免留下悬空引用。
        const parsed = parseImplementationKey(key);
        setBindings((current) => {
            const result: ModelWorkflowBindings = { ...current };
            for (const scenario of MODEL_INPUT_SCENARIOS) {
                const bound = result[scenario];
                const pointsHere = bound && (bound.provider === "runninghub" ? runningHubKey(bound.profileId) : localKey(bound.workflow)) === key;
                if (pointsHere) delete result[scenario];
                else if (bound?.provider === "comfyui" && !next.includes(localKey(bound.workflow))) delete result[scenario];
            }
            return result;
        });
        setRouting((current) => {
            const result: ModelWorkflowRouting = { ...current };
            for (const scenario of MODEL_INPUT_SCENARIOS) {
                const routed = result[scenario];
                if (routed && routed !== WORKFLOW_ROUTE_UNSUPPORTED && !next.includes(localKey(routed))) delete result[scenario];
            }
            return result;
        });
        // 该场景实际走的实现变了 → 上一个实现的参数作废，避免张冠李戴。
        setParams((current) => {
            const kept: ModelWorkflowParams = {};
            for (const scenario of MODEL_INPUT_SCENARIOS) {
                const previous = effectiveRouting[scenario];
                if (previous && effectiveKeys[scenario] === previous && current[scenario]) kept[scenario] = current[scenario];
            }
            return kept;
        });
    };

    const save = () => {
        const trimmed = name.trim();
        if (!trimmed) {
            message.warning("请填写对外暴露的模型名");
            return;
        }
        const localSelected = selected.map((key) => parseImplementationKey(key)).filter((item): item is { provider: "comfyui"; id: string } => item?.provider === "comfyui").map((item) => item.id);
        const cloudSelected = new Set(selected.map((key) => parseImplementationKey(key)).filter((item) => item?.provider === "runninghub").map((item) => (item as { id: string }).id));
        // 只挂了云端实现的场景不需要本地工作流列表；两者都挂时保留本地列表供回落。
        const finalBindings: ModelWorkflowBindings = {};
        for (const scenario of MODEL_INPUT_SCENARIOS) {
            const key = effectiveRouting[scenario];
            if (!key || key === WORKFLOW_ROUTE_UNSUPPORTED) continue;
            const parsed = parseImplementationKey(key);
            const binding = toBinding(key);
            if (!parsed || !binding) continue;
            if (binding.provider === "runninghub" && !cloudSelected.has(binding.profileId)) continue;
            finalBindings[scenario] = binding;
        }
        const finalRouting = localSelected.length ? effectiveWorkflowRouting(localSelected, routing) : undefined;
        const workflowParams = selected.length ? normalizeModelWorkflowParams(params, localSelected.length ? localSelected : [effectiveRouting.text || ""].filter(Boolean), finalRouting) : undefined;
        onSave({
            name: trimmed,
            capability,
            ...(localSelected.length ? { workflows: localSelected } : {}),
            ...(finalRouting ? { workflowRouting: finalRouting } : {}),
            ...(workflowParams ? { workflowParams } : {}),
            ...(Object.keys(finalBindings).length ? { workflowBindings: finalBindings } : {}),
        });
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
                        {list.map((item) => (
                            <Checkbox key={item.key} checked={selected.includes(item.key)} onChange={(event) => toggle(item.key, event.target.checked)}>
                                <span className="inline-flex min-w-0 items-center gap-1">
                                    <span className="truncate" title={item.label}>
                                        {item.label}
                                    </span>
                                    <Tag className="m-0 shrink-0" color={item.provider === "runninghub" ? "blue" : "default"}>
                                        {item.provider === "runninghub" ? "RunningHub" : "ComfyUI"}
                                    </Tag>
                                </span>
                            </Checkbox>
                        ))}
                    </div>
                ) : (
                    <div className="py-8 text-center text-sm text-stone-500">{loading ? "加载中…" : "暂无内部实现，请先在模型页导入模型或在运行环境登记 RunningHub 工作流"}</div>
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
                                options={[
                                    ...selected.map((key) => {
                                        const item = list.find((entry) => entry.key === key);
                                        const parsed = parseImplementationKey(key);
                                        const label = item?.label || parsed?.id || key;
                                        // 不能只看 list：它经过搜索过滤，已勾选的实现常常不在其中，
                                        // 那时 item 为 undefined，RunningHub 会被误标成 ComfyUI。
                                        const tag = (item?.provider || parsed?.provider) === "runninghub" ? "RunningHub" : "ComfyUI";
                                        return { label: `${label}（${tag}）`, value: key };
                                    }),
                                    { label: UNSUPPORTED_LABEL, value: WORKFLOW_ROUTE_UNSUPPORTED },
                                ]}
                                onChange={(value) => {
                                    if (value === routed) return;
                                    const binding = toBinding(value);
                                    // 显式绑定与旧 routing 同时维护：本地实现继续写 routing 以兼容旧配置，云端实现写 bindings。
                                    if (binding?.provider === "runninghub") {
                                        setBindings((current) => ({ ...current, [scenario]: binding }));
                                        setRouting((current) => {
                                            const next = { ...current };
                                            delete next[scenario];
                                            return next;
                                        });
                                    } else if (value !== WORKFLOW_ROUTE_UNSUPPORTED && binding) {
                                        setBindings((current) => {
                                            const next = { ...current };
                                            delete next[scenario];
                                            return next;
                                        });
                                        setRouting((current) => ({ ...current, [scenario]: binding.workflow }));
                                    } else {
                                        // 「不支持」不绑定任何实现：清掉该场景的绑定，保存时才会真正写入不支持。
                                        setBindings((current) => {
                                            const next = { ...current };
                                            delete next[scenario];
                                            return next;
                                        });
                                        setRouting((current) => ({ ...current, [scenario]: value }));
                                    }
                                    // 实现换了 → 旧参数属于旧实现的字段，直接丢弃。
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
                profiles={cloudProfiles}
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

/**
 * 单个输入场景的参数：按该场景实际走的实现拉字段。
 * 本地实现读 ComfyUI 工作流详情；RunningHub 实现的输入映射由运行环境档案管理，
 * 这里只提示去哪里改，不在模型弹窗里复制一份映射。
 */
function ScenarioWorkflowParamsModal({
    open,
    workflow,
    profiles,
    scenarioLabel,
    value,
    onSave,
    onClose,
}: {
    open: boolean;
    workflow: string;
    profiles: RunningHubWorkflowProfile[];
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
    const parsedKey = parseImplementationKey(workflow);
    const cloud = parsedKey?.provider === "runninghub" ? profiles.find((profile) => profile.id === parsedKey.id) : undefined;

    useEffect(() => {
        if (!open || !workflow) return;
        let cancelled = false;
        setLoading(true);
        setValues({});
        // RunningHub 档案没有本地工作流详情可读，字段映射在运行环境里维护。
        if (workflow.startsWith(RUNNINGHUB_PREFIX)) {
            setDetail(null);
            setLoading(false);
            return;
        }
        fetchWorkflowDetail(parseImplementationKey(workflow)?.id || workflow)
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
            title={`${scenarioLabel}参数 · ${cloud ? `${cloud.name}（RunningHub）` : parseImplementationKey(workflow)?.id || workflow}`}
            onCancel={onClose}
            styles={{ body: { maxHeight: "60vh", overflowY: "auto" } }}
            footer={
                cloud
                    ? [<Button key="close" type="primary" onClick={onClose}>
                          知道了
                      </Button>]
                    : [
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
                      ]
            }
        >
            {cloud ? (
                <div className="py-6 text-center text-sm text-stone-500">
                    <div>「{cloud.name}」是 RunningHub 云端工作流，其节点输入映射在「运行环境 → RunningHub 工作流」里配置。</div>
                    <div className="mt-2 text-xs text-stone-400">勾选状态：{cloud.fields.filter((field) => field.enabled !== false).length}/{cloud.fields.length} 个字段已启用</div>
                </div>
            ) : loading ? (
                <div className="py-8 text-center text-sm text-stone-500">加载中…</div>
            ) : fields.length ? (
                <WorkflowCustomFields fields={fields} values={values} onChange={(id, next) => setValues((current) => ({ ...current, [id]: next }))} />
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">该模型实现没有可配置的参数（参考图与提示词由生成时自动注入）。</div>
            )}
        </Modal>
    );
}
