import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("llm-handoff");

/**
 * GPU 显存交接（焊进后端的条件式交接）。
 *
 * 本地 LLM 引擎（KVMem / Infernix，:18080）与 ComfyUI 共享同一块 5090，
 * 互斥——LLM 占 ~26GB 时 ComfyUI 任何生成都 OOM。所以在 ComfyUI 任务
 * 执行前卸掉 LLM（Free），执行完再把 LLM 拉回来（Restore）。
 *
 * 两个实测得到的硬约束（改回去就会重现故障）：
 *
 * 1. Restore 绝不阻塞任务完成。h3Queue 的单段槽位要等 execute() 整体返回才
 *    释放，而重启引擎实测要 ~170s——早先版本把 Restore 放在 execute() 的
 *    finally 里 await，结果「每段跑完槽位被占 170s，下一段干等」，前端表现
 *    为 `1 段 • 1 排队` 长时间不动。现在任务立即返回，恢复走引用计数 + 空闲
 *    防抖（下条）。
 *
 * 2. 连续多段生成只在整批结束后恢复一次。activeCount 引用计数：段与段之间的
 *    空闲很短，会取消挂起的恢复定时器，于是整批 clip 期间引擎保持关停
 *    （ComfyUI 独享整卡），最后一段结束静默 RESTORE_IDLE_MS 才恢复。
 *
 * 条件式（用户要求：本地没启动 KVMem 时不能被影响）：
 *   - 交接脚本不存在              -> skip，ComfyUI 正常跑
 *   - Free 时没杀到任何引擎进程    -> 不欠恢复，不误拉起引擎（本地未启动 KVMem）
 *   - 只有 Free 真的杀了引擎       -> 才安排 Restore
 *
 * 覆盖 LLM_HANDOFF_SCRIPT 改脚本路径；LLM_HANDOFF_ENGINE 改恢复哪个引擎；
 * LLM_HANDOFF_RESTORE_IDLE_MS 改空闲多久后恢复（默认 20s）。
 */
const HANDOFF_SCRIPT = process.env.LLM_HANDOFF_SCRIPT || "E:\\kvmem-ninfer-rtx50\\LlmGpuHandoff.ps1";
const ENGINE = process.env.LLM_HANDOFF_ENGINE || "kvmem";
/** Free：杀进程 + 等显存排空；脚本自身最多等 120s。 */
const FREE_TIMEOUT_MS = 180_000;
/** Restore：SwitchEngine 起引擎 + 权重加载，实测最长 ~170s。 */
const RESTORE_TIMEOUT_MS = 300_000;
/** 最后一段生成结束后，静默多久才恢复 LLM；此窗口内有新生成则取消恢复。 */
const RESTORE_IDLE_MS = Number(process.env.LLM_HANDOFF_RESTORE_IDLE_MS || 20_000);

type HandoffResult = { ok: boolean; output: string };

function runHandoff(mode: "Free" | "Restore", timeoutMs: number): Promise<HandoffResult> {
    return new Promise((resolve) => {
        if (!existsSync(HANDOFF_SCRIPT)) {
            logger.info(`交接脚本不存在，跳过 ${mode}：${HANDOFF_SCRIPT}`);
            resolve({ ok: false, output: "" });
            return;
        }
        const args = ["-Mode", mode];
        if (mode === "Restore") args.push("-Engine", ENGINE);
        const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HANDOFF_SCRIPT, ...args], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (ok: boolean, code: number | null) => {
            if (settled) return;
            settled = true;
            const output = (stdout + "\n" + stderr).trim();
            const tail = output.split("\n").slice(-8).join(" | ").slice(-500);
            if (ok) logger.info(`${mode} 交接完成。${tail ? `输出：${tail}` : ""}`);
            else logger.warn(`${mode} 交接未确认成功（退出码 ${code ?? "无"}），显存状态可能不对。${tail ? `输出：${tail}` : ""}`);
            resolve({ ok, output });
        };
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            logger.warn(`${mode} 交接超时（${timeoutMs}ms），已终止子进程。`);
            finish(false, null);
        }, timeoutMs);
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("error", (err) => { clearTimeout(timer); logger.warn(`${mode} 交接进程启动失败：${err.message}`); finish(false, null); });
        child.on("close", (code) => { clearTimeout(timer); finish(code === 0, code); });
    });
}

/**
 * 持久化「欠一次引擎恢复」标记。dev watch 热重载（tsx --watch）会重置模块内存，
 * 若恰好在 Free 之后、Restore 之前重载，新进程不知道引擎还被我们关着，引擎就
 * 一直躺着。写文件让新进程启动时能自愈（见本文件末尾的自愈逻辑）。
 */
const OWE_FLAG = process.env.LLM_HANDOFF_OWE_FLAG
    || path.join(process.env.LOCALAPPDATA || process.env.TEMP || ".", "hermes", "llm-handoff-owe.json");

