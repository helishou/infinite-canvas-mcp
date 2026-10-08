"""Locate standalone-prompt violations in consumed source, without rewriting it."""
import re


def external_context_diagnostics(production, segment_ids=None):
    from audit_storyboard_quality import compile_segment
    from prompt_delivery import EXTERNAL, expand_prompt, prose_only
    from canvas_model_contract import validation_input

    production = validation_input(production)
    result = []
    bindings = production.get("prompt_bindings", {})

    def leaves(value, path, shot_id=None):
        if isinstance(value, str):
            yield path, value, shot_id
        elif isinstance(value, dict):
            for key, child in value.items():
                # Literal speech and editorial metadata are not prompt instructions.
                if key in {"text", "notes", "note", "display_summary", "id", "shot_ids", "entity_id", "file", "name"}:
                    continue
                yield from leaves(child, path + "." + key, shot_id)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                yield from leaves(child, path + "." + str(index), shot_id)

    def binding_origins(value, matched, seen=None):
        seen = set() if seen is None else seen
        origins = []
        for key in re.findall(r"\{\{([A-Za-z0-9_.-]+)\}\}", value):
            if key in seen or key not in bindings:
                continue
            seen.add(key)
            raw = bindings[key]
            if any(match.group().lower() == matched.lower() for match in EXTERNAL.finditer(prose_only(raw))):
                origins.append("director.source.prompt_bindings." + key)
            origins.extend(binding_origins(raw, matched, seen))
        return origins

    for segment in production.get("segments", []):
        if segment_ids is not None and segment["id"] not in segment_ids:
            continue
        try:
            text = compile_segment(production, segment, draft=True)
        except (ValueError, KeyError, TypeError, IndexError):
            # Preserve the original compiler's diagnostics for malformed inputs.
            continue
        prose = prose_only(text)
        matches = list(EXTERNAL.finditer(prose))
        if not matches:
            continue
        candidates = []
        fields = {key: segment.get(key) for key in ("style", "summary", "references", "subjects", "overall_soundscape", "non_diegetic_music", "motion_profile", "animation_term_evidence", "panels")}
        candidates.extend(leaves(fields, "director.source.segments." + segment["id"]))
        selected = [shot for shot in production.get("shots", []) if shot["id"] in segment.get("shot_ids", [])]
        for shot in selected:
            candidates.extend(leaves(shot, "director.source.shots." + shot["id"], shot["id"]))
        character_ids = {ch["id"] for shot in selected for ch in shot.get("characters", [])}
        scene_ids = {shot["scene_id"] for shot in selected}
        for section, ids in (("character_registry", character_ids), ("scene_registry", scene_ids)):
            for entry in production.get(section, []):
                if entry["id"] in ids:
                    candidates.append(("director.source." + section + "." + entry["id"] + ".prompt_description", entry.get("prompt_description", ""), None))
        located = set()
        covered = set()
        for path, value, shot_id in candidates:
            try:
                expanded = expand_prompt(value, bindings) if value.strip() else ""
            except ValueError:
                continue
            consumed = prose_only(expanded).strip()
            if not consumed or consumed not in prose:
                continue
            for occurrence in re.finditer(re.escape(consumed), prose):
                covered.update(index for index, match in enumerate(matches) if occurrence.start() <= match.start() and match.end() <= occurrence.end())
            for match in EXTERNAL.finditer(consumed):
                # A binding's value is the editable origin of its expanded text.
                paths = binding_origins(value, match.group())
                for origin_path in paths or [path]:
                    key = (segment["id"], origin_path, match.group().lower())
                    if key in located:
                        continue
                    located.add(key)
                    result.append(_diagnostic(segment["id"], origin_path, match.group(), shot_id, "source"))
        for index, match in enumerate(matches):
            if index not in covered:
                result.append(_diagnostic(segment["id"], "compiler.h3_prompt", match.group(), None, "compiler"))
    return result


def _diagnostic(target, path, matched, shot, origin):
    return {"code": "PROMPT_EXTERNAL_CONTEXT", "path": path, "targetId": target,
            **({"shotId": shot} if shot else {}), "origin": origin, "matchedText": matched,
            "blocksCompilation": True, "severity": "error",
            "message": "Prompt depends on external prose: " + matched,
            "nextAction": {"action": "correct_source" if origin == "source" else "configure",
                           "message": "Expand the instruction into explicit local visual conditions at " + path if origin == "source" else "Repair compiler-generated prose; do not rewrite the authored source."}}
