"""Read-only diagnostics using the production's pinned Acheng validators."""
import copy
import json
from pathlib import Path
import sys


def diagnose(runtime, source):
    base = Path(runtime).resolve()
    sys.path.insert(0, str(base / "scripts"))
    import asset_plan
    import style_anchor
    import post_hooks
    from audit_storyboard_quality import audit, ContractError
    from prompt_delivery import render_asset_prompt

    issues = []
    seen = set()

    def add(message, path, target=None, code="COMPILE_SOURCE_INVALID", severity="error", example=None):
        key = (code, path, str(message))
        if key in seen:
            return
        seen.add(key)
        issues.append({"code": code, "path": "director.source." + path,
                       **({"targetId": target} if target else {}), "message": str(message),
                       "severity": severity, **({"example": example} if example is not None else {}),
                       "nextAction": {"action": "correct_source", "message": "补齐此字段或绑定后重新预检；不要原样重试编译。"}})

    def check(callback, path, target=None, example_for_error=None):
        try:
            callback()
        except (ContractError, ValueError, TypeError, KeyError, IndexError, AttributeError, OSError, ZeroDivisionError) as error:
            add(error, path, target, example=example_for_error(str(error)) if example_for_error else None)

    if source.get("segments"):
        if not isinstance(source["segments"], list):
            add("视频段落必须为数组", "segments")
            return issues
        # The existing --draft compiler preserves incomplete references and audit blockers.
        # Surface those as draft diagnostics; do not turn them into a new compilation gate.
        for index, segment in enumerate(source["segments"]):
            if not isinstance(segment, dict):
                add("视频段落必须为对象", f"segments.{index}")
                continue
            for field in ("id", "mode", "generation_clip_duration", "start_frame", "end_frame"):
                if field not in segment:
                    add("视频段落编译字段缺失", f"segments.{index}.{field}", str(segment.get("id") or ""))
        if source.get("asset_cards"):
            def style_check():
                policy = style_anchor.style_policy_report(source, base, strict=True)
                if policy.get("status") == "BLOCKED":
                    raise ContractError(policy["reason"])
            check(style_check, "style_lock")
        report = audit(source, base)
        for gate in report.get("gates", []):
            for error in gate.get("errors", []):
                add(error, "segments", code="COMPILE_VIDEO_DRAFT", severity="warning")
        return issues

    cards = source.get("asset_cards")
    if not isinstance(cards, list) or not cards:
        add("当前没有可编译的资产卡或视频段落；剧本阶段先完成资产提示词卡。", "asset_cards", code="COMPILE_STAGE_NOT_READY")
        return issues

    # Use the pinned plan's own kinds/prose rules, and expose each missing field together.
    plans = source.get("asset_plan") or []
    if isinstance(plans, list):
        for index, node in enumerate(plans):
            if not isinstance(node, dict):
                add("资产计划项必须为对象", f"asset_plan.{index}")
                continue
            target = str(node.get("id") or node.get("asset_id") or "")
            if not isinstance(node.get("kind"), str) or node["kind"] not in asset_plan.KINDS:
                add("资产类别缺失或无效", f"asset_plan.{index}.kind", target)
            if not isinstance(node.get("version"), str) or not node["version"].strip():
                add("资产版本不能为空", f"asset_plan.{index}.version", target)
            if not asset_plan.prose(node.get("purpose")):
                add("资产用途缺失或不完整", f"asset_plan.{index}.purpose", target,
                    example={"purpose": "锁定此资产的身份、形态与材质，为后续镜头提供一致参考。"})
        if plans:
            check(lambda: asset_plan.check_asset_plan(source, base), "asset_plan")
    check(lambda: style_anchor.check_style_lock(source, base), "style_lock")
    check(lambda: style_anchor.style_policy_report(source, base, strict=True), "style_policy")

    anchor_id = (source.get("style_lock") or {}).get("anchor_asset_id") if isinstance(source.get("style_lock"), dict) else None
    lock = source.get("style_lock") or {}
    # Report declared binding shape independently of an incomplete anchor plan.
    # The pinned validator remains authoritative for media and cross-asset rules.
    if anchor_id and isinstance(plans, list) and isinstance(lock.get("apply_to_kinds"), list):
        for index, node in enumerate(plans):
            if not isinstance(node, dict) or node.get("id") == anchor_id or node.get("kind") not in lock["apply_to_kinds"]:
                continue
            target = str(node.get("id") or "")
            dependencies = node.get("depends_on") or []
            if not isinstance(dependencies, list) or anchor_id not in dependencies:
                add("缺少风格母图依赖", f"asset_plan.{index}.depends_on", target, "STYLE_DEPENDENCY_MISSING")
            card_index = next((i for i, item in enumerate(cards) if isinstance(item, dict) and item.get("id") == target), None)
            if card_index is not None:
                refs = cards[card_index].get("references")
                refs = refs if isinstance(refs, list) else []
                style_refs = [ref for ref in refs if isinstance(ref, dict) and ref.get("asset_id") == anchor_id and ref.get("role") == "style"]
                if len(style_refs) != 1 or style_refs[0].get("asset_version") != lock.get("anchor_version"):
                    add("风格参考或版本缺失", f"asset_cards.{card_index}.references", target, "STYLE_REFERENCE_MISSING")
    for index, card in enumerate(cards):
        if not isinstance(card, dict):
            add("资产提示词卡必须为对象", f"asset_cards.{index}")
            continue
        target = str(card.get("id") or "")
        def prompt_example(message):
            refs = card.get("references", [])
            if message == "reference_policy must explicitly be none or required" and isinstance(refs, list):
                return {"reference_policy": "required" if refs else "none"}
            if isinstance(refs, list):
                for slot, ref in enumerate(refs, 1):
                    if not isinstance(ref, dict):
                        continue
                    examples = {
                        "subject": "该槽位已登记的资产主体与视觉特征",
                        "preserve": "仅继承此参考明确登记的外观与材质特征",
                        "exclude": "不继承参考构图、动作及未登记的主体身份",
                    }
                    for field, value in examples.items():
                        if message == f"reference image {slot}: {field} description required":
                            repaired = copy.deepcopy(refs)
                            repaired[slot - 1][field] = value
                            return {"references": repaired}
            return None
        check(lambda: asset_plan.resolve_card(card, source, base, True), f"asset_cards.{index}.references", target)
        check(lambda: render_asset_prompt(card, source.get("prompt_bindings"), source.get("style_lock")), f"asset_cards.{index}.prompt", target, prompt_example)
        if anchor_id and isinstance(plans, list):
            scoped = copy.deepcopy(source)
            scoped["asset_plan"] = [node for node in plans if isinstance(node, dict) and node.get("id") in (anchor_id, target)]
            scoped["asset_cards"] = [item for item in cards if isinstance(item, dict) and item.get("id") in (anchor_id, target)]
            check(lambda: style_anchor.check_style_lock(scoped, base), f"asset_cards.{index}.references", target)
    # Keep the original full validator authoritative for cross-asset and transaction checks.
    check(lambda: post_hooks.check_assets(source, base, True), "asset_cards")
    return issues


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    print(json.dumps({"diagnostics": diagnose(sys.argv[1], payload["source"])}, ensure_ascii=False))
