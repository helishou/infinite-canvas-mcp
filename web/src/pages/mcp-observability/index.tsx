import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Download, Plus, RefreshCw, Search } from "lucide-react";
import { Alert, App, Button, Card, Checkbox, DatePicker, Input, Select, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";

import { numberSorter, sortRows, stringSorter, type SortOrder } from "@/lib/mcp-observability/table-sort";
import { clientToViewBox, trendHoverIndex } from "@/lib/mcp-observability/trend-hover";
import { deleteMcpOptimizationMarker, fetchMcpObservabilityReport, fetchMcpObservabilityTrace, fetchMcpOptimizationMarkers, saveMcpOptimizationMarker, type McpOptimizationMarker, type McpObservabilityEvent, type McpObservabilityReport } from "@/services/api/mcp-observability";

const percent = (value: number | null) => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);
const duration = (value: number | null | undefined) => (value == null ? "—" : `${value} ms`);
const signed = (value: number | null, digits = 0, suffix = "") => (value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`);
/** 字符数按 4 字符 ≈ 1 token 粗估，与后端口径一致。 */
const chars = (value: number | null | undefined) => (value == null ? "—" : `${value.toLocaleString("en-US")} 字符`);
const approxTokens = (value: number | null | undefined) => (value == null ? "—" : `≈${Math.round(value / 4).toLocaleString("en-US")} tokens`);

const dateText = (value: Dayjs) => value.format("YYYY-MM-DD");

type TrendMetric = "calls" | "successRate" | "failedPerThousand" | "averageDurationMs" | "averageOutputChars";

const trendMetricLabel: Record<TrendMetric, string> = {
    calls: "调用量",
    successRate: "成功率",
    failedPerThousand: "每千次失败",
    averageDurationMs: "平均耗时",
    averageOutputChars: "返回体均值",
};

type TrendSeries = { metric: TrendMetric; color: string; axis: "left" | "right"; percent: boolean };

function trendSeriesValue(series: TrendSeries, item: Record<string, unknown>): number | null {
    if (series.metric === "failedPerThousand") return Number(item.calls) > 0 ? Number(item.failed) / Number(item.calls) * 1000 : 0;
    const value = Number(item[series.metric]);
    return Number.isFinite(value) ? value : null;
}

const trendValueText = (series: TrendSeries, value: number | null) => {
    if (value == null) return "—";
    if (series.percent) return `${(value * 100).toFixed(1)}%`;
    if (series.metric === "averageDurationMs") return `${Math.round(value)} ms`;
    return value.toLocaleString("en-US");
};

/** 排序列：工具名用中文比较，其余列都是数值列。 */
const toolColumnCompare = (key: string | null) => (key === "tool" ? stringSorter : numberSorter("ascend"));

function TrendLineChart({ data, metrics, markers, tool }: { data: Array<Record<string, unknown>>; metrics: TrendSeries[]; markers: McpOptimizationMarker[]; tool: string }) {
    const [hoverIndex, setHoverIndex] = useState<number>(-1);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const seriesData = useMemo(() => metrics.map((series) => ({
        ...series,
        values: data.map((item) => trendSeriesValue(series, item)),
    })).filter((series) => series.values.some((value) => value != null)), [data, metrics]);
    const width = 900, height = 300, pad = { left: 64, right: 64, top: 22, bottom: 42 };
    const chartRef = useMemo(() => ({ width, height, padLeft: pad.left, padRight: pad.right }), []);
    const inner = width - pad.left - pad.right;
    const x = (index: number) => pad.left + (data.length === 1 ? inner / 2 : index * inner / (data.length - 1));
    const scales = (axis: "left" | "right") => {
        const values = seriesData.filter((item) => item.axis === axis).flatMap((item) => item.values.filter((value): value is number => value != null));
        const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
        return { min: min - span * 0.1, max: max + span * 0.1 };
    };
    const left = scales("left"), right = scales("right");
    const y = (value: number, axis: "left" | "right") => { const s = axis === "left" ? left : right; return height - pad.bottom - ((value - s.min) / (s.max - s.min || 1)) * (height - pad.top - pad.bottom); };
    const markerX = (marker: McpOptimizationMarker) => { const days = data.map((item) => dayjs(String(item.date)).valueOf()); const at = dayjs(marker.at).valueOf(); const first = days[0] ?? at, last = days[days.length - 1] ?? at; return pad.left + ((at - first) / (last - first || 1)) * inner; };
    const updateHover = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
        const svg = svgRef.current;
        if (!svg) return;
        const point = clientToViewBox(svg.getBoundingClientRect(), chartRef, event.clientX, event.clientY);
        setHoverIndex(trendHoverIndex(point.x, data.length, chartRef, 14));
    }, [chartRef, data.length]);
    if (!seriesData.length || !data.length) return <div className="py-12 text-center text-sm text-muted-foreground">当前范围暂无该指标数据</div>;
    const hoverItem = hoverIndex >= 0 ? data[hoverIndex] : undefined;
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-3">{seriesData.map((series) => <Tag key={series.metric} color={series.color}>{trendMetricLabel[series.metric]}</Tag>)}</div>
            <div className="relative">
                {hoverItem ? (
                    <div
                        role="status"
                        className="pointer-events-none absolute top-1 z-10 min-w-44 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
                        style={{ left: `clamp(0px, ${(x(hoverIndex) / width) * 100}% , calc(100% - 11rem))` }}
                    >
                        <div className="mb-1 font-medium text-foreground">{String(hoverItem.date)}</div>
                        {seriesData.map((series) => (
                            <div key={series.metric} className="flex items-center justify-between gap-4">
                                <span className="flex items-center gap-1 text-muted-foreground">
                                    <span className="inline-block size-2 rounded-full" style={{ background: series.color === "purple" ? "#a855f7" : series.color === "orange" ? "#f97316" : series.color === "blue" ? "#3b82f6" : series.color === "green" ? "#22c55e" : "#ef4444" }} />
                                    {trendMetricLabel[series.metric]}
                                </span>
                                <span className="tabular-nums text-foreground">{trendValueText(series, series.values[hoverIndex] ?? null)}</span>
                            </div>
                        ))}
                    </div>
                ) : null}
                <svg
                    ref={svgRef}
                    viewBox={`0 0 ${width} ${height}`}
                    role="img"
                    aria-label={`${tool === "*" ? "全部工具" : tool}多指标折线图`}
                    className="h-[300px] w-full"
                    onMouseMove={updateHover}
                    onMouseLeave={() => setHoverIndex(-1)}
                >
                    {[0, 0.5, 1].map((ratio) => {
                        const leftValue = left.min + (left.max - left.min) * ratio, rightValue = right.min + (right.max - right.min) * ratio;
                        return <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={y(leftValue, "left")} y2={y(leftValue, "left")} stroke="var(--border)" strokeDasharray="3 4" /><text x={pad.left - 7} y={y(leftValue, "left") + 4} textAnchor="end" fontSize="10" fill="var(--muted-foreground)">{leftValue.toFixed(0)}</text><text x={width - pad.right + 7} y={y(rightValue, "right") + 4} fontSize="10" fill="var(--muted-foreground)">{rightValue.toFixed(0)}</text></g>;
                    })}
                    {markers.map((marker) => <g key={marker.id}><line x1={markerX(marker)} x2={markerX(marker)} y1={pad.top} y2={height - pad.bottom} stroke="var(--destructive)" strokeDasharray="5 4"><title>{`${marker.label} · ${new Date(marker.at).toLocaleString()}`}</title></line><text x={markerX(marker) + 4} y={pad.top + 12} fontSize="10" fill="var(--destructive)">{marker.label}</text></g>)}
                    {data.map((item, index) => <text key={String(item.date)} x={x(index)} y={height - 12} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">{String(item.date).slice(5)}</text>)}
                    {hoverItem ? <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={pad.top} y2={height - pad.bottom} stroke="var(--foreground)" strokeOpacity="0.35" strokeWidth="1" /> : null}
                    {seriesData.map((series) => <g key={series.metric}><polyline points={series.values.map((value, index) => value == null ? "" : `${x(index)},${y(series.percent ? value * 100 : value, series.axis)}`).filter(Boolean).join(" ")} fill="none" stroke={series.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />{series.values.map((value, index) => value == null ? null : <circle key={`${series.metric}-${data[index]?.date}`} cx={x(index)} cy={y(series.percent ? value * 100 : value, series.axis)} r={hoverIndex === index ? 5.5 : 3.5} fill="var(--background)" stroke={series.color} strokeWidth="2"><title>{`${data[index]?.date} · ${trendMetricLabel[series.metric]}: ${trendValueText(series, value)}`}</title></circle>)}</g>)}
                </svg>
            </div>
            <Typography.Text type="secondary" className="block text-xs">左轴：调用量；右轴：标准化失败率、耗时与返回体。红色竖线为优化标记。悬停折线可查看该日各指标具体值。</Typography.Text>
        </div>
    );
}

function defaultRange(): [Dayjs, Dayjs] {
    const to = dayjs();
    return [to.subtract(6, "day").startOf("day"), to.startOf("day")];
}

function previousRange(range: [Dayjs, Dayjs]): [string, string] {
    const days = range[1].startOf("day").diff(range[0].startOf("day"), "day") + 1;
    return [dateText(range[0].subtract(days, "day")), dateText(range[1].subtract(days, "day"))];
}

function comparison(current: McpObservabilityReport, previous: McpObservabilityReport | null) {
    const successDelta = current.calls.successRate != null && previous != null && previous.calls.successRate != null
        ? (current.calls.successRate - previous.calls.successRate) * 100
        : null;
    const p95Delta = current.calls.p95DurationMs != null && previous != null && previous.calls.p95DurationMs != null
        ? current.calls.p95DurationMs - previous.calls.p95DurationMs
        : null;
    const outputDelta = current.payload?.averageOutputChars != null && previous?.payload?.averageOutputChars != null
        ? current.payload.averageOutputChars - previous.payload.averageOutputChars
        : null;
    const currentCalls = current.calls.completed;
    const previousCalls = previous?.calls.completed ?? 0;
    const failedRate = previous && previousCalls ? previous.calls.failed / previousCalls : 0;
    const currentFailedRate = currentCalls ? current.calls.failed / currentCalls : 0;
    const hasBaseline = Boolean(previous && previousCalls > 0 && currentCalls > 0);
    let verdict = "样本不足，无法判断";
    if (hasBaseline && successDelta != null && Math.abs(successDelta) < 0.05 && Math.abs(p95Delta ?? 0) < 1 && Math.abs(outputDelta ?? 0) < 1) verdict = "无明显变化";
    else if (hasBaseline && successDelta != null) verdict = successDelta > 0 ? "可靠性改善" : "可靠性回退";
    return { successDelta, p95Delta, outputDelta, currentCalls, previousCalls, currentFailedRate, failedRate, hasBaseline, verdict };
}

export default function McpObservabilityPage() {
    const { message } = App.useApp();
    const [report, setReport] = useState<McpObservabilityReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [traceLoading, setTraceLoading] = useState(false);
    const [traceId, setTraceId] = useState("");
    const [traceEvents, setTraceEvents] = useState<McpObservabilityEvent[]>([]);
    const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(defaultRange);
    const [previousReport, setPreviousReport] = useState<McpObservabilityReport | null>(null);
    const [trendTool, setTrendTool] = useState("*");
    const [trendMetrics, setTrendMetrics] = useState<TrendMetric[]>(["calls", "successRate"]);
    const [markers, setMarkers] = useState<McpOptimizationMarker[]>([]);
    const [markerLabel, setMarkerLabel] = useState("");
    const [markerAt, setMarkerAt] = useState<Dayjs>(dayjs());
    const trendSeries: TrendSeries[] = ([
        { metric: "calls", color: "blue", axis: "left", percent: false },
        { metric: "successRate", color: "green", axis: "right", percent: true },
        { metric: "failedPerThousand", color: "red", axis: "right", percent: false },
        { metric: "averageDurationMs", color: "orange", axis: "right", percent: false },
        { metric: "averageOutputChars", color: "purple", axis: "right", percent: false },
    ] satisfies TrendSeries[]).filter((series) => trendMetrics.includes(series.metric));
    const trendTools = useMemo(() => [...new Set((report?.dailyByTool ?? []).map((item) => item.tool))].sort(), [report?.dailyByTool]);
    const trendData = useMemo(() => trendTool === "*" ? (report?.daily ?? []) : (report?.dailyByTool ?? []).filter((item) => item.tool === trendTool), [report?.daily, report?.dailyByTool, trendTool]);
    const toolComparison = useMemo(() => {
        const previousByTool = new Map((previousReport?.byTool ?? []).map((item) => [item.tool, item]));
        return (report?.byTool ?? []).map((item) => {
            const previous = previousByTool.get(item.tool);
            return {
                ...item,
                previousCalls: previous?.calls ?? 0,
                previousSuccessRate: previous?.successRate ?? null,
                previousP95DurationMs: previous?.p95DurationMs ?? null,
                previousAverageOutputChars: previous?.averageOutputChars ?? null,
                successRateDelta: item.successRate != null && previous?.successRate != null ? item.successRate - previous.successRate : null,
                p95Delta: item.p95DurationMs != null && previous?.p95DurationMs != null ? item.p95DurationMs - previous.p95DurationMs : null,
                outputDelta: item.averageOutputChars != null && previous?.averageOutputChars != null ? item.averageOutputChars - previous.averageOutputChars : null,
            };
        }).filter((item) => item.calls > 0 || item.previousCalls > 0);
    }, [report?.byTool, previousReport?.byTool]);
    // 两张工具表各自记住排序状态；antd 的 sorter 降序会直接对比较结果取反，
    // 缺失值会被翻到榜首，所以用 sorter: true + 自行排序。
    const [comparisonSort, setComparisonSort] = useState<{ key: string; order: SortOrder }>({ key: "calls", order: "descend" });
    const [byToolSort, setByToolSort] = useState<{ key: string; order: SortOrder }>({ key: "calls", order: "descend" });
    const sortedToolComparison = useMemo(() => sortRows(toolComparison, comparisonSort.key, comparisonSort.order, toolColumnCompare(comparisonSort.key)), [toolComparison, comparisonSort]);
    const sortedByTool = useMemo(() => sortRows(report?.byTool ?? [], byToolSort.key, byToolSort.order, toolColumnCompare(byToolSort.key)), [report?.byTool, byToolSort]);
    const dataRangeStartIso = () => dateRange[0].startOf("day").toISOString();
    const dataRangeEndIso = () => dateRange[1].endOf("day").toISOString();

    const loadReport = useCallback(async (requestedRange = dateRange) => {
        setLoading(true);
        try {
            const options = { from: dateText(requestedRange[0]), to: dateText(requestedRange[1]) };
            const [current, previous] = await Promise.all([
                fetchMcpObservabilityReport(options),
                (async () => {
                    const previousRangeValue = previousRange(requestedRange);
                    return fetchMcpObservabilityReport({ from: previousRangeValue[0], to: previousRangeValue[1] });
                })(),
            ]);
            setReport(current);
            setPreviousReport(previous);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 MCP 诊断失败");
        } finally {
            setLoading(false);
        }
    }, [dateRange, message]);

    useEffect(() => {
        void loadReport();
        void fetchMcpOptimizationMarkers().then(setMarkers).catch(() => undefined);
    }, [loadReport]);

    const addMarker = async () => {
        const marker = await saveMcpOptimizationMarker({ at: markerAt.toISOString(), label: markerLabel });
        setMarkers((current) => [...current, marker].sort((left, right) => left.at.localeCompare(right.at)));
        setMarkerLabel("");
        message.success("优化标记已保存");
    };

    const removeMarker = async (id: string) => {
        await deleteMcpOptimizationMarker(id);
        setMarkers((current) => current.filter((item) => item.id !== id));
    };

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
                    <Space wrap>
                        <DatePicker.RangePicker
                            allowClear={false}
                            value={dateRange}
                            onChange={(value) => {
                                if (!value?.[0] || !value?.[1]) return;
                                const next = [value[0].startOf("day"), value[1].startOf("day")] as [Dayjs, Dayjs];
                                setDateRange(next);
                                void loadReport(next);
                            }}
                        />
                        <Button icon={<Download className="size-4" />} disabled={!report} onClick={exportReport}>导出</Button>
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadReport()}>
                            刷新
                        </Button>
                    </Space>
                </div>

                <Alert type="info" showIcon title="数据仅保存在本地 Backend SQLite；日期范围与紧邻的上一等长周期自动比较，无需手工导入基线。" />
                {report?.taskAssociation?.incomplete ? <Alert type="warning" showIcon title="任务关联数据不完整" description={report.taskAssociation.note} /> : null}

                <Tabs
                    defaultActiveKey="overview"
                    items={[
                        { key: "overview", label: "概览与效果", children: (
                            <div className="space-y-5">
                <section className="space-y-3">
                    <div>
                        <h2 className="text-base font-medium">诊断结论</h2>
                        <p className="mt-0.5 text-sm text-muted-foreground">根据所选日期范围的可靠性、延迟和返回体变化自动判断优化效果。</p>
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
                            suffix={report?.payload ? `${report.payload.outputSizedCalls} 次已记录` : undefined}
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

                <Card title="优化标记" extra={<Typography.Text type="secondary">用红色竖线标记代码优化上线时间</Typography.Text>}>
                    <div className="flex flex-wrap items-center gap-2">
                        <DatePicker showTime value={markerAt} onChange={(value) => value && setMarkerAt(value)} />
                        <Input value={markerLabel} onChange={(event) => setMarkerLabel(event.target.value)} placeholder="例如：MCP 返回体上限优化" style={{ width: 280 }} />
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => void addMarker()}>添加标记</Button>
                    </div>
                    <Space wrap className="mt-3">
                        {markers.map((marker) => <Tag key={marker.id} closable color="error" onClose={(event) => { event.preventDefault(); void removeMarker(marker.id); }}>{marker.label} · {new Date(marker.at).toLocaleString()}</Tag>)}
                    </Space>
                </Card>

                {report ? (() => {
                    const compare = comparison(report, previousReport);
                    const priorRange = previousRange(dateRange);
                    return (
                        <Card title="优化效果对比" extra={<Space wrap><Tag>{`${dateText(dateRange[0])} ~ ${dateText(dateRange[1])}`}</Tag><Tag>对比 {priorRange[0]} ~ {priorRange[1]}</Tag><Tag color={compare.verdict === "可靠性改善" ? "success" : compare.verdict === "可靠性回退" ? "error" : undefined}>{compare.verdict}</Tag></Space>}>
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                <Statistic title="完成调用" value={compare.currentCalls} suffix={compare.hasBaseline ? `对比 ${compare.previousCalls}（${signed(compare.currentCalls - compare.previousCalls)}）` : "上一周期无样本"} />
                                <Statistic title="成功率" value={percent(report.calls.successRate)} suffix={compare.hasBaseline ? `${signed(compare.successDelta, 1, " 个百分点")} · 对比 ${percent(previousReport?.calls.successRate ?? null)}` : "上一周期无样本"} />
                                <Statistic title="P95 耗时" value={duration(report.calls.p95DurationMs)} suffix={compare.hasBaseline ? `${signed(compare.p95Delta, 0, " ms")} · 对比 ${duration(previousReport?.calls.p95DurationMs ?? null)}` : "上一周期无样本"} />
                                <Statistic title="返回体均值" value={chars(report.payload?.averageOutputChars ?? null)} suffix={compare.hasBaseline ? `${signed(compare.outputDelta)} 字符 · 对比 ${chars(previousReport?.payload?.averageOutputChars ?? null)}` : "上一周期无样本"} />
                            </div>
                            <Typography.Text type="secondary" className="mt-3 block text-xs">结论以相同自然日长度的两个窗口为基础；调用量会同时展示。失败数不能脱离调用量解释，空窗口不判定为改善。</Typography.Text>
                        </Card>
                    );
                })() : null}
                            </div>
                        ) },
                        { key: "trends", label: "趋势与工具", children: (
                            <div className="space-y-4">
                <div className="grid gap-4 xl:grid-cols-2">
                    <Card
                        title="每日趋势"
                        extra={<Space wrap>
                            <Select
                                aria-label="趋势工具"
                                value={trendTool}
                                style={{ width: 220 }}
                                onChange={setTrendTool}
                                options={[{ value: "*", label: "全部工具" }, ...trendTools.map((tool) => ({ value: tool, label: tool }))]}
                            />
                            <Select
                                aria-label="趋势指标"
                                mode="multiple"
                                value={trendMetrics}
                                style={{ minWidth: 260 }}
                                onChange={(values) => setTrendMetrics(values.length ? values : ["successRate"])}
                                options={Object.entries(trendMetricLabel).map(([value, label]) => ({ value, label }))}
                            />
                        </Space>}
                    >
                        <TrendLineChart data={trendData as unknown as Array<Record<string, unknown>>} metrics={trendSeries} markers={markers.filter((marker) => marker.at >= dataRangeStartIso() && marker.at <= dataRangeEndIso())} tool={trendTool} />
                        <Table
                            rowKey={(item) => `${item.date}-${"tool" in item ? item.tool : "all"}`}
                            size="small"
                            loading={loading}
                            dataSource={trendData}
                            pagination={false}
                            columns={[
                                ...(trendTool === "*" ? [] : [{ title: "工具", dataIndex: "tool" }]),
                                { title: "日期", dataIndex: "date" },
                                { title: "调用", dataIndex: "calls", width: 80 },
                                { title: "成功率", dataIndex: "successRate", width: 100, render: percent },
                                { title: "失败", dataIndex: "failed", width: 70 },
                                { title: "平均耗时", dataIndex: "averageDurationMs", width: 110, render: duration },
                                { title: "返回均值", dataIndex: "averageOutputChars", width: 130, render: (value: number | null | undefined) => value == null ? <Typography.Text type="secondary">未采集</Typography.Text> : chars(value) },
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
                            </div>
                        ) },
                        { key: "tools", label: "工具与失败", children: (
                            <div className="space-y-4">
                                <Card title="工具优化对比" extra={<Typography.Text type="secondary">当前周期与紧邻上一等长周期</Typography.Text>}>
                                    <Table
                                        rowKey="tool"
                                        loading={loading}
                                        dataSource={sortedToolComparison}
                                        pagination={{ pageSize: 15 }}
                                        scroll={{ x: 1000 }}
                                        onChange={(_pagination, _filters, sorter) => {
                                            const next = Array.isArray(sorter) ? sorter[0] : sorter;
                                            setComparisonSort({ key: String(next?.columnKey ?? "calls"), order: next?.order ?? null });
                                        }}
                                        columns={[
                                            { title: "工具", dataIndex: "tool", key: "tool", sorter: true, sortOrder: comparisonSort.key === "tool" ? comparisonSort.order : null },
                                            { title: "当前调用", dataIndex: "calls", key: "calls", width: 90, sorter: true, sortOrder: comparisonSort.key === "calls" ? comparisonSort.order : null },
                                            { title: "对比调用", dataIndex: "previousCalls", key: "previousCalls", width: 90, sorter: true, sortOrder: comparisonSort.key === "previousCalls" ? comparisonSort.order : null },
                                            { title: "成功率变化", dataIndex: "successRateDelta", key: "successRateDelta", width: 120, sorter: true, sortOrder: comparisonSort.key === "successRateDelta" ? comparisonSort.order : null, render: (value: number | null) => value == null ? "—" : <Tag color={value > 0 ? "success" : value < 0 ? "error" : undefined}>{signed(value * 100, 1, " 个百分点")}</Tag> },
                                            { title: "P95 变化", dataIndex: "p95Delta", key: "p95Delta", width: 110, sorter: true, sortOrder: comparisonSort.key === "p95Delta" ? comparisonSort.order : null, render: (value: number | null) => value == null ? "—" : <Tag color={value < 0 ? "success" : value > 0 ? "error" : undefined}>{signed(value, 0, " ms")}</Tag> },
                                            { title: "返回均值变化", dataIndex: "outputDelta", key: "outputDelta", width: 130, sorter: true, sortOrder: comparisonSort.key === "outputDelta" ? comparisonSort.order : null, render: (value: number | null) => value == null ? "—" : <Tag color={value < 0 ? "success" : value > 0 ? "error" : undefined}>{signed(value)} 字符</Tag> },
                                        ]}
                                    />
                                </Card>
                                <Card title="按工具统计"><Table
                                    rowKey="tool"
                                    loading={loading}
                                    dataSource={sortedByTool}
                                    pagination={false}
                                    scroll={{ x: 1360 }}
                                    onChange={(_pagination, _filters, sorter) => {
                                        const next = Array.isArray(sorter) ? sorter[0] : sorter;
                                        setByToolSort({ key: String(next?.columnKey ?? "calls"), order: next?.order ?? null });
                                    }}
                                    columns={[
                                    { title: "工具", dataIndex: "tool", key: "tool", sorter: true, sortOrder: byToolSort.key === "tool" ? byToolSort.order : null },
                                    { title: "调用", dataIndex: "calls", key: "calls", width: 80, sorter: true, sortOrder: byToolSort.key === "calls" ? byToolSort.order : null },
                                    { title: "成功率", dataIndex: "successRate", key: "successRate", width: 90, sorter: true, sortOrder: byToolSort.key === "successRate" ? byToolSort.order : null, render: percent },
                                    { title: "失败", dataIndex: "failed", key: "failed", width: 70, sorter: true, sortOrder: byToolSort.key === "failed" ? byToolSort.order : null },
                                    { title: "最大返回体", dataIndex: "maxOutputChars", key: "maxOutputChars", width: 190, sorter: true, sortOrder: byToolSort.key === "maxOutputChars" ? byToolSort.order : null, render: (value: number | null | undefined) => value == null ? <Typography.Text type="secondary">未采集</Typography.Text> : <Space direction="vertical" size={0}><Typography.Text type={value >= 100000 ? "danger" : undefined}>{chars(value)}</Typography.Text><Typography.Text type="secondary" className="text-xs">{approxTokens(value)}</Typography.Text></Space> },
                                    { title: "返回均值", dataIndex: "averageOutputChars", key: "averageOutputChars", width: 120, sorter: true, sortOrder: byToolSort.key === "averageOutputChars" ? byToolSort.order : null, render: (value: number | null | undefined) => value == null ? "—" : chars(value) },
                                    { title: "最大入参", dataIndex: "maxInputChars", key: "maxInputChars", width: 110, sorter: true, sortOrder: byToolSort.key === "maxInputChars" ? byToolSort.order : null, render: (value: number | null | undefined) => value == null ? "—" : chars(value) },
                                    { title: "平均耗时", dataIndex: "averageDurationMs", key: "averageDurationMs", width: 110, sorter: true, sortOrder: byToolSort.key === "averageDurationMs" ? byToolSort.order : null, render: duration },
                                    { title: "P95", dataIndex: "p95DurationMs", key: "p95DurationMs", width: 100, sorter: true, sortOrder: byToolSort.key === "p95DurationMs" ? byToolSort.order : null, render: duration },
                                    { title: "最长耗时", dataIndex: "maxDurationMs", key: "maxDurationMs", width: 110, sorter: true, sortOrder: byToolSort.key === "maxDurationMs" ? byToolSort.order : null, render: duration },
                                ]} /></Card>
                            </div>
                        ) },
                        { key: "details", label: "链路与明细", children: (
                            <div className="space-y-4">
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
                        ) },
                    ]}
                />
            </div>
        </main>
    );
}
