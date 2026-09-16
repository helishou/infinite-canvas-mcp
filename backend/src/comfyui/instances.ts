import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

const INSTANCES_FILE = path.join(DATA_DIR, "comfyui-instances.json");

export interface ComfyInstances {
  instances: string[];
}

export async function loadInstances(): Promise<ComfyInstances> {
  try {
    const raw = await fs.readFile(INSTANCES_FILE, "utf8");
    const data = JSON.parse(raw);
    return { instances: Array.isArray(data.instances) ? data.instances.filter((s: unknown) => typeof s === "string") : [] };
  } catch {
    return { instances: [] };
  }
}

export async function saveInstances(data: ComfyInstances): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(INSTANCES_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function validateInstance(addr: string): string | null {
  const s = addr.trim();
  if (!s) return "地址不能为空";
  const cleaned = s.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!cleaned.includes(":")) return "地址缺少端口号（应为 host:port）";
  const idx = cleaned.lastIndexOf(":");
  const host = cleaned.slice(0, idx);
  const port = cleaned.slice(idx + 1);
  if (!host || !/^\d+$/.test(port)) return "地址不合法";
  return null;
}
