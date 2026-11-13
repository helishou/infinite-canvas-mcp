"""位置写法体检：位置与朝向以连续性账本为准，正文不复述；本脚本只查账本与构图两处。

为什么不再查正文方位：`source-contract` 的契约写得很清楚——
Subject Prompt v2 只把 `subject_usages[].continuityFactIds` 选中的事实投影进提示词，
`ledger.requirements` 与 events 负责校验与重放。所以位置、朝向、接触面的权威在账本，
镜头正文再写一遍就是双写（120 第 30 项也要求"局部画面正文避免再次复述状态字段"）。

三个检查都是确定性结构/词表规则，不做语义推断：
  1. MISSING_SHOT_STATE_BASELINE：某个 Clip 首镜既没有 hold/change 要求，也没有 stateRequirements
  2. VAGUE_STATE_VALUE：账本里的状态值用"旁边／一侧／附近"这类模糊方位
  3. NO_STRUCTURED_SCREEN_POSITION：首镜有在场角色，但既没有 characters[].position，也没有登记状态事实——
     屏幕位置没有结构化来源（画面左右是结构化字段，不靠正文描写）
  4. UNSOURCED_PARTITION：状态值里的地标在场景文案/landmarks 里找不到——分区名是临场造的
"""
import json
import re
import sys

# 模糊方位：「供桌旁」这类写法没落到具体方位，模型只能自己选一个位置。
# 只认紧贴地标字的「X旁」，避免误伤「一旁」「旁白」「旁观」。
VAGUE = re.compile(r"旁边|一侧|附近|边上|跟前|旁侧|靠边|(?<=[桌案门窗墙柱台柜床椅阶])旁")
# 台词包裹（编译合同要求台词只在 <d> 内），检查前先剔掉
DIALOGUE = re.compile(r"<d>.*?</d>", re.S)
# 判定"地标能否追溯到场景文案"时要排除的通用位置词，否则「地窖右侧地面」会靠「地面」蒙对。
GENERIC = {
    "地面", "地面。", "中央", "正中", "旁边", "一侧", "附近", "左侧", "右侧", "左边", "右边",
    "前方", "后方", "内侧", "外侧", "门口", "门内", "台阶", "座上", "画面", "镜头", "站位",
    "位置", "身体", "双脚", "上空", "远处", "近处", "中间", "周围", "四周",
}
CJK = re.compile(r"[\u4e00-\u9fa5]")


def shots_of(production):
    if isinstance(production.get("shots"), list):
        return production["shots"]
    director = production.get("director") or {}
    source = director.get("source") or {}
    value = source.get("shots")
    return value if isinstance(value, list) else []


def segments_of(production):
    if isinstance(production.get("segments"), list):
        return production["segments"]
    director = production.get("director") or {}
    source = director.get("source") or {}
    value = source.get("segments")
    return value if isinstance(value, list) else []


def ledger_of(production):
    if isinstance(production.get("ledger"), dict):
        return production["ledger"]
    director = production.get("director") or {}
    source = director.get("source") or {}
    value = source.get("ledger")
    return value if isinstance(value, dict) else {}


def scene_texts(production):
    """场景可追溯来源：结构化字段优先，prompt_description 兜底。"""
    if isinstance(production.get("scene_registry"), list):
        scenes = production["scene_registry"]
    else:
        director = production.get("director") or {}
        source = director.get("source") or {}
        scenes = source.get("scene_registry") if isinstance(source.get("scene_registry"), list) else []
    texts = {}
    for scene in scenes:
        if not isinstance(scene, dict) or not scene.get("id"):
            continue
        parts = [str(scene.get("name") or ""), str(scene.get("space") or ""), str(scene.get("prompt_description") or "")]
        for key in ("entrances", "exits", "landmarks"):
            value = scene.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value if isinstance(item, str))
        texts[str(scene["id"])] = " ".join(part for part in parts if part)
    return texts


def _candidates(value):
    """值里能当地标的中文片段（2–4 字，去掉通用位置词）。"""
    out = set()
    for size in (2, 3, 4):
        for index in range(0, max(0, len(value) - size + 1)):
            piece = value[index:index + size]
            if CJK.search(piece) and piece not in GENERIC:
                out.add(piece)
    return out


def _visual(shot):
    value = shot.get("visual")
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(str(item) for item in value if isinstance(item, str))
    return ""


def _screen_positions(shot):
    """结构化屏幕锚点：characters[].position = [x, y]，0–1 归一化。"""
    found = []
    for item in shot.get("characters") or []:
        if not isinstance(item, dict):
            continue
        position = item.get("position")
        if isinstance(position, list) and len(position) == 2 and all(
                isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1
                for value in position):
            found.append((item.get("id"), position))
    return found


def _has_cast(shot):
    usages = shot.get("subject_usages")
    if isinstance(usages, list) and usages:
        return True
    return bool(shot.get("characters"))


def ledger_dialect(ledger):
    """canvas v2 用它自己的 facts/timelines/initial[]/events[]/requirements；老样例是 initial{} 字典。"""
    if isinstance(ledger.get("facts"), list) or isinstance(ledger.get("requirements"), list):
        return "v2"
    if isinstance(ledger.get("initial"), dict) or isinstance(ledger.get("events"), list):
        return "legacy"
    return "none"


