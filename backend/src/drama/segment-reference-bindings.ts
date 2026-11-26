/**
 * 段参考图绑定自动派生（纯函数，对齐影策 bindingsForSegment + H3 reference contract）。
 *
 * 上游拆镜（e40cccb1）已在 shot 上落 characters(entity id)、scene_id(environmentId)、
 * director.shotInputs[shot.id].assetIds(asset_cards.id)。本模块把这些结构化引用翻译成
 * H3 段真正消费的 referenceBindings / referenceOrder / legend：
 *   - entity 域（场景、角色）经 source.asset_plan.entity_id 映射到 asset id；
 *   - 道具的 assetIds 已是 asset id，直接取；
 *   - 媒体只从 director.assets[assetId].storageKey 取，空则跳过（不抛）；
 *   - 名字一律取 asset_plan[].asset_name（回退 row.name），绝不读 asset_cards[].name
 *     （实测普遍为 None）。
 *
 * 不写任何 DB / HTTP，只做数据派生，便于单测锁定顺序、去重与 id 稳定性。
 */
import { REFERENCE_ROLES, stableReferenceId } from "@basketikun/canvas-agent/reference-contract";

type Rec = Record<string, any>;
type Role = (typeof REFERENCE_ROLES)[number];

export type SegmentReferenceLegendEntry = {
    /** 1 起，对应 <Picture N>。 */
    ordinal: number;
    assetId: string;
    name: string;
    kind: string;
    role: Role;
};

export type DerivedSegmentReferenceBindings = {
    bindings: Rec[];
    referenceOrder: string[];
    legend: SegmentReferenceLegendEntry[];
    /** 超出 H3 9 张上限、缺 storageKey 等可观测告警，由调用方写 pipeline 日志。 */
    warnings: string[];
    /** shotId → 该镜在最终 legend 中的参考图编号（1 起），供 segment-writer 使用。 */
    referencesByShot: Record<string, number[]>;
};

type AssetDesc = { assetId: string; name: string; kind: string };

const MAX_H3_REFERENCE_IMAGES = 9;
const ROLE_BY_KIND: Record<string, Role> = {
    character: "character_identity",
    scene: "scene",
    prop: "prop",
};
const CATEGORY_ORDER = ["scene", "character", "prop"] as const;

function recordOf(value: unknown): Rec {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
}

function rows(value: unknown): Rec[] {
    return Array.isArray(value) ? value.map(recordOf) : [];
}

function textOf(value: unknown): string {
    return String(value ?? "").trim();
}

function roleForKind(kind: string): Role {
    return ROLE_BY_KIND[kind.toLowerCase()] || "other";
}

/**
 * asset_plan 的实体域 → asset 描述。
 * 主键是 entity_id；老数据缺 entity_id 时按 kind 找到对应 registry 的同名条目借 id；
 * 再兜底用确定性 id（stableReferenceId('asset', name|assetId)），保证映射稳定可复现。
 */
function buildEntityAssetMap(source: Rec) {
    const byEntity = new Map<string, AssetDesc>();
    const byAssetId = new Map<string, AssetDesc>();
    const byName = new Map<string, AssetDesc>();
    const registries: Record<string, Rec[]> = {
        character: rows(source?.character_registry),
        scene: rows(source?.scene_registry),
        subject: rows(source?.subject_registry),
    };
    const allRegistry = [...registries.character, ...registries.scene, ...registries.subject];

    for (const row of rows(source?.asset_plan)) {
        const assetId = textOf(row.id || row.asset_id);
        if (!assetId) continue;
        const name = textOf(row.asset_name || row.name);
        const kind = textOf(row.kind || row.asset_kind);
        const desc: AssetDesc = { assetId, name, kind };
        if (!byAssetId.has(assetId)) byAssetId.set(assetId, desc);
        if (name && !byName.has(name)) byName.set(name, desc);

        const entityId = textOf(row.entity_id);
        if (entityId) {
            if (!byEntity.has(entityId)) byEntity.set(entityId, desc);
        } else {
            const kindRegistry = registries[kind] || [];
            const reg = (name ? kindRegistry.find((item) => textOf(item.name) === name) : undefined)
                || (name ? allRegistry.find((item) => textOf(item.name) === name) : undefined);
            const key = textOf(reg?.id) || stableReferenceId("asset", name || assetId, 0);
            if (key && !byEntity.has(key)) byEntity.set(key, desc);
        }
        // 有些镜头直接拿 asset id 当 entity id 用，双向兜底不吃亏。
        if (!byEntity.has(assetId)) byEntity.set(assetId, desc);
    }

    const resolve = (entityId: string): AssetDesc | undefined => {
        const id = textOf(entityId);
        if (!id) return undefined;
        const direct = byEntity.get(id);
        if (direct) return direct;
        const reg = allRegistry.find((item) => textOf(item.id) === id);
        if (reg) {
            const named = byName.get(textOf(reg.name));
            if (named) return named;
        }
        return undefined;
    };

    return { resolve, byAssetId };
}

