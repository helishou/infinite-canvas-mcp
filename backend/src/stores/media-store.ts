import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BackendDatabase, MediaFile } from "../db.js";
import { MEDIA_DIR } from "../config.js";
import { extensionForMime, mediaKindForMime, type MediaCategory, type MediaStore, type MediaStats, type NamedMedia } from "./types.js";

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/**
 * 内容寻址去重：同 sha256、同字节数、且文件仍在盘上时，复用同一份物理文件，
 * 只登记新的 storageKey（文件不重复落盘）。
 *
 * 为什么不能删掉共享文件：`media_files.storage_key` 才是业务身份，
 * 画布/回执/编译产物引用的是 key，不是路径；同一份内容被多个 key 引用是正常的。
 * 因此删除（`delete()`）必须先确认没有其它 key 还指向该文件。
 */
function reusablePath(db: BackendDatabase, sha256: string, bytes: number): string | null {
    const existing = db.getMediaFileByDigest(sha256);
    if (!existing || existing.bytes !== bytes) return null;
    try { return fs.statSync(existing.filePath).size === bytes ? existing.filePath : null; }
    catch { return null; // 老文件已丢失，按新内容重新落盘
    }
}

/** 媒体 store：media_files 表 + runtime-media/{input,output,library} 文件系统。 */
export function createMediaStore(db: BackendDatabase): MediaStore {
    const kindFor = (mime: string, fileName = "") => mediaKindForMime(mime, fileName);

    return {
        /** 入库媒体（web 双写 / 生成结果落地），storageKey 由后台生成。 */
        store(data, options) {
            if (!data.length) throw new Error("媒体为空");
            if (data.length > MAX_MEDIA_BYTES) throw new Error("媒体超过 200 MB 限制");
            const mimeType = options.mimeType || "application/octet-stream";
            const name = path.basename(options.name || "media.bin");
            const storageKey = options.storageKey || `${kindFor(mimeType, name)}:${randomUUID()}`;
            const extension = path.extname(name).replace(/[^a-z0-9.]/gi, "").slice(0, 12) || extensionForMime(mimeType);
            const category = safeCategory(options.category);
            const categoryDir = path.join(MEDIA_DIR, category);
            const sha256 = createHash("sha256").update(data).digest("hex");
            const reuse = reusablePath(db, sha256, data.length);
            const filePath = reuse ?? path.join(categoryDir, `${randomUUID()}${extension}`);
            if (!reuse) {
                fs.mkdirSync(categoryDir, { recursive: true, mode: 0o700 });
                fs.writeFileSync(filePath, data, { mode: 0o600 });
            }
            const media: MediaFile = {
                storageKey,
                filePath,
                mimeType,
                bytes: data.length,
                width: options.width ?? null,
                height: options.height ?? null,
                durationMs: options.durationMs ?? null,
                createdAt: new Date().toISOString(),
                sha256,
            };
            db.upsertMediaFile(media);
            return media;
        },

        async storeStream(source, options) {
            const name = path.basename(options.name || "media.bin");
            const categoryDir = path.join(MEDIA_DIR, safeCategory(options.category));
            const tempPath = path.join(categoryDir, `.incoming-${randomUUID()}.tmp`);
            fs.mkdirSync(categoryDir, { recursive: true, mode: 0o700 });
            let bytes = 0;
            let prefix = Buffer.alloc(0);
            const digest = createHash("sha256");
            const limit = new Transform({
                transform(chunk, _encoding, callback) {
                    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += data.length;
                    if (bytes > MAX_MEDIA_BYTES) callback(new Error("媒体超过 200 MB 限制"));
                    else {
                        digest.update(data);
                        if (prefix.length < 64) prefix = Buffer.concat([prefix, data.subarray(0, 64 - prefix.length)]);
                        callback(null, data);
                    }
                },
            });
            let filePath = "";
            let createdPath = "";
            try {
                await pipeline(source, limit, fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
                if (!bytes) throw new Error("媒体为空");
                const mimeType = options.resolveMimeType?.(prefix, bytes) || options.mimeType || "application/octet-stream";
                const storageKey = options.storageKey || `${kindFor(mimeType, name)}:${randomUUID()}`;
                const extension = path.extname(name).replace(/[^a-z0-9.]/gi, "").slice(0, 12) || extensionForMime(mimeType);
                const sha256 = digest.digest("hex");
                const reuse = reusablePath(db, sha256, bytes);
                if (reuse) {
                    // 已有同内容文件：丢弃刚落盘的临时文件，登记同一份物理文件。
                    filePath = reuse;
                    try { await fs.promises.unlink(tempPath); } catch { /* 临时文件已不在 */ }
                } else {
                    filePath = path.join(categoryDir, `${randomUUID()}${extension}`);
                    createdPath = filePath;
                    await fs.promises.rename(tempPath, filePath);
                }
                const media: MediaFile = {
                    storageKey,
                    filePath,
                    mimeType,
                    bytes,
                    width: options.width ?? null,
                    height: options.height ?? null,
                    durationMs: options.durationMs ?? null,
                    createdAt: new Date().toISOString(),
                    sha256,
                };
                db.upsertMediaFile(media);
                return { ...media, sha256, prefix };
            } catch (error) {
                try { fs.unlinkSync(tempPath); } catch { /* partial media may not have been created */ }
                // 只清理由本次调用真实创建的文件；`filePath` 可能是复用来的共享文件，绝不能删。
                if (createdPath) try { fs.unlinkSync(createdPath); } catch { /* archived media may not have been committed */ }
                throw error;
            }
        },

        /** 按 base64 dataUrl 落地（兼容旧 Agent /runtime/media 与 H3 ref 落地），返回稳定可读路径。 */
        storeDataUrl(dataUrl: string, name: string, extra: MediaStats & { storageKey?: string } = {}): MediaFile & { path: string; url: string } {
            const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl).trim());
            if (!match) throw new Error("媒体必须是 base64 data URL");
            const [, mimeType, b64] = match;
            const media = this.store(Buffer.from(b64, "base64"), { name, mimeType, ...extra });
            return { ...media, path: media.filePath, url: this.url(media) };
        },

        /** 按 name 幂等读写 runtime 媒体（H3 ref 落地）。 */
        storeNamed(name, data, mimeType = "application/octet-stream"): NamedMedia {
            const safeName = path.basename(name);
            if (!safeName || safeName.includes("..")) throw new Error("运行时媒体文件名无效");
            const id = cryptoStableId(`runtime-media:${safeName}`);
            const createdAt = new Date().toISOString();
            const filePath = path.join(MEDIA_DIR, safeName);
            const sha256 = createHash("sha256").update(data).digest("hex");
            if (fs.existsSync(filePath) && fs.statSync(filePath).size === data.length
                && createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") === sha256) {
                db.upsertMediaFile({ storageKey: id, filePath, mimeType, bytes: data.length, width: null, height: null, durationMs: null, createdAt, sha256 });
                return { id, name: safeName, path: filePath, size: data.length, bytes: data.length, mimeType, url: runtimeMediaUrl(safeName) };
            }
            fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
            fs.writeFileSync(filePath, data, { mode: 0o600 });
            db.upsertMediaFile({ storageKey: id, filePath, mimeType, bytes: data.length, width: null, height: null, durationMs: null, createdAt, sha256 });
            return { id, name: safeName, path: filePath, size: data.length, bytes: data.length, mimeType, url: runtimeMediaUrl(safeName) };
        },

        meta: (storageKey) => db.getMediaFile(storageKey),
        list: () => db.listMediaFiles(),

        async read(storageKey: string): Promise<Buffer> {
            const media = db.getMediaFile(storageKey);
            if (!media) throw new Error("media not found");
            try {
                return await fs.promises.readFile(media.filePath);
            } catch {
                throw new Error("媒体文件丢失");
            }
        },

        /** runtime 媒体按文件名读（对应旧 Agent /runtime/media-file）。 */
        readNamed(name: string): Buffer {
            const safeName = path.basename(name);
            if (!safeName || safeName.includes("..")) throw new Error("运行时媒体文件名无效");
            return fs.readFileSync(path.join(MEDIA_DIR, safeName));
        },

        url: (m) => `/media/${encodeURIComponent(m.storageKey)}`,

        delete(storageKey: string): number {
            const media = db.getMediaFile(storageKey);
            if (!media) return 0;
            db.deleteMediaFile(storageKey);
            // 内容寻址后同一份文件可能被多个 storage_key 共享：最后一个引用消失才删文件。
            if (db.countMediaFileSharers(media.filePath, storageKey) === 0) {
                try { fs.unlinkSync(media.filePath); } catch { /* 文件可能已不在 */ }
            }
            return 1;
        },
    };
}

/** 稳定 id：同名同一 id，改名换 id。 */
function cryptoStableId(source: string): string {
    return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function safeCategory(value: MediaCategory | undefined): MediaCategory {
    return value === "output" || value === "library" ? value : "input";
}

export function runtimeMediaUrl(name: string) {
    return `/runtime/media-file?name=${encodeURIComponent(name)}`;
}
