import { lazy, Suspense } from "react";
import { ArrowRight, LayoutGrid } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
const SeriesEpisodes = lazy(() => import("@/pages/drama"));

export default function ProductionHubPage() {
    const { t } = useTranslation();
    return <main className="min-h-full bg-background text-foreground" data-testid="production-home">
        <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
            <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{t("landing.productionTitle")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("landing.productionSubtitle")}</p></div><Link to="/canvas" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><LayoutGrid className="size-4" />{t("landing.canvasHome")}<ArrowRight className="size-4" /></Link></header>
            <Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground">{t("canvas.loading")}</div>}><SeriesEpisodes embedded /></Suspense>
        </div>
    </main>;
}
