import { Input, Select, Switch } from "antd";

import type { WorkflowField } from "@/services/api/workflows";

// 工作流的非 image / 非 prompt 自定义字段：text / number / slider / boolean / dropdown
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
    return (
        <div className="space-y-3">
            {fields.filter((field) => field.type !== "image").map((field) => (
                <CustomFieldInput key={field.id} field={field} value={values[field.id]} onChange={(value) => onChange(field.id, value)} />
            ))}
        </div>
    );
}

function CustomFieldInput({ field, value, onChange }: { field: WorkflowField; value: unknown; onChange: (value: unknown) => void }) {
    const label = <span className="mb-1.5 block text-sm font-semibold">{field.name}</span>;
    switch (field.type) {
        case "boolean":
            return (
                <label className="flex cursor-pointer items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{field.name}</span>
                    <Switch checked={value === true} onChange={(checked) => onChange(checked)} />
                </label>
            );
        case "dropdown": {
            const options = field.options || [];
            const current = options.includes(String(value ?? "")) ? String(value ?? "") : options[0] ?? "";
            return (
                <label className="block">
                    {label}
                    <Select
                        value={current || undefined}
                        onChange={(next) => onChange(next)}
                        options={options.map((option) => ({ value: option, label: option }))}
                        className="w-full"
                    />
                </label>
            );
        }
        case "number":
        case "slider":
            return (
                <label className="block">
                    {label}
                    <Input
                        type="number"
                        value={value === undefined || value === null ? "" : String(value)}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        onChange={(event) => onChange(event.target.value === "" ? (field.default ?? 0) : Number(event.target.value))}
                    />
                </label>
            );
        case "text":
        default:
            return (
                <label className="block">
                    {label}
                    <Input value={value === undefined || value === null ? "" : String(value)} onChange={(event) => onChange(event.target.value)} />
                </label>
            );
    }
}