function writeOweFlag(reason: string) {
    try { writeFileSync(OWE_FLAG, JSON.stringify({ engine: ENGINE, reason, at: new Date().toISOString() }), "utf8"); }
    catch (error) { logger.warn(`写欠恢复标记失败：${error instanceof Error ? error.message : String(error)}`); }
}
function clearOweFlag() {
    try { rmSync(OWE_FLAG, { force: true }); } catch { /* ignore */ }
}
function readOweFlag(): { engine?: string; reason?: string; at?: string } | null {
    try { return existsSync(OWE_FLAG) ? JSON.parse(readFileSync(OWE_FLAG, "utf8")) : null; }
    catch { return null; }
}

/** 正在执行的 ComfyUI 任务数。>0 期间引擎必须保持关停。 */
let activeCount = 0;
/** Free 确实杀掉了引擎，还欠一次 Restore。 */
let owesRestore = false;
/** 合并并发的 Free，避免同一时刻跑多个脚本。 */
let freeInFlight: Promise<boolean> | null = null;
/** 挂起的空闲恢复定时器。 */
let pendingRestore: NodeJS.Timeout | null = null;
/** 正在跑的 Restore（仅用于状态判断/日志）。 */
let restoreInFlight = false;

function cancelPendingRestore(reason: string) {
    if (!pendingRestore) return;
    clearTimeout(pendingRestore);
    pendingRestore = null;
    logger.info(`新的生成开始，取消挂起的引擎恢复（${reason}）。`);
}

function scheduleRestore() {
    if (pendingRestore) clearTimeout(pendingRestore);
    logger.info(`全部生成结束，${Math.round(RESTORE_IDLE_MS / 1000)}s 空闲后恢复 ${ENGINE}（期间有新生成则不恢复）。`);
    pendingRestore = setTimeout(() => {
        pendingRestore = null;
        if (activeCount > 0) return;      // 窗口内又忙起来了，恢复交给那批任务
        if (!owesRestore) return;
        owesRestore = false;
        clearOweFlag();
        restoreInFlight = true;
        void runHandoff("Restore", RESTORE_TIMEOUT_MS)
            .then((res) => {
                if (res.ok) clearOweFlag();
                else { writeOweFlag("restore-not-confirmed"); logger.warn("引擎恢复未确认成功，下次生成前请检查 18080。"); }
            })
            .finally(() => { restoreInFlight = false; });
    }, RESTORE_IDLE_MS);
}

/** ComfyUI 任务执行前调用：卸掉本地 LLM 引擎，让出整卡显存。 */
export async function freeLlmBeforeGenerate(): Promise<boolean> {
    activeCount++;
    cancelPendingRestore("activeCount=" + activeCount);
    if (owesRestore) return true;         // 本批已经卸过，引擎仍关停中
    if (pendingRestore) return true;      // 正在等恢复，引擎还关着
    if (restoreInFlight) logger.info("引擎正在恢复中，本次生成将再次卸掉它。");
    if (freeInFlight) return freeInFlight;
    freeInFlight = runHandoff("Free", FREE_TIMEOUT_MS).then((res) => {
        freeInFlight = null;
        // 只有脚本真的杀了进程，才欠一次恢复；"already drained" / "no engine" 不欠，
        // 所以本地根本没起 KVMem 时不会在生成结束后平白拉起一个引擎。
        if (/Free:\s*stopping (port holder|worker)/i.test(res.output)) { owesRestore = true; writeOweFlag("generation-freed"); }
        else logger.info("Free 未杀掉任何引擎进程（本地 LLM 未运行或显存本就够），本批不安排恢复。");
        return res.ok || !owesRestore;
    });
    return freeInFlight;
}

/**
 * ComfyUI 任务结束后调用（成功/失败/取消都要调）。
 * 同步返回、不阻塞任务完成——队列槽位要等本函数返回才释放。
 */
export function restoreLlmAfterGenerate(): void {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount > 0) return;          // 还有段在跑，等最后一段
    if (!owesRestore) return;             // 没杀过引擎，没什么可恢复
    scheduleRestore();
}

/**
 * 启动自愈：模块加载（含 dev watch 热重载）时若发现欠恢复标记，说明上一次进程
 * 在 Free 之后被换掉了，引擎可能仍被我们关着。此时若 18080 确实没有引擎在应答，
 * 就补一次恢复。正常情况（引擎已在跑 / 本地没起过 KVMem）标记不存在，什么都不做。
 */
void (async () => {
    const flag = readOweFlag();
    if (!flag) return;
    const engine = flag.engine || ENGINE;
    logger.info(`发现欠恢复标记（${flag.reason || "?"}，${flag.at || "?"}），检查 ${engine} 是否需要补恢复。`);
    try {
        const res = await fetch(`http://127.0.0.1:18080/v1/models`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) { clearOweFlag(); logger.info("18080 已有引擎在应答，清除欠恢复标记。"); return; }
    } catch { /* 18080 无应答 -> 需要补恢复 */ }
    logger.info(`18080 无引擎应答，启动自愈：恢复 ${engine}。`);
    const res = await runHandoff("Restore", RESTORE_TIMEOUT_MS);
    if (res.ok) { clearOweFlag(); logger.info("启动自愈完成，引擎已恢复。"); }
    else logger.warn("启动自愈未能确认引擎恢复，请检查 18080。");
})();
