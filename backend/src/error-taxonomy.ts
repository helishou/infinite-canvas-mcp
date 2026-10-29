/**
 * 失败语义分级（P7a）。
 *
 * 解决的问题：MCP 的 `error` 过去只有一句自由文本。调用方读到
 * 「spawn ffprobe ENOENT」这类环境故障时无法与「内容不合规」区分，
 * 只能按训练惯性去改提示词、重提生成 —— 2026-10-28 那次快闪 PV 因此
 * 白跑了 5 轮。
 *
 * 本模块只做一件事：把一个错误（code + message）判定成
 * `scope`（谁的问题）、`doNotRetry`（原样重提是否有意义）、`fix`（怎么修）。
 * 不重试、不改业务、不留状态，纯函数，工具层与任务回执层共用同一张表。
 */

export type ErrorScope = "environment" | "input" | "conflict" | "transient" | "content";

export type ErrorFix = {
  /** 一句话处置建议（面向调用方，不含内部实现细节）。 */
  summary: string;
  /** 可直接调用的恢复入口（可选）。 */
  tool?: string;
  input?: Record<string, unknown>;
  /** 需要改配置时给出配置文件名与键名。 */
  file?: string;
  key?: string;
};

export type ErrorDisposition = {
  code: string;
  scope: ErrorScope;
  /** true = 原样重提不会改变结果；false = 允许沿原身份恢复或定向回读后重来。 */
  doNotRetry: boolean;
  fix?: ErrorFix;
};

/** scope → 是否禁止原样重提。与 P7 方案 4.2 表一致。 */
const SCOPE_DO_NOT_RETRY: Record<ErrorScope, boolean> = {
  environment: true,
  input: true,
  conflict: false,
  transient: false,
  content: true,
};

/** 已知错误码的归属。未列出的码按 5xx/4xx 前缀规则与默认 transient 处理。 */
const CODE_SCOPE: Record<string, ErrorScope> = {
  // 环境：缺工具、缺模型、连不上、后端能力不支持。修配置，不重提生成。
  MEDIA_TOOL_MISSING: "environment",
  MODEL_FILE_MISSING: "environment",
  DEVICE_OUT_OF_MEMORY: "environment",
  BACKEND_UNREACHABLE: "environment",
  BACKEND_HTTP_401: "environment",
  BACKEND_HTTP_403: "environment",
  SOURCE_FIELDS_UNSUPPORTED: "environment",
  BROWSER_NOT_CONNECTED: "environment",
  // 输入：参数或身份不对，修正后作为新意图提交。
  INVALID_INPUT: "input",
  SCHEMA_MISMATCH: "input",
  PROJECT_SELECTION_REQUIRED: "input",
  PROJECT_NOT_FOUND: "input",
  NODE_NOT_FOUND: "input",
  TASK_NOT_FOUND: "input",
  SEGMENT_NOT_FOUND: "input",
  EPISODE_NOT_FOUND: "input",
  SCENE_NOT_FOUND: "input",
  ARTIFACT_NOT_FOUND: "input",
  ASSET_NOT_FOUND: "input",
  MODEL_REQUIRED: "input",
  OUTPUT_TOO_LARGE: "input",
  OPERATION_ID_REUSED: "input",
  MCP_COMMAND_MISMATCH: "input",
  MCP_COMMAND_REJECTED: "input",
  IDEMPOTENCY_CONFLICT: "input",
  PRODUCTION_RUN_NOT_FOUND: "input",
  DRAMA_NOT_FOUND: "input",
  TASK_HISTORY_PRUNED: "input",
  INVALID_CURSOR: "input",
  READ_CURSOR_EXPIRED: "input",
  BASE_HISTORY_UNAVAILABLE: "input",
  UNSUPPORTED_PRODUCTION_FORMAT: "input",
  MEDIA_MODE_PROMPT_ONLY: "input",
  // 冲突：目标正被占用或版本已变。定向回读后重算，不换 ID。
  REVISION_CONFLICT: "conflict",
  TARGET_BUSY: "conflict",
  TARGET_OCCUPIED: "conflict",
  TARGET_AWAITING_REVIEW: "conflict",
  TEXT_CONFLICT: "conflict",
  MANUAL_INPUT_CONFLICT: "conflict",
  COMPILATION_SUPERSEDED: "conflict",
  COMPILATION_INPUT_CHANGED: "conflict",
  H3_CLIP_OCCUPIED: "conflict",
  TASK_NOT_CANCELLABLE: "conflict",
  STALE_H3_PREVIEW: "conflict",
  PRODUCTION_RUN_ALREADY_ENDED: "conflict",
  PRODUCTION_RUN_NOT_RESUMABLE: "conflict",
  // 瞬时：进程、网络、超时、回执未就绪。沿原幂等身份恢复。
  BACKEND_TIMEOUT: "transient",
  BACKEND_NETWORK_ERROR: "transient",
  BACKEND_INVALID_RESPONSE: "transient",
  MCP_CALL_CANCELLED: "transient",
  RECEIPT_UNAVAILABLE: "transient",
  OPERATION_RECEIPT_UNAVAILABLE: "transient",
  // 内容：产物真的不合规。必须改输入后新开 runId。
  SPEC_MISMATCH: "content",
  REFERENCE_INVALID: "content",
  REFERENCE_UNBOUND: "content",
  PROMPT_INVALID: "content",
  MEDIA_IDENTITY_MISMATCH: "content",
  CONTINUITY_BLOCKED: "content",
  COMPILATION_MEDIA_INTEGRITY_FAILED: "content",
  SUBJECT_IMAGE_RESULT_MISSING: "content",
  SUBJECT_IMAGE_NOT_ARCHIVED: "content",
  SUBJECT_IMAGE_HASH_MISMATCH: "content",
};

