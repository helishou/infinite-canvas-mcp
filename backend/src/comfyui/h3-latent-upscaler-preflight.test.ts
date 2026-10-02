import assert from "node:assert/strict";
import test from "node:test";
import { assertH3LatentUpscalerReady } from "./h3-latent-upscaler-preflight.js";

test("缺少上游兼容节点时在一采提交前拒绝", async () => {
  const urls: string[] = [];
  const fetcher = async (url: string) => { urls.push(url); return Response.json({}); };
  await assert.rejects(() => assertH3LatentUpscalerReady("http://127.0.0.1:8188", "h3_upscaler_lms_v0.1.safetensors", new AbortController().signal, fetcher as typeof fetch), /缺少 H3LatentUpscalerNodeMegapixels/);
  assert.equal(urls.length, 1);
});

test("兼容节点与模型均可用时放行，模型缺失时拒绝", async () => {
  const fetcher = async (url: string) => Response.json(url.endsWith("H3LatentUpscalerNodeMegapixels")
    ? { H3LatentUpscalerNodeMegapixels: { input: {} } }
    : { NanFengH3LowPeakLatentUpscalerV15: { input: { required: { model_name: [["h3_upscaler_lms_v0.1.safetensors"]] } } } });
  const signal = new AbortController().signal;
  await assertH3LatentUpscalerReady("http://127.0.0.1:8188", "h3_upscaler_lms_v0.1.safetensors", signal, fetcher as typeof fetch);
  await assert.rejects(() => assertH3LatentUpscalerReady("http://127.0.0.1:8188", "missing.safetensors", signal, fetcher as typeof fetch), /模型.*未在/);
});
