/**
 * 字段权属的唯一权威表。
 *
 * 过去"这个字段该从哪个入口改"散在四处，每处一张不同的名单：
 * `operation-authority.ts` 护 productionClipProjection / directorEngine / directorSourceHash，
 * `plugins/minimax-h3/mcp.ts` 护 6 个 Clip 字段，`production.ts` 的 adopt 只允许两类 op，
 * 另有一处 settings 指纹校验。名单不一致时，同一次写入会"这条通道不报错但没落盘"，
 * 只能靠逐个入口试——这是制作返修里最耗时的一类试错。
 *
 * 本表只做两件事：给校验方一份可读的名单，给报错方一句"该走哪条路"。
 * 它不改变任何写入行为；迁移期各校验点改为读本表，名单才不会再漂。
 */

/** 谁拥有这个字段：源稿、Backend 投影、画布自由字段，或两边都可（重新编译时三方合并保留人工值）。 */
export type FieldOwner = "director-source" | "backend-projection" | "canvas" | "either";

/** 校验发生在哪一层：Clip/segment patch、节点 metadata，还是两层都有。 */
export type FieldScope = "clip" | "node" | "both";

export type FieldAuthority = {
    owner: FieldOwner;
    /** 校验层；名单不能跨层合并，否则会悄悄放宽某一侧的写入权。 */
    scope: FieldScope;
    /** 改这个字段的正确入口；报错时原样附给调用方，避免逐个入口试。 */
    entry: string;
};

/**
 * 正式 Clip 上的字段权属。
 * 名单变动必须同步 `canvas-agent/src/plugins/minimax-h3/mcp.ts` 的守卫与
 * `backend/src/canvas/operation-authority.ts` 的投影保护——两处都读本表，不再各写一份。
 */
export const CLIP_FIELD_AUTHORITY: Readonly<Record<string, FieldAuthority>> = {
    prompt: {
        owner: "director-source",
        scope: "clip",
        entry: "改源稿对应 Shot 的 visual 后重新编译；或在制作台「采用导演稿」走 production_edit(ops:[{type:'adopt_director_fields',fields:['prompt']}])",
    },
    referenceBindings: {
        owner: "director-source",
        scope: "clip",
        entry: "改 Shot 的 subject_usages / Picture 绑定后重新编译；或 production_edit(ops:[{type:'adopt_director_fields',fields:['referenceBindings']}])",
    },
    storyboardShots: {
        owner: "director-source",
        scope: "clip",
        entry: "在制作台改分镜格或用 production_edit(ops:[{type:'replace_director_clip_storyboard'}])",
    },
    storyboardInput: {
        owner: "director-source",
        scope: "clip",
        entry: "用 production_edit(ops:[{type:'replace_director_clip_storyboard'}]) 改分镜输入",
    },
    directorEngine: {
        owner: "backend-projection",
        scope: "both",
        entry: "编译身份由 Backend 在编译回执里写入，任何入口都不能直改；要换引擎请重新编译",
    },
    directorSourceHash: {
        owner: "backend-projection",
        scope: "both",
        entry: "源稿哈希由 Backend 维护，任何入口都不能直改；源稿变化后重新编译会更新它",
    },
    productionClipProjection: {
        owner: "backend-projection",
        scope: "node",
        entry: "制作投影摘要由 Backend 在编译应用时写入，任何入口都不能直改；需要更新请重新编译并应用",
    },
    tailFrameContinuation: {
        owner: "either",
        scope: "clip",
        entry: "画布 ClipSettings 或制作台的「续段衔接」都能改；重新编译时三方合并保留人工值",
    },
    motionContextEnabled: {
        owner: "either",
        scope: "clip",
        entry: "画布 ClipSettings 或制作台都能改；仅用于同一摄影镜头拆段",
    },
    videoContinuation: {
        owner: "either",
        scope: "clip",
        entry: "画布 ClipSettings 或制作台都能改；像素级视频续写",
    },
    duration: {
        owner: "canvas",
        scope: "clip",
        entry: "画布 update_h3_segment / canvas_update_node；正式镜头时长以源稿 Shot 的 duration_frames 为准",
    },
    title: {
        owner: "canvas",
        scope: "clip",
        entry: "画布 canvas_update_node 或 update_h3_segment",
    },
};

/** Clip/segment patch 上不得直改的字段（源稿拥有 + Backend 投影拥有，只取 clip 层）。 */
export function protectedClipFields(): string[] {
    return Object.entries(CLIP_FIELD_AUTHORITY)
        .filter(([, value]) => (value.owner === "director-source" || value.owner === "backend-projection")
            && (value.scope === "clip" || value.scope === "both"))
        .map(([field]) => field);
}

/** 节点 metadata 上不得直改的字段（Backend 投影拥有，只取 node 层）。 */
export function protectedNodeFields(): string[] {
    return Object.entries(CLIP_FIELD_AUTHORITY)
        .filter(([, value]) => value.owner === "backend-projection" && (value.scope === "node" || value.scope === "both"))
        .map(([field]) => field);
}

/** 给报错用的"该走哪条路"；未知字段返回空串，调用方保持原有报错。 */
export function fieldEntry(field: string): string {
    return CLIP_FIELD_AUTHORITY[field]?.entry ?? "";
}

/** 把"该走哪条路"拼进报错正文：已知字段补一句，未知字段原样返回。 */
export function withFieldEntry(field: string, message: string): string {
    const entry = fieldEntry(field);
    return entry ? `${message}；改这个字段请走：${entry}` : message;
}
