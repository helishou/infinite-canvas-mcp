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
def audit_continuity_v2(source, target_ids=None):
    if (source.get("prompt_assembly") or {}).get("version") == 2:
        from canvas_subject_prompt_v2 import audit_subject_continuity
        return audit_subject_continuity(source, target_ids)
    return continuity_module.audit(source, target_ids)

continuity_v2_contract = continuity_module.contract

RECIPES = ("portrait", "dark", "fantasy", "hard_surface", "ink", "monochrome", "product", "clean_slate", "style")
MODES = ("T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA")


def rows(value):
    return value if isinstance(value, list) else []


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
                "mode": {"type": "string", "enum": list(MODES)}, "mode_lock": {"type": "string"}, "mode_selection_reason": {"type": "string"},
                "subjects": {"type": "array", "items": {"type": "object", "properties": {
                    "label": {"type": "string", "pattern": "^<Subject [1-9][0-9]*>$"},
                    "entity_id": prose, "definition": prose, "retention": prose,
                    "shot_ids": {"type": "array", "minItems": 1, "items": prose}},
                    "required": ["label", "entity_id", "definition", "retention", "shot_ids"]}}
                }}},
            "shots": {"type": "array", "items": {"type": "object", "properties": {
                "prompt_contract_version": {"type": "integer", "enum": [2]},
                "identity_context": {"type": "object", "additionalProperties": prose},
                "offscreen_character_ids": {"type": "array", "items": {"type": "string"}},
                "camera": {"type": "object", "properties": {
                    "framing": {"type": "string", "enum": list(FRAMINGS)},
                    "angle": {"type": "string"},
                    "lens_mm": {"type": ["number", "null"], "exclusiveMinimum": 0},
                    "lens": {"type": ["number", "null"], "exclusiveMinimum": 0},
                    "movement": {"type": "string"},
                    "path": {"type": "string"},
                    "target": {"type": "string"},
                    "focus": {"type": "string"},
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
        "relationships": ["segments[].mode is an execution mode; missing modes are inferred from selected references, and lock/reason fields are optional metadata.", "Full creative and file contracts remain owned by Acheng audit/compiler; this schema covers Canvas source fields."],
        "templates": {"manual_storyboard_override": {"storyboard_policy": {"version": 1}, "camera": {"framing": "MCU", "attention_subject_ids": ["<registered subject id>"], "editorial_reason": "Read the speaker's strategy or listener's changing response."}}, "segment": {"mode": "Ref2VA", "mode_lock": "Ref2VA", "mode_selection_reason": "Use approved identity and scene references."}, "asset_card": {"recipe": "portrait"}, "style_scope": {"preserve_scope": ["Preserve the approved lighting and palette."], "exclude_scope": ["Do not copy the anchor subject identity."]}},
        "continuityLedger": continuity_v2_contract(),
        "storyboardPolicy": {"version": 1, "defaultForNewProductions": False, "dialogueCoverage": "Temporarily disabled: H3 compilation preserves authored camera design, dialogue text and timing without inserting speaker close-up/reverse/reaction cuts.", "manualOverrideCameraFields": ["framing", "attention_subject_ids", "editorial_reason"], "framingValues": list(FRAMINGS), "explicitManualOverride": "When version 1 is declared, enforce manual framing/attention/reason fields and validate only selected Shot/Segment structure in scoped compilation."},
        "modelPromptContract": {"version": 1,
            "subjects": "Ref2VA identity/character/scene/environment/prop references require one matching entity/source/Shot Subject. Frame and composition anchors may remain Pictures.",
            "continuity": "Replay snapshots remain report-only. Optional shots[].continuity_cues assert a registered local fact/value at start/end and provide complete model-facing description. Without cues, authored shot state/action remains the prose source.",
            "internalIds": "Registered fact/object/Shot/Segment IDs cannot appear in instructions; original dialogue and quoted visible text are preserved.",
            "semanticReview": "Structural acceptance does not verify natural-language agreement or visual quality."},
    }


def validate_subject_prompt_v2(source, stage="edit", validation_scope=None):
    issues = []
    def issue(path, message, target=None, severity=None):
        issues.append({"code": "INVALID_SUBJECT_SOURCE", "path": "director.source." + path, "targetId": target,
                       "message": message, "severity": severity or ("warning" if stage == "edit" else "error")})
    if not isinstance(source, dict) or source.get("prompt_assembly", {}).get("version") != 2:
        issue("prompt_assembly.version", "Subject Prompt v2 must explicitly declare version 2")
        return issues
    subjects = source.get("subject_registry") if isinstance(source.get("subject_registry"), list) else []
    shots = source.get("shots") if isinstance(source.get("shots"), list) else []
    scoped_shot_ids = set(map(str, validation_scope.get("shotIds", []))) if isinstance(validation_scope, dict) else set()
    if scoped_shot_ids:
        selected_utterance_ids = {
            str(ref.get("utteranceId"))
            for shot in shots if isinstance(shot, dict) and str(shot.get("id")) in scoped_shot_ids
            for ref in rows(shot.get("utterance_refs")) if isinstance(ref, dict) and ref.get("utteranceId")
        }
        scoped_shot_ids.update(
            str(shot.get("id")) for shot in shots if isinstance(shot, dict)
            and any(str(ref.get("utteranceId")) in selected_utterance_ids for ref in rows(shot.get("utterance_refs")) if isinstance(ref, dict))
        )
    scoped = bool(scoped_shot_ids)
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
    ledger_timelines = rows(ledger.get("timelines"))
    timeline_ids = [str(item.get("id")) for item in ledger_timelines if isinstance(item, dict) and item.get("id") is not None]
    default_timeline_id = "main" if "main" in timeline_ids else (timeline_ids[0] if timeline_ids else "main")
    timeline_by_shot, next_story_order = {}, {}
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            if not scoped:
                issue("shots." + str(index), "Shot must be an object")
            continue
        shot_id = str(shot.get("id") or "")
        if not shot_id or shot_id in shot_by_id:
            if not scoped or shot_id in scoped_shot_ids:
                issue("shots." + str(index) + ".id", "Shot IDs must be present and unique", shot_id or None)
            continue
        shot_by_id[shot_id] = shot
        position[shot_id] = index
        duration = shot.get("duration_frames")
        if (not scoped or shot_id in scoped_shot_ids) and (type(duration) is not int or duration <= 0):
            issue("shots." + shot_id + ".duration_frames", "Shot duration must be positive integer frames", shot_id)
        timeline_id = str(shot.get("timeline_id") or default_timeline_id)
        order = shot.get("story_order")
        if type(order) is not int or order < 0:
            order = next_story_order.get(timeline_id, 0)
            while (timeline_id, order) in order_keys:
                order += 1
        elif (timeline_id, order) in order_keys and (not scoped or shot_id in scoped_shot_ids):
            issue("shots." + shot_id, "Story order must be unique within its timeline", shot_id)
        order_keys.add((timeline_id, order))
        timeline_by_shot[shot_id] = timeline_id
        next_story_order[timeline_id] = max(next_story_order.get(timeline_id, 0), order + 1)
        if scoped and shot_id not in scoped_shot_ids:
            continue
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
                entity_ref = subject.get("entityRef") if isinstance(subject.get("entityRef"), dict) else {}
                selected = [str(value) for value in usage.get("pictureBindingIds", [])]
                if selected:
                    if any(binding_owner.get(value) != str(subject.get("id")) for value in selected):
                        issue("shots." + shot_id + ".subject_usages.pictureBindingIds", "Selected picture binding belongs to another Subject", shot_id)
                else:
                    if entity_ref.get("kind") == "scene":
                        continue
                    requirements = {str(item.get("factId")): str(item.get("value")) for item in usage.get("stateRequirements", [])}
                    purposes = usage.get("referencePurpose") or ["identity"]
                    for purpose in purposes:
                        eligible = [binding for binding in subject.get("pictureBindings", [])
                                    if str(purpose) in [str(value) for value in binding.get("provides", [])]
                                    and all(requirements.get(str(key)) == str(value) for key, value in (binding.get("applicableState") or {}).items())]
                        matches = [binding for binding in eligible
                                   if str(purpose) in [str(value) for value in binding.get("defaultFor", [])]]
                        fixed_results = [binding for binding in eligible
                                         if (binding.get("selection") or {}).get("mode") == "selected_result"]
                        if len(matches) != 1 and len(eligible) != 1 and not (not matches and len(fixed_results) == 1):
                            # Text prompts remain compilable as drafts while the image is
                            # unavailable. A real media submission still requires one
                            # unambiguous binding for each requested reference purpose.
                            issue("shots." + shot_id + ".subject_usages.pictureBindingIds", "Missing or ambiguous default binding for " + str(purpose), shot_id,
                                  severity="warning" if stage == "compile" else None)
        for frame in shot.get("keyframes", []) if isinstance(shot.get("keyframes"), list) else []:
            if frame.get("anchor") != "composition" and frame.get("requiredForSubmission", True) and str(frame.get("id")) not in binding_owner and not frame.get("sourceNode"):
                issue("shots." + shot_id + ".keyframes", "Required keyframe lacks a smart node binding", shot_id)
        for reference in shot.get("reference_requirements", []) if isinstance(shot.get("reference_requirements"), list) else []:
            if reference.get("requiredForSubmission", True) and (not reference.get("id") or not reference.get("asset_id") or not reference.get("asset_version") or not reference.get("purpose") or not reference.get("sourceNode")):
                issue("shots." + shot_id + ".reference_requirements", "Required composition reference lacks a stable source, version or purpose", shot_id)
    if scoped:
        for shot_id in sorted(scoped_shot_ids.difference(shot_by_id)):
            issue("shots." + shot_id, "Edited Shot does not exist in the source", shot_id)
    by_segment = {}
    selected_scope = source.get("_canvas_compilation_scope") if isinstance(source.get("_canvas_compilation_scope"), dict) else {}
    wanted = set(map(str, selected_scope.get("targetIds", [])))
    asset_targets = {
        str(item.get("asset_id") or item.get("id") or "")
        for item in source.get("asset_plan", []) if isinstance(item, dict)
    } | {
        str(item.get("id") or "")
        for item in source.get("asset_cards", []) if isinstance(item, dict)
    }
    partitioned = set()
    for index, segment in enumerate(segments):
        segment_id = str(segment.get("id") or "")
        ids = [str(value) for value in segment.get("shot_ids", [])]
        if scoped and not scoped_shot_ids.intersection(ids):
            continue
        if not ids or any(value not in position for value in ids):
            issue("segments." + str(index) + ".shot_ids", "Clip must contain known Shots", segment_id or None)
            continue
        offsets = [position[value] for value in ids]
        if offsets != list(range(offsets[0], offsets[0] + len(offsets))) or any(value in partitioned for value in ids):
            issue("segments." + segment_id + ".shot_ids", "Clip Shots must be an ordered contiguous partition", segment_id)
        if any(timeline_by_shot.get(value) != timeline_by_shot.get(ids[0]) for value in ids):
            issue("segments." + segment_id + ".shot_ids", "A Clip cannot cross story timelines", segment_id)
        partitioned.update(ids)
        by_segment[segment_id] = ids
        mode = str(segment.get("mode") or "")
        if mode and mode not in MODES:
            issue("segments." + segment_id + ".mode", "Clip generation mode is invalid", segment_id)
        elif not mode:
            issue("segments." + segment_id + ".mode", "Clip generation mode will be inferred from selected references", segment_id, severity="warning")
        if mode and segment.get("mode_lock") and segment.get("mode_lock") != mode:
            issue("segments." + segment_id + ".mode_lock", "Stored mode lock differs from the selected generation mode", segment_id, severity="warning")
    if not wanted:
        for shot_id in (scoped_shot_ids if scoped else shot_by_id):
            if shot_id not in partitioned:
                issue("shots." + shot_id, "Shot is not assigned to a Clip", shot_id)
    else:
        for target in wanted:
            # A mixed compilation scope may contain image-asset outputs as well as
            # video Clips. Asset targets are valid compile outputs; only Clip IDs
            # participate in the Shot partition check above.
            if target not in by_segment and target not in asset_targets:
                issue("segments", "Selected compilation target is neither a Clip nor a registered asset: " + target, target)
    if ledger.get("contract_version") != 2:
        issue("ledger", "Subject Prompt v2 requires the registered ledger v2")
    elif not scoped:
       replay = audit_continuity_v2(source)
       for diagnostic in replay.get("diagnostics", []):
            issues.append({**diagnostic, "severity": "warning"})
    for utterance in utterances:
        if scoped and not any(str(ref.get("utteranceId")) == str(utterance.get("id")) for shot in shots if isinstance(shot, dict) and str(shot.get("id")) in scoped_shot_ids for ref in rows(shot.get("utterance_refs")) if isinstance(ref, dict)):
            continue
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
    validation_scope = source.get("_canvas_source_validation_scope") if isinstance(source, dict) and isinstance(source.get("_canvas_source_validation_scope"), dict) else None
    selected_shot_ids = set(map(str, validation_scope.get("shotIds", []))) if validation_scope else set()
    if isinstance(source, dict) and source.get("prompt_assembly", {}).get("version") == 2:
        return validate_subject_prompt_v2(source, stage, validation_scope)
    issues = []
    def issue(path, message, target=None, missing=False):
        issues.append({"code": "SOURCE_INCOMPLETE" if missing else "INVALID_SOURCE", "path": "director.source." + path, "message": message, "severity": "warning" if missing and stage == "edit" else "error", **({"targetId": target} if target else {})})
    def warning(path, message, target=None):
        issues.append({"code": "INVALID_SOURCE", "path": "director.source." + path, "message": message, "severity": "warning", **({"targetId": target} if target else {})})
    def check(value, schema, path, target=None):
        kind = schema.get("type")
        declared_types = kind if isinstance(kind, list) else [kind]
        type_matches = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
                        "number": isinstance(value, (int, float)) and not isinstance(value, bool), "integer": isinstance(value, int) and not isinstance(value, bool),
                        "boolean": isinstance(value, bool), "null": value is None}
        valid_type = any(type_matches.get(expected, True) for expected in declared_types)
        if not valid_type:
            issue(path, "Expected " + " or ".join(str(expected) for expected in declared_types), target)
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
    source_schema = contract()["jsonSchema"]
    if selected_shot_ids:
        selected_shots = [shot for shot in rows(source.get("shots")) if isinstance(shot, dict) and str(shot.get("id")) in selected_shot_ids]
        check({"shots": selected_shots}, {"type": "object", "properties": {"shots": source_schema.get("properties", {}).get("shots", {})}}, "")
    else:
        check(source, source_schema, "")
    # The bridge is also imported while building the source-contract manifest.
    # Structural template generation needs no candidate-only dependencies.
    if isinstance(source, dict):
        from storyboard_policy import diagnostics
        selected_shots = ({sid for segment in source.get("segments", []) if isinstance(segment, dict) for sid in segment.get("shot_ids", [])}
                          if source.get("_canvas_compilation_scope") else selected_shot_ids or None)
        issues.extend({**item, "severity": "warning" if stage == "edit" else item["severity"]} for item in diagnostics(source, selected_shots))
        from canvas_model_contract import source_diagnostics
        issues.extend({**item, "severity": "warning" if stage == "edit" else item.get("severity", "error")} for item in source_diagnostics(source))
    continuity_issues = []
    if not selected_shot_ids and isinstance(source, dict) and isinstance(source.get("ledger"), dict) and source["ledger"].get("contract_version") == 2:
        report = audit_continuity_v2(source)
        for diagnostic in report["diagnostics"]:
            item = {**diagnostic, "severity": "warning" if stage == "edit" else "error"}
            continuity_issues.append(item)
    if isinstance(source, dict):
        for i, seg in enumerate(source.get("segments", []) if isinstance(source.get("segments", []), list) else []):
            if not isinstance(seg, dict):
                continue
            mode = str(seg.get("mode") or "")
            if mode and mode not in MODES:
                issue(f"segments.{i}.mode", "Clip generation mode is invalid", seg.get("id"))
            elif not mode:
                warning(f"segments.{i}.mode", "Clip generation mode will be inferred from selected references", seg.get("id"))
            if mode and seg.get("mode_lock") and seg["mode_lock"] != mode:
                warning(f"segments.{i}.mode_lock", "Stored mode lock differs from the selected generation mode", seg.get("id"))
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
        # 旧版前端兼容已移除：无标记草稿曾静默落入下方 legacy 校验。现在给出显式升级引导，
        # 只有完整标记的 Subject Prompt v2 源稿继续进入校验。（旧行为：无条件 issues = validate(...)）
        raw_assembly = source.get("prompt_assembly") if isinstance(source, dict) else None
        assembly = raw_assembly if isinstance(raw_assembly, dict) else {}
        raw_ledger = source.get("ledger") if isinstance(source, dict) else None
        ledger = raw_ledger if isinstance(raw_ledger, dict) else {}
        unsupported_message = "UNSUPPORTED_PRODUCTION_FORMAT: 当前制作台仅支持 Subject Prompt Assembly v2 与 Shot 局部帧账本 v2。请使用当前版 Acheng Director 升级后重新提交；原稿未修改。"
        if not isinstance(source, dict) or source.get("version") != 2:
            issues = [{"code": "UNSUPPORTED_PRODUCTION_FORMAT", "path": "director.source.version", "message": unsupported_message, "severity": "error"}]
        elif ledger.get("contract_version") != 2:
            issues = [{"code": "UNSUPPORTED_PRODUCTION_FORMAT", "path": "director.source.ledger.contract_version", "message": unsupported_message, "severity": "error"}]
        elif assembly.get("version") != 2:
            issues = [{"code": "UNSUPPORTED_PRODUCTION_FORMAT", "path": "director.source.prompt_assembly.version", "message": "UNSUPPORTED_PRODUCTION_FORMAT: 当前制作稿 v2 的 Prompt Assembly 结构不受支持。请使用当前版 Acheng Director 升级后重新提交；原稿未修改。", "severity": "error"}]
        else:
            issues = validate(source, request.get("stage", "edit"))
            # if assembly.get("version") == 2:  # v2 分支在上方门控后恒为真
            issues.extend(validate_prompt_source_maps(request.get("artifacts", [])))
            # 旧版编译产物校验（无标记 Segment 提示词回读）随旧稿兼容一并注释：
            # 能到达这里的源稿必然是完整 v2 标记，legacy h3 提示词回读不再需要。
            # elif isinstance(source, dict) and isinstance(source.get("segments", []), list):
            #     from h3_contract import detail_policy, english_word_count
            #     from h3_final_format import validate_h3_format
            #     segments = {s.get("id"): s for s in source.get("segments", []) if isinstance(s, "dict")}
            #     for index, artifact in enumerate(request.get("artifacts", [])):
            #         ... INVALID_ARTIFACT_TARGET / INVALID_COMPILED_PROMPT 回读循环 ...
        result = {"diagnostics": issues}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
