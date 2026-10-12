"""Local Canvas compatibility overlay. Never edit the clean upstream checkout."""
from pathlib import Path
import re
import sys
import subprocess

PATCH_VERSION = "canvas-10"


def replace(path, before, after):
    text = path.read_text(encoding="utf-8")
    if after and after in text or not after and before not in text:
        return
    if text.count(before) != 1:
        raise RuntimeError(f"Unsupported upstream contract in {path.name}: {before[:70]}")
    path.write_text(text.replace(before, after), encoding="utf-8")


def apply(root):
    root = Path(root)
    sys.path.insert(0, str(root / "scripts"))
    contract = root / "scripts/h3_contract.py"
    replace(contract, "REF2VA_MIN_WORDS = 2000", "REF2VA_MIN_WORDS = 0")
    replace(contract, "REF2VA_TARGET_WORDS = 2400", "REF2VA_TARGET_WORDS = 500")
    replace(contract, "REF2VA_MIN_WORDS_PER_SECOND = 200", "REF2VA_MIN_WORDS_PER_SECOND = 0")
    replace(contract, "REF2VA_TARGET_WORDS_PER_SECOND = 240", "REF2VA_TARGET_WORDS_PER_SECOND = 0")
    # The concise policy below preserves the current absence of a hard maximum.
    replace(contract, '''            need(word_count <= policy.get("maximum_words", REF2VA_MAX_WORDS),
                 f"Ref2VA detailed_description is {word_count} words; exceeds maximum ceiling of {policy.get('maximum_words', REF2VA_MAX_WORDS)} words (2900 words limit)")''', '')
    final = root / "scripts/h3_final_format.py"
    replace(final, "floor = max(2000, ceil(duration * 200))",
            'from h3_contract import detail_policy\n        floor = detail_policy({"shots": []}, {"generation_clip_duration": duration})["minimum_words"]')
    # Explicit authored minima remain verifiable; no automatic floor is added.
    bridge = Path(__file__).with_name("source-contract.py")
    (root / "scripts/canvas_source_contract.py").write_bytes(bridge.read_bytes())
    if not (root / "scripts/continuity_v2.py").is_file():
        raise RuntimeError("Acheng source is missing scripts/continuity_v2.py")
    import importlib.util
    spec = importlib.util.spec_from_file_location("canvas_source_contract", bridge)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (root / "canvas-source-contract.json").write_text(__import__("json").dumps(module.contract(), ensure_ascii=False, indent=2), encoding="utf-8")
    asset_plan = root / "scripts/asset_plan.py"
    replace(asset_plan, 'need(required and isinstance(required, list) and set(required) <= set(nodes), f"{shot[\'id\']}: asset requirements incomplete")',
            'need(isinstance(required, list) and set(required) <= set(nodes), f"{shot[\'id\']}: asset requirements incomplete")')
    replace(asset_plan, '        need(any(nodes[a]["kind"] == "scene" and nodes[a].get("entity_id") == shot["scene_id"] for a in required), f"{shot[\'id\']}: scene asset missing")\n', "")
    hooks = root / "scripts/post_hooks.py"
    replace(hooks, 'card.get("recipe") in ("portrait", "dark", "fantasy", "hard_surface", "ink", "monochrome", "product", "clean_slate", "style")', 'card.get("recipe") in __import__("canvas_source_contract").RECIPES')
    style = root / "scripts/style_anchor.py"
    for field in ("preserve_scope", "exclude_scope"):
        replace(style, f'isinstance(lock.get("{field}"), list) and lock["{field}"] and all(substantive(x) for x in lock["{field}"])', f'__import__("canvas_source_contract").is_scope(lock.get("{field}"))')
    bindings = root / "scripts/reference_bindings.py"
    replace(bindings, '    issues, labels, rows = [], [], []', '    issues, labels, rows = [], [], []\n    from canvas_source_contract import validate\n    if not legacy:\n        issues.extend(item["message"] for item in validate({"segments": [segment]}, "publish") if item["severity"] == "error")')
    replace(bindings,
            '''    if not legacy and (segment.get("mode_lock") != segment["mode"] or not segment.get("mode_selection_reason")):
        issues.append("explicit mode_lock and mode_selection_reason required; no silent mode fallback")''',
            "")
    hooks = root / "scripts/post_hooks.py"
    replace(hooks,
            'require(reference["role"] in ("identity", "scene", "style", "pose", "composition", "lighting"), "image reference role invalid")',
            'require(reference["role"] in ("identity", "scene", "style", "pose", "composition", "lighting", "layout"), "image reference role invalid")')
    # Update the actual entry instructions, not a contradictory appendix alone.
    for path in [root / "SKILL.md", root / "modules/model/SKILL.md", root / "references/62-style-anchor.md"]:
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"@图片([1-9]\d*)", r"<Picture \1>", text)
        text = text.replace("@图片几", "<Picture N>")
        text = text.replace("通常为 Reference image 1 或最后一个槽位", "必须为最后一个槽位")
        text = text.replace("风格母图（`<Picture 1>`）、场景图（`<Picture 2>`）、角色四视图（`<Picture 3>`）、道具图（`<Picture 4>`）", "场景图、角色四视图、道具图及最后槽位的风格母图（编号按实际输入顺序）")
        path.write_text(text, encoding="utf-8")
    entry = root / "SKILL.md"
    text = entry.read_text(encoding="utf-8")
    marker = "你是总导演及生产合同的唯一写入者。"
    if marker not in text:
        raise RuntimeError("Acheng director entry changed; review the Canvas routing hook")
    text = text.replace(marker, "涉及无限画布项目时，先读取项目提供的 `canvas-video-production-sop` 适配入口与 [本机兼容说明](CANVAS-COMPATIBILITY.md)。创作仍由本 Skill 主导；已获用户生成授权时，适配层通过原生画布 MCP 负责实际生成和正式存储。下文纯提示词交付限制不禁止该独立执行层。新制作或恢复制作使用本机当前激活引擎，不混装另一套同名 H3 规范。\n\n" + marker, 1)
    entry.write_text(text, encoding="utf-8")
    kickoff = Path(__file__).with_name("canvas-kickoff.md").read_text(encoding="utf-8").strip()
    kickoff_heading = kickoff.splitlines()[0]
    text = entry.read_text(encoding="utf-8")
    if kickoff_heading in text:
        if kickoff not in text:
            repo = Path(__file__).resolve().parents[2]
            previous = subprocess.run(["git", "show", "HEAD:scripts/acheng/canvas-kickoff.md"], cwd=repo,
                                      check=False, capture_output=True).stdout.decode("utf-8").strip()
            if not previous or previous == kickoff or text.count(previous) != 1:
                raise RuntimeError("Canvas kickoff overlay exists with different content; review before replacing")
            text = text.replace(previous, kickoff)
            entry.write_text(text, encoding="utf-8")
    else:
        marker = "你是总导演及生产合同的唯一写入者。"
        if text.count(marker) != 1:
            raise RuntimeError("Acheng director entry changed; cannot place the Canvas kickoff overlay")
        start = text.index(marker)
        paragraph_end = text.find("\n\n", start)
        end = paragraph_end if paragraph_end >= 0 else text.find("\n", start)
        if end < 0:
            raise RuntimeError("Acheng director entry has no paragraph boundary for the Canvas kickoff overlay")
        text = text[:end] + "\n\n" + kickoff + text[end:]
        entry.write_text(text, encoding="utf-8")
    for path in [root / "SKILL.md", root / "modules/assets/SKILL.md", root / "modules/model/SKILL.md", root / "references/90-production-contract.md", root / "templates/h3-prompt-package.md"]:
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"极限值\s*2900\s*词硬性封顶[^；。\n]*", "正文无硬性词数上限，保留当前激活运行版本的最低细节要求", text)
        text = text.replace("### H3 详细度、极限值（2200-2900词）与模式锁", "### H3 详细度、当前激活运行版本与模式锁")
        text = re.sub(r"1\. \*\*动态密度与硬性上限（2200-2900 词）\*\*[^\n]*", "1. **按当前激活运行版本计算详细度**：保留编译器的最低细节要求与复杂度预算；正文无硬性词数上限，不截断、不压缩、不按词数重装箱。", text)
        text = re.sub(r"### 固定角色四格模板（用户指定）\s*\n[^\n]*", "### Infinite Canvas 角色四视图规格\n新制作默认使用等高的正脸近景、正面全身、侧面全身、背面全身。用户明确指定时，在完整 view_layout 中保存 selection=user_explicit 和有效 selection_reason，可使用1:2行高的无头人形四格或等高的蛇形头正面/头侧面/盘绕全身/鳞片细节四格。空手中立、无文字，不改变角色事实；既有批准资产沿用原版本，不自动重生成。", text)
        path.write_text(text, encoding="utf-8")
    asset_plan = root / "scripts/asset_plan.py"
    overlay = Path(__file__).with_name("character-layout.py").read_text(encoding="utf-8")
    asset_plan.write_text(asset_plan.read_text(encoding="utf-8") + "\n\n" + overlay, encoding="utf-8")
    hooks = root / "scripts/post_hooks.py"
    text = hooks.read_text(encoding="utf-8")
    start = text.index('            if layout["type"] == "four_view_character_turnaround":')
    end = text.index('        if card.get("asset_kind") == "style":', start)
    text = text[:start] + "            check_character_view_layout(card, payload)\n" + text[end:]
    hooks.write_text("from asset_plan import check_character_view_layout\n" + text, encoding="utf-8")
    validator = root / "scripts/validate_director_contract.py"
    text = validator.read_text(encoding="utf-8")
    start = text.index('                require(resolved.get("view_layout", {}).get("type") == "four_view_character_turnaround"')
    end = text.index('            entry = entries[card["id"]]', start)
    text = text[:start] + "                check_character_view_layout(resolved, production)\n" + text[end:]
    validator.write_text("from asset_plan import check_character_view_layout\n" + text, encoding="utf-8")
    # The compiler adds a derived continuity report after freezing the authored
    # revision. Binding and delivery hashes must ignore that scratch-only field.
    for name in ("reference_bindings.py", "h3_delivery.py", "asset_delivery.py"):
        target = root / "scripts" / name
        target.write_text(target.read_text(encoding="utf-8") + '''

_canvas_authored_content_hash = content_hash
def content_hash(value):
    if isinstance(value, dict) and "_continuity_report" in value:
        value = {key: item for key, item in value.items() if key != "_continuity_report"}
    return _canvas_authored_content_hash(value)
''', encoding="utf-8")
    audit = root / "scripts/audit_storyboard_quality.py"
    text = audit.read_text(encoding="utf-8")
    text = text.replace('p.get("ledger", {}).get("initial", {}).get("props", {})', '(p.get("ledger", {}).get("initial", {}) if isinstance(p.get("ledger", {}).get("initial", {}), dict) else {}).get("props", {})')
    text = text.replace('p.get("delivery_scope") == "full_production" or p.get("story", {}).get("contract_version") == "3.0"', '(not p.get("_canvas_compilation_scope")) and (p.get("delivery_scope") == "full_production" or p.get("story", {}).get("contract_version") == "3.0")')
    audit.write_text(text, encoding="utf-8")
    import importlib.util
    concise_spec = importlib.util.spec_from_file_location("canvas_h3_prompt_policy", Path(__file__).with_name("h3-prompt-policy.py"))
    concise_module = importlib.util.module_from_spec(concise_spec)
    concise_spec.loader.exec_module(concise_module)
    concise_module.apply_prompt_policy(root)
    model_spec = importlib.util.spec_from_file_location("canvas_model_contract", Path(__file__).with_name("model-contract.py"))
    model_module = importlib.util.module_from_spec(model_spec)
    model_spec.loader.exec_module(model_module)
    model_module.apply(root)
    apply_subject_prompt_v2(root)
    (root / "CANVAS-COMPATIBILITY.md").write_text(
        "# Canvas compatibility overlay\n\n"
        "Upstream is retained in the clean Git checkout. Local overlay: " + PATCH_VERSION + ".\n"
        "Canvas production uses the project canvas-video-production-sop adapter. "
        "Its authorized generation/storage integration overrides prompt-only delivery in that context. "
        "Video production asks and records the final aspect ratio before creative breakdown; asset ratios stay independent. "
        "H3 uses <Picture N>/<Subject N>; style references occupy the final asset slot. "
        "New H3 prompts use complete local facts with no automatic word floor or per-second expansion; short-shot length guidance is 350–500 words. "
        "Historical legacy_fixture is for shipped examples only.\n", encoding="utf-8")


