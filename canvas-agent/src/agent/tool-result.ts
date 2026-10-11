/** Read MCP text and structured results using the same rules in live and history views. */
export function parseToolResult(result: unknown): unknown {
    const structured = field(result, "structuredContent");
    if (structured != null) return structured;
    const content = field(result, "content");
    const text = Array.isArray(content) ? content.map(item => field(item, "text")).filter(item => typeof item === "string").join("\n") : "";
    try { return text ? JSON.parse(text) : result; }
    catch { return text || result; }
}

export function toolResultFailure(item: unknown): { failed: boolean; message: string; connection: boolean } {
    const raw = field(item, "result");
    const result = parseToolResult(raw);
    const status = field(item, "status");
    const failed = Boolean(field(item, "error")) || field(item, "success") === false || status === "failed" || status === "error" || field(raw, "isError") === true || field(result, "ok") === false;
    const error = field(item, "error") || (failed ? field(result, "error") : undefined);
    const message = typeof error === "string" ? error : String(field(error, "message") || (failed && typeof result === "string" ? result : ""));
    return { failed, message, connection: /Transport closed|Transport send error|HTTP 502|fetch failed/i.test(message) };
}

/** Counts describe the returned task list, not all tasks in the database. */
export function generationTaskCounts(result: unknown) {
    const tasks = field(result, "tasks");
    if (!Array.isArray(tasks)) return null;
    const count = (status: string) => tasks.filter(task => field(task, "status") === status).length;
    return { total: tasks.length, queued: count("queued"), running: count("running"), succeeded: count("succeeded"), failed: count("failed") };
}

function field(value: unknown, key: string): unknown {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function compilationToolView(item: unknown) {
    const tool = field(item, "tool");
    if (tool !== "production_compile" && tool !== "production_get_compilation") return null;
    if (toolResultFailure(item).failed) return null;
    const result = parseToolResult(field(item, "result"));
    const compilation = field(result, "compilation");
    const status = field(compilation, "status");
    if (typeof status !== "string" || !["queued", "running", "blocked", "failed", "interrupted", "succeeded"].includes(status)) return null;
    let input = field(item, "arguments");
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = {}; } }
    const diagnostic = field(compilation, "blockingDiagnostic") || (field(input, "view") === "diagnostics" ? (field(compilation, "items") as unknown[] | undefined)?.[0] : undefined);
    return { status, titleKey: tool === "production_compile" ? "compilationSubmit" : field(input, "view") === "diagnostics" ? "compilationDiagnostics" : field(input, "view") === "targets" ? "compilationTargets" : "compilationQuery",
        operationId: String(field(compilation, "operationId") || ""), originalOperationId: String(field(compilation, "reusedFromOperationId") || ""),
        revision: field(compilation, "expectedRevision"), reused: field(compilation, "reused") === true, applied: Boolean(field(compilation, "application")),
        diagnostic, nextAction: field(compilation, "nextAction") };
}

export function describeCompilation(view: NonNullable<ReturnType<typeof compilationToolView>>, t: (key: string, values?: Record<string, unknown>) => string) {
    const lines = [t(`compilation_${view.status}`)];
    if (view.status === "succeeded") lines.push(t(view.applied ? "compilationApplied" : "compilationUnapplied"));
    if (view.reused) lines.push(t("compilationReused"));
    const diagnostic = view.diagnostic;
    if (diagnostic) lines.push([field(diagnostic, "code"), field(diagnostic, "targetId"), field(diagnostic, "shotId"), field(diagnostic, "path"), field(diagnostic, "matchedText") || field(diagnostic, "message")].filter(Boolean).join(" · "));
    return lines.join("\n");
}

export function compilationDetailRows(view: NonNullable<ReturnType<typeof compilationToolView>>) {
    return [{ key: "compilationOperation", value: view.operationId }, { key: "compilationOriginalOperation", value: view.originalOperationId },
        { key: "compilationRevision", value: view.revision == null ? "" : String(view.revision) },
        { key: "compilationSourcePath", value: String(field(view.diagnostic, "path") || "") },
        { key: "compilationNextAction", value: String(field(view.diagnostic, "nextAction") && field(field(view.diagnostic, "nextAction"), "message") || field(view.nextAction, "message") || "") }].filter(row => row.value);
}

export const compilationHistoryLabels: Record<string, string> = {
    compilationSubmit: "提交制作编译", compilationQuery: "查询编译状态", compilationDiagnostics: "读取编译诊断", compilationTargets: "读取编译目标",
    compilation_queued: "编译排队中", compilation_running: "编译运行中", compilation_blocked: "编译受阻", compilation_failed: "编译失败",
    compilation_interrupted: "编译中断", compilation_succeeded: "编译成功", compilationApplied: "已应用", compilationUnapplied: "尚未应用",
    compilationReused: "输入未变，复用原阻塞结果，本次未重跑编译器", compilationOperation: "本次操作", compilationOriginalOperation: "原操作",
    compilationRevision: "源稿版本", compilationSourcePath: "来源字段", compilationNextAction: "下一步",
};
