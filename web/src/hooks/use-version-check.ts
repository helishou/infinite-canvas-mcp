import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

const latestVersionUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION";
const latestChangelogUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md";
const skippedVersionKey = "infinite-canvas:skipped-version";

function normalizeVersion(version: string) {
    return version.trim().replace(/^v/i, "");
}

function readSkippedVersion() {
    try {
        return localStorage.getItem(skippedVersionKey) || "";
    } catch {
        return "";
    }
}

function broadcastSkippedVersion(value: string | null) {
    try {
        if (typeof StorageEvent !== "undefined") {
            window.dispatchEvent(new StorageEvent("storage", { key: skippedVersionKey, newValue: value }));
        }
    } catch {
        // 隐私模式下存储/事件可能不可用，忽略即可
    }
}

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [skippedVersion, setSkippedVersion] = useState(readSkippedVersion);
    const hasNewVersion = isNewerVersion(latestVersion, currentVersion) && normalizeVersion(skippedVersion) !== normalizeVersion(latestVersion);

    const skipThisVersion = useCallback((version: string) => {
        const value = version.trim();
        try {
            localStorage.setItem(skippedVersionKey, value);
        } catch {
            // 隐私模式下 localStorage 可能抛错，仍保留本次会话内的跳过状态
        }
        setSkippedVersion(value);
        broadcastSkippedVersion(value);
    }, []);

    const clearSkippedVersion = useCallback(() => {
        try {
            localStorage.removeItem(skippedVersionKey);
        } catch {
            // 同上，忽略存储异常
        }
        setSkippedVersion("");
        broadcastSkippedVersion(null);
    }, []);

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== skippedVersionKey) return;
            setSkippedVersion(event.newValue || "");
        };
        window.addEventListener("storage", handleStorage);
        return () => window.removeEventListener("storage", handleStorage);
    }, []);

    const checkLatestVersion = useCallback(async () => {
        try {
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            setLatestVersion(version.trim() || currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl)]);
                if (!versionResponse.ok) throw new Error(t("version.readFailed"));
                if (!changelogResponse.ok) throw new Error(t("version.changelogFailed"));
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(version.trim() || currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                clearSkippedVersion();
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [clearSkippedVersion, currentVersion, localReleases, message, t],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        clearSkippedVersion();
        void checkLatestRelease();
    }, [checkLatestRelease, clearSkippedVersion]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
        skipThisVersion,
        clearSkippedVersion,
    };
}
