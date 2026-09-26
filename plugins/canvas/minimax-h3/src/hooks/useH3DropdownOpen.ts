import { useCallback, useEffect, useRef, useState } from "react";

/**
 * antd 下拉（Select / AutoComplete）只在 window 的 `mousedown` 上收起。
 * 画布空白处的 pointerdown 会 `preventDefault()`（InfiniteCanvas.handlePointerDown），
 * 浏览器因此不再派发兼容的 mousedown —— 在画布空白处点一下，下拉就永远挂着不收。
 *
 * 这里自己接管 open：antd 仍然照常报告开关状态（点击、输入、失焦都照旧），
 * 另外用 pointerdown 捕获兜底收起，这样画布内外的关闭行为一致。
 */
export function useH3DropdownOpen() {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (rootRef.current?.contains(target)) return;
            if (target.closest(".ant-select-dropdown")) return;
            setOpen(false);
        };
        window.addEventListener("pointerdown", onPointerDown, true);
        return () => window.removeEventListener("pointerdown", onPointerDown, true);
    }, [open]);

    const onOpenChange = useCallback((next: boolean) => setOpen(Boolean(next)), []);
    return { open, onOpenChange, rootRef };
}
