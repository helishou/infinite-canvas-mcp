"""Model-facing source checks. No inferred identities or rewritten creative prose."""
import re


CONTENT_ROLES = {"identity", "character", "character identity", "scene", "environment", "prop"}


def rows(value):
    return value if isinstance(value, list) else []


def identity_requirements(segment):
    """Frame/composition anchors remain Pictures; reusable content needs Subjects."""
    if segment.get("mode") != "Ref2VA":
        return []
    result = []
    for ref in rows(segment.get("references")):
        role = str(ref.get("role", "")).lower().replace("_", " ").strip()
        if role not in CONTENT_ROLES and "identity" not in role.split():
            continue
        entities = ref.get("entity_ids") or [ref.get("entity_id")]
        for entity in entities:
            result.append({"entity_id": entity, "label": ref.get("label"),
                           "shot_ids": ref.get("shot_ids") or segment.get("shot_ids", [])})
    return result


def subject_coverage_errors(segment):
    errors = []
    subjects = rows(segment.get("subjects"))
    for required in identity_requirements(segment):
        entity, label = required["entity_id"], required["label"]
        if not entity:
            errors.append(f"SUBJECT_ENTITY_REQUIRED: {label} needs a declared entity_id")
            continue
        for shot_id in required["shot_ids"]:
            matches = [subject for subject in subjects if subject.get("entity_id") == entity
                       and shot_id in rows(subject.get("shot_ids"))
                       and label in re.findall(r"<(?:Picture|Video) [1-9]\d*>", str(subject.get("definition", "")))]
            if len(matches) != 1:
                errors.append(f"SUBJECT_COVERAGE_MISSING: {entity} from {label} in {shot_id} needs exactly one matching Subject")
    return errors


def internal_ids(production):
    identifiers = set()
    public_names = set((production.get("prompt_bindings") or {}).values())
    for field in ("character_registry", "scene_registry", "asset_plan", "asset_cards", "shots", "segments"):
        for item in rows(production.get(field)):
            identifier = item.get("id") or item.get("asset_id")
            if isinstance(identifier, str) and identifier != item.get("name") and identifier not in public_names:
                identifiers.add(identifier)
    for field in ("facts", "events", "requirements", "coverage"):
        for item in rows((production.get("ledger") or {}).get(field)):
            if isinstance(item.get("id"), str):
                identifiers.add(item["id"])
    return sorted(identifier for identifier in identifiers if len(identifier) >= 3)


def instruction_text(text):
    # Dialogue and quoted visible text are user-authored literals, not identifiers.
    text = re.sub(r"<d>.*?</d>", "", text, flags=re.S)
    return re.sub(r'"[^"\n]*"|“[^”\n]*”', "", text)


def validate_model_text(text, identifiers):
    prose = instruction_text(text)
    for identifier in identifiers:
        if re.search(r"(?<![\w])" + re.escape(identifier) + r"(?![\w])", prose):
            raise ValueError("INTERNAL_ID_IN_PROMPT: " + identifier)


def continuity_errors(production, shot):
    """A cue asserts an authored state; it never makes a new ledger fact."""
    if "continuity_cues" not in shot:
        return []
    cues = shot["continuity_cues"]
    if not isinstance(cues, list):
        return ["CONTINUITY_CUE_INVALID: continuity_cues must be an array"]
    ledger = production.get("ledger") or {}
    facts = {fact.get("id"): fact for fact in rows(ledger.get("facts"))}
    requirements = {req.get("fact_id") for req in rows(ledger.get("requirements")) if req.get("shot_id") == shot.get("id")}
    errors, seen = [], set()
    for cue in cues:
        if not isinstance(cue, dict):
            errors.append("CONTINUITY_CUE_INVALID: cue must be an object")
            continue
        fact_id, phase = cue.get("fact_id"), cue.get("phase")
        if not isinstance(fact_id, str) or not isinstance(phase, str):
            errors.append("CONTINUITY_CUE_INVALID: fact_id and phase must be strings")
            continue
        key = (fact_id, phase)
        if key in seen:
            errors.append("CONTINUITY_CUE_DUPLICATE: " + str(fact_id))
        seen.add(key)
        fact = facts.get(fact_id)
        if ledger.get("contract_version") != 2 or not fact or fact_id not in requirements:
            errors.append("CONTINUITY_CUE_UNBOUND: " + str(fact_id))
        if phase not in {"start", "end"}:
            errors.append("CONTINUITY_CUE_PHASE: " + str(fact_id))
        if not fact or cue.get("value") not in rows(fact.get("allowed_values")):
            errors.append("CONTINUITY_CUE_VALUE: " + str(fact_id))
        description = cue.get("description")
        if not isinstance(description, str) or len(description.strip()) < 3 or description.strip().lower() in {"tbd", "todo", "unknown", "n/a"}:
            errors.append("CONTINUITY_CUE_DESCRIPTION: complete model-facing prose required for " + str(fact_id))
        else:
            try:
                validate_model_text(description, internal_ids(production))
            except ValueError as error:
                errors.append(str(error))
    return errors


