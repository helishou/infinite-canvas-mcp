import type { WorkflowField } from "@/types/workflow";

/** RunningHub 值来源选项。constant=运行时填写，其余为注入来源。 */
export const RH_SOURCES = [
    { value: "constant", label: "运行时填写" },
    { value: "prompt", label: "工作流提示词" },
    { value: "image", label: "图片上传" },
    { value: "video", label: "视频上传" },
    { value: "audio", label: "音频上传" },
    { value: "param", label: "H3 参数" },
] as const;

const label = "mb-0.5 block text-[10px] text-stone-500";
const input = "w-full rounded border border-stone-200 px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900";

/**
 * 字段编辑器：本地 ComfyUI 与 RunningHub 共用同一个编辑器。
 * 显示名/类型/默认值是两者共有的部分；
 * RunningHub 额外需要的「值来源 / 必填 / 素材序号」由 rhMode 打开，
 * 所以两个来源在同一个节点浮窗里长得一样，只是可选项不同。
 */
export function FieldEditor({
    field, rawValue, comboOptions, showRunningHub, onUpdate, onRemove,
}: {
    field: WorkflowField;
    rawValue: unknown;
    comboOptions?: string[];
    /** 该字段来自 RunningHub 映射时才显示来源/必填控件。 */
    showRunningHub: boolean;
    onUpdate: (patch: Partial<WorkflowField>) => void;
    onRemove: () => void;
}) {
    return (
        <div className="space-y-2">
            <div>
                <label className={label}>显示名</label>
                <input value={field.name || ""} onChange={(e) => onUpdate({ name: e.target.value })} className={input} placeholder={field.input} />
            </div>

            <div>
                <label className={label}>类型</label>
                <select
                    value={field.type}
                    onChange={(e) => {
                        const type = e.target.value as WorkflowField["type"];
                        const patch: Partial<WorkflowField> = { type };
                        if (type === "number" || type === "slider") {
                            if (typeof rawValue === "number") {
                                patch.min = 0;
                                patch.max = Math.max(rawValue * 2, 10);
                                patch.step = rawValue > 0 && rawValue < 5 ? 0.1 : 1;
                            }
                            patch.randomEnabled = type === "number" ? false : undefined;
                        } else if (type === "dropdown") {
                            patch.options = field.options || comboOptions || [];
                        } else {
                            patch.randomEnabled = undefined;
                            patch.min = undefined;
                            patch.max = undefined;
                            patch.step = undefined;
                        }
                        if (type === "image" || type === "audio" || type === "video") {
                            patch.default = undefined;
                            // 选了媒体类型就必须按素材注入，否则运行时会拿字符串当文件名提交。
                            if (showRunningHub) patch.rhSource = type;
                        }
                        if (type !== "text") patch.isPrompt = false;
                        onUpdate(patch);
                    }}
                    className={input}
                >
                    {(["text", "number", "slider", "boolean", "dropdown", "image", "audio", "video"] as const).map((type) => (
                        <option key={type} value={type}>{type === "text" ? "文本" : type === "number" ? "数字" : type === "slider" ? "滑块" : type === "boolean" ? "布尔" : type === "dropdown" ? "下拉" : type === "image" ? "图片" : type === "audio" ? "音频" : "视频"}</option>
                    ))}
                </select>
            </div>

            {(field.type === "number" || field.type === "slider") && (
                <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-stone-500">最小值<input type="number" value={field.min ?? ""} onChange={(e) => onUpdate({ min: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className={`mt-0.5 ${input}`} /></label>
                    <label className="text-[10px] text-stone-500">最大值<input type="number" value={field.max ?? ""} onChange={(e) => onUpdate({ max: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className={`mt-0.5 ${input}`} /></label>
                    <label className="text-[10px] text-stone-500">步长<input type="number" value={field.step ?? ""} onChange={(e) => onUpdate({ step: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className={`mt-0.5 ${input}`} /></label>
                    <label className="text-[10px] text-stone-500">默认值<input type="number" value={field.default as number ?? ""} onChange={(e) => onUpdate({ default: e.target.value === "" ? undefined : parseFloat(e.target.value) })} className={`mt-0.5 ${input}`} /></label>
                </div>
            )}

            {field.type === "number" && (
                <label className="flex cursor-pointer items-center gap-2 text-[11px]">
                    <input type="checkbox" checked={!!field.randomEnabled} onChange={(e) => onUpdate({ randomEnabled: e.target.checked })} className="size-3" />允许随机值
                </label>
            )}

            {field.type !== "number" && field.type !== "slider" && field.type !== "image" && field.type !== "dropdown" && (
                <div>
                    <label className={label}>默认值</label>
                    {field.type === "boolean" ? (
                        <select value={String(field.default ?? "")} onChange={(e) => onUpdate({ default: e.target.value === "true" })} className={input}>
                            <option value="true">true</option><option value="false">false</option>
                        </select>
                    ) : (
                        <input value={String(field.default ?? "")} onChange={(e) => onUpdate({ default: e.target.value })} className={input} />
                    )}
                </div>
            )}

            {/* 本地 ComfyUI 用 isPrompt 标记提示词字段；RunningHub 没有这个概念，
    它的提示词绑定就是「值来源=工作流提示词」。这里让同一个勾选框在两种来源下
    写各自的字段，避免 RunningHub 出现一个点了没反应的「作为提示词」。 */}
            {(field.type === "text" || showRunningHub) && (
                <label className="flex cursor-pointer items-center gap-2 text-[11px]">
                    <input
                        type="checkbox"
                        checked={showRunningHub ? field.rhSource === "prompt" : !!field.isPrompt}
                        onChange={(e) => onUpdate(showRunningHub ? { rhSource: e.target.checked ? "prompt" : "constant" } : { isPrompt: e.target.checked })}
                        className="size-3"
                    />作为提示词
                </label>
            )}

            {field.type === "dropdown" && (
                <div>
                    <label className="mb-1 block text-[10px] text-stone-500">选项列表</label>
                    <div className="space-y-1">
                        {(field.options || []).map((option, index) => (
                            <div key={index} className="flex items-center gap-1">
                                <input value={option} onChange={(e) => { const options = [...(field.options || [])]; options[index] = e.target.value; onUpdate({ options }); }} className={`flex-1 ${input}`} />
                                <button onClick={() => onUpdate({ options: (field.options || []).filter((_, i) => i !== index) })} className="text-xs text-red-400 hover:text-red-600">×</button>
                            </div>
                        ))}
                    </div>
                    <button onClick={() => onUpdate({ options: [...(field.options || []), ""] })} className="mt-1 rounded border border-dashed border-stone-300 px-3 py-1 text-[11px] hover:border-stone-400 dark:border-stone-600">+ 添加选项</button>
                </div>
            )}

            {showRunningHub && (
                <div className="space-y-2 rounded border border-dashed border-stone-200 p-2 dark:border-stone-700">
                    <div className="text-[10px] font-medium text-stone-500">RunningHub 映射</div>
                    <div>
                        <label className={label}>值来源</label>
                        <select
                            value={field.rhSource || "constant"}
                            onChange={(e) => {
                                const source = e.target.value as NonNullable<WorkflowField["rhSource"]>;
                                onUpdate({
                                    rhSource: source,
                                    // 素材字段必须按序号注入，缺素材即报错。
                                    ...(source === "image" || source === "video" || source === "audio" ? { required: true } : {}),
                                });
                            }}
                            className={input}
                        >
                            {RH_SOURCES.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
                        </select>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-[11px]">
                        <input type="checkbox" checked={field.required === true} onChange={(e) => onUpdate({ required: e.target.checked })} className="size-3" />必填
                    </label>
                    {field.rhSource === "param" ? (
                        <div>
                            <label className={label}>H3 参数名</label>
                            <input value={field.rhParamKey || ""} onChange={(e) => onUpdate({ rhParamKey: e.target.value })} className={input} placeholder="duration / seed / steps" />
                        </div>
                    ) : ["image", "video", "audio"].includes(field.rhSource || "") ? (
                        <div>
                            <label className={label}>素材序号</label>
                            <input type="number" min={1} value={field.rhIndex ?? ""} onChange={(e) => onUpdate({ rhIndex: e.target.value === "" ? undefined : parseInt(e.target.value, 10) })} className={input} placeholder="按字段顺序" />
                        </div>
                    ) : null}
                </div>
            )}

            <div className="flex justify-end border-t border-stone-200/50 pt-2">
                <button onClick={onRemove} className="text-[11px] text-red-400 hover:text-red-600">移除字段</button>
            </div>
        </div>
    );
}