/**
 * 把 cg-use-everywhere 的广播节点（`Anything Everywhere` / `Anything Everywhere3` …）展开成真实连线。
 *
 * 这个插件是**纯前端**的：节点本身 `outputs: []`、后端 `execute()` 什么都不做，
 * 全靠前端把收到的值广播给「所有未连接的同类型输入」。RunningHub 没有这个插件，
 * 广播就不会发生，下游那些 CLIP / VAE 输入在云端一律空缺，工作流跑不起来。
 *
 * 这里按插件自己的匹配规则（`js/use_everywhere_classes.js` 的 `matches()`）把连线写实，再删掉广播节点：
 *  - 类型必须**完全相等**才发送；`send_to_any` / `string_to_combo` 默认关闭，所以不做 STRING→COMBO 之类的兼容；
 *  - 只填 `link === null` 的输入；
 *  - 同一个输入被两个通道匹配（插件会报 ambiguity 并且不连）时跳过，宁可留空也不乱接。
 *
 * 只在上传前作用于内存里的副本，不改本地工作流文件。
 */

type Json = Record<string, any>;

export type FlattenResult = {
    workflow: Json;
    /** 展开的通道数（每个有连线的输入算一个通道）。 */
    channels: number;
    /** 新写实的连线条数。 */
    links: number;
    /** 被移除的广播节点 id。 */
    removedNodes: string[];
    /** 因为多个通道同时匹配而被跳过的输入数（与插件报 ambiguity 的行为一致）。 */
    ambiguous: number;
};

const isObj = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const arr = (value: unknown): any[] => (Array.isArray(value) ? value : []);

function str(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 是不是广播节点。`type` 是节点注册名，插件的 `properties["Node name for S&R"]` 有时是
 * `Anything Everywhere3`（三通道版）而 `type` 显示成 `Anything Everywhere`，两个都要认。
 */
function isBroadcastNode(node: Json): boolean {
    const names = [str(node.type), str(isObj(node.properties) ? node.properties["Node name for S&R"] : "")];
    return names.some((name) => /^anything\s*everywhere/i.test(name.trim()));
}

/** 节点是否处于可用状态：bypass(4) / never(2) 的节点不参与。 */
function isLive(node: Json): boolean {
    return node.mode !== 2 && node.mode !== 4;
}

/** 解析一条 link：`[link_id, origin_id, origin_slot, target_id, target_slot, type]` 或对象形式。 */
function linkRow(link: unknown): { id: number; originId: number; originSlot: number; targetId: number } | null {
    if (Array.isArray(link) && link.length >= 4) return { id: num(link[0]), originId: num(link[1]), originSlot: num(link[2]), targetId: num(link[3]) };
    if (isObj(link)) return { id: num(link.id), originId: num(link.origin_id), originSlot: num(link.origin_slot), targetId: num(link.target_id) };
    return null;
}

export function flattenUseEverywhere(workflow: Json): FlattenResult {
    const nodes = arr(workflow.nodes).filter(isObj);
    const broadcasts = nodes.filter((node) => isBroadcastNode(node) && isLive(node));
    if (!broadcasts.length) return { workflow, channels: 0, links: 0, removedNodes: [], ambiguous: 0 };

    const links = arr(workflow.links).map((row) => (Array.isArray(row) ? [...row] : row));
    const broadcastIds = new Set(broadcasts.map((node) => num(node.id)));
    let nextLinkId = arr(workflow.links).reduce((max, row) => Math.max(max, linkRow(row)?.id ?? 0), num(workflow.last_link_id));

    // 1) 收集广播通道：每个有连线的输入就是一个通道，通道类型取该输入声明的类型。
    const channels: Array<{ originId: number; originSlot: number; type: string }> = [];
    for (const node of broadcasts) {
        for (const input of arr(node.inputs).filter(isObj)) {
            if (input.link === null || input.link === undefined) continue;
            const row = links.map(linkRow).find((item) => item && item.id === num(input.link));
            if (!row) continue;
            channels.push({ originId: row.originId, originSlot: row.originSlot, type: str(input.type, "*") });
        }
    }

    // 2) 收集候选目标：非广播节点的、未连接的同类型输入。
    type Target = { node: Json; index: number; input: Json };
    const targets: Target[] = [];
    for (const node of nodes) {
        if (broadcastIds.has(num(node.id)) || !isLive(node)) continue;
        arr(node.inputs).forEach((input, index) => {
            if (!isObj(input)) return;
            if (input.link !== null && input.link !== undefined) return;
            targets.push({ node, index, input });
        });
    }

    // 3) 逐目标统计命中它的通道；只有**唯一**命中的才写实。
    //    插件遇到多个通道同时匹配会报 ambiguity 并且两个都不连，这里保持一致，宁可留空也不乱接。
    const hits = new Map<Target, Set<string>>();
    for (const channel of channels) {
        const owner = `${channel.originId}:${channel.originSlot}`;
        for (const target of targets) {
            if (str(target.input.type) !== channel.type) continue;
            const owners = hits.get(target) ?? new Set<string>();
            owners.add(owner);
            hits.set(target, owners);
        }
    }

    let created = 0;
    let ambiguous = 0;
    for (const [target, owners] of hits) {
        if (owners.size !== 1) {
            ambiguous += 1;
            continue;
        }
        const [originId, originSlot] = [...owners][0].split(":").map(Number);
        nextLinkId += 1;
        const linkId = nextLinkId;
        target.input.link = linkId;
        links.push([linkId, originId, originSlot, num(target.node.id), target.index, str(target.input.type)]);
        const origin = nodes.find((node) => num(node.id) === originId);
        if (origin) {
            const outputs = arr(origin.outputs).filter(isObj);
            const slot = outputs[originSlot];
            if (slot) slot.links = [...arr(slot.links), linkId];
            origin.outputs = outputs;
        }
        created += 1;
    }

    // 4) 移除广播节点及其连线。
    //    广播节点没有输出，所以指向它的那条 link 的 **target** 才是它 —— 只按 origin 过滤会漏掉，
    //    残留下来就会在 UI→API 转换时报「连线引用了不存在的节点：736 → 738」。两边都要过滤。
    const keptLinks = links.filter((row) => {
        const info = linkRow(row);
        if (!info) return false;
        return !broadcastIds.has(info.originId) && !broadcastIds.has(info.targetId);
    });
    for (const node of nodes) {
        if (broadcastIds.has(num(node.id))) continue;
        for (const input of arr(node.inputs).filter(isObj)) {
            if (input.link === null || input.link === undefined) continue;
            // 输入端只可能指向广播节点（广播节点没有输出，不可能作为来源）。
            if (!keptLinks.some((row) => linkRow(row)?.id === num(input.link))) input.link = null;
        }
        for (const output of arr(node.outputs).filter(isObj)) {
            output.links = arr(output.links).filter((id) => keptLinks.some((row) => linkRow(row)?.id === num(id)));
        }
    }

    return {
        workflow: {
            ...workflow,
            nodes: nodes.filter((node) => !broadcastIds.has(num(node.id))),
            links: keptLinks,
            last_link_id: Math.max(nextLinkId, num(workflow.last_link_id)),
        },
        channels: channels.length,
        links: created,
        removedNodes: [...broadcastIds].map(String),
        ambiguous,
    };
}
