import { initializeCanvasDraftSession } from "@/lib/canvas/canvas-draft-session";

void initializeCanvasDraftSession().then(() => import("./bootstrap")).catch((error) => {
    const root = document.getElementById("root");
    if (root) root.textContent = `画布会话初始化失败，未提交任何草稿：${error instanceof Error ? error.message : String(error)}。请刷新重试。`;
});
