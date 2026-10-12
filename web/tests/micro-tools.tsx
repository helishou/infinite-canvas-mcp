import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import { RunPanel } from "../src/pages/workflows/run-panel";
import { AgentHistoryView } from "../src/components/agent/agent-history-view";
import { AgentPanelTabs } from "../src/components/agent/agent-panel-tabs";
import { canvasThemes } from "../src/lib/canvas-theme";
import { getAntThemeConfig } from "../src/lib/app-theme";
import type { WorkflowConfig } from "../src/types/workflow";
import i18n from "../src/i18n";
import "../src/styles/globals.css";
const config: WorkflowConfig = {title:"Fixture",backend:"fixture",operation:"fixture",description:"",fields:[
 {id:"prompt",name:"测试正文",node:"1",input:"text",type:"text",default:"原始正文"},
 {id:"image",name:"参考图片",node:"2",input:"image",type:"image"},
 {id:"seed",name:"种子",node:"3",input:"seed",type:"number",default:"42"},
 {id:"choice",name:"枚举",node:"4",input:"choice",type:"dropdown",options:["A","B"],default:"A"},
 {id:"enabled",name:"布尔参数",node:"5",input:"enabled",type:"boolean",default:true},
]};
function Fixture() {
 const [dark,setDark]=useState(false),[tab,setTab]=useState("chat"),[receipt,setReceipt]=useState("未提交"),[running,setRunning]=useState(false);
 const theme=canvasThemes[dark?"dark":"light"];
 return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main className={`${dark?"dark ":""}min-h-screen bg-background p-4 text-foreground`}>
  <p>仅内存 UI 验收，不调用生成与会话 API。不要上传文件。</p>
  <div className="flex gap-2"><Button onClick={()=>setDark(!dark)}>theme</Button><Button onClick={()=>void i18n.changeLanguage(i18n.language==="zh-CN"?"en-US":"zh-CN")}>language</Button></div>
  <h1>工作流字段分组</h1><RunPanel config={config} onRun={fields=>{setReceipt(JSON.stringify(fields));setRunning(true);}} running={running} result={null} onCancel={()=>setRunning(false)} />
  <output aria-label="fixture receipt">{receipt}</output>
  <h2>Agent 内容切换与会话管理</h2><AgentPanelTabs theme={theme} value={tab} onChange={setTab} items={[{value:"chat",label:"对话"},{value:"history",label:"会话历史"},{value:"skills",label:"技能"},{value:"logs",label:"运行日志"}]} />
  <AgentHistoryView theme={theme} threads={[{id:"one",name:"测试会话一",preview:"单项恢复与批量选择",updatedAt:1},{id:"two",name:"测试会话二",updatedAt:2}]} activeThreadId="one" workspacePath="fixture" loading={false} busy={false} connected={true} legacyHistory={false} onLegacyHistoryChange={()=>{}} onRefresh={()=>setReceipt("refresh")} onNewThread={()=>setReceipt("new")} onResumeThread={id=>setReceipt(`resume:${id}`)} onDeleteThreads={ids=>setReceipt(`delete:${ids.join(",")}`)} />
 </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
