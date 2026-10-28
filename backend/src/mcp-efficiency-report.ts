import type { DatabaseSync } from "node:sqlite";

/** Aggregates existing summary JSON in SQLite; never loads prompt bodies or changes history. */
export function mcpEfficiencyReport(db: DatabaseSync, filter: { where: string; params: string[] }, full: boolean) {
    const rows = db.prepare(`
        WITH terminal AS (
            SELECT session_id, tool, event, error_code,
                json_extract(input_summary_json,'$.schemaHash') AS schema_hash,
                json_extract(output_summary_json,'$.observedTaskFingerprint') AS task_key,
                json_extract(output_summary_json,'$.observedTaskStatus') AS task_status,
                COALESCE(json_extract(output_summary_json,'$.readScopeFingerprint'),json_extract(input_summary_json,'$.readScopeFingerprint')) AS scope,
                json_extract(input_summary_json,'$.requestFingerprint') AS request,
                json_extract(output_summary_json,'$.readVersion') AS version,
                json_extract(output_summary_json,'$.contentFingerprint') AS content,
                json_extract(output_summary_json,'$.readReturnedContent') AS returned
            FROM mcp_observability_events
            WHERE event IN ('tool.succeeded','tool.failed') ${filter.where}
        ), repeats AS (
            SELECT tool, CASE WHEN content IS NOT NULL THEN 'sameContent' ELSE 'sameVersion' END AS kind, COUNT(*)-1 AS candidates
            FROM terminal WHERE event='tool.succeeded' AND scope IS NOT NULL AND returned=1 AND (content IS NOT NULL OR version IS NOT NULL)
            GROUP BY session_id,tool,schema_hash,scope,CASE WHEN content IS NOT NULL THEN 'content:'||content ELSE 'version:'||version END
        ), retries AS (
            SELECT tool,COUNT(*)-1 AS candidates FROM terminal
            WHERE event='tool.failed' AND request IS NOT NULL AND error_code IN ('INVALID_INPUT','INVALID_SCHEMA','OUTPUT_TOO_LARGE','ARTIFACT_NOT_FOUND','NODE_NOT_FOUND')
            GROUP BY session_id,tool,schema_hash,request,error_code
        )
        SELECT tool,kind,SUM(candidates) AS count FROM repeats WHERE candidates>0 GROUP BY tool,kind
        UNION ALL SELECT tool,'failedReadRetry',SUM(candidates) FROM retries WHERE candidates>0 GROUP BY tool
        UNION ALL SELECT tool,'terminalTaskRead',SUM(candidates) FROM (
            SELECT tool,COUNT(*)-1 AS candidates FROM terminal WHERE event='tool.succeeded' AND task_key IS NOT NULL AND task_status IN ('success','succeeded','completed','failed','cancelled')
            GROUP BY session_id,tool,schema_hash,task_key,task_status
        ) WHERE candidates>0 GROUP BY tool
        UNION ALL SELECT '', 'measuredReadCalls', COUNT(*) FROM terminal WHERE event='tool.succeeded' AND scope IS NOT NULL
        ORDER BY count DESC,tool,kind
    `).all(...filter.params) as Array<{ tool: string; kind: string; count: number }>;
    const count = (kind: string) => rows.filter(row => row.kind === kind).reduce((sum, row) => sum + Number(row.count), 0);
    return { measuredReadCalls: count("measuredReadCalls"), sameContentCandidates: count("sameContent"), sameVersionCandidates: count("sameVersion"), failedReadRetryCandidates: count("failedReadRetry"), terminalTaskReadCandidates: count("terminalTaskRead"),
        ...(full ? { byTool: rows.filter(row => row.tool).map(row => ({ tool: row.tool, kind: row.kind, count: Number(row.count) })) } : {}),
        note: "仅统计同会话且具备指纹的新事件；分页续读、未读完内容与 unchanged 不计入重复返回。任务终态查询单列，运行中及待人工确认不计入。候选不等于无效调用或已节省 token。" };
}
