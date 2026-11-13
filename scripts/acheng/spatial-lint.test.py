"""位置写法体检的回归：只钉住确定性规则，不引入语义推断。"""
import importlib.util
import pathlib
import sys
import unittest

root = pathlib.Path(sys.argv.pop(1)).resolve()
_spec = importlib.util.spec_from_file_location(
    "spatial_lint", root / "scripts" / "acheng" / "spatial-lint.py")
assert _spec and _spec.loader, "找不到 scripts/acheng/spatial-lint.py"
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
spatial_lint = _module.spatial_lint


def production(shots, segments, ledger=None, scenes=None):
    value = {"shots": shots, "segments": segments, "ledger": ledger or {}}
    if scenes is not None:
        value["scene_registry"] = scenes
    return value


SHRINE = [{
    "id": "S01", "name": "家庙",
    "space": "正殿，供桌居中，左后方立神龛",
    "prompt_description": "院落南侧是朱漆庙门，门内正对大供桌，供桌左后方立神龛。",
    "landmarks": ["供桌", "神龛", "庙门"],
}]


def shot(shot_id, visual, cast=True, state=None):
    value = {"id": shot_id, "visual": visual}
    if cast:
        usage = {"subjectId": "SUB_A"}
        if state:
            usage["stateRequirements"] = state
        value["subject_usages"] = [usage]
    return value


def hold(shot_id, value, fact_id="FACT-STAND", kind="hold"):
    return {"kind": kind, "shot_id": shot_id, "fact_id": fact_id, "value": value}