/** 无法判定时使用的码：既不假装环境问题，也不假装内容问题。 */
const UNKNOWN_TASK_CODE = "TASK_FAILED";

function scopeForCode(code: string): ErrorScope {
  const known = CODE_SCOPE[code];
  if (known) return known;
  if (/^BACKEND_HTTP_5\d\d$/.test(code)) return "transient";
  if (/^BACKEND_HTTP_4\d\d$/.test(code)) return "input";
  // 未知失败按瞬时处理：不阻止沿原身份恢复，但也绝不声称「内容有问题」。
  return "transient";
}

const MEDIA_TOOL_PATTERN = /\b(ffmpeg|ffprobe)\b|ffmpeg\.exe|ffprobe\.exe/i;
const MISSING_BINARY_PATTERN = /ENOENT|not\s*found|no such file|不是内部或外部命令|系统找不到指定的文件|无法将.+识别为/i;
const MISSING_FILE_PATTERN = /ENOENT|no such file|不存在|cannot find|could not find|not\s*found/i;
const MODEL_FILE_PATTERN = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)\b/i;

/**
 * 从自由文本里识别已知故障。
 * 任务 `error` 字段与工具异常都会经过这里 —— 命令行的 ENOENT 文案在两处完全一致。
 */
export function detectCodeFromMessage(message: string): string | undefined {
  const text = String(message || "");
  if (!text) return undefined;
  if (MEDIA_TOOL_PATTERN.test(text) && MISSING_BINARY_PATTERN.test(text)) return "MEDIA_TOOL_MISSING";
  if (MODEL_FILE_PATTERN.test(text) && MISSING_FILE_PATTERN.test(text)) return "MODEL_FILE_MISSING";
  if (/out of memory|OOM|显存不足|CUDA error/i.test(text)) return "DEVICE_OUT_OF_MEMORY";
  if (/SPEC_MISMATCH|规格不符|规格不匹配/.test(text)) return "SPEC_MISMATCH";
  if (/REFERENCE_UNBOUND|未绑定参考|缺少角色参考/.test(text)) return "REFERENCE_UNBOUND";
  if (/REFERENCE_INVALID|参考图无效|参考不合法/.test(text)) return "REFERENCE_INVALID";
  if (/PROMPT_INVALID|提示词非法|提示词为空/.test(text)) return "PROMPT_INVALID";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network error|ENOTFOUND/i.test(text)) return "BACKEND_NETWORK_ERROR";
  if (/timeout|timed out|超时/i.test(text)) return "BACKEND_TIMEOUT";
  if (/任务不存在或已被清理|task not found/i.test(text)) return "TASK_NOT_FOUND";
  return undefined;
}

