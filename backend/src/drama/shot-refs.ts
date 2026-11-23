/**
 * 拆镜引用清单的命名真值（纯函数，不碰 DB）。
 *
 * 背景：拆镜 prompt 要给模型「道具名 → id」对照，模型才写得出 prop_ids，
 * 参考图才绑得上。但 asset_cards 常常只有 prompt 长描述、没有 name，
 * 直接把 prompt 当名字会给模型一整段描述，模型对不上号 → prop_ids 全空（实测 ep1 0/18）。
 * 道具名的真值在 asset_plan.asset_name，这里按 id 回查取真名。
 */

export type RefRow = Record<string, any>;

export type NamedRef = { id: string; name: string };

const text = (value: unknown): string => (typeof value === "string" || typeof value === "number") ? String(value).trim() : "";
const rows = (value: unknown): RefRow[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object") as RefRow[] : [];

/** asset_plan 里的 id → 资产名（真名，如「铁鞭」「悬赏告示」）。 */
export function planNameIndex(assetPlan: unknown): Map<string, string> {
    const index = new Map<string, string>();
    for (const row of rows(assetPlan)) {
        const id = text(row.id ?? row.asset_id);
        const name = text(row.asset_name ?? row.name);
        if (id && name) index.set(id, name);
    }
    return index;
}

/**
 * 道具引用清单：[{id, name}]。
 * 取名优先级：卡片自带 name > asset_plan.asset_name > prompt 前 12 字 > id。
 * 前三者都可能缺；只有 id 一定在，所以最后一定要落回 id，不能让 name 空着——
 * 空名会让模型把同一道具写成不同叫法，绑定因此失准。
 */
export function propRefsOf(source: Record<string, any> | null | undefined): NamedRef[] {
    const data = source || {};
    const names = planNameIndex(data.asset_plan);
    return rows(data.asset_cards)
        .filter(row => text(row.asset_kind ?? row.kind) === "prop")
        .map(row => {
            const id = text(row.id ?? row.asset_id);
            const name = text(row.name ?? row.asset_name) || names.get(id) || "";
            return { id, name: name || text(row.prompt).slice(0, 12) || id };
        })
        .filter(item => item.id);
}

/** 出场角色引用清单：[{id, name}]，来自 character_registry。名字缺失的条目直接丢弃（模型认不出）。 */
export function characterRefsOf(source: Record<string, any> | null | undefined): NamedRef[] {
    return rows((source || {}).character_registry)
        .map(row => ({ id: text(row.id), name: text(row.name ?? row.characterName) }))
        .filter(item => item.id && item.name);
}
