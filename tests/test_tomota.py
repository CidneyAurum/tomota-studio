from __future__ import annotations

import tempfile
import unittest
import json
import os
import re
import io
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tomota.generator import MockGenerator
from tomota.autopilot import AutopilotRunner
from tomota.browser_job import BrowserJobError
from tomota.cleanup import CleanupManager
from tomota.models import ChapterContract, ReviewGate, ReviewReport, utc_now
from tomota.pipeline import PipelineBlocked, TomotaPipeline
from tomota.publisher import DryRunBrowserDriver, FanqiePublisher, PublishBlocked
from tomota.router import SkillRouter
from tomota.scheduler import Scheduler
from tomota.skill_adapter import SkillAdapter
from tomota.store import ProjectStore
from tomota.review import ChapterReviewer
from tomota.workflow import WorkflowEngine, WorkflowError
from tomota.cli import main as cli_main


SKILL_ROOT = Path.home() / ".codex" / "skills" / "webnovel-writing"


class CliJsonContractTests(unittest.TestCase):
    def test_json_mode_returns_machine_readable_validation_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with redirect_stdout(output):
                code = cli_main(["--root", directory, "workflow", "status", "--run-id", "missing", "--json"])
            value = json.loads(output.getvalue())
            self.assertEqual(code, 2)
            self.assertEqual(value["status"], "error")
            self.assertEqual(value["error_type"], "WorkflowError")
            self.assertIn("missing", value["message"])

    def test_book_create_generates_internal_id_when_user_does_not_supply_one(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "new-book.json"
            source.write_text(json.dumps({"title": "自动编号作品", "metadata": {"completion_mode": "open_ended"}}, ensure_ascii=False), encoding="utf-8")
            output = io.StringIO()
            with redirect_stdout(output):
                code = cli_main(["--root", directory, "book", "create", "--file", str(source), "--json"])
            value = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertRegex(value["book"]["id"], r"^novel-[0-9a-f]{12}$")
            self.assertTrue((Path(directory) / "books" / value["book"]["id"]).is_dir())


def strict_approve(store: ProjectStore, contract: ChapterContract, content: str) -> None:
    store.save_chapter(contract, status="drafted", content=content)
    gates = [ReviewGate(name, True, [f"{name} 已核对正文第1段"]) for name in [
        "design_review", "review_logic", "review_voice", "review_continuity", "cold_review",
    ]]
    store.save_review(ReviewReport(contract.book_id, contract.chapter_number, True, [], gates=gates, strict_workflow=True))


class SkillAdapterTests(unittest.TestCase):
    def test_inspect_refresh_verify_and_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = SkillAdapter(root, SKILL_ROOT)
            manifest = adapter.refresh_lock()
            self.assertEqual(manifest.skill_name, "webnovel-writing")
            self.assertEqual(set(manifest.module_names), {
                "concept_planning", "opening", "transition", "dialogue", "chapter_ending",
                "plot_logic", "character_consistency", "consistency_review", "volume_outline", "anti_ai_voice",
            })
            self.assertTrue(adapter.verify_lock().ok)
            self.assertIn("runtime.md", adapter.load_module("consistency_review").artifacts)
            self.assertIn("第 X 章", adapter.load_template("chapter"))

    def test_corpus_wrapper_returns_references(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = SkillAdapter(Path(directory), SKILL_ROOT)
            references = adapter.search_corpus(excerpt_type="开头钩子", limit=2)
            self.assertLessEqual(len(references), 2)
            self.assertTrue(references)
            self.assertTrue(references[0].ref_id)

    def test_lock_detects_manifest_change(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = SkillAdapter(Path(directory), SKILL_ROOT)
            adapter.refresh_lock()
            lock = adapter.lock_path.read_text(encoding="utf-8")
            changed = re.sub(r'("skill_version_hash"\s*:\s*"|skill_version_hash:\s*)([0-9a-f]+)', r'\1changed', lock, count=1)
            adapter.lock_path.write_text(changed, encoding="utf-8")
            result = adapter.verify_lock()
            self.assertFalse(result.ok)
            self.assertEqual(result.status, "changed")

    def test_project_preferences_are_injected_into_prompt_packs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preference_path = root / "library" / "preferences" / "writing_preferences.md"
            preference_path.parent.mkdir(parents=True)
            preference_path.write_text("人物不能共用一种腔调。", encoding="utf-8")
            adapter = SkillAdapter(root, SKILL_ROOT)
            pack = adapter.build_prompt_pack(task="对白修复", stage="chapter", module_chain=["dialogue"])
            self.assertIn("人物不能共用一种腔调", pack.render())


class RouterTests(unittest.TestCase):
    def test_chapter_route_contains_full_native_chain(self):
        route = SkillRouter().route("生成章节", "chapter")
        self.assertEqual(route.module_chain[-1], "consistency_review")
        self.assertIn("plot_logic", route.module_chain)
        self.assertIn("anti_ai_voice", route.module_chain)

    def test_issue_tag_routes_to_specialist(self):
        self.assertEqual(SkillRouter().issue_modules(["转场"]), ["transition"])


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.adapter = SkillAdapter(self.root, SKILL_ROOT)
        self.adapter.refresh_lock()
        self.store = ProjectStore(self.root)
        self.store.create_book("demo", "测试书", {"synopsis": "一个测试简介"})

    def tearDown(self):
        self.temp.cleanup()

    def test_legacy_mock_chapter_cannot_claim_strict_approval(self):
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT, generator=MockGenerator())
        contract = ChapterContract(
            book_id="demo", chapter_number=1, title="门后的声音", objective="主角要查明声音来源",
            obstacle="门被锁住", change="主角发现锁内侧有血迹", chapter_hook="门外又响起敲门声",
            next_first_beat="主角必须打开门", current_character_goal="查明声音来源", target_word_count=100,
        )
        path, report = pipeline.draft(contract)
        self.assertTrue(path.is_file())
        self.assertFalse(report.passed)
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "blocked")
        self.assertEqual(self.store.load_canon("demo")["chapter_number"], 0)

    def test_prompt_only_plan_is_traceable(self):
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT)
        artifact = pipeline.plan("demo", "一个拥有异常能力的普通人被迫调查失踪案。")
        self.assertTrue(Path(artifact.text).is_file())
        self.assertIn("concept_planning", Path(artifact.text).read_text(encoding="utf-8"))

    def test_review_blocks_duplicate_paragraphs_and_summary_ending(self):
        reviewer = ChapterReviewer(self.adapter, SkillRouter())
        contract = ChapterContract(
            book_id="demo", chapter_number=2, title="重复", objective="调查", obstacle="受阻", change="发现线索",
            next_first_beat="继续调查", target_word_count=10,
        )
        report = reviewer.review(contract, "第一段。\n\n第一段。\n\n总之，事情已经结束。")
        self.assertFalse(report.passed)
        self.assertTrue(any("重复段落" in item for item in report.hard_failures))
        self.assertTrue(any("总结" in item for item in report.hard_failures))

    def test_ingest_prompt_ready_chapter_requires_strict_workflow(self):
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT)
        contract = ChapterContract(
            book_id="demo", chapter_number=3, title="导入的章节", objective="找到门后的线索",
            obstacle="门锁住了", change="主角发现锁芯里藏着录音笔", chapter_hook="门外传来第二次敲门声",
            next_first_beat="主角必须决定是否开门", current_character_goal="找到门后的线索",
            relationship_state="主角不信任门外的人", body_information_state="右手擦伤，已知门内有录音笔", target_word_count=100,
        )
        with self.assertRaises(PipelineBlocked):
            pipeline.draft(contract)
        prompt_row = self.store.get_chapter("demo", 3)
        self.assertEqual(prompt_row["status"], "prompt_ready")
        source = self.root / "chapter-3.txt"
        source.write_text("主角贴近门缝，先听见自己的呼吸。\n\n锁芯里卡着一支录音笔，他用受伤的右手把它挑了出来。\n\n门外再次响起敲门声，主角握住录音笔，没有立刻开门。", encoding="utf-8")
        path, report = pipeline.ingest_chapter("demo", 3, source)
        self.assertTrue(path.is_file())
        self.assertFalse(report.passed)
        self.assertEqual(self.store.get_chapter("demo", 3)["status"], "blocked")
        self.assertEqual(self.store.load_canon("demo")["chapter_number"], 0)

    def test_ingest_outline_json_becomes_contract_queue(self):
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT)
        source = self.root / "outline.json"
        source.write_text('[{"chapter_number": 1, "title": "第一拍", "objective": "调查", "obstacle": "受阻", "change": "发现线索", "next_first_beat": "追查"}]', encoding="utf-8")
        output = pipeline.ingest_outline("demo", source)
        self.assertEqual(output.name, "chapters.json")
        self.assertEqual(output.read_text(encoding="utf-8").count("第一拍"), 1)

    def test_autopilot_without_semantic_gates_never_prepares_release(self):
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT, generator=MockGenerator())
        contracts = [
            ChapterContract("demo", 1, "第一拍", "查明声音", "门被锁住", "发现血迹", next_first_beat="打开门", target_word_count=80),
            ChapterContract("demo", 2, "第二拍", "追查血迹", "线索中断", "找到信件", next_first_beat="拆开信件", target_word_count=80),
        ]
        result = AutopilotRunner(pipeline).run("demo", contracts)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual([item["chapter"] for item in result["processed"]], [1, 2])
        self.assertIsNone(result["release"])

    def test_autopilot_collects_prompt_only_work_into_one_handoff(self):
        pipeline = TomotaPipeline(self.root, skill_root=SKILL_ROOT)
        contracts = [
            ChapterContract("demo", 1, "第一拍", "查明声音", "门被锁住", "发现血迹", next_first_beat="打开门", target_word_count=80),
            ChapterContract("demo", 2, "第二拍", "追查血迹", "线索中断", "找到信件", next_first_beat="拆开信件", target_word_count=80),
        ]
        result = AutopilotRunner(pipeline).run("demo", contracts, prepare_release=False)
        self.assertEqual(result["status"], "waiting_for_model_runtime")
        self.assertEqual(len(result["pending_external_generation"]), 2)
        self.assertTrue(Path(result["handoff"]).is_file())


class StrictStateMachineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        SkillAdapter(self.root, SKILL_ROOT).refresh_lock()
        self.store = ProjectStore(self.root)
        self.store.create_book("demo", "严格测试书", {"synopsis": "钟声与错杀"})
        self.contract = ChapterContract(
            "demo", 1, "钟后的人", "确认钟声来源", "记录只承认十二响", "主角收到错杀证据",
            chapter_hook="门外出现新证人", next_first_beat="主角核对证人身份", target_word_count=80,
        )
        self.store.save_chapter(self.contract, status="planned")

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def foundation(stage="story_foundation"):
        return {
            "stage": stage,
            "world_rules": ["钟声计数不可无故重置"], "terminology": {"葬钟": "王城葬仪用钟"},
            "timeline": ["处刑后三日"],
            "characters": [{"name": "阿贝尔", "goal": "查明错杀", "fear": "记忆不可信", "boundary": "不伪造记录", "behavior_pattern": "先核对物证", "speech_rhythm": "短句追问", "avoidance": "回避家族", "pressure_method": "复述矛盾"}],
            "relationship_matrix": ["阿贝尔—奥斯温：互不信任"],
            "knowledge_boundaries": ["阿贝尔只知道十二响的官方记录"],
            "foreshadowing": ["第十三响：读者已听见，来源未知"],
        }

    @staticmethod
    def design():
        return {
            "stage": "chapter_design",
            "scenes": [{"scene_id": "s1", "setting": "钟楼档案室", "objective": "核对钟数", "obstacle": "记录缺页", "motivation": "证明自己没有听错", "trigger": "收到封蜡信", "choice": "拆信", "consequence": "卷入错杀案", "next_scene_entry": "追查寄信人"}],
            "dialogue_pressure_plan": ["书记官用程序压人，阿贝尔用记录矛盾反问"],
            "character_knowledge": {"阿贝尔": ["官方只记十二响"]},
            "foreshadow_actions": ["信蜡印只展示纹章，不解释主人"],
            "core_reveal_closeup": "给信纸、墨迹、手部停顿和选择完整特写",
        }

    @staticmethod
    def passed_gate(stage):
        required = {
            "design_review": ["outline_contract", "canon_consistency", "knowledge_boundaries", "foreshadow_object_clarity"],
            "review_logic": ["text_design_alignment", "timeline", "counts_and_terms", "motivation", "consequence"],
            "review_voice": ["character_consistency", "knowledge_boundaries", "dialogue_function", "voice_swap", "anti_ai"],
            "review_continuity": ["foreshadow_object", "canon_consistency", "transitions", "ending", "next_chapter"],
            "cold_review": ["who", "does_what", "why", "referents"],
        }
        value = {"stage": stage, "gate": stage, "passed": True, "evidence": [f"{stage}：核对第1—3段，未留开放问题"], "checks": [{"name": name, "passed": True, "evidence": f"{name} 有对应正文/设计证据"} for name in required[stage]], "findings": []}
        if stage == "cold_review":
            value["reader_answers"] = {"who": "阿贝尔", "does_what": "拆信并追查", "why": "官方记录与亲耳钟声冲突", "referents": "信指封蜡信，钟指王城葬钟"}
        return value

    def advance_to_logic_review(self, engine, run_id):
        engine.submit(run_id, self.foundation())
        engine.submit(run_id, self.design())
        engine.submit(run_id, self.passed_gate("design_review"))
        content = "阿贝尔数到第十三响时，抄写笔停在纸上。\n\n档册只记着十二次。他翻出缺页的接缝，确认有人割走一张纸。\n\n封蜡信压在门缝下，印纹与处刑台的徽记相同。他拆开信，逐字读完，决定去查寄信人。\n\n门外的脚步停住，一个证人叫出了他的名字。"
        engine.submit(run_id, {"stage": "draft", "content": content})
        return content

    def test_full_workflow_is_resumable_and_updates_canon_from_text_evidence(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        first = engine.next_action(run.run_id)
        self.assertLess(first["prompt_bytes"], 50000)
        content = self.advance_to_logic_review(engine, run.run_id)
        # A fresh engine must resume from the persisted stage.
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        self.assertEqual(engine.status(run.run_id)["current_stage"], "review_logic")
        for stage in ["review_logic", "review_voice", "review_continuity", "cold_review"]:
            engine.submit(run.run_id, self.passed_gate(stage))
        evidence = "封蜡信压在门缝下"
        result = engine.submit(run.run_id, {
            "stage": "canon_update", "facts": [{"fact": "阿贝尔亲耳听到第十三响", "certainty": "confirmed"}],
            "character_states": [{"character": "阿贝尔", "state": "决定追查寄信人"}], "relationships": [{"from": "新证人", "to": "阿贝尔", "change": "主动接触"}],
            "open_threads": ["寄信人身份"], "foreshadowing": ["处刑台徽记"], "evidence": [evidence],
        })
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "approved")
        self.assertTrue(self.store.is_release_ready("demo", 1))
        self.assertEqual(self.store.load_canon("demo")["evidence"], [evidence])
        self.assertEqual(self.store.load_canon("demo")["facts"][0]["certainty"], "confirmed")

    def test_empty_review_evidence_is_rejected(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        engine.submit(run.run_id, self.design())
        with self.assertRaisesRegex(WorkflowError, "evidence"):
            engine.submit(run.run_id, {"stage": "design_review", "gate": "design_review", "passed": True, "evidence": [], "findings": []})

    def test_final_body_validation_routes_to_logic_and_includes_actual_failure(self):
        self.contract.target_word_count = 1000
        self.store.update_chapter_contract(self.contract)
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        content = self.advance_to_logic_review(engine, run.run_id)
        for stage in ["review_logic", "review_voice", "review_continuity", "cold_review"]:
            engine.submit(run.run_id, self.passed_gate(stage))
        result = engine.submit(run.run_id, {
            "stage": "canon_update", "facts": ["阿贝尔听见第十三响"],
            "character_states": ["阿贝尔决定追查"], "relationships": ["证人主动接触阿贝尔"],
            "open_threads": ["寄信人身份"], "foreshadowing": ["处刑台徽记"],
            "evidence": ["封蜡信压在门缝下"],
        })
        self.assertEqual(result["current_stage"], "revise_logic")
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn('"repair_source": "final_validation"', prompt)
        self.assertIn("正文长度低于目标字数", prompt)
        self.assertIn(content.splitlines()[0], prompt)

    def test_sixth_failed_review_blocks_after_five_revisions_and_keeps_two_drafts(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1], max_revisions=5)
        content = self.advance_to_logic_review(engine, run.run_id)
        finding = {"finding_id": "motivation", "severity": "blocker", "category": "行动动机", "location": "第2段", "quote": "他决定去查", "diagnosis": "线索不足", "violated_rule": "行动必须有触发", "repair_requirement": "补出物证来源", "status": "open"}
        for index in range(6):
            status = engine.submit(run.run_id, {"stage": "review_logic", "gate": "review_logic", "passed": False, "evidence": ["第2段缺少因果连接"], "findings": [finding]})
            if index < 5:
                self.assertEqual(status["current_stage"], "revise_logic")
                engine.submit(run.run_id, {"stage": "revise_logic", "content": content + f"\n\n返工线索 {index + 1}。"})
                content += f"\n\n返工线索 {index + 1}。"
        self.assertEqual(status["status"], "blocked")
        drafts = list((self.store.book_dir("demo") / "workflow" / run.run_id / "chapter-0001" / "drafts").glob("*.md"))
        trashed = list((self.store.book_dir("demo") / ".trash").rglob("draft-v*.md"))
        self.assertEqual(len(drafts), 2)
        self.assertGreaterEqual(len(trashed), 4)
        self.assertEqual(self.store.load_canon("demo")["chapter_number"], 0)

    def test_known_regression_samples_produce_complete_evidence(self):
        reviewer = ChapterReviewer(SkillAdapter(self.root, SKILL_ROOT), SkillRouter())
        samples = json.loads((Path(__file__).parent / "fixtures" / "legacy_failures.json").read_text(encoding="utf-8"))
        text = "\n".join(sample["text"] for sample in samples)
        findings = reviewer.lint(text)
        self.assertGreaterEqual(len(findings), len(samples))
        for finding in findings:
            self.assertTrue(finding.location and finding.quote and finding.violated_rule and finding.repair_requirement)


