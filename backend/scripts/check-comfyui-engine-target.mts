/** 直接验证 findComfyuiEngineTarget 对 comfyui 渠道模型是否给出引擎目标。 */
import { findComfyuiEngineTarget, findEngineChannel } from "../src/canvas/engine-channel.js";

const config = {
    channels: [
        { id: "local-comfyui", kind: "comfyui", apiFormat: "openai", baseUrl: "http://127.0.0.1:8188", apiKey: "", models: [{ name: "2.1" }, { name: "krea2" }] },
        { id: "engine-local", kind: "local", apiFormat: "openai", baseUrl: "http://127.0.0.1:8300", apiKey: "", models: [{ name: "2.1" }] },
    ],
};

for (const selected of ["local-comfyui::2.1", "2.1", "engine-local::2.1"]) {
    console.log(selected, "→ engine:", JSON.stringify(findEngineChannel(config, selected)),
        "| comfyui→engine:", JSON.stringify(findComfyuiEngineTarget(config, selected)));
}
