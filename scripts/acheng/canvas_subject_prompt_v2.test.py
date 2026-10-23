import hashlib
import importlib.util
import os
import base64
import json
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from canvas_subject_prompt_v2 import adapt_production, binding_ids, build_source_map, compile_prompt_v2, entity_text, project_continuity_source, write_prompt_text, _state_start_descriptions, _render_state_end, _plain_text, _infer_segment_mode, _subject_retention_attributes, _h3_picture_submission_order, neutralize_spoken_repetition, repeated_spoken_dialogue

source_contract_spec = importlib.util.spec_from_file_location("canvas_source_contract", Path(__file__).with_name("source-contract.py"))
source_contract = importlib.util.module_from_spec(source_contract_spec)
source_contract_spec.loader.exec_module(source_contract)


class SubjectPromptV2ProjectionTest(unittest.TestCase):
    def test_retention_excludes_voice_only_shots_without_renumbering_visual_scope(self):
        from canvas_subject_prompt_v2 import _subject_retention_scope
        shots = [{"id": sid, "subject_usages": [{"subjectId": "P", "presentation": presentation}]}
                 for sid, presentation in [("A", "visible"), ("B", "offscreen_voice"), ("C", "visible")]]
        retention, visible = _subject_retention_scope("P", ["A", "B", "C"], shots, ["A", "C"])
        self.assertEqual(retention, "appears in [Shot 1], [Shot 3]")
        self.assertTrue(visible)

    def test_picture_ordinals_follow_h3_storyboard_subject_other_order(self):
        pictures = [
            {"number": 1, "is_keyframe": False, "subject_ids": ["SUB_A"]},
            {"number": 2, "is_keyframe": False, "subject_ids": []},  # composition reference between Shots
            {"number": 3, "is_keyframe": False, "subject_ids": ["SUB_B"]},
            {"number": 4, "is_keyframe": False, "subject_ids": ["SUB_SCENE"]},
            {"number": 5, "is_keyframe": True, "subject_ids": []},
        ]
        ordered = _h3_picture_submission_order(pictures)
        self.assertEqual([item["number"] for item in ordered], [5, 1, 3, 4, 2])

    def test_subject_retention_defaults_follow_entity_kind(self):
        retain, exclude = _subject_retention_attributes(
            "scene",
            ["character identity and costume as defined by the reference image"],
            ["pose, camera angle, background, and unrelated composition"],
        )
        self.assertEqual(retain, ["the established environment, architecture, spatial layout, and materials"])
        self.assertEqual(exclude, ["character identity, costume, and unrelated foreground subjects"])

    def test_state_context_scene_image_requires_and_respects_explicit_picture_binding(self):
        subject = {"id": "SUB_SCENE", "pictureBindings": [{"id": "SCENE_ENV", "provides": ["environment"], "defaultFor": ["environment"]}]}
        usage = {"subjectId": "SUB_SCENE", "presentation": "state_context", "referencePurpose": ["environment"], "pictureBindingIds": ["SCENE_ENV"]}
        self.assertEqual(binding_ids(subject, usage), ["SCENE_ENV"])
        self.assertEqual(binding_ids(subject, {**usage, "pictureBindingIds": []}), [])

    def test_entity_descriptions_deduplicate_identical_fields_but_keep_distinct_details(self):
        source = {"character_registry": [{"id": "CHAR_A", "name": "A", "prompt_description": "same appearance",
                                          "appearance": "same appearance", "description": "additional acting detail"}]}
        subject = {"entityRef": {"kind": "character", "id": "CHAR_A"}}
        name, description = entity_text(source, subject)
        self.assertEqual(name, "A")
        self.assertEqual(description, "same appearance additional acting detail")

    def test_missing_continuity_is_described_as_unregistered_not_verified_unchanged(self):
        source = {"ledger": {"facts": []}}
        shot = {"id": "SHOT_A", "subject_usages": [], "continuity_facts": []}
        self.assertEqual(_state_start_descriptions(source, {"trajectories": {}}, shot, []),
                         "No structured continuity facts are registered for this Shot's opening.")
        self.assertEqual(_render_state_end(source, {"trajectories": {}}, shot, []),
                         "No structured continuity state changes are registered for this Shot's ending.")

    def test_continuity_projection_uses_subject_entity_refs_without_mutating_source(self):
        source = {
            "prompt_assembly": {"version": 2},
            "character_registry": [{"id": "CHAR_A", "name": "A"}],
            "scene_registry": [{"id": "SCENE_A", "name": "Scene A"}],
            "asset_plan": [{"id": "PROP_A", "kind": "prop"}],
            "subject_registry": [
                {"id": "SUB_A", "entityRef": {"kind": "character", "id": "CHAR_A"}},
                {"id": "SUB_SCENE", "entityRef": {"kind": "scene", "id": "SCENE_A"}},
                {"id": "SUB_PROP", "entityRef": {"kind": "asset", "id": "PROP_A"}},
            ],
            "shots": [{"id": "SHOT_A", "duration_frames": 24, "timeline_id": "TL_A", "story_order": 0,
                       "subject_usages": [
                           {"subjectId": "SUB_A", "continuityFactIds": ["FACT_A"], "stateRequirements": []},
                           {"subjectId": "SUB_SCENE", "continuityFactIds": [], "stateRequirements": [{"factId": "FACT_SCENE"}]},
                           {"subjectId": "SUB_PROP", "continuityFactIds": [], "stateRequirements": []},
                       ]}],
            "segments": [{"id": "SEG_A", "shot_ids": ["SHOT_A"]}],
            "ledger": {"timelines": [{"id": "TL_A", "start_frame": 0}]},
        }
        snapshot = deepcopy(source)
        projected = project_continuity_source(source)
        self.assertEqual(source, snapshot)
        shot = projected["shots"][0]
        self.assertEqual([item["id"] for item in shot["characters"]], ["CHAR_A"])
        self.assertEqual(shot["scene_id"], "SCENE_A")
        self.assertEqual(shot["required_assets"], ["PROP_A"])
        self.assertEqual(shot["continuity_facts"], ["FACT_A", "FACT_SCENE"])

    def test_source_map_hashes_match_archived_prompt_bytes_on_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = "detailed_description:\r\nA registered visual action.\r\n\r\noverall_soundscape:\r\nIndustrial rain.\r\n"
            path = Path(directory) / "clip.h3.txt"
            normalized = write_prompt_text(path, prompt)
            source_map = build_source_map(normalized, {"segmentId": "CLIP_1", "sourceHash": "a" * 64, "entries": []})
            prompt_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(path.read_bytes(), normalized.encode("utf-8"))
            self.assertEqual(source_map["promptHash"], prompt_hash)
            artifact = {"kind": "h3", "status": "ready", "targetId": "CLIP_1", "prompt": path.read_text(encoding="utf-8"),
                        "sha256": prompt_hash, "sourceHash": source_map["sourceHash"], "receipt": {"sourceMap": source_map}}
            contract_path = Path(__file__).with_name("source-contract.py")
            spec = importlib.util.spec_from_file_location("source_contract_newlines", contract_path)
            contract = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(contract)
            self.assertFalse(contract.validate_prompt_source_maps([artifact]))

    def test_mixed_compilation_scope_accepts_registered_asset_outputs(self):
        source = {
            "prompt_assembly": {"version": 2},
            "_canvas_compilation_scope": {"targetIds": ["ASSET_STYLE", "KF_SHOT_06", "UNKNOWN"]},
            "asset_plan": [{"id": "ASSET_STYLE"}, {"id": "KF_SHOT_06"}],
            "asset_cards": [{"id": "ASSET_STYLE"}],
            "shots": [], "segments": [], "subject_registry": [], "utterances": [],
            "ledger": {"contract_version": 2, "facts": [], "timelines": [], "initial": [], "events": [], "requirements": [], "coverage": []},
        }
        issues = source_contract.validate_subject_prompt_v2(source, "compile")
        selected_target_issues = [item for item in issues if "Selected compilation target" in item["message"]]
        self.assertEqual([item["targetId"] for item in selected_target_issues], ["UNKNOWN"])

    def test_scene_compile_checks_output_shots_but_ignores_continuity_context_shots(self):
        source = {
            "prompt_assembly": {"version": 2},
            "_canvas_compilation_scope": {"targetIds": [], "outputShotIds": ["OUTPUT"]},
            "shots": [{"id": "CONTEXT"}, {"id": "OUTPUT"}],
            "segments": [{"id": "CLIP_OUTPUT", "shot_ids": ["OUTPUT"]}],
            "subject_registry": [], "utterances": [],
            "ledger": {"contract_version": 2, "facts": [], "timelines": [], "initial": [], "events": [], "requirements": [], "coverage": []},
        }
        issues = source_contract.validate_subject_prompt_v2(source, "compile")
        unassigned = [item["targetId"] for item in issues if item["message"] == "Shot is not assigned to a Clip"]
        self.assertEqual(unassigned, [])

        source["shots"].append({"id": "OUTPUT_UNASSIGNED"})
        source["_canvas_compilation_scope"]["outputShotIds"].append("OUTPUT_UNASSIGNED")
        issues = source_contract.validate_subject_prompt_v2(source, "compile")
        unassigned = [item["targetId"] for item in issues if item["message"] == "Shot is not assigned to a Clip"]
        self.assertEqual(unassigned, ["OUTPUT_UNASSIGNED"])

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
                "character_registry": [{"id": "CHILD", "name": "Child", "prompt_description": "A small child in a blue cotton shirt.",
                                        "appearance": "A small child in a blue cotton shirt.", "description": "A small child in a blue cotton shirt."}],
                "scene_registry": [{"id": "COOP", "name": "Chicken coop", "prompt_description": "A mud-brick coop with a straw nest behind a small opening.",
                                    "description": "A mud-brick coop with a straw nest behind a small opening."}],
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
            self.assertIn("Scene setting: Chicken coop: A mud-brick coop with a straw nest behind a small opening.", prompt)
            # Picture-bound character definitions stay label-based without appearance disclaimers.
            char_entry = next(item for item in segment["subjects"] if item.get("entity_id") == "CHILD")
            self.assertEqual(char_entry["definition"], "<Subject 1> is Child; identity: <Picture 1>.")
            self.assertEqual(char_entry["retention"], "<Subject 1> (appears in [Shot 1]): partially_preserved - <Picture 1>.")
            self.assertNotIn("blue cotton shirt", char_entry["definition"])
            scene_entry = next(item for item in segment["subjects"] if item.get("entity_id") != "CHILD")
            self.assertIn("A mud-brick coop with a straw nest", scene_entry["definition"])
            self.assertIn("continuity context for [Shot 1]; not visible", scene_entry["retention"])
            self.assertIn("weak_reference", scene_entry["retention"])
            self.assertNotIn("character identity and costume", scene_entry["retention"])
            self.assertIn("<Subject 2> (continuity context for [Shot 1]; not visible): weak_reference", prompt)
            source_map = build_source_map(prompt, projected["_canvas_subject_v2_source_maps"]["CLIP_1"])
            self.assertEqual(source_map["sourceHash"], "a" * 64)
            self.assertTrue(any(item["sourceId"] == "SHOT_1" and item["field"] == "visual" for item in source_map["entries"]))
            self.assertTrue(any(item["sourceId"] == "U1" and item["field"] == "text" for item in source_map["entries"]))

            unreferenced_scene_source = deepcopy(source)
            unreferenced_scene_source["shots"][0]["subject_usages"] = [
                usage for usage in unreferenced_scene_source["shots"][0]["subject_usages"]
                if usage["subjectId"] != "SCENE"
            ]
            unreferenced_scene = adapt_production(unreferenced_scene_source)
            unreferenced_prompt = compile_prompt_v2(unreferenced_scene, unreferenced_scene["segments"][0])
            self.assertNotIn("Scene setting:", unreferenced_prompt)
            self.assertNotIn("mud-brick coop", unreferenced_prompt)

            per_shot_source = deepcopy(source)
            second_shot = deepcopy(per_shot_source["shots"][0])
            second_shot.update({"id": "SHOT_2", "story_order": 1, "visual": "The child turns away from the coop."})
            second_shot["subject_usages"] = [usage for usage in second_shot["subject_usages"] if usage["subjectId"] != "SCENE"]
            second_shot["keyframes"] = []
            second_shot["utterance_refs"] = []
            per_shot_source["shots"].append(second_shot)
            per_shot_source["segments"][0]["shot_ids"].append("SHOT_2")
            per_shot = adapt_production(per_shot_source)
            per_shot_prompt = compile_prompt_v2(per_shot, per_shot["segments"][0])
            per_shot_details = per_shot_prompt.split("detailed_description:\n", 1)[1]
            second_shot_prompt = per_shot_details.split("[Shot 2] At", 1)[1]
            self.assertIn("Scene setting:", per_shot_details.split("[Shot 2] At", 1)[0])
            self.assertNotIn("Scene setting:", second_shot_prompt)

            # Missing lock prose is not an approval gate. A valid mode is inferred
            # from authored visible Subject references and frozen image inputs.
            inferred_source = deepcopy(source)
            for field in ("mode", "mode_lock", "mode_selection_reason"):
                inferred_source["segments"][0].pop(field, None)
            inferred_diagnostics = source_contract.validate(inferred_source, "compile")
            self.assertFalse([item for item in inferred_diagnostics if item["severity"] == "error"], inferred_diagnostics)
            inferred = adapt_production(inferred_source)["segments"][0]
            self.assertEqual(inferred["mode"], "Ref2VA")
            self.assertEqual(inferred["mode_lock"], "Ref2VA")
            self.assertTrue(inferred["mode_selection_reason"])

            text_source = deepcopy(inferred_source)
            for usage in text_source["shots"][0]["subject_usages"]:
                usage["presentation"] = "state_context"
                usage["pictureBindingIds"] = []
            text_projected = adapt_production(text_source, draft=True)["segments"][0]
            self.assertEqual(text_projected["mode"], "T2VA")

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

            # A missing visible identity image keeps the source editable and its text
            # prompt compilable as a draft. The same input remains blocked for media use.
            draft_source = deepcopy(source)
            draft_source["subject_registry"][0]["pictureBindings"] = []
            draft_source["shots"][0]["subject_usages"][0]["pictureBindingIds"] = []
            draft_source["shots"][0]["subject_usages"][1]["pictureBindingIds"] = []
            draft_source["_canvas_subject_picture_sources"] = {}
            compile_diagnostics = contract.validate(draft_source, "compile")
            self.assertFalse([item for item in compile_diagnostics if item["severity"] == "error"], compile_diagnostics)
            missing_binding = [item for item in compile_diagnostics if "Missing or ambiguous default binding" in item["message"]]
            self.assertTrue(missing_binding)
            self.assertEqual(missing_binding[0]["severity"], "warning")
            generate_diagnostics = contract.validate(draft_source, "generate")
            self.assertTrue(any(item["severity"] == "error" and "Missing or ambiguous default binding" in item["message"] for item in generate_diagnostics))
            projected_draft = adapt_production(draft_source, draft=True)
            draft_segment = projected_draft["segments"][0]
            self.assertEqual(draft_segment["references"], [])
            draft_prompt = compile_prompt_v2(projected_draft, draft_segment, draft=True)
            self.assertIn("The child stays outside", draft_prompt)

            runtime = os.environ.get("ACHENG_TEST_RUNTIME")
            if runtime:
                import subprocess
                python = os.environ.get("ACHENG_PYTHON") or sys.executable
                runtime_scripts = Path(runtime) / "scripts"
                env = os.environ.copy()
                env["PYTHONPATH"] = str(runtime_scripts) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
                compile_script = "from compile_h3 import compile_package; import json,sys; print(json.dumps(compile_package(sys.argv[1], sys.argv[2], draft=True)))"

                def compile_runtime(candidate, output_path):
                    input_path = Path(directory) / (output_path.name + ".json")
                    input_path.write_text(json.dumps(candidate, ensure_ascii=False), encoding="utf-8")
                    result = subprocess.run([python, "-B", "-X", "utf8", "-c", compile_script, str(input_path), str(output_path)],
                                            cwd=runtime, env=env, check=True, capture_output=True, text=True, encoding="utf-8")
                    return json.loads(result.stdout)

                output_path = Path(directory) / "compiled"
                index = compile_runtime(source, output_path)
                self.assertEqual(len(index), 1)
                self.assertEqual(index[0]["format_pass"], "PASSED", index[0].get("blockers"))
                self.assertEqual(index[0]["source_map"]["segmentId"], "CLIP_1")
                self.assertTrue(index[0]["source_map"]["entries"])
                compiled_text = (output_path / index[0]["file"]).read_text(encoding="utf-8")
                self.assertEqual(compiled_text.count("A small child in a blue cotton shirt."), 1)
                self.assertEqual(compiled_text.count("A mud-brick coop with a straw nest behind a small opening."), 1)
                draft_output = Path(directory) / "compiled-missing-image"
                draft_index = compile_runtime(draft_source, draft_output)
                self.assertEqual(len(draft_index), 1)
                self.assertEqual(draft_index[0]["format_pass"], "NOT_ACCEPTED")
                self.assertTrue(any("reference mode has no media bindings" in item for item in draft_index[0].get("blockers", [])))
                draft_prompt_file = draft_index[0].get("prompt_file") or draft_index[0].get("file")
                self.assertTrue(draft_prompt_file)
                self.assertTrue((draft_output / draft_prompt_file).is_file())


