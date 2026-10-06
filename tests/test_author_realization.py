import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from tomota.workflow import WorkflowEngine, WorkflowError, QUALITY_SCORE_FIELDS


class AuthorRealizationTests(unittest.TestCase):
    def setUp(self):
        self.engine = WorkflowEngine.__new__(WorkflowEngine)
        self.run = SimpleNamespace(current_stage="draft")
        self.rules = [{"rule_id": "A", "execution_required": True, "activation": "global_guard"}]
        self.engine._prose_author_rules = lambda run: self.rules
        self.content = "她把钥匙推回桌角，没有回答。"
        self.receipt = {"rule_id": "A", "status": "realized", "quote": self.content,
                        "location": "第1段", "reason": "用退还钥匙的动作表达拒绝", "suppressed_by": ""}

    def validate(self, receipts):
        self.engine._validate_author_realization(self.run, receipts, self.content)

    def test_grounded_realization_accepted(self):
        self.validate([self.receipt])

    def test_missing_duplicate_and_unknown_rules_rejected(self):
        for receipts in (None, [], [self.receipt, self.receipt], [{**self.receipt, "rule_id": "invented"}]):
            with self.subTest(receipts=receipts), self.assertRaises(WorkflowError):
                self.validate(receipts)

    def test_invented_quote_and_required_omission_rejected(self):
        for changes in ({"quote": "她接过钥匙。"}, {"status": "not_used"}, {"reason": ""}):
            with self.subTest(changes=changes), self.assertRaises(WorkflowError):
                self.validate([{**self.receipt, **changes}])

    def test_optional_omission_only_before_scene_selection(self):
        self.rules[0]["execution_required"] = False
        self.validate([{**self.receipt, "status": "not_used", "reason": "本章无此类对话场景"}])
        self.rules[0]["scene_ids"] = ["S1"]
        with self.assertRaises(WorkflowError):
            self.validate([{**self.receipt, "status": "not_used"}])

    def test_suppression_requires_exact_approved_suppressor(self):
        self.rules[0].update(activation="suppressed", execution_required=False, suppressed_by="F")
        self.validate([{**self.receipt, "status": "suppressed", "suppressed_by": "F", "quote": ""}])
        for changes in ({"status": "realized"}, {"status": "suppressed", "suppressed_by": "invented"}):
            with self.subTest(changes=changes), self.assertRaises(WorkflowError):
                self.validate([{**self.receipt, **changes}])

    def test_draft_gate_rejects_missing_receipts_before_writing(self):
        self.engine._draft_versions = Mock(side_effect=AssertionError("must not write draft"))
        with self.assertRaises(WorkflowError):
            self.engine._submit_draft(self.run, {"content": self.content})
        self.engine._draft_versions.assert_not_called()

    def test_passing_scorecard_rejects_low_scores(self):
        for score in (1, 2):
            card = {key: {"score": score, "evidence_refs": ["E1"]} for key in QUALITY_SCORE_FIELDS}
            with self.subTest(score=score), self.assertRaisesRegex(WorkflowError, "至少 3 分"):
                self.engine._validate_quality_scorecard(self.run, card, {"E1": self.content}, self.content)
        card = {key: {"score": 3, "evidence_refs": ["E1"]} for key in QUALITY_SCORE_FIELDS}
        self.engine._validate_quality_scorecard(self.run, card, {"E1": self.content}, self.content)
