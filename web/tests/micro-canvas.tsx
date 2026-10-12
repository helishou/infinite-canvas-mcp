import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Select } from "antd";
import { CanvasNodeHoverToolbar } from "../src/components/canvas/canvas-node-hover-toolbar";
import { CanvasNodeContextMenu } from "../src/components/canvas/canvas-context-menu";
import { CanvasImageSettingsPopover } from "../src/components/canvas/canvas-image-settings-popover";
import { getAntThemeConfig } from "../src/lib/app-theme";
import { useThemeStore } from "../src/stores/use-theme-store";
import { defaultConfig } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";
import "../src/i18n";
import "../src/styles/globals.css";
const handlers = ["onKeep","onLeave","onInfo","onDecreaseFont","onIncreaseFont","onToggleDialog","onGenerateImage","onUpload","onDownload","onSaveAsset","onDiscardSharedEdits","onCompareVideo","onTrimVideo","onMaskEdit","onCrop","onSplit","onUpscale","onSuperResolve","onAutoLevels","onAngle","onViewImage","onReversePrompt","onRetry","onConvertToCharacter","onConvertToScene","onConvertToProp","onSaveCharacterToAsset","onSaveSceneToAsset","onToggleFreeResize","onArrangeGroup","onToggleOrderedGroup","onToggleGroupLock","onDelete"];
function Fixture() {
 const theme=useThemeStore(s=>s.theme), setTheme=useThemeStore(s=>s.setTheme);
 const [type,setType]=useState("image"), [receipt,setReceipt]=useState("未操作"),[keys,setKeys]=useState(0),[context,setContext]=useState(false),[active,setActive]=useState(true);
 useEffect(()=>{const h=()=>setKeys(n=>n+1);window.addEventListener("keydown",h);return()=>window.removeEventListener("keydown",h);},[]);
 const node={id:"fixture-node",type,title:`测试 ${type} 对象`,position:{x:30,y:250},width:300,height:180,metadata:{content:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',text:"测试正文",status:"success"}} as CanvasNodeData;
 const callbacks=Object.fromEntries(handlers.map(name=>[name,(target: CanvasNodeData)=>{if(!["onKeep","onLeave"].includes(name))setReceipt(`${name}:${target?.id}`);}])) as unknown as React.ComponentProps<typeof CanvasNodeHoverToolbar>;
 return <ConfigProvider theme={getAntThemeConfig(theme==="dark")}><App><main className={`${theme==="dark"?"dark ":""}relative min-h-screen bg-background p-4 text-foreground`}>
  <p>仅内存工具验收，不运行生成、不上传文件。</p><div className="flex flex-wrap gap-2"><Button onClick={()=>setTheme(theme==="dark"?"light":"dark")}>theme</Button><Select aria-label="节点类型" value={type} onChange={setType} options={["image","text","video","audio","character","scene","prop","group","fixture:plugin"].map(value=>({value,label:value}))}/><Button onClick={()=>setContext(true)}>打开右键菜单</Button></div>
  <output aria-label="fixture receipt">{receipt}</output><p aria-label="background key count">背景按键 {keys}</p>
  <div className="mt-8"><CanvasImageSettingsPopover targetLabel={node.title} config={defaultConfig} onConfigChange={(key,value)=>setReceipt(`${key}:${value}`)}/></div>
  <CanvasNodeHoverToolbar {...callbacks} node={node} viewport={{x:0,y:0,k:1}} extraTools={[{id:"fixture-extension",title:"动态插件工具",label:"动态插件工具",active,onClick:()=>{setActive(!active);setReceipt("extension:fixture-node");}}]}/>
  {context&&<CanvasNodeContextMenu menu={{type:"node",x:330,y:720,nodeId:node.id}} canCaptureVideoFrame canCopyContent canGroup canTranslate onClose={()=>setContext(false)} onCaptureVideoFrame={p=>setReceipt(`frame:${p}`)} onExtractVideoKeyframes={()=>setReceipt("frames")} onGroup={()=>setReceipt("group")} onCopyContent={()=>setReceipt("copy")} onTranslate={l=>setReceipt(`translate:${l}`)} onDuplicate={()=>setReceipt("duplicate")} onDelete={()=>setReceipt("delete")}/>}
 </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
