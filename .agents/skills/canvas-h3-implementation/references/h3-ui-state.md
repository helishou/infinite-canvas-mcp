# H3 UI 定位与验收

触发：H3 控件、布局、播放、参考编辑、结果恢复。必须先遵守[交互约束](../../../rules/canvas-ui.md)与[数据契约](../../../rules/canvas-contracts.md)，本页不复制尺寸与协议规则。

## 按症状定位

| 症状 | 优先入口 | 要核对的事实 |
|---|---|---|
| 分区拖动、节点高度、CSS 覆盖 | H3Workbench、H3WorkbenchPrimitives、h3.css | 当前拖动基线、求解结果、最终生效 CSS、相邻不变量 |
| 时间轴、滚动条、seek、预览 | H3Timeline、H3WorkbenchPrimitives、useH3LocalView | 屏幕/布局比例、真实滚动偏移、用户 trigger、反馈回路 |
| Select/InputNumber 裁切或默认值漂移 | ClipSettings、H3ClipSettingsPanel | 可见文本样式、清空语义、存储值、最终参数 |
| 运行/取消无反应或刷新后假完成 | H3Runner、useH3RunEvents、Backend h3-runner | flush、任务创建/绑定、父子 taskId 与 Backend 状态 |
| 默认布局恢复不一致 | h3-defaults、宿主 h3Defaults、共享 node-factory | Backend settings.layout、内存镜像、布局兜底 |
| 参考、智能分镜或 Output 串内容 | H3ReferenceModal、H3PromptSection、h3-storyboard-track、Backend ops | 稳定 Clip/绑定 ID、目标字段、日志与实际恢复动作 |

组件在 `plugins/canvas/minimax-h3/src/`；宿主在 `web/src/pages/canvas/hooks/use-plugin-host.tsx`；共享节点工厂在 `canvas-agent/src/plugins/minimax-h3/node-factory.ts`。符号重命名时从真实消费者定位，不照旧行号修改。

## 修改方法

- 拖拽同时查看输入手柄、布局求解和读取端；测试连续拖动、超出空间后拉回，不能只改一个 clamp。
- 修改 CSS 先检查重复声明和响应式覆盖。不要因为文件有多个同名选择器就全部强行设成同值。
- ResizeObserver 测量的对象不要由本轮回写变量决定自身尺寸。播放 timeupdate 和 seek 要区分来源，避免 effect 互相反馈。
- 回调引用是否需要稳定取决于实际 effect/订阅，不把所有函数统一包 useCallback。
- H3 运行在 flush 后提交 Backend；单段和多段取消都走同一权威任务入口。面板打开不自动清任务 error，也不从日志猜结果。
- 默认参数与 layout 可一起存 Backend；模型参数读取要剥离 layout。参数导入不能连带覆盖 prompt/duration。
- “恢复参数”“恢复提示词”“恢复输出”分别核对；选择历史 Output 不意味着用户允许改写当前 Clip 的剧情。
- 智能分镜创意不双向绑定通用生成 prompt；分镜生成不要无意跳选第一段。选定模型应真实传入生成调用。
- 浏览器 UI 展示和工程静态检查不能代替视频质量验收，制作任务按生产 SOP。

## 验证

使用独立页面，记录操作前后目标字段与分区尺寸，检查深浅主题、常用及低倍率、刷新恢复、重复事件。实际页面方法见[页面验证](live-page-verification.md)；源码正确但界面不变先查[加载路径](development-verification.md)。
