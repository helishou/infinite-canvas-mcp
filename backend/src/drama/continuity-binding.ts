/** 账本 coverage 声明的事实必须投影到对应镜头的连续性勾选，否则账本写了但编译不会用到。 */
const APPLICABLE_EVIDENCE = new Set(["explicit_hold", "explicit_change"]);

function ids(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
function rows(value: unknown): Array<Record<string, any>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object") : [];
}

export type ContinuityBindingIssue = {
    code: "CONTINUITY_FACT_NOT_SELECTED";
    message: string;
    severity: "blocked";
    affectedTargets: string[];
};

/**
 * coverage 是「哪些事实在本镜生效」的权威；subject_usages[].continuityFactIds 与
 * shot.continuity_facts 是把它们投影给编译器的开关。两者脱节时账本检查仍可能通过，
 * 但 H3 提示词不会带上状态——这里把脱节变成可定位的诊断。
 */
export function auditContinuityFactBindings(source: unknown): ContinuityBindingIssue[] {
    const root = (source ?? {}) as Record<string, any>;
    const ledger = root.ledger;
    if (!ledger || ledger.contract_version !== 2) return [];
    const facts = new Map(rows(ledger.facts).map((fact) => [String(fact.id), fact]));
    const subjects = new Map(rows(root.subject_registry)
        .filter((item) => item.entityRef && typeof item.entityRef === "object")
        .map((item) => [`${String(item.entityRef.kind)}:${String(item.entityRef.id)}`, String(item.id)]));
    const required = new Set(rows(ledger.requirements)
        .filter((req) => req.kind === "hold" || req.kind === "change")
        .map((req) => `${String(req.shot_id)}:${String(req.fact_id)}`));
    const shotById = new Map(rows(root.shots).map((shot) => [String(shot.id), shot]));
    const segmentOfShot = new Map<string, string>();
    for (const segment of rows(root.segments))
        for (const shotId of ids(segment.shot_ids)) segmentOfShot.set(shotId, String(segment.id));

    const missing = new Map<string, Map<string, string[]>>();
    for (const coverage of rows(ledger.coverage)) {
        if (!APPLICABLE_EVIDENCE.has(String(coverage.evidence_kind))) continue;
        for (const shotId of ids(coverage.shot_ids)) {
            const shot = shotById.get(shotId);
            if (!shot) continue;
            const shotLevel = ids(shot.continuity_facts);
            const selected = new Set(shotLevel);
            const usages = rows(shot.subject_usages);
            for (const usage of usages) for (const factId of ids(usage.continuityFactIds)) selected.add(factId);
            for (const factId of ids(coverage.fact_ids)) {
                const fact = facts.get(factId);
                if (!fact || selected.has(factId) || required.has(`${shotId}:${factId}`)) continue;
                const subjectId = subjects.get(`${String(fact.object_kind)}:${String(fact.object_id)}`);
                // 账本事实对应的主体必须在本镜出现（usage 里或镜头级事实里），
                // 不凭空要求新增一个主体图片引用。
                if (!subjectId || (!usages.some((usage) => String(usage.subjectId) === subjectId) && !shotLevel.includes(factId))) continue;
                const segmentId = segmentOfShot.get(shotId) || shotId;
                if (!missing.has(segmentId)) missing.set(segmentId, new Map());
                const byShot = missing.get(segmentId)!;
                if (!byShot.has(shotId)) byShot.set(shotId, []);
                byShot.get(shotId)!.push(factId);
            }
        }
    }
    return [...missing].map(([segmentId, byShot]) => ({
        code: "CONTINUITY_FACT_NOT_SELECTED" as const,
        message: `账本登记的事实没有在对应镜头勾选，编译不会带上该状态：${[...byShot].map(([shotId, ids]) => `${shotId}(${[...new Set(ids)].join(",")})`).join("；")}`,
        severity: "blocked" as const,
        affectedTargets: [segmentId],
    }));
}
