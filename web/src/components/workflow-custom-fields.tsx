import { Input, Segmented, Select, Switch } from "antd";

import type { WorkflowField } from "@/services/api/workflows";

// 工作流的非媒体 / 非 prompt 自定义字段：text / number / slider / boolean / dropdown
// 生图工作台与画布图片节点共享同一份 UI。
export function WorkflowCustomFields({
    fields,
    values,
    onChange,
}: {
    fields: WorkflowField[];
    values: Record<string, unknown>;
    onChange: (id: string, value: unknown) => void;
}) {
    const visible = fields.filter((field) => !["image", "audio", "video"].includes(field.type));
    return (
        <div className="space-y-3">
            {labelWorkflowFields(visible).map(({ field, label }) => (
                <CustomFieldInput key={field.id} field={field} label={label} value={values[field.id]} onChange={(value) => onChange(field.id, value)} />
            ))}
        </div>
    );
}

/**
 * 工作流里常见多个节点导出同名输入（例如每个文本节点都有一个 Text1），
 * 直接显示 field.name 会出现一列重复标题，分不清改的是哪个。同名的补上「节点.输入」后缀。
 */
export function labelWorkflowFields(fields: WorkflowField[]): Array<{ field: WorkflowField; label: string }> {
    const counts = new Map<string, number>();
    for (const field of fields) {
        const name = fieldTitle(field);
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    const seen = new Map<string, number>();
    return fields.map((field) => {
        const name = fieldTitle(field);
        if ((counts.get(name) || 0) <= 1) return { field, label: name };
        const order = (seen.get(name) || 0) + 1;
        seen.set(name, order);
        const suffix = field.node && field.input ? `${field.node}.${field.input}` : `#${order}`;
        return { field, label: `${name} · ${suffix}` };
    });
}

function fieldTitle(field: WorkflowField): string {
    return String(field.name || field.input || field.id).trim();
}

/** 数值回显：去掉 0.5000000000000001 这类浮点噪声，同时保留有意义的小数位。 */
export function formatFieldNumber(value: unknown): string {
    if (value === undefined || value === null || value === "") return "";
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return String(value);
    if (Number.isInteger(parsed)) return String(parsed);
    const rounded = Number(parsed.toPrecision(6));
    return String(rounded);
}

function CustomFieldInput({ field, label, value, onChange }: { field: WorkflowField; label: string; value: unknown; onChange: (value: unknown) => void }) {
    const caption = <span className="mb-1.5 block text-sm font-semibold">{label}</span>;
    switch (field.type) {
        case "boolean":
            return (
                <label className="flex cursor-pointer items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{label}</span>
                    <Switch checked={value === true} onChange={(checked) => onChange(checked)} />
                </label>
            );
        case "dropdown": {
            const options = field.options || [];
            const current = options.includes(String(value ?? "")) ? String(value ?? "") : options[0] ?? "";
            return (
                <label className="block">
                    {caption}
                    <Select
                        value={current || undefined}
                        onChange={(next) => onChange(next)}
                        options={options.map((option) => ({ value: option, label: option }))}
                        className="w-full"
                        popupStyle={{ zIndex: 1300 }}
                    />
                </label>
            );
        }
        case "number":
        case "slider": {
            // seed 类字段（randomEnabled）支持「固定 / 随机」两态：
            // 随机态向工作流写 -1，后端 prepareRun 会把它换成每次新种子；
            // 固定态就是输入框里的具体数值，可复现。
            const randomCapable = field.type === "number" && field.randomEnabled !== false && /seed/i.test(field.id);
            const isRandom = Number(value) === -1;
            return (
                <label className="block">
                    {caption}
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            value={isRandom ? "" : formatFieldNumber(value)}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            placeholder={isRandom ? "每次随机" : undefined}
                            disabled={isRandom}
                            onChange={(event) => onChange(event.target.value === "" ? (field.default ?? 0) : Number(event.target.value))}
                        />
                        {randomCapable && (
                            <Segmented
                                size="small"
                                value={isRandom ? "random" : "fixed"}
                                options={[
                                    { label: "固定", value: "fixed" },
                                    { label: "随机", value: "random" },
                                ]}
                                onChange={(next) => onChange(next === "random" ? -1 : (field.default ?? 0))}
                            />
                        )}
                    </div>
                </label>
            );
        }
        case "text":
        default:
            return (
                <label className="block">
                    {caption}
                    <Input value={value === undefined || value === null ? "" : String(value)} onChange={(event) => onChange(event.target.value)} />
                </label>
            );
    }
}