def render_continuity(shot, production, *, strict=True):
    """Render explicit local cues, never the full replay snapshot or ledger IDs."""
    errors = continuity_errors(production, shot)
    if errors:
        if strict:
            raise ValueError("; ".join(errors))
        return ""
    cues = rows(shot.get("continuity_cues"))
    trajectory = (production.get("_continuity_report") or {}).get("trajectories", {}).get(str(shot.get("id")), {})
    chunks = []
    for cue in cues:
        if trajectory.get(cue["phase"], {}).get(cue["fact_id"]) != cue["value"]:
            if strict:
                raise ValueError("CONTINUITY_CUE_STATE_MISMATCH: " + cue["fact_id"])
            continue
        prefix = "At the start of this shot: " if cue["phase"] == "start" else "At the end of this shot: "
        chunks.append(prefix + cue["description"].strip())
    return " ".join(chunks)


def source_diagnostics(production):
    result = []
    for index, segment in enumerate(rows(production.get("segments"))):
        for message in subject_coverage_errors(segment):
            result.append({"code": message.split(":", 1)[0], "message": message,
                           "path": f"director.source.segments.{index}.subjects", "targetId": segment.get("id")})
    for index, shot in enumerate(rows(production.get("shots"))):
        for message in continuity_errors(production, shot):
            result.append({"code": message.split(":", 1)[0], "message": message,
                           "path": f"director.source.shots.{index}.continuity_cues", "targetId": shot.get("id")})
    if (production.get("ledger") or {}).get("contract_version") == 2 and any(shot.get("continuity_cues") for shot in rows(production.get("shots"))):
        from continuity_v2 import audit
        report = audit(production)
        for index, shot in enumerate(rows(production.get("shots"))):
            if continuity_errors(production, shot):
                continue
            try:
                render_continuity(shot, {**production, "_continuity_report": report})
            except ValueError as error:
                result.append({"code": "CONTINUITY_CUE_STATE_MISMATCH", "message": str(error),
                               "path": f"director.source.shots.{index}.continuity_cues", "targetId": shot.get("id")})
    return result


def check_source_and_text(production, segment, text=None):
    from storyboard_policy import check, render
    check(production, set(segment.get("shot_ids", [])))
    errors = subject_coverage_errors(segment)
    selected = set(segment.get("shot_ids", []))
    for shot in rows(production.get("shots")):
        if shot.get("id") in selected:
            errors.extend(continuity_errors(production, shot))
    if errors:
        raise ValueError("; ".join(errors))
    if text is not None:
        for shot in rows(production.get("shots")):
            if shot.get("id") in selected:
                framing = render(shot, production)
                if framing and framing not in text:
                    raise ValueError("STORYBOARD_COMPILED_COVERAGE: framing, attention or editorial purpose missing for " + shot["id"])
        validate_model_text(text, internal_ids(production))


class ValidatedModelInput(dict):
    """Validator-only copy; attributes cannot be forged by JSON source fields."""


def continuity_input(source):
    """Restore only authentic registry IDs captured by Backend's scope projection."""
    if not source.get("_canvas_compilation_scope") or not source.get("_canvas_continuity_asset_registry"):
        return source
    registry = rows(source.get("_canvas_continuity_asset_registry"))
    known = {item.get("id") for item in rows(source.get("asset_plan"))}
    return {**source, "asset_plan": rows(source.get("asset_plan")) +
            [{"id": item["id"]} for item in registry if isinstance(item, dict) and item.get("id") not in known]}


