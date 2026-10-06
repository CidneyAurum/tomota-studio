import unittest
from copy import deepcopy

from tomota.polish import add_findings, apply_revision, verify_repairs


class PolishLedgerTests(unittest.TestCase):
    def setUp(self):
        self.before = "门仍锁着。他突然离开。钥匙还在桌上。"
        self.after = "门仍锁着。听见窗外呼救，他转身赶往窗边。钥匙还在桌上。"
        self.ledger = add_findings({}, "review_logic", [{
            "finding_id": "F1", "quote": "他突然离开。", "repair_requirement": "补出离开的动机",
            "violated_rule": "行动需要触发",
        }], self.before, ["钥匙仍在桌上"])
        self.target = self.ledger["targets"][0]["target_id"]
        self.receipt = {"target_id": self.target, "mode": "repaired", "before_quote": "他突然离开。",
                        "after_quote": "听见窗外呼救，他转身赶往窗边。", "explanation": "明确呼救触发行动",
                        "preservation": {"before_quote": "钥匙还在桌上。", "after_quote": "钥匙还在桌上。",
                                         "explanation": "保留钥匙位置，不引入开门能力"}}
        self.verification = {"target_id": self.target, "resolved": True,
                             "quote": "听见窗外呼救，他转身赶往窗边。", "explanation": "呼救先于行动，动机完整",
                             "preservation_check": "门仍锁着，钥匙未移动，未改变已知事实"}

    def revised(self):
        return apply_revision(self.ledger, [self.receipt], self.before, self.after)

    def test_full_evidence_chain_and_input_immutability(self):
        original = deepcopy(self.ledger)
        revised = self.revised()
        self.assertEqual(self.ledger, original)
        self.assertEqual(revised["targets"][0]["status"], "needs_verification")
        confirmed = verify_repairs(revised, "review_logic", [self.verification], self.after)
        self.assertEqual(confirmed["targets"][0]["status"], "verified")
        self.assertEqual(revised["targets"][0]["status"], "needs_verification")

    def test_missing_duplicate_unrelated_unchanged_and_fake_protection_rejected(self):
        cases = [[], [self.receipt, self.receipt], [{**self.receipt, "before_quote": "门仍锁着。"}],
                 [{**self.receipt, "after_quote": "不存在的修复"}], [{**self.receipt, "mode": "preserved"}],
                 [{**self.receipt, "preservation": {"before_quote": "不存在", "after_quote": "不存在", "explanation": "已保留"}}]]
        for receipts in cases:
            with self.subTest(receipts=receipts), self.assertRaises(ValueError):
                apply_revision(self.ledger, receipts, self.before, self.after)

    def test_stale_draft_and_false_resolution_rejected(self):
        revised = self.revised()
        for receipts, text in (([], self.after), ([self.verification], self.before),
                               ([{**self.verification, "resolved": False}], self.after),
                               ([{**self.verification, "quote": "他突然离开。"}], self.after)):
            with self.subTest(receipts=receipts), self.assertRaises(ValueError):
                verify_repairs(revised, "review_logic", receipts, text)

    def test_later_revision_reopens_even_previously_verified_targets(self):
        confirmed = verify_repairs(self.revised(), "review_logic", [self.verification], self.after)
        preserved = {**self.receipt, "mode": "preserved", "before_quote": self.receipt["after_quote"]}
        next_draft = self.after + "窗外有人挥手。"
        reopened = apply_revision(confirmed, [preserved], self.after, next_draft)
        self.assertEqual(reopened["targets"][0]["status"], "needs_verification")
        self.assertNotIn("verification", reopened["targets"][0])

    def test_repeated_finding_keeps_stable_id_and_history(self):
        new = add_findings(self.revised(), "review_logic", [{
            "finding_id": "F1", "quote": self.receipt["after_quote"], "repair_requirement": "呼救方向仍不明确",
        }], self.after, ["钥匙未移动"])
        self.assertEqual(new["targets"][0]["target_id"], self.target)
        self.assertEqual(new["targets"][0]["status"], "needs_revision")
        self.assertEqual(len(new["targets"][0]["history"]), 1)
