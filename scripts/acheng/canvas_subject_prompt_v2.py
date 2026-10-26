"""Compiler-owned projection from Subject Prompt v2 source to the existing H3 delivery contract."""
from collections import defaultdict
from copy import deepcopy
from fractions import Fraction
import importlib.util
import json
import re
import sys
from pathlib import Path

_continuity_path = Path(__file__).with_name("continuity_v2.py")
if not _continuity_path.is_file():
    _continuity_path = Path(__file__).resolve().parents[2] / ".agents" / "skills" / "acheng-director" / "scripts" / "continuity_v2.py"
_runtime_scripts = _continuity_path.parent
if str(_runtime_scripts) not in sys.path:
    sys.path.insert(0, str(_runtime_scripts))
if _continuity_path.is_file() and "continuity_v2" not in sys.modules:
    _continuity_spec = importlib.util.spec_from_file_location("continuity_v2", _continuity_path)
    _continuity_module = importlib.util.module_from_spec(_continuity_spec)
    sys.modules["continuity_v2"] = _continuity_module
    _continuity_spec.loader.exec_module(_continuity_module)


def rows(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def string_rows(value):
    return [item for item in value if isinstance(item, str) and item] if isinstance(value, list) else []


def _canvas_node_entity_id(source_node, fallback=""):
    source_node = source_node if isinstance(source_node, dict) else {}
    project_id = str(source_node.get("projectId") or "")
    node_id = str(source_node.get("nodeId") or "")
    if project_id and node_id:
        return "canvas-node:" + json.dumps([project_id, node_id], ensure_ascii=False, separators=(",", ":"))
    return str(fallback or "")


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def write_prompt_text(path, text):
    """Write the exact LF bytes used by SourceMap offsets and prompt hashes."""
    normalized = str(text).replace("\r\n", "\n")
    Path(path).write_bytes(normalized.encode("utf-8"))
    return normalized


def entity_text(source, subject):
    ref = subject.get("entityRef", {})
    entity_id = str(ref.get("id", ""))
    registry = {"character": "character_registry", "scene": "scene_registry", "asset": "asset_plan"}.get(ref.get("kind"), "asset_plan")
    row = next((item for item in rows(source.get(registry)) if str(item.get("id") or item.get("asset_id") or "") == entity_id), {})
    name = str(row.get("name") or row.get("asset_name") or row.get("title") or row.get("scene_name") or entity_id)
    descriptions = []
    seen = set()
    for key in ("prompt_description", "appearance", "description"):
        value = str(row.get(key) or "").strip()
        if value and value not in seen:
            seen.add(value)
            descriptions.append(value)
    description = " ".join(descriptions)
    return name, description


def _subject_prompt_description(source, subject, uses, fallback):
    """Prefer an authored clothing description for the selected outfit, then the entity description."""
    clothing_purposes = {"wardrobe", "clothing", "costume", "outfit"}
    assets = {str(item.get("asset_id") or item.get("id") or ""): item for item in rows(source.get("asset_plan"))}
    snapshots = source.get("_canvas_subject_picture_sources") or {}
    for _shot_id, _picture_label, binding in uses:
        binding_id = str(binding.get("id") or "")
        asset_id = str(binding.get("assetId") or binding.get("asset_id") or "")
        snapshot = snapshots.get(binding_id, {})
        asset = assets.get(asset_id, {})
        purpose_values = [binding.get("role"), binding.get("purpose")]
        purpose_values.extend(binding.get("provides") if isinstance(binding.get("provides"), list) else [])
        purpose_values.extend([snapshot.get("role"), asset.get("kind")])
        if not clothing_purposes.intersection(str(value).strip().casefold() for value in purpose_values if value):
            continue
        # A character asset can provide both identity and outfit references; its
        # general description is still the character fallback, not an outfit description.
        sources = [binding, snapshot]
        if str(asset.get("kind") or "").strip().casefold() in clothing_purposes:
            sources.append(asset)
        for row in sources:
            for key in ("outfitDescription", "clothingDescription", "description", "prompt_description", "appearance", "prompt"):
                value = row.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return fallback


def _subject_retention_attributes(kind, retain, exclude):
    """Keep generated retention language aligned with the referenced entity type."""
    defaults = {
        "character": (
            "character identity and costume as defined by the reference image",
            "pose, camera angle, background, and unrelated composition",
        ),
        "scene": (
            "the established environment, architecture, spatial layout, and materials",
            "character identity, costume, and unrelated foreground subjects",
        ),
        "asset": (
            "the referenced object's identity, shape, material, and registered visual attributes",
            "unrelated background, staging, and composition",
        ),
    }
    default_retain, default_exclude = defaults.get(kind, defaults["asset"])
    # These old generic values were written for character references. They must
    # not leak into scene or prop retention just because they were stored on a binding.
    character_only = {
        "character identity and costume as defined by the reference image",
        "character identity and registered appearance",
        "character identity",
    }
    generic_character_excludes = {
        "pose, camera angle, background, and unrelated composition",
        "camera pose",
        "original composition",
        "unrelated background",
    }
    selected_retain = list(dict.fromkeys(value for value in retain if value and not (kind != "character" and value in character_only)))
    selected_exclude = list(dict.fromkeys(value for value in exclude if value and not (kind != "character" and value in generic_character_excludes)))
    return selected_retain or [default_retain], selected_exclude or [default_exclude]


def _subject_presentation(subject, usage):
    """Treat a scene used for environment reference as visible background content."""
    presentation = str(usage.get("presentation") or "")
    entity_kind = str((subject or {}).get("entityRef", {}).get("kind") or "")
    purposes = usage.get("referencePurpose") or []
    if isinstance(purposes, str):
        purposes = [purposes]
    if presentation == "state_context" and entity_kind == "scene" and "environment" in [str(value) for value in purposes]:
        return "visible"
    return presentation if presentation in {"visible", "offscreen_voice"} else "state_context"


def _subject_retention_scope(subject_id, clip_shot_ids, shots, reference_shot_ids=None, subject=None):
    """Report visible appearances separately from off-screen continuity uses."""
    visible, context, offscreen_voice = [], [], []
    for shot_number, shot_id in enumerate(clip_shot_ids, 1):
        if reference_shot_ids is not None and shot_id not in reference_shot_ids:
            continue
        shot = next((item for item in shots if str(item.get("id")) == str(shot_id)), {})
        presentations = [_subject_presentation(subject, usage) for usage in rows(shot.get("subject_usages"))
                         if str(usage.get("subjectId") or "") == str(subject_id)]
        number = "[Shot " + str(shot_number) + "]"
        if "visible" in presentations:
            visible.append(number)
        elif "state_context" in presentations:
            context.append(number)
        elif "offscreen_voice" in presentations:
            offscreen_voice.append(number)
    parts = []
    if visible:
        parts.append("appears in " + ", ".join(visible))
    if context:
        parts.append("continuity context for " + ", ".join(context) + "; not visible")
    if offscreen_voice:
        parts.append("off-screen voice in " + ", ".join(offscreen_voice))
    return "; ".join(parts), bool(visible)


def binding_ids(subject, usage, *, allow_missing=False):
    bindings = rows(subject.get("pictureBindings"))
    explicit = [str(value) for value in usage.get("pictureBindingIds") or []]
    # An empty explicit selection is a deliberate "no picture" choice and must
    # not fall back to a purpose default. Keep parity with
    # resolveSubjectPictureBindingIds in canvas-agent.
    if usage.get("pictureBindingMode") == "explicit" or explicit:
        return explicit
    requirements = {str(item.get("factId")): str(item.get("value")) for item in rows(usage.get("stateRequirements"))}
    purposes = usage.get("referencePurpose") or ["identity"]
    scene_environment = (subject.get("entityRef") or {}).get("kind") == "scene" and "environment" in [str(value) for value in purposes]
    # Scene environment references are visible background inputs even when the
    # Subject itself is carried as state context. Other non-visible usages
    # remain explicit-only. Keep parity with resolveSubjectPictureBindingIds in
    # canvas-agent; Backend derives Ref2VA for these usages on the same rule.
    if usage.get("presentation") != "visible" and not (usage.get("presentation") == "state_context" and scene_environment):
        return []
    # Visible scene Subjects inherit a purpose-matched environment default only.
    if (subject.get("entityRef") or {}).get("kind") == "scene" and not scene_environment:
        return []
    selected = []
    for purpose in dict.fromkeys(map(str, purposes)):
        eligible = [item for item in bindings
                    if purpose in [str(value) for value in item.get("provides", [])]
                    and all(requirements.get(str(key)) == str(value) for key, value in (item.get("applicableState") or {}).items())]
        candidates = [item for item in eligible if purpose in [str(value) for value in item.get("defaultFor", [])]]
        fixed_results = [item for item in eligible if (item.get("selection") or {}).get("mode") == "selected_result"]
        if len(candidates) == 1:
            selected.append(str(candidates[0]["id"]))
        elif len(candidates) > 1:
            if allow_missing:
                continue
            raise ValueError("Subject " + str(subject.get("id")) + " has ambiguous " + purpose + " default picture bindings")
        elif len(eligible) == 1:
            # A default-mode usage with one applicable picture is unambiguous,
            # even when older saved bindings omitted the redundant defaultFor tag.
            selected.append(str(eligible[0]["id"]))
        elif len(fixed_results) == 1:
            # A pinned generation result is an explicit, stable image choice.
            # Prefer it over legacy node-selection candidates when no purpose
            # default is declared, so visible Subjects do not silently vanish.
            selected.append(str(fixed_results[0]["id"]))
        elif not eligible:
            if allow_missing:
                continue
            raise ValueError("Subject " + str(subject.get("id")) + " lacks one unambiguous " + purpose + " default picture binding")
        elif not allow_missing:
            raise ValueError("Subject " + str(subject.get("id")) + " has ambiguous " + purpose + " default picture bindings")
    return selected


def _used_continuity_fact_ids(shot, facts):
    """Subject Prompt v2 emits only facts explicitly selected on its usages."""
    selected = set()
    for usage in rows(shot.get("subject_usages")):
        fact_ids = usage.get("continuityFactIds")
        if isinstance(fact_ids, list):
            selected.update(str(fact_id) for fact_id in fact_ids if isinstance(fact_id, str) and fact_id)
    return selected.intersection(facts)


def _state_start_descriptions(source, report, shot, subjects):
    trajectory = (report.get("trajectories") or {}).get(str(shot.get("id")), {})
    start = trajectory.get("start", {})
    facts = {str(item.get("id")): item for item in rows((source.get("ledger") or {}).get("facts"))}
    subject_by_entity = {(str(item.get("entityRef", {}).get("kind")), str(item.get("entityRef", {}).get("id"))): item for item in subjects}
    used = _used_continuity_fact_ids(shot, facts)
    values = []
    for fact_id in sorted(used):
        fact = facts.get(fact_id)
        value = start.get(fact_id)
        if not fact or value is None:
            continue
        description = (fact.get("value_descriptions") or {}).get(str(value))
        if not description:
            continue
        owner = subject_by_entity.get((str(fact.get("object_kind")), str(fact.get("object_id"))))
        name = entity_text(source, owner)[0] if owner else "The registered subject"
        values.append(name + " " + str(fact.get("property") or fact.get("name") or "state") + ": " + str(description))
    return "; ".join(values) if values else ""


def _render_state_end(source, report, shot, subjects):
    trajectory = (report.get("trajectories") or {}).get(str(shot.get("id")), {})
    end = trajectory.get("end", {})
    facts = {str(item.get("id")): item for item in rows((source.get("ledger") or {}).get("facts"))}
    subjects = list(subjects or [])
    subject_by_entity = {(str(item.get("entityRef", {}).get("kind")), str(item.get("entityRef", {}).get("id"))): item for item in subjects}
    used = _used_continuity_fact_ids(shot, facts)
    chunks = []
    for fact_id, value in sorted(end.items()):
        if str(fact_id) not in used:
            continue
        fact = facts.get(str(fact_id))
        if not fact:
            continue
        description = (fact.get("value_descriptions") or {}).get(str(value))
        if not description:
            continue
        owner = subject_by_entity.get((str(fact.get("object_kind")), str(fact.get("object_id"))))
        name = entity_text(source, owner)[0] if owner else "The registered subject"
        chunks.append(name + " " + str(fact.get("property") or fact.get("name") or "state") + " remains: " + str(description))
    return "; ".join(chunks) if chunks else ""


def _state_snapshot(source, report, shot, subjects, edge):
    """Return compiled state values; frame-zero events expose their post-event opening state."""
    trajectory = (report.get("trajectories") or {}).get(str(shot.get("id")), {})
    snapshot = trajectory.get(edge, {})
    facts = {str(item.get("id")): item for item in rows((source.get("ledger") or {}).get("facts"))}
    subject_by_entity = {(str(item.get("entityRef", {}).get("kind")), str(item.get("entityRef", {}).get("id"))): item
                         for item in subjects}
    used_facts = _used_continuity_fact_ids(shot, facts)
    opening_event_values = {}
    ending_unknown_values = {}
    shot_id = str(shot.get("id"))
    shot_events = [event for event in rows((source.get("ledger") or {}).get("events"))
                   if str(event.get("shot_id")) == shot_id]
    if edge == "start":
        shot_start = shot.get("start_frame")
        for event in shot_events:
            if (event.get("local_frame") == 0
                    or (shot_start is not None and event.get("frame") == shot_start)):
                fact_id = str(event.get("fact_id"))
                if fact_id in used_facts:
                    opening_event_values[fact_id] = event.get("after", "unknown")
    else:
        ending_unknown_values = {
            str(event.get("fact_id")): "unknown" for event in shot_events
            if str(event.get("fact_id")) in used_facts and event.get("after") == "unknown"
            and snapshot.get(str(event.get("fact_id"))) == "unknown"
        }
    result = {}
    for fact_id in sorted(used_facts):
        fact = facts.get(fact_id)
        is_event_value = fact_id in opening_event_values or fact_id in ending_unknown_values
        value = opening_event_values.get(fact_id, ending_unknown_values.get(fact_id, snapshot.get(fact_id)))
        if not fact or value is None:
            continue
        description = (fact.get("value_descriptions") or {}).get(str(value))
        if not description and is_event_value:
            description = "未知" if value == "unknown" else str(value)
        if not description:
            continue
        owner = subject_by_entity.get((str(fact.get("object_kind")), str(fact.get("object_id"))))
        name = entity_text(source, owner)[0] if owner else "The registered subject"
        label = name + " " + str(fact.get("property") or fact.get("name") or "state") + ": " + str(description)
        result[fact_id] = {"value": value, "text": label}
    return result


def project_continuity_source(production):
    """In-memory time/block compatibility projection; authored frames remain local."""
    if (production.get("prompt_assembly") or {}).get("version") != 2:
        return production
    source = deepcopy(production)
    ledger = source.get("ledger") if isinstance(source.get("ledger"), dict) else {}
    timeline_rows = rows(ledger.get("timelines"))
    timeline_ids = [str(row.get("id")) for row in timeline_rows if row.get("id") is not None]
    default_timeline_id = "main" if "main" in timeline_ids else (timeline_ids[0] if timeline_ids else "main")
    if not timeline_rows:
        source["ledger"] = {**ledger, "timelines": [{"id": default_timeline_id, "start_frame": 0}]}
        ledger = source["ledger"]
    next_order, occupied_orders = {}, {}
    for shot in rows(source.get("shots")):
        timeline_id = str(shot.get("timeline_id") or default_timeline_id)
        shot["timeline_id"] = timeline_id
        used = occupied_orders.setdefault(timeline_id, set())
        order = shot.get("story_order")
        if type(order) is not int or order < 0:
            order = next_order.get(timeline_id, 0)
            while order in used:
                order += 1
            shot["story_order"] = order
        used.add(order)
        next_order[timeline_id] = max(next_order.get(timeline_id, 0), order + 1)
    subjects = {str(row.get("id")): row for row in rows(source.get("subject_registry")) if row.get("id")}
    # The ledger validator consumes the older participant fields. Derive those
    # fields from the authoritative Subject usages in memory so character and
    # prop facts are checked without adding duplicate ownership to the source.
    text_ids = lambda value: [str(item) for item in value if isinstance(item, str) and item] if isinstance(value, list) else []
    for shot in rows(source.get("shots")):
        character_rows = list(shot.get("characters")) if isinstance(shot.get("characters"), list) else []
        asset_ids = text_ids(shot.get("required_assets"))
        continuity_ids = []
        for usage in rows(shot.get("subject_usages")):
            subject = subjects.get(str(usage.get("subjectId") or ""), {})
            entity_ref = subject.get("entityRef") if isinstance(subject.get("entityRef"), dict) else {}
            entity_kind = str(entity_ref.get("kind") or "")
            entity_id = str(entity_ref.get("id") or "")
            if not entity_id:
                continue
            if entity_kind == "character":
                character_rows.append({"id": entity_id})
            elif entity_kind == "asset":
                asset_ids.append(entity_id)
            elif entity_kind == "scene" and not shot.get("scene_id"):
                shot["scene_id"] = entity_id
            continuity_ids.extend(text_ids(usage.get("continuityFactIds")))
            continuity_ids.extend(str(value.get("factId")) for value in rows(usage.get("stateRequirements"))
                                  if isinstance(value, dict) and value.get("factId"))
        unique_characters = {}
        for item in character_rows:
            if isinstance(item, dict) and item.get("id"):
                unique_characters[str(item["id"])] = item
            elif isinstance(item, str) and item:
                unique_characters[item] = {"id": item}
        shot["characters"] = list(unique_characters.values())
        shot["required_assets"] = list(dict.fromkeys(str(value) for value in asset_ids if value))
        shot["continuity_facts"] = list(dict.fromkeys(str(value) for value in continuity_ids if value))
    origins = {str(row.get("id")): row.get("start_frame", 0) for row in rows((source.get("ledger") or {}).get("timelines"))}
    streams = defaultdict(list)
    for shot in rows(source.get("shots")):
        streams[str(shot.get("timeline_id") or "")].append(shot)
    windows = {}
    for timeline, stream in streams.items():
        cursor = origins.get(timeline, 0)
        if type(cursor) is not int:
            continue
        for shot in sorted(stream, key=lambda row: row.get("story_order", 0)):
            duration = shot.get("duration_frames")
            if type(duration) is not int or duration <= 0:
                continue
            shot["start_frame"], shot["end_frame"] = cursor, cursor + duration
            windows[str(shot.get("id"))] = (cursor, cursor + duration)
            cursor += duration
    for event in rows((source.get("ledger") or {}).get("events")):
        window = windows.get(str(event.get("shot_id")))
        if window and type(event.get("local_frame")) is int:
            event["frame"] = window[0] + event["local_frame"]
    for segment in rows(source.get("segments")):
        ids = segment.get("shot_ids") or []
        if ids and all(str(key) in windows for key in ids):
            segment["start_frame"], segment["end_frame"] = windows[str(ids[0])][0], windows[str(ids[-1])][1]
    for scene in rows(source.get("script_scenes")):
        if not rows(scene.get("blocks")) and isinstance(scene.get("text"), str) and scene.get("id"):
            # Coverage is authored against the source block's identity, kind and
            # text. Copying scene metadata into this synthetic block changes the
            # digest even though the screenplay itself is unchanged.
            scene["blocks"] = [{"id": str(scene["id"]), "kind": str(scene.get("kind") or "action"), "text": scene["text"]}]
    return source


def _subject_continuity_audit_projection(production):
    projected = project_continuity_source(production)
    if (production.get("prompt_assembly") or {}).get("version") == 2:
        # Subject usages are the v2 authority for which facts a Shot consumes.
        # The legacy validator otherwise expands every fact owned by each visible
        # character/scene to every Shot, creating false baseline/requirement debt.
        authored_shots = {str(row.get("id")): row for row in rows(production.get("shots")) if row.get("id")}
        ledger = projected.get("ledger") if isinstance(projected.get("ledger"), dict) else {}
        requirements = rows(ledger.get("requirements"))
        events = rows(ledger.get("events"))
        explicit_by_shot = {}
        for shot_id, authored in authored_shots.items():
            explicit = set()
            for usage in rows(authored.get("subject_usages")):
                explicit.update(str(value) for value in usage.get("continuityFactIds", [])
                                if isinstance(value, str) and value)
                explicit.update(str(value.get("factId")) for value in rows(usage.get("stateRequirements"))
                                if isinstance(value, dict) and value.get("factId"))
            explicit.update(str(event.get("fact_id")) for event in events
                            if str(event.get("shot_id")) == shot_id and event.get("fact_id"))
            explicit_by_shot[shot_id] = explicit
        for req in requirements:
            if req.get("kind") in {"hold", "change"} and req.get("shot_id") and req.get("fact_id"):
                explicit_by_shot.setdefault(str(req["shot_id"]), set()).add(str(req["fact_id"]))
        initial_values = {(str(row.get("timeline_id", "")), str(row.get("fact_id", ""))): row.get("value", "unknown")
                          for row in rows(ledger.get("initial"))}
        change_event_refs = {
            (str(req.get("shot_id", "")), str(req.get("fact_id", "")), str(event_id))
            for req in requirements if req.get("kind") == "change"
            for event_id in (req.get("event_ids") or []) if isinstance(event_id, str)
        }
        first_unknown_observations = set()
        seen_event_facts = set()
        for event in sorted(events, key=lambda row: (str(row.get("timeline_id", "")),
                                                     row.get("frame", -1) if type(row.get("frame")) is int else -1,
                                                     str(row.get("id", "")))):
            timeline_id = str(event.get("timeline_id", ""))
            fact_id = str(event.get("fact_id", ""))
            key = (timeline_id, fact_id)
            if key not in seen_event_facts:
                if event.get("before") == "unknown" and initial_values.get(key, "unknown") == "unknown":
                    first_unknown_observations.add((str(event.get("shot_id", "")), fact_id, str(event.get("id", ""))))
                seen_event_facts.add(key)
        state_requirements_by_shot = {}
        for shot_id, authored in authored_shots.items():
            state_requirements_by_shot[shot_id] = {
                str(item.get("factId")) for usage in rows(authored.get("subject_usages"))
                for item in rows(usage.get("stateRequirements")) if item.get("factId")
            }
        unbaselined_openings = {
            (shot_id, fact_id) for shot_id, fact_id, event_id in first_unknown_observations
            if (shot_id, fact_id, event_id) in change_event_refs
            and fact_id not in state_requirements_by_shot.get(shot_id, set())
        }
        script_occurrences = {}
        for scene in rows(projected.get("script_scenes")):
            environment_id = str(scene.get("scene_id") or "")
            occurrence_id = str(scene.get("id") or "")
            if environment_id and occurrence_id:
                script_occurrences.setdefault(environment_id, []).append(occurrence_id)
        for shot in rows(projected.get("shots")):
            shot_id = str(shot.get("id"))
            authored = authored_shots.get(shot_id, {})
            declared = set(explicit_by_shot.get(shot_id, set()))
            # A first explicit change from `unknown` is the first observation,
            # not a claim that the value was known at the Shot opening. The
            # event and its change requirement remain audited; omit only the
            # opening-baseline assertion for that one fact.
            declared.difference_update(fact_id for shot_ref, fact_id in unbaselined_openings
                                       if shot_ref == shot_id)
            # Scene membership is not a declaration that every scene-owned
            # continuity fact is consumed by every Shot. Preserve a uniquely
            # matching screenplay occurrence for scoped coverage checks, then
            # remove environment ownership from the legacy participant projection.
            scene_id = str(authored.get("scene_id") or "")
            if scene_id:
                occurrence_id = str(authored.get("source_scene_id") or "")
                matches = script_occurrences.get(scene_id, [])
                if not occurrence_id and len(matches) == 1:
                    occurrence_id = matches[0]
                if occurrence_id:
                    shot["source_scene_id"] = occurrence_id
                shot["scene_id"] = ""
            shot["characters"] = []
            shot["required_assets"] = []
            shot["continuity_facts"] = sorted(declared)
        # Legacy bulk projections left unresolved rows on Shots that never
        # declared or emitted the fact. Keep those rows only when the authored
        # Shot scope actually consumes the fact; retain all explicit holds and
        # changes because they are direct ledger assertions.
        ledger["requirements"] = [req for req in requirements
                                  if req.get("kind") != "unresolved"
                                  or str(req.get("fact_id", "")) in explicit_by_shot.get(str(req.get("shot_id", "")), set())]

    return projected


def audit_subject_continuity(production, target_ids=None):
    from continuity_v2 import audit, digest
    report = audit(_subject_continuity_audit_projection(production), target_ids)
    report["sourceDigest"] = digest(production)
    return report


def _h3_picture_submission_order(pictures):
    """Match H3 slots: storyboard/keyframes, subject images, then other refs."""
    return sorted(pictures, key=lambda picture: (
        not bool(picture.get("is_keyframe")),
        not bool(picture.get("subject_ids")),
        int(picture.get("number") or 0),
    ))


def _infer_segment_mode(source, segment):
    explicit = str(segment.get("mode") or "").strip()
    modes = {"T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"}
    if explicit:
        if explicit not in modes:
            raise ValueError("Clip " + str(segment.get("id")) + " has an invalid generation mode " + explicit)
        return explicit
    shot_by_id = {str(item.get("id")): item for item in rows(source.get("shots"))}
    subjects = {str(item.get("id")): item for item in rows(source.get("subject_registry"))}
    for shot_id in segment.get("shot_ids", []):
        shot = shot_by_id.get(str(shot_id), {})
        if any(frame.get("requiredForSubmission", True) and frame.get("anchor") != "composition" for frame in rows(shot.get("keyframes"))) \
                or any(reference.get("requiredForSubmission", True) for reference in rows(shot.get("reference_requirements"))) \
                or any(frame.get("requiredForSubmission", True) and frame.get("anchor") == "composition" for frame in rows(shot.get("keyframes"))):
            return "Ref2VA"
        for usage in rows(shot.get("subject_usages")):
            subject_id = str(usage.get("subjectId"))
            subject = subjects.get(subject_id)
            if not subject:
                continue
            explicit = string_rows(usage.get("pictureBindingIds"))
            if explicit:
                if any(str(binding.get("id")) in explicit for binding in rows(subject.get("pictureBindings"))):
                    return "Ref2VA"
                continue
            # Purpose-default references (visible Subjects and state-context
            # scene environments) also need Ref2VA to carry their image.
            if binding_ids(subject, usage, allow_missing=True):
                return "Ref2VA"
    return "T2VA"


def adapt_production(production, *, draft=False):
    """Project authored v2 data to the mature H3 packaging schema without writing it back."""
    if (production.get("prompt_assembly") or {}).get("version") != 2:
        return production
    source = project_continuity_source(production)
    source["_canvas_prompt_assembly_version"] = 2
    source["_canvas_compiled_subject_projection"] = True
    source["_canvas_subject_source_hash"] = str(production.get("_canvas_subject_source_hash") or "")
    snapshots = source.get("_canvas_subject_picture_sources") or {}
    subjects = rows(source.get("subject_registry"))
    subject_by_id = {str(item.get("id")): item for item in subjects}
    shots = rows(source.get("shots"))
    segments = rows(source.get("segments"))
    timelines = {str(item.get("id")): int(item.get("start_frame", 0)) for item in rows((source.get("ledger") or {}).get("timelines"))}
    by_timeline = defaultdict(list)
    for shot in shots:
        by_timeline[str(shot.get("timeline_id") or "")].append(shot)
    windows = {}
    for timeline_id, stream in by_timeline.items():
        cursor = timelines.get(timeline_id, 0)
        for shot in sorted(stream, key=lambda item: int(item.get("story_order", 0))):
            start = cursor
            cursor += int(shot.get("duration_frames", 0))
            windows[str(shot["id"])] = (start, cursor)

    continuity = audit_subject_continuity(source)
    # Replay validates every event's authored `before` against the prior state.
    # For compiler-visible Shot openings, a local-frame-zero event has already
    # taken effect, so project its `after` into the opening snapshot only after
    # that audit has captured the before-state verification result.
    trajectories = continuity.get("trajectories") if isinstance(continuity.get("trajectories"), dict) else {}
    for shot in shots:
        shot_id = str(shot.get("id"))
        trajectory = trajectories.get(shot_id)
        if not isinstance(trajectory, dict):
            continue
        opening = trajectory.get("start")
        if not isinstance(opening, dict):
            continue
        for event in rows((source.get("ledger") or {}).get("events")):
            if str(event.get("shot_id")) == shot_id and event.get("local_frame") == 0:
                opening[str(event.get("fact_id"))] = event.get("after", "unknown")
    source["_continuity_report"] = continuity
    assets = {str(item.get("asset_id") or item.get("id")): item for item in rows(source.get("asset_plan"))}
    ledger_facts_by_id = {str(item.get("id")): item for item in rows((source.get("ledger") or {}).get("facts"))}
    reference_cache = {}
    transformed_segments = []
    all_transformed_shots = []
    source_maps = {}
    for segment in segments:
        segment_id = str(segment.get("id"))
        shot_ids = [str(value) for value in segment.get("shot_ids", [])]
        mode = _infer_segment_mode(source, segment)
        selected_pictures = []
        picture_by_digest = {}
        subject_uses = defaultdict(list)
        reference_requirements = defaultdict(list)
        for shot_id in shot_ids:
            shot = next((item for item in shots if str(item.get("id")) == shot_id), None)
            if not shot:
                raise ValueError("Clip " + segment_id + " refers to an unknown Shot " + shot_id)
            for usage in (rows(shot.get("subject_usages")) if mode == "Ref2VA" else []):
                subject_id = str(usage.get("subjectId") or "")
                subject = subject_by_id.get(subject_id)
                if not subject:
                    raise ValueError("Shot " + shot_id + " refers to an unknown Subject " + subject_id)
                for binding_id in binding_ids(subject, usage, allow_missing=draft):
                    snapshot = snapshots.get(binding_id)
                    if not snapshot:
                        raise ValueError("Subject image " + binding_id + " is not in the frozen compiler inputs")
                    digest = str(snapshot.get("sha256") or "")
                    if not digest or not snapshot.get("file"):
                        raise ValueError("Subject image " + binding_id + " has no verified media file")
                    picture = picture_by_digest.get(digest)
                    if not picture:
                        picture = {"number": len(selected_pictures) + 1, "label": "<Picture " + str(len(selected_pictures) + 1) + ">",
                                   "sha256": digest, "file": str(snapshot["file"]), "asset_ids": [], "entity_ids": [],
                                   "subject_ids": [], "shot_ids": [], "roles": [], "retain": [], "exclude": [],
                                   "asset_version": "sha256:" + digest, "is_keyframe": False, "anchor": "", "anchor_shot_ids": []}
                        picture_by_digest[digest] = picture
                        selected_pictures.append(picture)
                    binding = next(item for item in rows(subject.get("pictureBindings")) if str(item.get("id")) == binding_id)
                    ref = subject.get("entityRef") or {}
                    entity_id = str(ref.get("id") or "")
                    picture["asset_ids"].append(str(snapshot.get("assetId") or binding.get("assetId") or ""))
                    if entity_id:
                        picture["entity_ids"].append(entity_id)
                    picture["subject_ids"].append(subject_id)
                    picture["shot_ids"].append(shot_id)
                    picture["roles"].append(str(snapshot.get("role") or "identity"))
                    picture["retain"].extend(str(value) for value in binding.get("retain", []))
                    picture["exclude"].extend(str(value) for value in binding.get("exclude", []))
                    subject_uses[subject_id].append((shot_id, picture["label"], binding))
                    reference_requirements[shot_id].append({"entity_id": entity_id, "asset_version": picture["asset_version"], "purpose": str(snapshot.get("role") or "identity")})
            composition_references = list(rows(shot.get("reference_requirements")))
            composition_references.extend({
                "id": str(frame.get("id") or ""), "asset_id": str(frame.get("assetId") or frame.get("id") or ""),
                "asset_version": str(frame.get("asset_version") or ""), "purpose": "构图参考",
                "sourceNode": frame.get("sourceNode"),
                "retain": frame.get("retain") or [], "exclude": frame.get("exclude") or [],
                "requiredForSubmission": frame.get("requiredForSubmission", True),
            } for frame in rows(shot.get("keyframes")) if frame.get("anchor") == "composition")
            for reference in composition_references:
                if not reference.get("requiredForSubmission", True):
                    continue
                binding_id = str(reference.get("id") or reference.get("asset_id") or "")
                snapshot = snapshots.get(binding_id)
                if not snapshot:
                    raise ValueError("Composition reference " + binding_id + " is not in the frozen compiler inputs")
                digest = str(snapshot.get("sha256") or "")
                if not digest or not snapshot.get("file"):
                    raise ValueError("Composition reference " + binding_id + " has no verified media file")
                asset_id = str(snapshot.get("assetId") or reference.get("asset_id") or "")
                # Composition references are standalone content: give the source canvas node
                # a stable identity, and keep equal bytes from different source nodes distinct.
                # Digest-only deduplication used to collapse their separate asset/Shot links.
                entity_id = str(reference.get("entity_id") or _canvas_node_entity_id(reference.get("sourceNode"), asset_id))
                picture = next((candidate for candidate in selected_pictures
                                if candidate["sha256"] == digest
                                and not candidate["is_keyframe"]
                                and "composition" in candidate["roles"]
                                and asset_id in candidate["asset_ids"]
                                and entity_id in candidate["entity_ids"]), None)
                if not picture:
                    picture = {"number": len(selected_pictures) + 1, "label": "<Picture " + str(len(selected_pictures) + 1) + ">",
                               "sha256": digest, "file": str(snapshot["file"]), "asset_ids": [], "entity_ids": [],
                               "subject_ids": [], "shot_ids": [], "roles": [], "retain": [], "exclude": [],
                               "asset_version": str(snapshot.get("assetVersion") or reference.get("asset_version") or "sha256:" + digest),
                               "is_keyframe": False, "anchor": "", "anchor_shot_ids": []}
                    selected_pictures.append(picture)
                if asset_id:
                    picture["asset_ids"].append(asset_id)
                if entity_id:
                    picture["entity_ids"].append(entity_id)
                picture["shot_ids"].append(shot_id)
                picture["roles"].append("composition")
                picture["retain"].extend(str(value) for value in reference.get("retain", []))
                picture["exclude"].extend(str(value) for value in reference.get("exclude", []))
                reference_requirements[shot_id].append({"asset_id": asset_id, "entity_id": entity_id,
                                                        "asset_version": str(snapshot.get("assetVersion") or reference.get("asset_version") or picture["asset_version"]),
                                                        "purpose": str(reference.get("purpose") or "构图参考")})
            for frame in rows(shot.get("keyframes")):
                if not frame.get("requiredForSubmission", True) or frame.get("anchor") == "composition":
                    continue
                binding_id = str(frame.get("id") or "")
                snapshot = snapshots.get(binding_id)
                if not snapshot:
                    raise ValueError("Required keyframe " + binding_id + " is not in the frozen compiler inputs")
                digest = str(snapshot.get("sha256") or "")
                # A valid keyframe may be attached before a visible Subject is
                # registered. Its archived source node (or stable asset ID) is
                # still sufficient to identify and require this standalone image.
                asset_id = str(snapshot.get("assetId") or frame.get("assetId") or frame.get("id") or "")
                ref_subject = next((subject_by_id.get(str(sid)) for sid in frame.get("subjectIds", []) if str(sid) in subject_by_id), None)
                entity_id = str((ref_subject or {}).get("entityRef", {}).get("id") or _canvas_node_entity_id(frame.get("sourceNode"), asset_id))
                picture = next((candidate for candidate in selected_pictures
                                if candidate["sha256"] == digest
                                and candidate["is_keyframe"]
                                and candidate["anchor"] == str(snapshot.get("anchor") or "")
                                and asset_id in candidate["asset_ids"]
                                and entity_id in candidate["entity_ids"]), None)
                if not picture:
                    picture = {"number": len(selected_pictures) + 1, "label": "<Picture " + str(len(selected_pictures) + 1) + ">",
                               "sha256": digest, "file": str(snapshot["file"]), "asset_ids": [], "entity_ids": [],
                               "subject_ids": [], "shot_ids": [], "roles": [], "retain": [], "exclude": [],
                               "asset_version": "sha256:" + digest, "is_keyframe": True, "anchor": str(snapshot.get("anchor") or ""), "anchor_shot_ids": []}
                    selected_pictures.append(picture)
                picture["is_keyframe"] = True
                # Preserve the formal keyframe asset identity on the compiled
                # reference so Backend can resolve its frozen archive path.
                # Without this id, readCompilationReference only knows the
                # segment label while the trusted snapshot is indexed by keyframe.
                if asset_id:
                    picture["asset_ids"].append(asset_id)
                picture["anchor_shot_ids"].append(shot_id)
                picture["shot_ids"].append(shot_id)
                picture["roles"].append("keyframe")
                picture["retain"].extend(str(value) for value in frame.get("retain", []))
                picture["exclude"].extend(str(value) for value in frame.get("exclude", []))
                if entity_id:
                    picture["entity_ids"].append(entity_id)
                    if ref_subject:
                        picture["subject_ids"].append(str(ref_subject.get("id")))
                    reference_requirements[shot_id].append({"asset_id": asset_id, "entity_id": entity_id,
                                                            "asset_version": picture["asset_version"], "purpose": "keyframe"})

        # Keep prompt ordinals aligned with H3's actual submission slots:
        # storyboard/keyframe images, all Subject images, then other references.
        # Otherwise a composition reference inserted between two Shots can take
        # a lower Picture number than the later Subject image H3 submits first.
        storyboard_first = _h3_picture_submission_order(selected_pictures)
        label_map = {}
        for number, picture in enumerate(storyboard_first, 1):
            previous = picture["label"]
            current = "<Picture " + str(number) + ">"
            label_map[previous] = current
            picture["number"] = number
            picture["label"] = current
        for subject_id, uses in subject_uses.items():
            subject_uses[subject_id] = [(shot_id, label_map.get(label, label), binding) for shot_id, label, binding in uses]
        selected_pictures = storyboard_first

        if not selected_pictures and mode != "T2VA" and not draft:
            raise ValueError("Clip " + segment_id + " needs at least one image binding for its selected generation mode")
        start_frame = windows[shot_ids[0]][0]
        end_frame = windows[shot_ids[-1]][1]
        duration = float(Fraction((end_frame - start_frame) * int(source.get("fps_den", 1)), int(source.get("fps_num", 24))))
        if duration < 4 or duration > 15:
            raise ValueError("Clip " + segment_id + " duration is outside the 4–15 second H3 range")
        refs = []
        for picture in selected_pictures:
            asset_ids = list(dict.fromkeys(value for value in picture["asset_ids"] if value))
            entity_ids = list(dict.fromkeys(value for value in picture["entity_ids"] if value))
            asset_id = asset_ids[0] if asset_ids else ""
            if asset_id:
                plan = assets.get(asset_id)
                if not plan:
                    card = next((item for item in rows(source.get("asset_cards"))
                                 if str(item.get("asset_id") or item.get("id") or "") == asset_id), {})
                    plan = {"id": asset_id, "asset_id": asset_id, "kind": "keyframe" if picture["is_keyframe"] else "prop",
                            "name": asset_id, "version": card.get("asset_version") or picture["asset_version"],
                            "entity_id": entity_ids[0] if entity_ids else "",
                            "entity_ids": entity_ids, "status": "selected_result"}
                    source.setdefault("asset_plan", []).append(plan)
                    assets[asset_id] = plan
                # Keep the authored asset version stable. The SHA-256 below pins this
                # exact archived image; replacing the semantic version with that hash
                # makes every other card referencing this asset look version-stale.
                plan.update({"file": picture["file"], "sha256": picture["sha256"], "status": "selected_result",
                             "entity_id": entity_ids[0] if entity_ids else plan.get("entity_id"), "entity_ids": entity_ids})
            picture_shots = list(dict.fromkeys(picture["shot_ids"]))
            picture_scope = ", ".join("[Shot " + str(shot_ids.index(str(value)) + 1) + "]" for value in picture_shots if str(value) in shot_ids)
            picture_preserve = "; ".join(dict.fromkeys(picture["retain"])) or ("original shot-entry composition and camera" if picture["is_keyframe"] else "registered visual attributes")
            picture_exclude = "; ".join(dict.fromkeys(picture["exclude"])) or ("identity or staging changes" if picture["is_keyframe"] else "unregistered pose or background")
            keyframe_anchor = {"opening": "shot-entry", "closing": "shot-ending", "at_frame": "declared-frame"}.get(str(picture["anchor"]), "shot-entry")
            picture_definition = (picture["label"] + " is the persisted storyboard frame for " + picture_scope
                                 + "; preserve its original " + keyframe_anchor + " composition and camera.") if picture["is_keyframe"] else (
                                     picture["label"] + " is the archived " + str(picture["roles"][0] if picture["roles"] else "reference")
                                     + " image for " + picture_scope + "; it contributes only its registered visual evidence.")
            retention_level = "fully_preserved" if picture["is_keyframe"] else "partially_preserved"
            retention_detail = ("retain composition, camera and subject placement; exclude identity or staging changes"
                                if picture["is_keyframe"] else "retain " + picture_preserve + "; exclude " + picture_exclude)
            refs.append({"label": picture["label"], "image": picture["number"], "asset_id": asset_id,
                         "asset_version": picture["asset_version"], "sha256": picture["sha256"], "file": picture["file"],
                         "entity_id": entity_ids[0] if entity_ids else "", "entity_ids": entity_ids,
                         "role": picture["roles"][0] if picture["roles"] else "keyframe",
                         "preserve": picture_preserve, "exclude": picture_exclude,
                         "definition": picture_definition,
                         "retention": picture["label"] + " (" + picture_scope + "): " + retention_level + " - " + retention_detail + ".",
                         # Subject-bound identity images remain real uploaded references, but their
                         # source label belongs inside the Subject definition rather than as a
                         # standalone Picture entry. Independent frame/composition uses stay visible.
                         "source_only": bool(picture["subject_ids"]) and not picture["is_keyframe"] and "composition" not in picture["roles"],
                         "shot_ids": picture_shots, **({"anchor_shot_ids": list(dict.fromkeys(picture["anchor_shot_ids"]))} if picture["anchor_shot_ids"] else {}),
                         "start_frame": start_frame, "end_frame": end_frame})

        # Audio remains a first-class current-format binding. Materialize a
        # compiler-only asset/reference row so H3 receives the exact archived
        # sound input without restoring Segment.references in saved source.
        audio_sources = source.get("_canvas_subject_audio_sources") or {}
        for binding in rows(segment.get("audio_bindings")):
            binding_id = str(binding.get("id") or "")
            snapshot = audio_sources.get(binding_id) if isinstance(audio_sources, dict) else None
            if not binding_id or not isinstance(snapshot, dict) or not snapshot.get("file"):
                raise ValueError("Audio binding " + binding_id + " is not in the frozen compiler inputs")
            digest = str(binding.get("sha256") or snapshot.get("sha256") or "")
            version = "sha256:" + digest
            audio_plan = {"id": binding_id, "asset_id": binding_id, "kind": "audio", "name": str(binding.get("label") or binding_id),
                          "version": version, "entity_id": binding_id, "entity_ids": [binding_id], "status": "selected_result",
                          "file": str(snapshot["file"]), "sha256": digest}
            source.setdefault("asset_plan", []).append(audio_plan)
            assets[binding_id] = audio_plan
            shot_scope = binding.get("shotIds")
            binding_shots = string_rows(shot_scope)
            if not binding_shots or any(shot_id not in shot_ids for shot_id in binding_shots):
                raise ValueError("Audio binding " + binding_id + " has an invalid Shot scope")
            label = str(binding.get("label") or "")
            refs.append({"label": label, "asset_id": binding_id, "asset_version": version, "sha256": digest,
                         "file": str(snapshot["file"]), "entity_id": binding_id, "entity_ids": [binding_id],
                         "role": str(binding.get("role") or "audio"), "preserve": "the registered audio reference",
                         "exclude": "Do not treat audio as a visual identity reference.",
                         "definition": label + " is the archived audio reference for this Segment.",
                         "retention": label + ": reference - preserve its audible reference only.", "shot_ids": binding_shots,
                         "start_frame": start_frame, "end_frame": end_frame, "mediaType": "audio"})
            for shot_id in binding_shots:
                reference_requirements[shot_id].append({"asset_id": binding_id, "asset_version": version, "purpose": "audio"})

        subject_entries = []
        subject_labels = {}
        for subject_id, uses in subject_uses.items():
            if subject_id not in subject_labels:
                subject_labels[subject_id] = "<Subject " + str(len(subject_labels) + 1) + ">"
            subject = subject_by_id[subject_id]
            name, description = entity_text(source, subject)
            labels = list(dict.fromkeys(label for _shot, label, _binding in uses))
            shot_scope = list(dict.fromkeys(sid for sid, _label, _binding in uses))
            retain = list(dict.fromkeys(value for _sid, _label, binding in uses for value in binding.get("retain", [])))
            exclude = list(dict.fromkeys(value for _sid, _label, binding in uses for value in binding.get("exclude", [])))
            # Normalize legacy Chinese placeholder strings written by older UI/build code.
            _LEGACY_RETAIN = {
                "跟随共享主体节点当前图片": "character identity and costume as defined by the reference image",
                "跟随已绑定主体节点当前图片": "character identity and costume as defined by the reference image",
                "主体身份与已登记外观": "character identity and registered appearance",
                "角色身份": "character identity",
            }
            _LEGACY_EXCLUDE = {
                "原图无关姿势与构图": "pose, camera angle, background, and unrelated composition",
                "原图姿势": "camera pose",
                "原图构图": "original composition",
                "无关背景": "unrelated background",
            }
            retain = [_LEGACY_RETAIN.get(v, v) for v in retain]
            exclude = [_LEGACY_EXCLUDE.get(v, v) for v in exclude]
            entity_kind = str((subject.get("entityRef") or {}).get("kind") or "asset")
            retain, exclude = _subject_retention_attributes(entity_kind, retain, exclude)
            retention_scope, visually_present = _subject_retention_scope(subject_id, shot_ids, shots, shot_scope, subject)
            label = subject_labels[subject_id]
            has_identity_reference = False
            if str((subject.get("entityRef") or {}).get("kind") or "") == "character" and labels:
                picture_roles = []
                for _sid, picture_label, binding in uses:
                    purpose = str(binding.get("role") or binding.get("purpose") or "")
                    if not purpose:
                        purpose_values = binding.get("provides") if isinstance(binding.get("provides"), list) else []
                        purpose = str(purpose_values[0]) if purpose_values else "reference"
                    has_identity_reference = has_identity_reference or purpose.casefold() in {"identity", "character_identity"}
                    purpose_label = {"wardrobe": "outfit", "clothing": "outfit", "costume": "outfit"}.get(purpose, purpose)
                    entry = purpose_label + ": " + picture_label
                    if entry not in picture_roles:
                        picture_roles.append(entry)
                selected_description = _subject_prompt_description(source, subject, uses, description)
                description_text = ("; appearance: " + selected_description) if selected_description else ""
                definition = label + " is " + name + description_text + "; " + ", ".join(picture_roles) + "."
            else:
                _core_def = description or name
                definition = label + " is " + _core_def + ", represented by " + ", ".join(labels) + "."
            if visually_present:
                retention_level = "fully_preserved" if entity_kind == "character" and has_identity_reference else "partially_preserved"
                retention_detail = "retain " + ", ".join(retain) + "; exclude " + ", ".join(exclude)
            else:
                # A state-context Subject informs the shot without appearing in
                # frame. It must not be described as appearing or fully retained.
                retention_level = "weak_reference"
                retention_detail = "the reference informs continuity without showing the referenced appearance in these Shots"
            if not retention_scope:
                retention_scope = "reference context for this Clip"
            subject_retention = (label + " (" + retention_scope + "): " + retention_level + " - " + ", ".join(labels) + "."
                                 if str((subject.get("entityRef") or {}).get("kind") or "") == "character" and labels else
                                 label + " (" + retention_scope + "): " + retention_level + " - " + retention_detail + ".")
            subject_entries.append({"label": label, "entity_id": str(subject.get("entityRef", {}).get("id") or subject_id),
                                    "definition": definition,
                                    "retention": subject_retention,
                                    "shot_ids": shot_scope, "start_frame": start_frame, "end_frame": end_frame})

        transformed_shots = []
        for shot_id in shot_ids:
            shot = next(item for item in shots if str(item.get("id")) == shot_id)
            shot_start, shot_end = windows[shot_id]
            next_shot = deepcopy(shot)
            source_features = shot.get("features") if isinstance(shot.get("features"), dict) else {}
            next_shot.update({"start_frame": shot_start, "end_frame": shot_end, "features": {"core_emotion": bool(shot.get("performance")), "combat": bool(source_features.get("combat")), "supernatural_vfx": False, "colossal": False},
                              "audio": shot.get("audio") if isinstance(shot.get("audio"), dict) else {"foley": []},
                              "performance": shot.get("performance") if isinstance(shot.get("performance"), dict) else {},
                              "characters": [], "identity_context": {}, "dialogues": [], "reference_requirements": reference_requirements[shot_id]})
            scene_subject = next((subject_by_id.get(str(usage.get("subjectId"))) for usage in rows(shot.get("subject_usages"))
                                  if subject_by_id.get(str(usage.get("subjectId")), {}).get("entityRef", {}).get("kind") == "scene"), None)
            scene_id = str((scene_subject or {}).get("entityRef", {}).get("id") or shot.get("scene_id") or "")
            if scene_subject and not any(str(item.get("id")) == scene_id for item in rows(source.get("scene_registry"))):
                raise ValueError("Shot " + shot_id + " refers to an unregistered Scene Subject")
            if scene_id:
                next_shot["scene_id"] = scene_id
            for usage in rows(shot.get("subject_usages")):
                subject = subject_by_id.get(str(usage.get("subjectId")))
                if not subject or usage.get("presentation") != "visible":
                    continue
                ref = subject.get("entityRef") or {}
                if ref.get("kind") == "character" and any(str(item.get("id")) == str(ref.get("id")) for item in rows(source.get("character_registry"))):
                    next_shot["characters"].append({"id": str(ref.get("id"))})
                    next_shot["identity_context"][str(ref.get("id"))] = "See " + subject_labels.get(str(subject.get("id")), "the registered Subject") + " for the approved appearance."
            for ref in rows(shot.get("utterance_refs")):
                utterance = next((item for item in rows(source.get("utterances")) if str(item.get("id")) == str(ref.get("utteranceId"))), None)
                if not utterance:
                    raise ValueError("Shot " + shot_id + " refers to an unknown utterance " + str(ref.get("utteranceId")))
                text = str(utterance.get("text") or "")
                text_start, text_end = int(ref.get("textStart", 0)), int(ref.get("textEnd", 0))
                speaker = subject_by_id.get(str(utterance.get("speakerSubjectId")))
                speaker_entity = str((speaker or {}).get("entityRef", {}).get("id") or utterance.get("speakerSubjectId") or "UTT_" + str(utterance.get("id") or "UNKNOWN"))
                speaker_name = entity_text(source, speaker)[0] if speaker else str(utterance.get("speakerName") or "旁白")
                part = text[text_start:text_end]
                next_shot["dialogues"].append({"utterance_id": str(utterance["id"]), "_shot_id": shot_id, "source_text": text,
                                               "source_start": text_start, "source_end": text_end,
                                               "character_id": speaker_entity, "speaker_name": speaker_name, "speaker_id": "SUBJECT_" + str(utterance.get("speakerSubjectId") or utterance.get("id") or speaker_entity),
                                               "text": part, "language": str(utterance.get("language") or ("Chinese" if any("\u4e00" <= char <= "\u9fff" for char in part) else "English")),
                                               "delivery": str(utterance.get("delivery") or "natural, intelligible delivery"),
                                               "voiceover": bool(utterance.get("voiceover")), "start": int(ref["localStartFrame"]), "end": int(ref["localEndFrame"])})
            selected_fact_ids = _used_continuity_fact_ids(shot, ledger_facts_by_id)
            next_shot["_canvas_v2_events"] = [event for event in rows((source.get("ledger") or {}).get("events"))
                                               if str(event.get("shot_id")) == shot_id and str(event.get("fact_id")) in selected_fact_ids]
            next_shot["state_description"] = _state_start_descriptions(source, continuity, shot, subjects)
            transformed_shots.append(next_shot)
        all_transformed_shots.extend(transformed_shots)

        first_shot = transformed_shots[0]
        # Reuse the authored production creative notes when this Clip has no
        # dedicated summary, so the existing frontend field controls Ref2VA's summary.
        summary = str(segment.get("summary") or "")
        if not summary:
            summary = str(source.get("brief") or "").strip()
        if not summary:
            summary = "A continuous scene of " + str(len(shot_ids)) + " authored camera Shot(s)."
        if not summary.startswith("["):
            summary = "[reference generation] " + summary
        mode_reason = str(segment.get("mode_selection_reason") or ("Inferred from visible Subject and keyframe references." if mode == "Ref2VA" else "No image reference intent is present; using text-to-video."))
        transformed_segments.append({**segment, "mode": mode, "mode_lock": mode, "mode_selection_reason": mode_reason,
                                     "shot_ids": shot_ids, "start_frame": start_frame, "end_frame": end_frame,
                                     "generation_clip_duration": duration, "style": str(segment.get("style") or ""),
                                     "summary": summary, "references": refs, "subjects": subject_entries,
                                     "overall_soundscape": str(segment.get("overall_soundscape") or "Synchronized dialogue, ambience and action sounds follow the authored shots."),
                                     "non_diegetic_music": str(segment.get("non_diegetic_music") or "N/A")})
        source_maps[segment_id] = _source_map_inputs(source, segment, shot_ids, windows, subject_uses)

    transformed_by_id = {str(item.get("id")): item for item in all_transformed_shots}
    source["shots"] = [transformed_by_id.get(str(item.get("id")), item) for item in shots]
    source["segments"] = transformed_segments
    source["project_id"] = str(source.get("project_id") or source.get("drama_id") or source.get("brief") or "subject-prompt-production")
    source["delivery_scope"] = "full_production"
    source["production_total_duration"] = str(max((end for _start, end in windows.values()), default=0) * int(source.get("fps_den", 1)) / int(source.get("fps_num", 24)))
    source["generation_clip_limit"] = 15
    source["prompt_detail_policy"] = {"profile": "subject_prompt_v2", "minimum_words_per_second": 0, "target_words_per_second": 0, "ref2va_min_words": 0, "ref2va_target_words": 500}
    source["_canvas_subject_v2_source_maps"] = source_maps
    return source


def _source_map_inputs(source, segment, shot_ids, windows, subject_uses):
    mappings = []
    for shot_id in shot_ids:
        shot = next(item for item in rows(source.get("shots")) if str(item.get("id")) == shot_id)
        for field in ("visual", "action", "audio"):
            value = shot.get(field)
            if isinstance(value, str) and value:
                mappings.append({"sourceKind": "shot", "sourceId": shot_id, "field": field, "sourceValue": value, "sourceStart": 0, "sourceEnd": utf16_length(value), "needle": value})
        camera = shot.get("camera")
        editorial_reason = camera.get("editorial_reason") if isinstance(camera, dict) else None
        if isinstance(editorial_reason, str) and editorial_reason:
            mappings.append({"sourceKind": "shot", "sourceId": shot_id, "field": "camera.editorial_reason", "sourceValue": editorial_reason, "sourceStart": 0, "sourceEnd": utf16_length(editorial_reason), "needle": editorial_reason})
        for ref in rows(shot.get("utterance_refs")):
            utterance = next((item for item in rows(source.get("utterances")) if str(item.get("id")) == str(ref.get("utteranceId"))), None)
            if not utterance:
                continue
            text = str(utterance.get("text") or "")
            start, end = int(ref.get("textStart", 0)), int(ref.get("textEnd", 0))
            mapping = {"sourceKind": "utterance", "sourceId": str(utterance["id"]), "field": "text", "sourceValue": text,
                       "sourceStart": utf16_length(text[:start]), "sourceEnd": utf16_length(text[:end]), "needle": text[start:end]}
            if mapping["needle"]:
                mappings.append(mapping)
    return {"segmentId": str(segment.get("id")), "sourceHash": str(source.get("_canvas_subject_source_hash") or ""), "entries": mappings}


def build_source_map(prompt, inputs):
    # Ref2VA uses detailed_description; the other H3 modes put authored Shot
    # text in integrated_multimodal_description. Both sections need the same
    # field-level map for prompt edits to sync back to their source.
    detail = next((header for header in ("detailed_description:\n", "integrated_multimodal_description:\n") if header in prompt), None)
    if detail is None:
        return None
    start_body = prompt.find(detail)
    if start_body < 0:
        return None
    start_body += len(detail)
    end_body = prompt.find("\n\noverall_soundscape:", start_body)
    if end_body < 0:
        end_body = len(prompt)
    body = prompt[start_body:end_body]
    entries = []
    for mapping in inputs.get("entries", []):
        needle = mapping["needle"]
        offset = 0
        while needle and (found := body.find(needle, offset)) >= 0:
            start = start_body + found
            end = start + len(needle)
            entries.append({"start": utf16_length(prompt[:start]), "end": utf16_length(prompt[:end]),
                            "sourceKind": mapping["sourceKind"], "sourceId": mapping["sourceId"], "field": mapping["field"],
                            "sourceText": needle, "sourceValue": mapping["sourceValue"],
                            "sourceStart": mapping["sourceStart"], "sourceEnd": mapping["sourceEnd"]})
            offset = found + len(needle)
    entries.sort(key=lambda entry: (entry["start"], entry["end"]))
    accepted = []
    for entry in entries:
        if accepted and entry["start"] < accepted[-1]["end"]:
            continue
        accepted.append(entry)
    return {"version": 1, "offsetUnit": "utf16", "segmentId": inputs["segmentId"], "sourceHash": inputs["sourceHash"],
            "promptHash": __import__("hashlib").sha256(prompt.encode("utf-8")).hexdigest(), "entries": accepted}


def _plain_text(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "; ".join(text for text in (_plain_text(item) for item in value) if text)
    if isinstance(value, dict):
        excluded = {"id", "beat_id", "factId", "subjectId", "shotId", "timeline_id", "story_order", "start", "end"}
        return "; ".join(text for text in (_plain_text(item) for key, item in value.items() if key not in excluded) if text)
    return ""


def _performance_text(value):
    # Classification and persistence identifiers are not acting cues.
    if isinstance(value, dict):
        value = {key: item for key, item in value.items() if key not in {"beat_id", "beat_ids", "dominant_track"}}
    return _plain_text(value)


def _camera_prompt_lines(camera, suppressed_keys=None):
    fields = (("description", "Camera description"), ("angle", "Angle"), ("movement", "Movement"),
              ("path", "Path"), ("target", "Target"), ("focus", "Focus"))
    rendered = []
    for key, label in fields:
        if key in (suppressed_keys or set()):
            continue
        text = _plain_text(camera.get(key))
        if text and text.casefold() != "per shot description":
            rendered.append(label + ": " + text + ".")
    if "lens" not in (suppressed_keys or set()):
        lens = camera.get("lens_mm") if "lens_mm" in camera else camera.get("lens")
        if isinstance(lens, (int, float)) and not isinstance(lens, bool):
            lens_text = f"{lens:g} mm"
        else:
            lens_text = _plain_text(lens)
            if lens_text and not lens_text.casefold().endswith("mm"):
                lens_text += " mm"
        if lens_text and lens_text.casefold() != "per shot description":
            rendered.insert(1, "Lens: " + lens_text + ".")
    return rendered


def _combat_prompt_lines(shot, production):
    """Render the authored combat contract into the model-facing Shot body."""
    combat = shot.get("combat")
    if not isinstance(combat, dict) or not combat:
        return []
    labels = (
        ("force_source", "Force source"), ("trajectory", "Trajectory"),
        ("contact", "Contact"), ("resistance", "Resistance"),
        ("impact_hold", "Impact read"), ("transfer", "Force transfer"),
        ("recoil", "Recoil"),
    )
    lines = []
    for key, label in labels:
        text = _plain_text(combat.get(key))
        if text:
            lines.append(label + ": " + text)
    chain = combat.get("chain") if isinstance(combat.get("chain"), dict) else {}
    for key, label in (("attack", "Attack"), ("response", "Defender response"),
                       ("result", "Exchange result"), ("continuation", "Continuation")):
        text = _plain_text(chain.get(key))
        if text:
            lines.append(label + ": " + text)
    timing = combat.get("timing")
    if isinstance(timing, dict) and timing:
        timing_renderer = _load_runtime_helper("combat_timing").render_combat_timing
        factor = Fraction(int(production.get("fps_den", 1)), int(production.get("fps_num", 24)))
        lines.extend(timing_renderer(timing, factor))
    return ["Combat choreography:\n" + "\n".join(lines)] if lines else []


def _audio_prompt_text(value):
    if isinstance(value, dict):
        value = {key: item for key, item in value.items() if key != "no_low_frequency_reason"}
    return _plain_text(value)


def _time(frame, production):
    milliseconds = round(Fraction(int(frame) * int(production.get("fps_den", 1)) * 1000, int(production.get("fps_num", 24))))
    return f"{milliseconds // 60000:02d}:{milliseconds // 1000 % 60:02d}.{milliseconds % 1000:03d}"


# Spoken content may appear only inside <d>[Language] ... </d>. Authored prose is
# allowed to name the line ("说出已确认台词") but when it also quotes the line
# verbatim the compiled prompt carries the same words twice and the video model
# can perform them twice. The compiler therefore replaces a substantial verbatim
# copy with a language-neutral reference before the dialogue line is appended,
# and `repeated_spoken_dialogue` is the final gate for anything that bypasses it.
_QUOTE_PAIRS = (("\u201c", "\u201d"), ('"', '"'), ("\u300c", "\u300d"), ("\u300e", "\u300f"))
_LINE_NAMES = ("台词", "对白", "台词原文", "对白原文")
DIALOGUE_REFERENCE_MIN_CHARS = 4
DIALOGUE_REFERENCE_PHRASE = "该句台词"
_SENTENCE_PUNCTUATION = "。！？，；、：:.!?,;”\"’'）)]}"


def _speech_key(value):
    """Compare spoken payloads and quoted copies by content, not punctuation."""
    return re.sub(r"[\W_]+", "", str(value or ""), flags=re.UNICODE)


def _quoted_spans(text):
    """Yield (start, end, inner) for each balanced quoted span in ``text``."""
    spans = []
    pending = None
    for index, char in enumerate(text):
        if pending is not None:
            if char == pending[2]:
                spans.append((pending[0], index + 1, text[pending[0] + 1:index]))
                pending = None
            continue
        for opener, closer in _QUOTE_PAIRS:
            if char == opener:
                pending = (index, opener, closer)
                break
    return spans


def _repeated_dialogue(text, spoken_lines):
    """Quoted copies of a spoken payload that are long enough to be performed.

    Short quoted fragments ("妖", "吗") are ordinary acting directions and stay
    untouched; a copy counts only when it keeps both
    ``DIALOGUE_REFERENCE_MIN_CHARS`` characters and a third of the line.
    """
    payloads = [(_speech_key(line), str(line or "")) for line in spoken_lines]
    payloads = [(key, line) for key, line in payloads if key]
    if not payloads:
        return []
    found = []
    for start, end, inner in _quoted_spans(str(text or "")):
        key = _speech_key(inner)
        if len(key) < DIALOGUE_REFERENCE_MIN_CHARS:
            continue
        for payload_key, line in payloads:
            if key in payload_key and len(key) * 3 >= len(payload_key):
                found.append({"start": start, "end": end, "key": key, "payload": payload_key, "line": line})
                break
    return found


def _line_reference(quote_key, payload_key):
    """Reference wording for a quoted copy of ``payload_key``."""
    if quote_key == payload_key:
        return DIALOGUE_REFERENCE_PHRASE
    if payload_key.startswith(quote_key):
        return DIALOGUE_REFERENCE_PHRASE + "开头"
    if payload_key.endswith(quote_key):
        return DIALOGUE_REFERENCE_PHRASE + "结尾"
    return DIALOGUE_REFERENCE_PHRASE + "片段"


def neutralize_spoken_repetition(text, spoken_lines):
    """Replace verbatim copies of a Shot's dialogue with a spoken-line reference.

    Prose that already names the line ("说出已确认台词：...") drops the duplicate
    payload instead of restating it, so the sentence still reads as direction.
    """
    text = str(text or "")
    if not text:
        return text
    replacements = []
    for item in _repeated_dialogue(text, spoken_lines):
        start, end = item["start"], item["end"]
        reference = _line_reference(item["key"], item["payload"])
        prefix = text[:start].rstrip()
        # "说出已确认台词：" names the line; the colon is not part of the name.
        name_prefix = prefix[:-1].rstrip() if prefix.endswith(("：", ":")) else prefix
        replacement = reference
        drop = start
        if reference == DIALOGUE_REFERENCE_PHRASE and name_prefix.endswith(_LINE_NAMES):
            # The line is already named; drop the payload and the colon that
            # introduced it rather than saying "说出已确认台词：该句台词".
            while drop > 0 and text[drop - 1] in " \t":
                drop -= 1
            if drop > 0 and text[drop - 1] in "：:":
                drop -= 1
                while drop > 0 and text[drop - 1] in " \t":
                    drop -= 1
            replacement = "" if end < len(text) and text[end] in _SENTENCE_PUNCTUATION else "，"
        elif reference == DIALOGUE_REFERENCE_PHRASE and name_prefix.endswith(("句", "字")):
            replacement = "台词"
        if (drop == start and replacement == DIALOGUE_REFERENCE_PHRASE
                and end < len(text) and text[end] not in _SENTENCE_PUNCTUATION):
            # Keep the sentence readable where the quote carried its own boundary.
            replacement += "，"
        replacements.append((drop, end, replacement))
    result, cursor = [], 0
    for start, end, replacement in replacements:
        if start < cursor:
            continue
        result.append(text[cursor:start])
        result.append(replacement)
        cursor = end
    result.append(text[cursor:])
    output = "".join(result)
    for payload in (str(line or "") for line in spoken_lines):
        # An unquoted verbatim copy cannot be a direction; replace the exact text.
        if len(_speech_key(payload)) >= DIALOGUE_REFERENCE_MIN_CHARS and payload in output:
            output = output.replace(payload, DIALOGUE_REFERENCE_PHRASE)
    return output


def repeated_spoken_dialogue(text, speech_expectations):
    """Spoken payloads that also appear outside their single legal <d> location."""
    prose = re.sub(r"<d>[\s\S]*?</d>", " ", str(text or ""))
    prose_key = _speech_key(prose)
    violations = []
    for speaker, _language, source_text in speech_expectations or ():
        payload = re.sub(r"<scenetrans>|<cutoff>", "", str(source_text or ""))
        payload_key = _speech_key(payload)
        if len(payload_key) < DIALOGUE_REFERENCE_MIN_CHARS:
            continue
        copies = _repeated_dialogue(prose, [payload])
        if copies:
            violations.append("speaker " + str(speaker) + " dialogue is quoted again outside <d>: “" + copies[0]["key"] + "”")
        elif payload_key in prose_key:
            violations.append("speaker " + str(speaker) + " dialogue is repeated verbatim outside <d>: “" + payload.strip() + "”")
    return violations


def render_shot_text_v2(shot, production, speakers, speech_parts, referenced_subjects=None):
    camera = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
    parts = []
    framing = str(camera.get("framing") or "")
    if framing:
        parts.append("Framing: " + framing + ".")
    attention = []
    by_subject = {str(item.get("id")): item for item in rows(production.get("subject_registry"))}
    for subject_id in camera.get("attention_subject_ids", []):
        subject = by_subject.get(str(subject_id))
        entity_id = str((subject or {}).get("entityRef", {}).get("id") or "")
        label = (referenced_subjects or {}).get(entity_id)
        name = entity_text(production, subject)[0] if subject else str(subject_id)
        attention.append((label + " (" + name + ")") if label else name)
    if attention:
        parts.append("The camera gives visual attention to " + ", ".join(attention) + ".")
    reason = str(camera.get("editorial_reason") or "")
    if reason:
        parts.append("Editorial reason: " + reason)
    parts.extend(_camera_prompt_lines(camera))
    visual = str(shot.get("visual") or "").strip()
    if visual:
        parts.append(visual)
    action = str(shot.get("action") or shot.get("action_description") or "").strip()
    if action and action != visual:
        parts.append("Action: " + action)
    parts.extend(_combat_prompt_lines(shot, production))
    performance = _performance_text(shot.get("performance"))
    if performance:
        parts.append("Performance: " + performance)
    audio = _audio_prompt_text(shot.get("audio"))
    if audio:
        parts.append("Sound: " + audio)
    for event in shot.get("_canvas_v2_events", []):
        fact = next((item for item in rows((production.get("ledger") or {}).get("facts")) if str(item.get("id")) == str(event.get("fact_id"))), {})
        desc = (fact.get("value_descriptions") or {}).get(str(event.get("after")), str(event.get("after") or ""))
        time = _time(int(event.get("local_frame", 0)), production)
        parts.append("At local shot time " + time + ", the registered state changes: " + str(desc) + ".")
        if event.get("reason"):
            parts.append("Recorded cause: " + str(event["reason"]))

    by_id = {str(item.get("id")): item for item in rows(production.get("subject_registry"))}
    for line in sorted(rows(shot.get("dialogues")), key=lambda item: int(item.get("start", 0))):
        identity = str(line.get("character_id") or line.get("speaker_name") or "")
        speaker = speakers.get(identity, str(line.get("speaker_id") or "S1"))
        name = str(line.get("speaker_name") or identity or "Narrator")
        subject = next((item for item in by_id.values() if str(item.get("entityRef", {}).get("id")) == identity), None)
        subject_label = (referenced_subjects or {}).get(identity) or (referenced_subjects or {}).get(str((subject or {}).get("id") or ""))
        voice = name + ((" " + subject_label) if subject_label else "")
        start = _time(int(line.get("start", 0)), production)
        end = _time(int(line.get("end", 0)), production)
        spoken = str(line.get("text") or "")
        uid = str(line.get("utterance_id") or "")
        if uid and speech_parts:
            ids = speech_parts.get(uid, [])
            if ids and str(shot.get("id")) != ids[0]:
                spoken = "<scenetrans>" + spoken
            if ids and str(shot.get("id")) != ids[-1]:
                spoken += "<scenetrans>"
        line_text = "During " + start + "–" + end + " seconds within this shot, " + voice + " (" + speaker + "), " + str(line.get("delivery") or "natural, intelligible delivery") + ": <d>[" + str(line.get("language") or "Chinese") + "] " + spoken + "</d>."
        if line.get("voiceover"):
            line_text += " The speaker stays offscreen; visible listeners remain silent."
        else:
            line_text += " Preserve the original words and synchronize only the visible speaker's mouth."
        if uid:
            line_text += " The utterance continues seamlessly across the cut."
        parts.append(line_text)
    return " ".join(part for part in parts if part)


def render_continuity_text_v2(shot, production):
    return _render_state_end(production, production.get("_continuity_report") or {}, shot, rows(production.get("subject_registry")))


def _subject_presence_index(production, segment, shots):
    """Compact repeated, explicit Subject presentation into one scoped index.

    Missing usages are deliberately omitted: absence of a declaration is not
    evidence that a Subject is offscreen. Ambiguous duplicate usages within a
    Shot are left in the local Shot prose rather than normalized here.
    """
    subjects = {str(item.get("id")): item for item in rows(production.get("subject_registry"))}
    labels_by_entity = {str(item.get("entity_id") or ""): str(item.get("label") or "")
                        for item in rows(segment.get("subjects"))}
    by_subject = {}
    local_lines = {}
    covered = set()
    ambiguous_subjects = set()
    for shot_number, shot in enumerate(shots, 1):
        shot_id = str(shot.get("id") or "")
        seen_in_shot = set()
        for usage in rows(shot.get("subject_usages")):
            subject_id = str(usage.get("subjectId") or "")
            subject = subjects.get(subject_id)
            entity_id = str((subject or {}).get("entityRef", {}).get("id") or "")
            label = labels_by_entity.get(entity_id)
            if not subject_id or not label:
                continue
            status = _subject_presentation(subject, usage)
            if subject_id in ambiguous_subjects:
                continue
            if subject_id in seen_in_shot:
                # A duplicate or conflicting declaration must remain explicit.
                ambiguous_subjects.add(subject_id)
                by_subject.pop(subject_id, None)
                covered = {item for item in covered if item[1] != subject_id}
                local_lines = {key: line for key, line in local_lines.items() if key[1] != subject_id}
                continue
            seen_in_shot.add(subject_id)
            by_subject.setdefault(subject_id, {"label": label, "records": []})["records"].append(
                (shot_number, shot_id, status))
            if status == "visible":
                local_line = label + " is visible in this Shot."
            elif status == "offscreen_voice":
                local_line = label + " is an offscreen voice and has no visible body in this Shot."
            else:
                local_line = label + " supplies continuity context only and is not visible in this Shot."
            covered.add((shot_id, subject_id, status))
            local_lines[(shot_id, subject_id, status)] = local_line

    groups = []
    for subject_id, value in by_subject.items():
        records = value["records"]
        if not records or subject_id in ambiguous_subjects:
            continue
        spans = []
        for shot_number, _shot_id, status in records:
            if spans and spans[-1][0] == status and spans[-1][1][-1] == shot_number - 1:
                spans[-1][1].append(shot_number)
            else:
                spans.append([status, [shot_number]])
        clauses = []
        for status, numbers in spans:
            scope = ("Shot " + str(numbers[0]) if len(numbers) == 1
                     else "Shots " + str(numbers[0]) + "–" + str(numbers[-1]))
            if status == "visible":
                description = "visible in " + scope
            elif status == "offscreen_voice":
                description = "offscreen voice with no visible body in " + scope
            else:
                description = "continuity context only, not visible in " + scope
            clauses.append(description)
        groups.append(value["label"] + ": " + "; ".join(clauses))

    if not groups:
        return "", set()
    candidate = "Subject presence by Shot: " + "; ".join(groups) + "."
    # Use the index only when it actually shortens the repeated local lines.
    if len(candidate) >= sum(len(local_lines[key]) for key in covered):
        return "", set()
    return candidate, covered


def _shot_camera_facts(production, segment, shot):
    camera = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
    facts = {}
    framing = _plain_text(camera.get("framing"))
    if framing:
        facts["framing"] = ("Framing", framing, "Framing: " + framing + ".")
    for key, label in (("description", "Camera description"), ("angle", "Angle"), ("movement", "Movement"),
                       ("path", "Path"), ("target", "Target"), ("focus", "Focus")):
        value = _plain_text(camera.get(key))
        if value and value.casefold() != "per shot description":
            facts[key] = (label, value, label + ": " + value + ".")
    lens = camera.get("lens_mm") if "lens_mm" in camera else camera.get("lens")
    if isinstance(lens, (int, float)) and not isinstance(lens, bool):
        lens_text = f"{lens:g} mm"
    else:
        lens_text = _plain_text(lens)
        if lens_text and not lens_text.casefold().endswith("mm"):
            lens_text += " mm"
    if lens_text and lens_text.casefold() != "per shot description":
        facts["lens"] = ("Lens", lens_text, "Lens: " + lens_text + ".")

    subjects = {str(item.get("id")): item for item in rows(production.get("subject_registry"))}
    subject_labels = {str(item.get("entity_id") or ""): str(item.get("label") or "")
                      for item in rows(segment.get("subjects"))}
    attention = []
    for subject_id in camera.get("attention_subject_ids", []):
        subject = subjects.get(str(subject_id))
        if subject:
            entity_id = str(subject.get("entityRef", {}).get("id") or "")
            label = subject_labels.get(entity_id)
            name = entity_text(production, subject)[0]
            attention.append((label + " (" + name + ")") if label else name)
    if attention:
        value = ", ".join(attention)
        facts["attention"] = ("Visual attention", value, "The camera gives visual attention to " + value + ".")
    return facts


def _shot_camera_index(production, segment, shots):
    """Move only repeated, identical camera facts to an explicit Shot index."""
    by_key = {}
    for shot_number, shot in enumerate(shots, 1):
        for key, (label, value, local_line) in _shot_camera_facts(production, segment, shot).items():
            by_key.setdefault(key, []).append((shot_number, str(shot.get("id") or ""), label, value, local_line))

    clauses = []
    suppressed = {}
    original_size = 0
    for key, records in by_key.items():
        spans = []
        for record in records:
            shot_number, _shot_id, label, value, local_line = record
            if spans and spans[-1]["value"] == value and spans[-1]["records"][-1][0] == shot_number - 1:
                spans[-1]["records"].append(record)
            else:
                spans.append({"value": value, "records": [record]})
        for span in spans:
            if len(span["records"]) < 2:
                continue
            first = span["records"][0][0]
            last = span["records"][-1][0]
            scope = "Shot " + str(first) if first == last else "Shots " + str(first) + "–" + str(last)
            label = span["records"][0][2]
            clauses.append(label + ": " + span["value"] + " in " + scope)
            for shot_number, shot_id, _label, _value, local_line in span["records"]:
                suppressed.setdefault(shot_id, set()).add(key)
                original_size += len(local_line)

    if not clauses:
        return "", {}
    candidate = "Camera facts by Shot: " + "; ".join(clauses) + "."
    if len(candidate) >= original_size:
        return "", {}
    return candidate, suppressed


def _shot_prompt_v2(production, segment, shot, shot_number, speakers, *, state_lines=None,
                    suppressed_presence=None, suppressed_camera=None):
    camera = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
    fps_num, fps_den = int(production.get("fps_num", 24)), int(production.get("fps_den", 1))
    clip_start = int(segment["start_frame"])
    local_start = int(shot["start_frame"]) - clip_start
    local_end = int(shot["end_frame"]) - clip_start
    duration = float(Fraction((local_end - local_start) * fps_den, fps_num))
    start_time, end_time = _time(local_start, production), _time(local_end, production)
    if shot_number == 1:
        header = "[Shot 1] " + start_time + "–" + end_time + " within this Clip."
    else:
        header = "[Shot " + str(shot_number) + "] At " + start_time + ", covering " + start_time + "–" + end_time + " within this Clip."
    parts = [header]
    subjects = {str(item.get("id")): item for item in rows(production.get("subject_registry"))}
    for state_line in state_lines or []:
        parts.append(state_line)
    framing = str(camera.get("framing") or "").strip()
    camera_suppressed = (suppressed_camera or {}).get(str(shot.get("id") or ""), set())
    if framing and "framing" not in camera_suppressed:
        parts.append("Framing: " + framing + ".")
    attention = []
    for subject_id in camera.get("attention_subject_ids", []):
        subject = subjects.get(str(subject_id))
        if subject:
            label = next((entry.get("label") for entry in segment.get("subjects", []) if entry.get("entity_id") == subject.get("entityRef", {}).get("id")), "")
            attention.append((str(label) + " (" + entity_text(production, subject)[0] + ")") if label else entity_text(production, subject)[0])
    if attention and "attention" not in camera_suppressed:
        parts.append("The camera gives visual attention to " + ", ".join(attention) + ".")
    subject_labels = {}
    for entry in segment.get("subjects", []):
        subject_labels[str(entry.get("entity_id") or "")] = str(entry.get("label") or "")
    for usage in rows(shot.get("subject_usages")):
        subject = subjects.get(str(usage.get("subjectId")))
        entity_id = str((subject or {}).get("entityRef", {}).get("id") or "")
        label = subject_labels.get(entity_id)
        if not label:
            continue
        presentation = _subject_presentation(subject, usage)
        status = presentation
        if (str(shot.get("id") or ""), str(usage.get("subjectId") or ""), status) in (suppressed_presence or set()):
            continue
        if presentation == "visible":
            parts.append(label + " is visible in this Shot.")
        elif presentation == "offscreen_voice":
            parts.append(label + " is an offscreen voice and has no visible body in this Shot.")
        else:
            parts.append(label + " supplies continuity context only and is not visible in this Shot.")
    editorial_reason = str(camera.get("editorial_reason") or "").strip()
    if editorial_reason:
        parts.append("Editorial reason for this shot and cut: " + editorial_reason)
    parts.extend(_camera_prompt_lines(camera, camera_suppressed))
    visual = str(shot.get("visual") or "").strip()
    if visual:
        parts.append(visual)
    action = str(shot.get("action") or shot.get("action_description") or "").strip()
    if action and action != visual:
        parts.append("Action: " + action)
    parts.extend(_combat_prompt_lines(shot, production))
    performance = _performance_text(shot.get("performance"))
    if performance:
        parts.append("Performance: " + performance)
    sound = _audio_prompt_text(shot.get("audio"))
    if sound:
        parts.append("Diegetic sound: " + sound)
    for event in shot.get("_canvas_v2_events", []):
        fact = next((item for item in rows((production.get("ledger") or {}).get("facts")) if str(item.get("id")) == str(event.get("fact_id"))), {})
        after = event.get("after")
        description = (fact.get("value_descriptions") or {}).get(str(after), "未知" if after == "unknown" else str(after or ""))
        local_frame = int(event.get("local_frame", 0))
        if local_frame == 0:
            continue
        parts.append("During " + _time(local_frame, production) + " of this Shot, the registered state changes: " + str(description) + ".")
    for picture in segment.get("references", []):
        if picture.get("source_only"):
            continue
        if str(shot["id"]) not in [str(value) for value in picture.get("shot_ids", [])]:
            continue
        if picture.get("anchor_shot_ids") and str(shot["id"]) not in [str(value) for value in picture["anchor_shot_ids"]]:
            continue
        if picture.get("is_keyframe"):
            anchor = {"opening": "shot-entry", "closing": "shot-ending", "at_frame": "declared-frame"}.get(str(picture.get("anchor") or ""), "shot-entry")
            start_seconds = float(Fraction(local_start * fps_den, fps_num))
            end_seconds = float(Fraction(local_end * fps_den, fps_num))
            parts.append("From " + f"{start_seconds:.3f}" + " to " + f"{end_seconds:.3f}"
                         + " seconds of this request, " + str(picture["label"]) + " is the persisted storyboard frame for [Shot " + str(shot_number)
                         + "]; preserve its original " + anchor + " composition and camera. Preserve only: "
                         + str(picture.get("preserve") or "the registered visual evidence") + ". Do not inherit: "
                         + str(picture.get("exclude") or "identity or staging changes") + ".")
        else:
            parts.append("Use " + str(picture["label"]) + " only for its declared " + str(picture.get("role") or "reference") + " attributes; preserve " + str(picture.get("preserve") or "the registered visual evidence") + ".")
        if picture.get("anchor") and not picture.get("is_keyframe"):
            parts.append(str(picture["anchor"]).capitalize() + " keyframe anchor: " + str(picture["label"]) + ".")
    # Authored prose above may name the line but must not carry it verbatim; the
    # <d> lines appended below stay the single spoken payload of this Shot.
    prose = neutralize_spoken_repetition(" ".join(part for part in parts if part),
                                         [line.get("text") for line in rows(shot.get("dialogues"))])
    dialogue_parts = []
    for line in sorted(rows(shot.get("dialogues")), key=lambda item: int(item.get("start", 0))):
        speaker_identity = str(line.get("character_id") or line.get("speaker_name") or "")
        speaker_name = str(line.get("speaker_name") or speaker_identity or "Narrator")
        speaker_tag = speakers.get(speaker_identity, "S1")
        spoken = str(line.get("text") or "")
        utterance_id = str(line.get("utterance_id") or "")
        if utterance_id:
            pieces = [entry for current in production["shots"] for entry in rows(current.get("dialogues")) if str(entry.get("utterance_id") or "") == utterance_id]
            if pieces and shot["id"] != pieces[0].get("_shot_id"):
                spoken = "<scenetrans>" + spoken
            if pieces and shot["id"] != pieces[-1].get("_shot_id"):
                spoken += "<scenetrans>"
        start = _time(int(line.get("start", 0)), production)
        end = _time(int(line.get("end", 0)), production)
        verb = "speaks" if line.get("voiceover") else "says"
        delivery = neutralize_spoken_repetition(
            str(line.get("delivery") or "natural, intelligible delivery"),
            [line.get("text") or spoken])
        line_text = "During " + start + "–" + end + " within this Shot, " + speaker_name + " (" + speaker_tag + ") " + verb + " with " + delivery + ": <d>[" + str(line.get("language") or "Chinese") + "] " + spoken + "</d>."
        if line.get("voiceover"):
            line_text += " The speaker remains offscreen; visible listeners stay silent."
        else:
            line_text += " Preserve the original words and synchronize only the visible speaker's mouth."
        if utterance_id:
            line_text += " The utterance continues seamlessly across the cut."
        dialogue_parts.append(line_text)
    return " ".join(part for part in [prose, *dialogue_parts] if part)


def _load_runtime_helper(name):
    if name in sys.modules:
        return sys.modules[name]
    candidate = Path(__file__).resolve().parent / f"{name}.py"
    if not candidate.is_file():
        candidate = Path(__file__).resolve().parents[2] / ".agents" / "skills" / "acheng-director" / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, candidate)
    module = importlib.util.module_from_spec(spec); sys.modules[name] = module; spec.loader.exec_module(module); return module


def compile_prompt_v2(production, segment, *, draft=False):
    mode = str(segment["mode"])
    shot_ids = [str(value) for value in segment["shot_ids"]]
    references = rows(segment.get("references"))
    shots_by_id = {str(item["id"]): item for item in production["shots"]}
    shots = [shots_by_id[str(shot_id)] for shot_id in segment["shot_ids"]]
    anchor_roles = [str(item.get("anchor") or "") for shot in shots for item in rows(shot.get("keyframes")) if item.get("requiredForSubmission", True) and item.get("anchor") != "composition"]
    if not draft and mode == "T2VA" and references:
        raise ValueError("T2VA cannot consume bound Subject or required keyframe pictures; preserve the bindings and select a compatible mode.")
    if not draft and mode == "I2VA" and (len(references) != 1 or "opening" not in anchor_roles):
        raise ValueError("I2VA needs exactly one required opening keyframe; the compiler will not move another picture into the first-frame slot.")
    if not draft and mode == "FL2VA" and (len(references) != 2 or not {"opening", "closing"} <= set(anchor_roles)):
        raise ValueError("FL2VA needs required opening and closing keyframes; the compiler will not discard or reposition anchors.")
    if not draft and mode == "L2VA" and (len(references) != 1 or "closing" not in anchor_roles):
        raise ValueError("L2VA needs exactly one required closing keyframe.")
    speakers = {}
    for shot in shots:
        for line in rows(shot.get("dialogues")):
            identity = str(line.get("character_id") or line.get("speaker_name") or "")
            if identity and identity not in speakers:
                speakers[identity] = "S" + str(len(speakers) + 1)
    report = production.get("_continuity_report") or {}
    subjects = rows(production.get("subject_registry"))
    detail_rows = []
    carried_state = {}
    presence_index, suppressed_presence = _subject_presence_index(production, segment, shots)
    camera_index, suppressed_camera = _shot_camera_index(production, segment, shots)
    for index, shot in enumerate(shots):
        shot_id = str(shot.get("id"))
        start_state = _state_snapshot(production, report, shot, subjects, "start")
        end_state = _state_snapshot(production, report, shot, subjects, "end")
        if index == 0:
            state_lines = (["Clip opening states: " + "; ".join(item["text"] for item in start_state.values())]
                           if start_state else [])
        else:
            changes_at_cut = [item["text"] for fact_id, item in start_state.items()
                              if fact_id not in carried_state or item["value"] != carried_state[fact_id]["value"]]
            state_lines = (["At this cut, state changes to: " + "; ".join(changes_at_cut)] if changes_at_cut else [])
        event_fact_ids = {str(event.get("fact_id")) for event in shot.get("_canvas_v2_events", [])}
        changes_by_end = [item["text"] for fact_id, item in end_state.items()
                          if fact_id not in event_fact_ids and (fact_id not in start_state or item["value"] != start_state[fact_id]["value"])]
        if changes_by_end:
            state_lines.append("State changes by shot end: " + "; ".join(changes_by_end))
        detail_rows.append(_shot_prompt_v2(production, segment, shot, index + 1, speakers,
                                           state_lines=state_lines,
                                           suppressed_presence=suppressed_presence, suppressed_camera=suppressed_camera))
        carried_state.update(start_state)
        carried_state.update(end_state)
    scoped_indexes = [line for line in (presence_index, camera_index) if line]
    detail = "\n".join(scoped_indexes + detail_rows)
    soundscape = str(segment.get("overall_soundscape") or "Synchronized dialogue, ambience and action sounds follow the authored shots.")
    music = str(segment.get("non_diegetic_music") or "N/A")
    if mode == "Ref2VA":
        picture_definitions = [str(item.get("definition") or "") for item in references if not item.get("source_only", False)]
        definitions = "\n".join([*picture_definitions, *(str(subject.get("definition") or "") for subject in segment.get("subjects", []))])
        retention_lines = []
        for item in references:
            if not item.get("source_only", False):
                retention_lines.append(str(item.get("retention") or ""))
        retention_lines.extend(str(subject.get("retention") or "") for subject in segment.get("subjects", []) if subject.get("retention"))
        retention = "\n".join(retention_lines)
        fields = [
            ("subject_definitions", definitions),
            ("summary", str(segment.get("summary") or "[reference generation] Authored Subjects and camera Shots.")),
            ("retention_analysis", retention),
            ("detailed_description", detail),
            ("overall_soundscape", soundscape),
            ("non_diegetic_music", music),
        ]
    else:
        anchor_text = " ".join(str(item["label"]) + " anchors the " + str(item.get("role") or "frame") + " for its declared Shot scope." for item in references)
        fields = [("integrated_multimodal_description", anchor_text + "\n" + detail), ("overall_soundscape", soundscape), ("non_diegetic_music", music)]
    raw = "\n\n".join(key + ":\n" + value for key, value in fields) + "\n"
    h3_contract = _load_runtime_helper("h3_contract")
    speech_map = h3_contract.speech_map
    h3_final_format = _load_runtime_helper("h3_final_format")
    finalize_h3_prompt, normalize_h3_prompt = h3_final_format.finalize_h3_prompt, h3_final_format.normalize_h3_prompt
    speech_expectations = []
    for shot in shots:
        for line in rows(shot.get("dialogues")):
            identity = str(line.get("character_id") or line.get("speaker_name") or "")
            speech_expectations.append((speakers.get(identity, "S1"), line.get("language", "Chinese"), line.get("text", "")))
    if draft:
        final = normalize_h3_prompt(raw)
    else:
        final = finalize_h3_prompt(raw, mode=mode, shot_count=len(shots),
                                   reference_labels=[str(item["label"]) for item in references],
                                   subject_labels=[str(item["label"]) for item in segment.get("subjects", [])],
                                   speech_expectations=speech_expectations,
                                   minimum_words=0)
    # Spoken content is legal only inside <d>. A Shot whose prose still carries the
    # line verbatim would make the model perform it twice, so it fails here instead
    # of shipping: fix the authored field rather than relying on the model.
    violations = repeated_spoken_dialogue(final, speech_expectations)
    if violations:
        raise ValueError("H3 台词重复（台词只能在 <d> 内出现一次）: " + "; ".join(violations))
    return final
