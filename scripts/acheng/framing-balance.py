"""编译前景别分布体检：只诊断，不改源稿。

把"中景堆叠、近景太少、缺建立镜头"这类用户看片才发现的分布问题，提前到编译前报出来。
判据全部来自 `camera.framing`（七值枚举），不读正文、不猜叙事。
"""
import json
import sys
from collections import Counter

ORDER = ("EWS", "WS", "FS", "MS", "MCU", "CU", "ECU")
WIDE = ("EWS", "WS", "FS")
CLOSE = ("MCU", "CU", "ECU")

# 阈值按 EP2 返修实测取：修好后 CU18/MCU8/FS5/MS5/WS3/EWS1（40 镜）→ MS 12.5%、近景 65%。
# 这些是告警线不是门禁线，超了只提示，不阻断编译。
MEDIUM_MAX = 0.40          # 中景占比上限
CLOSE_MIN = 0.20           # 近景（MCU/CU/ECU）占比下限
SINGLE_MAX = 0.50          # 任一景别占比上限
SEGMENT_FLAT_MIN_SHOTS = 3  # 段内达到这个镜数且单一景别，算"段内节奏平"


def shots_of(production):
    """兼容正式制作稿与导演源稿两种形状，不猜字段。"""
    if isinstance(production.get("shots"), list):
        return production["shots"]
    director = production.get("director") or {}
    source = director.get("source") or {}
    if isinstance(source.get("shots"), list):
        return source["shots"]
    return []


def segments_of(production):
    if isinstance(production.get("segments"), list):
        return production["segments"]
    director = production.get("director") or {}
    source = director.get("source") or {}
    if isinstance(source.get("segments"), list):
        return source["segments"]
    return []


def _framing(shot):
    camera = shot.get("camera")
    if isinstance(camera, dict):
        value = camera.get("framing")
        if isinstance(value, str):
            return value.strip().upper()
    return ""


def framing_balance(production):
    shots = shots_of(production)
    segments = segments_of(production)
    counts = Counter()
    missing = []
    for shot in shots:
        value = _framing(shot)
        if value in ORDER:
            counts[value] += 1
        else:
            missing.append(str(shot.get("id") or "?"))
    total = sum(counts.values())
    ratios = {key: (counts[key] / total if total else 0.0) for key in ORDER}
    diagnostics = []

    def warn(code, scope, message):
        diagnostics.append({"code": code, "scope": scope, "message": message})

    if total == 0 and not missing:
        warn("FRAMING_NO_SHOTS", "production", "没有可统计的 Shot。")
        return {"total": 0, "counts": dict(counts), "ratios": ratios, "diagnostics": diagnostics}

    if missing:
        warn("FRAMING_MISSING", ",".join(missing[:20]),
             f"{len(missing)} 个 Shot 缺少合法 camera.framing（允许值 {'/'.join(ORDER)}）。"
             "未声明 storyboard_policy 的历史稿允许缺省，此时分布检查不成立，只报这一条。")

    if total == 0:
        return {"total": 0, "counts": dict(counts), "ratios": ratios, "diagnostics": diagnostics}

    if ratios["MS"] > MEDIUM_MAX:
        warn("FRAMING_MEDIUM_DOMINANT", "production",
             f"中景 MS 占 {ratios['MS']:.0%}（>{MEDIUM_MAX:.0%}）：情绪与关系镜头会平。"
             "用近景/反应镜替代一部分中景，而不是整体改小景别。")
    close_ratio = sum(ratios[key] for key in CLOSE)
    if close_ratio < CLOSE_MIN:
        warn("FRAMING_CLOSE_SHORTAGE", "production",
             f"近景 MCU/CU/ECU 合计仅 {close_ratio:.0%}（<{CLOSE_MIN:.0%}）：情绪点没有对应景别支撑。")
    if not any(counts[key] for key in WIDE):
        warn("FRAMING_NO_ESTABLISHING", "production",
             "全集没有任何 EWS/WS/FS：观众建立不了空间，站位问题也会更难读。")
    for key in ORDER:
        if ratios[key] > SINGLE_MAX:
            warn("FRAMING_SINGLE_DOMINANT", key,
                 f"单一景别 {key} 占 {ratios[key]:.0%}（>{SINGLE_MAX:.0%}）：整片节奏单一。")

    by_id = {str(shot.get("id")): shot for shot in shots}
    for segment in segments:
        ids = [str(item) for item in (segment.get("shot_ids") or [])]
        framed = [_framing(by_id[sid]) for sid in ids if sid in by_id and _framing(by_id[sid]) in ORDER]
        if len(framed) < SEGMENT_FLAT_MIN_SHOTS:
            continue
        unique = set(framed)
        if len(unique) == 1:
            warn("FRAMING_SEGMENT_FLAT", str(segment.get("id") or "?"),
                 f"该段 {len(framed)} 镜全部是 {framed[0]}：段内没有景别变化，切镜看不出节奏。")

    return {"total": total, "counts": dict(counts), "ratios": ratios, "diagnostics": diagnostics}


def render_report(result):
    lines = []
    total = result["total"]
    lines.append(f"景别分布（{total} 镜）")
    for key in ORDER:
        count = result["counts"].get(key, 0)
        ratio = result["ratios"].get(key, 0.0)
        bar = "#" * int(round(ratio * 40))
        lines.append(f"  {key:<4} {count:>3}  {ratio:>6.1%}  {bar}")
    lines.append("")
    if not result["diagnostics"]:
        lines.append("没有分布告警。")
        return "\n".join(lines)
    lines.append(f"{len(result['diagnostics'])} 条告警（不阻断编译，但建议进 120 复核前先处理）：")
    for item in result["diagnostics"]:
        lines.append(f"  [{item['code']}] {item['scope']}: {item['message']}")
    return "\n".join(lines)


def load(path):
    text = open(path, encoding="utf-8").read()
    if path.lower().endswith((".yaml", ".yml")):
        try:
            import yaml  # 可选依赖：只在输入是 YAML 时需要
        except ImportError as error:
            raise SystemExit("输入是 YAML 但环境没有 PyYAML；请先用 JSON 导出。") from error
        return yaml.safe_load(text)
    return json.loads(text)


def main(argv):
    if len(argv) < 2:
        raise SystemExit("用法: python framing-balance.py <production.json|yaml> [--json]")
    path = argv[1]
    result = framing_balance(load(path))
    if "--json" in argv[2:]:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render_report(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
