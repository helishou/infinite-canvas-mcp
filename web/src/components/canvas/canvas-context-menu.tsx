import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BetweenHorizontalStart, ClipboardCopy, GalleryHorizontalEnd, GalleryHorizontal, Group, Images, Languages, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "@/types/canvas";
import type { VideoFramePosition } from "@/lib/canvas/canvas-video-frame";

export function CanvasNodeContextMenu({
    menu,
    canDelete = true,
    canCaptureVideoFrame,
    canGroup,
    canCopyContent,
    canTranslate,
    isExtractingKeyframes,
    onClose,
    onCaptureVideoFrame,
    onExtractVideoKeyframes,
    onGroup,
    onCopyContent,
    onTranslate,

    onDuplicate,
    onDelete,
}: {
    menu: ContextMenuState;
    canDelete?: boolean;
    canCaptureVideoFrame: boolean;
    canGroup: boolean;
    canCopyContent: boolean;
    canTranslate: boolean;
    isExtractingKeyframes?: boolean;

    onClose: () => void;
    onCaptureVideoFrame: (position: VideoFramePosition) => void;
    onExtractVideoKeyframes?: () => void;
    onGroup: () => void;
    onCopyContent: () => void;
    onTranslate: (target: "zh-CN" | "en") => void;

    onDuplicate: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ left: menu.x, top: menu.y });

    useLayoutEffect(() => {
        const place = () => {
            const rect = menuRef.current?.getBoundingClientRect();
            if (!rect) return;
            setPosition({ left: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)) });
        };
        place();
        menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        window.addEventListener("resize", place);
        return () => window.removeEventListener("resize", place);
    }, [menu.x, menu.y, menu.type, canDelete, canCaptureVideoFrame, canCopyContent, canTranslate, canGroup, isExtractingKeyframes, t]);

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            role="menu"
            aria-label={t("canvas.nodeActions.all")}
            data-canvas-shortcuts-ignore
            className="fixed z-[80] min-w-44 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border py-1 shadow-2xl"
            style={{ ...position, maxHeight: "calc(100dvh - 16px)", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
            }}
        >
            {canCopyContent ? <MenuSection label={t("canvas.nodeActions.groups.inspect")}>
                <MenuButton icon={<ClipboardCopy className="size-4" />} label={t("canvas.controls.copyContent")} onClick={onCopyContent} />
            </MenuSection> : null}
            {canCaptureVideoFrame || canTranslate ? <MenuSection label={t("canvas.nodeActions.groups.generate")}>
                {canCaptureVideoFrame ? <>
                    <MenuButton icon={<BetweenHorizontalStart className="size-4" />} label={t("canvas.videoFrames.first")} onClick={() => onCaptureVideoFrame("first")} />
                    <MenuButton icon={<GalleryHorizontalEnd className="size-4" />} label={t("canvas.videoFrames.last")} onClick={() => onCaptureVideoFrame("last")} />
                    <MenuButton icon={<GalleryHorizontal className="size-4" />} label={t("canvas.videoFrames.current")} onClick={() => onCaptureVideoFrame("current")} />
                    <MenuButton icon={<Images className="size-4" />} label={isExtractingKeyframes ? t("canvas.videoFrames.extracting") : t("canvas.videoFrames.allShots")} onClick={onExtractVideoKeyframes} disabled={isExtractingKeyframes} />
                </> : null}
                {canTranslate ? <>
                    <MenuButton icon={<Languages className="size-4" />} label={t("canvas.nodeActions.translateChinese")} onClick={() => onTranslate("zh-CN")} />
                    <MenuButton icon={<Languages className="size-4" />} label={t("canvas.nodeActions.translateEnglish")} onClick={() => onTranslate("en")} />
                </> : null}
            </MenuSection> : null}
            {canGroup || menu.type === "node" ? <MenuSection label={t("canvas.nodeActions.groups.organize")}>
                {canGroup ? <MenuButton icon={<Group className="size-4" />} label={t("canvas.controls.group")} onClick={onGroup} /> : null}
                {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label={t("canvas.controls.duplicate")} onClick={onDuplicate} /> : null}
            </MenuSection> : null}
            {canDelete ? <MenuSection label={t("canvas.nodeActions.groups.danger")}>
                <MenuButton icon={<Trash2 className="size-4" />} label={t("canvas.controls.delete")} onClick={onDelete} danger />
            </MenuSection> : null}
        </div>
    );
}

function MenuSection({ label, children }: { label: string; children: ReactNode }) {
    return <div role="group" aria-label={label} className="py-1">
        <div className="px-3 pb-1 text-[11px] font-medium opacity-55">{label}</div>
        {children}
    </div>;
}

function MenuButton({ icon, label, onClick, danger = false, disabled = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors enabled:hover:bg-black/5 dark:enabled:hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: danger ? "var(--destructive)" : theme.node.text }}
            onClick={onClick}
            disabled={disabled}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
