"""Compiler-owned projection from Subject Prompt v2 source to the existing H3 delivery contract."""
from collections import defaultdict
from copy import deepcopy
from fractions import Fraction


def rows(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def entity_text(source, subject):
    ref = subject.get("entityRef", {})
    entity_id = str(ref.get("id", ""))
    registry = {"character": "character_registry", "scene": "scene_registry", "asset": "asset_plan"}.get(ref.get("kind"), "asset_plan")
    row = next((item for item in rows(source.get(registry)) if str(item.get("id") or item.get("asset_id") or "") == entity_id), {})
    name = str(row.get("name") or row.get("asset_name") or row.get("title") or row.get("scene_name") or entity_id)
    description = " ".join(str(row.get(key) or "").strip() for key in ("prompt_description", "appearance", "description") if str(row.get(key) or "").strip())
    return name, description


def binding_ids(subject, usage):
    bindings = rows(subject.get("pictureBindings"))
    explicit = [str(value) for value in usage.get("pictureBindingIds", [])]
    if explicit:
        return explicit
    if usage.get("presentation") != "visible":
        return []
    requirements = {str(item.get("factId")): str(item.get("value")) for item in rows(usage.get("stateRequirements"))}
    purposes = usage.get("referencePurpose") or ["identity"]
    selected = []
    for purpose in dict.fromkeys(map(str, purposes)):
        candidates = [item for item in bindings
                      if purpose in [str(value) for value in item.get("defaultFor", [])]
                      and all(requirements.get(str(key)) == str(value) for key, value in (item.get("applicableState") or {}).items())]
        if len(candidates) != 1:
            raise ValueError("Subject " + str(subject.get("id")) + " lacks one unambiguous " + purpose + " default picture binding")
        selected.append(str(candidates[0]["id"]))
    return selected


def _state_start_descriptions(source, report, shot, subjects):
    trajectory = (report.get("trajectories") or {}).get(str(shot.get("id")), {})
    start = trajectory.get("start", {})
    facts = {str(item.get("id")): item for item in rows((source.get("ledger") or {}).get("facts"))}
    subject_by_entity = {(str(item.get("entityRef", {}).get("kind")), str(item.get("entityRef", {}).get("id"))): item for item in subjects}
    used = {str(value) for value in shot.get("continuity_facts", [])}
    for usage in rows(shot.get("subject_usages")):
        used.update(str(value) for value in usage.get("continuityFactIds", []))
        used.update(str(item.get("factId")) for item in rows(usage.get("stateRequirements")))
        subject = next((item for item in subjects if str(item.get("id")) == str(usage.get("subjectId"))), None)
        ref = (subject or {}).get("entityRef", {})
        for fact in facts.values():
            if str(fact.get("object_kind")) == str(ref.get("kind")) and str(fact.get("object_id")) == str(ref.get("id")):
                used.add(str(fact.get("id")))
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
    return "; ".join(values) if values else "No registered continuity facts apply at this shot's opening."


def _render_state_end(source, report, shot, subjects):
    trajectory = (report.get("trajectories") or {}).get(str(shot.get("id")), {})
    end = trajectory.get("end", {})
    facts = {str(item.get("id")): item for item in rows((source.get("ledger") or {}).get("facts"))}
    subject_by_entity = {(str(item.get("entityRef", {}).get("kind")), str(item.get("entityRef", {}).get("id"))): item for item in subjects}
    chunks = []
    for fact_id, value in sorted(end.items()):
        fact = facts.get(str(fact_id))
        if not fact:
            continue
        description = (fact.get("value_descriptions") or {}).get(str(value))
        if not description:
            continue
        owner = subject_by_entity.get((str(fact.get("object_kind")), str(fact.get("object_id"))))
        name = entity_text(source, owner)[0] if owner else "The registered subject"
        chunks.append(name + " " + str(fact.get("property") or fact.get("name") or "state") + " remains: " + str(description))
    return "; ".join(chunks) if chunks else "No registered continuity facts change at this shot's ending."


def adapt_production(production):
    """Project authored v2 data to the mature H3 packaging schema without writing it back."""
    if (production.get("prompt_assembly") or {}).get("version") != 2:
        return production
    source = deepcopy(production)
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

    from continuity_v2 import audit as audit_continuity
    continuity = audit_continuity(source)
    assets = {str(item.get("asset_id") or item.get("id")): item for item in rows(source.get("asset_plan"))}
    reference_cache = {}
    transformed_segments = []
    all_transformed_shots = []
    source_maps = {}
    for segment in segments:
        segment_id = str(segment.get("id"))
        shot_ids = [str(value) for value in segment.get("shot_ids", [])]
        selected_pictures = []
        picture_by_digest = {}
        subject_uses = defaultdict(list)
        reference_requirements = defaultdict(list)
        for shot_id in shot_ids:
            shot = next((item for item in shots if str(item.get("id")) == shot_id), None)
            if not shot:
                raise ValueError("Clip " + segment_id + " refers to an unknown Shot " + shot_id)
            for usage in (rows(shot.get("subject_usages")) if str(segment.get("mode")) == "Ref2VA" else []):
                subject_id = str(usage.get("subjectId") or "")
                subject = subject_by_id.get(subject_id)
                if not subject:
                    raise ValueError("Shot " + shot_id + " refers to an unknown Subject " + subject_id)
                for binding_id in binding_ids(subject, usage):
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
            for frame in rows(shot.get("keyframes")):
                if not frame.get("requiredForSubmission"):
                    continue
                binding_id = str(frame.get("id") or "")
                snapshot = snapshots.get(binding_id)
                if not snapshot:
                    raise ValueError("Required keyframe " + binding_id + " is not in the frozen compiler inputs")
                digest = str(snapshot.get("sha256") or "")
                picture = picture_by_digest.get(digest)
                if not picture:
                    picture = {"number": len(selected_pictures) + 1, "label": "<Picture " + str(len(selected_pictures) + 1) + ">",
                               "sha256": digest, "file": str(snapshot["file"]), "asset_ids": [], "entity_ids": [],
                               "subject_ids": [], "shot_ids": [], "roles": [], "retain": [], "exclude": [],
                               "asset_version": "sha256:" + digest, "is_keyframe": True, "anchor": str(snapshot.get("anchor") or ""), "anchor_shot_ids": []}
                    picture_by_digest[digest] = picture
                    selected_pictures.append(picture)
                picture["is_keyframe"] = True
                picture["anchor_shot_ids"].append(shot_id)
                picture["shot_ids"].append(shot_id)
                picture["roles"].append("keyframe")
                picture["retain"].extend(str(value) for value in frame.get("retain", []))
                picture["exclude"].extend(str(value) for value in frame.get("exclude", []))
                ref_subject = next((subject_by_id.get(str(sid)) for sid in frame.get("subjectIds", []) if str(sid) in subject_by_id), None)
                entity_id = str((ref_subject or {}).get("entityRef", {}).get("id") or "")
                if entity_id:
                    picture["entity_ids"].append(entity_id)
                    picture["subject_ids"].append(str(ref_subject.get("id")))
                    reference_requirements[shot_id].append({"entity_id": entity_id, "asset_version": picture["asset_version"], "purpose": "keyframe"})

        if not selected_pictures and str(segment.get("mode")) != "T2VA":
            raise ValueError("Clip " + segment_id + " needs at least one image binding for its selected generation mode")
        start_frame = windows[shot_ids[0]][0]
        end_frame = windows[shot_ids[-1]][1]
        duration = float(Fraction((end_frame - start_frame) * int(source.get("fps_den", 1)), int(source.get("fps_num", 24))))
        if duration < 4 or duration > 15:
            raise ValueError("Clip " + segment_id + " duration is outside the 4–15 second H3 range")
        mode = str(segment.get("mode") or "")
        if not mode or segment.get("mode_lock", mode) != mode or not str(segment.get("mode_selection_reason") or "").strip():
            raise ValueError("Clip " + segment_id + " must declare its locked generation mode and reason")
        refs = []
        for picture in selected_pictures:
            asset_ids = list(dict.fromkeys(value for value in picture["asset_ids"] if value))
            entity_ids = list(dict.fromkeys(value for value in picture["entity_ids"] if value))
            asset_id = asset_ids[0] if asset_ids else ""
            if asset_id:
                plan = assets.get(asset_id)
                if not plan:
                    plan = {"id": asset_id, "asset_id": asset_id, "kind": "keyframe" if picture["is_keyframe"] else "prop",
                            "name": asset_id, "version": picture["asset_version"], "entity_id": entity_ids[0] if entity_ids else "",
                            "entity_ids": entity_ids, "status": "selected_result"}
                    source.setdefault("asset_plan", []).append(plan)
                    assets[asset_id] = plan
                plan.update({"file": picture["file"], "sha256": picture["sha256"], "version": picture["asset_version"], "status": "selected_result",
                             "entity_id": entity_ids[0] if entity_ids else plan.get("entity_id"), "entity_ids": entity_ids})
            picture_shots = list(dict.fromkeys(picture["shot_ids"]))
            picture_scope = ", ".join("[Shot " + str(shot_ids.index(str(value)) + 1) + "]" for value in picture_shots if str(value) in shot_ids)
            picture_preserve = "; ".join(dict.fromkeys(picture["retain"])) or "registered visual attributes"
            picture_exclude = "; ".join(dict.fromkeys(picture["exclude"])) or "unregistered pose or background"
            refs.append({"label": picture["label"], "image": picture["number"], "asset_id": asset_id,
                         "asset_version": picture["asset_version"], "sha256": picture["sha256"], "file": picture["file"],
                         "entity_id": entity_ids[0] if entity_ids else "", "entity_ids": entity_ids,
                         "role": picture["roles"][0] if picture["roles"] else "keyframe",
                         "preserve": picture_preserve, "exclude": picture_exclude,
                         "definition": picture["label"] + " is the archived " + str(picture["roles"][0] if picture["roles"] else "reference") + " image for " + picture_scope + "; it contributes only its registered visual evidence.",
                         "retention": picture["label"] + " (" + picture_scope + "): partially_preserved - retain " + picture_preserve + "; exclude " + picture_exclude + ".",
                         "shot_ids": picture_shots, **({"anchor_shot_ids": list(dict.fromkeys(picture["anchor_shot_ids"]))} if picture["anchor_shot_ids"] else {}),
                         "start_frame": start_frame, "end_frame": end_frame})

        subject_entries = []
        subject_labels = {}
        for subject_id, uses in subject_uses.items():
            if subject_id not in subject_labels:
                subject_labels[subject_id] = "<Subject " + str(len(subject_labels) + 1) + ">"
            subject = subject_by_id[subject_id]
            name, description = entity_text(source, subject)
            labels = list(dict.fromkeys(label for _shot, label, _binding in uses))
            shot_scope = list(dict.fromkeys(sid for sid, _label, _binding in uses))
            shot_numbers = [shot_ids.index(sid) + 1 for sid in shot_scope]
            retain = list(dict.fromkeys(value for _sid, _label, binding in uses for value in binding.get("retain", [])))
            exclude = list(dict.fromkeys(value for _sid, _label, binding in uses for value in binding.get("exclude", [])))
            label = subject_labels[subject_id]
            subject_entries.append({"label": label, "entity_id": str(subject.get("entityRef", {}).get("id") or subject_id),
                                    "definition": label + " is " + (description or name) + ", represented by " + ", ".join(labels) + ".",
                                    "retention": label + " (" + ", ".join("[Shot " + str(value) + "]" for value in shot_numbers)
                                    + "): partially_preserved - retain " + (", ".join(retain) or "the registered identity")
                                    + "; exclude " + (", ".join(exclude) or "unregistered appearance changes") + ".",
                                    "shot_ids": shot_scope, "start_frame": start_frame, "end_frame": end_frame})

        transformed_shots = []
        for shot_id in shot_ids:
            shot = next(item for item in shots if str(item.get("id")) == shot_id)
            shot_start, shot_end = windows[shot_id]
            next_shot = deepcopy(shot)
            next_shot.update({"start_frame": shot_start, "end_frame": shot_end, "features": {"core_emotion": bool(shot.get("performance")), "combat": False, "supernatural_vfx": False, "colossal": False},
                              "audio": shot.get("audio") if isinstance(shot.get("audio"), dict) else {"foley": []},
                              "performance": shot.get("performance") if isinstance(shot.get("performance"), dict) else {},
                              "characters": [], "identity_context": {}, "dialogues": [], "reference_requirements": reference_requirements[shot_id]})
            scene_subject = next((subject_by_id.get(str(usage.get("subjectId"))) for usage in rows(shot.get("subject_usages"))
                                  if subject_by_id.get(str(usage.get("subjectId")), {}).get("entityRef", {}).get("kind") == "scene"), None)
            scene_id = str((scene_subject or {}).get("entityRef", {}).get("id") or shot.get("scene_id") or "")
            if not scene_id or not any(str(item.get("id")) == scene_id for item in rows(source.get("scene_registry"))):
                raise ValueError("Shot " + shot_id + " requires a registered Scene Subject")
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
                speaker_entity = str((speaker or {}).get("entityRef", {}).get("id") or utterance.get("speakerSubjectId") or "NARRATOR")
                speaker_name = entity_text(source, speaker)[0] if speaker else "旁白"
                part = text[text_start:text_end]
                next_shot["dialogues"].append({"utterance_id": str(utterance["id"]), "_shot_id": shot_id, "source_text": text,
                                               "source_start": text_start, "source_end": text_end,
                                               "character_id": speaker_entity, "speaker_name": speaker_name, "speaker_id": "SUBJECT_" + str(utterance.get("speakerSubjectId") or speaker_entity),
                                               "text": part, "language": str(utterance.get("language") or ("Chinese" if any("\u4e00" <= char <= "\u9fff" for char in part) else "English")),
                                               "delivery": str(utterance.get("delivery") or "natural, intelligible delivery"),
                                               "voiceover": bool(utterance.get("voiceover")), "start": int(ref["localStartFrame"]), "end": int(ref["localEndFrame"])})
            next_shot["_canvas_v2_events"] = [event for event in rows((source.get("ledger") or {}).get("events")) if str(event.get("shot_id")) == shot_id]
            next_shot["state_description"] = _state_start_descriptions(source, continuity, shot, subjects)
            transformed_shots.append(next_shot)
        all_transformed_shots.extend(transformed_shots)

        first_shot = transformed_shots[0]
        summary = str(segment.get("summary") or source.get("story_summary") or source.get("brief") or "")
        if not summary:
            summary = "A continuous scene of " + str(len(shot_ids)) + " authored camera Shot(s)."
        if not summary.startswith("["):
            summary = "[reference generation] " + summary
        transformed_segments.append({**segment, "mode": mode, "mode_lock": mode, "mode_selection_reason": str(segment.get("mode_selection_reason") or ""),
                                     "shot_ids": shot_ids, "start_frame": start_frame, "end_frame": end_frame,
                                     "generation_clip_duration": duration, "style": str(segment.get("style") or ""),
                                     "summary": summary, "references": refs, "subjects": subject_entries,
                                     "overall_soundscape": str(segment.get("overall_soundscape") or "Synchronized dialogue, ambience and action sounds follow the authored shots."),
                                     "non_diegetic_music": str(segment.get("non_diegetic_music") or "N/A")})
        source_maps[segment_id] = _source_map_inputs(source, segment, shot_ids, windows, subject_uses)

    transformed_by_id = {str(item.get("id")): item for item in all_transformed_shots}
    source["shots"] = [transformed_by_id.get(str(item.get("id")), item) for item in shots]
    source["segments"] = transformed_segments
    source["version"] = "2.0"
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
    detail = "detailed_description:\n"
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
        excluded = {"id", "factId", "subjectId", "shotId", "timeline_id", "story_order", "start", "end"}
        return "; ".join(text for text in (_plain_text(item) for key, item in value.items() if key not in excluded) if text)
    return ""


def _time(frame, production):
    milliseconds = round(Fraction(int(frame) * int(production.get("fps_den", 1)) * 1000, int(production.get("fps_num", 24))))
    return f"{milliseconds // 60000:02d}:{milliseconds // 1000 % 60:02d}.{milliseconds % 1000:03d}"


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
    for key in ("angle", "lens", "movement", "path", "target", "focus"):
        value = _plain_text(camera.get(key))
        if value:
            parts.append(key.capitalize() + ": " + value + ".")
    visual = str(shot.get("visual") or "").strip()
    if visual:
        parts.append(visual)
    action = str(shot.get("action") or shot.get("action_description") or "").strip()
    if action and action != visual:
        parts.append("Action: " + action)
    performance = _plain_text(shot.get("performance"))
    if performance:
        parts.append("Performance: " + performance)
    audio = _plain_text(shot.get("audio"))
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


def _shot_prompt_v2(production, segment, shot, shot_number, speakers):
    camera = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
    fps_num, fps_den = int(production.get("fps_num", 24)), int(production.get("fps_den", 1))
    clip_start = int(segment["start_frame"])
    local_start = int(shot["start_frame"]) - clip_start
    local_end = int(shot["end_frame"]) - clip_start
    duration = float(Fraction((local_end - local_start) * fps_den, fps_num))
    parts = ["[Shot " + str(shot_number) + "] " + _time(local_start, production) + "–" + _time(local_end, production) + " within this Clip."]
    state = str(shot.get("state_description") or "").strip()
    if state:
        parts.append("At shot start, preserve these registered Subject states: " + state)
    framing = str(camera.get("framing") or "").strip()
    if framing:
        parts.append("Framing: " + framing + ".")
    attention = []
    subjects = {str(item.get("id")): item for item in rows(production.get("subject_registry"))}
    for subject_id in camera.get("attention_subject_ids", []):
        subject = subjects.get(str(subject_id))
        if subject:
            label = next((entry.get("label") for entry in segment.get("subjects", []) if entry.get("entity_id") == subject.get("entityRef", {}).get("id")), "")
            attention.append((str(label) + " (" + entity_text(production, subject)[0] + ")") if label else entity_text(production, subject)[0])
    if attention:
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
        presentation = str(usage.get("presentation") or "")
        if presentation == "visible":
            parts.append(label + " is visible in this Shot.")
        elif presentation == "offscreen_voice":
            parts.append(label + " is an offscreen voice and has no visible body in this Shot.")
        else:
            parts.append(label + " supplies continuity context only and is not visible in this Shot.")
    editorial_reason = str(camera.get("editorial_reason") or "").strip()
    if editorial_reason:
        parts.append("Editorial reason for this shot and cut: " + editorial_reason)
    for field in ("angle", "lens", "movement", "path", "target", "focus"):
        text = _plain_text(camera.get(field))
        if text:
            parts.append(field.capitalize() + ": " + text + ".")
    visual = str(shot.get("visual") or "").strip()
    if visual:
        parts.append(visual)
    action = str(shot.get("action") or shot.get("action_description") or "").strip()
    if action and action != visual:
        parts.append("Action: " + action)
    performance = _plain_text(shot.get("performance"))
    if performance:
        parts.append("Performance: " + performance)
    sound = _plain_text(shot.get("audio"))
    if sound:
        parts.append("Diegetic sound: " + sound)
    for event in shot.get("_canvas_v2_events", []):
        fact = next((item for item in rows((production.get("ledger") or {}).get("facts")) if str(item.get("id")) == str(event.get("fact_id"))), {})
        description = (fact.get("value_descriptions") or {}).get(str(event.get("after")), str(event.get("after") or ""))
        local_frame = int(event.get("local_frame", 0))
        parts.append("During " + _time(local_frame, production) + " of this Shot, the registered state changes: " + str(description) + ".")
    for picture in segment.get("references", []):
        if str(shot["id"]) not in [str(value) for value in picture.get("shot_ids", [])]:
            continue
        if picture.get("anchor_shot_ids") and str(shot["id"]) not in [str(value) for value in picture["anchor_shot_ids"]]:
            continue
        parts.append("Use " + str(picture["label"]) + " only for its declared " + str(picture.get("role") or "reference") + " attributes; preserve " + str(picture.get("preserve") or "the registered visual evidence") + ".")
        if picture.get("anchor"):
            parts.append(str(picture["anchor"]).capitalize() + " keyframe anchor: " + str(picture["label"]) + ".")
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
        line_text = "During " + start + "–" + end + " within this Shot, " + speaker_name + " (" + speaker_tag + ") " + verb + " with " + str(line.get("delivery") or "natural, intelligible delivery") + ": <d>[" + str(line.get("language") or "Chinese") + "] " + spoken + "</d>."
        if line.get("voiceover"):
            line_text += " The speaker remains offscreen; visible listeners stay silent."
        else:
            line_text += " Preserve the original words and synchronize only the visible speaker's mouth."
        if utterance_id:
            line_text += " The utterance continues seamlessly across the cut."
        parts.append(line_text)
    end_state = _render_state_end(production, production.get("_continuity_report") or {}, shot, subjects.values())
    if end_state:
        parts.append("At shot end, carry forward: " + end_state)
    return " ".join(part for part in parts if part)


def compile_prompt_v2(production, segment, *, draft=False):
    mode = str(segment["mode"])
    shot_ids = [str(value) for value in segment["shot_ids"]]
    references = rows(segment.get("references"))
    shots_by_id = {str(item["id"]): item for item in production["shots"]}
    shots = [shots_by_id[str(shot_id)] for shot_id in segment["shot_ids"]]
    anchor_roles = [str(item.get("anchor") or "") for shot in shots for item in rows(shot.get("keyframes")) if item.get("requiredForSubmission")]
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
    detail = "\n".join(_shot_prompt_v2(production, segment, shot, index + 1, speakers) for index, shot in enumerate(shots))
    soundscape = str(segment.get("overall_soundscape") or "Synchronized dialogue, ambience and action sounds follow the authored shots.")
    music = str(segment.get("non_diegetic_music") or "N/A")
    if mode == "Ref2VA":
        picture_definitions = [str(item.get("definition") or "") for item in references]
        definitions = "\n".join([*picture_definitions, *(str(subject.get("definition") or "") for subject in segment.get("subjects", []))])
        retention_lines = []
        for item in references:
            retention_lines.append(str(item.get("retention") or ""))
        retention_lines.extend(str(subject.get("retention") or "") for subject in segment.get("subjects", []))
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
    from h3_contract import speech_map
    from h3_final_format import finalize_h3_prompt, normalize_h3_prompt
    speech_expectations = []
    for shot in shots:
        for line in rows(shot.get("dialogues")):
            identity = str(line.get("character_id") or line.get("speaker_name") or "")
            speech_expectations.append((speakers.get(identity, "S1"), line.get("language", "Chinese"), line.get("text", "")))
    if draft:
        return normalize_h3_prompt(raw)
    return finalize_h3_prompt(raw, mode=mode, shot_count=len(shots),
                              reference_labels=[str(item["label"]) for item in references],
                              subject_labels=[str(item["label"]) for item in segment.get("subjects", [])],
                              speech_expectations=speech_expectations,
                              minimum_words=0)
