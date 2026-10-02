import { buildNativeNanFengV15Workflow } from "../src/comfyui/bridge.js";

const upload = async () => "uploaded.png";
const graph = await buildNativeNanFengV15Workflow(
    { prompt: "@图片1", references: ["reference.png"] },
    { mode: "ref2va", seed: 123, targetNodeId: "h3-node-42", taeh3Enabled: true },
    upload as any,
    "http://comfy.local",
    new AbortController().signal,
);
const types = Object.entries(graph as Record<string, any>).map(([id, n]) => `${id}=${n.class_type}`);
console.log(types.join("\n"));
