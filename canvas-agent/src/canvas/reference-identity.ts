/**
 * 逻辑编号 ↔ 稳定身份（P0-B 阶段一，只读校验）。
 *
 * H3 提示词用 `<Picture N>` / `<Video N>` / `<Audio N>` 这类**逻辑编号**引用素材，
 * 编号按提交顺序临时分配；正文里禁止出现内部 asset ID。于是「删掉 / 换掉第 2 张参考图」
 * 会让 `<Picture 3>` 静默指向另一张图，而编译期原先只校验编号数量、不校验编号指向谁。
 *
 * 本模块把「编号 → 身份」的映射显式化，提供：
 *   - buildLabelMap：从编译结果生成映射；
 *   - labelMapHash：稳定摘要，供绑定前后比对；
 *   - validateReferenceIdentity：编译期只读一致性检查（只产 warning）；
 *   - compareLabelMaps：两次编译之间的身份漂移检查（只产 warning）；
 *   - rewritePromptLabels：按身份重映射正文（本阶段导出备用，不启用改写）。
 *
 * 身份只存在于 manifest / 编译产物元数据里，绝不写进正文；不改动 `<Picture N>` 格式，
 * 因此不会碰翻译冻结哈希与已定稿段。
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { CompiledReference, ReferenceIssue } from "./reference-contract.js";

/** 跨重排稳定的身份。storageKey 计入，使「同一 assetId 换图」也能被检出。 */
export type ReferenceIdentityKey = {
    assetId: string;
    bindingId: string;
    storageKey?: string;
    sourceNodeId?: string;
    subjectId?: string;
    groupId?: string;
    pictureBindingId?: string;
};

export type ReferenceLabelEntry = {
    token: string;
    ordinal: number;
    mediaType: string;
    label: string;
    identity: ReferenceIdentityKey;
};

export type ReferenceLabelMap = {
    version: 1;
    byToken: Record<string, ReferenceLabelEntry>;
    /** 可选：冻结映射时的正文摘要，用于区分「合法重排」与「换图但正文没改」。 */
    promptHash?: string;
};

const TOKEN_PATTERN = /<(Picture|Video|Audio)\s+(\d+)>/giu;

export function normalizeReferenceToken(token: string): string {
    const match = /^<(picture|video|audio)\s+(\d+)>$/iu.exec(String(token || "").trim());
    if (!match) return String(token || "").trim();
    const kind = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    return `<${kind} ${Number(match[2])}>`;
}

export function identityOf(reference: Pick<CompiledReference, "id" | "assetId" | "storageKey" | "sourceNodeId" | "subjectId" | "groupId" | "pictureBindingId">): ReferenceIdentityKey {
    return {
        assetId: String(reference.assetId || ""),
        bindingId: String(reference.id || ""),
        ...(reference.storageKey ? { storageKey: String(reference.storageKey) } : {}),
        ...(reference.sourceNodeId ? { sourceNodeId: String(reference.sourceNodeId) } : {}),
        ...(reference.subjectId ? { subjectId: String(reference.subjectId) } : {}),
        ...(reference.groupId ? { groupId: String(reference.groupId) } : {}),
        ...(reference.pictureBindingId ? { pictureBindingId: String(reference.pictureBindingId) } : {}),
    };
}

/**
 * 素材身份的规范化字符串，用于比对与摘要；字段顺序固定，不受对象插入顺序影响。
 * 刻意不含 bindingId / pictureBindingId：两条不同绑定指向同一张图，正是「重复占槽」
 * 与「换图后编号错指」要识别的场景；绑定 id 变化但素材没变不应误报漂移。
 */
export function identityKeyOf(identity: ReferenceIdentityKey): string {
    return [
        identity.assetId, identity.storageKey || "",
        identity.sourceNodeId || "", identity.subjectId || "", identity.groupId || "",
    ].join("\u0000");
}

export function buildLabelMap(references: CompiledReference[], promptHash?: string): ReferenceLabelMap {
    const byToken: Record<string, ReferenceLabelEntry> = {};
    for (const reference of references) {
        const token = normalizeReferenceToken(reference.token);
        byToken[token] = {
            token,
            ordinal: reference.ordinal,
            mediaType: reference.mediaType,
            label: String(reference.label || ""),
            identity: identityOf(reference),
        };
    }
    return { version: 1, byToken, ...(promptHash ? { promptHash } : {}) };
}

