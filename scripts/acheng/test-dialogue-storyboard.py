"""Validate an isolated dialogue redesign against its frozen source; no media submission."""
import hashlib
import json
from pathlib import Path
import sys

runtime, directory = map(Path, sys.argv[1:3])
sys.path.insert(0, str(runtime / "scripts"))
from audit_storyboard_quality import compile_segment
from storyboard_policy import diagnostics
from h3_final_format import file_contract, validate_h3_file
from canvas_source_contract import validate, contract

p = json.loads((directory / "production.json").read_text(encoding="utf-8"))
baseline = json.loads((directory / "baseline.json").read_text(encoding="utf-8"))
assert contract()["templates"]["storyboard_policy"] == {"version": 1}
issues = validate(p, "publish")
assert not [d for d in issues if d["severity"] == "error"], issues
report = {"scope": "isolated-source-and-compiled-prompts", "visualStatus": "UNVERIFIED", "diagnostics": issues, "segments": []}
for segment, original in zip(p["segments"], baseline["shots"]):
    selected = [s for s in p["shots"] if s["id"] in segment["shot_ids"]]
    expected = [(d["character_id"], d["text"], d["start"], d["end"]) for d in original["dialogues"]]
    actual = [(d["character_id"], d["text"], s["start_frame"] - segment["start_frame"] + d["start"], s["start_frame"] - segment["start_frame"] + d["end"]) for s in selected for d in s["dialogues"]]
    assert actual == expected, (actual, expected)
    assert segment["end_frame"] - segment["start_frame"] == original["end_frame"] - original["start_frame"]
    prompt = compile_segment(p, segment)
    file = directory / (segment["id"] + ".h3.txt")
    file.write_text(prompt, encoding="utf-8")
    refs = segment["references"]
    for ref in refs:
        assert hashlib.sha256(Path(ref["file"]).read_bytes()).hexdigest() == ref["sha256"]
    receipt = validate_h3_file(file, file_contract(p, segment, refs))
    report["segments"].append({"id": segment["id"], "shots": [{"id": s["id"], "framing": s["camera"]["framing"], "startFrame": s["start_frame"] - segment["start_frame"], "endFrame": s["end_frame"] - segment["start_frame"]} for s in selected], "dialoguePreserved": True, "receipt": receipt})
(directory / "compile-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"status": "PASSED", "segments": len(report["segments"]), "shots": len(p["shots"]), "visualStatus": "UNVERIFIED"}))
