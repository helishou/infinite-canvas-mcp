import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
const ProjectsPage = lazy(() => import("@/pages/projects"));
const ProductionWorkbench = lazy(() => import("@/pages/drama/production"));

export default function ProductionHubPage() {
    const { t } = useTranslation();
    const [query] = useSearchParams();
    const dramaId = query.get("dramaId");
    if (dramaId) return <Suspense fallback={<div className="p-6">{t("drama.production.loading")}</div>}><ProductionWorkbench dramaId={dramaId} /></Suspense>;
    return <Suspense fallback={<div className="p-6">{t("canvas.loading")}</div>}><ProjectsPage /></Suspense>;
}
