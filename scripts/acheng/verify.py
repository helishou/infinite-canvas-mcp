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
    assert 2200 <= policy["minimum_words"] <= policy["target_words"] <= 2900, policy
    assert policy["maximum_words"] is None
assert detail_policy({"shots": []}, {"generation_clip_duration": 15})["minimum_words"] == 2900
assert english_word_count("中文 hello world") == 2
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
issues = validate({"segments": [{"mode": "Ref2VA", "mode_lock": True}], "asset_cards": [{"recipe": "invented"}], "style_lock": {"preserve_scope": "lighting", "exclude_scope": ["x"]}})
assert any(i["path"].endswith("mode_lock") and i["severity"] == "error" for i in issues)
assert any(i["path"].endswith("recipe") for i in issues)
assert any(i["path"].endswith("exclude_scope.0") for i in issues)
assert "STYLE_MOTHER must be the final uploaded reference slot" in (root / "scripts/style_anchor.py").read_text(encoding="utf-8")
assert "@图片1" not in (root / "SKILL.md").read_text(encoding="utf-8")
print("Canvas Acheng compatibility: PASS")
