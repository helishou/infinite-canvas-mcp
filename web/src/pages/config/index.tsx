import { useTranslation } from "react-i18next";
import { Activity, BarChart3 } from "lucide-react";
import { Button } from "antd";
import { Link } from "react-router-dom";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { PageHeader } from "@/components/layout/page-header";

export default function ConfigPage() {
    const { t } = useTranslation();

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
                <PageHeader
                    width="data"
                    title={t("config.title")}
                    description={t("config.description")}
                    actions={
                        <>
                            <Link to="/analytics/local">
                                <Button type="text" icon={<BarChart3 className="size-4" />}>
                                    {t("localAnalytics.title")}
                                </Button>
                            </Link>
                            <Link to="/diagnostics/mcp">
                                <Button type="text" icon={<Activity className="size-4" />}>
                                    MCP 诊断
                                </Button>
                            </Link>
                        </>
                    }
                />
                <div className="mt-6">
                    <AppConfigPanel />
                </div>
            </div>
        </main>
    );
}