/** 直接 asset id → 描述；不在 asset_plan 的道具用 asset id 当名字、prop 当 kind。 */
function propDesc(assetId: string, byAssetId: Map<string, AssetDesc>): AssetDesc {
    return byAssetId.get(assetId) || { assetId, name: assetId, kind: "prop" };
}

/**
 * 按 shot_ids 顺序、[场景, 角色, 道具] 分类去重派生一段的参考绑定。
 * 顺序与去重规则对齐 scratch_ep2_resegment.ts 的 bindingsForSegment 样板。
 */
export function deriveSegmentReferenceBindings(
    source: Rec,
    director: Rec,
    segmentId: string,
    shotIds: string[],
    shots: Rec[],
): DerivedSegmentReferenceBindings {
    const { resolve, byAssetId } = buildEntityAssetMap(source);
    const assets = recordOf(director?.assets);
    const shotInputs = recordOf(director?.shotInputs);
    const shotById = new Map(rows(shots).map((shot) => [textOf(shot.id), shot]));
    const warnings: string[] = [];

    // 先按镜头收集三类 asset id，再按类别全局去重 → [sceneA, sceneB, char1, char2, prop]。
    const grouped: Array<{ shotId: string; byCategory: Record<(typeof CATEGORY_ORDER)[number], AssetDesc[]> }> = [];
    for (const rawShotId of (Array.isArray(shotIds) ? shotIds : []).map(String)) {
        const shot = shotById.get(rawShotId);
        if (!shot) continue;
        const byCategory: Record<(typeof CATEGORY_ORDER)[number], AssetDesc[]> = { scene: [], character: [], prop: [] };

        const scene = resolve(textOf(shot.scene_id || shot.sceneId));
        if (scene) byCategory.scene.push(scene);

        for (const value of (Array.isArray(shot.characters) ? shot.characters : [])) {
            const entityId = textOf(value?.id || value?.character_id || value);
            const character = resolve(entityId);
            if (character) byCategory.character.push(character);
        }

        const input = recordOf(shotInputs[rawShotId]);
        for (const value of (Array.isArray(input.assetIds) ? input.assetIds : [])) {
            const assetId = textOf(value);
            if (assetId) byCategory.prop.push(propDesc(assetId, byAssetId));
        }
        grouped.push({ shotId: rawShotId, byCategory });
    }

    // 场景图保底：整章只建一个剧本场次时，所有 shot.scene_id 都是章节标题，
    // resolve() 解析不到任何具体场景资产 → 全段没有场景图，ref2va 拿不到环境参考。
    // 此时回退到 asset_plan 中第一个有归档图的场景资产，保证每段至少有一张场景图。
    // 精准的环境级匹配属于后续优化；"绝不让场景图缺席"是这里必须守住的底线。
    const anyScene = grouped.some((group) => group.byCategory.scene.length > 0);
    if (!anyScene) {
        const sceneAssets = rows(source?.asset_plan).filter((row) =>
            textOf(row.kind || row.asset_kind).toLowerCase() === "scene"
            && textOf(recordOf(assets[textOf(row.id || row.asset_id)]).storageKey));
        const fallbackScene = sceneAssets.map((row) => {
            const assetId = textOf(row.id || row.asset_id);
            return { assetId, name: textOf(row.asset_name || row.name) || assetId, kind: "scene" } as AssetDesc;
        })[0];
        if (fallbackScene) {
            for (const group of grouped) group.byCategory.scene.push(fallbackScene);
            warnings.push(`段 ${segmentId}: shot.scene_id 未解析到具体场景，已回退到默认场景图 ${fallbackScene.name}`);
        }
    }

    const ordered: AssetDesc[] = [];
    const seen = new Set<string>();
    const seenStorage = new Set<string>();
    const descriptor = new Map<string, AssetDesc>();
    for (const category of CATEGORY_ORDER) {
        for (const group of grouped) {
            for (const desc of group.byCategory[category]) {
                if (!desc.assetId || seen.has(desc.assetId)) continue;
                // 同一张归档图可能被两个不同 asset 引用（典型：场景图保底补的 asset-plan 项 +
                // 投影阶段的真实场景资产，指向同一 storageKey）。按 storageKey 再去重一次，
                // 否则 H3 会收到两个编号都指向同一张图（实网 ep1 段1 的 <图1><图1>）。
                // 先用有 storageKey 的做键；没有 storageKey 的稍后由 withMedia 阶段剔除。
                const storageKey = textOf(recordOf(assets[desc.assetId]).storageKey);
                if (storageKey && seenStorage.has(storageKey)) continue;
                seen.add(desc.assetId);
                if (storageKey) seenStorage.add(storageKey);
                ordered.push(desc);
                descriptor.set(desc.assetId, desc);
            }
        }
    }

    // 没有归档图的资产不能提交给 H3：跳过并记告警，绝不抛错打断整条流水线。
    const withMedia = ordered.filter((desc) => {
        const storageKey = textOf(recordOf(assets[desc.assetId]).storageKey);
        if (!storageKey) {
            warnings.push(`资产 ${desc.assetId} 没有 storageKey，段 ${segmentId} 跳过该参考图`);
            return false;
        }
        return true;
    });

    let kept = withMedia;
    if (kept.length > MAX_H3_REFERENCE_IMAGES) {
        warnings.push(`段 ${segmentId} 派生参考图 ${kept.length} 张，超过 H3 上限 ${MAX_H3_REFERENCE_IMAGES} 张，已截断`);
        kept = kept.slice(0, MAX_H3_REFERENCE_IMAGES);
    }

    const bindings: Rec[] = [];
    const legend: SegmentReferenceLegendEntry[] = [];
    for (let index = 0; index < kept.length; index += 1) {
        const desc = descriptor.get(kept[index].assetId) || kept[index];
        const bindingId = stableReferenceId("binding", `${segmentId}:${desc.assetId}`, 0);
        const role = roleForKind(desc.kind);
        bindings.push({
            id: bindingId,
            bindingId,
            assetId: desc.assetId,
            label: `<Picture ${index + 1}>`,
            role,
            tags: [],
            enabled: true,
            usage: "reference",
            mediaType: "image",
            storageKey: textOf(recordOf(assets[desc.assetId]).storageKey),
            order: index,
        });
        legend.push({ ordinal: index + 1, assetId: desc.assetId, name: desc.name || desc.assetId, kind: desc.kind, role });
    }

    const ordinalByAssetId = new Map(legend.map((entry) => [entry.assetId, entry.ordinal]));
    const referencesByShot: Record<string, number[]> = {};
    for (const group of grouped) {
        const ordinals: number[] = [];
        for (const category of CATEGORY_ORDER) {
            for (const desc of group.byCategory[category]) {
                const ordinal = ordinalByAssetId.get(desc.assetId);
                if (ordinal !== undefined && !ordinals.includes(ordinal)) ordinals.push(ordinal);
            }
        }
        if (ordinals.length) referencesByShot[group.shotId] = ordinals.sort((a, b) => a - b);
    }

    return {
        bindings,
        referenceOrder: bindings.map((binding) => String(binding.id)),
        legend,
        warnings,
        referencesByShot,
    };
}

/** 中文「参考图N」→ H3 的 <Picture N>；越界编号剔除并返回告警。 */
export function alignPromptPictures(text: string, bindingCount: number): { text: string; warnings: string[] } {
    const warnings: string[] = [];
    const count = Math.max(0, Number(bindingCount) || 0);
    const out = String(text || "").replace(/@?参考图\s*(\d+)/g, (_match, digits: string) => {
        const ordinal = Number(digits);
        if (ordinal >= 1 && ordinal <= count) return `<Picture ${ordinal}>`;
        warnings.push(`提示词引用 参考图${digits} 超出本段 ${count} 张绑定，已剔除`);
        return "";
    });
    return { text: out, warnings };
}
