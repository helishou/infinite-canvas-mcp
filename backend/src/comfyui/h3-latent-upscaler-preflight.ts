/** Check V15 latent-upscale dependencies before starting the expensive first pass. */
export async function assertH3LatentUpscalerReady(
  comfyUrl: string,
  modelName: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const base = comfyUrl.replace(/\/$/, "");
  const upstreamName = "H3LatentUpscalerNodeMegapixels";
  const upstream = await fetcher(`${base}/object_info/${upstreamName}`, { signal });
  const upstreamInfo = upstream.ok ? await upstream.json() as Record<string, unknown> : {};
  if (!upstreamInfo[upstreamName]) {
    throw new Error(`H3 潜空间二采缺少 ${upstreamName} 兼容节点；请安装并重启 ComfyUI，或关闭潜空间二采。未提交一采任务。`);
  }

  const wrapperName = "NanFengH3LowPeakLatentUpscalerV15";
  const wrapper = await fetcher(`${base}/object_info/${wrapperName}`, { signal });
  const wrapperInfo = wrapper.ok ? await wrapper.json() as Record<string, any> : {};
  const choices = wrapperInfo[wrapperName]?.input?.required?.model_name?.[0];
  if (!Array.isArray(choices) || !choices.map(String).includes(modelName)) {
    throw new Error(`H3 潜空间二采模型「${modelName}」未在 ${wrapperName} 的可用模型中；请检查兼容节点和模型目录后再提交。未提交一采任务。`);
  }
}