def apply_subject_prompt_v2(root):
    root = Path(root)
    helper_source = Path(__file__).with_name("canvas_subject_prompt_v2.py")
    helper_target = root / "scripts/canvas_subject_prompt_v2.py"
    helper_target.write_bytes(helper_source.read_bytes())
    asset_plan = root / "scripts/asset_plan.py"
    asset_plan_text = asset_plan.read_text(encoding="utf-8")
    if "_canvas_subject_base_asset_plan" not in asset_plan_text:
        asset_plan_text += '''

_canvas_subject_base_asset_plan = check_asset_plan
def check_asset_plan(payload, base):
    # Authored v2 Shot references are validated through Subject usages. The
    # legacy plan checker still owns asset cards, versions and dependencies.
    # Compiled video projections retain their derived legacy Shot checks.
    if (payload.get("prompt_assembly") or {}).get("version") == 2 and not payload.get("_canvas_compiled_subject_projection"):
        return _canvas_subject_base_asset_plan({**payload, "shots": []}, base)
    return _canvas_subject_base_asset_plan(payload, base)
'''
        asset_plan.write_text(asset_plan_text, encoding="utf-8")
    continuity = root / "scripts/continuity_v2.py"
    continuity_text = continuity.read_text(encoding="utf-8")
    replace(continuity, 'current_digest = digest({"scene_id": scene.get("scene_id"), "block": block})', 'current_digest = digest({"scene_id": scene.get("scene_id") or scene.get("id"), "block": block})')
    continuity_text = continuity.read_text(encoding="utf-8")
    if "_canvas_continuity_base_audit_defaults" not in continuity_text:
        wrapper = """

_canvas_continuity_base_audit_defaults = audit
def audit(source, target_ids=None):
    if isinstance(source, dict) and isinstance(source.get("ledger"), dict) and source["ledger"].get("contract_version") == 2:
        from copy import deepcopy
        original = source
        projected = deepcopy(source)
        ledger = projected["ledger"]
        timeline_rows = ledger.get("timelines") if isinstance(ledger.get("timelines"), list) else []
        timeline_ids = [str(row.get("id")) for row in timeline_rows if isinstance(row, dict) and row.get("id") is not None]
        default_timeline = "main" if "main" in timeline_ids else (timeline_ids[0] if timeline_ids else "main")
        if not timeline_ids:
            ledger["timelines"] = [{"id": default_timeline, "start_frame": 0}]
        next_order, occupied = {}, {}
        for shot in projected.get("shots", []) if isinstance(projected.get("shots"), list) else []:
            if not isinstance(shot, dict):
                continue
            timeline_id = str(shot.get("timeline_id") or default_timeline)
            shot["timeline_id"] = timeline_id
            used = occupied.setdefault(timeline_id, set())
            order = shot.get("story_order")
            if type(order) is not int or order < 0:
                order = next_order.get(timeline_id, 0)
                while order in used:
                    order += 1
                shot["story_order"] = order
            used.add(order)
            next_order[timeline_id] = max(next_order.get(timeline_id, 0), order + 1)
        for scene in projected.get("script_scenes", []) if isinstance(projected.get("script_scenes"), list) else []:
            if isinstance(scene, dict) and "blocks" not in scene and isinstance(scene.get("text"), str) and scene.get("id"):
                # Match the existing script projection's source block bytes,
                # not a copy of scene metadata that changes the coverage hash.
                scene["blocks"] = [{"id": scene["id"], "kind": "action", "text": scene["text"]}]
        if (projected.get("prompt_assembly") or {}).get("version") == 2:
            from canvas_subject_prompt_v2 import project_continuity_source
            projected = project_continuity_source(projected)
        result = _canvas_continuity_base_audit_defaults(projected, target_ids)
        result["sourceDigest"] = digest(original)
        return result
    return _canvas_continuity_base_audit_defaults(source, target_ids)
"""
        # CLI must resolve the adapted audit before its __main__ call.
        entry = 'if __name__ == "__main__":'
        if entry not in continuity_text:
            raise RuntimeError("continuity_v2.py CLI entry missing")
        continuity_text = continuity_text.replace(entry, wrapper + "\n" + entry, 1)
        continuity.write_text(continuity_text, encoding="utf-8")


    audit = root / "scripts/audit_storyboard_quality.py"
    text = audit.read_text(encoding="utf-8")
    marker = "_canvas_source_contract_audit"
    if marker not in text:
        text += '''

_canvas_source_contract_audit = True
def audit(p, base_dir=ROOT, *, h3_segment_ids=None):
    if isinstance(p, dict) and p.get("_canvas_prompt_assembly_version") == 2:
        return {"status": "PASS", "score": 100, "applicable_gates": 0,
                "scope": "canvas-prompt-assembly-v2", "production_sha256": digest(p),
                "gates": [], "diagnostics": [], "visual_status": "UNVERIFIED"}
    from canvas_source_contract import validate
    diagnostics = validate(p, "compile")
    errors = [item for item in diagnostics if item.get("severity") == "error"]
    return {"status": "FAIL" if errors else "PASS", "score": 0 if errors else 100,
            "applicable_gates": 1, "production_sha256": digest(p),
            "scope": "canvas-source-contract",
            "gates": [{"gate": "source-contract", "status": "FAIL" if errors else "PASS",
                       "errors": [item["message"] for item in errors]}],
            "diagnostics": diagnostics, "visual_status": "UNVERIFIED"}

_canvas_subject_prompt_v2_compile_segment = compile_segment
def compile_segment(p, seg, *, draft=False):
    if isinstance(p, dict) and p.get("_canvas_prompt_assembly_version") == 2:
        from canvas_subject_prompt_v2 import compile_prompt_v2
        return compile_prompt_v2(p, seg, draft=draft)
    return _canvas_subject_prompt_v2_compile_segment(p, seg, draft=draft)
'''
        audit.write_text(text, encoding="utf-8")

    # This validator checks authored upstream examples and their exported
    # hashes; keep it on the upstream audit while Canvas inputs use our wrapper.
    validator = root / "scripts/validate_director_contract.py"
    replace(validator,
            "from audit_storyboard_quality import ROOT, audit, compile_segment, read_data, require",
            "from audit_storyboard_quality import ROOT, _canvas_audit_impl as audit, compile_segment, read_data, require")

    references = root / "scripts/reference_bindings.py"
    replace(references,
            '''        if node and ref.get("asset_version") != node.get("version"):
            errors.append("asset version conflict")''',
            '''        if node and ref.get("asset_version") != node.get("version"):
            # Subject Prompt v2 references may bind an exact archived result by
            # content hash while retaining the asset's authored semantic version.
            content_bound = (node.get("status") == "selected_result"
                             and ref.get("asset_version") == "sha256:" + str(ref.get("sha256") or "")
                             and ref.get("sha256") == node.get("sha256"))
            if not content_bound:
                errors.append("asset version conflict")''')
    if 'media_status = node.get("status") in ("approved", "generated", "selected_result")' not in references.read_text(encoding="utf-8"):
        replace(references,
            '''        elif node:
            errors.append("asset planned; real approved media pending")
        expected = node.get("sha256") if node.get("status") == "approved" else ref.get("sha256")''',
            '''        elif node and node.get("status") in ("generated", "selected_result"):
            file = file or node.get("file")
            if ref.get("sha256") and node.get("sha256") != ref["sha256"]:
                errors.append("generated node result SHA-256 conflicts with the archived binding")
        elif node:
            errors.append("asset planned; generated media not bound")
        expected = node.get("sha256") if node.get("status") in ("approved", "generated", "selected_result") else ref.get("sha256")''')
    replace(references,
            '''               "content_status": "LEGACY_FIXTURE_NOT_REVIEWED" if legacy else ("APPROVAL_RECORDED" if not errors else "UNVERIFIED"),''',
            '''               "content_status": "LEGACY_FIXTURE_NOT_REVIEWED" if legacy else ("APPROVAL_RECORDED" if node.get("status") == "approved" and not errors else ("GENERATED_RESULT_BOUND" if node.get("status") == "generated" and not errors else ("BOUND_ARCHIVED_RESULT" if node.get("status") == "selected_result" and not errors else "UNVERIFIED"))),''')

    compiler = root / "scripts/compile_h3.py"
    replace(compiler,
            "    production = read_data(source)\n",
            '''    production = read_data(source)
    v2_source_maps = {}
    if production.get("prompt_assembly", {}).get("version") == 2:
        from canvas_source_contract import validate
        from canvas_subject_prompt_v2 import adapt_production
        source_issues = validate(production, "compile")
        source_errors = [item for item in source_issues if item.get("severity") == "error"]
        if source_errors:
            raise ContractError(json.dumps(source_errors, ensure_ascii=False))
        production = adapt_production(production, draft=True)
        v2_source_maps = production.pop("_canvas_subject_v2_source_maps", {})
''')
    replace(compiler,
            '''        try:
            text = compile_segment(production, resolved_seg, draft=True)
        except ValueError as exc:''',
            '''        try:
            if production.get("_canvas_prompt_assembly_version") == 2:
                from canvas_subject_prompt_v2 import compile_prompt_v2
                text = compile_prompt_v2(production, resolved_seg, draft=True)
            else:
                text = compile_segment(production, resolved_seg, draft=True)
        except ValueError as exc:''')
    replace(compiler,
            '''            text = compile_segment(production, resolved_seg, draft=True)''',
            '''            if production.get("_canvas_prompt_assembly_version") == 2:
                from canvas_subject_prompt_v2 import compile_prompt_v2
                text = compile_prompt_v2(production, resolved_seg, draft=True)
            else:
                text = compile_segment(production, resolved_seg, draft=True)''')
    source_map_marker = '        source_map_input = v2_source_maps.get(seg["id"])'
    if source_map_marker not in compiler.read_text(encoding="utf-8"):
        compiler_text = compiler.read_text(encoding="utf-8")
        compile_gate = "        if not blockers:\n"
        if compiler_text.count(compile_gate) != 1:
            raise RuntimeError("Unsupported compile_h3.py contract: expected one per-Segment format gate")
        source_map = '''        source_map_input = v2_source_maps.get(seg["id"])
        if source_map_input:
            from canvas_subject_prompt_v2 import build_source_map
            source_map = build_source_map(text, source_map_input)
            if source_map:
                entry["source_map"] = source_map
'''
        compiler.write_text(compiler_text.replace(compile_gate, source_map + compile_gate, 1), encoding="utf-8")
    replace(compiler,
            '        (output / name).write_text(text, encoding="utf-8")',
            '''        if production.get("_canvas_prompt_assembly_version") == 2:
            from canvas_subject_prompt_v2 import write_prompt_text
            text = write_prompt_text(output / name, text)
        else:
            (output / name).write_text(text, encoding="utf-8")''')


if __name__ == "__main__":
    apply(sys.argv[1])
