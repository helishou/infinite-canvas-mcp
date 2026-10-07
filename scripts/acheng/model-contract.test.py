"""Regression checks for missing identity bindings and ledger leakage."""
import copy
import json
import pathlib
import sys
import tempfile
import unittest

root = pathlib.Path(sys.argv.pop(1)).resolve()
sys.path.insert(0, str(root / "scripts"))
from canvas_model_contract import (subject_coverage_errors, check_source_and_text,
                                   render_continuity, internal_ids, validate_model_text, validation_input)
from canvas_source_contract import validate
from audit_storyboard_quality import compile_segment
from h3_final_format import file_contract, validate_h3_file


def production():
    # Real upstream media/shot contracts; a silent character identity replaces
    # the fixture's composition-only reference to exercise missing coverage.
    value = json.loads((root / "examples/01-mecha.production.json").read_text(encoding="utf-8"))
    value.pop("prompt_detail_policy", None)
    segment = value["segments"][0]
    segment.pop("prompt_detail_policy", None)
    ref = segment["references"][0]
    entity = value["shots"][0]["characters"][0]["id"]
    ref.update(role="identity", entity_id=entity, shot_ids=segment["shot_ids"])
    segment["subjects"] = []
    return value, segment, entity


def add_subject(segment, entity):
    segment["subjects"] = [{"label": "<Subject 1>", "entity_id": entity,
                            "definition": "<Subject 1> is the armored operator referenced from <Picture 1>.",
                            "retention": "<Subject 1> ([Shot 1], [Shot 2]): partially_preserved - retain the approved armor and silhouette.",
                            "shot_ids": list(segment["shot_ids"])}]


