import { inferReferenceRole, referenceCatalogOf, stableReferenceId, type ProjectReferenceAsset } from "../../canvas/reference-contract.js";

/**
 * 有序分镜组（orderedGroup）的槽位账本解析。
 *
 * `metadata.groupSlots` 是派生账本，抽帧、复制组、拖拽三条写路径都可能漏写或串组；
 * 槽位读取与替换都必须能沿它的两个上游（成员 metadata.groupId、源视频镜头）重建，
 * 而不是把空账本当成「这个组没有槽位」。
 */

const SLOT_POSITION_TOLERANCE = 8;

export type StoryboardSlotIssue = { code: string; slot?: number; message: string };

export type StoryboardSlotSource = "groupSlots" | "memberGroupId" | "sourceVideoShots" | "empty";

export type ResolvedStoryboardSlot = {
    slot: number;
    nodeId: string;
    title: string;
    status: string;
    storageKey: string;
    url?: string;
    mimeType?: string;
    width: number;
    height: number;
    aspectRatio?: string;
    shotNumber?: number;
    assetIds: string[];
};

export type StoryboardGroupSlots = {
    groupId: string;
    title: string;
    columns?: number;
    declaredShotCount?: number;
    sourceVideoNodeId?: string;
    slotSource: StoryboardSlotSource;
    slots: ResolvedStoryboardSlot[];
    issues: StoryboardSlotIssue[];
};

