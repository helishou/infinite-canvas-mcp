import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Activity, Download, RefreshCw, Search, Upload } from "lucide-react";
import { Alert, App, Button, Card, Input, Space, Statistic, Table, Tag, Typography } from "antd";

import { fetchMcpObservabilityReport, fetchMcpObservabilityTrace, type McpObservabilityEvent, type McpObservabilityReport } from "@/services/api/mcp-observability";

const percent = (value: number | null) => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);
const duration = (value: number | null | undefined) => (value == null ? "—" : `${value} ms`);
const signed = (value: number | null, digits = 0, suffix = "") => (value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`);

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

    const queryTrace = async () => {
        const id = traceId.trim();
        if (!id) return;
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
                        <Statistic title="恢复成功率" value={percent(report?.recovery.successRate ?? null)} suffix={report ? `成功 ${report.recovery.succeeded} · 采纳 ${report.recovery.followed} · 建议 ${report.recovery.suggested}` : undefined} />
                    </Card>
                </div>

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
                        scroll={{ x: 900 }}
                        columns={[
                            { title: "工具", dataIndex: "tool" },
                            { title: "调用", dataIndex: "calls", width: 90 },
                            { title: "成功率", dataIndex: "successRate", width: 100, render: percent },
                            { title: "失败", dataIndex: "failed", width: 80 },
                            { title: "平均耗时", dataIndex: "averageDurationMs", width: 120, render: duration },
                            { title: "P95", dataIndex: "p95DurationMs", width: 110, render: duration },
                            { title: "最长耗时", dataIndex: "maxDurationMs", width: 120, render: duration },
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
                    </Space.Compact>
                    <Table
                        rowKey="id"
                        dataSource={traceEvents}
                        pagination={false}
                        locale={{ emptyText: "输入 traceId 后查看完整调用链" }}
                        scroll={{ x: 900 }}
                        columns={[
                            { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => new Date(value).toLocaleString() },
                            { title: "事件", dataIndex: "event", width: 130, render: (value: string) => <Tag color={value === "tool.failed" ? "error" : value === "tool.succeeded" ? "success" : "processing"}>{value}</Tag> },
                            { title: "工具", dataIndex: "tool", width: 220 },
                            { title: "耗时", dataIndex: "durationMs", width: 100, render: duration },
                            {
                                title: "上下文",
                                render: (_: unknown, item: McpObservabilityEvent) =>
                                    [item.projectId && `project=${item.projectId}`, item.nodeId && `node=${item.nodeId}`, item.taskId && `task=${item.taskId}`, item.errorCode && `error=${item.errorCode}`].filter(Boolean).join(" · ") || "—",
                            },
                        ]}
                    />
                </Card>
            </div>
        </main>
    );
}
