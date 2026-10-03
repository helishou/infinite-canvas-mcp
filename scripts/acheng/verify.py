"""Behavior probes for the upstream/overlay interface; no generation calls."""
import sys
from pathlib import Path
import tempfile

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "scripts"))
from h3_contract import detail_policy, english_word_count
from h3_final_format import validate_h3_file

for seconds in (4, 10, 14, 15):
    policy = detail_policy({"shots": []}, {"generation_clip_duration": seconds})
    assert 2200 <= policy["minimum_words"] <= policy["target_words"] <= 2900, policy
assert detail_policy({"shots": []}, {"generation_clip_duration": 15})["minimum_words"] == 2900
assert english_word_count("中文 hello world") == 2
with tempfile.TemporaryDirectory() as tmp:
    prompt = Path(tmp) / "probe.h3.txt"
    prompt.write_text("detailed_description:\n" + "word " * 2901, encoding="utf-8")
    try:
        validate_h3_file(prompt, {"mode": "Ref2VA", "duration_seconds": 15,
                                 "minimum_words": 2900, "speech_expectations": [], "references": []})
        raise AssertionError("oversized prompt accepted")
    except ValueError as error:
        assert "exceeds 2900" in str(error), str(error)
assert "STYLE_MOTHER must be the final uploaded reference slot" in (root / "scripts/style_anchor.py").read_text(encoding="utf-8")
assert "@图片1" not in (root / "SKILL.md").read_text(encoding="utf-8")
print("Canvas Acheng compatibility: PASS")
