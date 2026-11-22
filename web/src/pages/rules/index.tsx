import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Empty, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";

import { PageHeader } from "@/components/layout/page-header";
import { useAgentStore } from "@/stores/use-agent-store";
import {
    deleteLearnedRule,
    fetchLearnedRules,
    reviewLearnedRule,
    RULE_CATEGORIES,
    RULE_CATEGORY_LABELS,
    RULE_CATEGORY_TARGETS,
    setLearnedRuleEnabled,
    setRulesAutoLearn,
    updateLearnedRule,
    type LearnedRule,
    type RuleCategory,
} from "@/services/api/agent-rules";

type RuleFilter = "all" | "pending" | "enabled" | "disabled";

const STATUS_LABELS = { pending: "待复核", enabled: "已启用", disabled: "已停用" } as const;

function ruleStatus(rule: LearnedRule): keyof typeof STATUS_LABELS {
    if (!rule.reviewed) return "pending";
    return rule.enabled ? "enabled" : "disabled";
}

/** 独立规则页：对话中提炼出的候选先在这里复核，启用的规则按类别进入对应制作链路。 */
export default function RulesPage() {
    const { message } = App.useApp();
    const endpoint = useAgentStore((state) => state.url).trim().replace(/\/$/, "");
    const token = useAgentStore((state) => state.token);
    const [rules, setRules] = useState<LearnedRule[]>([]);
    const [autoLearn, setAutoLearn] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState<RuleFilter>("all");
    const [category, setCategory] = useState<RuleCategory | "all">("all");
    const [busy, setBusy] = useState("");
    const [editing, setEditing] = useState<LearnedRule | null>(null);
    const [form] = Form.useForm();

    const load = useCallback(async () => {
        if (!endpoint || !token) {
            setError("尚未配置 Agent 连接。请先在导演面板的连接设置中填写地址与令牌。");
            setLoading(false);
            return;
        }
        setLoading(true);
        setError("");
        try {
            const response = await fetchLearnedRules(endpoint, token);
            setRules(response.data?.rules || []);
            setAutoLearn(response.data?.autoLearn !== false);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "读取规则失败");
        } finally {
            setLoading(false);
        }
    }, [endpoint, token]);

    useEffect(() => { void load(); }, [load]);

    const run = async (id: string, action: () => Promise<unknown>, success: string) => {
        setBusy(id);
        try {
            await action();
            message.success(success);
            await load();
        } catch (caught) {
            message.error(caught instanceof Error ? caught.message : "操作失败");
        } finally {
            setBusy("");
        }
    };

    const onToggleAutoLearn = async (value: boolean) => {
        const previous = autoLearn;
        setAutoLearn(value);
        try {
            await setRulesAutoLearn(endpoint, token, value);
            message.success(value ? "已开启每轮对话自动提炼" : "已关闭自动提炼");
        } catch (caught) {
            setAutoLearn(previous);
            message.error(caught instanceof Error ? caught.message : "保存开关失败");
        }
    };

    const openEdit = (rule: LearnedRule) => {
        setEditing(rule);
        form.setFieldsValue({ title: rule.title, statement: rule.statement, detail: rule.detail || "", category: rule.category, evidence: rule.evidence || "" });
    };

    const saveEdit = async () => {
        if (!editing) return;
        const values = await form.validateFields();
        await run(editing.id, () => updateLearnedRule(endpoint, token, editing.id, values), "规则已更新");
        setEditing(null);
    };

    const filtered = useMemo(() => rules.filter((rule) => {
        if (category !== "all" && rule.category !== category) return false;
        if (filter === "all") return true;
        return ruleStatus(rule) === filter;
    }), [rules, category, filter]);

    const counts = useMemo(() => ({
        enabled: rules.filter((rule) => rule.enabled && rule.reviewed).length,
        pending: rules.filter((rule) => !rule.reviewed).length,
    }), [rules]);

    const columns = useMemo(() => [
        {
            title: "类别",
            dataIndex: "category",
            width: 130,
            render: (value: RuleCategory) => <Tooltip title={RULE_CATEGORY_TARGETS[value]}><Tag color="blue">{RULE_CATEGORY_LABELS[value] || value}</Tag></Tooltip>,
        },
        {
            title: "规则",
            key: "rule",
            render: (_: unknown, rule: LearnedRule) => (
                <div>
                    <div className="text-sm font-medium">{rule.title}</div>
                    <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{rule.statement}</div>
                    {rule.detail ? <div className="mt-1 text-xs text-muted-foreground">适用条件：{rule.detail}</div> : null}
                    {rule.evidence ? <div className="mt-1 text-xs text-muted-foreground">依据原话：{rule.evidence}</div> : null}
                </div>
            ),
        },
        {
            title: "状态",
            key: "status",
            width: 96,
            render: (_: unknown, rule: LearnedRule) => {
                const status = ruleStatus(rule);
                return <Tag color={status === "enabled" ? "green" : status === "pending" ? "gold" : "default"}>{STATUS_LABELS[status]}</Tag>;
            },
        },
        {
            title: "启用",
            key: "enabled",
            width: 76,
            render: (_: unknown, rule: LearnedRule) => (
                <Switch
                    size="small"
                    checked={rule.enabled}
                    loading={busy === rule.id}
                    onChange={(value) => void run(rule.id, () => setLearnedRuleEnabled(endpoint, token, rule.id, value), value ? "规则已启用，后续制作将遵循" : "规则已停用")}
                />
            ),
        },
        {
            title: "操作",
            key: "actions",
            width: 190,
            render: (_: unknown, rule: LearnedRule) => (
                <Space size={4} wrap>
                    {!rule.reviewed ? <Button type="link" size="small" loading={busy === rule.id} onClick={() => void run(rule.id, () => reviewLearnedRule(endpoint, token, rule.id, "accept"), "已采纳并启用")}>采纳</Button> : null}
                    {!rule.reviewed ? <Popconfirm title="忽略这条候选？" onConfirm={() => void run(rule.id, () => reviewLearnedRule(endpoint, token, rule.id, "ignore"), "已忽略")}><Button type="link" size="small" danger>忽略</Button></Popconfirm> : null}
                    <Button type="link" size="small" onClick={() => openEdit(rule)}>编辑</Button>
                    <Popconfirm title="删除这条规则？" onConfirm={() => void run(rule.id, () => deleteLearnedRule(endpoint, token, rule.id), "已删除")}><Button type="link" size="small" danger>删除</Button></Popconfirm>
                </Space>
            ),
        },
    ], [busy, endpoint, token]);

    return (
        <div className="bg-background text-foreground">
            <main className="px-4 py-6 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-[1440px]">
                    <PageHeader
                        title="学习规则"
                        description="导演对话中的修改意见在每轮结束后自动提炼为候选；复核启用后，按类别进入剧本、分镜、提示词、资产、连续性、视频与剪辑环节。"
                        className="border-b border-border pb-5"
                        actions={<Button onClick={() => void load()} loading={loading}>刷新</Button>}
                    />
                    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
                        <span className="flex items-center gap-2">
                            <Switch size="small" checked={autoLearn} loading={loading} onChange={(value) => void onToggleAutoLearn(value)} />
                            每轮对话结束后自动提炼
                        </span>
                        <span className="text-muted-foreground">启用 {counts.enabled} 条 · 待复核 {counts.pending} 条 · 共 {rules.length} 条</span>
                        <span className="text-xs text-muted-foreground">提取的候选默认停用，需在此页采纳后才生效。</span>
                    </div>
                    {error ? <Alert className="mt-4" type="warning" showIcon message={error} /> : null}
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <Segmented<RuleFilter>
                            value={filter}
                            onChange={setFilter}
                            options={[
                                { label: "全部", value: "all" },
                                { label: "待复核", value: "pending" },
                                { label: "已启用", value: "enabled" },
                                { label: "已停用", value: "disabled" },
                            ]}
                        />
                        <Select<RuleCategory | "all">
                            value={category}
                            onChange={setCategory}
                            className="w-48"
                            options={[
                                { value: "all", label: "全部类别" },
                                ...RULE_CATEGORIES.map((value) => ({ value, label: `${RULE_CATEGORY_LABELS[value]} · ${RULE_CATEGORY_TARGETS[value]}` })),
                            ]}
                        />
                    </div>
                    <div className="mt-4">
                        {filtered.length ? (
                            <Table
                                rowKey="id"
                                size="small"
                                loading={loading}
                                pagination={false}
                                columns={columns}
                                dataSource={filtered}
                            />
                        ) : (
                            <Empty description={loading ? "正在读取规则…" : "当前没有符合条件的规则。对话中提出明确的长期修改意见后，规则会出现在待复核中。"} />
                        )}
                    </div>
                    <Typography.Paragraph type="secondary" className="mt-4 text-xs">
                        各类规则只在对应环节生效：分镜规则进拆镜，提示词规则进提示词撰写，资产规则进资产提取与生图，连续性规则进拆镜与提示词的承接约束；剪辑与合成类规则记为人工核对约束，不自动改写 ffmpeg 参数。
                    </Typography.Paragraph>
                </div>
            </main>
            <Modal title="编辑规则" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => void saveEdit()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" className="mt-4">
                    <Form.Item name="title" label="名称" rules={[{ required: true, message: "请输入名称" }]}><Input maxLength={60} /></Form.Item>
                    <Form.Item name="statement" label="规则内容" rules={[{ required: true, message: "请输入规则内容" }]}><Input.TextArea rows={3} maxLength={400} /></Form.Item>
                    <Form.Item name="detail" label="适用条件或例外"><Input.TextArea rows={2} maxLength={800} /></Form.Item>
                    <Form.Item name="category" label="生效链路">
                        <Select options={RULE_CATEGORIES.map((value) => ({ value, label: `${RULE_CATEGORY_LABELS[value]} · ${RULE_CATEGORY_TARGETS[value]}` }))} />
                    </Form.Item>
                    <Form.Item name="evidence" label="用户原话依据"><Input.TextArea rows={2} maxLength={400} /></Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
