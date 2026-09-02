# H3 插件书写规范（与 web/ 主项目前端统一）

> 主项目（`web/src`）技术栈基线：React 19.2 + antd 6.4 + lucide-react 图标 + tailwind v4 +
> zustand/i18next + prettier({tabWidth:4, printWidth:255, semi, trailingComma:"all", endOfLine:"lf"})。
> 插件（本目录）是独立 esbuild 包，但书写方式向主项目看齐；拿不准时以 `web/src` 现有代码为准。

## 1. React 来源（铁律）

- **hooks 一律从 `@infinite-canvas/plugin-sdk` 导入**：`import { useState, useEffect, ... } from "@infinite-canvas/plugin-sdk";`
  SDK 转发宿主单例 React，插件运行时绝**不打包第二份 React**（`external: ["react","react-dom"]`）。
- React **类型**（`KeyboardEvent`、`CSSProperties`、`ReactNode`…）允许 `import type` from `"react"`——
  类型只在编译期存在；但插件 tsconfig 设了 `"types": []`，**纯值导入 `react` 会炸**（宿主加载器先 import 插件）。
- 不用 `React.` 全限定名（jsx:react-jsx + 上述两种导入已覆盖）。

## 2. 导入与文件组织

- 导入顺序（与 main 项目一致）：SDK/第三方 → 相对模块类型 → 相对模块值。每组合间空一行。
- 目录职责：
  - `components/` 渲染与事件；不写业务落库逻辑（交给 services）。
  - `services/` 纯逻辑（引用解析、分段归一、日志、模型发现）——**模块顶层不打闭包状态**，可测试。
  - `hooks/` React 副作用（事件订阅、轮询、useMemo 派生）。
  - `constants/` 选项表、默认值；`types.ts` 单一类型出口。
- **函数命名 kebab-case**（与 web 一致）：`segmentsFor`、`refsForSegment`、`patchSelectedSegment`。
  （现存的 `useH3Segments/useH3TaskPolling/useH3RunEvents` 是旧驼峰，改动该文件时顺手统一。）
- 组件文件名沿用现有 `H3*` 前缀（`H3PromptSection.tsx`），导出函数名与文件名一致。

## 3. UI 组件

- UI 控件优先 **antd 组件**（Button/Select/Switch/Tooltip/Modal…），版本跟随主项目当前 `antd` major（现为 6.x；
  插件 package.json 的 antd 版本要能被 esbuild 解到 —— 构建报 `Could not resolve "antd"` 就 `npm i` 装上再 build）。
- 图标：**优先复用主项目 icon 集**（`lucide-react` 同名图标直接 import，与 web 视觉一致 ——
  Play/Plus/Download/Settings/Image/Video/Volume/SideBar…）；插件内私有图形才留在 `H3Icon`，
  且 `H3Icon` 的 SVG path 与 lucide 规格对齐（24 viewBox / stroke 1.8 / round）。
- 样式：
  - 布局用 `className` + `src/styles/h3.css`（BEM 风格 `minimax-*`），**少用 inline style**；
    动态值（百分比宽度等）才允许 `style`。
  - CSS 里颜色尽量引用既有变量族（`#202124` 面板 / `#2f3338` 边 / `#f8fafc` 主文字…），不新增随机色。
  - 暗色主题由宿主变量驱动，不在插件里硬编码白底。
- 弹层/下拉：插件包内用 `position:absolute` 定位在容器内（参考 `minimax-prompt-mentions`）；
  需要覆盖全屏时才考虑 portal（SDK 未导出 `createPortal` 前保持容器内定位）。

## 4. 语言与注释

- 用户可见文案：**中文**（主项目 zh-CN 优先）；技术注释中英均可，代码标识符英文。
- 常量/关键逻辑写「为什么」的一行注释，不复述代码。

## 5. 构建与验证（Windows/bun 环境）

- `npm i` → `npm run typecheck`（tsc --noEmit）→ `node build.mjs`（esbuild，产物同步 `web/public/plugins/`）。
- 产物验证用 `grep -F "目标串" dist/minimax-h3.js`，**不要 `require()` 插件产物**（是 ES module）。
- 新增依赖必须写进 `package.json`（dependencies 会打进 bundle；devDependencies 只在本地解析）。
- 浏览器验证太烧 token：代码层 typecheck + 产物 grep 优先，最后让用户刷新画布人工点一遍。

## 6. 与主项目共享契约（勿漂移）

- `ctx.ai.runLocalH3 / runRunningHubH3` 参数与 `canvas-agent/src/ai/h3.ts` 保持同步（改 prompt 提交口径前先对 agent 侧）。
- `H3Ref.url` 语义 = 相对 ComfyUI `input/` 的媒体文件名（见 canvas-agent `h3.ts` refs 解析注释）；
  插件内渲染 `<img src>` 需要可访问 URL 时，优先素材库已解析好的 `H3Ref.url`（工作台已给绝对/相对 URL 则直接用），
  不要自行拼 `/api/...`。
- metadata 字段命名沿用 `minimax*` 前缀（历史兼容），新增字段同样前缀。
