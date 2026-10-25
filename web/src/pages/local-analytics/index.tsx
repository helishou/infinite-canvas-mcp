import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Download, Info, RefreshCw } from "lucide-react";
import { App, Button, Card, DatePicker, Empty, Segmented, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

import { appRoutes } from "@/router";
import { PageHeader } from "@/components/layout/page-header";
import { axisTicks } from "@/lib/axis-ticks";
import { exportLocalAnalytics, readLocalAnalyticsEvents, type LocalAnalyticsEvent, type LocalAnalyticsEventType, type LocalAnalyticsRect } from "@/lib/local-analytics";
import { routeTemplate } from "@/lib/route-template";

type PageRow = { key: string; label: string; count: number; share: number; lastAt: string };
type ModuleRow = { key: string; module: string; page: string; mv: number; mc: number; share: number; lastAt: string; rect?: LocalAnalyticsRect };
type DailyRow = { date: string; pv: number; mv: number; mc: number };
type Grouping = "route" | "path";
type ModuleFilter = "all" | "unclicked";

const percent = (value: number) => `${Math.round(value * 100)}%`;
/** Structural fallbacks look like `panel › div#3`; flag them so the report does not pretend they are names. */
const isAutomaticModule = (value: string) => /(^|› )([a-z]+)#\d+$/.test(value);

/** Stable module keys set by the app, translated at display time so stored records stay language-independent. */
const MODULE_LABELS: Record<string, string> = {
    "app-top-nav": "localAnalytics.moduleAppTopNav",
};

function defaultRange(): [Dayjs, Dayjs] {
    const to = dayjs();
    return [to.subtract(6, "day").startOf("day"), to.startOf("day")];
}

function pageLabel(path: string, grouping: Grouping) {
    return grouping === "route" ? routeTemplate(appRoutes, path) : path;
}

export default function LocalAnalyticsPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [events, setEvents] = useState<LocalAnalyticsEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>(defaultRange);
    const [grouping, setGrouping] = useState<Grouping>("route");
    const [moduleFilter, setModuleFilter] = useState<ModuleFilter>("all");
    const [showDailyTable, setShowDailyTable] = useState(false);
    const [activeModuleKey, setActiveModuleKey] = useState<string | null>(null);
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
        routes: new Set(rangeEvents.filter((event) => event.type === "pv").map((event) => routeTemplate(appRoutes, event.path))).size,
    }), [rangeEvents]);

    const dailyRows = useMemo(() => makeDailyRows(rangeEvents, dateRange), [dateRange, rangeEvents]);
    const kpiCards = [
        { key: "pv", label: t("localAnalytics.pv"), value: totals.pv },
        { key: "mv", label: t("localAnalytics.mv"), value: totals.mv },
        { key: "mc", label: t("localAnalytics.mc"), value: totals.mc },
        { key: "routes", label: t("localAnalytics.activeRoutes"), value: totals.routes },
    ];
    const pageRows = useMemo(() => aggregatePages(rangeEvents, grouping), [grouping, rangeEvents]);
    const moduleRows = useMemo(() => aggregateModules(rangeEvents, grouping), [grouping, rangeEvents]);
    const visibleModuleRows = useMemo(
        () => moduleFilter === "unclicked" ? moduleRows.filter((row) => row.mc === 0) : moduleRows,
        [moduleFilter, moduleRows],
    );
    const activeModule = visibleModuleRows.find((row) => row.key === activeModuleKey) ?? visibleModuleRows[0];
    const previewRows = useMemo(
        () => activeModule ? moduleRows.filter((row) => row.page === activeModule.page && row.rect) : [],
        [activeModule, moduleRows],
    );

    const timeText = useCallback((value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)), [locale]);
    const pageTitle = grouping === "route" ? t("localAnalytics.route") : t("localAnalytics.page");

    const recentColumns: ColumnsType<LocalAnalyticsEvent> = [
        { title: t("localAnalytics.event"), dataIndex: "type", width: 100, render: (type: LocalAnalyticsEventType) => <Tag color={type === "pv" ? "blue" : type === "mv" ? "purple" : "green"}>{type.toUpperCase()}</Tag> },
        { title: t("localAnalytics.page"), dataIndex: "path", ellipsis: true },
        { title: t("localAnalytics.module"), dataIndex: "module", ellipsis: true },
        { title: t("localAnalytics.name"), dataIndex: "name", ellipsis: true },
        { title: t("localAnalytics.time"), dataIndex: "occurredAt", width: 190, render: (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) },
    ];

    const pageColumns: ColumnsType<PageRow> = [
        { title: pageTitle, dataIndex: "label", ellipsis: true, sorter: (a, b) => a.label.localeCompare(b.label) },
        { title: t("localAnalytics.count"), dataIndex: "count", width: 92, sorter: (a, b) => a.count - b.count },
        { title: t("localAnalytics.share"), dataIndex: "share", width: 88, sorter: (a, b) => a.share - b.share, render: (value: number) => percent(value) },
        { title: t("localAnalytics.lastSeen"), dataIndex: "lastAt", width: 150, render: (value: string) => timeText(value) },
    ];

    const moduleColumns: ColumnsType<ModuleRow> = [
        {
            title: t("localAnalytics.module"),
            dataIndex: "module",
            ellipsis: true,
            render: (value: string) => {
                const label = value === "unassigned" ? t("localAnalytics.noModule") : MODULE_LABELS[value] ? t(MODULE_LABELS[value]) : value;
                return (
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-xs">{label}</span>
                        {isAutomaticModule(value) && (
                            <Tooltip title={t("localAnalytics.unnamedModuleHint")}>
                                <Tag className="shrink-0">{t("localAnalytics.unnamedModule")}</Tag>
                            </Tooltip>
                        )}
                    </div>
                );
            },
        },
        { title: pageTitle, dataIndex: "page", ellipsis: true, width: 180 },
        { title: t("localAnalytics.mvShort"), dataIndex: "mv", width: 76, sorter: (a, b) => a.mv - b.mv },
        { title: t("localAnalytics.mcShort"), dataIndex: "mc", width: 76, sorter: (a, b) => a.mc - b.mc },
        { title: t("localAnalytics.share"), dataIndex: "share", width: 84, sorter: (a, b) => a.share - b.share, render: (value: number) => percent(value) },
        {
            title: t("localAnalytics.position"),
            key: "position",
            width: 76,
            render: (_, row) => (
                <ModulePosition
                    rect={row.rect}
                    label={row.rect ? t("localAnalytics.rectHint", { x: percent(row.rect.x), y: percent(row.rect.y), w: percent(row.rect.w), h: percent(row.rect.h) }) : t("localAnalytics.noPosition")}
                />
            ),
        },
        { title: t("localAnalytics.lastSeen"), dataIndex: "lastAt", width: 150, render: (value: string) => timeText(value) },
    ];

    const dailyColumns: ColumnsType<DailyRow> = [
        { title: t("localAnalytics.date"), dataIndex: "date", width: 120 },
        ...(["pv", "mv", "mc"] as const).map((type) => ({ title: t(`localAnalytics.${type}`), dataIndex: type, width: 120 })),
    ];

    const exportEvents = async () => {
        const count = await exportLocalAnalytics(rangeEvents);
        message.success(t("localAnalytics.exported", { count }));
    };

    const groupingControl = (
        <Segmented
            size="small"
            value={grouping}
            onChange={(value) => setGrouping(value as Grouping)}
            options={[
                { value: "route", label: t("localAnalytics.groupByRoute") },
                { value: "path", label: t("localAnalytics.groupByPath") },
            ]}
        />
    );

    const moduleFilterControl = (
        <Segmented
            size="small"
            value={moduleFilter}
            onChange={(value) => setModuleFilter(value as ModuleFilter)}
            options={[
                { value: "all", label: t("localAnalytics.filterAll") },
                { value: "unclicked", label: t("localAnalytics.filterUnclicked") },
            ]}
        />
    );

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
                <PageHeader
                    width="data"
                    icon={<Activity className="size-5" />}
                    title={
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{t("localAnalytics.title")}</span>
                            <Tooltip title={<span className="block max-w-80 text-xs leading-relaxed">{t("localAnalytics.localOnly")}</span>}>
                                <button type="button" aria-label={t("localAnalytics.localOnlyTitle")} className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-foreground">
                                    <Info className="size-4" />
                                </button>
                            </Tooltip>
                        </span>
                    }
                    description={t("localAnalytics.description")}
                    actions={
                        <Space wrap>
                            <DatePicker.RangePicker
                                allowClear={false}
                                value={dateRange}
                                onChange={(value) => {
                                    if (!value?.[0] || !value?.[1]) return;
                                    setDateRange([value![0].startOf("day"), value![1].startOf("day")]);
                                }}
                            />
                            <Button icon={<Download className="size-4" />} onClick={() => void exportEvents()}>{t("localAnalytics.export")}</Button>
                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                                {t("localAnalytics.refresh")}
                            </Button>
                        </Space>
                    }
                />

                <Tabs
                    defaultActiveKey="overview"
                    items={[
                        {
                            key: "overview",
                            label: t("localAnalytics.overview"),
                            children: (
                                <div className="space-y-4">
                                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                        {kpiCards.map((kpi) => (
                                            <Card key={kpi.key} size="small" loading={loading}>
                                                <div className="text-xs text-muted-foreground">{kpi.label}</div>
                                                <div className="mt-1 text-2xl font-semibold tabular-nums">{kpi.value}</div>
                                            </Card>
                                        ))}
                                    </div>

                                    {rangeEvents.length === 0 ? (
                                        <FirstRunGuide loading={loading} onRefresh={() => void refresh()} />
                                    ) : (
                                        <Card
                                            title={t("localAnalytics.dailyTrend")}
                                            extra={
                                                <Button type="link" size="small" onClick={() => setShowDailyTable((value) => !value)}>
                                                    {showDailyTable ? t("localAnalytics.dailyHide") : t("localAnalytics.dailyShow")}
                                                </Button>
                                            }
                                        >
                                            <DailyTrendChart data={dailyRows} labels={{ pv: t("localAnalytics.pv"), mv: t("localAnalytics.mv"), mc: t("localAnalytics.mc") }} />
                                            {totals.mv + totals.mc === 0 && <p className="mb-3 text-xs text-muted-foreground">{t("localAnalytics.noModuleHint")}</p>}
                                            {showDailyTable && (
                                                <Table
                                                    rowKey="date"
                                                    columns={dailyColumns}
                                                    dataSource={dailyRows}
                                                    size="small"
                                                    pagination={false}
                                                    scroll={{ y: 260 }}
                                                />
                                            )}
                                        </Card>
                                    )}
                                </div>
                            ),
                        },
                        {
                            key: "pages",
                            label: t("localAnalytics.byPage"),
                            children: (
                                <Card title={t("localAnalytics.pageViews")} extra={groupingControl}>
                                    <Table rowKey="key" columns={pageColumns} dataSource={pageRows} loading={loading} size="small" pagination={{ pageSize: 15, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                                </Card>
                            ),
                        },
                        {
                            key: "modules",
                            label: t("localAnalytics.byModule"),
                            children: (
                                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                                    <Card title={t("localAnalytics.moduleTable")} extra={<Space size={8} wrap>{moduleFilterControl}{groupingControl}</Space>}>
                                        <Table
                                            rowKey="key"
                                            columns={moduleColumns}
                                            dataSource={visibleModuleRows}
                                            loading={loading}
                                            size="small"
                                            scroll={{ x: 680 }}
                                            pagination={{ pageSize: 15, showSizeChanger: false }}
                                            onRow={(row) => ({
                                                onMouseEnter: () => setActiveModuleKey(row.key),
                                                onClick: () => setActiveModuleKey(row.key),
                                                className: "cursor-pointer",
                                            })}
                                            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={moduleFilter === "unclicked" && moduleRows.length ? t("localAnalytics.noUnclicked") : t("localAnalytics.empty")} /> }}
                                        />
                                    </Card>
                                    <Card title={t("localAnalytics.modulePreview")} className="xl:sticky xl:top-4 xl:self-start">
                                        {previewRows.length ? (
                                            <>
                                                <ModulePreview
                                                    rows={previewRows}
                                                    activeKey={activeModule?.key ?? ""}
                                                    onSelect={setActiveModuleKey}
                                                    caption={t("localAnalytics.previewOf", { page: activeModule?.page ?? "" })}
                                                />
                                                <p className="mt-3 text-xs text-muted-foreground">{activeModule?.rect ? t("localAnalytics.previewHint") : t("localAnalytics.previewNoPosition")}</p>
                                            </>
                                        ) : (
                                            <Empty
                                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                                description={moduleRows.length ? t("localAnalytics.modulePreviewLegacy") : t("localAnalytics.modulePreviewEmpty")}
                                            />
                                        )}
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

/** Shown instead of an empty chart, so a first visit explains how records appear. */
function FirstRunGuide({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
    const { t } = useTranslation();
    return (
        <Card title={t("localAnalytics.firstRunTitle")}>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>{t("localAnalytics.firstRunStep1")}</li>
                <li>{t("localAnalytics.firstRunStep2")}</li>
                <li>{t("localAnalytics.firstRunStep3")}</li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">{t("localAnalytics.firstRunNote")}</p>
            <Button className="mt-3" size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={onRefresh}>
                {t("localAnalytics.firstRunRefresh")}
            </Button>
        </Card>
    );
}

/** Draw the recorded boxes of one page so a module row can be recognised by where it sat, not only by its id. */
function ModulePreview({ rows, activeKey, onSelect, caption }: { rows: ModuleRow[]; activeKey: string; onSelect: (key: string) => void; caption: string }) {
    const width = 320;
    const height = 200;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const boxes = rows.filter((row) => row.rect && row.rect.y + row.rect.h > 0 && row.rect.y < 1);
    return (
        <div className="space-y-3">
            <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded-md border border-border bg-muted/30" role="img" aria-label={caption}>
                {boxes.map((row) => {
                    const rect = row.rect!;
                    const x = clamp(rect.x);
                    const y = clamp(rect.y);
                    const active = row.key === activeKey;
                    return (
                        <g key={row.key} className="cursor-pointer" onMouseEnter={() => onSelect(row.key)} onClick={() => onSelect(row.key)}>
                            <rect
                                x={x * width}
                                y={y * height}
                                width={Math.max(2, (Math.min(1, rect.x + rect.w) - x) * width)}
                                height={Math.max(2, (Math.min(1, rect.y + rect.h) - y) * height)}
                                rx={3}
                                fill={active ? "rgba(59,130,246,0.18)" : "rgba(148,163,184,0.14)"}
                                stroke={active ? "#3b82f6" : "rgba(148,163,184,0.6)"}
                                strokeWidth={active ? 2 : 1}
                            />
                            <title>{row.module}</title>
                        </g>
                    );
                })}
                <rect x={0.5} y={0.5} width={width - 1} height={height - 1} fill="none" stroke="currentColor" strokeDasharray="4 4" className="text-border" />
            </svg>
            <p className="text-xs text-muted-foreground">{caption}</p>
        </div>
    );
}

/** One row's box drawn small, so rows can be compared without reading four percentages. */
function ModulePosition({ rect, label }: { rect?: LocalAnalyticsRect; label: string }) {
    if (!rect) return <span className="text-xs text-muted-foreground">—</span>;
    const width = 48;
    const height = 32;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const x = clamp(rect.x);
    const y = clamp(rect.y);
    return (
        <Tooltip title={label}>
            <svg viewBox={`0 0 ${width} ${height}`} className="h-8 w-12 rounded-sm border border-border bg-muted/50" role="img" aria-label={label}>
                <rect x={0.5} y={0.5} width={width - 1} height={height - 1} fill="none" stroke="currentColor" strokeDasharray="2 3" className="text-border" />
                <rect
                    x={x * width}
                    y={y * height}
                    width={Math.max(2, (Math.min(1, rect.x + rect.w) - x) * width)}
                    height={Math.max(2, (Math.min(1, rect.y + rect.h) - y) * height)}
                    rx={1.5}
                    fill="rgba(59,130,246,0.35)"
                    stroke="#3b82f6"
                    strokeWidth={1.2}
                />
            </svg>
        </Tooltip>
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

function aggregatePages(events: LocalAnalyticsEvent[], grouping: Grouping): PageRow[] {
    const pageviews = events.filter((event) => event.type === "pv");
    const rows = new Map<string, PageRow>();
    for (const event of pageviews) {
        const label = pageLabel(event.path, grouping);
        const row = rows.get(label) ?? { key: label, label, count: 0, share: 0, lastAt: event.occurredAt };
        row.count++;
        if (event.occurredAt > row.lastAt) row.lastAt = event.occurredAt;
        rows.set(label, row);
    }
    return [...rows.values()]
        .map((row) => ({ ...row, share: pageviews.length ? row.count / pageviews.length : 0 }))
        .sort((a, b) => b.count - a.count);
}

function aggregateModules(events: LocalAnalyticsEvent[], grouping: Grouping): ModuleRow[] {
    const interactions = events.filter((event) => event.type !== "pv");
    const rows = new Map<string, ModuleRow>();
    for (const event of interactions) {
        const page = pageLabel(event.path, grouping);
        const key = `${page}\u0000${event.module}`;
        const row = rows.get(key) ?? { key, module: event.module, page, mv: 0, mc: 0, share: 0, lastAt: event.occurredAt };
        if (event.type === "mv") row.mv++;
        if (event.type === "mc") row.mc++;
        if (event.occurredAt >= row.lastAt) {
            row.lastAt = event.occurredAt;
            // Keep the newest box for the preview; older records carry no position at all.
            row.rect = event.rect ?? row.rect;
        }
        rows.set(key, row);
    }
    return [...rows.values()]
        .map((row) => ({ ...row, share: interactions.length ? (row.mv + row.mc) / interactions.length : 0 }))
        .sort((a, b) => (b.mv + b.mc) - (a.mv + a.mc));
}

function DailyTrendChart({ data, labels }: { data: DailyRow[]; labels: Record<LocalAnalyticsEventType, string> }) {
    const width = 900;
    const height = 230;
    const padding = { left: 54, right: 24, top: 18, bottom: 34 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const ticks = axisTicks(Math.max(1, ...data.flatMap((item) => [item.pv, item.mv, item.mc])));
    const top = ticks[ticks.length - 1];
    const x = (index: number) => padding.left + (data.length <= 1 ? innerWidth / 2 : (index / (data.length - 1)) * innerWidth);
    const y = (value: number) => padding.top + innerHeight - (value / top) * innerHeight;
    const series = [
        { key: "pv", color: "#3b82f6" },
        { key: "mv", color: "#a855f7" },
        { key: "mc", color: "#22c55e" },
    ] as const;
    const labelStep = Math.max(1, Math.ceil(data.length / 8));

    return (
        <div className="w-full overflow-x-auto">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily PV, MV, MC trend" className="mb-3 min-w-[620px] w-full">
                {ticks.map((value) => {
                    const lineY = y(value);
                    return <g key={value}><line x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY} stroke="currentColor" className="text-border" strokeDasharray="3 4" /><text x={padding.left - 10} y={lineY + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">{value}</text></g>;
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