class BookPlanningTests(unittest.TestCase):
    def test_open_ended_book_keeps_full_volume_and_chapter_outline_levels(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProjectStore(Path(directory))
            store.create_book("serial", "开放式作品", {"author": "作者"})
            outline = store.save_master_outline("serial", {
                "completion_mode": "open_ended", "premise": "故事核", "core_conflict": "主冲突",
                "ending_direction": "未锁定", "major_beats": ["第一次转折"],
                "volumes": [{"volume_id": "volume-1", "title": "雨夜卷", "objective": "建立同盟", "main_conflict": "追捕", "character_change": "开始信任", "foreshadowing": "黑伞", "ending": "离开旧城"}],
                "rolling_plan": {"window_size": 5, "planned_through": 2},
            })
            chapters = store.save_outline_chapters("serial", [
                {"chapter_number": 1, "volume_id": "volume-1", "title": "雨中来客", "objective": "相遇", "obstacle": "追兵", "change": "临时合作", "next_first_beat": "检查伤口", "target_word_count": 2800},
                {"chapter_number": 2, "volume_id": "volume-1", "title": "旧物店", "objective": "藏身", "obstacle": "搜查", "change": "交换情报", "next_first_beat": "听见敲门", "target_word_count": 2800},
            ])
            self.assertEqual(outline["completion_mode"], "open_ended")
            self.assertIsNone(outline["target_chapters"])
            self.assertEqual(outline["volumes"][0]["title"], "雨夜卷")
            self.assertEqual(chapters[0]["volume_id"], "volume-1")
            self.assertEqual(store.get_book("serial")["metadata"]["completion_mode"], "open_ended")

    def test_filesystem_sync_refreshes_manifest_and_invalidates_changed_approved_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "旧标题", {"synopsis": "旧简介"})
            contract = ChapterContract("serial", 1, "第一章", "目标", "阻碍", "变化", next_first_beat="下一拍", target_word_count=10)
            store.save_outline_chapters("serial", [contract.to_dict()])
            strict_approve(store, contract, "原始正文。\n\n门开了。")
            manifest = {"book_id": "serial", "title": "新标题", "synopsis": "新简介", "completion_mode": "open_ended", "created_at": utc_now()}
            store.write_structured(store.book_dir("serial") / "book.yaml", manifest)
            (store.book_dir("serial") / "drafts" / "chapter-0001.md").write_text("外部工具修改后的正文。\n", encoding="utf-8")
            result = store.index_existing_books()
            self.assertIn("serial", result["updated_books"])
            self.assertEqual(store.get_book("serial")["title"], "新标题")
            self.assertEqual(store.get_book("serial")["metadata"]["synopsis"], "新简介")
            self.assertEqual(store.get_chapter("serial", 1)["status"], "modified_after_review")
            self.assertIn(1, result["invalidated_chapters"]["serial"])

    def test_filesystem_sync_marks_existing_unreviewed_draft_as_not_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "已有草稿", {})
            contract = ChapterContract("serial", 1, "第一章", "目标", "阻碍", "变化", next_first_beat="下一拍")
            store.save_outline_chapters("serial", [contract.to_dict()])
            draft = store.book_dir("serial") / "drafts" / "chapter-0001.md"
            draft.parent.mkdir(parents=True, exist_ok=True)
            draft.write_text("这一章已经存在，但还没有经过严格审查。\n", encoding="utf-8")
            store.index_existing_books()
            chapter = store.get_chapter("serial", 1)
            self.assertEqual(chapter["status"], "draft_unreviewed")
            self.assertTrue(chapter["path"].endswith("chapter-0001.md"))
            self.assertGreater(chapter["word_count"], 0)


