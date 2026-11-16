import { request } from "@/services/backend-api";

export type SkillCategory = "drama" | "ecommerce" | "creative" | "social" | "others";
export type SkillSource = "builtin" | "markdown" | "zip";

export type MarketSkill = {
    name: string;
    title: string;
    description: string;
    tag: SkillCategory;
    source: SkillSource;
    sourceRef: string;
    builtin: boolean;
    liked: boolean;
    added: boolean;
    autoUpdate: boolean;
    installedAt: string;
    fileCount: number;
    totalBytes: number;
    version: string;
    path: string;
    glyph: string;
};

export type SkillDetail = { name: string; content: string; revision: string; files: string[] };
export type UploadFileEntry = { path: string; contentBase64: string };

export async function fetchMarketSkills(): Promise<{ skills: MarketSkill[]; revision: string }> {
    const response = await request<{ ok: boolean; data: MarketSkill[]; revision: string }>("GET", "/api/skill-market/skills");
    return { skills: response.data || [], revision: response.revision || "" };
}

export async function fetchSkillDetail(name: string): Promise<SkillDetail> {
    const response = await request<{ ok: boolean; data: SkillDetail }>("GET", `/api/skill-market/detail?name=${encodeURIComponent(name)}`);
    return response.data;
}

export async function updateSkillState(input: {
    name: string;
    revision: string;
    patch: Partial<Pick<MarketSkill, "liked" | "added" | "autoUpdate" | "tag">>;
}): Promise<{ entry: MarketSkill; revision: string }> {
    return request<{ ok: boolean; data: { entry: MarketSkill; revision: string } }>("POST", "/api/skill-market/state", {
        name: input.name, expectedRevision: input.revision, patch: input.patch,
    }).then(response => response.data);
}

export async function installMarketSkill(input: {
    name: string;
    source: "markdown" | "zip";
    tag: SkillCategory;
    files: UploadFileEntry[];
}): Promise<MarketSkill> {
    const response = await request<{ ok: boolean; data: MarketSkill }>("POST", "/api/skill-market/install", input);
    return response.data;
}

export async function uninstallMarketSkill(name: string): Promise<void> {
    await request("POST", "/api/skill-market/uninstall", { name });
}

/** 把浏览器 File 读成 base64（不含 data: 前缀）。 */
export function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error("读取技能文件失败"));
        reader.readAsDataURL(file);
    });
}

/** 拆分 SKILL.md 头部 YAML frontmatter，避免结尾 --- 被 Markdown 渲染成 setext 标题。 */
export function splitSkillFrontmatter(source: string): { body: string } {
    const match = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    return { body: match ? source.slice(match[0].length) : source };
}

/** 从 SKILL.md 文本里读取 name / description，供安装表单自动填充。 */
export function readSkillFrontmatter(source: string): { name?: string; description?: string } {
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
    if (!match) return {};
    const result: { name?: string; description?: string } = {};
    for (const line of match[1].split(/\r?\n/)) {
        const item = /^(name|description)[ \t]*:[ \t]*(.*)$/.exec(line);
        if (!item) continue;
        let value = item[2].trim();
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
        if (item[1] === "name") result.name = value;
        else result.description = value;
    }
    return result;
}