class SubjectAudioBindingTest(unittest.TestCase):
    def test_keyframes_default_to_required_unless_explicitly_optional(self):
        source = {"shots": [{"id": "S1", "keyframes": [{"id": "KF1"}]}], "subject_registry": []}
        segment = {"id": "C1", "shot_ids": ["S1"]}

        self.assertEqual(_infer_segment_mode(source, segment), "Ref2VA")

        source["shots"][0]["keyframes"][0]["requiredForSubmission"] = False
        self.assertEqual(_infer_segment_mode(source, segment), "T2VA")

    def test_performance_projection_omits_internal_beat_ids(self):
        self.assertEqual(_plain_text({"beat_id": "SH-18-01-B01", "dominant_track": "gaze"}), "gaze")

    def test_audio_binding_shot_ids_are_preserved_as_string_rows(self):
        source = {
            "prompt_assembly": {"version": 2}, "project_id": "EP", "fps_num": 24, "fps_den": 1,
            "scene_registry": [{"id": "SCENE", "name": "Scene"}],
            "subject_registry": [{"id": "SUB_SCENE", "kind": "scene",
                                  "entityRef": {"ownerKind": "episode", "ownerId": "EP", "kind": "scene", "id": "SCENE"},
                                  "pictureBindings": []}],
            "shots": [{"id": "SHOT_1", "scene_id": "SCENE", "timeline_id": "main", "story_order": 0,
                       "duration_frames": 120, "subject_usages": [], "keyframes": [], "utterance_refs": []}],
            "segments": [{"id": "CLIP_1", "mode": "Ref2VA", "shot_ids": ["SHOT_1"],
                          "audio_bindings": [{"id": "AUDIO_1", "label": "<Audio 1>", "shotIds": ["SHOT_1"],
                                              "sha256": "a" * 64}]}],
            "ledger": {"contract_version": 2, "facts": [], "timelines": [{"id": "main", "start_frame": 0}],
                       "initial": [], "events": [], "requirements": [], "coverage": []},
            "_canvas_subject_audio_sources": {"AUDIO_1": {"file": "audio.mp3", "sha256": "a" * 64}},
        }

        projected = adapt_production(source, draft=True)

        self.assertEqual(projected["segments"][0]["references"][0]["shot_ids"], ["SHOT_1"])
        prompt = compile_prompt_v2(projected, projected["segments"][0], draft=True)
        self.assertIn("<Audio 1>: reference - preserve its audible reference only.", prompt)


