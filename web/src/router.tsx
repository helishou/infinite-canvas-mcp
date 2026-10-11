import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
const AssetsPage = lazy(() => import("@/pages/assets"));
import { loadCanvasProjectPage } from "@/lib/canvas-project-loader";

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
const ImagePage = lazy(() => import("@/pages/image"));
const NotFound = lazy(() => import("@/pages/not-found"));
const WorkflowsPage = lazy(() => import("@/pages/workflows"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const VideoPage = lazy(() => import("@/pages/video"));
const McpObservabilityPage = lazy(() => import("@/pages/mcp-observability"));
const PelicanBikePage = lazy(() => import("@/pages/pelican-bike"));

const pageFallback = <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">加载中…</div>;

function lazyPage(Page: LazyExoticComponent<ComponentType>) {
    return (
        <Suspense fallback={pageFallback}>
            <Page />
        </Suspense>
    );
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: lazyPage(HomePage) },
            { path: "/production", element: lazyPage(ProductionHubPage) },
            { path: "/director", element: lazyPage(LegacyDirectorPage) },
            { path: "/director/:projectId", element: lazyPage(EpisodeProductionPage) },
            { path: "/image", element: lazyPage(ImagePage) },
            { path: "/video", element: lazyPage(VideoPage) },
            { path: "/assets", element: lazyPage(AssetsPage) },
            { path: "/prompts", element: lazyPage(PromptsPage) },
            { path: "/canvas", element: lazyPage(CanvasPage) },
            { path: "/canvas/performance", element: lazyPage(CanvasPerformanceFixture) },
            { path: "/canvas/:id", element: lazyPage(CanvasProjectPage) },
            { path: "/drama", element: lazyPage(ProductionAliasRedirect) },
            { path: "/drama/episodes/:episodeId/production", element: lazyPage(EpisodeProductionRedirect) },
            { path: "/drama/scenes/:sceneId/production", element: lazyPage(SceneProductionRedirect) },
            { path: "/workflows", element: lazyPage(WorkflowsPage) },
            { path: "/config", element: lazyPage(ConfigPage) },
            { path: "/diagnostics/mcp", element: lazyPage(McpObservabilityPage) },
        ],
    },
    { path: "/pelican-bike", element: lazyPage(PelicanBikePage) },
    { path: "*", element: lazyPage(NotFound) },
]);
