import { Button, Empty, Input, Modal, Tooltip } from "antd";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { canvasNodeFocusHref, searchCanvasNodes } from "@/lib/canvas/canvas-node-search";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const EMPTY_NODES: never[] = [];

/**
 * 自由画布的「找画面」。
 *
 * 制作画布有制作目录（角色 / 场次 / 镜头 / Clip），自由画布没有；这里退化为节点检索，
 * 点结果走画布已有的 `?nodeId=` 深链，定位逻辑与别处完全一致，不另造视口接口。
 */
export function CanvasNodeFinder({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const nodes = useCanvasStore(state => state.projects.find(project => project.id === projectId)?.nodes || EMPTY_NODES);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const hits = useMemo(() => searchCanvasNodes(nodes, query, 40), [nodes, query]);

    const focus = (nodeId: string) => {
        setOpen(false);
        navigate(canvasNodeFocusHref(projectId, nodeId));
    };

    return (
        <>
            <Tooltip title={t("productionCanvas.find")}>
                <Button
                    type="text"
                    size="small"
                    icon={<Search className="size-3.5" />}
                    aria-label={t("productionCanvas.find")}
                    data-testid="canvas-node-finder-trigger"
                    onClick={() => setOpen(true)}
                >
                    <span className="hidden sm:inline">{t("productionCanvas.find")}</span>
                </Button>
            </Tooltip>
            <Modal
                open={open}
                onCancel={() => setOpen(false)}
                footer={null}
                width={560}
                title={t("productionCanvas.find")}
                styles={{ body: { padding: 0 } }}
                destroyOnHidden
            >
                <div className="flex flex-col bg-background text-foreground" data-testid="canvas-node-finder">
                    <div className="border-b border-border p-3">
                        <Input
                            autoFocus
                            allowClear
                            prefix={<Search className="size-4 text-muted-foreground" />}
                            value={query}
                            aria-label={t("canvas.nodeFinder.placeholder")}
                            placeholder={t("canvas.nodeFinder.placeholder")}
                            onChange={event => setQuery(event.target.value)}
                        />
                        <p className="ui-caption mt-2 text-muted-foreground">{t("canvas.nodeFinder.hint", { count: nodes.length })}</p>
                    </div>
                    <div className="max-h-[52vh] min-h-[180px] overflow-y-auto p-1.5">
                        {hits.length === 0 ? (
                            <Empty
                                className="py-10"
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={query.trim() ? t("canvas.nodeFinder.noMatch") : t("canvas.nodeFinder.empty")}
                            />
                        ) : (
                            <ul className="flex flex-col gap-0.5">
                                {hits.map(hit => (
                                    <li key={hit.id}>
                                        <button
                                            type="button"
                                            data-testid="canvas-node-finder-hit"
                                            data-node-id={hit.id}
                                            onClick={() => focus(hit.id)}
                                            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition hover:bg-muted"
                                        >
                                            <span className="mt-0.5 shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{hit.type}</span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm">{hit.title}</span>
                                                {hit.snippet ? <span className="ui-caption mt-0.5 block truncate text-muted-foreground">{hit.snippet}</span> : null}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </Modal>
        </>
    );
}