/** 只由「编号 → 身份」决定的稳定摘要；编号顺序变化不影响，身份变化一定影响。 */
export function labelMapHash(map: ReferenceLabelMap): string {
    const canonical = Object.keys(map.byToken).sort()
        .map((token) => `${token}=${identityKeyOf(map.byToken[token].identity)}`)
        .join("\n");
    return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

export function promptTokensOf(prompt: string): string[] {
    return [...new Set([...String(prompt || "").matchAll(TOKEN_PATTERN)]
        .map((match) => normalizeReferenceToken(match[0])))];
}

/**
 * 编译期只读一致性检查。只产出 severity:"warning"：
 * `assertReferenceCompilation` 只过滤 error，因此不会阻断生成。
 */
export function validateReferenceIdentity(prompt: string, map: ReferenceLabelMap): ReferenceIssue[] {
    const issues: ReferenceIssue[] = [];
    const entries = Object.values(map.byToken);
    const byIdentity = new Map<string, ReferenceLabelEntry>();
    for (const entry of entries) {
        const key = identityKeyOf(entry.identity);
        const prior = byIdentity.get(key);
        if (prior && prior.token !== entry.token) {
            issues.push({
                severity: "warning",
                code: "prompt_reference_identity_duplicated",
                message: `${prior.token} 与 ${entry.token} 指向同一份素材；重排后编号可能互换，请核对正文`,
            });
        } else if (!prior) byIdentity.set(key, entry);
        if (!entry.identity.assetId || !entry.identity.bindingId) {
            issues.push({
                severity: "warning",
                code: "prompt_reference_identity_unstable",
                message: `${entry.token}（${entry.label}）缺少稳定的 assetId / bindingId，换图后无法追踪编号指向`,
            });
        }
    }
    // 正文已经使用了编号体系，却有绑定未在正文出现：常见于增删参考图后正文没跟上。
    const used = new Set(promptTokensOf(prompt));
    if (used.size) {
        const unused = entries.filter((entry) => !used.has(entry.token)).map((entry) => entry.token);
        if (unused.length) issues.push({
            severity: "warning",
            code: "prompt_reference_identity_unused",
            message: `绑定已分配 ${unused.join("、")}，但正文没有引用这些编号；请确认是重排后正文未同步，还是确实不需要`,
        });
    }
    return issues;
}

/**
 * 两次编译之间的身份漂移检查。用于「绑定前后比对」与「删除/换图前预检」。
 * 正文同步改写过 = 合法重排，不报；正文没变但身份变了 = 静默错指。
 */
export function compareLabelMaps(
    before: ReferenceLabelMap,
    after: ReferenceLabelMap,
    options: { promptBefore?: string; promptAfter?: string } = {},
): ReferenceIssue[] {
    const issues: ReferenceIssue[] = [];
    const promptBefore = options.promptBefore ?? "";
    const promptAfter = options.promptAfter ?? promptBefore;
    const promptUnchanged = promptBefore === promptAfter;
    for (const [token, entry] of Object.entries(after.byToken)) {
        const prior = before.byToken[token];
        if (!prior) continue;
        if (identityKeyOf(prior.identity) === identityKeyOf(entry.identity)) continue;
        if (!promptUnchanged) continue;
        issues.push({
            severity: "warning",
            code: "prompt_reference_identity_mismatch",
            message: `${token} 指向的素材已变化（${prior.label} → ${entry.label}），但正文未同步改写；该编号可能已指向另一张图`,
        });
    }
    const stillUsed = new Set(promptTokensOf(promptAfter));
    for (const token of Object.keys(before.byToken)) {
        if (after.byToken[token] || !stillUsed.has(token)) continue;
        issues.push({
            severity: "warning",
            code: "prompt_reference_dangling",
            message: `${token} 对应的绑定已被移除，但正文仍引用该编号；请先修改正文再删除资产`,
        });
    }
    return issues;
}

/**
 * 按身份把正文里的旧编号一次性替换成新编号。
 * 单次 replace 而非链式替换，避免 1→2、2→3 连续漂移；同时避免 `<Picture 1>` 误匹配 `<Picture 10>`。
 */
export function rewritePromptLabels(prompt: string, before: ReferenceLabelMap, after: ReferenceLabelMap): string {
    const afterByIdentity = new Map<string, string>();
    for (const entry of Object.values(after.byToken)) afterByIdentity.set(identityKeyOf(entry.identity), entry.token);
    const mapping = new Map<string, string>();
    for (const [token, entry] of Object.entries(before.byToken)) {
        const next = afterByIdentity.get(identityKeyOf(entry.identity));
        if (next && next !== token) mapping.set(token, next);
    }
    if (!mapping.size) return prompt;
    return String(prompt || "").replace(TOKEN_PATTERN, (marker) => mapping.get(normalizeReferenceToken(marker)) || normalizeReferenceToken(marker));
}
