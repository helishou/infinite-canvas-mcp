import assert from "node:assert/strict";
import test from "node:test";
import {
    backfillShots,
    dialogueKey,
    missingDialogue,
    quotedSourceLines,
    splitChapters,
    type ShotLike,
} from "./shot-dialogue-backfill.js";

const CHAPTER3 = `第 3 章 卷中之谜

沈砚把那封信托在袖中，反复琢磨“真相在卷中”这五个字。他忽然想起，柳文卿死时怀里死死揣着的正是自己的会试卷。难道答案就在那卷文章里？

他重新展开那卷墨卷，逐字逐句地读。文章表面讲的是治国安民，可当他读到第三段时，目光停住了。那一段里有八个字的对仗，看似寻常，可若将每句的首字连起来读，竟是一句隐语：“周郎害我，谨防寒波。”

“周郎……寒波……”沈砚喃喃自语。寒波寺，正是柳文卿陈尸之处。周郎又是谁？

他猛地想起赵孟坚提到的那个“周举子”。可掌柜说从无此人，这说明周举子要么是化名，要么根本就不存在——是有人故意放出的烟幕。沈砚重新审视赵孟坚的证词，越想越觉得此人居心叵测。

他连夜提审赵孟坚。起初赵孟坚矢口否认，直到沈砚念出那句隐语，他的脸色才骤然变了。原来，今科会试的主考官之一，正是赵孟坚的叔父。二人舞弊，将柳文卿的卷子掉包，又把真正的会元卷据为己有。柳文卿察觉真相，写下隐语藏于卷中，却被赵孟坚先行发现。

“寒波寺那晚，是我把他骗去的。”赵孟坚瘫坐在地，泪如雨下，“我本只想吓他退让，谁知失手……”

真相大白。沈砚望着窗外初晴的雪色，长长舒了一口气。一桩会因贪念而起的命案，终究没能瞒过那卷藏在尸身怀里的文章。他提笔写下判词，心中却久久不能平静：读书人本该以文章立身，为何偏偏有人，把聪明用在了歪路上。`;

const VISUALS = [
    "场1｜内景·开封府书房｜夜｜沈砚｜沈砚反复琢磨“真相在卷中”，因想起柳文卿死时怀揣会试卷而决定重查墨卷。",
    "场2｜内景·开封府书房｜夜｜沈砚｜沈砚逐字细读柳文卿的会试墨卷，从第三段对仗首字中读出“周郎害我，谨防寒波”的隐语。",
    "场3｜内景·开封府书房｜夜｜沈砚｜沈砚联想到寒波寺与赵孟坚所言的周举子，断定周举子是烟幕而将疑心锁定赵孟坚。",
    "场4｜内景·开封府大牢｜夜｜沈砚、赵孟坚｜沈砚连夜提审矢口否认的赵孟坚，因念出卷中隐语而令其神色骤变。",
    "场5｜内景·开封府大牢｜夜｜沈砚、赵孟坚｜赵孟坚崩溃供出叔父舞弊掉包试卷、自己骗柳文卿至寒波寺失手害命的真相。",
    "场6｜内景·开封府书房｜日｜沈砚｜雪霁天晴，沈砚提笔写下判词，却因读书人以聪明行歪路而久久难平。",
];
const SHOTS: ShotLike[] = VISUALS.map((visual, i) => ({ id: `shot-${i}`, visual }));

test("splitChapters 拆出第 3 章正文", () => {
    const source = "第 1 章 雪夜沉尸\n\n甲。\n\n第 2 章 会元疑云\n\n乙。\n\n" + CHAPTER3;
    const chapters = splitChapters(source);
    assert.deepEqual(chapters.map(c => c.no), [1, 2, 3]);
    assert.equal(chapters[2].title, "第 3 章 卷中之谜");
    assert.ok(chapters[2].body.includes("周郎害我，谨防寒波"));
});

test("quotedSourceLines 提取原文 6 句引号台词", () => {
    const lines = quotedSourceLines(CHAPTER3);
    assert.equal(lines.length, 6, JSON.stringify(lines));
    assert.deepEqual(lines, [
        "真相在卷中",
        "周郎害我，谨防寒波。",
        "周郎……寒波……",
        "周举子",
        "寒波寺那晚，是我把他骗去的。",
        "我本只想吓他退让，谁知失手……",
    ]);
});

test("回填映射：前2句→镜头1/2，周郎寒波与周举子→镜头3，后2句→镜头5", () => {
    const result = backfillShots({
        chapterText: CHAPTER3,
        shots: SHOTS,
        characterRegistryNames: ["沈砚", "赵孟坚"],
    });
    assert.equal(result.added, 6, `assignments=${JSON.stringify(result.assignments)}`);
    const byText = new Map(result.assignments.map(a => [a.text, a]));
    assert.equal(byText.get("真相在卷中")?.shotIndex, 0, "真相在卷中 → 镜头1（visual 逐字）");
    assert.equal(byText.get("周郎害我，谨防寒波。")?.shotIndex, 1, "周郎害我 → 镜头2（visual 逐字）");
    assert.equal(byText.get("周郎……寒波……")?.shotIndex, 2, "周郎寒波 → 镜头3（关键字重叠）");
    assert.equal(byText.get("周举子")?.shotIndex, 2, "周举子 → 镜头3（visual 逐字）");
    assert.equal(byText.get("寒波寺那晚，是我把他骗去的。")?.shotIndex, 4, "寒波寺那晚 → 镜头5（关键字重叠）");
    assert.equal(byText.get("我本只想吓他退让，谁知失手……")?.shotIndex, 4, "我本只想吓他 → 镜头5（关键字重叠）");
    assert.equal(byText.get("寒波寺那晚，是我把他骗去的。")?.speaker, "赵孟坚");
    assert.equal(byText.get("我本只想吓他退让，谁知失手……")?.speaker, "赵孟坚");
    assert.equal(byText.get("真相在卷中")?.speaker, "沈砚");
    assert.equal(byText.get("周举子")?.method, "exact-visual");
    assert.equal(byText.get("周郎……寒波……")?.method, "keyword-overlap");

    // 回填后逐字核查缺失归零
    const shotLines = result.shots.flatMap(s => {
        const ds = Array.isArray(s.dialogues) ? s.dialogues as Array<Record<string, unknown>> : [];
        return ds.map(d => String(d?.text || ""));
    });
    assert.deepEqual(missingDialogue(quotedSourceLines(CHAPTER3), shotLines), []);
});

test("回填幂等：已有对白后再次回填 added=0", () => {
    const first = backfillShots({ chapterText: CHAPTER3, shots: SHOTS, characterRegistryNames: ["沈砚", "赵孟坚"] });
    const second = backfillShots({ chapterText: CHAPTER3, shots: first.shots, characterRegistryNames: ["沈砚", "赵孟坚"] });
    assert.equal(second.added, 0);
    assert.equal(second.assignments.length, 0);
    assert.equal(second.alreadyPresent, 6);
});

test("dialogueKey 与前端一致：去标点/空白/引号并小写", () => {
    assert.equal(dialogueKey("周郎……寒波……"), "周郎寒波");
    assert.equal(dialogueKey("“真相在卷中”"), "真相在卷中");
    assert.equal(dialogueKey("我本只想吓他退让，谁知失手……"), "我本只想吓他退让谁知失手");
});
