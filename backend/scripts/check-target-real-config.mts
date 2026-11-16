/** 用真实的 ai.config 复现：comfyui 渠道模型是否被判定为引擎目标。 */
import fs from "node:fs";

import { findComfyuiEngineTarget, findEngineChannel } from "../src/canvas/engine-channel.js";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const selected of ["local-comfyui::2.1", "2.1", "engine-local::2.1"]) {
    console.log(selected, "→", JSON.stringify(findEngineChannel(raw, selected)), "|", JSON.stringify(findComfyuiEngineTarget(raw, selected)));
}