class ModelContractTests(unittest.TestCase):
    def test_registry_lookup_does_not_invent_missing_assets_or_add_media(self):
        from canvas_model_contract import continuity_input
        source = {'_canvas_compilation_scope': {}, '_canvas_continuity_asset_registry': [{'id': 'KNOWN_FOREIGN'}], 'asset_plan': [{'id': 'LOCAL', 'file': 'approved.png'}]}
        # A real scope marker is required; plain authored fields cannot enable it.
        source['_canvas_compilation_scope'] = {'scope': {'targetIds': ['SEG']}}
        before = copy.deepcopy(source)
        projected = continuity_input(source)
        self.assertEqual(projected['asset_plan'], [{'id': 'LOCAL', 'file': 'approved.png'}, {'id': 'KNOWN_FOREIGN'}])
        self.assertFalse(any(row['id'] == 'MISSING' for row in projected['asset_plan']))
        self.assertEqual(source, before)
    def test_scoped_validation_keeps_replay_context_without_output_gaps(self):
        value, segment, _ = production()
        before = copy.deepcopy(value)
        # The first Shot is context for replay, only the second is an output.
        segment['shot_ids'] = [value['shots'][1]['id']]
        segment['start_frame'] = value['shots'][1]['start_frame']
        value['_canvas_compilation_scope'] = {'scope': {'targetIds': [segment['id']]}}
        authored = copy.deepcopy(value)
        local = validation_input(value)
        self.assertEqual(value, authored)
        self.assertEqual(len(local['shots']), 1)
        self.assertEqual(local['segments'][0]['start_frame'], 0)
        self.assertEqual(local['shots'][0]['start_frame'], 0)
        self.assertEqual(local['shots'][0]['end_frame'], before['shots'][1]['end_frame'] - before['shots'][1]['start_frame'])
        # The full context ledger is preserved, rather than silently narrowed.
        self.assertEqual(local['ledger'], value['ledger'])
        value['shots'].reverse()
        reordered = validation_input(value)
        self.assertEqual(reordered['shots'][0]['id'], segment['shot_ids'][0])
        self.assertIs(validation_input(reordered), reordered)

    def test_scoped_replay_does_not_trust_a_source_report(self):
        value, _, _ = production()
        value['_canvas_compilation_scope'] = {'scope': {}}
        value['ledger'] = {'contract_version': 2, 'facts': [], 'timelines': [], 'initial': [], 'events': [], 'requirements': [], 'coverage': []}
        value['_canvas_validation_continuity'] = {'status': 'passed', 'final': {}, 'diagnostics': []}
        local = validation_input(value)
        self.assertEqual(local.continuity_report['status'], 'blocked')

    def test_fractional_frame_duration_is_exact_without_accepting_a_mismatch(self):
        from fractions import Fraction
        value, segment, _ = production()
        segment['shot_ids'] = [value['shots'][1]['id']]
        shot = value['shots'][1]
        shot['end_frame'] += 1
        frames = shot['end_frame'] - shot['start_frame']
        segment['generation_clip_duration'] = frames / value['fps_num']
        value['_canvas_compilation_scope'] = {'scope': {}}
        before = copy.deepcopy(value)
        local = validation_input(value)
        self.assertEqual(Fraction(local['segments'][0]['generation_clip_duration']), Fraction(frames, value['fps_num']))
        self.assertEqual(value, before)
        segment['generation_clip_duration'] += 0.1
        self.assertEqual(validation_input(value)['segments'][0]['generation_clip_duration'], segment['generation_clip_duration'])

    def test_missing_subject_blocks_source_binding_and_compiler(self):
        value, segment, _ = production()
        self.assertTrue(subject_coverage_errors(segment))
        self.assertTrue(any(item["code"] == "SUBJECT_COVERAGE_MISSING" for item in validate(value, "publish")))
        with self.assertRaisesRegex(ValueError, "SUBJECT_COVERAGE_MISSING"):
            compile_segment(value, segment)
        # Keep a recoverable draft, never grant it strict acceptance.
        self.assertIn("[Shot 1]", compile_segment(value, segment, draft=True))

    def test_subject_needs_matching_source_entity_and_each_shot(self):
        _, segment, entity = production()
        add_subject(segment, entity)
        self.assertFalse(subject_coverage_errors(segment))
        segment["subjects"][0]["shot_ids"] = [segment["shot_ids"][0]]
        self.assertTrue(subject_coverage_errors(segment))
        segment["subjects"][0]["shot_ids"] = segment["shot_ids"]
        segment["subjects"][0]["definition"] = "<Subject 1> is the operator from <Picture 9>."
        self.assertTrue(subject_coverage_errors(segment))
        segment["subjects"][0]["entity_id"] = "OTHER_OPERATOR"
        self.assertTrue(subject_coverage_errors(segment))

    def test_composition_anchor_does_not_require_subject(self):
        _, segment, _ = production()
        segment["references"][0]["role"] = "first-frame composition anchor"
        self.assertFalse(subject_coverage_errors(segment))

    def test_registered_ids_rejected_but_literals_preserved(self):
        value, segment, entity = production()
        add_subject(segment, entity)
        value["ledger"] = {"facts": [{"id": "fact-Abuse.X"}]}
        with self.assertRaisesRegex(ValueError, "INTERNAL_ID_IN_PROMPT"):
            check_source_and_text(value, segment, "Hold fact-Abuse.X at the end.")
        literal = '<d>[English] fact-Abuse.X is printed here.</d> The sign reads "fact-Abuse.X".'
        validate_model_text(literal, internal_ids(value))
        self.assertEqual(literal, '<d>[English] fact-Abuse.X is printed here.</d> The sign reads "fact-Abuse.X".')

    def test_replay_snapshot_is_not_a_prompt(self):
        shot = {"id": "SHOT_LOCAL"}
        value = {"ledger": {"contract_version": 2}, "_continuity_report": {
            "trajectories": {shot["id"]: {"end": {"F_ABUSE": "stopped", "F_EGGS": "fewer", "F_MANNER": "grievance"}}}}}
        self.assertEqual(render_continuity(shot, value), "")

    def test_local_cue_asserts_exact_state_and_keeps_complete_prose(self):
        shot = {"id": "SHOT_LOCAL", "continuity_cues": [{"fact_id": "F_HAND", "phase": "end", "value": "held",
                "description": "The woman keeps the egg basket in her right hand."}]}
        value = {"ledger": {"contract_version": 2, "facts": [{"id": "F_HAND", "allowed_values": ["held", "released"]}],
                            "requirements": [{"id": "REQ_HAND", "shot_id": shot["id"], "fact_id": "F_HAND"}]},
                 "_continuity_report": {"trajectories": {shot["id"]: {"end": {"F_HAND": "held"}}}}}
        before = copy.deepcopy(value)
        prose = render_continuity(shot, value)
        self.assertIn("The woman keeps", prose)
        self.assertNotIn("F_HAND", prose)
        self.assertEqual(value, before)
        shot["continuity_cues"][0]["value"] = "released"
        with self.assertRaisesRegex(ValueError, "CONTINUITY_CUE_STATE_MISMATCH"):
            render_continuity(shot, value)
        self.assertEqual(render_continuity(shot, value, strict=False), "")
        shot["continuity_cues"][0]["description"] = "F_HAND is released."
        with self.assertRaisesRegex(ValueError, "INTERNAL_ID_IN_PROMPT"):
            render_continuity(shot, value)

    def test_fixed_prompt_and_file_receipt_preserve_authored_content(self):
        value, segment, entity = production()
        add_subject(segment, entity)
        value["ledger"]["facts"] = [{"id": "fact-Abuse.X"}]
        before = copy.deepcopy(value)
        text = compile_segment(value, segment)
        self.assertEqual(value, before)
        self.assertIn("<Subject 1>", text.split("detailed_description:", 1)[1])
        for shot in value["shots"]:
            self.assertIn(shot["visual"], text)
            for line in shot["dialogues"]:
                self.assertIn(line["text"], text)
        refs = [{**ref, "file": str((root / "examples" / ref["file"]).resolve())} for ref in segment["references"]]
        import hashlib
        for ref in refs:
            ref["sha256"] = hashlib.sha256(pathlib.Path(ref["file"]).read_bytes()).hexdigest()
        contract = file_contract(value, segment, refs)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "prompt.h3.txt"
            path.write_text(text, encoding="utf-8")
            self.assertEqual(validate_h3_file(path, contract)["format_pass"], "PASSED")
            path.write_text(text.replace("\n\noverall_soundscape:", "\nAt the end, retain fact-Abuse.X.\n\noverall_soundscape:"), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "INTERNAL_ID_IN_PROMPT"):
                validate_h3_file(path, contract)


if __name__ == "__main__":
    unittest.main()
