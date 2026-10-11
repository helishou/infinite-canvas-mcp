import type { ReactNode } from "react";

import { BackendBanner } from "@/components/backend-banner";
import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { CanvasStorageBanner } from "@/components/canvas/canvas-storage-banner";
import { MediaPreviewHost } from "@/components/media/media-preview-host";
import { ProductionFollowController } from "@/components/production/production-follow-controller";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <BackendBanner />
                <CanvasStorageBanner />
                <div className="min-h-0 flex-1 overflow-auto">{children}</div>
            </div>
            <AgentPanel />
            <ProductionFollowController />
            <MediaPreviewHost />
        </div>
    );
}
