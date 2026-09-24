import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import { Button } from "antd";
import { Link } from "react-router-dom";

import { AppConfigPanel } from "@/components/layout/app-config-modal";

export default function ConfigPage() {
    const { t } = useTranslation();

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("config.title")}</h1>
                        <p className="mt-1 text-sm text-stone-500">{t("config.description")}</p>
                    </div>
                    <Link to="/diagnostics/mcp">
                        <Button type="text" icon={<Activity className="size-4" />}>
                            MCP 诊断
                        </Button>
                    </Link>
                </div>
                <AppConfigPanel />
            </div>
        </main>
    );
}
