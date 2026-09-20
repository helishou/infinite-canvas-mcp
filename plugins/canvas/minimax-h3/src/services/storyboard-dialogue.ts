// H3 分镜台词（<d>...</d>）检测与说话人绑定工具。
//
// 设计：分镜编辑框里的描述文本保持「干净」（不含 (Sx)），说话人绑定存放在
// StoryboardShot.dialogueSpeakers（按台词出现顺序对齐）。只有在「统一提交 / 编译」
// （serializeStoryboardShots → detailed_description）时，才把 (Sx) 注入到文本里；
// 重新载入提示词时再从文本里把 (Sx) 解析回 dialogueSpeakers，编辑框再次变干净。
// 这样绑定状态随提示词文本自然持久化，无需额外元数据。

export type StoryboardDialogue = { speaker: string | null; preview: string };

// 匹配台词：可选紧贴 <d> 前的 (Sx)、<d> 标签、可选语言标签 [xx]、台词内容。
const DIALOGUE_RE = /(\(S(\d)\)\s*)?<d>(?:\[[^\]]+\])?([\s\S]*?)<\/d>/gi;

/** 从文本中提取所有台词及其已绑定的说话人（(Sx) 紧贴 <d> 前）。 */
export function extractDialogues(text: string): StoryboardDialogue[] {
  const out: StoryboardDialogue[] = [];
  let m: RegExpExecArray | null;
  DIALOGUE_RE.lastIndex = 0;
  while ((m = DIALOGUE_RE.exec(text))) {
    out.push({ speaker: m[2] ? `S${m[2]}` : null, preview: (m[3] || "").trim() });
  }
  return out;
}

/**
 * 从提示词文本里解析 <Subject N> 与说话人 (Sx) 的对应关系。
 * 官方规则要求发声主体写成 `<Subject 1> (S1) says:`，这里把已确立的编号关系读回来，
 * 用于把下拉/徽标里的 Sx 显示成真实角色名。
 * 返回 Map<主体序号字符串, "S1">。
 */
export function parseSubjectSpeakerMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  // <Subject 3> ... (S2) / <Subject 3> (S2)
  for (const match of text.matchAll(/<Subject\s+(\d+)[^<>{}\n]{0,140}?\(\s*(S\d+)\s*\)/giu)) {
    const ordinal = match[1];
    if (!map.has(ordinal)) map.set(ordinal, match[2].toUpperCase());
  }
  // (S2) ... <Subject 3>
  for (const match of text.matchAll(/\(\s*(S\d+)\s*\)[^<>{}\n]{0,60}?<Subject\s+(\d+)>/giu)) {
    const ordinal = match[2];
    if (!map.has(ordinal)) map.set(ordinal, match[1].toUpperCase());
  }
  return map;
}

/** 文本里出现过的全部说话人编号（按首次出现顺序），如 ["S1","S2"]。 */
export function collectSpeakerIds(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\(\s*(S\d+)\s*\)/giu)) {
    const id = match[1].toUpperCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 去掉紧帖 <d> 前的 (Sx)（保留其它位置的，例如 <Subject 1> (S1) says:）。 */
export function stripDialogueSpeakers(text: string): string {
  return text.replace(/\(S\d\)\s*(?=<d>)/gi, "");
}

/**
 * 把 dialogueSpeakers（按台词顺序）编译进文本：
 * - 想要 Sx 且当前未紧帖 → 在 <d> 前插入 (Sx)
 * - 想要 Sx 且当前已是 (Sx) → 保持
 * - 想要 Sx 且当前是别的 (Sx) 紧贴 → 替换
 * - 不想要且当前紧贴 (Sx) → 移除
 * 其余位置（如 <Subject 1> (S1) says:）的 (Sx) 不动，避免重复。
 */
export function injectDialogueSpeakers(text: string, speakers: string[]): string {
  if (!speakers.length) return text;
  const re = /<d>(?:\[[^\]]+\])?[\s\S]*?<\/d>/gi;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) matches.push(m);
  if (!matches.length) return text;
  let out = "";
  let last = 0;
  for (let i = 0; i < matches.length; i++) {
    const target = matches[i];
    out += text.slice(last, target.index);
    const before = text.slice(0, target.index);
    const immediate = /\(S(\d)\)\s*$/.exec(before);
    const wanted = speakers[i] || "";
    if (wanted) {
      if (immediate) {
        if (immediate[1] !== wanted.replace(/^S/, "")) out = out.replace(/\(S\d\)\s*$/, `(${wanted}) `);
      } else {
        out += `(${wanted}) `;
      }
    } else if (immediate) {
      out = out.replace(/\(S\d\)\s*$/, "");
    }
    out += target[0];
    last = target.index + target[0].length;
  }
  out += text.slice(last);
  return out;
}