function fixForCode(code: string, message: string, tool?: string): ErrorFix | undefined {
  switch (code) {
    case "MEDIA_TOOL_MISSING": {
      const binary = /ffprobe/i.test(message) ? "ffprobe" : "ffmpeg";
      const envKey = binary === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
      return {
        summary: `把 ${binary} 所在目录写入 backend.json 的 mediaTools.ffmpegDir（或设置 ${envKey}）后重启 Backend；已生成的媒体只需重新核验，不要重提生成`,
        file: "backend.json",
        key: "mediaTools.ffmpegDir",
      };
    }
    case "MODEL_FILE_MISSING":
      return { summary: "在模型设置里补齐该模型文件后重试；模型路径问题不会因重提生成而消失", file: "backend.json", key: "ai.channels" };
    case "DEVICE_OUT_OF_MEMORY":
      return { summary: "降低分辨率/帧数或释放显存后作为新意图提交；原样重提必定再次 OOM" };
    case "BACKEND_NETWORK_ERROR":
    case "BACKEND_UNREACHABLE":
      return { summary: "确认 Backend 进程与地址可达；MCP 重连后用原 taskId 恢复，不要新开任务", file: "backend.json", key: "url" };
    case "BACKEND_TIMEOUT":
      return { summary: "任务可能仍在运行：用原 taskId 查询终态，不要重提" };
    case "BACKEND_HTTP_401":
    case "BACKEND_HTTP_403":
      return { summary: "检查 Backend token 与权限", file: "backend.json", key: "token" };
    case "SOURCE_FIELDS_UNSUPPORTED":
      return { summary: "更新 Backend 后重试 fields 读取，或省略 fields 读取原内容" };
    case "BROWSER_NOT_CONNECTED":
      return { summary: "先在 Infinite Canvas 网页建立连接；Backend 原生 MCP 工具不依赖网页" };
    case "STALE_H3_PREVIEW":
      return { tool: "h3_preview_run", summary: "重新预检拿到新 planHash 后，用原 idempotencyKey 提交" };
    case "REVISION_CONFLICT":
      return { summary: "定向回读当前 revision 与目标状态后重算，不要换 ID 重来" };
    case "H3_CLIP_OCCUPIED":
      return { summary: "先查占用该 Clip 的原任务；待其结束后再运行" };
    case "SPEC_MISMATCH":
      return { summary: "按 specification.issues 修正输入后新开 runId；不要原样重提" };
    case UNKNOWN_TASK_CODE:
      // 说不清是谁的问题时，至少把「该看哪里」说清楚，避免按惯性改内容。
      return { summary: `先判断该错误属于环境、输入还是内容：读了 ${tool || "任务"} 的 errorContext / 产物规格后再决定，不要原样重提相同请求` };
    default:
      return undefined;
  }
}

/**
 * 判定一个错误的分级。
 *
 * code 优先：调用方已经给出明确错误码时以它为准；只有在码是兜底类
 * （空、CANVAS_TOOL_FAILED、TASK_FAILED）时才用 message 识别，
 * 避免把「消息里提到 ffmpeg」的无关失败误判成缺工具。
 */
export function classifyErrorDisposition(input: {
  code?: string | null;
  message?: string | null;
  tool?: string;
}): ErrorDisposition {
  const rawCode = String(input.code || "").trim();
  const message = String(input.message || "");
  const detected = detectCodeFromMessage(message);
  const codeFallback = !rawCode || rawCode === "CANVAS_TOOL_FAILED" || rawCode === UNKNOWN_TASK_CODE;
  const code = codeFallback && detected ? detected : rawCode || detected || UNKNOWN_TASK_CODE;
  const scope = scopeForCode(code);
  const fix = fixForCode(code, message, input.tool);
  return { code, scope, doNotRetry: SCOPE_DO_NOT_RETRY[scope], ...(fix ? { fix } : {}) };
}

/**
 * 任务 `error` 字段的分级。任务失败的文本没有错误码，只能靠消息识别；
 * 识别不出时返回 TASK_FAILED/transient，绝不臆断为内容问题。
 */
export function taskFailureDisposition(error: unknown): ErrorDisposition | undefined {
  const message = typeof error === "string" ? error.trim() : "";
  if (!message) return undefined;
  return classifyErrorDisposition({ code: detectCodeFromMessage(message), message });
}
