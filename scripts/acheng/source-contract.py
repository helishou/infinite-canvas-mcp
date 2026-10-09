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
    from storyboard_policy import FRAMINGS
    prose = {"type": "string", "minLength": 3, "pattern": r"^(?!\s*(?:TBD|TODO|unknown|待填|示例|\.\.\.|…|N/A)\s*$).+", "description": "At least three trimmed characters; concrete content, no placeholder."}
    return {
        "contractVersion": "2", "promptAssemblyVersions": [2], "ref2vaMaximumWords": None, "scopedCompilation": True,
        "jsonSchema": {"type": "object", "properties": {
            "storyboard_policy": {"type": "object", "properties": {"version": {"type": "integer", "enum": [1]}}, "required": ["version"]},
            "prompt_assembly": {"type": "object", "properties": {"version": {"type": "integer", "enum": [2]}}, "required": ["version"]},
            "subject_registry": {"type": "array", "items": {"type": "object", "required": ["id", "entityRef", "pictureBindings"]}},
            "utterances": {"type": "array", "items": {"type": "object", "required": ["id", "speakerSubjectId", "text", "start", "end"]}},
            "segments": {"type": "array", "items": {"type": "object", "properties": {
                "mode": {"type": "string", "enum": list(MODES)}, "mode_lock": {"type": "string", "enum": list(MODES)}, "mode_selection_reason": prose,
                "subjects": {"type": "array", "items": {"type": "object", "properties": {
                    "label": {"type": "string", "pattern": "^<Subject [1-9][0-9]*>$"},
                    "entity_id": prose, "definition": prose, "retention": prose,
                    "shot_ids": {"type": "array", "minItems": 1, "items": prose}},
                    "required": ["label", "entity_id", "definition", "retention", "shot_ids"]}}
                }, "required": ["mode", "mode_lock", "mode_selection_reason"]}},
            "shots": {"type": "array", "items": {"type": "object", "properties": {
                "prompt_contract_version": {"type": "integer", "enum": [2]},
                "identity_context": {"type": "object", "additionalProperties": prose},
                "offscreen_character_ids": {"type": "array", "items": {"type": "string"}},
                "camera": {"type": "object", "properties": {
                    "framing": {"type": "string", "enum": list(FRAMINGS)},
                    "attention_subject_ids": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                    "editorial_reason": prose}},
                "continuity_cues": {"type": "array", "items": {"type": "object", "properties": {
                    "fact_id": prose, "phase": {"type": "string", "enum": ["start", "end"]},
                    "value": prose, "description": prose}, "required": ["fact_id", "phase", "value", "description"]}}
            }}},
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
        "templates": {"manual_storyboard_override": {"storyboard_policy": {"version": 1}, "camera": {"framing": "MCU", "attention_subject_ids": ["<registered subject id>"], "editorial_reason": "Read the speaker's strategy or listener's changing response."}}, "segment": {"mode": "Ref2VA", "mode_lock": "Ref2VA", "mode_selection_reason": "Use approved identity and scene references."}, "asset_card": {"recipe": "portrait"}, "style_scope": {"preserve_scope": ["Preserve the approved lighting and palette."], "exclude_scope": ["Do not copy the anchor subject identity."]}},
        "continuityLedger": continuity_v2_contract(),
        "storyboardPolicy": {"version": 1, "defaultForNewProductions": False, "dialogueCoverage": "H3 compilation inserts speaker close-up/reverse coverage from authored dialogue timing and character visibility for legacy and new sources, without changing source Shot/Segment frames or dialogue text.", "manualOverrideCameraFields": ["framing", "attention_subject_ids", "editorial_reason"], "framingValues": list(FRAMINGS), "explicitManualOverride": "When version 1 is declared, enforce manual framing/attention/reason fields and validate only selected Shot/Segment structure in scoped compilation."},
        "modelPromptContract": {"version": 1,
            "subjects": "Ref2VA identity/character/scene/environment/prop references require one matching entity/source/Shot Subject. Frame and composition anchors may remain Pictures.",
            "continuity": "Replay snapshots remain report-only. Optional shots[].continuity_cues assert a registered local fact/value at start/end and provide complete model-facing description. Without cues, authored shot state/action remains the prose source.",
            "internalIds": "Registered fact/object/Shot/Segment IDs cannot appear in instructions; original dialogue and quoted visible text are preserved.",
            "semanticReview": "Structural acceptance does not verify natural-language agreement or visual quality."},
    }


def validate_subject_prompt_v2(source, stage="edit"):
    issues = []
    def issue(path, message, target=None):
        issues.append({"code": "INVALID_SUBJECT_SOURCE", "path": "director.source." + path, "targetId": target,
                       "message": message, "severity": "warning" if stage == "edit" else "error"})
    if not isinstance(source, dict) or source.get("prompt_assembly", {}).get("version") != 2:
        issue("prompt_assembly.version", "Subject Prompt v2 must explicitly declare version 2")
        return issues
    subjects = source.get("subject_registry") if isinstance(source.get("subject_registry"), list) else []
    shots = source.get("shots") if isinstance(source.get("shots"), list) else []
    segments = source.get("segments") if isinstance(source.get("segments"), list) else []
    utterances = source.get("utterances") if isinstance(source.get("utterances"), list) else []
    ledger = source.get("ledger") if isinstance(source.get("ledger"), dict) else {}
    subject_by_id = {str(item.get("id")): item for item in subjects if isinstance(item, dict)}
    if len(subject_by_id) != len(subjects):
        issue("subject_registry", "Subject IDs must be present and unique")
    binding_owner = {}
    for subject in subjects:
        subject_id = str(subject.get("id") or "")
        ref = subject.get("entityRef") if isinstance(subject.get("entityRef"), dict) else {}
        if not ref.get("kind") or not ref.get("id") or not ref.get("ownerId"):
            issue("subject_registry." + subject_id + ".entityRef", "Subject must reference one registered entity")
        for binding in subject.get("pictureBindings", []) if isinstance(subject.get("pictureBindings"), list) else []:
            binding_id = str(binding.get("id") or "")
            if not binding_id or binding_id in binding_owner:
                issue("subject_registry." + subject_id + ".pictureBindings", "Picture binding IDs must be globally unique")
            binding_owner[binding_id] = subject_id
    shot_by_id, position = {}, {}
    order_keys = set()
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            issue("shots." + str(index), "Shot must be an object")
            continue
        shot_id = str(shot.get("id") or "")
        if not shot_id or shot_id in shot_by_id:
            issue("shots." + str(index) + ".id", "Shot IDs must be present and unique", shot_id or None)
            continue
        shot_by_id[shot_id] = shot
        position[shot_id] = index
        duration = shot.get("duration_frames")
        if type(duration) is not int or duration <= 0:
            issue("shots." + shot_id + ".duration_frames", "Shot duration must be positive integer frames", shot_id)
        timeline_id, order = str(shot.get("timeline_id") or ""), shot.get("story_order")
        if not timeline_id or type(order) is not int or order < 0 or (timeline_id, order) in order_keys:
            issue("shots." + shot_id, "Shot timeline and story_order must be valid and unique", shot_id)
        order_keys.add((timeline_id, order))
        camera = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
        for field in ("framing", "editorial_reason"):
            if not str(camera.get(field) or "").strip():
                issue("shots." + shot_id + ".camera." + field, "Shot camera contract field is required", shot_id)
        if not isinstance(camera.get("attention_subject_ids"), list) or not camera["attention_subject_ids"]:
            issue("shots." + shot_id + ".camera.attention_subject_ids", "At least one registered attention Subject is required", shot_id)
        for usage in shot.get("subject_usages", []) if isinstance(shot.get("subject_usages"), list) else []:
            subject = subject_by_id.get(str(usage.get("subjectId") or ""))
            if not subject:
                issue("shots." + shot_id + ".subject_usages", "Shot references an unknown Subject", shot_id)
                continue
            if usage.get("presentation") == "visible":
                selected = [str(value) for value in usage.get("pictureBindingIds", [])]
                if selected:
                    if any(binding_owner.get(value) != str(subject.get("id")) for value in selected):
                        issue("shots." + shot_id + ".subject_usages.pictureBindingIds", "Selected picture binding belongs to another Subject", shot_id)
                else:
                    requirements = {str(item.get("factId")): str(item.get("value")) for item in usage.get("stateRequirements", [])}
                    purposes = usage.get("referencePurpose") or ["identity"]
                    for purpose in purposes:
                        matches = [binding for binding in subject.get("pictureBindings", [])
                                   if str(purpose) in [str(value) for value in binding.get("defaultFor", [])]
                                   and all(requirements.get(str(key)) == str(value) for key, value in (binding.get("applicableState") or {}).items())]
                        if len(matches) != 1:
                            issue("shots." + shot_id + ".subject_usages.pictureBindingIds", "Missing or ambiguous default binding for " + str(purpose), shot_id)
        for frame in shot.get("keyframes", []) if isinstance(shot.get("keyframes"), list) else []:
            if frame.get("requiredForSubmission") and str(frame.get("id")) not in binding_owner and not frame.get("sourceNode"):
                issue("shots." + shot_id + ".keyframes", "Required keyframe lacks a smart node binding", shot_id)
    by_segment = {}
    selected_scope = source.get("_canvas_compilation_scope") if isinstance(source.get("_canvas_compilation_scope"), dict) else {}
    wanted = set(map(str, selected_scope.get("targetIds", [])))
    partitioned = set()
    for index, segment in enumerate(segments):
        segment_id = str(segment.get("id") or "")
        ids = [str(value) for value in segment.get("shot_ids", [])]
        if not ids or any(value not in position for value in ids):
            issue("segments." + str(index) + ".shot_ids", "Clip must contain known Shots", segment_id or None)
            continue
        offsets = [position[value] for value in ids]
        if offsets != list(range(offsets[0], offsets[0] + len(offsets))) or any(value in partitioned for value in ids):
            issue("segments." + segment_id + ".shot_ids", "Clip Shots must be an ordered contiguous partition", segment_id)
        if any(shot_by_id[value].get("timeline_id") != shot_by_id[ids[0]].get("timeline_id") for value in ids):
            issue("segments." + segment_id + ".shot_ids", "A Clip cannot cross story timelines", segment_id)
        partitioned.update(ids)
        by_segment[segment_id] = ids
        mode = str(segment.get("mode") or "")
        if mode not in MODES or segment.get("mode_lock") != mode or not str(segment.get("mode_selection_reason") or "").strip():
            issue("segments." + segment_id, "Clip mode must be explicit, locked, and justified", segment_id)
    if not wanted:
        for shot_id in shot_by_id:
            if shot_id not in partitioned:
                issue("shots." + shot_id, "Shot is not assigned to a Clip", shot_id)
    else:
        for target in wanted:
            if target not in by_segment:
                issue("segments", "Selected compilation target is not a Clip: " + target, target)
    if ledger.get("contract_version") != 2:
        issue("ledger", "Subject Prompt v2 requires the registered ledger v2")
    else:
       replay = audit_continuity_v2(source)
       for diagnostic in replay.get("diagnostics", []):
            issues.append({**diagnostic, "severity": "warning"})
    for utterance in utterances:
        refs = sorted([(position.get(str(shot.get("id")), -1), ref, shot) for shot in shots
                       for ref in shot.get("utterance_refs", []) if str(ref.get("utteranceId")) == str(utterance.get("id"))],
                      key=lambda item: (item[0], int(item[1].get("localStartFrame", 0))))
        if not refs:
            issue("utterances." + str(utterance.get("id")), "Utterance must be referenced by Shot audio coverage")
            continue
        if refs[0][2].get("id") != utterance.get("start", {}).get("shotId") or refs[-1][2].get("id") != utterance.get("end", {}).get("shotId"):
            issue("utterances." + str(utterance.get("id")), "Utterance endpoints differ from Shot audio coverage")
        text_cursor = 0
        for order, (_position, ref, shot) in enumerate(refs):
            if int(ref.get("textStart", -1)) != text_cursor or int(ref.get("textEnd", 0)) <= text_cursor:
                issue("utterances." + str(utterance.get("id")), "Utterance text coverage has a gap or overlap")
            text_cursor = int(ref.get("textEnd", 0))
            if order < len(refs) - 1 and int(ref.get("localEndFrame", 0)) != int(shot.get("duration_frames", 0)):
                issue("utterances." + str(utterance.get("id")), "Dialogue must continue to the Shot cut boundary")
        if text_cursor != len(str(utterance.get("text") or "")):
            issue("utterances." + str(utterance.get("id")), "Shot audio coverage must preserve the complete utterance text")
        clip_ids = {segment_id for segment_id, ids in by_segment.items() if any(str(shot.get("id")) in ids for _pos, _ref, shot in refs)}
        if len(clip_ids) != 1:
            issue("utterances." + str(utterance.get("id")), "A complete utterance must remain within one Clip")
    return issues


def validate(source, stage="edit"):
    from audit_storyboard_quality import substantive
    if isinstance(source, dict) and source.get("prompt_assembly", {}).get("version") == 2:
        return validate_subject_prompt_v2(source, stage)
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
            issue(path, "Allowed values: " + ", ".join(map(str, schema["enum"])), target)
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
    # The bridge is also imported while building the source-contract manifest.
    # Structural template generation needs no candidate-only dependencies.
    if isinstance(source, dict):
        from storyboard_policy import diagnostics
        selected_shots = {sid for segment in source.get("segments", []) if isinstance(segment, dict) for sid in segment.get("shot_ids", [])} if source.get("_canvas_compilation_scope") else None
        issues.extend({**item, "severity": "warning" if stage == "edit" else item["severity"]} for item in diagnostics(source, selected_shots))
        from canvas_model_contract import source_diagnostics
        issues.extend({**item, "severity": "warning" if stage == "edit" else item.get("severity", "error")} for item in source_diagnostics(source))
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


def _utf16_slice(value, start, end):
    output, units, begin = [], 0, None
    for char in value:
        width = 2 if ord(char) > 0xFFFF else 1
        if units == start:
            begin = len(output)
        if units >= end:
            break
        output.append(char)
        units += width
    if units == start:
        begin = len(output)
    if begin is None or units != end:
        return None
    return "".join(output[begin:])


def validate_prompt_source_maps(artifacts):
    import hashlib
    issues = []
    for index, artifact in enumerate(artifacts if isinstance(artifacts, list) else []):
        if not isinstance(artifact, dict) or artifact.get("kind") != "h3" or artifact.get("status") != "ready":
            continue
        target = str(artifact.get("targetId") or "")
        prompt = artifact.get("prompt") if isinstance(artifact.get("prompt"), str) else ""
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        source_map = (artifact.get("receipt") or {}).get("sourceMap")
        def fail(message):
            issues.append({"code": "PROMPT_SOURCE_MAP_INVALID", "path": f"director.artifacts.{index}.receipt.sourceMap",
                           "targetId": target, "message": message, "severity": "error"})
        if not isinstance(source_map, dict) or source_map.get("version") != 1 or source_map.get("offsetUnit") != "utf16":
            fail("A ready Subject Prompt v2 artifact requires SourceMap version 1 with UTF-16 offsets.")
            continue
        if source_map.get("segmentId") != target or source_map.get("sourceHash") != artifact.get("sourceHash") or source_map.get("promptHash") != prompt_hash or artifact.get("sha256") != prompt_hash:
            fail("SourceMap identity, source hash or prompt hash differs from the compiled artifact.")
            continue
        entries = source_map.get("entries")
        if not isinstance(entries, list):
            fail("SourceMap entries must be an array.")
            continue
        ordered = sorted(entries, key=lambda item: (item.get("start", -1), item.get("end", -1)) if isinstance(item, dict) else (-1, -1))
        last_end = -1
        for entry in ordered:
            if not isinstance(entry, dict):
                fail("SourceMap entry must be an object.")
                continue
            start, end = entry.get("start"), entry.get("end")
            source_start, source_end = entry.get("sourceStart"), entry.get("sourceEnd")
            if type(start) is not int or type(end) is not int or start < 0 or end <= start or end > len(prompt.encode("utf-16-le")) // 2:
                fail("SourceMap output span is outside the prompt.")
                continue
            output_text = _utf16_slice(prompt, start, end)
            source_value = entry.get("sourceValue") if isinstance(entry.get("sourceValue"), str) else ""
            source_text = entry.get("sourceText") if isinstance(entry.get("sourceText"), str) else ""
            expected_source = _utf16_slice(source_value, source_start, source_end) if type(source_start) is int and type(source_end) is int and source_start >= 0 and source_end >= source_start else None
            if output_text != source_text or expected_source != source_text:
                fail("SourceMap span text does not exactly match its output and source field.")
            if start < last_end:
                fail("SourceMap output spans overlap.")
            last_end = end
            if entry.get("sourceKind") not in ("shot", "utterance") or entry.get("field") not in ("visual", "action", "audio", "camera.editorial_reason", "text"):
                fail("SourceMap entry points to an unsupported source kind or field.")
    return issues


def main():
    request = json.load(sys.stdin)
    if request.get("action") == "contract":
        result = contract()
    else:
        source = request.get("source")
        issues = validate(source, request.get("stage", "edit"))
        if isinstance(source, dict) and source.get("prompt_assembly", {}).get("version") == 2:
            issues.extend(validate_prompt_source_maps(request.get("artifacts", [])))
        elif isinstance(source, dict) and isinstance(source.get("segments", []), list):
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
                    from canvas_model_contract import check_source_and_text
                    check_source_and_text(source, seg, artifact["prompt"])
                    policy = detail_policy(source, seg)
                    validate_h3_format(artifact["prompt"], mode=seg["mode"], shot_count=len(seg.get("shot_ids", [])), reference_labels=[r["label"] for r in artifact.get("references", [])], subject_labels=[r["label"] for r in seg.get("subjects", [])], minimum_words=policy["minimum_words"] if seg["mode"] == "Ref2VA" else 0, duration_seconds=float(Fraction(str(seg["generation_clip_duration"]))))
                except (ValueError, KeyError, TypeError) as error:
                    issues.append({"code": "INVALID_COMPILED_PROMPT", "path": f"director.artifacts.{index}.prompt", "targetId": artifact.get("targetId"), "message": str(error), "severity": "error"})
        result = {"diagnostics": issues}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
