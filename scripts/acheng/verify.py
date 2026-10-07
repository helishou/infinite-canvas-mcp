"""Behavior probes for the upstream/overlay interface; no generation calls."""
import sys
from pathlib import Path
import tempfile

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "scripts"))
from h3_contract import detail_policy, english_word_count
from h3_final_format import validate_h3_file, file_contract
from audit_storyboard_quality import compile_segment, read_data
import hashlib
from canvas_source_contract import contract, validate

for seconds in (4, 10, 14, 15):
    policy = detail_policy({"shots": []}, {"generation_clip_duration": seconds})
    assert policy["minimum_words"] == 0 and policy["target_words"] == 500, policy
    assert policy["recommended_words"] == [350, 500], policy
    assert policy["maximum_words"] is None
assert detail_policy({"shots": []}, {"generation_clip_duration": 15})["minimum_words_per_second"] == 0
assert english_word_count("中文 hello world") == 2
import copy
import json
from h3_contract import check_h3_semantics
from h3_final_format import validate_h3_format
from audit_storyboard_quality import audit
from orchestrator_plan import plan

# Preserve the full authored combat request while defining its repeated
# identity and environment once. Shortness never authorizes truncation.
concise = read_data(root / "examples/01-mecha.production.json")
concise.pop("prompt_detail_policy", None)
for segment in concise["segments"]:
    segment.pop("prompt_detail_policy", None)
segment = concise["segments"][0]
before = copy.deepcopy(concise)
short_text = compile_segment(concise, segment)
check_h3_semantics(concise, segment, short_text)
assert concise == before
assert "Write this shot" not in short_text and "For every shot, explicitly state" not in short_text
body = short_text.split("detailed_description:\n", 1)[1].split("\n\noverall_soundscape:", 1)[0]
assert english_word_count(body) > 0
for character in concise["character_registry"]:
    assert short_text.count(character["prompt_description"]) == 1
for scene in concise["scene_registry"]:
    assert short_text.count(scene["prompt_description"]) == 1
for shot in concise["shots"]:
    assert shot["visual"] in short_text and shot["state_description"] in short_text
    assert shot["camera"]["path"] in short_text
    for line in shot["dialogues"]:
        assert line["text"] in short_text
assert all(g["status"] != "FAIL" for g in audit(concise, root / "examples")["gates"])
nodes = plan({"request_id": "concise-probe", "intent": "h3"}, concise)["nodes"]
assert all(n["h3_min_words"] == 0 for n in nodes if n.get("phase") == "model" and n.get("segment_id"))
with tempfile.TemporaryDirectory() as directory:
    output = Path(directory) / "short.h3.txt"
    output.write_text(short_text, encoding="utf-8")
    references = [{**ref, "file": str((root / "examples" / ref["file"]).resolve()),
                   "sha256": hashlib.sha256((root / "examples" / ref["file"]).read_bytes()).hexdigest()}
                  for ref in segment["references"]]
    receipt = validate_h3_file(output, file_contract(concise, segment, references))
    assert receipt["format_pass"] == "PASSED" and receipt["minimum_words"] == 0
    assert output.read_text(encoding="utf-8") == short_text
    broken = short_text.replace("<Picture 1>", "<Picture 9>")
    try:
        validate_h3_format(broken, mode="Ref2VA", shot_count=2, reference_labels=["<Picture 1>"], duration_seconds=14)
        raise AssertionError("invalid reference passed concise format validation")
    except ValueError:
        pass
    # The first authored shot is a complete seven-second observation request.
    # Compile it independently to exercise acceptance below the former floor.
    local = copy.deepcopy(segment)
    local["shot_ids"] = [concise["shots"][0]["id"]]
    local["end_frame"] = concise["shots"][0]["end_frame"]
    local["generation_clip_duration"] = 7
    local.pop("panels", None)
    for ref in local["references"]:
        for key in ("definition", "retention"):
            ref[key] = ref[key].replace(" and [Shot 2]", "")
    local_text = compile_segment(concise, local)
    local_body = local_text.split("detailed_description:\n", 1)[1].split("\n\noverall_soundscape:", 1)[0]
    assert 0 < english_word_count(local_body) < 2200
    check_h3_semantics(concise, local, local_text)
    output.write_text(local_text, encoding="utf-8")
    local_contract = file_contract(concise, local, references)
    local_receipt = validate_h3_file(output, local_contract)
    assert local_receipt["format_pass"] == "PASSED" and local_receipt["minimum_words"] == 0
drama = read_data(root / "examples/02-drama.production.json")
for segment in drama["segments"]:
    text = compile_segment(drama, segment)
    for shot in drama["shots"]:
        if shot["id"] in segment["shot_ids"]:
            for line in shot["dialogues"]:
                assert f'<d>[{line["language"]}] {line["text"]}</d>' in text
