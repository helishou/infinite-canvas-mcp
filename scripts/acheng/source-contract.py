"""Versioned Canvas source contract. Structural checks never open media paths."""
import json
import re
import sys
from pathlib import Path
from fractions import Fraction
import importlib.util

continuity_path = Path(__file__).with_name("continuity_v2.py")
if not continuity_path.is_file():
    repository = Path(__file__).resolve().parents[2]
    continuity_path = repository / ".agents/skills/acheng-director/scripts/continuity_v2.py"
continuity_spec = importlib.util.spec_from_file_location("continuity_v2", continuity_path)
continuity_module = importlib.util.module_from_spec(continuity_spec)
sys.modules["continuity_v2"] = continuity_module
continuity_spec.loader.exec_module(continuity_module)
audit_continuity_v2, continuity_v2_contract = continuity_module.audit, continuity_module.contract

RECIPES = ("portrait", "dark", "fantasy", "hard_surface", "ink", "monochrome", "product", "clean_slate", "style")
MODES = ("T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA")


def is_scope(value):
    from audit_storyboard_quality import substantive
    return isinstance(value, list) and bool(value) and all(substantive(x) for x in value)


def contract():
    prose = {"type": "string", "minLength": 3, "pattern": r"^(?!\s*(?:TBD|TODO|unknown|待填|示例|\.\.\.|…|N/A)\s*$).+", "description": "At least three trimmed characters; concrete content, no placeholder."}
    return {
        "contractVersion": "2", "ref2vaMaximumWords": None, "scopedCompilation": True,
        "jsonSchema": {"type": "object", "properties": {
            "segments": {"type": "array", "items": {"type": "object", "properties": {
                "mode": {"type": "string", "enum": list(MODES)}, "mode_lock": {"type": "string", "enum": list(MODES)}, "mode_selection_reason": prose}, "required": ["mode", "mode_lock", "mode_selection_reason"]}},
            "asset_cards": {"type": "array", "items": {"type": "object", "properties": {
                "recipe": {"type": "string", "enum": list(RECIPES)},
                "view_layout": {"type": "object", "properties": {
                    "selection": {"type": "string", "enum": ["user_explicit"]},
                    "selection_reason": prose,
                    "type": {"type": "string", "enum": ["four_view_character_turnaround", "four_view_creature_turnaround"]},
                }},
            }, "required": ["recipe"]}},
            "style_lock": {"type": "object", "properties": {field: {"type": "array", "minItems": 1, "items": prose} for field in ("preserve_scope", "exclude_scope")}, "required": ["preserve_scope", "exclude_scope"]}}},
        "relationships": ["segments[].mode_lock must equal mode", "Full creative and file contracts remain owned by Acheng audit/compiler; this schema covers Canvas source fields."],
        "templates": {"segment": {"mode": "Ref2VA", "mode_lock": "Ref2VA", "mode_selection_reason": "Use approved identity and scene references."}, "asset_card": {"recipe": "portrait"}, "style_scope": {"preserve_scope": ["Preserve the approved lighting and palette."], "exclude_scope": ["Do not copy the anchor subject identity."]}},
        "continuityLedger": continuity_v2_contract(),
    }


def validate(source, stage="edit"):
    from audit_storyboard_quality import substantive
    issues = []
    def issue(path, message, target=None, missing=False):
        issues.append({"code": "SOURCE_INCOMPLETE" if missing else "INVALID_SOURCE", "path": "director.source." + path, "message": message, "severity": "warning" if missing and stage == "edit" else "error", **({"targetId": target} if target else {})})
    def check(value, schema, path, target=None):
        kind = schema.get("type")
        valid_type = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str)}.get(kind, True)
        if not valid_type:
            issue(path, "Expected " + kind, target)
            return
        if "enum" in schema and value not in schema["enum"]:
            issue(path, "Allowed values: " + ", ".join(schema["enum"]), target)
        if kind == "string" and "minLength" in schema and not substantive(value):
            issue(path, "Concrete text of at least three trimmed characters required; placeholders are invalid", target)
        if kind == "array":
            if len(value) < schema.get("minItems", 0):
                issue(path, "Nonempty array required", target)
            for i, item in enumerate(value):
                check(item, schema["items"], f"{path}.{i}", item.get("id") if isinstance(item, dict) else target)
        if kind == "object":
            for field in schema.get("required", []):
                if field not in value:
                    issue(f"{path}.{field}".strip("."), "Required field missing", target, missing=True)
            for field, child in schema.get("properties", {}).items():
                if field in value:
                    check(value[field], child, f"{path}.{field}".strip("."), target)
    check(source, contract()["jsonSchema"], "")
    continuity_issues = []
    if isinstance(source, dict) and isinstance(source.get("ledger"), dict) and source["ledger"].get("contract_version") == 2:
        report = audit_continuity_v2(source)
        for diagnostic in report["diagnostics"]:
            item = {**diagnostic, "severity": "warning" if stage == "edit" else "error"}
            continuity_issues.append(item)
    if isinstance(source, dict):
        for i, seg in enumerate(source.get("segments", []) if isinstance(source.get("segments", []), list) else []):
            if isinstance(seg, dict) and "mode_lock" in seg and "mode" in seg and seg["mode_lock"] != seg["mode"]:
                issue(f"segments.{i}.mode_lock", "mode_lock must equal mode", seg.get("id"))
    return issues + continuity_issues


def main():
    request = json.load(sys.stdin)
    if request.get("action") == "contract":
        result = contract()
    else:
        source = request.get("source")
        issues = validate(source, request.get("stage", "edit"))
        if isinstance(source, dict) and isinstance(source.get("segments", []), list):
            from h3_contract import detail_policy, english_word_count
            from h3_final_format import validate_h3_format
            segments = {s.get("id"): s for s in source.get("segments", []) if isinstance(s, dict)}
            for index, artifact in enumerate(request.get("artifacts", [])):
                if artifact.get("kind") != "h3" or artifact.get("status") != "ready":
                    continue
                seg = segments.get(artifact.get("targetId"))
                if not seg:
                    issues.append({"code": "INVALID_ARTIFACT_TARGET", "path": f"director.artifacts.{index}.targetId", "targetId": artifact.get("targetId"), "message": "Compiled Segment is not registered", "severity": "error"})
                    continue
                try:
                    policy = detail_policy(source, seg)
                    validate_h3_format(artifact["prompt"], mode=seg["mode"], shot_count=len(seg.get("shot_ids", [])), reference_labels=[r["label"] for r in artifact.get("references", [])], subject_labels=[r["label"] for r in seg.get("subjects", [])], minimum_words=policy["minimum_words"] if seg["mode"] == "Ref2VA" else 0, duration_seconds=float(Fraction(str(seg["generation_clip_duration"]))))
                except (ValueError, KeyError, TypeError) as error:
                    issues.append({"code": "INVALID_COMPILED_PROMPT", "path": f"director.artifacts.{index}.prompt", "targetId": artifact.get("targetId"), "message": str(error), "severity": "error"})
        result = {"diagnostics": issues}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
