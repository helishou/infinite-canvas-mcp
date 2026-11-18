import assert from "node:assert/strict";
import { parseEpisodeScriptBeats } from "./outline-proposal.ts";

// 影策式：梗概 + 分场 + 钩子/悬念
const full = `本集梗概：伥听闻薮觏山妖患害人，决意独自上山除妖。途中斩杀沿路蟒妖，与百毒真君、红莲护法相遇，被红莲护法吞入腹中，展开一场生死搏杀。
场1｜外景·山下路｜日｜伥、小妖｜伥听闻妖患，决意上山。
场2｜外景·上山道｜日｜伥｜伥斩杀沿路蟒妖。
开场钩子：妖患害人，少年独闯。
结尾悬念：护法张口吞人。`;
const a = parseEpisodeScriptBeats(full);
assert.match(a.synopsis, /伥听闻薮觏山妖患害人/);
assert.ok(!a.synopsis.includes("场1"), "梗概不含分场标记");
assert.equal(a.hook, "妖患害人，少年独闯。");
assert.equal(a.cliffhanger, "护法张口吞人。");
assert.match(a.text, /场1/);
assert.ok(!a.text.includes("开场钩子"), "正文剥离钩子");
assert.ok(!a.text.includes("本集梗概"), "正文剥离梗概行");

// 旧格式：无梗概标记 → synopsis 空，text 原样保留（向后兼容）
const old = `场1｜内景·书房｜夜｜沈砚｜沈砚读卷。
开场钩子：卷中藏谜。`;
const b = parseEpisodeScriptBeats(old);
assert.equal(b.synopsis, "");
assert.match(b.text, /场1/);
assert.equal(b.hook, "卷中藏谜。");

// 全角冒号 + 梗概独占行
const cjk = parseEpisodeScriptBeats("本集梗概：\n沈砚查案，牵出舞弊。\n场1｜内景·书房｜夜｜沈砚｜读卷。");
assert.equal(cjk.synopsis, ""); // 标记后同行空 → 空；正文在下一行
assert.match(cjk.text, /沈砚查案/); // 下一行作为正文保留

console.log("parseEpisodeScriptBeats tests passed");
