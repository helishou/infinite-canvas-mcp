import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * React 要求每次渲染的 hook 序列完全一致。DramaManagePanel 在 folder 尚未加载时会
 * 提前返回；任何写在提前返回之后的 hook 都会在「folder=null → folder 有值」时多出一个，
 * 触发 "Rendered more hooks than during the previous render."。这里做静态守卫。
 */
const source = readFileSync(new URL("./manage-panel.tsx", import.meta.url), "utf8");
const lines = source.split(/\r?\n/);
const earlyReturn = lines.findIndex((line) => /^\s*if\s*\(!folder\)\s*return\b/.test(line));

test("DramaManagePanel 保留 folder 未加载时的提前返回", () => {
    assert.ok(earlyReturn >= 0, "未找到 `if (!folder) return ...` 守卫，请同步更新本测试");
});

test("DramaManagePanel 提前返回之后不得调用任何 hook", () => {
    assert.ok(earlyReturn >= 0);
    const after = lines.slice(earlyReturn + 1).join("\n");
    const hooks = [
        "useState", "useEffect", "useMemo", "useCallback", "useRef", "useContext",
        "useLayoutEffect", "useImperativeHandle", "useReducer", "useId", "useTransition",
        "useDeferredValue", "useSyncExternalStore", "useActionState", "useOptimistic",
        "useApp", "useTranslation", "useNavigate", "useLocation", "useWorkbenchCanvas",
        "useCanvasStore", "useConfigStore", "useProductionFollowStore",
    ];
    for (const hook of hooks) {
        assert.doesNotMatch(after, new RegExp(`\\b${hook}\\s*\\(`), `提前返回之后出现 hook: ${hook}`);
    }
});
