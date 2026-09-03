import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";

export type AppLocale = "zh-CN" | "en-US";

i18n.use(initReactI18next).init({
    resources: {
        "zh-CN": { translation: zhCN },
        "en-US": { translation: enUS },
    },
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export function changeAppLocale(locale: AppLocale) {
    void i18n.changeLanguage(locale);
    void import("@/services/settings-api").then(({ saveSettings }) => saveSettings({ locale }));
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => {
        void import("@/services/settings-api").then(async ({ fetchSettings }) => {
            const settings = await fetchSettings();
            if (settings.locale) await i18n.changeLanguage(settings.locale);
        });
    });
}

export default i18n;
