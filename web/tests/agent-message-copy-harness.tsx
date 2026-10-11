import React from "react";
import { App, ConfigProvider, theme } from "antd";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import i18n from "../src/i18n";
import { AgentChatMessage, type AgentChatMessageItem } from "../src/components/agent/agent-chat-message";
import { canvasThemes } from "../src/lib/canvas-theme";
import "../src/styles/globals.css";

declare global {
  interface Window { __agentCopiedText?: string }
}

const clipboardBlocked = new URLSearchParams(window.location.search).has("blocked");
if (clipboardBlocked) Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });

// Exercise clipboard behavior without touching the system clipboard.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      if (clipboardBlocked) throw new Error("Simulated clipboard denial");
      window.__agentCopiedText = text;
      const output = document.querySelector<HTMLOutputElement>("[data-testid='copy-result']");
      if (output) output.value = text;
    },
  },
});

const item: AgentChatMessageItem = {
  id: "copy-fixture",
  role: "assistant",
  text: [
    "导演回复复制测试。",
    "",
    "| 问题 | 原因与处理结果 |",
    "|---|---|",
    "| 开头铺垫过长 | 缩短开场，把主要篇幅放在角色行为与结果上。 |",
  ].join("\n"),
};

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <App>
        <main className="p-8">
          <AgentChatMessage item={item} theme={canvasThemes.dark} />
          <output data-testid="copy-result" className="sr-only" />
        </main>
      </App>
    </ConfigProvider>
  </I18nextProvider>,
);
