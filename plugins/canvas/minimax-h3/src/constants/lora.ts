/**
 * NanFengH3MultiReferenceGeneratorV15 的「LoRA{N}强度」合法范围。
 * 与 backend/src/canvas/h3-params.ts 的 H3_LORA_STRENGTH_MIN/MAX 保持一致，
 * 来源同为 GET /object_info/NanFengH3MultiReferenceGeneratorV15 的 FLOAT min/max。
 * UI 与后端各留一份常量：前端不能 import backend，且两边都要独立兜底。
 */
export const H3_LORA_STRENGTH_MIN = -4;
export const H3_LORA_STRENGTH_MAX = 4;