explicit = detail_policy({"prompt_detail_policy": {"ref2va_min_words": 700}}, {"generation_clip_duration": 4})
assert explicit["minimum_words"] == 700 and explicit["target_words"] >= 700
with tempfile.TemporaryDirectory() as tmp:
    prompt = Path(tmp) / "probe.h3.txt"
    production = read_data(root / "examples/01-mecha.production.json")
    segment = production["segments"][0]
    text = compile_segment(production, segment)
    refs = []
    for ref in segment["references"]:
        media = (root / "examples" / ref["file"]).resolve()
        refs.append(dict(label=ref["label"], file=str(media), role=ref["role"], sha256=hashlib.sha256(media.read_bytes()).hexdigest()))
    receipt_contract = file_contract(production, segment, refs)
    receipt_contract.update(profile="strict", minimum_words=2900)
    for count in (2901, 6500):
        expanded = text.replace("\n\noverall_soundscape:", "\n" + "authored " * count + "\n\noverall_soundscape:")
        prompt.write_text(expanded, encoding="utf-8")
        before = prompt.read_bytes()
        receipt = validate_h3_file(prompt, receipt_contract)
        assert receipt["english_words"] > 2900
        assert prompt.read_bytes() == before
    prompt.write_text(text, encoding="utf-8")
    body = text.split("detailed_description:\n", 1)[1].split("\n\noverall_soundscape:", 1)[0]
    receipt_contract["minimum_words"] = english_word_count(body) + 1
    try:
        validate_h3_file(prompt, receipt_contract)
        raise AssertionError("insufficient detail accepted")
    except ValueError as error:
        assert "minimum" in str(error), str(error)
assert detail_policy({"shots": []}, {"generation_clip_duration": 10, "prompt_detail_policy": {"ref2va_max_words": 100, "ref2va_target_words": 6000}})["target_words"] == 6000
assert contract()["ref2vaMaximumWords"] is None
assert contract()["scopedCompilation"] is True
issues = validate({"segments": [{"mode": "Ref2VA", "mode_lock": True}], "asset_cards": [{"recipe": "invented"}], "style_lock": {"preserve_scope": "lighting", "exclude_scope": ["x"]}})
assert any(i["path"].endswith("mode_lock") and i["severity"] == "error" for i in issues)
assert any(i["path"].endswith("recipe") for i in issues)
assert any(i["path"].endswith("exclude_scope.0") for i in issues)
assert "STYLE_MOTHER must be the final uploaded reference slot" in (root / "scripts/style_anchor.py").read_text(encoding="utf-8")
skill = (root / "SKILL.md").read_text(encoding="utf-8")
assert "固定角色四格模板（用户指定）" not in skill
assert "动态密度与硬性上限（2200-2900 词）" not in skill
from asset_plan import DEFAULT_CHARACTER_VIEW_LAYOUT
assert DEFAULT_CHARACTER_VIEW_LAYOUT["views"] == ["front_face_above_clavicle", "front_full_body", "side_full_body", "back_full_body"]
assert "@图片1" not in skill
assert "Infinite Canvas 集成：视频制作启动确认" in skill
assert "videoAspectRatioConfirmed=true" in skill
assert "Infinite Canvas 集成：制作内容语言" in skill
assert "display_summary" in skill
asset_skill = (root / "modules/assets/SKILL.md").read_text(encoding="utf-8")
assert "固定角色四格模板（用户指定）" not in asset_skill
assert "selection=user_explicit" in asset_skill
import copy
from asset_plan import prepare_asset_card, check_character_view_layout, _canvas_legacy_character_layout
layout_payload = {"asset_plan": [{"id": "CHAR_PROBE", "kind": "character", "status": "planned", "version": "v1"}]}
layout_card = {"id": "CHAR_PROBE", "asset_kind": "character", "character_name": "A documented character",
               "state_label": "neutral_identity", "prompt": "Preserve the documented subject facts.", "seven_steps": [{"step": 1, "content": "The documented subject."}]}
default_card = prepare_asset_card(layout_card, layout_payload)
check_character_view_layout(default_card, layout_payload)
assert prepare_asset_card(default_card, layout_payload) == default_card
headless_card = copy.deepcopy(layout_card)
headless_card["view_layout"] = {**copy.deepcopy(_canvas_legacy_character_layout), "selection": "user_explicit",
                               "selection_reason": "The user explicitly selected the original headless costume board."}
creature_card = copy.deepcopy(layout_card)
creature_card["view_layout"] = {"type": "four_view_creature_turnaround", "views": ["front_head", "side_head", "coiled_full_body", "mid_body_scale_detail"],
                              "order": "grid_2x2", "row_height_ratio": [1, 1], "same_subject": True,
                              "purpose": "Reference the documented creature anatomy.", "selection": "user_explicit",
                              "selection_reason": "The user explicitly retained the original snake views."}
for authored in (headless_card, creature_card):
    before = copy.deepcopy(authored)
    prepared = prepare_asset_card(authored, layout_payload)
    check_character_view_layout(prepared, layout_payload)
    assert authored == before
    assert prepare_asset_card(prepared, layout_payload) == prepared
    if authored is creature_card:
        assert "headless" not in prepared["prompt"] and "costume full body" not in prepared["prompt"]
for invalid in (
    {**layout_card, "prompt": "Create a headless costume board."},
    {**headless_card, "view_layout": {**headless_card["view_layout"], "selection_reason": ""}},
    {**headless_card, "view_layout": {**headless_card["view_layout"], "row_height_ratio": [1, 1]}},
    {**headless_card, "view_layout": {**headless_card["view_layout"], "views": ["invented"]}},
    {**headless_card, "prompt": "Use four equal panels."},
):
    try:
        prepare_asset_card(invalid, layout_payload)
        raise AssertionError("invalid explicit or conflicting layout accepted")
    except ValueError:
        pass
print("Canvas Acheng compatibility: PASS")
