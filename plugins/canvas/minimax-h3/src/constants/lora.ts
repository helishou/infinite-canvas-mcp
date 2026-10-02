/**
 * NanFengH3MultiReferenceGeneratorV15 的「LoRA{N}强度」合法范围。
 * 与 backend/src/canvas/h3-params.ts 的 H3_LORA_STRENGTH_MIN/MAX 保持一致，
 * 对应本机 V15 节点源码的 FLOAT min/max；运行中的 ComfyUI 重载后 object_info 才会更新。
 * UI 与后端各留一份常量：前端不能 import backend，且两边都要独立兜底。
 */
export const H3_LORA_STRENGTH_MIN = -4;
export const H3_LORA_STRENGTH_MAX = 10;
