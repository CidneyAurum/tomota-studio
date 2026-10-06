from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tomota.models import ChapterContract, WorkflowRun
from tomota.pipeline import TomotaPipeline
from tomota.review import ChapterReviewer
from tomota.router import SkillRouter
from tomota.skill_adapter import SkillAdapter
from tomota.store import ProjectStore
from tomota.workflow import QUALITY_SCORE_FIELDS, REQUIRED_CHECKS, WorkflowEngine


SKILL_ROOT = Path(__file__).parent.parent / "skills" / "webnovel-writing"


class DeslopWorkflowIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = ProjectStore(self.root)
        self.store.create_book("demo", "去 AI 接线测试", {"synopsis": "测试"})
        self.contract = ChapterContract(
            "demo", 1, "第一章", "找到证据", "档案缺页", "主角决定追查", "继续核验",
            target_word_count=20,
        )
        self.store.save_chapter(self.contract, status="draft_unreviewed", content="正文。")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _voice_run(self, content: str) -> tuple[WorkflowEngine, WorkflowRun, Path]:
        run = WorkflowRun(
            run_id="workflow-deslop", book_id="demo", chapter_numbers=[1],
            status="running", current_chapter=1, current_stage="review_voice",
            max_revisions=5,
        )
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        engine.store.save_workflow_run(run)
        stage_dir = engine.store.book_dir("demo") / "workflow" / run.run_id / "chapter-0001"
        draft = stage_dir / "drafts" / "draft-v01.md"
        draft.parent.mkdir(parents=True, exist_ok=True)
        draft.write_text(content.rstrip() + "\n", encoding="utf-8")
        return engine, run, stage_dir

    @staticmethod
    def _passed_voice_artifact(quote: str, checks: tuple[str, ...] | None = None) -> dict[str, object]:
        # The required check set is author-dependent.  Legacy/system-compatible
        # runs intentionally omit author-only checks, so tests must build the
        # artifact from the same resolved contract instead of a static global
        # list.
        check_names = checks or REQUIRED_CHECKS["review_voice"]
        return {
            "schema_version": "review-artifact-v2",
            "stage": "review_voice", "gate": "review_voice", "passed": True,
            "summary": "模型认为全部检查通过",
            "evidence": [{"evidence_id": "E1", "location": "第1行", "quote": quote}],
            "checks": [
                {"name": name, "passed": True, "evidence_refs": ["E1"]}
                for name in check_names
            ],
            "findings": [], "revision_brief": [],
            "quality_scorecard": {
                name: {"score": 5, "evidence_refs": ["E1"]}
                for name in QUALITY_SCORE_FIELDS
            },
        }

    def test_review_voice_context_contains_deterministic_deslop_report(self) -> None:
        content = "这不是一次意外，而是命运安排好的审判。"
        engine, run, _ = self._voice_run(content)

        context = engine._stage_context(run)

        self.assertIn("deslop_scan", context)
        scan = context["deslop_scan"]
        self.assertGreaterEqual(scan["blocking_count"], 1)
        self.assertIn("not-is-comparison", [item["rule_type"] for item in scan["findings"]])
        self.assertIn("diagnostic_only", scan["authority"])

    def test_deslop_blocker_forces_voice_revision_even_when_model_passes(self) -> None:
        content = "这不是一次意外，而是命运安排好的审判。"
        engine, run, stage_dir = self._voice_run(content)

        engine._submit_review(run, self._passed_voice_artifact(content, engine._required_checks(run, "review_voice")))

        self.assertEqual(run.current_stage, "revise_voice")
        self.assertEqual(run.revision_round, 1)
        saved = json.loads((stage_dir / "review_voice.json").read_text(encoding="utf-8"))
        self.assertFalse(saved["passed"])
        self.assertIn("去AI味", [item["category"] for item in saved["findings"]])
        self.assertTrue(saved["revision_brief"])

    def test_chapter_review_keeps_deslop_item_and_names_rule_families(self) -> None:
        reviewer = ChapterReviewer(SkillAdapter(self.root, SKILL_ROOT), SkillRouter())
        content = "她不知道的是，这意味着危险。她感到一阵紧张。"
        report = reviewer.review(self.contract, content)
        item = next(item for item in report.items if item.category == "去AI味")
        self.assertEqual(item.status, "需修")
        self.assertIn("解释腔", item.summary)
        self.assertIn("心理告知", item.summary)
        self.assertEqual(item.route, ["anti_ai_voice"])

    def test_apply_preserves_pre_change_version_and_audit_events(self) -> None:
        SkillAdapter(self.root, SKILL_ROOT).refresh_lock()
        original = "门开了...他问,你是谁?"
        self.store.save_chapter(self.contract, status="approved", content=original)
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT)

        result = pipeline.deslop_chapter("demo", 1, apply=True)

        self.assertTrue(result["applied"])
        version_path = Path(str(result["version_path"]))
        self.assertTrue(version_path.is_file())
        self.assertEqual(version_path.read_text(encoding="utf-8").strip(), original)
        self.assertIn("门开了……他问，你是谁？", self.store.read_content("demo", 1))
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "modified_after_review")
        metrics = result["effect_metrics"]
        self.assertEqual(metrics["scope"], "deterministic_patterns_and_punctuation_only")
        self.assertFalse(metrics["semantic_quality_measured"])
        self.assertIn("不代表文笔更像人类", metrics["notice"])
        events = [json.loads(line) for line in (self.root / "audit" / "events.jsonl").read_text(encoding="utf-8").splitlines()]
        event_types = [item["event_type"] for item in events]
        self.assertIn("chapter_deslop_apply_requested", event_types)
        self.assertIn("chapter_deslopped", event_types)


if __name__ == "__main__":
    unittest.main()
