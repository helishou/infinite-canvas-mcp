import type { AgentCreativeLaunch } from "@/stores/use-agent-store";
import type { AgentSkillSummary } from "@/services/api/canvas-agent";

export const ACHENG_DIRECTOR_SKILL_NAME = "acheng-director";

export const ACHENG_CANVAS_LANGUAGE_RULE = "制作语言默认简体中文：导演对话、问题与说明，以及导演工作台展示的故事梗概、分场名称和非对白正文、角色/场景/资产名称与说明、镜头标题和摘要、阻塞原因及审核说明都用简体中文，除非用户明确指定其他语言。角色对白、歌词和画面内文字逐字保留原语言。Acheng 编译专用字段（如 prompt_description、state_description 和最终 H3 正文）继续遵循对应 Skill/模型合同要求的英文；同时填写中文展示字段（角色 appearance、资产 description、镜头 display_summary 等），不要把英文编译提示词当作唯一的用户可读说明。不要自行翻译既有确认稿，只将新写或用户明确要求修改的内容按此规则输出。";

export function findProjectAchengDirectorSkill(skills: readonly AgentSkillSummary[]) {
    return skills.find(skill => skill.name === ACHENG_DIRECTOR_SKILL_NAME && skill.scope === "repo" && skill.enabled) || null;
}

export function creativeLaunchPrompt(launch: Pick<AgentCreativeLaunch, "id" | "mode" | "text">) {
    const kind = launch.mode === "drama" ? "剧目创作" : "资产创作";
    const module = launch.mode === "drama" ? "story" : "assets";
    const planning = launch.mode === "drama" ? "剧目创作先停留在剧目规划页：先讨论并保存全剧大纲、制作要求、分镜图生成或跳过的选择，以及角色／服装、场景、道具、风格图、分镜／关键帧各类别的图片模型、视频模型和成片画幅。跳过分镜图时不要求配置关键帧图片模型，但仍要保留文字镜头表。创建剧目后使用 site_navigate({path:\"/production?dramaId=<真实剧目 ID>&workspace=series\"}) 打开剧目总览（工作台「剧目」页签），交由用户保存并确认剧目规划。只有用户明确选择某一集、开始本集制作时，才准备绑定画布并执行下文的分集制作导航。不要因创建剧目、讨论大纲或修改参数自动打开画布；不要把自由画布转成制作 SOP 项目。\n\n" : "";
    return `【制作中心创意入口：${kind}】\n请以项目 Skill $acheng-director 的 Acheng 七模块规范主导创作。处理画布对象时再读取项目适配 Skill canvas-video-production-sop：它只负责 Backend 正式数据、原生 MCP 执行、参考绑定和媒体归档，不取代 Acheng 的创作权属。当前制作 workId=${launch.id}；在同一制作会话的各模块间保持此 workId，用户明确开始另一份制作时才更换。\n\n${ACHENG_CANVAS_LANGUAGE_RULE}\n\n${planning}画幅是视频制作启动时的必确认项：若本次要交付视频，第一轮先检查用户创意是否已经明确成片画幅；没有明确值时，先询问 16:9、9:16、1:1、4:3、3:4、2:3、3:2、21:9、沿用画布配置或用户指定的其他比例，再开始故事拆解、资产提示词或分镜。若沿用既有制作对象，先读取正式 settings：非空 videoAspectRatio 或 videoAspectRatioConfirmed=true 表示已确认，沿用且不重复询问；未确认才提问。纯独立资产包且不交付视频时不问视频画幅。角色设定图、STYLE_MOTHER 和关键帧仍按各自用途选比例。用户确认后，在创建/选定制作对象时通过正式 set_settings 保存 {videoAspectRatio:<所选比例或沿用画布时为 null>,videoAspectRatioConfirmed:true}，回读正式 revision 后再继续；不得只记在聊天或默认猜成 16:9。\n\n分镜图也是视频制作启动时要确认的选择：先读正式 settings.storyboardImageMode；若未设置，在故事拆解和镜头设计前请用户明确选择“生成分镜图”或“跳过分镜图，只保留文字镜头与视频分段”，选定后在正式制作对象上通过 set_settings 保存 storyboardImageMode:"generate" 或 "skip" 并回读 revision。剧目规划中已经保存的选择优先沿用，不重复询问。选择 skip 时，保留书面 Shot、Segment 和完整 H3 提示词，不登记或准备分镜关键帧图片资产，不提交关键帧图片任务；其他角色、场景和道具资产仍按需要制作。\n\n先围绕用户创意澄清其他关键决定；不得把“创建并打开画布”当成默认流程。用户确认制作对象并创建/选定对应项目或剧目分集后，保存 source.brief 与制作记录，并通过 set_settings 写入已确认的成片画幅与分镜图选择；随后写入 workflow.currentWork={workId:"${launch.id}",module:"${module}",action:"author",inputRevision:<刚回读的 revision>} 并登记当前 Agent thread。回读 Backend 正式 readiness.presentation 后，使用结构化 site_navigate({production:{kind:"${launch.mode === "drama" ? "episode" : "canvas"}",id:<真实对象 ID>,workId:"${launch.id}"}}) 进入对应制作画布；不可凭聊天内容自行拼路由。\n\n推进到新的 Acheng 目标时，同步更新正式 workflow.currentWork 的模块、动作与目标，并基于 Backend 回读结果调用同一结构化导航。具体制作默认进入固定画布：每集一张制作画布，剧目另有共享资产画布。无节点时在对象面板编辑，需要节点时通过 production_prepare_targets 准备；准备和跟随不授权媒体生成。画布不是制作记录的另一份真值。\n\n除非用户明确要求媒体生产，本请求只授权澄清、创作、源稿修订和编译，不提交图片或视频任务。用户批准图片、关键帧或声音资产必须绑定真实媒体版本与审核证据。\n\n用户的创意：\n${launch.text}`;
}
