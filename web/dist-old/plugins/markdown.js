function k(){let e=globalThis.InfiniteCanvasRuntime;if(!e)throw new Error("[plugin-sdk] Infinite Canvas \u8FD0\u884C\u65F6\u672A\u5C31\u7EEA:\u8BF7\u5728\u753B\u5E03\u5BBF\u4E3B\u4E2D\u52A0\u8F7D\u672C\u63D2\u4EF6");return e}function r(){return k().React}var p=((...e)=>r().useState(...e)),d=((...e)=>r().useEffect(...e));var l=((...e)=>r().useRef(...e));var m=((...e)=>r().useSyncExternalStore(...e));var w=`.cnv-md {\r
    height: 100%;\r
    width: 100%;\r
    overflow: auto;\r
    padding: 16px;\r
    font-size: 14px;\r
    line-height: 1.6;\r
}\r
.cnv-md h1,\r
.cnv-md h2,\r
.cnv-md h3 {\r
    margin: 0.6em 0 0.3em;\r
    font-weight: 600;\r
    line-height: 1.3;\r
}\r
.cnv-md h1 {\r
    font-size: 1.5em;\r
}\r
.cnv-md h2 {\r
    font-size: 1.3em;\r
}\r
.cnv-md p {\r
    margin: 0.5em 0;\r
}\r
.cnv-md a {\r
    color: #6366f1;\r
    text-decoration: underline;\r
}\r
.cnv-md code {\r
    padding: 0.1em 0.35em;\r
    border-radius: 4px;\r
    background: rgba(120, 120, 120, 0.16);\r
    font-family: monospace;\r
    font-size: 0.9em;\r
}\r
.cnv-md pre {\r
    padding: 12px;\r
    border-radius: 8px;\r
    background: rgba(120, 120, 120, 0.14);\r
    overflow: auto;\r
}\r
.cnv-md pre code {\r
    padding: 0;\r
    background: transparent;\r
}\r
.cnv-md ul,\r
.cnv-md ol {\r
    padding-left: 1.4em;\r
    margin: 0.5em 0;\r
}\r
.cnv-md blockquote {\r
    margin: 0.5em 0;\r
    padding-left: 0.8em;\r
    border-left: 3px solid rgba(120, 120, 120, 0.4);\r
    opacity: 0.85;\r
}\r
.cnv-md img {\r
    max-width: 100%;\r
}\r
`;var E=Symbol.for("infinite-canvas.jsx.fragment");function h(e,n,t,c=!1){let s=r(),a=e===E?s.Fragment:e;if(c&&Array.isArray(n?.children)){let{children:f,...R}=n,v=t===void 0?R:{...R,key:t};return s.createElement(a,v,...f)}let o=t===void 0?n:{...n??{},key:t};return s.createElement(a,o)}function u(e,n,t){return h(e,n,t)}var i,g;function b(){return i?Promise.resolve(i):(g||(g=import("https://esm.sh/marked@14").then(e=>i=e.marked)),g)}var P="*\u9009\u4E2D\u8282\u70B9,\u70B9\u4E0A\u65B9\u5DE5\u5177\u6761\u7684 \u270E \u7F16\u8F91 Markdown*",y=new Map;function S(e){if(!i)return"";let n=e||P,t=y.get(n);return t===void 0&&(t=i.parse(n),y.set(n,t)),t}function M({ctx:e}){let[,n]=p(0),t=l(null),c=l(null);d(()=>{if(i)return;let o=!0;return b().then(()=>o&&n(f=>f+1)),()=>{o=!1}},[]);let s=e.node.metadata?.content||"",a=S(s);return d(()=>{let o=t.current;!o||c.current===a||(o.innerHTML=a,c.current=a)},[a]),u("div",{ref:t,className:"cnv-md","data-canvas-no-zoom":!0,onWheel:o=>o.stopPropagation(),style:{height:"100%",width:"100%",color:e.theme.node.text}})}function I({ctx:e}){let n=e.TextEditor;return u(n,{projectId:e.projectId,target:{nodeId:e.node.id,field:"content"},autoFocus:!0,placeholder:"# \u8F93\u5165 Markdown",onEscape:()=>e.view.update({editing:!1}),style:{height:"100%",width:"100%",background:e.theme.node.fill,borderRadius:16,boxSizing:"border-box",padding:16,fontFamily:"monospace",fontSize:14,color:e.theme.node.text}})}function A({ctx:e}){return m(e.view.subscribe,()=>!!e.view.getSnapshot().editing)?u(I,{ctx:e}):u(M,{ctx:e})}var L=e=>!!e.view.getSnapshot().editing,U={id:"markdown",name:"Markdown \u8282\u70B9",version:"1.1.0",description:"\u5728\u753B\u5E03\u4E2D\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",css:w,nodes:[{type:"markdown:doc",title:"Markdown",icon:"\u{1F4DD}",description:"\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",defaultSize:{width:360,height:300},defaultMetadata:{content:""},minimapColor:"#6366f1",hidePanel:!0,interactionToggle:!0,forceInteractive:(e,n)=>!!n.editing,resource:e=>({kind:"text",text:e.metadata?.content}),Content:A,toolbar:e=>{let n=L(e);return[{id:"md-toggle-edit",title:n?"\u9884\u89C8\u6E32\u67D3\u7ED3\u679C":"\u7F16\u8F91 Markdown \u6E90\u7801",label:n?"\u9884\u89C8":"\u7F16\u8F91",icon:n?"\u{1F441}":"\u270E",active:n,onClick:()=>e.view.update({editing:!n})}]}}]};export{U as default};