class ContinuityProjectionTest(unittest.TestCase):
    def test_subject_audit_projection_does_not_expand_every_character_fact_into_each_shot(self):
        from canvas_subject_prompt_v2 import _subject_continuity_audit_projection
        source = {
            "prompt_assembly": {"version": 2},
            "subject_registry": [{"id": "SUB_A", "entityRef": {"kind": "character", "id": "CHAR_A"}}],
            "scene_registry": [{"id": "SCENE_A"}],
            "script_scenes": [{"id": "SCENE_OCC_A", "scene_id": "SCENE_A", "blocks": [{"id": "B1", "kind": "action", "text": "Scene evidence."}]}],
            "shots": [{"id": "S1", "timeline_id": "T", "story_order": 0, "duration_frames": 24,
                       "scene_id": "SCENE_A", "subject_usages": [
                           {"subjectId": "SUB_A", "continuityFactIds": ["F_WEAPON", "F_INJURY"],
                            "stateRequirements": [{"factId": "F_WEAPON", "value": "held"}]}
                       ]}],
            "segments": [{"id": "C1", "shot_ids": ["S1"]}],
            "ledger": {"contract_version": 2, "timelines": [{"id": "T", "start_frame": 0}],
                       "facts": [{"id": "F_WEAPON", "object_kind": "character", "object_id": "CHAR_A"},
                                 {"id": "F_INJURY", "object_kind": "character", "object_id": "CHAR_A"},
                                 {"id": "F_SCENE", "object_kind": "scene", "object_id": "SCENE_A"}],
                       "initial": [], "events": [],
                       "requirements": [
                           {"id": "R_WEAPON", "timeline_id": "T", "shot_id": "S1", "fact_id": "F_WEAPON", "kind": "unresolved"},
                           {"id": "R_INJURY", "timeline_id": "T", "shot_id": "S1", "fact_id": "F_INJURY", "kind": "unresolved"},
                           {"id": "R_SCENE", "timeline_id": "T", "shot_id": "S1", "fact_id": "F_SCENE", "kind": "unresolved"}],
                       "coverage": []},
        }
        projected = _subject_continuity_audit_projection(source)
        shot = projected["shots"][0]
        self.assertEqual(shot["characters"], [])
        self.assertEqual(shot["required_assets"], [])
        self.assertEqual(shot["scene_id"], "")
        self.assertEqual(shot["source_scene_id"], "SCENE_OCC_A")
        self.assertEqual(shot["continuity_facts"], ["F_WEAPON"])
        self.assertEqual([row["id"] for row in projected["ledger"]["requirements"]], ["R_WEAPON"])
        self.assertEqual(source["shots"][0]["scene_id"], "SCENE_A")
        self.assertEqual(len(source["ledger"]["requirements"]), 3)

    def test_first_unknown_event_is_not_misreported_as_an_opening_baseline(self):
        from canvas_subject_prompt_v2 import _subject_continuity_audit_projection
        source = {
            "prompt_assembly": {"version": 2},
            "shots": [{"id": "S1", "timeline_id": "T", "story_order": 0, "duration_frames": 24,
                       "continuity_facts": ["F_STATE"], "subject_usages": []}],
            "segments": [{"id": "C1", "shot_ids": ["S1"]}],
            "script_scenes": [{"id": "SC1", "blocks": [{"id": "B1", "kind": "action", "text": "A state is first seen."}]}],
            "ledger": {
                "contract_version": 2,
                "timelines": [{"id": "T", "start_frame": 0}],
                "facts": [{"id": "F_STATE", "object_kind": "scene", "object_id": "UNUSED_SCENE", "allowed_values": ["observed"]}],
                "initial": [{"timeline_id": "T", "fact_id": "F_STATE", "value": "unknown"}],
                "events": [{"id": "E1", "timeline_id": "T", "fact_id": "F_STATE", "shot_id": "S1", "frame": 0,
                            "local_frame": 0, "before": "unknown", "after": "observed"}],
                "requirements": [{"id": "R1", "timeline_id": "T", "shot_id": "S1", "fact_id": "F_STATE",
                                  "kind": "change", "event_ids": ["E1"]}],
                "coverage": [],
            },
        }
        projected = _subject_continuity_audit_projection(source)
        self.assertEqual(projected["shots"][0]["continuity_facts"], [])
        self.assertEqual(projected["ledger"]["events"][0]["before"], "unknown")
        self.assertEqual(projected["ledger"]["requirements"][0]["id"], "R1")
        self.assertEqual(source["shots"][0]["continuity_facts"], ["F_STATE"])

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