function recordOf(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function positionSort(left: Record<string, any>, right: Record<string, any>) {
    const a = recordOf(left.position);
    const b = recordOf(right.position);
    const deltaY = Number(a.y || 0) - Number(b.y || 0);
    if (Math.abs(deltaY) > SLOT_POSITION_TOLERANCE) return deltaY;
    return Number(a.x || 0) - Number(b.x || 0);
}

function shotNumberSort(left: Record<string, any>, right: Record<string, any>) {
    const a = Number(recordOf(left.metadata).shotNumber);
    const b = Number(recordOf(right.metadata).shotNumber);
    const aKnown = Number.isFinite(a);
    const bKnown = Number.isFinite(b);
    if (aKnown && bKnown && a !== b) return a - b;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return positionSort(left, right);
}

function gcd(left: number, right: number): number {
    return right ? gcd(right, left % right) : left;
}

/** 活动图片：节点当前 storageKey 指向的那张，尺寸取 images[] 里的自然尺寸。 */
export function readNodeImage(node: Record<string, any>) {
    const metadata = recordOf(node.metadata);
    const storageKey = String(metadata.storageKey || "");
    const images = Array.isArray(metadata.images) ? metadata.images.map(recordOf) : [];
    const image = images.find((item) => String(item.storageKey || "") === storageKey) || {};
    return {
        storageKey,
        url: String(image.url || metadata.content || ""),
        mimeType: String(image.mimeType || metadata.mimeType || ""),
        width: Number(image.naturalWidth || metadata.naturalWidth || 0),
        height: Number(image.naturalHeight || metadata.naturalHeight || 0),
    };
}

/** 常见画幅档位；抽帧/生成图的尺寸常有几像素误差（如 2944×1664 精确约分是 23:13），按 1% 归一到人读得懂的档位。 */
const COMMON_ASPECT_RATIOS: Array<[string, number]> = [
    ["21:9", 21 / 9], ["2.39:1", 2.39], ["2:1", 2], ["16:9", 16 / 9], ["16:10", 16 / 10],
    ["3:2", 3 / 2], ["4:3", 4 / 3], ["5:4", 5 / 4], ["1:1", 1],
    ["4:5", 4 / 5], ["3:4", 3 / 4], ["2:3", 2 / 3], ["9:16", 9 / 16],
];

export function aspectRatioOf(width: number, height: number): string | undefined {
    if (!(width > 0 && height > 0)) return undefined;
    const actual = width / height;
    const common = COMMON_ASPECT_RATIOS.find(([, value]) => Math.abs(actual - value) / value <= 0.01);
    if (common) return common[0];
    const w = Math.round(width);
    const h = Math.round(height);
    const divisor = gcd(w, h);
    if (!divisor) return undefined;
    return `${w / divisor}:${h / divisor}`;
}

export function parseAspectRatio(value: unknown): number | undefined {
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(String(value || ""));
    if (!match) return undefined;
    return Number(match[1]) / Number(match[2]);
}

/**
 * 画布上的图会被缩放到节点尺寸，宽高取整后与目标画幅差 1–2px 是常态；
 * 固定 1px 容差会把正常分镜图判成比例不符，这里同时接受相对误差与像素误差。
 */
export function matchesAspectRatio(width: number, height: number, targetRatio: number) {
    if (!(width > 0 && height > 0 && targetRatio > 0)) return false;
    const relative = Math.abs(width / height - targetRatio) / targetRatio;
    const pixelDelta = Math.abs(width - height * targetRatio);
    return relative <= 0.01 || pixelDelta <= Math.max(2, Math.round(Math.min(width, height) * 0.015));
}

function slotAssetIds(catalog: ProjectReferenceAsset[], nodeId: string, storageKey: string) {
    const byNode = catalog.filter((asset) => inferReferenceRole(asset) === "storyboard" && String(asset.sourceNodeId || "") === nodeId);
    if (byNode.length) return byNode.map((asset) => asset.id);
    if (!storageKey) return [];
    return catalog.filter((asset) => inferReferenceRole(asset) === "storyboard" && String(asset.storageKey || "") === storageKey).map((asset) => asset.id);
}

/** 找一个已登记、可直接复用的分镜资产；找不到时由调用方按需新建。 */
export function findStoryboardAsset(project: Record<string, unknown>, nodeId: string, storageKey: string) {
    const catalog = referenceCatalogOf(project);
    return catalog.find((asset) => inferReferenceRole(asset) === "storyboard" && String(asset.sourceNodeId || "") === nodeId && String(asset.storageKey || "") === storageKey)
        || catalog.find((asset) => inferReferenceRole(asset) === "storyboard" && String(asset.storageKey || "") === storageKey);
}

export function buildStoryboardAsset(input: { nodeId: string; storageKey: string; label: string; url?: string; mimeType?: string; now?: string }): ProjectReferenceAsset {
    const now = input.now || new Date().toISOString();
    return {
        id: stableReferenceId("asset", `${input.nodeId}:${input.storageKey}`),
        label: input.label,
        mediaType: "image",
        role: "storyboard",
        tags: [],
        url: input.url,
        storageKey: input.storageKey,
        mimeType: input.mimeType || "image/png",
        sourceNodeId: input.nodeId,
        createdAt: now,
        updatedAt: now,
    };
}

/** 项目内所有有序分镜组的轻量索引，供调用方先找 groupId 再读槽位。 */
export function listStoryboardGroups(project: Record<string, unknown>): StoryboardGroupSlots[] {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    return nodes
        .filter((node) => String(node.type || "") === "group" && recordOf(node.metadata).orderedGroup === true)
        .map((node) => resolveStoryboardGroupSlots(project, String(node.id || "")));
}

export function resolveStoryboardGroupSlots(project: Record<string, unknown>, groupId: string): StoryboardGroupSlots {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
    const group = nodes.find((node) => String(node.id || "") === groupId);
    const metadata = recordOf(group?.metadata);
    if (!group || String(group.type || "") !== "group" || metadata.orderedGroup !== true) throw new Error(`STORYBOARD_GROUP_NOT_FOUND: 找不到有序分镜组:${groupId}`);

    const issues: StoryboardSlotIssue[] = [];
    const byId = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const catalog = referenceCatalogOf(project);
    const sourceVideoNodeId = String(metadata.sourceVideoNodeId || "");
    const rawSlots = Array.isArray(metadata.groupSlots) ? [...new Set(metadata.groupSlots.map((value: unknown) => String(value || "")).filter(Boolean))] : [];

    rawSlots.filter((id) => !byId.has(id)).forEach((id) => {
        issues.push({ code: "STORYBOARD_SLOT_NODE_MISSING", message: `槽位账本引用的节点已不存在:${id}；旧槽位未自动删除` });
    });

    const candidates = nodes.filter((node) => String(node.id || "") !== groupId && String(node.type || "") === "image");
    let memberIds = rawSlots.filter((id) => byId.has(id));
    let slotSource: StoryboardSlotSource = memberIds.length ? "groupSlots" : "empty";

    if (!memberIds.length) {
        const byMemberGroup = candidates.filter((node) => String(recordOf(node.metadata).groupId || "") === groupId).sort(positionSort);
        if (byMemberGroup.length) {
            memberIds = byMemberGroup.map((node) => String(node.id));
            slotSource = "memberGroupId";
        } else if (sourceVideoNodeId) {
            const shots = candidates.filter((node) => String(recordOf(node.metadata).sourceVideoNodeId || "") === sourceVideoNodeId).sort(shotNumberSort);
            if (shots.length) {
                memberIds = shots.map((node) => String(node.id));
                slotSource = "sourceVideoShots";
            }
        }
        if (memberIds.length) {
            issues.push({
                code: "STORYBOARD_SLOTS_REBUILT",
                message: `groupSlots 为空，已按${slotSource === "memberGroupId" ? "成员组归属" : "源视频分镜镜头"}重建 ${memberIds.length} 个槽位；写回后账本会同步`,
            });
        }
    }

    const orphans = candidates
        .filter((node) => String(recordOf(node.metadata).groupId || "") === groupId && !memberIds.includes(String(node.id)))
        .sort(positionSort);
    orphans.forEach((node) => {
        memberIds.push(String(node.id));
        issues.push({ code: "STORYBOARD_SLOT_ORPHAN", slot: memberIds.length, message: `成员归属本组但不在槽位账本中，已追加到槽位 ${memberIds.length}:${String(node.id)}` });
    });

    const slots: ResolvedStoryboardSlot[] = memberIds.map((nodeId, index) => {
        const node = byId.get(nodeId)!;
        const nodeMetadata = recordOf(node.metadata);
        const image = readNodeImage(node);
        // 有序组也会用来装成片（视频槽位），只有分镜图槽位才需要图片。
        const isVideoSlot = String(nodeMetadata.storageKey || "").startsWith("video:") || String(node.type || "") === "video";
        if (!isVideoSlot && !image.storageKey.startsWith("image:")) {
            issues.push({ code: "STORYBOARD_SLOT_NO_IMAGE", slot: index + 1, message: `槽位 ${index + 1} 还没有成功图片:${nodeId}` });
        }
        if (nodeMetadata.groupId && String(nodeMetadata.groupId) !== groupId && rawSlots.includes(nodeId)) {
            issues.push({ code: "STORYBOARD_MEMBER_GROUP_DRIFT", slot: index + 1, message: `槽位 ${index + 1} 同时在组 ${String(nodeMetadata.groupId)} 的账本里，成员归属与槽位账本不一致` });
        }
        if (sourceVideoNodeId && nodeMetadata.sourceVideoNodeId && String(nodeMetadata.sourceVideoNodeId) !== sourceVideoNodeId) {
            issues.push({ code: "STORYBOARD_SLOT_FOREIGN_SHOT", slot: index + 1, message: `槽位 ${index + 1} 的镜头来自另一个源视频 ${String(nodeMetadata.sourceVideoNodeId)}，可能串组` });
        }
        return {
            slot: index + 1,
            nodeId,
            title: String(node.title || ""),
            status: String(nodeMetadata.status || ""),
            storageKey: image.storageKey,
            url: image.url || undefined,
            mimeType: image.mimeType || undefined,
            width: image.width,
            height: image.height,
            aspectRatio: aspectRatioOf(image.width, image.height),
            shotNumber: Number.isFinite(Number(nodeMetadata.shotNumber)) ? Number(nodeMetadata.shotNumber) : undefined,
            assetIds: slotAssetIds(catalog, nodeId, image.storageKey),
        };
    });

    if (!slots.length) {
        issues.push({ code: "STORYBOARD_SLOT_EMPTY", message: `分镜组 ${String(group.title || groupId)} 没有可识别的槽位成员：槽位账本、成员归属、源视频分镜镜头都为空` });
    }
    const declaredShotCount = Number.isFinite(Number(metadata.shotCount)) ? Number(metadata.shotCount) : undefined;
    if (declaredShotCount !== undefined && declaredShotCount !== slots.length) {
        issues.push({ code: "STORYBOARD_SHOTCOUNT_MISMATCH", message: `组标题声明的 shotCount=${declaredShotCount} 与实际槽位 ${slots.length} 个不一致` });
    }

    return {
        groupId,
        title: String(group.title || ""),
        columns: Number.isFinite(Number(metadata.orderedGroupColumns)) ? Number(metadata.orderedGroupColumns) : undefined,
        declaredShotCount,
        sourceVideoNodeId: sourceVideoNodeId || undefined,
        slotSource,
        slots,
        issues,
    };
}