class CleanupTests(unittest.TestCase):
    def test_cleanup_defaults_to_preview_and_never_touches_final_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("demo", "清理测试", {})
            final = store.book_dir("demo") / "drafts" / "chapter-0001.md"
            final.write_text("最终稿", encoding="utf-8")
            old = store.book_dir("demo") / ".trash" / "old.tmp"
            old.parent.mkdir(parents=True, exist_ok=True)
            old.write_text("废稿", encoding="utf-8")
            timestamp = (datetime.now(timezone.utc) - timedelta(days=8)).timestamp()
            os.utime(old, (timestamp, timestamp))
            manager = CleanupManager(store)
            preview = manager.run("demo")
            self.assertTrue(old.exists())
            self.assertIn(str(old), preview.candidates)
            applied = manager.run("demo", apply=True)
            self.assertFalse(old.exists())
            self.assertTrue(final.exists())
            self.assertIn(str(old), applied.removed)


class PublisherTests(unittest.TestCase):
    def test_confirmation_and_idempotency(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            SkillAdapter(root, SKILL_ROOT).refresh_lock()
            store = ProjectStore(root)
            store.create_book("demo", "测试书", {})
            contract = ChapterContract("demo", 1, "标题", "目标", "阻碍", "变化", chapter_hook="钩子", next_first_beat="下一拍", target_word_count=10)
            strict_approve(store, contract, "正文。\n\n门开了。")
            publisher = FanqiePublisher(store, DryRunBrowserDriver())
            batch = publisher.prepare_batch("demo", [1], {"1": "2030-01-01T20:00:00+00:00"})
            with self.assertRaises(PublishBlocked):
                publisher.submit_batch(batch)
            result = publisher.submit_batch(batch, confirmation=f"PUBLISH {batch.batch_id}")
            self.assertEqual(result.status, "submitted")
            second = publisher.submit_batch(batch, confirmation=f"PUBLISH {batch.batch_id}")
            self.assertEqual(second.skipped, [1])

    def test_browser_job_export_and_reconcile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            SkillAdapter(root, SKILL_ROOT).refresh_lock()
            store = ProjectStore(root)
            store.create_book("demo", "测试书", {})
            contract = ChapterContract("demo", 1, "标题", "目标", "阻碍", "变化", chapter_hook="钩子", next_first_beat="下一拍", target_word_count=10)
            content = "正文第一段。\n\n门开了，里面有新的线索。"
            strict_approve(store, contract, content)
            publisher = FanqiePublisher(store, DryRunBrowserDriver())
            batch = publisher.prepare_batch("demo", [1], {"1": "2030-01-01T20:00:00+00:00"})
            job_path = publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
            job = json.loads(job_path.read_text(encoding="utf-8"))
            self.assertEqual(job["schema_version"], 2)
            self.assertTrue(job["safety"]["confirm_before_each_cloud_write"])
            self.assertEqual(job["chapters"][0]["title"], "标题")
            result_path = Path(job["result_path"])
            result_path.write_text(json.dumps({
                "batch_id": batch.batch_id,
                "status": "submitted",
                "chapters": [{"chapter_number": 1, "status": "submitted", "platform_id": "fanqie-1", "content_fingerprint": job["chapters"][0]["content_fingerprint"]}],
            }, ensure_ascii=False), encoding="utf-8")
            result = publisher.reconcile_browser_job(batch)
            self.assertEqual(result.status, "submitted")
            self.assertEqual(store.get_chapter("demo", 1)["platform_id"], "fanqie-1")

    def test_browser_reconcile_rejects_content_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            SkillAdapter(root, SKILL_ROOT).refresh_lock()
            store = ProjectStore(root)
            store.create_book("demo", "测试书", {})
            contract = ChapterContract("demo", 1, "标题", "目标", "阻碍", "变化", chapter_hook="钩子", next_first_beat="下一拍", target_word_count=10)
            strict_approve(store, contract, "正文。\n\n门开了。")
            publisher = FanqiePublisher(store, DryRunBrowserDriver())
            batch = publisher.prepare_batch("demo", [1], {})
            job_path = publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
            job = json.loads(job_path.read_text(encoding="utf-8"))
            Path(job["result_path"]).write_text(json.dumps({
                "batch_id": batch.batch_id,
                "status": "submitted",
                "chapters": [{"chapter_number": 1, "status": "submitted", "content_fingerprint": "wrong-hash"}],
            }), encoding="utf-8")
            with self.assertRaises(BrowserJobError):
                publisher.reconcile_browser_job(batch)


class SchedulerTests(unittest.TestCase):
    def test_two_per_day(self):
        schedule = Scheduler(2, 7).build_schedule([1, 2, 3, 4])
        self.assertEqual(schedule["1"][:10], schedule["2"][:10])
        self.assertNotEqual(schedule["2"][:10], schedule["3"][:10])

    def test_explicit_platform_schedule_uses_requested_start_and_hour(self):
        start = datetime(2026, 8, 21, 9, 30, tzinfo=timezone(timedelta(hours=8)))
        schedule = Scheduler(2, 0, 18).build_schedule([1, 2, 3], start=start)
        self.assertEqual(schedule["1"], "2026-08-21T18:00:00+08:00")
        self.assertEqual(schedule["2"], "2026-08-21T19:00:00+08:00")
        self.assertEqual(schedule["3"], "2026-08-22T18:00:00+08:00")


class OhStoryTests(unittest.TestCase):
    OH_STORY_ROOT = Path.home() / ".codex" / "skills" / "oh-story-claudecode"

    def test_oh_story_skill_adapter(self):
        if not self.OH_STORY_ROOT.is_dir():
            self.skipTest("oh-story-claudecode repo not found")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = SkillAdapter(root, self.OH_STORY_ROOT)
            manifest = adapter.inspect()
            self.assertEqual(manifest.skill_name, "oh-story-claudecode")
            self.assertIn("anti_ai_voice", manifest.module_names)
            self.assertIn("scan", manifest.module_names)
            self.assertIn("cover", manifest.module_names)
            pack = adapter.load_module("anti_ai_voice")
            self.assertIn("README.md", pack.artifacts)

    def test_deslop_lint_and_normalization(self):
        from tomota.deslop import normalize_punctuation, run_deslop_lint
        raw = "门开了...空气仿佛凝固。他不禁感到--这一切刚刚开始。"
        normalized = normalize_punctuation(raw)
        self.assertIn("……", normalized)
        self.assertIn("——", normalized)

        findings = run_deslop_lint(raw, skill_root=self.OH_STORY_ROOT)
        self.assertTrue(any("空气仿佛凝固" in f.message or "空洞总结" in f.message or f.rule_type == "abstract-cliché" for f in findings))

    def test_scan_analyze_cover_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            SkillAdapter(root, SKILL_ROOT).refresh_lock()
            pipeline = TomotaPipeline(root, skill_root=SKILL_ROOT)
            pipeline.store.create_book("demo", "测试书", {"synopsis": "少年得到神剑。", "genre": "玄幻"})
            contract = ChapterContract("demo", 1, "第1章", "目标", "阻碍", "变化", "下一拍")
            pipeline.store.save_chapter(contract, status="draft", content="正文内容。")

            scan_art = pipeline.scan("玄幻修仙")
            self.assertIn("玄幻修仙", scan_art.metadata["prompt_text"])

            cover_art = pipeline.cover("demo")
            self.assertIn("测试书", cover_art.metadata["prompt_text"])

            deslop_res = pipeline.deslop_chapter("demo", 1, apply=False)
            self.assertEqual(deslop_res["book_id"], "demo")
            self.assertEqual(deslop_res["chapter_number"], 1)


if __name__ == "__main__":
    unittest.main()
