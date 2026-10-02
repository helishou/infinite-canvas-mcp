# Web 开发约定

继承[根约定](../AGENTS.md)。涉及画布数据读写先读[数据契约](../.agents/rules/canvas-contracts.md)；涉及画布外观、坐标、视口或拖拽先读[交互约束](../.agents/rules/canvas-ui.md)。

## 目录与复用

- 使用当前 Vite、React、React Router、TypeScript、Ant Design、Tailwind、Zustand 栈，不为局部功能引入另一套框架。
- 页面 `src/pages/<业务>/index.tsx`，布局 `src/layouts/`，路由 `src/router.tsx`。页面私有组件和 hooks 留在页面目录，真实跨页面复用后再提升。
- 画布入口 `src/pages/canvas/`，组件 `src/components/canvas/`，Store `src/stores/canvas/`，工具 `src/lib/canvas/`。
- 一个主业务组件直接写在页面入口，不另建只转发 props 的 Manager/包装组件；复杂且内聚的逻辑可拆同目录 hook 或工具。
- 全局状态与动作从既有 Store/hook 获取，不层层传递全局配置、组件或十几个 props。复制提示、下载提示、统一确认等可复用 UI 副作用放 hooks，只有共享状态才进 Store。

## 请求与持久化

- 复用 `src/services/`：功能/模型 API 在 `services/api/`，Backend 数据与设置沿用 `backend-api.ts`、`settings-api.ts` 等入口。组件不重新实现鉴权、地址解析、重试和序列化。
- 画布生成提交 Backend 服务；浏览器渠道也先建权威任务再认领，不能恢复组件模型直连与本地回填。独立图片/视频页面已有渠道调用不在局部任务里擅自迁移。
- 大缓存用现有 localforage；localStorage 仅保存极小视图/连接配置，不放媒体、base64、业务列表或生成记录。outbox/冲突草稿保护见数据契约。
- Backend 能力不依赖 Agent 对话面板的 SSE connected 状态。视频拼接等使用 `resolveBackendAgentEndpoint()`，Comfy 能力使用既有解析器；核对路由是否带 `/agent`，不凭相似名称互换端点。
- 改草稿恢复、页面懒加载或测试入口时，核对会话认领与 Store 导入顺序，覆盖复制标签页场景。

## 样式与文案

- 应用主题和弹层颜色在 `src/lib/app-theme.ts`、AppProviders 或必要的全局 CSS 作用域集中配置。Dropdown/Menu/Select 等用全局 token，业务组件不各自写深浅色分支。
- 组件私有样式用 Tailwind 或少量内联样式；全局 CSS 只承载基础变量、重置、共享样式和必要的第三方覆盖。
- 沿用当前 antd 版本和组件用法。新 API 或不明确行为才查对应官方文档，不每次通读整站。
- 图标使用 lucide-react 或已有 Ant Design 图标。
- 宿主文案复用 i18next/react-i18next key，同时维护 `src/i18n/locales/zh-CN.ts`、`en-US.ts`；默认与回退语言中文。用户提示词、对白、资产名保持原文。

## React 与交互

- 用户操作触发的播放、提交、跳转使用显式事件或本地 trigger。effect 路径须能承受 StrictMode 的重复 setup/cleanup；不要用“首次跳过”的 ref 配合 metadata 残留值充当授权。
- 避免测量元素的尺寸再修改同一个尺寸形成 ResizeObserver 反馈循环；依赖关系以真实消费者为依据，不滥加 memo 或全局状态。
- Select/InputNumber 的显示、默认值、清空与提交语义必须一致；输入可清空时不能立即用默认值填回。滚动问题先核对所属容器，不能为普通页面改坏画布的 overflow 行为。

## 验证

遵循根目录验证矩阵。页面变更核对相关语言、主题和交互；涉及 Portal 或高频渲染时在弹层打开状态复现。视口改动按交互约束验证覆盖范围、缩放锚点和低倍率。

Vite dev 走 HMR；静态页面消费 `web/dist` 时重建 Web。`scripts/test.mjs` 会枚举整个 workspace 的测试，不能把 `npm test -- 文件名` 当成只跑该文件；精确测试调用见[运行与验证](../.agents/skills/canvas-h3-implementation/references/development-verification.md)。
