import { App } from "antd";
import copy from "copy-to-clipboard";
import { useTranslation } from "react-i18next";

export function useCopyText() {
    const { message } = App.useApp();
    const { t } = useTranslation();

    return async (value: string, successText = t("common.copied")) => {
        try {
            if (await copy(value)) {
                message.success(successText);
                return true;
            }
        } catch {
            // The clipboard may be unavailable or denied; report the failure below.
        }
        message.warning(t("common.copyFailed"));
        return false;
    };
}
