import unittest
from copy import deepcopy

import test_tomota as fixtures
from tomota.workflow import WorkflowEngine, WorkflowError


class FailedReviewAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StrictStateMachineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.engine = WorkflowEngine(self.fixture.root, skill_root=fixtures.SKILL_ROOT)
        self.run = self.engine.start("demo", [1])
        self.fixture.advance_to_logic_review(self.engine, self.run.run_id)

    def failure(self):
        value = self.fixture.passed_gate("review_logic")
        value.update(passed=False, findings=[{
            "finding_id": "F1", "severity": "blocker", "category": "因果",
            "location": "第1段", "quote": "抄写笔停在纸上。", "diagnosis": "停笔触发应更明确",
            "violated_rule": "动作必须有触发", "repair_requirement": "补足停笔原因", "status": "open",
        }], revision_brief=self.fixture.revision_brief("抄写笔停在纸上。", "review_logic"))
        return value

    def assert_rejected_without_artifact(self, value):
        with self.assertRaises(WorkflowError):
            self.engine.submit(self.run.run_id, value)
        run = self.engine._run(self.run.run_id)
        self.assertEqual(run.current_stage, "review_logic")
        self.assertFalse((self.engine._stage_dir(run) / "review_logic.json").exists())

    def test_real_top_level_evidence_does_not_authorize_invented_finding(self):
        value = self.failure()
        value["findings"][0]["quote"] = "不存在的原文和人物动作。"
        self.assert_rejected_without_artifact(value)

    def test_duplicate_finding_ids_rejected(self):
        value = self.failure()
        value["findings"].append(deepcopy(value["findings"][0]))
        self.assert_rejected_without_artifact(value)

    def test_invalid_brief_never_persists_as_repair_authority(self):
        # Call the submission boundary validator directly to ensure persistence
        # is safe even without JSON Schema guarding an external caller first.
        value = self.failure()
        value["revision_brief"] = []
        run = self.engine._run(self.run.run_id)
        with self.assertRaises(WorkflowError):
            self.engine._submit_review(run, value)
        self.assertFalse((self.engine._stage_dir(run) / "review_logic.json").exists())

    def test_grounded_failure_still_enters_targeted_revision(self):
        self.engine.submit(self.run.run_id, self.failure())
        self.assertEqual(self.engine._run(self.run.run_id).current_stage, "revise_logic")

    def test_revision_requires_receipt_and_independent_closure(self):
        engine = self.engine
        run_id = self.run.run_id
        engine.submit(run_id, self.failure())
        run = engine._run(run_id)
        ledger = engine._polish_ledger(run)
        target = ledger["targets"][0]
        content = engine._current_draft(run).replace("抄写笔停在纸上。", "异常的钟声让他停住了笔。")
        revision = {"stage": "revise_logic", "content": content}
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, revision)
        revision["repair_receipts"] = [{
            "target_id": target["target_id"], "mode": "repaired", "before_quote": "抄写笔停在纸上。",
            "after_quote": "异常的钟声让他停住了笔。", "explanation": "钟声异常先触发停笔",
            "preservation": {"before_quote": "档册只记着十二次。", "after_quote": "档册只记着十二次。",
                             "explanation": "保留记录和听闻的冲突"},
        }]
        engine.submit(run_id, revision)
        passed = self.fixture.passed_gate("review_logic", "档册只记着十二次。")
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, passed)
        passed["repair_verification"] = [{
            "target_id": target["target_id"], "resolved": True, "quote": "异常的钟声让他停住了笔。",
            "explanation": "核对修复后动作有明确触发", "preservation_check": "十二次官方记录仍然保留，未改动事实",
        }]
        engine.submit(run_id, passed)
        current = engine._run(run_id)
        self.assertEqual(current.current_stage, "review_voice")
        self.assertEqual(engine._polish_ledger(current)["targets"][0]["status"], "verified")
        for stage in ("review_voice", "review_continuity", "cold_review"):
            engine.submit(run_id, self.fixture.passed_gate(stage, "档册只记着十二次。"))
        result = engine.submit(run_id, {
            "stage": "canon_update", "facts": ["阿贝尔听到第十三响"],
            "character_states": ["阿贝尔决定追查"], "relationships": ["证人主动接触阿贝尔"],
            "open_threads": ["寄信人身份"], "foreshadowing": ["处刑台徽记"],
            "state_facts": [], "evidence": ["封蜡信压在门缝下"],
        })
        self.assertEqual(result["status"], "completed")
        self.assertTrue(engine.store.is_release_ready("demo", 1))


class DesignPolishTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StrictStateMachineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.engine = WorkflowEngine(self.fixture.root, skill_root=fixtures.SKILL_ROOT)
        self.run = self.engine.start("demo", [1])
        self.engine.submit(self.run.run_id, self.fixture.foundation())
        self.engine.submit(self.run.run_id, self.fixture.design())

    def failure(self):
        value = self.fixture.passed_gate("design_review")
        value.update(passed=False, findings=[{
            "finding_id": "D1", "severity": "blocker", "category": "揭示", "location": "scenes[0]",
            "quote": "承担核心信件揭示，不可删并", "diagnosis": "缺少具体物证对照",
            "violated_rule": "揭示需要物证", "repair_requirement": "明确封蜡与徽记对照", "status": "open",
        }], revision_brief=self.fixture.revision_brief("承担核心信件揭示，不可删并", "design_review"))
        return value

    def test_design_repair_cannot_cite_receipt_as_repaired_artifact(self):
        engine = self.engine
        run_id = self.run.run_id
        engine.submit(run_id, self.failure())
        run = engine._run(run_id)
        self.assertEqual(run.current_stage, "chapter_design")
        target = engine._polish_ledger(run)["targets"][0]["target_id"]
        old = "承担核心信件揭示，不可删并"
        new = "通过封蜡印痕与处刑台徽记对照交付可核验物证，不可删并"
        design = self.fixture.design()
        design["repair_receipts"] = [{
            "target_id": target, "mode": "repaired", "before_quote": old, "after_quote": new,
            "explanation": "加入具体物证核验", "preservation": {
                "before_quote": "官方只承认十二响", "after_quote": "官方只承认十二响",
                "explanation": "保持官方记录与亲耳听闻矛盾"},
        }]
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, design)
        design["scenes"][0]["cut_or_merge_reason"] = new
        engine.submit(run_id, design)
        review = self.fixture.passed_gate("design_review", new)
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, review)
        review["repair_verification"] = [{
            "target_id": target, "resolved": True, "quote": new,
            "explanation": "设计明确物证核验而非空泛揭示", "preservation_check": "知识边界和钟声矛盾未改变",
        }]
        engine.submit(run_id, review)
        self.assertEqual(engine._run(run_id).current_stage, "draft")

    def test_design_rework_has_a_finite_budget(self):
        run = self.engine._run(self.run.run_id)
        run.max_revisions = 0
        self.engine.store.save_workflow_run(run)
        self.engine.submit(run.run_id, self.failure())
        self.assertEqual(self.engine._run(run.run_id).status, "blocked")
