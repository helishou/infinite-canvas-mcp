import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Activity, Download, RefreshCw, Search, Upload } from "lucide-react";
import { Alert, App, Button, Card, Input, Space, Statistic, Table, Tag, Typography } from "antd";

import { fetchMcpObservabilityReport, fetchMcpObservabilityTrace, type McpObservabilityEvent, type McpObservabilityReport } from "@/services/api/mcp-observability";

const percent = (value: number | null) => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);
const duration = (value: number | null | undefined) => (value == null ? "—" : `${value} ms`);
const signed = (value: number | null, digits = 0, suffix = "") => (value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`);
/** 字符数按 4 字符 ≈ 1 token 粗估，与后端口径一致。 */
const chars = (value: number | null | undefined) => (value == null ? "—" : `${value.toLocaleString("en-US")} 字符`);
const approxTokens = (value: number | null | undefined) => (value == null ? "—" : `≈${Math.round(value / 4).toLocaleString("en-US")} tokens`);

function parseBaselineReport(payload: unknown): McpObservabilityReport | null {
    if (!payload || typeof payload !== "object") return null;
    const candidate = "report" in payload ? payload.report : payload;
    if (!candidate || typeof candidate !== "object" || !("calls" in candidate) || !("byTool" in candidate)) return null;
    const calls = candidate.calls;
    return calls && typeof calls === "object" && Array.isArray(candidate.byTool) ? (candidate as McpObservabilityReport) : null;
}

export default function McpObservabilityPage() {
    const { message } = App.useApp();
    const [report, setReport] = useState<McpObservabilityReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [traceLoading, setTraceLoading] = useState(false);
    const [traceId, setTraceId] = useState("");
    const [traceEvents, setTraceEvents] = useState<McpObservabilityEvent[]>([]);
    const [baselineReport, setBaselineReport] = useState<McpObservabilityReport | null>(null);
    const [baselineName, setBaselineName] = useState("");
    const baselineInputRef = useRef<HTMLInputElement>(null);

    const loadReport = useCallback(async () => {
        setLoading(true);
        try {
            setReport(await fetchMcpObservabilityReport());
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 MCP 诊断失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void loadReport();
    }, [loadReport]);

    const queryTrace = async (requestedTraceId = traceId) => {
        const id = requestedTraceId.trim();
        if (!id) return;
        setTraceId(id);
        setTraceLoading(true);
        try {
            const events = await fetchMcpObservabilityTrace(id);
            setTraceEvents(events);
            if (!events.length) message.info("没有找到这个 trace");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 trace 失败");
        } finally {
            setTraceLoading(false);
        }
    };

    const exportTrace = () => {
        const id = traceId.trim();
        if (!id || !traceEvents.length) return;
        const payload = { formatVersion: 1, exportedAt: new Date().toISOString(), scope: "mcp-observability-trace", traceId: id, events: traceEvents };
        const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `mcp-observability-trace-${id}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    };

    const exportReport = () => {
        if (!report) return;
        const payload = {
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            scope: "mcp-observability-summary",
            report,
        };
        const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `mcp-observability-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    };

    const loadBaseline = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const parsed = parseBaselineReport(JSON.parse(await file.text()));
            if (!parsed) throw new Error("文件不是有效的 MCP 汇总格式");
            setBaselineReport(parsed);
            setBaselineName(file.name);
            message.success("已载入基线，仅用于当前页面对比");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "载入基线失败");
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-7xl space-y-5 px-6 py-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <Activity className="size-5" />
                            <h1 className="text-xl font-semibold">MCP 诊断</h1>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">查看本机 MCP 工具调用、失败恢复和任务状态；这里只保存脱敏摘要。</p>
                    </div>
                    <Space>
                        <input ref={baselineInputRef} className="hidden" type="file" accept="application/json" aria-label="载入 MCP 诊断基线" onChange={(event) => void loadBaseline(event)} />
                        <Button icon={<Upload className="size-4" />} onClick={() => baselineInputRef.current?.click()}>
                            载入基线
                        </Button>
                        <Button icon={<Download className="size-4" />} disabled={!report} onClick={exportReport}>
                            导出汇总
                        </Button>
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadReport()}>
                            刷新
                        </Button>
                    </Space>
                </div>

                <Alert type="info" showIcon title="数据仅保存在本地 Backend SQLite；当前不会自动上传、轮询刷新或清理历史。载入的基线只留在当前浏览器页面。" />
                {report?.taskAssociation?.incomplete ? <Alert type="warning" showIcon title="任务关联数据不完整" description={report.taskAssociation.note} /> : null}

                <section className="space-y-3">
                    <div>
                        <h2 className="text-base font-medium">诊断结论</h2>
                        <p className="mt-0.5 text-sm text-muted-foreground">根据累计数据自动指出优先处理的可靠性和性能问题。</p>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        {(report?.diagnostics ?? []).map((item) => (
                            <Alert key={`${item.code}-${item.tool ?? "all"}`} type={item.severity} showIcon title={item.title} description={item.detail} />
                        ))}
                    </div>
                </section>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    <Card loading={loading}>
                        <Statistic title="已完成调用" value={report?.calls.completed ?? 0} suffix={report?.calls.incomplete ? `（${report.calls.incomplete} 未完成）` : undefined} />
                    </Card>
                    <Card loading={loading}>
                        <Statistic title="成功率" value={percent(report?.calls.successRate ?? null)} />
                    </Card>
                    <Card loading={loading}>
                        <Statistic title="P95 耗时" value={duration(report?.calls.p95DurationMs)} suffix={report?.calls.averageDurationMs != null ? `均值 ${duration(report.calls.averageDurationMs)}` : undefined} />
                    </Card>
                    <Card loading={loading}>
                        <Statistic title="会话数" value={report?.sessions.total ?? 0} />
                    </Card>
                    <Card loading={loading}>
                        <Statistic title="已观测工具" value={report?.byTool.length ?? 0} suffix="个" />
                    </Card>
                    <Card loading={loading}>
                        <Statistic title="每会话调用" value={report?.sessions.averageCalls ?? "—"} suffix={report ? `最高 ${report.sessions.maxCalls}` : undefined} />
                    </Card>
                    <Card loading={loading}>
                        <Statistic title="建议采纳率" value={percent(report?.recovery.followRate ?? null)} suffix={report ? `采纳后成功 ${percent(report.recovery.followedSuccessRate ?? null)} · ${report.recovery.observation === "same_session_adjacent_terminal_call" ? "同会话相邻调用" : "未采集口径"}` : undefined} />
                    </Card>
                </div>

                <Card title="耗时口径">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Statistic title="普通调用 P95" value={duration(report?.latency?.ordinary.p95DurationMs)} suffix={report?.latency ? `${report.latency.ordinary.calls} 次 · 均值 ${duration(report.latency.ordinary.averageDurationMs)}` : "未采集"} />
                        <Statistic title="包含任务等待 P95" value={duration(report?.latency?.waiting.p95DurationMs)} suffix={report?.latency ? `${report.latency.waiting.calls} 次 · 均值 ${duration(report.latency.waiting.averageDurationMs)}` : "未采集"} />
                    </div>
                </Card>

                <Card
                    title="输入输出大小"
                    extra={<Typography.Text type="secondary">字符数为序列化长度，token 按 4 字符 ≈ 1 token 粗估</Typography.Text>}
                >
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <Statistic
                            title="最大单次返回"
                            value={chars(report?.payload?.maxOutputChars ?? null)}
                            suffix={report?.payload ? approxTokens(report.payload.maxOutputChars) : undefined}
                        />
                        <Statistic
                            title="返回体均值"
                            value={chars(report?.payload?.averageOutputChars ?? null)}
                            suffix={report?.payload ? `${report.payload.sizedCalls} 次已记录` : undefined}
                        />
                        <Statistic
                            title="累计输出"
                            value={report?.payload ? approxTokens(report.payload.totalOutputChars) : "—"}
                            suffix={report?.payload ? chars(report.payload.totalOutputChars) : undefined}
                        />
                        <Statistic
                            title="超大返回体调用"
                            value={report?.payload?.oversizedCalls ?? 0}
                            suffix={report?.payload ? `≥ ${report.payload.warnThresholdChars.toLocaleString("en-US")} 字符` : undefined}
                        />
                    </div>
                    {report?.payload?.note ? (
                        <Typography.Text type="secondary" className="mt-3 block text-xs">{report.payload.note}</Typography.Text>
                    ) : null}
                </Card>

                {baselineReport ? (
                    <Card title="基线对比" extra={<Typography.Text type="secondary">{baselineName}</Typography.Text>}>
                        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                            <Statistic title="完成调用变化" value={signed(report ? report.calls.completed - baselineReport.calls.completed : null)} />
                            <Statistic
                                title="成功率变化"
                                value={signed(report && report.calls.successRate != null && baselineReport.calls.successRate != null ? (report.calls.successRate - baselineReport.calls.successRate) * 100 : null, 1, " 个百分点")}
                            />
                            <Statistic title="失败调用变化" value={signed(report ? report.calls.failed - baselineReport.calls.failed : null)} />
                            <Statistic title="P95 变化" value={signed(report && report.calls.p95DurationMs != null && baselineReport.calls.p95DurationMs != null ? report.calls.p95DurationMs - baselineReport.calls.p95DurationMs : null, 0, " ms")} />
                        </div>
                    </Card>
                ) : null}

                <Card title="按工具统计" extra={report ? <Typography.Text type="secondary">统计生成于 {new Date(report.generatedAt).toLocaleString()}</Typography.Text> : null}>
                    <Table
                        rowKey="tool"
                        loading={loading}
                        dataSource={report?.byTool ?? []}
                        pagination={false}
                        scroll={{ x: 1360 }}
                        columns={[
                            { title: "工具", dataIndex: "tool" },
                            { title: "调用", dataIndex: "calls", width: 80 },
                            { title: "成功率", dataIndex: "successRate", width: 90, render: percent },
                            { title: "失败", dataIndex: "failed", width: 70 },
                            {
                                title: "最大返回体",
                                dataIndex: "maxOutputChars",
                                width: 190,
                                render: (value: number | null | undefined) =>
                                    value == null ? <Typography.Text type="secondary">未采集</Typography.Text> : (
                                        <Space direction="vertical" size={0}>
                                            <Typography.Text type={value >= 100000 ? "danger" : undefined}>{chars(value)}</Typography.Text>
                                            <Typography.Text type="secondary" className="text-xs">{approxTokens(value)}</Typography.Text>
                                        </Space>
                                    ),
                            },
                            { title: "返回均值", dataIndex: "averageOutputChars", width: 120, render: (value: number | null | undefined) => (value == null ? "—" : chars(value)) },
                            { title: "最大入参", dataIndex: "maxInputChars", width: 110, render: (value: number | null | undefined) => (value == null ? "—" : chars(value)) },
                            { title: "平均耗时", dataIndex: "averageDurationMs", width: 110, render: duration },
                            { title: "P95", dataIndex: "p95DurationMs", width: 100, render: duration },
                            { title: "最长耗时", dataIndex: "maxDurationMs", width: 110, render: duration },
                        ]}
                    />
                </Card>

                <div className="grid gap-4 xl:grid-cols-2">
                    <Card title="每日趋势">
                        <Table
                            rowKey="date"
                            size="small"
                            dataSource={report?.daily ?? []}
                            pagination={false}
                            columns={[
                                { title: "日期", dataIndex: "date" },
                                { title: "调用", dataIndex: "calls", width: 80 },
                                { title: "成功率", dataIndex: "successRate", width: 100, render: percent },
                                { title: "平均耗时", dataIndex: "averageDurationMs", width: 110, render: duration },
                            ]}
                        />
                    </Card>
                    <Card title="失败定位">
                        <Table
                            rowKey={(item) => `${item.tool}-${item.code}`}
                            size="small"
                            dataSource={report?.failuresByTool ?? []}
                            pagination={false}
                            locale={{ emptyText: "暂无失败记录" }}
                            columns={[
                                { title: "工具", dataIndex: "tool" },
                                { title: "错误代码", dataIndex: "code", render: (value: string) => <Tag color="error">{value}</Tag> },
                                { title: "次数", dataIndex: "count", width: 70 },
                                {
                                    title: "最新 Trace",
                                    dataIndex: "latestTraceId",
                                    width: 150,
                                    render: (value: string | undefined) => value ? <Button type="link" size="small" onClick={() => void queryTrace(value)}>查看</Button> : <Typography.Text type="secondary">未采集</Typography.Text>,
                                },
                            ]}
                        />
                    </Card>
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                    <Card title="真实调用路径" extra={<Typography.Text type="secondary">同一 MCP 会话内的相邻工具</Typography.Text>}>
                        <Table
                            rowKey={(item) => `${item.fromTool}-${item.toTool}`}
                            size="small"
                            dataSource={report?.transitions ?? []}
                            pagination={false}
                            locale={{ emptyText: "暂无连续调用路径" }}
                            columns={[
                                { title: "从", dataIndex: "fromTool" },
                                { title: "到", dataIndex: "toTool" },
                                { title: "次数", dataIndex: "count", width: 70 },
                            ]}
                        />
                    </Card>
                    <Card title="异步任务结果" extra={<Typography.Text type="secondary">按发起工具归属，区别于调用成功</Typography.Text>}>
                        <Table
                            rowKey={(item) => `${item.tool}-${item.status}`}
                            size="small"
                            dataSource={report?.taskOutcomesByTool ?? []}
                            pagination={false}
                            locale={{ emptyText: "暂无关联任务" }}
                            columns={[
                                { title: "发起工具", dataIndex: "tool" },
                                {
                                    title: "任务结果",
                                    dataIndex: "status",
                                    render: (value: string) => <Tag color={value === "succeeded" ? "success" : value === "failed" || value === "missing" ? "error" : value === "running" ? "processing" : undefined}>{value}</Tag>,
                                },
                                { title: "任务数", dataIndex: "count", width: 80 },
                            ]}
                        />
                    </Card>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                    <Card title="错误代码">
                        <Space wrap>
                            {report?.errors.length ? (
                                report.errors.map((item) => (
                                    <Tag color="error" key={item.code}>
                                        {item.code} · {item.count}
                                    </Tag>
                                ))
                            ) : (
                                <Typography.Text type="secondary">暂无失败记录</Typography.Text>
                            )}
                        </Space>
                    </Card>
                    <Card title="关联任务状态">
                        <Space wrap>
                            {report?.taskStatuses.length ? (
                                report.taskStatuses.map((item) => (
                                    <Tag key={item.status}>
                                        {item.status} · {item.count}
                                    </Tag>
                                ))
                            ) : (
                                <Typography.Text type="secondary">暂无关联任务</Typography.Text>
                            )}
                        </Space>
                    </Card>
                </div>

                <Card title="Trace 查询">
                    <Space.Compact className="mb-4 w-full max-w-2xl">
                        <Input value={traceId} onChange={(event) => setTraceId(event.target.value)} onPressEnter={() => void queryTrace()} placeholder="粘贴工具返回的 traceId" />
                        <Button type="primary" icon={<Search className="size-4" />} loading={traceLoading} onClick={() => void queryTrace()}>
                            查询
                        </Button>
                        <Button icon={<Download className="size-4" />} disabled={!traceEvents.length} onClick={exportTrace}>
                            导出链路
                        </Button>
                    </Space.Compact>
                    <Table
                        rowKey="id"
                        dataSource={traceEvents}
                        pagination={false}
                        locale={{ emptyText: "输入 traceId 后查看完整调用链" }}
                        scroll={{ x: 1120 }}
                        columns={[
                            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => new Date(value).toLocaleString() },
                            { title: "事件", dataIndex: "event", width: 120, render: (value: string) => <Tag color={value === "tool.failed" ? "error" : value === "tool.succeeded" ? "success" : "processing"}>{value}</Tag> },
                            { title: "工具", dataIndex: "tool", width: 200 },
                            { title: "耗时", dataIndex: "durationMs", width: 90, render: duration },
                            {
                                title: "入参 / 返回",
                                width: 170,
                                render: (_: unknown, item: McpObservabilityEvent) => {
                                    const inputChars = typeof item.inputSummary?.inputChars === "number" ? item.inputSummary.inputChars : null;
                                    const outputChars = typeof item.outputSummary?.outputChars === "number" ? item.outputSummary.outputChars : null;
                                    const outputBytes = typeof item.outputSummary?.outputBytes === "number" ? item.outputSummary.outputBytes : null;
                                    if (inputChars == null && outputChars == null) return <Typography.Text type="secondary">未采集</Typography.Text>;
                                    return (
                                        <Typography.Text type={outputChars != null && outputChars >= 100000 ? "danger" : undefined}>
                                            {inputChars == null ? "—" : `${inputChars.toLocaleString("en-US")}`}
                                            {" / "}
                                            {outputChars == null ? "—" : `${outputChars.toLocaleString("en-US")}`}
                                            {outputBytes != null && outputBytes > 512 * 1024 && (
                                                <Typography.Text type="danger" style={{ marginLeft: 6 }}>
                                                    超限 {(outputBytes / 1024 / 1024).toFixed(2)}MB
                                                </Typography.Text>
                                            )}
                                        </Typography.Text>
                                    );
                                },
                            },
                            {
                                title: "上下文",
                                render: (_: unknown, item: McpObservabilityEvent) =>
                                    [item.projectId && `project=${item.projectId}`, item.nodeId && `node=${item.nodeId}`, item.operationId && `op=${item.operationId}`, item.taskId && `task=${item.taskId}`, item.errorCode && `error=${item.errorCode}`, item.outputSummary?.httpStatus && `HTTP=${item.outputSummary.httpStatus}`].filter(Boolean).join(" · ") || "—",
                            },
                        ]}
                    />
                </Card>
            </div>
        </main>
    );
}