class SpatialLintTest(unittest.TestCase):
    def codes(self, result):
        return [item["code"] for item in result["diagnostics"]]

    # —— 账本基线：位置靠账本，不靠正文 ——

    def test_first_shot_without_any_ledger_state_is_reported(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，站在供桌右侧地面。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"facts": [], "requirements": []}))
        self.assertIn("MISSING_SHOT_STATE_BASELINE", self.codes(result))

    def test_hold_requirement_satisfies_baseline(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，拿起茶盏。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "供桌右侧地面")]}))
        self.assertEqual(result["diagnostics"], [])

    def test_state_requirements_satisfy_baseline(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，拿起茶盏。",
                  state=[{"factId": "FACT-STAND", "value": "供桌右侧地面"}])],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}]))
        self.assertEqual(result["diagnostics"], [])

    def test_continuity_fact_ids_alone_satisfy_baseline(self):
        # 渲染取的是轨迹值 + value_descriptions；勾了 fact 就已经有事实进提示词
        shot_value = {"id": "SH1", "visual": "慕璃在画面左侧，拿起茶盏。",
                      "subject_usages": [{"subjectId": "SUB_A", "continuityFactIds": ["FACT-STAND"]}]}
        result = spatial_lint(production([shot_value], [{"id": "CLIP_A", "shot_ids": ["SH1"]}]))
        self.assertEqual(result["diagnostics"], [])

    def test_change_requirement_also_counts_as_baseline(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，跨到门边。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "门槛内侧", kind="change")]}))
        self.assertEqual(result["diagnostics"], [])

    # —— 模糊方位：查账本值，不查正文 ——

    def test_vague_ledger_value_is_reported(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "供桌旁")]}))
        self.assertIn("VAGUE_STATE_VALUE", self.codes(result))

    def test_landmark_partition_in_ledger_is_accepted(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "供桌右侧地面")]}))
        self.assertEqual(result["diagnostics"], [])

    def test_vague_state_requirements_value_is_reported(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，拿起茶盏。",
                  state=[{"factId": "FACT-STAND", "value": "村长一侧"}])],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}]))
        self.assertIn("VAGUE_STATE_VALUE", self.codes(result))

    def test_bare_side_word_in_ledger_is_not_vague(self):
        # 「一旁」不是模糊定位，不误伤
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "茶盏放在一旁")]}))
        self.assertEqual(result["diagnostics"], [])

    def test_vague_prose_is_no_longer_flagged(self):
        # 新分工：正文不承担方位，所以正文里的「供桌旁」不再告警（账本才是权威）
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，走到供桌旁。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "供桌右侧地面")]}))
        self.assertEqual(result["diagnostics"], [])

    # —— 屏幕位置：只认结构化字段 ——

    def test_structured_position_satisfies_check(self):
        value = {"id": "SH1", "visual": "慕璃拿起茶盏。",
                 "characters": [{"id": "CHAR_A", "position": [0.35, 0.55]},
                                {"id": "CHAR_B", "position": [0.7, 0.55]}]}
        result = spatial_lint(production(([value]), [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
                                         {"facts": [], "requirements": []}))
        self.assertNotIn("NO_STRUCTURED_SCREEN_POSITION", self.codes(result))

    def test_missing_structured_position_is_reported(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，站在供桌右侧地面。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"facts": [], "requirements": []}))
        self.assertIn("NO_STRUCTURED_SCREEN_POSITION", self.codes(result))

    def test_prose_left_right_no_longer_counts(self):
        # 正文写「在画面左侧」不算：屏幕位置是结构化字段，正文描写不产生锚点
        result = spatial_lint(production(
            [shot("SH1", "Lu sits on the left and Cen sits on the right of frame.")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"facts": [], "requirements": []}))
        self.assertIn("NO_STRUCTURED_SCREEN_POSITION", self.codes(result))

    def test_invalid_position_values_are_not_accepted(self):
        value = {"id": "SH1", "visual": "慕璃拿起茶盏。",
                 "characters": [{"id": "CHAR_A", "position": [35, 55]}]}  # 不是 0–1
        result = spatial_lint(production([value], [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
                                         {"facts": [], "requirements": []}))
        self.assertIn("NO_STRUCTURED_SCREEN_POSITION", self.codes(result))

    def test_ledger_state_alone_also_satisfies(self):
        # v2 稿没有 characters[].position 时，账本状态事实也能承担屏幕位置
        result = spatial_lint(production(
            [shot("SH1", "慕璃拿起茶盏。", state=[{"factId": "FACT-STAND", "value": "供桌右侧地面"}])],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}]))
        self.assertNotIn("NO_STRUCTURED_SCREEN_POSITION", self.codes(result))

    def test_empty_shot_is_not_flagged_for_position(self):
        result = spatial_lint(production(
            [shot("SH1", "空供位与残绳铜钱。", cast=False)],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"facts": [], "requirements": []}))
        self.assertNotIn("NO_STRUCTURED_SCREEN_POSITION", self.codes(result))

    def test_dialogue_text_is_ignored(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，站在供桌右侧地面，说：<d>旁边有人吗</d>")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            {"requirements": [hold("SH1", "供桌右侧地面")], "facts": []}))
        self.assertEqual(result["diagnostics"], [])

    def test_only_segment_first_shot_is_checked(self):
        result = spatial_lint(production(
            [shot("SH1", "慕璃拿起茶盏。"),
             shot("SH2", "她放下茶盏。"),
             shot("SH3", "镜头推近烛台。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1", "SH2", "SH3"]}],
            {"requirements": [hold("SH1", "供桌右侧地面")], "facts": []}))
        self.assertEqual(result["diagnostics"], [])
        self.assertEqual(result["checked"], 1)

    def test_director_source_shape_is_read(self):
        source = {"director": {"source": {
            "shots": [{"id": "SH1", "visual": "慕璃在画面左侧。"}],
            "segments": [{"id": "CLIP_A", "shot_ids": ["SH1"]}],
            "ledger": {"facts": [], "requirements": [hold("SH1", "供桌旁")]}}}}
        result = spatial_lint(source)
        self.assertEqual(result["checked"], 1)
        self.assertIn("VAGUE_STATE_VALUE", self.codes(result))

    def test_legacy_dialect_skips_ledger_baseline(self):
        # 官方样例是老式 initial{}/events 账本，没有 facts：不能报"没接状态"
        led = {"initial": {"characters": {"CHAR_A": {"ammo": 0}}}, "events": [], "final": {}}
        result = spatial_lint(production(
            [shot("SH1", "慕璃在画面左侧，站在供桌右侧地面。")],
            [{"id": "CLIP_A", "shot_ids": ["SH1"]}], led))
        self.assertEqual(result["dialect"], "legacy")
        self.assertNotIn("MISSING_SHOT_STATE_BASELINE", self.codes(result))

    def test_segment_with_unknown_shot_is_skipped(self):
        result = spatial_lint(production([], [{"id": "CLIP_A", "shot_ids": ["SH9"]}]))
        self.assertEqual(result["checked"], 0)
        self.assertEqual(result["diagnostics"], [])


if __name__ == "__main__":
    unittest.main()