def validation_input(production):
    """Validate selected model requests; replay still uses the full authored context.

    Backend scopes retain preceding Shots for ledger replay. Those context Shots
    are not output requests and must not create timeline gaps or asset demands.
    This copy is used only by validators, never written into production source.
    """
    if not production.get("_canvas_compilation_scope") or isinstance(production, ValidatedModelInput):
        return production
    import copy
    result = ValidatedModelInput(copy.deepcopy(production))
    if (production.get("ledger") or {}).get("contract_version") == 2:
        from continuity_v2 import audit
        report = audit(production)
        result.continuity_report = report
        result["_continuity_report"] = report
    ordered_ids = [sid for segment in rows(result.get("segments")) for sid in segment.get("shot_ids", [])]
    by_id = {shot.get("id"): shot for shot in rows(result.get("shots"))}
    shots = [by_id[sid] for sid in ordered_ids if sid in by_id]
    if not shots:
        return result
    shifts, cursor = {}, 0
    for shot in shots:
        start, end = shot["start_frame"], shot["end_frame"]
        shifts[shot["id"]] = cursor - start
        shot["start_frame"], shot["end_frame"] = cursor, cursor + end - start
        cursor = shot["end_frame"]
    by_id = {shot["id"]: shot for shot in shots}
    for segment in rows(result.get("segments")):
        covered = [by_id[sid] for sid in segment["shot_ids"] if sid in by_id]
        if not covered:
            continue
        shift = shifts[covered[0]["id"]]
        for reference in rows(segment.get("references")) + rows(segment.get("subjects")):
            for field in ("start_frame", "end_frame"):
                if isinstance(reference.get(field), int):
                    reference[field] += shift
        segment["start_frame"], segment["end_frame"] = covered[0]["start_frame"], covered[-1]["end_frame"]
        # Backend stores fractional frame durations as JSON doubles. Normalize
        # only an exactly matching double in this validator copy; authored
        # mismatches remain failures, without a tolerance or timeline change.
        from fractions import Fraction
        frame_duration = Fraction((segment["end_frame"] - segment["start_frame"]) * result["fps_den"], result["fps_num"])
        authored_duration = segment.get("generation_clip_duration")
        if isinstance(authored_duration, float) and authored_duration == float(frame_duration):
            segment["generation_clip_duration"] = str(frame_duration)
    result["shots"] = shots
    result["production_total_duration"] = f"{cursor * result['fps_den']}/{result['fps_num']}"
    return result


