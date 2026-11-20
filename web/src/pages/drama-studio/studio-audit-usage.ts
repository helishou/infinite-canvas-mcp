/**
 * 按集核查的纯真值派生层（对齐影策 project-asset-audit + lib/drama/asset-usage）。
 *
 * 真值只来自传入的 source（当前集制作稿 director.source）、assets（director.assets）
 * 与 artifacts（director.artifacts 的 h3 请求记录）。不生成、不猜测、不放占位数据：
 * - 资产列表：source.shots[].subject_usages → subject_registry.pictureBindings → asset_plan；
 *   无结构化绑定时才用镜头视觉文本匹配 asset_plan 名称（仍是真实文本派生）。
 * - 缩略图：assets[assetId].storageKey（请求记录 reference.storageKey 作兜底真值）；没有就不显示图。
 * - issue：本机没有 drama_segments.request.references，用 h3 artifact.references（该段真实附图记录）
 *   作为等价真值判定 not-sent / not-selected，用 assets[].storageKey 判定 missing-image。
 */

export type AuditKind = "character" | "scene" | "prop" | "image";
export type AuditIssue = "missing-asset" | "missing-image" | "not-selected" | "not-sent";
export type AuditStatus = "随当前请求发送" | "本次请求不附图" | "未选为本段参考" | "缺少参考图" | "资产已缺失";

export type AuditAssetRow = {
    assetId: string;
    /** 本地「打开资产设定」的目标 ID：资产记录 ID（asset_plan.id / 绑定 assetId），非编造的 castId。 */
    castId: string;
    name: string;
    kind: AuditKind;
    /** 真实参考图 storageKey；空串表示该资产当前没有可用图，UI 不渲染缩略图。 */
    storageKey: string;
    status: AuditStatus;
    issue?: AuditIssue;
    refLabel: string;
    shotCount: number;
};

export type AuditShotRow = {
    id: string;
    position: number;
    description: string;
    durationLabel: string;
    chips: Array<{ assetId: string; name: string; kind: AuditKind; issue?: AuditIssue }>;
};

export type AuditSegment = {
    id: string;
    index: number;
    title: string;
    shotCount: number;
    durationLabel: string;
    pendingCount: number;
    assets: AuditAssetRow[];
    shots: AuditShotRow[];
};

export type AuditUsage = {
    segments: AuditSegment[];
    unassignedShots: AuditShotRow[];
    warnings: string[];
    counts: Record<AuditKind, number>;
    assetCount: number;
};

export const AUDIT_KINDS = ["character", "scene", "prop", "image"] as const;
export const AUDIT_KIND_LABEL: Record<AuditKind, string> = {
    character: "角色", scene: "环境", prop: "道具", image: "附加素材",
};
export const AUDIT_ISSUE_LABEL: Record<AuditIssue, AuditStatus> = {
    "missing-asset": "资产已缺失",
    "missing-image": "缺少参考图",
    "not-selected": "未选为本段参考",
    "not-sent": "本次请求不附图",
};
export const auditStatusOf = (issue?: AuditIssue): AuditStatus => (issue ? AUDIT_ISSUE_LABEL[issue] : "随当前请求发送");

// 只把「对象」当行：segments.shot_ids / subject_usages[].pictureBindingIds 是字符串数组，不能用 rows() 读。
export const auditRows = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];
export const auditStr = (v: unknown): string => (typeof v === "string" || typeof v === "number") ? String(v) : "";

