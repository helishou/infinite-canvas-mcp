import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const CanvasPerformanceFixture = lazy(() => import("@/pages/canvas/performance-fixture"));
const DramaPage = lazy(() => import("@/pages/drama"));
const ConfigPage = lazy(() => import("@/pages/config"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const NotFound = lazy(() => import("@/pages/not-found"));
const WorkflowsPage = lazy(() => import("@/pages/workflows"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const VideoPage = lazy(() => import("@/pages/video"));
const McpObservabilityPage = lazy(() => import("@/pages/mcp-observability"));

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
            { path: "/image", element: lazyPage(ImagePage) },
            { path: "/video", element: lazyPage(VideoPage) },
            { path: "/assets", element: lazyPage(AssetsPage) },
            { path: "/prompts", element: lazyPage(PromptsPage) },
            { path: "/canvas", element: lazyPage(CanvasPage) },
            { path: "/canvas/performance", element: lazyPage(CanvasPerformanceFixture) },
            { path: "/canvas/:id", element: lazyPage(CanvasProjectPage) },
            { path: "/drama", element: lazyPage(DramaPage) },
            { path: "/workflows", element: lazyPage(WorkflowsPage) },
            { path: "/config", element: lazyPage(ConfigPage) },
            { path: "/diagnostics/mcp", element: lazyPage(McpObservabilityPage) },
        ],
    },
    { path: "*", element: lazyPage(NotFound) },
]);
