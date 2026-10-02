import { spawn } from "node:child_process";
import path from "node:path";

export const CHARACTER_VOICE_COMPRESSION_THRESHOLD_BYTES = 512 * 1024;

export type CharacterVoiceUpload = {
  body: Buffer;
  name: string;
  mimeType: string;
  compressed: boolean;
  originalBytes: number;
};

/** Only character voice uploads use this path; ordinary audio assets keep their original encoding. */
export async function prepareCharacterVoiceUpload(
  body: Buffer,
  name: string,
  mimeType: string,
  encode: (input: Buffer) => Promise<Buffer> = encodeCharacterVoiceMp3,
): Promise<CharacterVoiceUpload> {
  if (!mimeType.startsWith("audio/") && !/\.(wav|mp3|m4a|flac|ogg|opus)$/i.test(name)) {
    throw new Error("角色声线必须是音频文件");
  }
  if (body.length <= CHARACTER_VOICE_COMPRESSION_THRESHOLD_BYTES) {
    return { body, name, mimeType, compressed: false, originalBytes: body.length };
  }
  const compressed = await encode(body);
  if (!compressed.length) throw new Error("角色声线压缩未产生音频");
  if (compressed.length >= body.length) {
    return { body, name, mimeType, compressed: false, originalBytes: body.length };
  }
  return {
    body: compressed,
    name: `${path.parse(name).name}-24k-64kbps.mp3`,
    mimeType: "audio/mpeg",
    compressed: true,
    originalBytes: body.length,
  };
}

function encodeCharacterVoiceMp3(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:a:0", "-vn",
      "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`角色声线压缩失败：${Buffer.concat(errors).toString("utf8").trim() || `ffmpeg exit ${code}`}`));
      resolve(Buffer.concat(output));
    });
    // Invalid input may close ffmpeg's stdin early; the process exit above reports the useful error.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
