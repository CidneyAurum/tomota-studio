"""Exercise author receipts through the public submit/action boundary."""
import unittest

import test_tomota as fixtures
from tomota.authors import AuthorService
from tomota.workflow import WorkflowEngine, WorkflowError


class AuthoredWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StrictStateMachineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.engine = WorkflowEngine(self.fixture.root, skill_root=fixtures.SKILL_ROOT)
        authors = AuthorService(self.fixture.root)
        author = authors.create_profile("验收测试作者")
        version = authors.create_version(author["id"], fixtures.author_profile("用动作呈现情绪"), status="published")
        authors.bind_book("demo", version["id"])
        self.run = self.engine.start("demo", [1])

    def current(self):
        return self.engine._run(self.run.run_id)

    def gate(self, stage):
        value = self.fixture.passed_gate(stage)
        value["checks"] = [{"name": name, "passed": True, "evidence_refs": ["E1"]}
                           for name in self.engine._required_checks(self.current(), stage)]
        return value

    def test_author_draft_and_independent_review_require_current_receipts(self):
        engine = self.engine
        run_id = self.run.run_id
        foundation = self.fixture.foundation()
        rules = engine._compile_stage_writing_policy(self.current(), engine._writing_policy(self.current()), {})["executable_style_rules"]
        foundation["constraint_application"] = [
            {"constraint_id": rule["rule_id"], "source": rule["source"], "target_fields": ["world_rules"],
             "execution": "人物以核对物证的动作表达焦虑", "acceptance_test": "保留核对物证动作",
             "conflict_status": "active", "suppressed_by": "", "conflict_reason": "", "conflict_dimensions": []}
            for rule in rules]
        engine.submit(run_id, foundation)
        design = self.fixture.design()
        rules = engine._compile_stage_writing_policy(self.current(), engine._writing_policy(self.current()), {})["executable_style_rules"]
        design["constraint_application"] += [
            {"constraint_id": rule["rule_id"], "source": rule["source"], "scene_ids": ["s1"],
             "execution": "抄写笔停住呈现震惊", "acceptance_test": "有停笔动作",
             "conflict_status": "active", "suppressed_by": "", "conflict_reason": "", "conflict_dimensions": []}
            for rule in rules]
        engine.submit(run_id, design)
        engine.submit(run_id, self.gate("design_review"))
        content = "阿贝尔数到第十三响时，抄写笔停在纸上。\n\n档册只记着十二次。他翻出缺页的接缝，确认有人割走一张纸。\n\n封蜡信压在门缝下，印纹与处刑台的徽记相同。他拆开信，逐字读完，决定去查寄信人。\n\n门外的脚步停住，一个证人叫出了他的名字。"
        action = engine.next_action(run_id)
        self.assertIn("author_realization", action["output_schema"]["required"])
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, {"stage": "draft", "content": content})
        receipts = [{"rule_id": rule["rule_id"], "status": "realized", "quote": "抄写笔停在纸上。",
                     "location": "第1段", "reason": "停笔动作表达发现异常时的震惊", "suppressed_by": ""}
                    for rule in engine._prose_author_rules(self.current())]
        engine.submit(run_id, {"stage": "draft", "content": content, "author_realization": receipts})
        engine.submit(run_id, self.gate("review_logic"))
        voice = self.gate("review_voice")
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, voice)
        voice["author_realization"] = [{**receipt, "quote": "并不存在的动作。"} for receipt in receipts]
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, voice)
        self.assertEqual(self.current().current_stage, "review_voice")
        voice["author_realization"] = receipts
        engine.submit(run_id, voice)
        self.assertEqual(self.current().current_stage, "review_continuity")
        failure = self.gate("review_continuity")
        failure.update(passed=False, findings=[{
            "finding_id": "repair-1", "severity": "blocker", "category": "转场",
            "location": "第1段", "quote": "抄写笔停在纸上。", "diagnosis": "需要更明确的停顿动作",
            "violated_rule": "动作承接情绪", "repair_requirement": "改写停笔动作", "status": "open",
        }], revision_brief=self.fixture.revision_brief("抄写笔停在纸上。", "review_continuity"))
        engine.submit(run_id, failure)
        self.assertEqual(self.current().current_stage, "revise_continuity")
        revised = content.replace("抄写笔停在纸上。", "抄写笔悬在纸面。")
        revision = {"stage": "revise_continuity", "content": revised,
                    "author_realization": receipts}
        with self.assertRaises(WorkflowError):
            engine.submit(run_id, revision)
        revision["author_realization"] = [{**receipt, "quote": "抄写笔悬在纸面。"} for receipt in receipts]
        engine.submit(run_id, revision)
        self.assertEqual(self.current().current_stage, "review_logic")
        self.assertFalse((engine._stage_dir(self.current()) / "review_voice.json").exists())