export function auditDuration(frames: number): string {
    const total = Math.max(0, Math.round(frames / 24));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function auditKind(raw: string): AuditKind {
    const k = raw.toLowerCase();
    if (k === "scene" || k === "environment" || k === "场景" || k === "环境") return "scene";
    if (k === "prop" || k === "道具") return "prop";
    // 关键帧/参考图在本机资产计划里是 keyframe/image，对应影策「附加素材」。
    if (k === "image" || k === "keyframe" || k === "附加素材") return "image";
    return "character";
}

/** 没有 artifacts 时也不要把所有资产误判为「已发送」；调用方传 director.artifacts 真值即可。 */
export function buildAuditUsage(
    source: Record<string, unknown> | null,
    assets: Record<string, unknown>,
    artifacts: Array<Record<string, unknown>> = [],
): AuditUsage {
    const src = source || {};
    const warnings: string[] = [];
    const shotById = new Map<string, Record<string, unknown>>();
    const shotPosition = new Map<string, number>();
    auditRows(src.shots).forEach((s, i) => {
        const id = auditStr(s.id);
        if (id) { shotById.set(id, s); shotPosition.set(id, i); }
    });

    const sceneName = new Map<string, string>();
    for (const sc of auditRows(src.scene_registry)) {
        sceneName.set(auditStr(sc.id), auditStr(sc.name || sc.scene_name || sc.id));
    }

    const planById = new Map<string, Record<string, unknown>>();
    for (const p of auditRows(src.asset_plan)) {
        const id = auditStr(p.id || p.asset_id);
        if (id) planById.set(id, p);
    }
    const planIds = new Set(planById.keys());

    // subjectId → assetId：优先 subject_registry.pictureBindings（SUB-LUCHEN → SHARED_..._AST-CHAR-LUCHEN）
    const subjectToAsset = new Map<string, string>();
    // character_registry.id / scene_registry.id → asset_plan.id（用 entity_id 真绑定，不用字符串猜）。
    const registryToAsset = new Map<string, string>();
    for (const p of planById.values()) {
        const entityId = auditStr(p.entity_id);
        if (entityId) registryToAsset.set(entityId, auditStr(p.id || p.asset_id));
    }
    for (const s of auditRows(src.subject_registry)) {
        const subjectId = auditStr(s.id);
        for (const b of auditRows(s.pictureBindings)) {
            const aid = auditStr(b.assetId).split(":")[0];
            if (aid && (planIds.has(aid) || aid in assets)) { subjectToAsset.set(subjectId, aid); break; }
        }
        if (subjectId && !subjectToAsset.has(subjectId)) {
            // SUB_1_CHAR_LIXI / SUB-MULI 等主体名里带 registry id 时，走真实注册表映射。
            const registryId = [...registryToAsset.keys()].find((id) => id && subjectId.includes(id));
            if (registryId) subjectToAsset.set(subjectId, registryToAsset.get(registryId)!);
        }
    }
    const resolveAssetId = (subjectId: string): string => {
        if (!subjectId) return "";
        if (subjectToAsset.has(subjectId)) return subjectToAsset.get(subjectId)!;
        const stripped = subjectId.startsWith("SUB-") ? subjectId.slice(4) : subjectId;
        if (planIds.has(stripped) || stripped in assets) return stripped;
        const tail = stripped.replace(/^AC-(CHAR|SCENE|PROP|IMAGE)-/, "");
        return [...planIds].find((id) => tail.length > 0 && id.endsWith(tail)) || "";
    };

    // 镜头用到的资产：优先 subject_usages；旧剧目没有该字段时从镜头画面描述匹配 asset_plan 名称。
    const explicitUsage = (shot: Record<string, unknown>): string[] => auditRows(shot.subject_usages)
        .map((u) => resolveAssetId(auditStr(u.subjectId))).filter(Boolean);
    const textUsage = (shot: Record<string, unknown>): string[] => {
        const visual = `${auditStr(shot.visual)} ${auditStr(shot.title)}`;
        if (!visual.trim()) return [];
        return [...planById.values()]
            .filter((p) => {
                const name = auditStr(p.asset_name || p.name).trim();
                return name.length >= 2 && visual.includes(name);
            })
            .map((p) => auditStr(p.id || p.asset_id))
            .filter(Boolean);
    };
    const shotAssetIds = (shot: Record<string, unknown>): string[] => {
        const explicit = explicitUsage(shot);
        return explicit.length ? explicit : textUsage(shot);
    };

    const assetName = (aid: string): string => {
        const p = planById.get(aid) || {};
        const media = (assets[aid] || {}) as Record<string, unknown>;
        return auditStr(p.asset_name || p.name || media.title) || aid;
    };
    const assetKind = (aid: string): AuditKind => {
        const p = planById.get(aid) || {};
        return auditKind(auditStr(p.kind || p.asset_type || p.role));
    };
    const storageOf = (aid: string, ref?: Record<string, unknown>): string =>
        auditStr(((assets[aid] || {}) as Record<string, unknown>).storageKey) || auditStr(ref?.storageKey);

    /** 单机 issue 判定：资产在不在 → 有没有图 → 本次 h3 请求有没有带上它。 */
    const issueOf = (aid: string, refs: Array<Record<string, unknown>>): AuditIssue | undefined => {
        const p = planById.get(aid);
        const media = assets[aid] as Record<string, unknown> | undefined;
        if (aid && !p && !media) return "missing-asset";
        const ref = refs.find((r) => {
            if (aid && auditStr(r.assetId) === aid) return true;
            const nodeId = auditStr(media?.nodeId);
            return Boolean(nodeId && auditStr(r.nodeId) === nodeId);
        });
        if (!storageOf(aid, ref)) return "missing-image";
        if (!ref) return "not-selected";
        if (ref.sent === false || !auditStr(ref.storageKey)) return "not-sent";
        return undefined;
    };

    const segmentArtifacts = new Map<string, Array<Record<string, unknown>>>();
    for (const a of artifacts) {
        if (auditStr(a.kind) !== "h3") continue;
        const id = auditStr(a.targetId);
        if (!id) continue;
        const list = segmentArtifacts.get(id) || [];
        list.push(...auditRows(a.references));
        segmentArtifacts.set(id, list);
    }

    const segments: AuditSegment[] = [];
    const assigned = new Set<string>();
    const uniqueAssets = new Map<string, AuditAssetRow>();

    for (const [index, seg] of auditRows(src.segments).entries()) {
        const segId = auditStr(seg.id);
        const rawIds = Array.isArray(seg.shot_ids) ? seg.shot_ids.map(auditStr).filter(Boolean) : [];
        const segShots: Array<Record<string, unknown>> = [];
        for (const id of new Set(rawIds)) {
            const shot = shotById.get(id);
            if (shot) { segShots.push(shot); assigned.add(id); }
            else warnings.push(`第 ${index + 1} 段有无法读取的镜头，请打开该段核查`);
        }

        const useCount = new Map<string, number>();
        for (const shot of segShots) {
            const inShot = new Set<string>();
            for (const aid of shotAssetIds(shot)) {
                if (aid && !inShot.has(aid)) { inShot.add(aid); useCount.set(aid, (useCount.get(aid) || 0) + 1); }
            }
        }

        const refs = segmentArtifacts.get(segId) || [];
        const assetRows: AuditAssetRow[] = [];
        let refNo = 0;
        for (const [aid, count] of useCount) {
            refNo += 1;
            const ref = refs.find((r) => auditStr(r.assetId) === aid);
            const issue = issueOf(aid, refs);
            assetRows.push({
                assetId: aid,
                castId: aid,
                name: assetName(aid),
                kind: assetKind(aid),
                storageKey: storageOf(aid, ref),
                status: auditStatusOf(issue),
                issue,
                refLabel: auditStr(ref?.label) || `参考图${refNo}`,
                shotCount: count,
            });
        }

        const shots: AuditShotRow[] = segShots.map((shot) => ({
            id: auditStr(shot.id),
            position: shotPosition.get(auditStr(shot.id)) ?? 0,
            description: auditStr(shot.visual || shot.title),
            durationLabel: auditDuration(Number(shot.duration_frames) || 0),
            chips: [...new Set(shotAssetIds(shot))].map((aid) => ({
                assetId: aid, name: assetName(aid), kind: assetKind(aid), issue: issueOf(aid, refs),
            })),
        }));

        const first = segShots[0] || {};
        const title = auditStr(seg.summary || seg.title)
            || [sceneName.get(auditStr(first.scene_id)), auditStr(first.title)].filter(Boolean).join(" / ")
            || segId;
        const frames = segShots.reduce((sum, s) => sum + (Number(s.duration_frames) || 0), 0);
        const row = {
            id: segId,
            index,
            title,
            shotCount: segShots.length,
            durationLabel: auditDuration(frames),
            pendingCount: assetRows.filter((a) => Boolean(a.issue)).length,
            assets: assetRows,
            shots: shots.sort((a, b) => a.position - b.position),
        };
        segments.push(row);
        for (const a of row.assets) if (!uniqueAssets.has(a.assetId)) uniqueAssets.set(a.assetId, a);
    }

    const unassignedShots: AuditShotRow[] = auditRows(src.shots)
        .filter((shot) => !assigned.has(auditStr(shot.id)))
        .map((shot) => ({
            id: auditStr(shot.id),
            position: shotPosition.get(auditStr(shot.id)) ?? 0,
            description: auditStr(shot.visual || shot.title),
            durationLabel: auditDuration(Number(shot.duration_frames) || 0),
            chips: [...new Set(shotAssetIds(shot))].map((aid) => {
                const base = issueOf(aid, []);
                // 未关联段没有「本段请求」，影策这里也不标 not-selected/not-sent。
                const issue = base === "not-selected" || base === "not-sent" ? undefined : base;
                return { assetId: aid, name: assetName(aid), kind: assetKind(aid), issue };
            }),
        }));

    for (const shot of unassignedShots) {
        for (const chip of shot.chips) {
            if (!uniqueAssets.has(chip.assetId)) {
                uniqueAssets.set(chip.assetId, {
                    assetId: chip.assetId, castId: chip.assetId, name: chip.name, kind: chip.kind,
                    storageKey: "", status: auditStatusOf(chip.issue), issue: chip.issue,
                    refLabel: "", shotCount: 1,
                });
            }
        }
    }

    const counts: Record<AuditKind, number> = { character: 0, scene: 0, prop: 0, image: 0 };
    for (const asset of uniqueAssets.values()) counts[asset.kind] += 1;
    return { segments, unassignedShots, warnings: [...new Set(warnings)], counts, assetCount: uniqueAssets.size };
}
