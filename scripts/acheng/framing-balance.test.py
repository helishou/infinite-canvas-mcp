"""景别分布体检的回归：告警必须可复现，且不误报健康分布。"""
import importlib.util
import pathlib
import sys
import unittest

root = pathlib.Path(sys.argv.pop(1)).resolve()
# 本目录的 overlay 工具按约定用连字符命名（不可 import），按文件路径加载。
_spec = importlib.util.spec_from_file_location(
    "framing_balance", root / "scripts" / "acheng" / "framing-balance.py")
assert _spec and _spec.loader, "找不到 scripts/acheng/framing-balance.py"
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
framing_balance = _module.framing_balance


def production(framings, segments=None):
    shots = [{"id": f"SH{i}", "camera": {"framing": value}} for i, value in enumerate(framings, 1)]
    value = {"shots": shots}
    if segments is not None:
        value["segments"] = segments
    return value


class FramingBalanceTest(unittest.TestCase):
    def codes(self, result):
        return [item["code"] for item in result["diagnostics"]]

    def test_healthy_distribution_has_no_warnings(self):
        # EP2 修好后的实测分布：CU18 MCU8 FS5 MS5 WS3 EWS1
        values = (["CU"] * 18 + ["MCU"] * 8 + ["FS"] * 5 + ["MS"] * 5 + ["WS"] * 3 + ["EWS"] * 1)
        result = framing_balance(production(values))
        self.assertEqual(result["total"], 40)
        self.assertEqual(result["diagnostics"], [])
        self.assertAlmostEqual(result["ratios"]["MS"], 0.125)

    def test_medium_stack_is_reported(self):
        result = framing_balance(production(["MS"] * 8 + ["CU"] * 2))
        self.assertIn("FRAMING_MEDIUM_DOMINANT", self.codes(result))

    def test_close_shortage_is_reported(self):
        # 近景 1/10 = 10% < 20% 阈值
        result = framing_balance(production(["MS"] * 6 + ["WS"] * 3 + ["CU"] * 1))
        self.assertIn("FRAMING_CLOSE_SHORTAGE", self.codes(result))

    def test_close_ratio_exactly_at_threshold_is_allowed(self):
        # 2/10 = 20%，等于阈值不算短缺（只告警真低于线的情形）
        result = framing_balance(production(["MS"] * 5 + ["WS"] * 3 + ["CU", "MCU"]))
        self.assertNotIn("FRAMING_CLOSE_SHORTAGE", self.codes(result))

    def test_missing_establishing_shot_is_reported(self):
        result = framing_balance(production(["MCU", "CU", "MS", "MCU", "CU", "MS"]))
        self.assertIn("FRAMING_NO_ESTABLISHING", self.codes(result))

    def test_single_dominant_framing_is_reported(self):
        result = framing_balance(production(["CU"] * 6 + ["MS", "WS", "FS", "EWS"]))
        self.assertIn("FRAMING_SINGLE_DOMINANT", self.codes(result))

    def test_missing_framing_names_the_shot(self):
        value = production(["MS", "CU", "WS", "FS"])
        value["shots"][1]["camera"] = {}
        result = framing_balance(value)
        self.assertIn("FRAMING_MISSING", self.codes(result))
        item = next(item for item in result["diagnostics"] if item["code"] == "FRAMING_MISSING")
        self.assertIn("SH2", item["scope"])

    def test_flat_segment_is_reported(self):
        value = production(["MS"] * 6 + ["CU"] * 2 + ["WS"] * 2 + ["FS"] * 2,
                           segments=[{"id": "CLIP_A", "shot_ids": ["SH1", "SH2", "SH3"]},
                                     {"id": "CLIP_B", "shot_ids": ["SH7", "SH8", "SH9"]}])
        result = framing_balance(value)
        flat = [item for item in result["diagnostics"] if item["code"] == "FRAMING_SEGMENT_FLAT"]
        self.assertEqual([item["scope"] for item in flat], ["CLIP_A"])

    def test_short_segment_is_not_flagged_flat(self):
        value = production(["MS", "MS", "CU", "WS", "FS"],
                           segments=[{"id": "CLIP_A", "shot_ids": ["SH1", "SH2"]}])
        result = framing_balance(value)
        self.assertNotIn("FRAMING_SEGMENT_FLAT", self.codes(result))

    def test_director_source_shape_is_read(self):
        source = {"director": {"source": {"shots": [{"id": "SH1", "camera": {"framing": "CU"}},
                                                    {"id": "SH2", "camera": {"framing": "MS"}}]}}}
        result = framing_balance(source)
        self.assertEqual(result["total"], 2)

    def test_shots_without_framing_report_missing_not_no_shots(self):
        # 历史稿未声明 storyboard_policy 时可以没有 framing：只报缺失，不谎称没有镜头
        value = {"shots": [{"id": "SH1", "camera": {"lens_mm": 35}}, {"id": "SH2", "camera": {}}]}
        result = framing_balance(value)
        codes = self.codes(result)
        self.assertIn("FRAMING_MISSING", codes)
        self.assertNotIn("FRAMING_NO_SHOTS", codes)
        self.assertNotIn("FRAMING_MEDIUM_DOMINANT", codes)

    def test_empty_production_reports_no_shots(self):
        result = framing_balance({"shots": []})
        self.assertIn("FRAMING_NO_SHOTS", self.codes(result))


if __name__ == "__main__":
    unittest.main()