def spatial_lint(production):
    shots = shots_of(production)
    segments = segments_of(production)
    ledger = ledger_of(production)
    by_id = {str(shot.get("id")): shot for shot in shots}
    dialect = ledger_dialect(ledger)
    diagnostics = []

    def warn(code, scope, message):
        diagnostics.append({"code": code, "scope": scope, "message": message})

    # 账本里声明了状态的镜头：requirements(hold/change)、stateRequirements 或 continuityFactIds
    declared = set()
    for requirement in ledger.get("requirements") or []:
        if not isinstance(requirement, dict):
            continue
        if requirement.get("kind") in ("hold", "change") and requirement.get("shot_id"):
            declared.add(str(requirement["shot_id"]))
    for shot in shots:
        for usage in shot.get("subject_usages") or []:
            if not isinstance(usage, dict):
                continue
            # 勾了 continuityFactIds 也算：渲染取的是轨迹值 + value_descriptions，
            # 有勾选就已经有事实进提示词，不能因为没写 requirement 就判成空缺。
            if usage.get("stateRequirements") or usage.get("continuityFactIds"):
                declared.add(str(shot.get("id")))
                break

    # 1 + 3：逐个 Clip 首镜
    seen = set()
    for segment in segments:
        ids = [str(item) for item in (segment.get("shot_ids") or [])]
        if not ids:
            continue
        shot = by_id.get(ids[0])
        if not shot:
            continue
        shot_id = ids[0]
        if shot_id in seen:
            continue
        seen.add(shot_id)
        if dialect == "v2" and shot_id not in declared:
            warn("MISSING_SHOT_STATE_BASELINE", shot_id,
                 "这段的首镜没有任何 hold/change 要求、没有 stateRequirements、也没勾 continuityFactIds："
                 "跨段边界一条状态都没接上，位置与朝向只能靠模型自己编。"
                 "去 ledger 登记该镜的位置/朝向事实，勾上 continuityFactIds 并挂 hold。")
        if _has_cast(shot) and not _screen_positions(shot) and shot_id not in declared:
            warn("NO_STRUCTURED_SCREEN_POSITION", shot_id,
                 "首镜有在场角色，但既没有 characters[].position（[x,y] 0–1 的归一化屏幕锚点），也没有账本状态事实："
                 "屏幕位置没有结构化来源，只能靠模型自己猜。补位置字段，别在正文里用文字描述左右。")

    # 2：账本状态值的模糊方位
    def scan(value, scope):
        if not isinstance(value, str):
            return
        hit = VAGUE.search(value)
        if hit:
            warn("VAGUE_STATE_VALUE", scope,
                 f"状态值用了模糊方位「{hit.group(0)}」：「{value[:40]}」。改成「地标＋方位」，"
                 "如「供桌右侧地面」「案左后方」——账本是权威，模糊词会被原样投影进提示词。")

    for requirement in ledger.get("requirements") or []:
        if isinstance(requirement, dict):
            scan(requirement.get("value"),
                 str(requirement.get("shot_id") or requirement.get("fact_id") or "ledger.requirements"))
    for shot in shots:
        for usage in shot.get("subject_usages") or []:
            if not isinstance(usage, dict):
                continue
            for item in usage.get("stateRequirements") or []:
                if isinstance(item, dict):
                    scan(item.get("value"), str(shot.get("id")))

    # 4：分区名可追溯性（分区名靠文案/landmarks，不靠临场造词）
    texts = scene_texts(production)
    scene_of = {str(shot.get("id")): str(shot.get("scene_id") or "") for shot in shots}
    checked_partitions = set()

    def trace(shot_id, value):
        scene_id = scene_of.get(str(shot_id), "")
        text = texts.get(scene_id, "")
        if not isinstance(value, str) or not value or not text or not CJK.search(text):
            return  # 拿不到中文场景文案就不断言，不制造噪音
        key = (str(shot_id), value)
        if key in checked_partitions:
            return
        checked_partitions.add(key)
        candidates = _candidates(value)
        if not candidates:
            return
        if any(piece in text for piece in candidates):
            return
        warn("UNSOURCED_PARTITION", str(shot_id),
             f"状态值「{value[:40]}」里的地标在场景 {scene_id or '（未标注）'} 的文案/landmarks 里找不到。"
             "分区名只来自场景文案（space／prompt_description／landmarks／entrances），临场造一个词下一镜就对不上。")

    for requirement in ledger.get("requirements") or []:
        if isinstance(requirement, dict):
            trace(requirement.get("shot_id"), requirement.get("value"))
    for shot in shots:
        for usage in shot.get("subject_usages") or []:
            if not isinstance(usage, dict):
                continue
            for item in usage.get("stateRequirements") or []:
                if isinstance(item, dict):
                    trace(shot.get("id"), item.get("value"))

    return {"checked": len(seen), "dialect": dialect, "diagnostics": diagnostics}


def render_report(result):
    lines = [f"位置写法体检（{result['checked']} 个 Clip 首镜，账本方言 {result.get('dialect', 'none')}）", ""]
    if result.get("dialect") == "legacy":
        lines.append("提示：这份稿用的是老式 initial/events 账本，没有 facts/requirements——账本类检查不成立，屏幕位置只认结构化字段，不查正文措辞。")
        lines.append("")
    if not result["diagnostics"]:
        lines.append("没有告警。")
        return "\n".join(lines)
    lines.append(f"{len(result['diagnostics'])} 条告警（提示，不阻断）：")
    for item in result["diagnostics"]:
        lines.append(f"  [{item['code']}] {item['scope']}: {item['message']}")
    return "\n".join(lines)


def load(path):
    text = open(path, encoding="utf-8").read()
    if path.lower().endswith((".yaml", ".yml")):
        try:
            import yaml
        except ImportError as error:
            raise SystemExit("输入是 YAML 但环境没有 PyYAML；请先用 JSON 导出。") from error
        return yaml.safe_load(text)
    return json.loads(text)


def main(argv):
    if len(argv) < 2:
        raise SystemExit("用法: python spatial-lint.py <production.json|yaml> [--json]")
    result = spatial_lint(load(argv[1]))
    if "--json" in argv[2:]:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render_report(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
