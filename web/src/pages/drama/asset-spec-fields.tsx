import { Input, Select } from "antd";
import { useTranslation } from "react-i18next";
import type { AssetSpec, AssetSpecKind } from "@/services/backend-api";

/**
 * 角色 / 场景 / 道具设定卡的字段区（纯展示 + 受控编辑）。
 *
 * 剧目级「资产设定」页签和画布节点编辑弹窗共用这一份，
 * 字段顺序、长短文本、角色专有的定位/标签/关系只有一处定义。
 */

export const SPEC_KINDS: AssetSpecKind[] = ["character", "scene", "prop"];

export const SPEC_FIELDS: Record<AssetSpecKind, string[]> = {
    character: ["age", "gender", "identity", "trueIdentity", "personality", "appearance", "motivation", "conflict", "catchphrase", "arc", "negativePrompt"],
    scene: ["lighting", "landmarks", "styleNotes", "negativePrompt"],
    prop: ["material", "sizeNote", "styleNotes", "negativePrompt"],
};

const LONG_FIELDS = new Set(["appearance", "personality", "conflict", "arc", "landmarks", "material", "styleNotes", "lighting"]);

export function readSpecField(spec: AssetSpec | null, kind: AssetSpecKind, key: string): string {
    const bucket = (spec as Record<string, unknown> | null)?.[kind] as Record<string, unknown> | undefined;
    const value = bucket?.[key];
    return typeof value === "string" ? value : "";
}

export function patchSpecField(spec: AssetSpec | null, kind: AssetSpecKind, key: string, value: unknown): AssetSpec {
    const base = (spec || { kind }) as AssetSpec;
    const bucket = { ...((base as Record<string, unknown>)[kind] as Record<string, unknown> | undefined) };
    bucket[key] = value;
    return { ...base, kind, [kind]: bucket } as AssetSpec;
}

export function AssetSpecFields({ kind, spec, onChange, disabled }: {
    kind: AssetSpecKind;
    spec: AssetSpec | null;
    onChange: (next: AssetSpec) => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const set = (key: string, value: unknown) => onChange(patchSpecField(spec, kind, key, value));
    const character = ((spec as Record<string, unknown> | null)?.character || {}) as Record<string, unknown>;

    return <div className="space-y-2.5" data-asset-spec-fields={kind}>
        <div className="grid gap-2.5 md:grid-cols-2">
            {SPEC_FIELDS[kind].filter((key) => key !== "negativePrompt").map((key) => <label key={key} className={`block ${LONG_FIELDS.has(key) ? "md:col-span-2" : ""}`}>
                <span className="mb-1 block text-[11px] text-foreground/60">{t(`assetSpec.field.${key}`)}</span>
                <Input.TextArea disabled={disabled} autoSize={{ minRows: LONG_FIELDS.has(key) ? 2 : 1, maxRows: 6 }}
                    value={readSpecField(spec, kind, key)} onChange={(event) => set(key, event.target.value)} />
            </label>)}
        </div>

        {kind === "character" ? <>
            <div className="grid gap-2.5 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-[11px] text-foreground/60">{t("assetSpec.field.role")}</span>
                    <Select className="w-full" size="small" allowClear disabled={disabled} value={(character.role as string) || undefined}
                        onChange={(value) => set("role", value || "")}
                        options={[{ value: "hero", label: t("assetSpec.role.hero") }, { value: "supporting", label: t("assetSpec.role.supporting") }, { value: "cameo", label: t("assetSpec.role.cameo") }]} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-[11px] text-foreground/60">{t("assetSpec.field.tags")}</span>
                    <Input size="small" disabled={disabled} value={((character.tags as string[] | undefined) || []).join("、")} placeholder={t("assetSpec.tagsPlaceholder")}
                        onChange={(event) => set("tags", event.target.value.split(/[、,，\s]+/).filter(Boolean))} />
                </label>
            </div>
            <label className="block">
                <span className="mb-1 block text-[11px] text-foreground/60">{t("assetSpec.field.relationships")}</span>
                <Input.TextArea disabled={disabled} autoSize={{ minRows: 2, maxRows: 6 }} placeholder={t("assetSpec.relationshipPlaceholder")}
                    value={((character.relationships as Array<{ name: string; relation: string }> | undefined) || []).map((item) => `${item.name}｜${item.relation}`).join("\n")}
                    onChange={(event) => set("relationships", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
                        const [name, relation] = line.split(/[｜|]/);
                        return { name: (name || "").trim(), relation: (relation || "").trim() };
                    }))} />
            </label>
        </> : null}

        <label className="block">
            <span className="mb-1 block text-[11px] text-foreground/60">{t("assetSpec.field.negativePrompt")}</span>
            <Input.TextArea disabled={disabled} autoSize={{ minRows: 1, maxRows: 3 }} placeholder={t("assetSpec.negativePlaceholder")}
                value={readSpecField(spec, kind, "negativePrompt")} onChange={(event) => set("negativePrompt", event.target.value)} />
        </label>
    </div>;
}
