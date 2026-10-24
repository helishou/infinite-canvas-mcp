import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Download, RefreshCw } from "lucide-react";
import { Alert, App, Button, Card, DatePicker, Empty, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

import { exportLocalAnalytics, readLocalAnalyticsEvents, type LocalAnalyticsEvent, type LocalAnalyticsEventType } from "@/lib/local-analytics";

type MetricRow = { key: string; label: string; count: number };
type ModuleRow = { key: string; label: string; mv: number; mc: number };
type DailyRow = { date: string; pv: number; mv: number; mc: number };

function defaultRange(): [Dayjs, Dayjs] {
    const to = dayjs();
    return [to.subtract(6, "day").startOf("day"), to.startOf("day")];
}

export default function LocalAnalyticsPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [events, setEvents] = useState<LocalAnalyticsEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(defaultRange);
    const locale = i18n.resolvedLanguage || "zh-CN";

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setEvents(await readLocalAnalyticsEvents());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const rangeEvents = useMemo(() => {
        const from = dateRange[0].startOf("day").valueOf();
        const to = dateRange[1].endOf("day").valueOf();
        return events.filter((event) => {
            const at = Date.parse(event.occurredAt);
            return at >= from && at <= to;
        });
    }, [dateRange, events]);

    const totals = useMemo(() => ({
        pv: rangeEvents.filter((event) => event.type === "pv").length,
        mv: rangeEvents.filter((event) => event.type === "mv").length,
        mc: rangeEvents.filter((event) => event.type === "mc").length,
    }), [rangeEvents]);

    const dailyRows = useMemo(() => makeDailyRows(rangeEvents, dateRange), [dateRange, rangeEvents]);
    const pageRows = useMemo(() => aggregate(rangeEvents.filter((event) => event.type === "pv"), (event) => event.path), [rangeEvents]);
    const moduleRows = useMemo(() => aggregateModules(rangeEvents.filter((event) => event.type !== "pv")), [rangeEvents]);

    const recentColumns: ColumnsType<LocalAnalyticsEvent> = [
        { title: t("localAnalytics.event"), dataIndex: "type", width: 100, render: (type: LocalAnalyticsEventType) => <Tag color={type === "pv" ? "blue" : type === "mv" ? "purple" : "green"}>{type.toUpperCase()}</Tag> },
        { title: t("localAnalytics.page"), dataIndex: "path", ellipsis: true },
        { title: t("localAnalytics.module"), dataIndex: "module", ellipsis: true },
        { title: t("localAnalytics.name"), dataIndex: "name", ellipsis: true },
        { title: t("localAnalytics.time"), dataIndex: "occurredAt", width: 190, render: (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) },
    ];

    const aggregateColumns: ColumnsType<MetricRow> = [
        { title: t("localAnalytics.page"), dataIndex: "label", ellipsis: true },
        { title: t("localAnalytics.count"), dataIndex: "count", width: 100, sorter: (a, b) => a.count - b.count },
    ];
    const moduleColumns: ColumnsType<ModuleRow> = [
        { title: t("localAnalytics.module"), dataIndex: "label", ellipsis: true },
        { title: t("localAnalytics.mv"), dataIndex: "mv", width: 90, sorter: (a, b) => a.mv - b.mv },
        { title: t("localAnalytics.mc"), dataIndex: "mc", width: 90, sorter: (a, b) => a.mc - b.mc },
    ];
    const dailyColumns: ColumnsType<DailyRow> = [
        { title: t("localAnalytics.date"), dataIndex: "date", width: 120 },
        ...(["pv", "mv", "mc"] as const).map((type) => ({ title: t(`localAnalytics.${type}`), dataIndex: type, width: 120 })),
    ];

    const exportEvents = async () => {
        const count = await exportLocalAnalytics(rangeEvents);
        message.success(t("localAnalytics.exported", { count }));
    };

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-7xl space-y-5 px-6 py-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <Activity className="size-5" />
                            <h1 className="text-xl font-semibold">{t("localAnalytics.title")}</h1>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{t("localAnalytics.description")}</p>
                    </div>
                    <Space wrap>
                        <DatePicker.RangePicker
                            allowClear={false}
                            value={dateRange}
                            onChange={(value) => {
                                if (!value?.[0] || !value?.[1]) return;
                                setDateRange([value[0].startOf("day"), value[1].startOf("day")]);
                            }}
                        />
                        <Button icon={<Download className="size-4" />} onClick={() => void exportEvents()}>{t("localAnalytics.export")}</Button>
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                            {t("localAnalytics.refresh")}
                        </Button>
                    </Space>
                </div>

                <Alert type="info" showIcon title={t("localAnalytics.localOnly")} />

                <Tabs
                    defaultActiveKey="overview"
                    items={[
                        {
                            key: "overview",
                            label: t("localAnalytics.overview"),
                            children: (
                                <div className="space-y-5">
                                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                        {(["pv", "mv", "mc"] as const).map((type) => (
                                            <Card key={type} loading={loading}>
                                                <Statistic title={t(`localAnalytics.${type}`)} value={totals[type]} />
                                            </Card>
                                        ))}
                                    </div>

                                    <Card title={t("localAnalytics.dailyTrend")}>
                                        <DailyTrendChart data={dailyRows} labels={{ pv: t("localAnalytics.pv"), mv: t("localAnalytics.mv"), mc: t("localAnalytics.mc") }} />
                                        <Table rowKey="date" columns={dailyColumns} dataSource={dailyRows} size="small" loading={loading} pagination={{ pageSize: 7, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "modules",
                            label: t("localAnalytics.pagesModules"),
                            children: (
                                <div className="grid gap-4 xl:grid-cols-2">
                                    <Card title={t("localAnalytics.pageViews")}>
                                        <Table rowKey="key" columns={aggregateColumns} dataSource={pageRows} loading={loading} size="small" pagination={{ pageSize: 15, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                                    </Card>
                                    <Card title={t("localAnalytics.byModule")}>
                                        <Table rowKey="key" columns={moduleColumns} dataSource={moduleRows} loading={loading} size="small" pagination={{ pageSize: 15, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "events",
                            label: t("localAnalytics.eventDetails"),
                            children: (
                                <Card title={t("localAnalytics.recentEvents")} extra={<Typography.Text type="secondary">{t("localAnalytics.rangeCount", { count: rangeEvents.length })}</Typography.Text>}>
                                    <Table rowKey="id" columns={recentColumns} dataSource={rangeEvents} loading={loading} size="small" scroll={{ x: 720 }} pagination={{ pageSize: 20, showSizeChanger: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                                </Card>
                            ),
                        },
                    ]}
                />
            </div>
        </main>
    );
}

function makeDailyRows(events: LocalAnalyticsEvent[], dateRange: [Dayjs, Dayjs]): DailyRow[] {
    const count = dateRange[1].startOf("day").diff(dateRange[0].startOf("day"), "day") + 1;
    const rows = Array.from({ length: Math.max(0, count) }, (_, index) => {
        const date = dateRange[0].add(index, "day").format("YYYY-MM-DD");
        return { date, pv: 0, mv: 0, mc: 0 };
    });
    const rowsByDate = new Map(rows.map((row) => [row.date, row]));
    for (const event of events) {
        const row = rowsByDate.get(dayjs(event.occurredAt).format("YYYY-MM-DD"));
        if (row) row[event.type]++;
    }
    return rows;
}

function aggregate(events: LocalAnalyticsEvent[], getLabel: (event: LocalAnalyticsEvent) => string): MetricRow[] {
    const counts = new Map<string, number>();
    for (const event of events) {
        const label = getLabel(event);
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts].map(([label, count]) => ({ key: label, label, count })).sort((a, b) => b.count - a.count);
}

function aggregateModules(events: LocalAnalyticsEvent[]): ModuleRow[] {
    const counts = new Map<string, ModuleRow>();
    for (const event of events) {
        const label = `${event.path} · ${event.module}`;
        const row = counts.get(label) || { key: label, label, mv: 0, mc: 0 };
        if (event.type === "mv") row.mv++;
        if (event.type === "mc") row.mc++;
        counts.set(label, row);
    }
    return [...counts.values()].sort((a, b) => (b.mv + b.mc) - (a.mv + a.mc));
}

function DailyTrendChart({ data, labels }: { data: DailyRow[]; labels: Record<LocalAnalyticsEventType, string> }) {
    const width = 900;
    const height = 250;
    const padding = { left: 54, right: 24, top: 18, bottom: 40 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const maximum = Math.max(1, ...data.flatMap((item) => [item.pv, item.mv, item.mc]));
    const x = (index: number) => padding.left + (data.length <= 1 ? innerWidth / 2 : (index / (data.length - 1)) * innerWidth);
    const y = (value: number) => padding.top + innerHeight - (value / maximum) * innerHeight;
    const series = [
        { key: "pv", color: "#3b82f6" },
        { key: "mv", color: "#a855f7" },
        { key: "mc", color: "#22c55e" },
    ] as const;
    const labelStep = Math.max(1, Math.ceil(data.length / 8));

    return (
        <div className="w-full overflow-x-auto">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily PV, MV, MC trend" className="mb-3 min-w-[620px] w-full">
                {[0, 1, 2, 3].map((step) => {
                    const value = maximum * (step / 3);
                    const lineY = y(value);
                    return <g key={step}><line x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY} stroke="currentColor" className="text-border" strokeDasharray="3 4" /><text x={padding.left - 10} y={lineY + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">{Math.round(value)}</text></g>;
                })}
                {series.map(({ key, color }) => {
                    const points = data.map((item, index) => `${x(index)},${y(item[key])}`).join(" ");
                    return <polyline key={key} points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />;
                })}
                {data.map((item, index) => index % labelStep === 0 || index === data.length - 1 ? <text key={item.date} x={x(index)} y={height - 12} textAnchor="middle" className="fill-muted-foreground text-[11px]">{item.date.slice(5)}</text> : null)}
            </svg>
            <Space wrap>
                {series.map(({ key, color }) => <Tag key={key} bordered={false}><span className="mr-1 inline-block size-2 rounded-full" style={{ backgroundColor: color }} />{labels[key]}</Tag>)}
            </Space>
        </div>
    );
}
