// Agent 对话 markdown 渲染入口。streamdown 会连带引入 mermaid（产物 JS 4MB+、CSS 300KB+），
// 是制作台首屏最大的一块浪费，因此把 streamdown 与它的样式收进这个按需加载模块：
// 只有真正渲染对话消息时才拉取，首屏（含 Agent 面板未展开时）不再请求 mermaid。
import "streamdown/styles.css";
import { extractTableDataFromElement, Streamdown, tableDataToMarkdown, type StreamdownProps } from "streamdown";

export type { LinkSafetyModalProps, StreamdownProps } from "streamdown";

/** 按需加载的 Streamdown 包装，props 原样透传，保持原有渲染与交互。 */
export function AgentStreamdown(props: StreamdownProps) {
    return <Streamdown {...props} />;
}

/** 表格「复制」按钮用：把已渲染的 <table> 还原成 markdown 文本。 */
export function tableElementToMarkdown(table: HTMLTableElement) {
    return tableDataToMarkdown(extractTableDataFromElement(table));
}
