/**
 * 分集需求正文 ↔ 制作源稿 剧本正文 同步 CLI（人工执行，默认只读）。
 *
 * 背景（实测）：同一份剧本正文存在两处 ——
 *   - `drama_episodes.synopsis`：作者写的「需求正文」，manage 面板编辑；
 *     是 `initialize_director_from_demand` 的种子（重新初始化时读它）。
 *   - `director.source.script_scenes[].text`：制作源稿里的剧本正文，
 *     director 面板编辑；分镜/连续性/编译都读它。
 * 两者是不同层（需求 vs 产出），但剧本正文部分重复。导演改稿后 synopsis
 * 会静默变旧（实测：制作稿已改成「干涸旧伤」，synopsis 仍写「金色流火、滋滋」）。
 *
 * 本命令把 synopsis 的**正文段**对齐到制作源稿，保留作者意图段落
 * （预估时长/场景/时间/人物/核心道具）不覆盖 —— 那是 synopsis 独有、
 * script_scenes 里没有的信息。
 *
 * 用法：
 *   node --import tsx src/maintenance/sync-episode-demand.ts --id <episodeId>            # 只读报告
 *   node --import tsx src/maintenance/sync-episode-demand.ts --id <episodeId> --apply
 */
import fs from "node:fs";
import { BackendDatabase } from "../db.js";
import { DB_FILE } from "../config.js";

const args = process.argv.slice(2);
let episodeId: string | undefined;
let apply = false;
for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") { if (apply) throw new Error("重复参数 --apply"); apply = true; continue; }
    if (arg === "--id") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("--id 缺少值");
        episodeId = value;
        continue;
    }
    throw new Error("未知参数: " + arg);
}
if (!episodeId) throw new Error("用法: sync-episode-demand --id <episodeId> [--apply]");
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护");

/** synopsis 里属于「作者意图」的段落，同步时不覆盖。 */
const INTENT_HEADINGS = ["【预估时长】", "【场景】", "【时间】", "【人物】", "【核心道具】"];

/** 从 synopsis 里切出意图段（到第一个非意图段为止）。 */
function intentPreamble(synopsis: string): string[] {
    const lines = synopsis.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (INTENT_HEADINGS.some(heading => trimmed.startsWith(heading))) { kept.push(line); continue; }
        // 意图段里的续行（- 开头的人物条目、道具续行）
        if (kept.length && (trimmed.startsWith("- ") || trimmed === "" && kept.at(-1)?.trim() === "")) {
            if (trimmed.startsWith("- ")) { kept.push(line); continue; }
        }
        if (kept.length && trimmed === "") { kept.push(line); continue; }
        break;
    }
    while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
    return kept;
}

const db = new BackendDatabase(DB_FILE);
try {
    const episode = db.getDramaEpisode(episodeId);
    if (!episode) throw new Error(`分集不存在: ${episodeId}`);
    const row = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id = ?").get(episodeId) as { draft_json?: string } | undefined;
    if (!row?.draft_json) throw new Error(`该分集没有制作稿: ${episodeId}`);
    const source = JSON.parse(row.draft_json)?.director?.source;
    if (!source) throw new Error("制作稿缺少 director.source");
    const scenes: Array<Record<string, any>> = Array.isArray(source.script_scenes) ? source.script_scenes : [];
    if (!scenes.length) throw new Error("制作稿没有剧本场次");

    const current = String(episode.synopsis || "");
    const preamble = intentPreamble(current);
    // 剧本正文：按场次顺序取 text，用空行分隔
    const body = scenes.map(scene => String(scene.text || "").trim()).filter(Boolean).join("\n\n");
    const nextSynopsis = [...preamble, "", body].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

    if (nextSynopsis === current) {
        console.log(JSON.stringify({ ok: true, changed: false, episodeId, note: "需求正文已与制作源稿一致" }, null, 2));
        db.close();
        process.exit(0);
    }

    const report = {
        ok: true, dryRun: !apply, episodeId, title: episode.title,
        intentLinesKept: preamble.length,
        scenes: scenes.map(scene => ({ id: scene.id, scene_id: scene.scene_id, textChars: String(scene.text || "").length })),
        before: { chars: current.length },
        after: { chars: nextSynopsis.length },
        // 只报告被移除的旧措辞，便于人工核对
        removedTerms: ["金色流火", "滋滋", "……操。", "雪白幼小", "白爪", "金焰"]
            .filter(term => current.includes(term) && !nextSynopsis.includes(term)),
    };

    if (!apply) {
        console.log(JSON.stringify({ ...report, note: "只读报告；--apply 写回 synopsis" }, null, 2));
        db.close();
        process.exit(0);
    }

    db.updateDramaEpisode(episodeId, { synopsis: nextSynopsis });
    const verify = db.getDramaEpisode(episodeId);
    const stale = ["金色流火", "滋滋", "……操。", "雪白幼小", "白爪", "金焰"].filter(term => String(verify?.synopsis || "").includes(term));
    console.log(JSON.stringify({ ...report, dryRun: false, applied: true, remainingStaleTerms: stale }, null, 2));
    if (stale.length) process.exitCode = 1;
} finally {
    db.close();
}
