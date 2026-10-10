import hashlib
import importlib.util
import os
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

from canvas_subject_prompt_v2 import adapt_production, build_source_map, compile_prompt_v2


class SubjectPromptV2ProjectionTest(unittest.TestCase):
    def test_clip_compiles_subjects_shots_and_source_map_without_mutating_source(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "picture.png"
            image_bytes = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=")
            image.write_bytes(image_bytes)
            digest = hashlib.sha256(image_bytes).hexdigest()
            source = {
                "prompt_assembly": {"version": 2},
                "_canvas_subject_source_hash": "a" * 64,
                "_canvas_subject_picture_sources": {
                    "CHAR_IMG": {"assetId": "CHAR_ASSET", "subjectId": "CHAR", "kind": "subject", "role": "identity",
                                 "file": str(image), "sha256": digest, "storageKey": "image:char", "nodeId": "CHAR_NODE",
                                 "retain": ["face and hair"], "exclude": ["pose and background"], "defaultFor": ["identity"]},
                    "SCENE_IMG": {"assetId": "SCENE_ASSET", "subjectId": "SCENE", "kind": "subject", "role": "scene",
                                  "file": str(image), "sha256": digest, "storageKey": "image:scene", "nodeId": "SCENE_NODE",
                                  "retain": ["coop layout"], "exclude": ["people and original blocking"], "defaultFor": ["identity"]},
                },
                "fps_num": 24, "fps_den": 1, "brief": "A child investigates a real egg.",
                "character_registry": [{"id": "CHILD", "name": "Child", "prompt_description": "A small child in a blue cotton shirt."}],
                "scene_registry": [{"id": "COOP", "name": "Chicken coop", "prompt_description": "A mud-brick coop with a straw nest behind a small opening."}],
                "subject_registry": [
                    {"id": "CHAR", "kind": "character", "entityRef": {"kind": "character", "id": "CHILD", "ownerKind": "episode", "ownerId": "EP"}, "pictureBindings": [
                        {"id": "CHAR_IMG", "assetId": "CHAR_ASSET", "provides": ["identity"], "retain": ["face and hair"], "exclude": ["pose and background"], "defaultFor": ["identity"]}]},
                    {"id": "SCENE", "kind": "scene", "entityRef": {"kind": "scene", "id": "COOP", "ownerKind": "episode", "ownerId": "EP"}, "pictureBindings": [
                        {"id": "SCENE_IMG", "assetId": "SCENE_ASSET", "provides": ["scene"], "retain": ["coop layout"], "exclude": ["people and original blocking"], "defaultFor": ["identity"]}]},
                ],
                "asset_plan": [], "asset_cards": [], "shots": [
                    {"id": "SHOT_1", "timeline_id": "main", "story_order": 0, "duration_frames": 96,
                     "visual": "The child stays outside the coop window and watches the hen in the nest.",
                     "camera": {"framing": "MCU", "attention_subject_ids": ["CHAR"], "editorial_reason": "Read the child's cautious reaction."},
                     "subject_usages": [
                         {"subjectId": "CHAR", "presentation": "visible", "pictureBindingIds": [], "referencePurpose": ["identity"], "continuityFactIds": [], "stateRequirements": []},
                         {"subjectId": "SCENE", "presentation": "state_context", "pictureBindingIds": ["SCENE_IMG"], "referencePurpose": ["identity"], "continuityFactIds": [], "stateRequirements": []},
                     ],
                     "keyframes": [], "utterance_refs": [{"utteranceId": "U1", "role": "speaker", "localStartFrame": 20, "localEndFrame": 60, "textStart": 0, "textEnd": 20}]},
                ],
                "segments": [{"id": "CLIP_1", "shot_ids": ["SHOT_1"], "mode": "Ref2VA", "mode_lock": "Ref2VA", "mode_selection_reason": "Use the registered identity and coop references."}],
                "utterances": [{"id": "U1", "speakerSubjectId": "CHAR", "text": "Look at the real egg", "language": "English", "delivery": "quietly", "voiceover": False,
                                "start": {"shotId": "SHOT_1", "localFrame": 20}, "end": {"shotId": "SHOT_1", "localFrame": 60}}],
                "ledger": {"contract_version": 2, "facts": [], "timelines": [{"id": "main", "start_frame": 0}], "initial": [], "events": [], "requirements": [], "coverage": []},
            }
            authored_snapshot = repr(source)
            projected = adapt_production(source)
            self.assertEqual(repr(source), authored_snapshot)
            segment = projected["segments"][0]
            self.assertEqual(segment["generation_clip_duration"], 4.0)
            self.assertEqual([item["label"] for item in segment["references"]], ["<Picture 1>"])
            self.assertEqual(len(segment["subjects"]), 2)
            prompt = compile_prompt_v2(projected, segment)
            self.assertLess(prompt.index("subject_definitions:"), prompt.index("summary:"))
            self.assertIn("[Shot 1]", prompt)
            source_map = build_source_map(prompt, projected["_canvas_subject_v2_source_maps"]["CLIP_1"])
            self.assertEqual(source_map["sourceHash"], "a" * 64)
            self.assertTrue(any(item["sourceId"] == "SHOT_1" and item["field"] == "visual" for item in source_map["entries"]))
            self.assertTrue(any(item["sourceId"] == "U1" and item["field"] == "text" for item in source_map["entries"]))

            contract_path = Path(__file__).with_name("source-contract.py")
            spec = importlib.util.spec_from_file_location("subject_prompt_source_contract", contract_path)
            contract = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(contract)
            self.assertEqual(contract.contract()["promptAssemblyVersions"], [2])
            self.assertFalse([item for item in contract.validate(source, "edit") if item["severity"] == "error"])
            artifact = {"kind": "h3", "status": "ready", "targetId": "CLIP_1", "prompt": prompt,
                        "sha256": source_map["promptHash"], "sourceHash": source_map["sourceHash"],
                        "receipt": {"sourceMap": source_map}}
            self.assertFalse(contract.validate_prompt_source_maps([artifact]))
            artifact["prompt"] += " changed"
            self.assertTrue(contract.validate_prompt_source_maps([artifact]))

            runtime = os.environ.get("ACHENG_TEST_RUNTIME")
            if runtime:
                sys.path.insert(0, str(Path(runtime) / "scripts"))
                from compile_h3 import compile_package
                input_path = Path(directory) / "director.json"
                output_path = Path(directory) / "compiled"
                input_path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
                index = compile_package(input_path, output_path, draft=True)
                self.assertEqual(len(index), 1)
                self.assertEqual(index[0]["format_pass"], "PASSED", index[0].get("blockers"))
                self.assertEqual(index[0]["source_map"]["segmentId"], "CLIP_1")
                self.assertTrue(index[0]["source_map"]["entries"])


class ContinuityProjectionTest(unittest.TestCase):
    def test_local_events_and_flat_screenplay_are_projected_without_rewriting_source(self):
        from copy import deepcopy
        from canvas_subject_prompt_v2 import project_continuity_source, audit_subject_continuity
        scene = {"id": "SC1", "scene_id": "ENV", "text": "铆钉护甲受损，仍守在门前。"}
        source = {"prompt_assembly": {"version": 2}, "shots": [
            {"id": "S1", "timeline_id": "T", "story_order": 0, "duration_frames": 48},
            {"id": "S2", "timeline_id": "T", "story_order": 1, "duration_frames": 72}],
            "segments": [{"id": "C", "shot_ids": ["S1", "S2"]}], "script_scenes": [scene],
            "ledger": {"contract_version": 2, "timelines": [{"id": "T", "start_frame": 100}], "facts": [], "initial": [], "requirements": [], "coverage": [],
                "events": [{"id": "E1", "shot_id": "S2", "local_frame": 0}, {"id": "E2", "shot_id": "S2", "local_frame": 1}]}}
        before = deepcopy(source)
        projected = project_continuity_source(source)
        self.assertEqual([(s["start_frame"], s["end_frame"]) for s in projected["shots"]], [(100, 148), (148, 220)])
        self.assertEqual([e["frame"] for e in projected["ledger"]["events"]], [148, 149])
        self.assertEqual(projected["script_scenes"][0]["blocks"][0], scene)
        self.assertEqual(source, before)
        self.assertEqual(project_continuity_source(projected), projected)
        from continuity_v2 import digest
        self.assertEqual(audit_subject_continuity(source)["sourceDigest"], digest(source))


if __name__ == "__main__":
    unittest.main()
