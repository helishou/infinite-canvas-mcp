import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { fetchBackendDramaEpisode } from "@/services/backend-api";

/**
 * 制作入口收敛用的旧地址重定向：
 * - /drama 与 /production 是同一入口；
 * - 分集深链统一改写为 /production?dramaId&episodeId（唯一能带剧目上下文的工作台地址）；
 * - 场景制作归属画布或分集，没有独立页面，历史链接回到制作首页。
 */

export function ProductionAliasRedirect() {
    const { search } = useLocation();
    return <Navigate to={{ pathname: "/production", search }} replace />;
}

export function EpisodeProductionRedirect() {
    const { episodeId = "" } = useParams();
    const { search } = useLocation();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [dramaId, setDramaId] = useState<string>();
    const [failed, setFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let active = true;
        setFailed(false);
        void fetchBackendDramaEpisode(episodeId)
            .then(result => { if (active) { const id = result.episode?.dramaId || ""; if (id) setDramaId(id); else setFailed(true); } })
            .catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [episodeId, retry]);
    if (failed) return <div className="mx-auto max-w-[720px] space-y-4 p-6">
        <Alert type="error" showIcon message={t("director.atomic.episodeGone")} />
        <div className="flex gap-2"><Button onClick={() => setRetry(value => value + 1)}>{t("director.refresh")}</Button><Button type="text" onClick={() => navigate("/production")}>{t("director.back")}</Button></div>
    </div>;
    if (!dramaId) return <div className="p-6 text-sm text-muted-foreground">{t("drama.production.loading")}</div>;
    const query = new URLSearchParams(search);
    query.set("dramaId", dramaId);
    query.set("episodeId", episodeId);
    return <Navigate to={{ pathname: "/production", search: query.toString() }} replace />;
}

export function SceneProductionRedirect() {
    return <Navigate to="/production" replace />;
}
