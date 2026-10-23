import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Card, Empty, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { exportLocalAnalytics, readLocalAnalyticsEvents, type LocalAnalyticsEvent } from "@/lib/local-analytics";

type MetricRow = { key: string; label: string; count: number };

export default function LocalAnalyticsPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [events, setEvents] = useState<LocalAnalyticsEvent[]>([]);
    const [loading, setLoading] = useState(false);
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

    const totals = useMemo(() => ({
        pv: events.filter((event) => event.type === "pv").length,
        mv: events.filter((event) => event.type === "mv").length,
        mc: events.filter((event) => event.type === "mc").length,
    }), [events]);

    const pageRows = useMemo(() => aggregate(events, (event) => event.path), [events]);
    const moduleRows = useMemo(() => aggregate(events.filter((event) => event.type !== "pv"), (event) => event.module), [events]);

    const recentColumns: ColumnsType<LocalAnalyticsEvent> = [
        { title: t("localAnalytics.event"), dataIndex: "type", width: 100, render: (type: LocalAnalyticsEvent["type"]) => <Tag color={type === "pv" ? "blue" : type === "mv" ? "purple" : "green"}>{type.toUpperCase()}</Tag> },
        { title: t("localAnalytics.page"), dataIndex: "path", ellipsis: true },
        { title: t("localAnalytics.module"), dataIndex: "module", ellipsis: true },
        { title: t("localAnalytics.name"), dataIndex: "name", ellipsis: true },
        { title: t("localAnalytics.time"), dataIndex: "occurredAt", width: 190, render: (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) },
    ];

    const aggregateColumns: ColumnsType<MetricRow> = [
        { title: t("localAnalytics.name"), dataIndex: "label", ellipsis: true },
        { title: t("localAnalytics.count"), dataIndex: "count", width: 100, sorter: (a, b) => a.count - b.count },
    ];

    const exportEvents = async () => {
        const count = await exportLocalAnalytics();
        message.success(t("localAnalytics.exported", { count }));
    };

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-8 sm:py-10">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h1 className="text-3xl font-medium tracking-tight text-foreground">{t("localAnalytics.title")}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t("localAnalytics.description")}</p>
                    </div>
                    <div className="flex gap-2">
                        <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>{t("localAnalytics.refresh")}</Button>
                        <Button type="primary" icon={<Download className="size-4" />} onClick={() => void exportEvents()}>{t("localAnalytics.export")}</Button>
                    </div>
                </div>

                <p className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">{t("localAnalytics.localOnly")}</p>

                <div className="grid gap-3 sm:grid-cols-3">
                    {(["pv", "mv", "mc"] as const).map((type) => (
                        <Card key={type} size="small"><div className="text-sm text-muted-foreground">{t(`localAnalytics.${type}`)}</div><div className="mt-1 text-2xl font-semibold text-foreground">{totals[type].toLocaleString(locale)}</div></Card>
                    ))}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                    <Card title={t("localAnalytics.byPage")} size="small">
                        <Table rowKey="key" columns={aggregateColumns} dataSource={pageRows} size="small" pagination={{ pageSize: 8, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                    </Card>
                    <Card title={t("localAnalytics.byModule")} size="small">
                        <Table rowKey="key" columns={aggregateColumns} dataSource={moduleRows} size="small" pagination={{ pageSize: 8, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                    </Card>
                </div>

                <Card title={t("localAnalytics.recentEvents")} size="small">
                    <Table rowKey="id" columns={recentColumns} dataSource={events.slice(0, 50)} loading={loading} size="small" scroll={{ x: 720 }} pagination={false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("localAnalytics.empty")} /> }} />
                </Card>
            </div>
        </main>
    );
}

function aggregate(events: LocalAnalyticsEvent[], getLabel: (event: LocalAnalyticsEvent) => string): MetricRow[] {
    const counts = new Map<string, number>();
    for (const event of events) {
        const label = getLabel(event);
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts].map(([label, count]) => ({ key: label, label, count })).sort((a, b) => b.count - a.count);
}