def apply(root):
    """Install into a new candidate only; fail on unreviewed upstream changes."""
    from pathlib import Path
    root = Path(root)
    (root / "scripts/canvas_model_contract.py").write_bytes(Path(__file__).read_bytes())
    (root / "scripts/canvas_prompt_diagnostics.py").write_bytes(Path(__file__).with_name("prompt-diagnostics.py").read_bytes())

    def replace(relative, before, after):
        path = root / relative
        text = path.read_text(encoding="utf-8")
        if text.count(before) != 1:
            raise RuntimeError("Unsupported model contract overlay: " + relative)
        path.write_text(text.replace(before, after), encoding="utf-8")

    path = root / "scripts/audit_storyboard_quality.py"
    text = path.read_text(encoding="utf-8")
    start = text.index('    if production.get("ledger", {}).get("contract_version") == 2:', text.index("def continuity_text("))
    end = text.index("    bindings = production.get('prompt_bindings', {})", start)
    text = text[:start] + '    if production.get("ledger", {}).get("contract_version") == 2:\n        from canvas_model_contract import render_continuity\n        return render_continuity(shot, production, strict=not draft)\n' + text[end:]
    text = text.replace("def continuity_text(shot, production):", "def continuity_text(shot, production, *, draft=False):", 1)
    path.write_text(text, encoding="utf-8")
    replace("scripts/audit_storyboard_quality.py", 'def compile_segment(p, seg, *, draft=False):\n',
            'def compile_segment(p, seg, *, draft=False):\n    from canvas_model_contract import check_source_and_text\n    if not draft:\n        check_source_and_text(p, seg)\n')
    # Both strict and historical branches have a raw expansion; only new production
    # receives the new contract. The historical function is intentionally unchanged.
    path = root / "scripts/audit_storyboard_quality.py"
    text = path.read_text(encoding="utf-8")
    start, end = text.index("def compile_segment("), text.index("def _canvas_legacy_compile_segment(")
    section = text[start:end]
    marker = '    speech_expectations = []\n'
    if section.count(marker) != 1:
        raise RuntimeError("Unsupported raw prompt compilation")
    section = section.replace(marker, '    if not draft:\n        check_source_and_text(p, seg, raw)\n' + marker)
    section = section.replace("continuity_text(s, p)", "continuity_text(s, p, draft=draft)")
    path.write_text(text[:start] + section + text[end:], encoding="utf-8")
    replace("scripts/h3_contract.py", 'def check_h3_semantics(p, seg, text):\n',
            'def check_h3_semantics(p, seg, text):\n    from canvas_model_contract import check_source_and_text\n    check_source_and_text(p, seg, text)\n')
    replace("scripts/audit_storyboard_quality.py", 'def audit(p, base_dir=ROOT, *, h3_segment_ids=None):\n',
            'def audit(p, base_dir=ROOT, *, h3_segment_ids=None):\n    from canvas_model_contract import validation_input\n    p = validation_input(p)\n')
    path = root / "scripts/audit_storyboard_quality.py"
    text = path.read_text(encoding="utf-8")
    # The concise overlay retains the historical compiler/replay definitions.
    if text.count('def replay(p):\n') != 2:
        raise RuntimeError("Unsupported scoped replay overlay")
    text = text.replace('def replay(p):\n', 'def replay(p):\n    from canvas_model_contract import ValidatedModelInput\n    if isinstance(p, ValidatedModelInput) and getattr(p, "continuity_report", None):\n        report = p.continuity_report\n        require(report["status"] == "passed", str(report["diagnostics"]))\n        return report["final"]\n')
    path.write_text(text, encoding="utf-8")
    replace("scripts/post_hooks.py", 'def check_assets(payload, base, allow_missing=False):\n',
            'def check_assets(payload, base, allow_missing=False):\n    from canvas_model_contract import validation_input\n    payload = validation_input(payload)\n')
    replace("scripts/continuity_v2.py", 'def audit(source, target_ids=None):\n',
            'def audit(source, target_ids=None):\n    from canvas_model_contract import continuity_input\n    source = continuity_input(source)\n')
    replace("scripts/reference_bindings.py", '    issues, labels, rows = [], [], []',
            '    issues, labels, rows = [], [], []\n    from canvas_model_contract import subject_coverage_errors\n    issues.extend(subject_coverage_errors(segment))')
    replace("scripts/h3_final_format.py", '        _check_reference_structure(text, reference_labels, subject_labels, shot_count)',
            '        _check_reference_structure(text, reference_labels, subject_labels, shot_count)\n        for label in subject_labels:\n            _need(label in body, "defined Subject never used in detailed_description: " + label)')
    replace("scripts/h3_final_format.py", '    for field, expected in contract.get("reference_sections", {}).items():',
            '    from canvas_model_contract import validate_model_text, subject_coverage_errors\n    validate_model_text(text, contract.get("internal_ids", []))\n    coverage = subject_coverage_errors({"mode": mode, "references": refs, "subjects": contract.get("model_subjects", [])})\n    _need(not coverage, "; ".join(coverage))\n    for field, expected in contract.get("reference_sections", {}).items():')
    replace("scripts/h3_final_format.py", '    if segment["mode"] == "Ref2VA":\n        from h3_contract import remap_speech_references',
            '    from canvas_model_contract import check_source_and_text, internal_ids\n    check_source_and_text(production, segment)\n    result["internal_ids"] = internal_ids(production)\n    result["model_subjects"] = [{key: subject.get(key) for key in ("label", "entity_id", "definition", "shot_ids")} for subject in segment.get("subjects", [])]\n    if segment["mode"] == "Ref2VA":\n        from h3_contract import remap_speech_references')
    replace("scripts/h3_final_format.py", '    _need(not re.search(r"\\b(?:CHAR|SCENE|PROP)_[A-Za-z0-9_]+\\b", text),',
            '    from canvas_model_contract import instruction_text\n    _need(not re.search(r"\\b(?:CHAR|SCENE|PROP)_[A-Za-z0-9_]+\\b", instruction_text(text)),')

    # Preserve upstream gate behavior, while retaining per-target source provenance.
    path = root / "scripts/audit_storyboard_quality.py"
    text = path.read_text(encoding="utf-8")
    text = text.replace("def audit(p, base_dir=ROOT, *, h3_segment_ids=None):", "def _canvas_audit_impl(p, base_dir=ROOT, *, h3_segment_ids=None):", 1)
    wrapper = '''
def audit(p, base_dir=ROOT, *, h3_segment_ids=None):
    report = _canvas_audit_impl(p, base_dir, h3_segment_ids=h3_segment_ids)
    from canvas_prompt_diagnostics import external_context_diagnostics
    diagnostics = external_context_diagnostics(p, h3_segment_ids)
    if diagnostics:
        report["diagnostics"] = diagnostics
        report["status"] = "FAIL"
        for item in report.get("gates", []):
            if item["gate"] == "h3_schema":
                item["status"] = "FAIL"
                item["score"] = 0
                item["errors"] = [error for error in item["errors"] if not error.startswith("external-context dependency:")] + [diagnostic["message"] for diagnostic in diagnostics]
    return report

'''
    marker = "def main():"
    if text.count(marker) != 1:
        raise RuntimeError("Unsupported audit diagnostics overlay")
    path.write_text(text.replace(marker, wrapper + marker), encoding="utf-8")
