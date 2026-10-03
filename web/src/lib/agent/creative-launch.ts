import type { AgentCreativeLaunch } from "@/stores/use-agent-store";
import type { AgentSkillSummary } from "@/services/api/canvas-agent";

export const ACHENG_DIRECTOR_SKILL_NAME = "acheng-director";

export function findProjectAchengDirectorSkill(skills: readonly AgentSkillSummary[]) {
    return skills.find(skill => skill.name === ACHENG_DIRECTOR_SKILL_NAME && skill.scope === "repo" && skill.enabled) || null;
}

export function creativeLaunchPrompt(launch: Pick<AgentCreativeLaunch, "id" | "mode" | "text">) {
    const kind = launch.mode === "drama" ? "剧目创作" : "资产创作";
    const module = launch.mode === "drama" ? "story" : "assets";
    return `【制作中心创意入口：${kind}】\n请以项目 Skill $acheng-director 的 Acheng 七模块规范主导创作。处理画布对象时再读取项目适配 Skill canvas-video-production-sop：它只负责Backend正式数据、原生MCP执行、参考绑定和媒体归档，不取代Acheng的创作权属。当前制作 workId=${launch.id}；在同一制作会话的各模块间保持此 workId，用户明确开始另一份制作时才更换。先围绕用户创意澄清关键决定；不得把“创建并打开画布”当成默认流程。\n\n用户确认制作对象并创建/选定对应的项目或剧目分集后，使用 Backend 正式接口保存需求与制作记录，随后写入 workflow.currentWork={workId:"${launch.id}",module:"${module}",action:"author",inputRevision:<刚回读的 revision>}，并登记当前 Agent thread。回读 Backend 正式 readiness.presentation 后，使用结构化 site_navigate({production:{kind:"${launch.mode === "drama" ? "episode" : "canvas"}",id:<真实对象 ID>,workId:"${launch.id}"}}) 进入对应导演工作台；不可凭聊天内容自行拼路由。\n\n推进到新的 Acheng 目标时，同步更新正式 workflow.currentWork 的模块、动作与目标，并基于 Backend 回读结果调用同一结构化导航。图片或视频任务有真实节点/Clip 映射后才能切到对象画布；提示词准备、编译和缺项留在导演工作台。画布不是制作记录的另一份真值。\n\n除非用户明确要求媒体生产，本请求只授权澄清、创作、源稿修订和编译，不提交图片或视频任务。用户批准图片、关键帧或声音资产必须绑定真实媒体版本与审核证据。\n\n用户的创意：\n${launch.text}`;
}