class SpokenDialogueRepetitionTest(unittest.TestCase):
    """A Shot may name its line in prose, but the spoken words live only in <d>."""

    line = "道长……妖……生来就该死吗？……"

    def _compile(self, visual, delivery="faint and trembling", dialogue=None, speaker_name=None):
        dialogue = dialogue or self.line
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "picture.png"
            image_bytes = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=")
            image.write_bytes(image_bytes)
            digest = hashlib.sha256(image_bytes).hexdigest()
            source = {
                "prompt_assembly": {"version": 2},
                "_canvas_subject_source_hash": "a" * 64,
                "_canvas_subject_picture_sources": {
                    "HARE_IMG": {"assetId": "HARE_ASSET", "subjectId": "SUB_HARE", "kind": "subject", "role": "identity",
                                 "file": str(image), "sha256": digest, "storageKey": "image:hare", "nodeId": "HARE_NODE",
                                 "retain": ["face"], "exclude": ["pose"], "defaultFor": ["identity"]},
                    "ROAD_IMG": {"assetId": "ROAD_ASSET", "subjectId": "SUB_ROAD", "kind": "subject", "role": "scene",
                                 "file": str(image), "sha256": digest, "storageKey": "image:road", "nodeId": "ROAD_NODE",
                                 "retain": ["road"], "exclude": ["people"], "defaultFor": ["identity"]},
                },
                "fps_num": 24, "fps_den": 1, "brief": "A dying beast asks why it must die.",
                "character_registry": [{"id": "HARE", "name": "白貉", "prompt_description": "A white hare spirit.",
                                        "appearance": "A white hare spirit.", "description": "A white hare spirit."}],
                "scene_registry": [{"id": "ROAD", "name": "Mountain road", "prompt_description": "A rain-soaked mountain road.",
                                    "description": "A rain-soaked mountain road."}],
                "subject_registry": [
                    {"id": "SUB_HARE", "kind": "character", "entityRef": {"kind": "character", "id": "HARE", "ownerKind": "episode", "ownerId": "EP"},
                     "pictureBindings": [{"id": "HARE_IMG", "assetId": "HARE_ASSET", "provides": ["identity"], "retain": ["face"], "exclude": ["pose"], "defaultFor": ["identity"]}]},
                    {"id": "SUB_ROAD", "kind": "scene", "entityRef": {"kind": "scene", "id": "ROAD", "ownerKind": "episode", "ownerId": "EP"},
                     "pictureBindings": [{"id": "ROAD_IMG", "assetId": "ROAD_ASSET", "provides": ["scene"], "retain": ["road"], "exclude": ["people"], "defaultFor": ["identity"]}]},
                ],
                "asset_plan": [], "asset_cards": [],
                "shots": [{
                    "id": "SHOT_1", "timeline_id": "main", "story_order": 0, "duration_frames": 96,
                    "visual": visual,
                    "camera": {"framing": "BSCU", "attention_subject_ids": ["SUB_HARE"], "editorial_reason": "Read the dying question."},
                    "subject_usages": [
                        {"subjectId": "SUB_HARE", "presentation": "visible", "pictureBindingIds": [], "referencePurpose": ["identity"], "continuityFactIds": [], "stateRequirements": []},
                        {"subjectId": "SUB_ROAD", "presentation": "state_context", "pictureBindingIds": ["ROAD_IMG"], "referencePurpose": ["identity"], "continuityFactIds": [], "stateRequirements": []},
                    ],
                    "keyframes": [], "utterance_refs": [{"utteranceId": "U1", "role": "speaker", "localStartFrame": 20, "localEndFrame": 60, "textStart": 0, "textEnd": 20}],
                }],
                "segments": [{"id": "CLIP_1", "shot_ids": ["SHOT_1"], "mode": "Ref2VA", "mode_lock": "Ref2VA",
                              "mode_selection_reason": "Use the registered identity and road references."}],
                "utterances": [{"id": "U1", **({"speakerSubjectId": "SUB_HARE"} if speaker_name is None else {"speakerName": speaker_name}), "text": dialogue, "language": "Chinese",
                                "delivery": delivery, "voiceover": False,
                                "start": {"shotId": "SHOT_1", "localFrame": 20}, "end": {"shotId": "SHOT_1", "localFrame": 60}}],
                "ledger": {"contract_version": 2, "facts": [], "timelines": [{"id": "main", "start_frame": 0}],
                           "initial": [], "events": [], "requirements": [], "coverage": []},
            }
            projected = adapt_production(source)
            return compile_prompt_v2(projected, projected["segments"][0])

    def test_quoted_line_in_prose_is_replaced_so_the_payload_appears_once(self):
        prompt = self._compile("白貉瞳孔涣散，临终泣言如利刃般在脑海深处炸响：“" + self.line + "”小小头颅垂下，跌向泥泞。")
        self.assertEqual(prompt.count(self.line), 1)
        self.assertIn("<d>[Chinese] " + self.line + "</d>", prompt)
        self.assertIn("该句台词，小小头颅垂下", prompt)

    def test_temporary_speaker_name_reaches_compiled_dialogue(self):
        prompt = self._compile("窗外传来一声喝止。", speaker_name="窗外的守卫", dialogue="站住！")
        self.assertIn("窗外的守卫", prompt)
        self.assertIn("<d>[Chinese] 站住！</d>", prompt)

    def test_named_line_drops_the_payload_and_keeps_short_clause_directions(self):
        prompt = self._compile("她带着细弱断续的呼吸说出已确认台词：“" + self.line + "”说到“妖”时她试图看清对方，问到“吗”时眉间松开。")
        self.assertEqual(prompt.count(self.line), 1)
        self.assertIn("说出已确认台词，说到“妖”时她试图看清对方，问到“吗”时眉间松开", prompt)
        self.assertNotIn("该句台词", prompt)

    def test_unquoted_copy_is_replaced_too(self):
        text = neutralize_spoken_repetition("她临死前问：" + self.line + "然后头颅垂下。", [self.line])
        self.assertEqual(text.count(self.line), 0)
        self.assertIn("该句台词", text)
        demonstrative = neutralize_spoken_repetition("那句“" + self.line + "”在他胸腔中疯狂翻涌。", [self.line])
        self.assertIn("那句台词在他胸腔中疯狂翻涌。", demonstrative)

    def test_delivery_cues_cannot_repeat_words_reserved_for_the_dialogue_tag(self):
        spoken = "血煞缠身……灵台却如白纸。"
        delivery = "沈砚男声画外音，清冷低沉、压低声线；“血煞缠身”后停半拍，再低声说“灵台却如白纸”，克制而带疑惑。"
        prompt = self._compile("红绡重伤濒死，目光涣散。", delivery, spoken)
        self.assertEqual(prompt.count(spoken), 1)
        self.assertEqual(prompt.count("血煞缠身"), 1)
        self.assertEqual(prompt.count("灵台却如白纸"), 1)
        self.assertIn("后停半拍", prompt)
        self.assertIn("克制而带疑惑", prompt)

    def test_gate_reports_quoted_and_verbatim_copies_but_not_short_fragments(self):
        expectations = [("S1", "Chinese", self.line)]
        clean = "[Shot 1] She asks: <d>[Chinese] " + self.line + "</d>."
        self.assertEqual(repeated_spoken_dialogue(clean, expectations), [])
        short = "[Shot 1] 说到“妖”时她抬头。 <d>[Chinese] " + self.line + "</d>."
        self.assertEqual(repeated_spoken_dialogue(short, expectations), [])
        self.assertEqual(len(repeated_spoken_dialogue("[Shot 1] 她问出“" + self.line + "”。 <d>[Chinese] " + self.line + "</d>.", expectations)), 1)
        self.assertEqual(len(repeated_spoken_dialogue("[Shot 1] " + self.line + " <d>[Chinese] " + self.line + "</d>.", expectations)), 1)

    def test_compile_refuses_a_repeated_line_when_the_rewrite_is_bypassed(self):
        from unittest.mock import patch
        with patch("canvas_subject_prompt_v2.neutralize_spoken_repetition", side_effect=lambda text, spoken: text):
            with self.assertRaises(ValueError) as error:
                self._compile("白貉临终泣言：“" + self.line + "”")
        self.assertIn("台词重复", str(error.exception))


if __name__ == "__main__":
    unittest.main()
