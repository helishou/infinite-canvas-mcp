import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { useTranslation } from "react-i18next";
import { createBrowserRouter, Navigate, Outlet, useLocation, useRouteError } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
const AssetsPage = lazy(() => import("@/pages/assets"));
import { loadCanvasProjectPage } from "@/lib/canvas-project-loader";

const ProjectsPage = lazy(() => import("@/pages/projects"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(loadCanvasProjectPage);
const CanvasPerformanceFixture = lazy(() => import("@/pages/canvas/performance-fixture"));
const EpisodeProductionPage = lazy(() => import("@/pages/drama/production"));
const ProductionHubPage = lazy(() => import("@/pages/production"));
const ProductionAliasRedirect = lazy(() => import("@/pages/drama/legacy-routes").then(module => ({ default: module.ProductionAliasRedirect })));
const EpisodeProductionRedirect = lazy(() => import("@/pages/drama/legacy-routes").then(module => ({ default: module.EpisodeProductionRedirect })));
const SceneProductionRedirect = lazy(() => import("@/pages/drama/legacy-routes").then(module => ({ default: module.SceneProductionRedirect })));
const LegacyDirectorPage = lazy(() => import("@/pages/director"));
const ConfigPage = lazy(() => import("@/pages/config"));
const HomePage = lazy(() => import("@/pages/home"));
const NotFound = lazy(() => import("@/pages/not-found"));
const EngineConsolePage = lazy(() => import("@/pages/engine-console"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const McpObservabilityPage = lazy(() => import("@/pages/mcp-observability"));
const PelicanBikePage = lazy(() => import("@/pages/pelican-bike"));
const LocalAnalyticsPage = lazy(() => import("@/pages/local-analytics"));
const SkillsPage = lazy(() => import("@/pages/skills"));
const RulesPage = lazy(() => import("@/pages/rules"));
const DramaStudioPage = lazy(() => import("@/pages/drama-studio"));
const NewDramaPage = lazy(() => import("@/pages/drama/new-drama-page"));

const pageFallback = <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">加载中…</div>;

/** 渲染期异常（含 dev HMR 后的 hook 错链）兜底：保留错误信息，给一次可恢复的重载入口，而不是整页白屏。 */
function RouteErrorPage() {
    const error = useRouteError();
    const { t } = useTranslation();
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
    const stack = error instanceof Error ? error.stack || "" : "";
    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
            <h1 className="text-lg font-semibold">{t("routeError.title")}</h1>
            <p className="max-w-[640px] text-sm text-muted-foreground">{t("routeError.hint")}</p>
            {message ? <pre className="max-w-[720px] overflow-auto rounded-md border p-3 text-left text-xs">{message}</pre> : null}
            <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={() => window.location.reload()}>
                {t("routeError.reload")}
            </button>
            {stack ? (
                <details className="max-w-[720px] text-left text-xs text-muted-foreground">
                    <summary>{t("routeError.details")}</summary>
                    <pre className="overflow-auto whitespace-pre-wrap">{stack}</pre>
                </details>
            ) : null}
        </div>
    );
}

function lazyPage(Page: LazyExoticComponent<ComponentType>) {
    return (
        <Suspense fallback={pageFallback}>
            <Page />
        </Suspense>
    );
}

/** 旧快速生成入口并入首页启动台：保留地址与查询参数，预选对应生成模式。 */
function HomeModeRedirect({ mode }: { mode: "image" | "video" }) {
    const { search } = useLocation();
    const query = new URLSearchParams(search);
    query.set("mode", mode);
    return <Navigate to={{ pathname: "/", search: query.toString() }} replace />;
}

// Exported so reports can collapse a concrete pathname to its route pattern without a second route table.
export const appRoutes = [
    { path: "/", element: lazyPage(HomePage) },
    { path: "/projects", element: lazyPage(ProjectsPage) },
    { path: "/drama-studio", element: lazyPage(DramaStudioPage) },
    { path: "/drama-studio/new", element: lazyPage(NewDramaPage) },
    { path: "/production", element: lazyPage(ProductionHubPage) },
    { path: "/director", element: lazyPage(LegacyDirectorPage) },
    { path: "/director/:projectId", element: lazyPage(EpisodeProductionPage) },
    { path: "/image", element: <HomeModeRedirect mode="image" /> },
    { path: "/video", element: <HomeModeRedirect mode="video" /> },
    { path: "/assets", element: lazyPage(AssetsPage) },
    { path: "/prompts", element: lazyPage(PromptsPage) },
    { path: "/skills", element: lazyPage(SkillsPage) },
    { path: "/rules", element: lazyPage(RulesPage) },
    { path: "/canvas", element: lazyPage(CanvasPage) },
    { path: "/canvas/performance", element: lazyPage(CanvasPerformanceFixture) },
    { path: "/canvas/:id", element: lazyPage(CanvasProjectPage) },
    { path: "/drama", element: lazyPage(ProductionAliasRedirect) },
    { path: "/drama/episodes/:episodeId/production", element: lazyPage(EpisodeProductionRedirect) },
    { path: "/drama/scenes/:sceneId/production", element: lazyPage(SceneProductionRedirect) },
    // 工作流管理已迁移到执行引擎控制台，画布这个路由只做跳转
    { path: "/workflows", element: lazyPage(EngineConsolePage) },
    { path: "/config", element: lazyPage(ConfigPage) },
    { path: "/diagnostics/mcp", element: lazyPage(McpObservabilityPage) },
    { path: "/analytics/local", element: lazyPage(LocalAnalyticsPage) },
];

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        errorElement: <RouteErrorPage />,
        children: appRoutes,
    },
    { path: "/pelican-bike", element: <><AnalyticsTracker />{lazyPage(PelicanBikePage)}</> },
    { path: "*", element: lazyPage(NotFound) },
]);
