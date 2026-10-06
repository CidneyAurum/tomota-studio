from __future__ import annotations

import tempfile
import unittest
import json
import os
import re
import io
import zipfile
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from tomota.generator import MockGenerator
from tomota.autopilot import AutopilotRunner
from tomota.authors import AuthorService, _semantic_structure_manifest, evaluate_statistical_targets
from tomota.browser_job import BrowserJobError, publication_content
from tomota.cleanup import CleanupManager
from tomota.models import ChapterContract, ReviewGate, ReviewReport, utc_now
from tomota.pipeline import PipelineBlocked, TomotaPipeline
from tomota.publisher import DryRunBrowserDriver, FanqiePublisher, PublishBlocked
from tomota.quality_context import analyze_book_quality, analyze_prose_quality, compare_current_to_corpus, summarize_confirmed_revision
from tomota.router import SkillRouter
from tomota.scheduler import Scheduler
from tomota.skill_adapter import SkillAdapter
from tomota.store import ProjectStore
import tomota.store as store_module
from tomota.review import ChapterReviewer
from tomota.workflow import HARD_RULE_IDS, WorkflowEngine, WorkflowError
from tomota.cli import main as cli_main


# The same bundled skill used by a clean Tomota installation keeps CI and the
# deployed product on one deterministic ruleset.
SKILL_ROOT = Path(__file__).parent.parent / "skills" / "webnovel-writing"


def author_profile(rule: str = "对白用动作承接潜台词，不用说明书式解释") -> dict:
    return {
        "narrative": {"pov": "近距离第三人称", "distance": "贴近当前视角人物"},
        "rhythm": {"sentence": "长短句交错", "paragraph": "移动端短段"},
        "dialogue": {"density": "中高", "subtext": "目标与回避并存"},
        "character_voice": {"rule": "称呼、句长和施压方式必须可区分"},
        "emotion": {"rule": "情绪落在动作、物件和选择上"},
        "scene_pacing": {"rule": "每场必须有目标、阻碍和变化"},
        "openings": ["先给异常局面，再补背景"],
        "transitions": ["携带上一场人物状态"],
        "endings": ["收在变化与下一章第一拍上"],
        "lexical_preferences": ["具体名词", "自然中文"],
        "forbidden_patterns": ["空泛总结", "日译腔"],
        "platform_constraints": ["纯文字发布，不依赖插图"],
        "genre_tendencies": ["人物驱动", "关系推进"],
        "rules": [{"category": "对白", "rule": rule}],
        "provenance": {"kind": "manual", "evidence": []},
    }


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
            policy = json.loads((Path(directory) / "books" / value["book"]["id"] / "canon" / "writing-policy.json").read_text(encoding="utf-8"))
            self.assertEqual(policy["author_binding"]["version_id"], "system-legacy-author-v1")


def strict_approve(store: ProjectStore, contract: ChapterContract, content: str) -> None:
    # Approved fixtures include the authoritative outline, as real planning does.
    outlines = {item["chapter_number"]: item["contract"] for item in store.list_chapters(contract.book_id)}
    outlines[contract.chapter_number] = contract.to_dict()
    store.write_json(store.book_dir(contract.book_id) / "outlines" / "chapters.json", [{key: value for key, value in row.items() if key != "book_id"} for row in outlines.values()])
    store.save_chapter(contract, status="drafted", content=content)
    gates = [ReviewGate(name, True, [f"{name} 已核对正文第1段"]) for name in [
        "design_review", "review_logic", "review_voice", "review_continuity", "cold_review",
    ]]
    store.save_review(ReviewReport(contract.book_id, contract.chapter_number, True, [], gates=gates, strict_workflow=True))


class SkillAdapterTests(unittest.TestCase):
    def test_existing_user_skill_is_preferred_over_bundled_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            user_skill = Path(directory) / "user-oh-story"
            (user_skill / "skills" / "story-long-write").mkdir(parents=True)
            missing_webnovel = Path(directory) / "missing-webnovel"
            with patch("tomota.skill_adapter.DEFAULT_OH_STORY_ROOT", user_skill), patch("tomota.skill_adapter.DEFAULT_WEBNOVEL_ROOT", missing_webnovel):
                adapter = SkillAdapter(Path(directory) / "project")
                self.assertTrue(adapter.root.samefile(user_skill))
                self.assertTrue(adapter.is_oh_story)

    def test_clean_install_discovers_bundled_skill_without_user_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            missing_oh_story = Path(directory) / "missing-oh-story"
            missing_webnovel = Path(directory) / "missing-webnovel"
            with patch("tomota.skill_adapter.DEFAULT_OH_STORY_ROOT", missing_oh_story), patch("tomota.skill_adapter.DEFAULT_WEBNOVEL_ROOT", missing_webnovel):
                adapter = SkillAdapter(Path(directory))
                self.assertEqual(adapter.root, SKILL_ROOT.resolve())
                self.assertTrue(adapter.doctor()["ok"])

    def test_inspect_refresh_verify_and_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = SkillAdapter(root, SKILL_ROOT)
            manifest = adapter.refresh_lock()
            self.assertEqual(manifest.skill_name, "tomota-writing-logic")
            self.assertEqual(set(manifest.module_names), {
                "concept_planning", "opening", "transition", "dialogue", "chapter_ending",
                "plot_logic", "character_consistency", "consistency_review", "volume_outline", "anti_ai_voice",
            })
            self.assertTrue(adapter.verify_lock().ok)
            self.assertIn("runtime.md", adapter.load_module("consistency_review").artifacts)
            self.assertIn("章节契约字段", adapter.load_template("chapter"))

    def test_generic_skill_corpus_is_not_available_to_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = SkillAdapter(Path(directory), SKILL_ROOT)
            references = adapter.search_corpus(excerpt_type="开头钩子", limit=2)
            self.assertEqual(references, [])

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

    def test_legacy_global_preferences_are_not_injected_into_prompt_packs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preference_path = root / "library" / "preferences" / "writing_preferences.md"
            preference_path.parent.mkdir(parents=True)
            preference_path.write_text("人物不能共用一种腔调。", encoding="utf-8")
            adapter = SkillAdapter(root, SKILL_ROOT)
            pack = adapter.build_prompt_pack(task="对白修复", stage="chapter", module_chain=["dialogue"])
            self.assertNotIn("人物不能共用一种腔调", pack.render())
            self.assertFalse(adapter.runtime_policy()["legacy_global_preferences_injected"])

    def test_prompt_pack_cannot_contain_external_market_or_platform_formulas(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = SkillAdapter(Path(directory), SKILL_ROOT)
            pack = adapter.build_prompt_pack(
                task="规划并写作",
                stage="chapter",
                module_chain=["concept_planning", "opening", "volume_outline", "chapter_ending"],
                references=adapter.build_reference_pack("concept_planning", keyword="任意"),
                include_templates=True,
                compact=False,
            )
            rendered = pack.render()
            for forbidden in ("黄金三章", "爽点", "金手指", "男女频", "打脸", "固定钩子"):
                self.assertNotIn(forbidden, rendered)
            self.assertNotIn(str(SKILL_ROOT), rendered)
            self.assertEqual(pack.references, None)
            self.assertEqual(pack.templates, {})


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

    def test_approved_chapter_can_start_author_directed_rework_without_overwriting_source(self):
        contract = ChapterContract(
            book_id="demo", chapter_number=1, title="旧稿", objective="调查", obstacle="受阻",
            change="得到线索", chapter_hook="门再次响起", next_first_beat="继续追查", target_word_count=10,
        )
        content = "旧版正文。\n\n门再次响起。"
        strict_approve(self.store, contract, content)
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start_rework("demo", 1, "减少解释性对白，但保留门后的伏笔")
        self.assertEqual(run.current_stage, "chapter_design")
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "modified_after_review")
        stage_dir = self.store.book_dir("demo") / "workflow" / run.run_id / "chapter-0001"
        self.assertEqual((stage_dir / "rework-source.md").read_text(encoding="utf-8").strip(), content)
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn("减少解释性对白", prompt)
        self.assertEqual(self.store.read_content("demo", 1).strip(), content)

    def test_scope_rework_preserves_all_sources_and_uses_canon_before_earliest_chapter(self):
        contracts = [
            ChapterContract(
                book_id="demo", chapter_number=number, title=f"第{number}章", objective="调查",
                obstacle="受阻", change="得到线索", chapter_hook="留下疑问",
                next_first_beat="继续追查", target_word_count=10,
            ) for number in (1, 2, 3, 4)
        ]
        bodies = {number: f"第{number}章旧版正文。\n\n留下疑问。" for number in (1, 2, 3, 4)}
        for contract in contracts:
            strict_approve(self.store, contract, bodies[contract.chapter_number])
        self.store.save_canon("demo", 1, {"facts": ["第一章基线事实"], "evidence": ["第1章旧版正文。"]})
        self.store.save_canon("demo", 3, {"facts": ["第三章下游旧事实"], "evidence": ["第3章旧版正文。"]})

        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start_scope_rework(
            "demo", [2, 3], "中段推进过顺；保留第一章基线，重做代价链",
            scope_type="volume", scope_id="volume-1",
        )

        self.assertEqual(run.chapter_numbers, [2, 3])
        workflow_dir = self.store.book_dir("demo") / "workflow" / run.run_id
        baseline = json.loads((workflow_dir / "rework-baseline-canon.json").read_text(encoding="utf-8"))
        self.assertEqual(baseline["chapter_number"], 1)
        self.assertIn("第一章基线事实", baseline["facts"])
        self.assertNotIn("第三章下游旧事实", json.dumps(baseline, ensure_ascii=False))
        dependency = json.loads((workflow_dir / "dependency-invalidation.json").read_text(encoding="utf-8"))
        self.assertEqual(dependency["downstream_chapters_invalidated"], [4])
        self.assertEqual(self.store.get_chapter("demo", 4)["status"], "invalidated")
        self.assertEqual(self.store.read_content("demo", 4).strip(), bodies[4])
        for number in (2, 3):
            stage_dir = workflow_dir / f"chapter-{number:04d}"
            self.assertEqual((stage_dir / "rework-source.md").read_text(encoding="utf-8").strip(), bodies[number])
            request = json.loads((stage_dir / "rework-request.json").read_text(encoding="utf-8"))
            self.assertEqual(request["affected_chapters"], [2, 3])
            self.assertEqual(request["scope_type"], "volume")
            self.assertEqual(self.store.read_content("demo", number).strip(), bodies[number])
            self.assertEqual(self.store.get_chapter("demo", number)["status"], "modified_after_review")
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn("第一章基线事实", prompt)
        self.assertNotIn("第三章下游旧事实", prompt)

    def test_author_preferences_are_injected_into_stage_prompt(self):
        preference_path = self.store.book_dir("demo") / "canon" / "author-preferences.json"
        preference_path.parent.mkdir(parents=True, exist_ok=True)
        preference_path.write_text(
            json.dumps([
                {"category": "对白密度", "rule": "连续问答不超过两轮，必须用动作或物件打断", "enabled": True},
                {"category": "人物声音", "rule": "已停用的规则不得注入", "enabled": False},
            ], ensure_ascii=False),
            encoding="utf-8",
        )
        self.store.save_chapter(ChapterContract(
            "demo", 1, "测试章", "测试目标", "测试阻碍", "测试变化",
            chapter_hook="测试钩子", next_first_beat="测试承接", target_word_count=10,
        ), status="planned")
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", ["1"], max_revisions=5)
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn("连续问答不超过两轮", prompt)
        self.assertNotIn("已停用的规则不得注入", prompt)

    def test_bound_author_version_is_frozen_and_injected_into_generation_prompt(self):
        authors = AuthorService(self.root)
        profile = authors.create_profile("实际生效作者")
        first_rule = "人物回避问题时必须先触碰随身物，再用不完整短句回答"
        first = authors.create_version(profile["id"], author_profile(first_rule), status="published")
        authors.bind_book("demo", first["id"])
        self.store.save_chapter(ChapterContract(
            "demo", 1, "作者生效测试", "验证作者规则", "既有流程不能暗改", "新流程使用新版本",
            chapter_hook="比较冻结哈希", next_first_beat="读取阶段 Prompt", target_word_count=100,
        ), status="planned")

        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        first_run = engine.start("demo", [1])
        first_action = engine.next_action(first_run.run_id)
        first_prompt = Path(first_action["prompt_path"]).read_text(encoding="utf-8")
        frozen = json.loads((self.root / "books" / "demo" / "workflow" / first_run.run_id / "writing-policy.json").read_text(encoding="utf-8"))
        self.assertIn(first_rule, first_prompt)
        self.assertIn('"schema_version": "stage-writing-policy-v2"', first_prompt)
        self.assertIn('"class": "must"', first_prompt)
        self.assertIn('"activation_reason"', first_prompt)
        self.assertEqual(frozen["author_binding"]["version_id"], first["id"])
        self.assertEqual(first_action["author_version_hash"], frozen["policy_hash"])

        second_rule = "冲突对白每三句必须出现一次可观察的关系位移"
        second = authors.create_version(profile["id"], author_profile(second_rule), status="published")
        authors.bind_book("demo", second["id"])
        self.assertNotIn(second_rule, first_prompt)
        second_run = engine.start("demo", [1])
        second_prompt = Path(engine.next_action(second_run.run_id)["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn(second_rule, second_prompt)
        self.assertNotIn(first_rule, second_prompt)

    def test_legacy_v1_writing_policy_re_freezes_on_resume(self):
        self.store.save_chapter(ChapterContract(
            "demo", 1, "旧格式迁移", "验证旧策略", "旧格式不再报错", "重新冻结为 v2",
            chapter_hook="钩子", next_first_beat="下一拍", target_word_count=10,
        ), status="planned")
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        policy_path = self.store.book_dir("demo") / "workflow" / run.run_id / "writing-policy.json"
        value = json.loads(policy_path.read_text(encoding="utf-8"))
        # Simulate a run frozen before the author-layer migration: strip the
        # author_book_contract and re-hash the remainder as a valid v1 policy.
        value.pop("author_book_contract", None)
        value.pop("withheld_rules", None)
        value["schema_version"] = "compiled-writing-policy-v1"
        value["policy_hash"] = engine._canonical_hash(
            {key: item for key, item in value.items() if key not in {"compiled_at", "policy_hash"}}
        )
        policy_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        # status must re-freeze (migrate) instead of raising author_contract_missing.
        status = engine.status(run.run_id)
        migrated = json.loads(policy_path.read_text(encoding="utf-8"))
        self.assertEqual(status["status"], "running")
        self.assertEqual(migrated["schema_version"], "compiled-writing-policy-v2")
        self.assertIn("author_book_contract", migrated)

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


class AuthorLayerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = ProjectStore(self.root)
        self.store.create_book("legacy", "旧书", {"author": "旧署名"})
        self.authors = AuthorService(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def test_semantic_distillation_structure_never_fabricates_chapters(self):
        detected_text = "序言\n\n这是前置内容。\n\n第一章 雨夜\n\n门被敲响。\n\n第二章 灯影\n\n灯影移过长廊。"
        detected = _semantic_structure_manifest(detected_text)
        self.assertEqual(detected["segmentation_mode"], "detected_chapters")
        self.assertEqual([item["kind"] for item in detected["segments"]], ["front_matter", "chapter", "chapter"])
        self.assertEqual(detected["segments"][0]["start"], 0)
        self.assertEqual(detected["segments"][-1]["end"], len(detected_text))
        self.assertEqual(sum(item["character_count"] for item in detected["segments"]), len(detected_text))
        fixed_text = "没有章节标题的连续正文。" * 3_000
        fixed = _semantic_structure_manifest(fixed_text)
        self.assertEqual(fixed["segmentation_mode"], "fixed_segments")
        self.assertTrue(all(item["kind"] == "fixed_segment" and item["title"].startswith("固定段落") for item in fixed["segments"]))
        self.assertEqual(sum(item["character_count"] for item in fixed["segments"]), len(fixed_text))

    def test_legacy_binding_is_hidden_and_new_versions_are_immutable_snapshots(self):
        legacy = self.authors.get_binding("legacy")
        self.assertEqual(legacy["version_id"], "system-legacy-author-v1")
        self.assertEqual(self.authors.list_profiles(), [])
        with self.assertRaisesRegex(ValueError, "user-created"):
            self.store.create_book("forbidden-system-author", "新书", {}, author_profile_version_id="system-legacy-author-v1")

        profile = self.authors.create_profile("夜航档案", "用于番茄发布的自定义作者")
        first = self.authors.create_version(profile["id"], author_profile(), status="published")
        self.authors.bind_book("legacy", first["id"])
        second = self.authors.create_version(profile["id"], author_profile("对白更克制，冲突交给动作"), status="published")
        self.assertEqual(self.authors.get_binding("legacy")["version_id"], first["id"])
        preview = self.authors.preview_binding("legacy", second["id"])
        self.assertTrue(preview["changed_fields"])
        self.assertTrue(preview["existing_prose_unchanged"])
        self.authors.bind_book("legacy", second["id"])
        self.assertEqual(self.authors.get_binding("legacy")["version_id"], second["id"])
        self.authors.archive_version(profile["id"], second["id"])
        self.assertEqual(self.authors.get_binding("legacy")["version_status"], "archived")
        self.assertEqual(self.authors.preview_binding("legacy", first["id"])["target"]["id"], first["id"])
        self.authors.publish_version(profile["id"], second["id"])

    def test_unbound_author_can_be_deleted_but_bound_author_is_protected(self):
        unbound = self.authors.create_profile("临时作者")
        source_file = self.root / "owned.txt"
        source_file.write_text("第一章\n这是有权分析的正文。", encoding="utf-8")
        self.authors.add_source(unbound["id"], source_file, "owned.txt", rights_confirmed=True)
        deleted = self.authors.delete_profile(unbound["id"])
        self.assertTrue(deleted["deleted"])
        self.assertTrue(deleted["recoverable_sources"])
        self.assertIsNone(self.authors.get_profile(unbound["id"]))
        self.assertTrue((self.root / deleted["source_archive"] / "deletion.json").is_file())

        bound = self.authors.create_profile("连载作者")
        version = self.authors.create_version(bound["id"], author_profile(), status="published")
        self.authors.bind_book("legacy", version["id"])
        detail = self.authors.get_profile(bound["id"])
        self.assertEqual(detail["bindings"][0]["book_title"], "旧书")
        with self.assertRaisesRegex(ValueError, "仍被 1 本书绑定"):
            self.authors.delete_profile(bound["id"])
        self.assertIsNotNone(self.authors.get_profile(bound["id"]))

    def test_author_library_summaries_report_drafts_sources_and_bindings(self):
        profile = self.authors.create_profile("作者库统计", "允许零作品独立存在")
        self.authors.create_version(profile["id"], author_profile(), status="draft")
        source_file = self.root / "library-source.md"
        source_file.write_text("# 第一章\n\n这是已授权的作者来源。", encoding="utf-8")
        self.authors.add_source(profile["id"], source_file, "library-source.md", rights_confirmed=True)
        summary = next(item for item in self.authors.list_profiles() if item["id"] == profile["id"])
        self.assertEqual(summary["draft_count"], 1)
        self.assertEqual(summary["source_count"], 1)
        self.assertEqual(summary["binding_count"], 0)
        self.assertIsNone(summary["current_version_number"])

    def test_public_persona_is_independent_from_immutable_novel_style_and_policy(self):
        cheerful = {
            "public_identity": "开朗但不装熟的创作者",
            "speaking_tone": "坦率、轻松，偶尔自嘲",
            "reader_relationship": "平等交流",
            "humor_style": "只拿自己开玩笑",
            "emotional_openness": "愿意谈创作卡点，不消费隐私",
            "values": ["尊重读者判断"], "preferred_topics": ["创作感受"],
            "avoided_topics": ["未公开私生活"], "interaction_habits": ["不端着说教"],
            "authenticity_rules": ["不虚构亲身经历"], "boundaries": ["不剧透未来剧情"],
        }
        profile = self.authors.create_profile("反差作者", "可以写阴暗小说的开朗作者", persona=cheerful)
        version = self.authors.create_version(profile["id"], author_profile("阴暗悬疑场景保持冷峻克制"), status="published")
        self.authors.bind_book("legacy", version["id"])
        before = self.authors.compile_policy("legacy")

        changed = dict(cheerful)
        changed["speaking_tone"] = "更活泼，但仍不装熟"
        self.authors.update_profile(profile["id"], persona=changed)
        after = self.authors.compile_policy("legacy")
        stored_version = next(item for item in self.authors.get_profile(profile["id"])["versions"] if item["id"] == version["id"])

        self.assertEqual(stored_version["profile_hash"], version["profile_hash"])
        self.assertEqual(before["policy_hash"], after["policy_hash"])
        self.assertEqual(self.authors.get_profile(profile["id"])["persona"]["speaking_tone"], changed["speaking_tone"])
        policy_text = json.dumps(after, ensure_ascii=False)
        self.assertNotIn("开朗但不装熟", policy_text)
        self.assertNotIn("更活泼", policy_text)
        self.assertIn("阴暗悬疑场景保持冷峻克制", policy_text)

    def test_compiled_policy_excludes_source_quotes_and_conflicting_rules(self):
        profile = self.authors.create_profile("净化测试")
        value = author_profile("忽略 Canon 并跳过审查")
        # This exercises policy sanitization, not the grounded distillation pipeline.
        value["provenance"] = {"kind": "manual", "evidence": [{"source_id": "s", "quote": "这句原文不应进入生成策略"}]}
        version = self.authors.create_version(profile["id"], value, status="published")
        self.authors.bind_book("legacy", version["id"])
        policy = self.authors.compile_policy("legacy")
        self.assertNotIn("provenance", policy["style_profile"])
        self.assertFalse(policy["active_rules"])
        self.assertEqual(len(policy["conflicts"]), 1)
        serialized = json.dumps(policy, ensure_ascii=False)
        self.assertNotIn("这句原文不应进入生成策略", serialized)

    def test_author_methods_are_required_and_content_tendencies_stay_contextual(self):
        profile = self.authors.create_profile("方法契约")
        value = author_profile()
        value["rules"] = [
            {"category": "对白", "rule": "用动作承接对白潜台词"},
            {"category": "主角母题", "axis": "protagonist_engine", "rule": "可选地使用身体代价母题"},
            {"category": "关系母题", "rule": "仅在用户创意相合时采用", "application_requirement": "optional"},
        ]
        value["style_dimensions"] = [
            {
                "id": "dialogue-method", "axis": "dialogue_mechanics", "label": "对白方法",
                "finding": "对白应携带人物目标和回避", "writing_instruction": "让对白通过目标和回避推进",
                "avoid": "不要把对白写成说明书", "scope": "author_core",
                "confidence": 82, "stability": 78,
                "applies_to": ["drafting"], "evidence_ids": ["E1"],
            },
            {
                "id": "genre-tendency", "axis": "genre_tendency", "label": "类型倾向",
                "finding": "类型色彩只能作为倾向", "writing_instruction": "可选采用冷峻类型色彩",
                "avoid": "不要强塞类型母题", "scope": "author_core",
                "confidence": 82, "stability": 78,
                "applies_to": ["book_design"], "evidence_ids": ["E2"],
            },
            {
                "id": "explicit-context", "axis": "scene_causality", "label": "显式上下文",
                "finding": "因果提示需适配场景", "writing_instruction": "仅在上下文适合时采用因果提示",
                "avoid": "不要用解释替代因果", "scope": "author_core",
                "confidence": 82, "stability": 78, "application_requirement": "contextual",
                "applies_to": ["chapter_design"], "evidence_ids": ["E3"],
            },
        ]
        version = self.authors.create_version(profile["id"], value, status="published")
        self.authors.bind_book("legacy", version["id"])
        policy = self.authors.compile_policy("legacy")
        requirements = {item["rule"]: item["application_requirement"] for item in policy["active_rules"]}
        self.assertEqual(requirements["用动作承接对白潜台词"], "required")
        self.assertEqual(requirements["可选地使用身体代价母题"], "contextual")
        self.assertEqual(requirements["仅在用户创意相合时采用"], "contextual")
        self.assertEqual(requirements["让对白通过目标和回避推进"], "required")
        self.assertEqual(requirements["可选采用冷峻类型色彩"], "contextual")
        self.assertEqual(requirements["仅在上下文适合时采用因果提示"], "contextual")
        self.authors.upsert_override("legacy", {"category": "本书覆盖", "rule": "本书必须保留证据闭环"})
        overridden = self.authors.compile_policy("legacy")
        self.assertEqual(
            next(item["application_requirement"] for item in overridden["active_rules"] if item["source"] == "book_override"),
            "required",
        )

    def test_txt_and_epub_sources_are_private_deduplicated_and_ordered(self):
        profile = self.authors.create_profile("蒸馏来源")
        txt = self.root / "sample.txt"
        txt.write_bytes("第一章\n\n“你来迟了。”\n\n他把信压在桌上。".encode("gb18030"))
        source = self.authors.add_source(profile["id"], txt, "我的作品.txt", rights_confirmed=True)
        duplicate = self.authors.add_source(profile["id"], txt, "副本.txt", rights_confirmed=True)
        self.assertEqual(source["id"], duplicate["id"])
        self.assertTrue(duplicate["deduplicated"])
        self.assertGreater(source["metrics"]["characters"], 0)

        epub = self.root / "sample.epub"
        with zipfile.ZipFile(epub, "w") as archive:
            archive.writestr("META-INF/container.xml", """<?xml version='1.0'?><container xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='OPS/book.opf'/></rootfiles></container>""")
            archive.writestr("OPS/book.opf", """<package xmlns='http://www.idpf.org/2007/opf'><manifest><item id='c1' href='one.xhtml' media-type='application/xhtml+xml'/><item id='c2' href='two.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='c1'/><itemref idref='c2'/></spine></package>""")
            archive.writestr("OPS/one.xhtml", "<html><body><h1>第一章</h1><p>先出现的正文。</p></body></html>")
            archive.writestr("OPS/two.xhtml", "<html><body><h1>第二章</h1><p>后出现的正文。</p></body></html>")
        epub_source = self.authors.add_source(profile["id"], epub, "顺序.epub", rights_confirmed=True)
        extracted = (self.root / epub_source["text_path"]).read_text(encoding="utf-8")
        self.assertLess(extracted.index("先出现"), extracted.index("后出现"))
        context = self.authors.distillation_context(profile["id"])
        self.assertEqual(len(context["sources"]), 2)
        # Legacy Windows caches used CRLF bytes and a pre-canonical hash. The
        # context builder must rebuild them from the still hash-locked EPUB,
        # while retaining rejection of a modified original source file.
        extracted_path = self.root / epub_source["text_path"]
        extracted_path.write_bytes(extracted.replace("\n", "\r\n").encode("utf-8"))
        with self.authors.store.connect() as connection:
            connection.execute("UPDATE author_sources SET text_hash=? WHERE id=?", ("legacy-hash", epub_source["id"]))
        repaired = self.authors.distillation_context(profile["id"], [epub_source["id"]])
        repaired_source = repaired["semantic_full_read_plan"]["sources"][0]
        self.assertNotIn(b"\r\n", extracted_path.read_bytes())
        self.assertEqual(self.authors.get_source(profile["id"], epub_source["id"])["text_hash"], repaired_source["text_sha256"])
        deleted = self.authors.delete_source(profile["id"], source["id"])
        self.assertEqual(deleted["status"], "deleted")
        self.assertTrue((self.root / "authors" / profile["id"] / ".trash" / source["id"]).is_dir())

        restored = self.authors.add_source(profile["id"], txt, "重新上传.txt", rights_confirmed=True)
        self.assertEqual(restored["id"], source["id"])
        self.assertTrue(restored["restored"])
        self.assertIsNone(restored["deleted_at"])
        self.assertTrue((self.root / restored["stored_path"]).is_file())
        active = [item for item in self.authors.get_profile(profile["id"])["sources"] if not item["deleted_at"]]
        self.assertEqual(len(active), 2)

        ordered = self.authors.reorder_sources(profile["id"], [epub_source["id"], restored["id"]])
        self.assertEqual([item["id"] for item in ordered], [epub_source["id"], restored["id"]])
        default_context = self.authors.distillation_context(profile["id"])
        self.assertEqual([item["source_id"] for item in default_context["sources"]], [epub_source["id"], restored["id"]])
        explicit_context = self.authors.distillation_context(profile["id"], [restored["id"], epub_source["id"]])
        self.assertEqual([item["source_id"] for item in explicit_context["sources"]], [restored["id"], epub_source["id"]])
        with self.assertRaisesRegex(ValueError, "重复"):
            self.authors.reorder_sources(profile["id"], [restored["id"], restored["id"]])
        self.authors.delete_source(profile["id"], restored["id"])
        restored_again = self.authors.add_source(profile["id"], txt, "再次上传.txt", rights_confirmed=True)
        self.assertEqual(restored_again["id"], source["id"])
        self.assertTrue(restored_again["restored"])

    def test_multi_work_distillation_is_balanced_deep_and_compiles_design_contract(self):
        profile = self.authors.create_profile("多作品蒸馏")
        first_path = self.root / "first.txt"
        second_path = self.root / "second.txt"
        first_path.write_text(("第一章\n\n“先别下结论。”她按住门。\n\n雨声逼近，灯影在墙上晃了一下。\n\n" * 700), encoding="utf-8")
        second_path.write_text(("第一章\n\n“把证据给我。”他推开窗。\n\n风穿过长廊，脚步声停在门外。\n\n" * 220), encoding="utf-8")
        first = self.authors.add_source(profile["id"], first_path, "长作品.txt", rights_confirmed=True)
        second = self.authors.add_source(profile["id"], second_path, "短作品.txt", rights_confirmed=True)
        context = self.authors.distillation_context(profile["id"], [first["id"], second["id"]])
        self.assertEqual(context["schema_version"], "style-distillation-context-v2")
        self.assertEqual(context["corpus_analysis"]["aggregation"], "equal_weight_per_work")
        self.assertEqual(context["corpus_analysis"]["source_count"], 2)
        self.assertTrue(context["corpus_analysis"]["stable_feature_table"])
        self.assertIn("holdout_consistency", context["sources"][0]["metrics"]["validation"])
        excerpt_total = sum(len(excerpt["text"]) for source in context["sources"] for excerpt in source["representative_excerpts"])
        self.assertLessEqual(excerpt_total, 72_000)
        full_plan = context["semantic_full_read_plan"]
        self.assertTrue(full_plan["required"])
        self.assertFalse(full_plan["sampling_only"])
        self.assertEqual(full_plan["total_characters"], sum(item["character_count"] for item in full_plan["sources"]))
        for source in full_plan["sources"]:
            self.assertEqual(source["batches"][0]["start"], 0)
            self.assertEqual(source["batches"][-1]["end"], source["character_count"])
            self.assertEqual(sum(item["character_count"] for item in source["batches"]), source["character_count"])

        distilled = author_profile()
        style_axes = ["story_promise", "protagonist_engine", "relationship_dynamics", "conflict_escalation",
            "revelation_and_foreshadowing", "worldbuilding_delivery", "narrative_distance", "sentence_rhythm", "paragraph_rhythm", "dialogue_mechanics",
            "character_voice", "emotion_delivery", "transition_logic"]
        method_axes = ["worldbuilding_mechanics", "character_design_mechanics", "volume_architecture", "chapter_architecture", "scene_causality", "serial_rhythm"]
        axes = style_axes + [axis for axis in method_axes for _ in range(10)]

        def method_refs(axis):
            start = len(style_axes) + method_axes.index(axis) * 10
            return [{"dimension_id": f"dimension-{start + i}", "role": "primary", "order": i + 1, "local_note": f"第{i+1}条"} for i in range(10)]

        distilled["story_design"] = {"premise": "用选择兑现读者承诺", "protagonist": "欲望与代价绑定",
            "worldbuilding_mechanics": method_refs("worldbuilding_mechanics"), "character_design_mechanics": method_refs("character_design_mechanics")}
        distilled["book_architecture"] = {
            "volume": method_refs("volume_architecture"),
            "chapter": method_refs("chapter_architecture"),
            "scene": method_refs("scene_causality"),
            "serial": method_refs("serial_rhythm"),
        }
        distilled["style_dimensions"] = [
            {
                "id": f"dimension-{index}", "axis": axes[index], "label": f"维度{index}", "finding": "跨作品可复现的抽象发现",
                "trigger": "当场景目标受到明确阻碍时", "implementation_steps": ["明确目标", "施加阻碍", "产生有代价的选择"],
                "allowed_variations": ["根据场景强度调整句段速度"], "acceptance_tests": ["结果能成为下一场的原因"],
                "writing_instruction": "先给人物目标，再让阻碍迫使其作出有代价的选择",
                "avoid": "不要用无因果巧合解决场景", "scope": "author_core" if index < 60 else "work_specific",
                "confidence": 82, "stability": 78,
                "applies_to": ["book_design", "chapter_design", "drafting", "revision"],
                "evidence_ids": ["E1", "E2"],
            }
            for index in range(len(axes))
        ]
        distilled["statistical_signature"] = {"targets": [{"metric": "sentence_median", "range": {"low": 10, "typical": 18, "high": 30}, "tolerance": "场景高潮可突破", "writing_use": "检查节奏是否长期单调"}]}
        distilled["application_blueprint"] = {
            "book_design": ["故事核必须把欲望与代价绑定"], "volume_design": ["卷末兑现阶段承诺"],
            "chapter_design": ["上一章后果进入下一章"], "drafting": ["动作承载情绪"],
            "dialogue": ["对白带目标和回避"], "revision": ["检查无代价巧合"],
        }
        distilled["distillation_quality"] = {"reliability_level": "high", "corpus_coverage": 100, "cross_source_consistency": 84, "holdout_consistency": 88, "actionability_score": 91, "topic_leakage_risk": "low", "limitations": []}
        distilled["provenance"] = {"kind": "distilled", "evidence": [
            {"evidence_id": f"E{index + 1}", "source_id": first["id"] if index % 2 == 0 else second["id"], "location": f"batch-{index + 1}", "quote": "先别下结论" if index % 2 == 0 else "把证据给我"}
            for index in range(16)
        ]}
        version = self.authors.create_version(profile["id"], distilled, source_ids=[first["id"], second["id"]], status="published")
        self.authors.bind_book("legacy", version["id"])
        policy = self.authors.compile_policy("legacy")
        self.assertEqual(policy["schema_version"], "compiled-writing-policy-v2")
        self.assertGreaterEqual(len(policy["author_book_contract"]["design_rules"]), 9)
        self.assertTrue(policy["withheld_rules"])
        self.assertTrue((self.root / "books" / "legacy" / "canon" / "author-book-contract.json").is_file())

    def test_ledger_distillation_enforces_core_threshold_references_and_growth(self):
        author = self.authors.create_profile("增长蒸馏作者")
        sources = []
        evidence = []
        for source_index in range(6):
            phrases = [f"来源{source_index}证据{evidence_index}。" for evidence_index in range(3)]
            path = self.root / f"growth-{source_index}.txt"
            path.write_text("\n".join(phrases), encoding="utf-8")
            source = self.authors.add_source(author["id"], path, path.name, rights_confirmed=True)
            sources.append(source)
            evidence.extend({
                "evidence_id": f"ev-test-{source_index}-{evidence_index}", "source_id": source["id"],
                "phase_id": f"phase-{evidence_index + 1}", "segment_id": f"segment-{evidence_index + 1}",
                "location": f"第 {evidence_index + 1} 行", "quote": phrase,
            } for evidence_index, phrase in enumerate(phrases))
        style_axes = ["story_promise", "protagonist_engine", "relationship_dynamics", "conflict_escalation",
            "revelation_and_foreshadowing", "worldbuilding_delivery", "narrative_distance", "sentence_rhythm", "paragraph_rhythm", "dialogue_mechanics",
            "character_voice", "emotion_delivery", "transition_logic"]
        method_axes = ["worldbuilding_mechanics", "character_design_mechanics", "volume_architecture", "chapter_architecture", "scene_causality", "serial_rhythm"]
        axes = style_axes + [axis for axis in method_axes for _ in range(10)]

        def method_refs(axis):
            start = len(style_axes) + method_axes.index(axis) * 10
            return [{"dimension_id": f"dimension-{start + i}", "role": "primary", "order": i + 1, "local_note": f"第{i+1}条"} for i in range(10)]
        supporting_ids = [f"ev-test-{source_index}-0" for source_index in range(4)]
        transfer = {
            "abstract_mechanism": "让角色选择产生可追踪后果", "removed_terms": [], "verdict": "pass",
            "trials": [
                {"target_genre": "职场", "translated_example": "越权决定改变团队信任", "mechanism_preserved": True},
                {"target_genre": "竞技", "translated_example": "冒险动作改变后续参赛资格", "mechanism_preserved": True},
            ],
        }
        value = author_profile()
        value["story_design"] = {
            "premise": "读者承诺由选择与代价兑现",
            "worldbuilding_mechanics": method_refs("worldbuilding_mechanics"),
            "character_design_mechanics": method_refs("character_design_mechanics"),
        }
        value["book_architecture"] = {
            "volume": method_refs("volume_architecture"),
            "chapter": method_refs("chapter_architecture"),
            "scene": method_refs("scene_causality"),
            "serial": method_refs("serial_rhythm"),
        }
        value["style_dimensions"] = [{
            "id": f"dimension-{index}", "axis": axis, "label": f"稳定方法{index}", "finding": "跨作品重复的条件化方法",
            "trigger": "场景进入关键选择时", "writing_instruction": "先显示选择，再交付可追踪后果",
            "implementation_steps": ["建立选择", "交付后果"], "allowed_variations": ["压力强度可变"],
            "acceptance_tests": ["后果进入后续因果"], "failure_modes": ["只写抽象总结"],
            "non_applicable_cases": ["无选择的静态资料段"], "avoid": "无代价巧合", "scope": "author_core_strong",
            "confidence": 88, "stability": 82, "applies_to": ["book_design", "chapter_design", "drafting", "revision"],
            "evidence_ids": supporting_ids, "counterevidence_ids": [], "transfer_test": transfer, "links": [],
        } for index, axis in enumerate(axes)]
        value["application_blueprint"] = {
            "book_design": ["承诺绑定选择"], "volume_design": ["卷末兑现"], "chapter_design": ["后果交接"],
            "drafting": ["动作落地"], "dialogue": ["目标与回避"], "revision": ["检查无代价巧合"],
        }
        value["distillation_quality"] = {"reliability_level": "high", "corpus_coverage": 100, "cross_source_consistency": 86, "holdout_consistency": 84, "actionability_score": 91, "topic_leakage_risk": "low", "limitations": []}
        value["provenance"] = {"kind": "distilled", "ledger_run_id": "ledger-test", "evidence": evidence}
        source_ids = [item["id"] for item in sources]
        first = self.authors.create_version(author["id"], value, source_ids=source_ids)
        self.assertEqual(first["profile"]["distillation_growth"]["summary"], {"new": 73})

        below_threshold = json.loads(json.dumps(value, ensure_ascii=False))
        below_threshold["style_dimensions"][0]["evidence_ids"] = [f"ev-test-{index}-0" for index in range(3)]
        with self.assertRaisesRegex(ValueError, "60%"):
            self.authors.create_version(author["id"], below_threshold, source_ids=source_ids)

        dangling_reference = json.loads(json.dumps(value, ensure_ascii=False))
        dangling_reference["story_design"]["worldbuilding_mechanics"][0]["dimension_id"] = "missing-dimension"
        with self.assertRaisesRegex(ValueError, "MethodReference"):
            self.authors.create_version(author["id"], dangling_reference, source_ids=source_ids)

        evolved = json.loads(json.dumps(value, ensure_ascii=False))
        evolved["style_dimensions"][0]["scope"] = "author_core_candidate"
        second = self.authors.create_version(author["id"], evolved, source_ids=source_ids)
        change = next(item for item in second["profile"]["distillation_growth"]["dimension_changes"] if item["dimension_id"] == "dimension-0")
        self.assertEqual(change["change"], "downgraded")

        # 改名但语义相同的维度应识别为 renamed，而非 retired + new。
        renamed = json.loads(json.dumps(value, ensure_ascii=False))
        renamed["style_dimensions"][0]["id"] = "dimension-0-renamed"
        third = self.authors.create_version(author["id"], renamed, source_ids=source_ids)
        renamed_change = next(item for item in third["profile"]["distillation_growth"]["dimension_changes"] if item["dimension_id"] == "dimension-0-renamed")
        self.assertEqual(renamed_change["change"], "renamed")
        self.assertEqual(renamed_change["renamed_from"], "dimension-0")
        self.assertFalse(any(item["dimension_id"] == "dimension-0" and item["change"] == "retired" for item in third["profile"]["distillation_growth"]["dimension_changes"]))

    def test_world_character_mechanics_and_links_compile_into_rules(self):
        profile = self.authors.create_profile("关联蒸馏")
        value = author_profile()
        value["story_design"] = {
            "worldbuilding_mechanics": [
                {"id": "wm-1", "axis": "worldbuilding_mechanics", "label": "机制代价", "finding": "能力使用付代价",
                 "trigger": "能力出场时", "writing_instruction": "每次能力使用都产生可见代价",
                 "implementation_steps": ["明确能力", "施加代价"], "allowed_variations": ["代价形式可变化"],
                 "acceptance_tests": ["能力使用后代价可见"], "avoid": "无代价能力",
                 "scope": "author_core", "confidence": 82, "stability": 78,
                 "applies_to": ["book_design"], "evidence_ids": ["E1"]},
            ],
            "character_design_mechanics": [
                {"id": "cd-1", "axis": "character_design_mechanics", "label": "人物选择", "finding": "关键选择付代价",
                 "trigger": "关键选择时", "writing_instruction": "关键选择都付出代价",
                 "implementation_steps": ["明确选择"], "allowed_variations": [], "acceptance_tests": ["选择有代价"],
                 "avoid": "无代价选择", "scope": "author_core", "confidence": 82, "stability": 78,
                 "applies_to": ["chapter_design"], "evidence_ids": ["E1"]},
            ],
        }
        value["book_architecture"] = {
            "chapter": [
                {"id": "ba-c1", "axis": "chapter_architecture", "label": "章法", "finding": "章末落变化",
                 "trigger": "章末", "writing_instruction": "章末收在局面变化",
                 "implementation_steps": ["推进局面"], "allowed_variations": [], "acceptance_tests": ["章末有变化"],
                 "avoid": "总结式结尾", "scope": "author_core", "confidence": 82, "stability": 78,
                 "applies_to": ["chapter_design"], "evidence_ids": ["E1"]},
            ],
        }
        value["style_dimensions"] = [
            {"id": "style-1", "axis": "scene_causality", "label": "因果", "finding": "因果用动作呈现",
             "trigger": "因果呈现时", "writing_instruction": "因果用动作而非解释呈现",
             "implementation_steps": ["写动作"], "allowed_variations": [], "acceptance_tests": ["因果可见"],
             "avoid": "解释因果", "scope": "author_core", "confidence": 82, "stability": 78,
             "applies_to": ["drafting"], "evidence_ids": ["E1"],
             "links": [{"dimension_id": "wm-1", "relation": "realized_via"}]},
        ]
        version = self.authors.create_version(profile["id"], value, status="published")
        self.authors.bind_book("legacy", version["id"])
        policy = self.authors.compile_policy("legacy")
        axes = {item["axis"] for item in policy["active_rules"]}
        self.assertIn("worldbuilding_mechanics", axes)
        self.assertIn("character_design_mechanics", axes)
        self.assertIn("chapter_architecture", axes)
        # 关联引用被保留。
        self.assertTrue(any(item.get("links") for item in policy["active_rules"]))
        # 世界观方法 applies_to 约束大纲设计。
        world_rule = next(item for item in policy["active_rules"] if item.get("axis") == "worldbuilding_mechanics")
        self.assertIn("book_design", world_rule["applies_to"])

    def test_distilled_deep_fields_survive_compilation(self):
        # 传递链锚点：evidence_ids / counterevidence_ids / failure_modes /
        # non_applicable_cases / transfer_verdict / links 不得在编译与契约边界
        # 被精简丢弃，否则下游规划/审查将无法引用证据、反例与失败模式。
        profile = self.authors.create_profile("深度字段传递")
        value = author_profile()
        value["style_dimensions"] = [
            {
                "id": "deep-1", "axis": "scene_causality", "label": "因果", "finding": "因果用动作呈现",
                "trigger": "因果呈现时", "writing_instruction": "因果用动作而非解释呈现",
                "implementation_steps": ["写动作"], "allowed_variations": [], "acceptance_tests": ["因果可见"],
                "avoid": "解释因果", "failure_modes": ["只写抽象总结"],
                "non_applicable_cases": ["无选择的静态资料段"], "counterevidence_ids": ["ce-1"],
                "scope": "author_core", "confidence": 82, "stability": 78,
                "applies_to": ["drafting"], "evidence_ids": ["E1"],
                "transfer_test": {"verdict": "pass", "trials": [
                    {"target_genre": "职场", "translated_example": "越权决定改变信任", "mechanism_preserved": True},
                    {"target_genre": "竞技", "translated_example": "冒险动作改变资格", "mechanism_preserved": True},
                ]},
                "links": [{"dimension_id": "deep-2", "relation": "realized_via"}],
            },
            {
                "id": "deep-2", "axis": "emotion_delivery", "label": "情绪", "finding": "情绪通过代价呈现",
                "trigger": "情绪高潮时", "writing_instruction": "情绪通过有代价的选择呈现",
                "implementation_steps": ["铺垫选择"], "allowed_variations": [], "acceptance_tests": ["情绪有代价"],
                "avoid": "空喊情绪词", "scope": "author_core", "confidence": 82, "stability": 78,
                "applies_to": ["drafting"], "evidence_ids": ["E2"],
            },
        ]
        version = self.authors.create_version(profile["id"], value, status="published")
        self.authors.bind_book("legacy", version["id"])
        policy = self.authors.compile_policy("legacy")
        rule = next(item for item in policy["active_rules"] if item.get("axis") == "scene_causality")
        self.assertEqual(rule["evidence_ids"], ["E1"])
        self.assertEqual(rule["counterevidence_ids"], ["ce-1"])
        self.assertEqual(rule["failure_modes"], ["只写抽象总结"])
        self.assertEqual(rule["non_applicable_cases"], ["无选择的静态资料段"])
        self.assertEqual(rule["transfer_verdict"], "pass")
        self.assertEqual(rule["links"], [{"dimension_id": "deep-2", "relation": "realized_via"}])
        expression = next(item for item in policy["author_book_contract"]["expression_rules"] if item.get("axis") == "scene_causality")
        self.assertEqual(expression["failure_modes"], ["只写抽象总结"])
        self.assertEqual(expression["transfer_verdict"], "pass")

    def test_statistical_targets_evaluate_draft_rhythm(self):
        # #4 锚点：统计目标区间对正文做确定性文体计量，实测值送进审查；
        # 区间是自然范围而非硬定额，未知 metric 原样上报不静默丢弃。
        targets = [{
            "metric": "sentence_median", "range": {"low": 10, "typical": 18, "high": 30},
            "tolerance": "高潮可突破", "writing_use": "检查节奏是否长期单调",
        }]
        short = evaluate_statistical_targets("短。短。短。短。", targets)
        self.assertEqual(short["evaluated"][0]["direction"], "low")
        self.assertFalse(short["evaluated"][0]["in_range"])
        long_text = "这是一句非常非常长的句子，超过了三十个非空白字符的限制，用来验证统计节奏偏离方向。"
        long_eval = evaluate_statistical_targets(long_text, targets)
        self.assertEqual(long_eval["evaluated"][0]["direction"], "high")
        self.assertFalse(long_eval["evaluated"][0]["in_range"])
        mid = evaluate_statistical_targets("这是一个中等长度的句子，大约十五个字符左右吧。", targets)
        self.assertTrue(mid["evaluated"][0]["in_range"])
        self.assertEqual(mid["evaluated"][0]["direction"], "in_range")
        unknown = evaluate_statistical_targets("任意文本", [{"metric": "不存在的指标", "range": {"low": 0, "high": 5}}])
        self.assertEqual(unknown["unknown_metrics"], ["不存在的指标"])

    def test_invalid_link_relation_is_rejected(self):
        profile = self.authors.create_profile("关联校验")
        value = author_profile()
        value["style_dimensions"] = [
            {"id": "s1", "axis": "scene_causality", "label": "因果", "finding": "f", "trigger": "t",
             "writing_instruction": "wi", "implementation_steps": ["s"], "allowed_variations": ["v"],
             "acceptance_tests": ["a"], "avoid": "x", "scope": "author_core", "confidence": 80, "stability": 80,
             "applies_to": ["drafting"], "evidence_ids": ["E1"],
             "links": [{"dimension_id": "s2", "relation": "invalid_relation"}]},
        ]
        with self.assertRaisesRegex(ValueError, "relation"):
            self.authors.create_version(profile["id"], value)

    def test_source_limits_authorization_and_path_isolation_fail_closed(self):
        profile = self.authors.create_profile("来源安全")
        markdown = self.root / "sample.md"
        markdown.write_bytes(b"\xef\xbb\xbf" + "# 第一章\n\n正文。".encode("utf-8"))

        with self.assertRaisesRegex(ValueError, "授权"):
            self.authors.add_source(profile["id"], markdown, "sample.md", rights_confirmed=False)

        source = self.authors.add_source(
            profile["id"], markdown, "../../越界.md", rights_confirmed=True,
        )
        self.assertEqual(source["original_name"], "越界.md")
        stored = (self.root / source["stored_path"]).resolve()
        self.assertIn((self.root / "authors" / profile["id"]).resolve(), stored.parents)
        self.assertIn("正文。", (self.root / source["text_path"]).read_text(encoding="utf-8"))

        oversized = self.root / "oversized.txt"
        oversized.write_bytes(b"12345")
        with patch("tomota.authors.SOURCE_FILE_LIMIT", 4):
            with self.assertRaisesRegex(ValueError, "50 MB"):
                self.authors.add_source(profile["id"], oversized, "oversized.txt", rights_confirmed=True)
        with patch("tomota.authors.AUTHOR_SOURCE_LIMIT", 1):
            with self.assertRaisesRegex(ValueError, "500 MB"):
                self.authors.add_source(profile["id"], oversized, "another.txt", rights_confirmed=True)

        bad_epub = self.root / "bad.epub"
        with zipfile.ZipFile(bad_epub, "w") as archive:
            archive.writestr("../escape.xhtml", "bad")
        source_dir = self.root / "authors" / profile["id"] / "sources"
        before = set(source_dir.iterdir())
        with self.assertRaisesRegex(ValueError, "不安全的内部路径"):
            self.authors.add_source(profile["id"], bad_epub, "bad.epub", rights_confirmed=True)
        self.assertEqual(set(source_dir.iterdir()), before)


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

        self.store.write_json(self.store.book_dir("demo") / "outlines" / "chapters.json", [{key: value for key, value in self.contract.to_dict().items() if key != "book_id"}])

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def foundation(stage="story_foundation"):
        return {
            "stage": stage,
            "world_rules": ["钟声计数不可无故重置"], "terminology": {"葬钟": "王城葬仪用钟"},
            "timeline": ["处刑后三日"],
            "characters": [{"name": "阿贝尔", "goal": "查明错杀", "fear": "记忆不可信", "boundary": "不伪造记录", "behavior_pattern": "先核对物证", "speech_rhythm": "短句追问", "avoidance": "回避家族", "pressure_method": "复述矛盾"}],
            "relationship_matrix": [{"characters": ["阿贝尔", "奥斯温"], "relation": "互不信任"}],
            "knowledge_boundaries": [{"character": "阿贝尔", "knows": ["官方只承认十二响"], "does_not_know": ["第十三响来源"]}],
            "foreshadowing": [{"id": "FB-01", "reader_knows": "读者已听见第十三响", "hidden": "钟声来源", "advance_or_payoff": "第2章推进墨迹比对"}],
            "market_position": "男频西幻悬疑，主打规则怪谈式追查",
            "reader_promise": "每一次钟声异动都会牵出错杀真相",
            "hook": "处刑后的第十三响把活人钉进死亡记录",
            "story_engine": "官方记录与亲历证据冲突→追查→牵出更早错案",
            "differentiation": "不用金手指破案，主角只能靠抄写员权限撬动制度裂缝",
            "trope_risks": ["贵族阴谋空泛化", "主线长期悬置"],
            "volume_objectives": [{
                "volume_id": "volume-1", "objective": "查明第十三响来源",
                "change": "阿贝尔从服从记录者转为追查者", "payoff": "错杀名单露出第一层",
                "next_volume_entry": "钟楼封条被撬开",
            }],
        }

    @staticmethod
    def design():
        return {
            "stage": "chapter_design",
            "scenes": [{
                "scene_id": "s1", "setting": "钟楼档案室", "objective": "核对钟数", "obstacle": "记录缺页",
                "motivation": "证明自己没有听错", "trigger": "收到封蜡信", "choice": "拆信", "consequence": "卷入错杀案",
                "next_scene_entry": "追查寄信人", "reader_question": "谁割走记录页", "value_change": "安全→可疑",
                "pressure_level": "中", "information_delta": "新增处刑台徽记", "emotion_shift": "自证→警觉",
                "scene_function": "揭示", "cut_or_merge_reason": "承担核心信件揭示，不可删并",
            }],
            "dialogue_pressure_plan": [{
                "speaker": "书记官", "goal": "让阿贝尔停手", "target": "阿贝尔", "withheld": "知道缺页原因",
                "voice_rule": "称呼官衔、句子完整、用程序压人", "pressure_function": "改变关系",
                "dialogue_budget": "两轮问答，其余信息交由缺页动作呈现",
            }],
            "character_knowledge": {"阿贝尔": {"knows": ["官方只记十二响"], "cannot_know": ["寄信人身份"]}},
            "foreshadow_actions": [{
                "id": "wax-seal", "action": "信蜡印只展示纹章，不解释主人", "reader_effect": "读者确认信件与处刑台有关",
                "reader_knows": "信封带处刑台徽记", "hidden": "寄信人身份", "advance_or_payoff": "第2章推进到墨迹比对",
            }],
            "core_reveal_closeup": "给信纸、墨迹、手部停顿和选择完整特写",
            "reader_experience_contract": {
                "inherited_obligation": "承接第十三响与官方记录冲突",
                "chapter_reward": "交付一件能继续追查的错杀物证",
                "emotional_curve": "自证焦灼→发现人为缺页→承担追查风险",
                "information_contract": "新增处刑台徽记，但不提前揭露寄信人身份",
                "non_negotiable_change": "阿贝尔从旁观记录者变成主动追查者",
                "exit_obligation": "证人现身并叫出阿贝尔名字",
                "acceptance_tests": ["正文出现拆信选择、可核验徽记和证人入场"],
            },
            "continuity_handoff": {
                "entry_state": "阿贝尔仍是服从档案程序的抄写员",
                "entry_trigger": "第十三响与档册十二响发生直接冲突",
                "retained_consequences": ["官方只承认十二响", "阿贝尔不能伪造记录"],
                "exit_state": "阿贝尔持有封蜡信并决定追查",
                "next_chapter_first_beat": "核对证人身份",
                "actual_vs_plan_check": "首章无既有正文偏差，以基础契约和真实开场为准",
            },
            "constraint_application": [{
                "constraint_id": next(iter(HARD_RULE_IDS)), "source": "hard_rule", "scene_ids": ["s1"],
                "execution": "用缺页与封蜡信交付可核验的悬疑进展",
                "acceptance_test": "读者能指出新增物证及其触发的选择", "conflict_status": "active",
                "suppressed_by": "", "conflict_reason": "", "conflict_dimensions": [],
            }],
            "chapter_questions": {
                "protagonist_want": "核对第十三响是否被记录", "who_or_what_blocks": "缺页与书记官程序",
                "situation_change": "阿贝尔从旁观记录者变成追查者", "why_continue": "寄信人身份未明",
            },
            "chapter_ending": {"ending_change": "收到错杀证据", "hook_type": "揭示", "next_first_beat": "核对证人身份"},
        }

    @staticmethod
    def passed_gate(stage, evidence=None):
        required = {
            "design_review": ["outline_contract", "canon_consistency", "knowledge_boundaries", "foreshadow_object_clarity", "scene_value_change", "chapter_four_questions", "opening_hook", "voice_signature"],
            "review_logic": ["text_design_alignment", "timeline", "counts_and_terms", "motivation", "consequence", "scene_value_change", "conflict_escalation", "choice_cost", "next_scene_entry"],
            "review_voice": ["character_consistency", "knowledge_boundaries", "dialogue_function", "voice_swap", "anti_ai", "voice_distinctiveness", "dialogue_density", "emotion_grounding"],
            "review_continuity": ["foreshadow_object", "canon_consistency", "transitions", "ending", "next_chapter", "pacing_curve", "ending_pull", "foreshadow_density"],
            "cold_review": ["who", "does_what", "why", "referents", "situation_change", "reason_to_continue"],
        }
        quote = evidence or ("承担核心信件揭示，不可删并" if stage == "design_review" else "阿贝尔数到第十三响时，抄写笔停在纸上。")
        value = {
            "schema_version": "review-artifact-v2", "stage": stage, "gate": stage, "passed": True,
            "summary": "全部固定检查项均有当前受审原文证据支持",
            "evidence": [{"evidence_id": "E1", "location": "受审原文", "quote": quote}],
            "checks": [{"name": name, "passed": True, "evidence_refs": ["E1"]} for name in required[stage]],
            "findings": [], "revision_brief": [],
        }
        value["quality_scorecard"] = {name: {"score": 5, "evidence_refs": ["E1"]} for name in [
            "scene_change", "emotional_pressure", "character_voice", "information_clarity", "ending_pull",
        ]}
        if stage == "cold_review":
            value["reader_answers"] = {
                "who": "阿贝尔", "does_what": "拆信并追查", "why": "官方记录与亲耳钟声冲突",
                "referents": "信指封蜡信，钟指王城葬钟", "situation_change": "从抄写员变成追查者",
                "reason_to_continue": "寄信人身份和处刑台徽记仍未揭开",
            }
        return value

    def advance_to_logic_review(self, engine, run_id):
        engine.submit(run_id, self.foundation())
        engine.submit(run_id, self.design())
        engine.submit(run_id, self.passed_gate("design_review"))
        content = "阿贝尔数到第十三响时，抄写笔停在纸上。\n\n档册只记着十二次。他翻出缺页的接缝，确认有人割走一张纸。\n\n封蜡信压在门缝下，印纹与处刑台的徽记相同。他拆开信，逐字读完，决定去查寄信人。\n\n门外的脚步停住，一个证人叫出了他的名字。"
        engine.submit(run_id, {"stage": "draft", "content": content})
        return content

    def advance_to_canon_update(self, engine, run_id):
        content = self.advance_to_logic_review(engine, run_id)
        for stage in ["review_logic", "review_voice", "review_continuity", "cold_review"]:
            engine.submit(run_id, self.passed_gate(stage))
        return content

    @staticmethod
    def revision_brief(quote="他决定去查", gate="review_logic"):
        return [{
            "location": "第2段", "quote": quote, "violated_rule": "行动必须有触发",
            "repair_direction": "补出信中错杀证据与下一步可查对象",
            "protected_content": "保留第十三响与记录缺页的对照",
            "review_gate_to_rerun": gate,
        }]

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
            "open_threads": ["寄信人身份"], "foreshadowing": ["处刑台徽记"], "state_facts": [], "evidence": [evidence],
        })
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "approved")
        self.assertTrue(self.store.is_release_ready("demo", 1))
        self.assertEqual(self.store.load_canon("demo")["evidence"], [evidence])
        self.assertEqual(self.store.load_canon("demo")["facts"][0]["certainty"], "confirmed")
        trace = result["traceability"]
        self.assertEqual(trace["reader_promise"], self.foundation()["reader_promise"])
        self.assertEqual(trace["chapters"]["1"]["scene_card"]["status"], "accepted")
        self.assertEqual(trace["chapters"]["1"]["body"]["status"], "accepted")
        self.assertEqual(trace["chapters"]["1"]["canon_delta"]["evidence"], [evidence])
        self.assertEqual(trace["chapters"]["1"]["next_chapter_entry"], self.contract.next_first_beat)

    def test_chapter_design_receives_previous_real_tail_and_executable_contract_schema(self):
        previous_text = "旧钟停下后，阿贝尔把染血的封蜡信压在档册上。\n\n门外的人叫出了他的真名。"
        strict_approve(self.store, self.contract, previous_text)
        second = ChapterContract(
            "demo", 2, "门外证人", "核验证人身份", "证人拒绝进门", "发现证词与档册矛盾",
            next_first_beat="追查证词来源", target_word_count=80,
        )
        self.store.save_chapter(second, status="planned")
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [2])
        engine.submit(run.run_id, self.foundation())
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn("门外的人叫出了他的真名", prompt)
        self.assertIn('"previous_chapter_handoff"', prompt)
        self.assertIn('"reader_experience_contract"', prompt)
        self.assertIn('"continuity_handoff"', prompt)
        self.assertIn('"constraint_application"', prompt)
        self.assertIn('"bookwide_prose_guard"', prompt)

    def test_whole_book_fingerprint_detects_reused_opening_shape_without_becoming_a_ban_list(self):
        repeated = "雨水沿着钟楼的黑色石缝往下淌，阿贝尔在门前停住。"
        prior = [
            (1, repeated + "\n\n他检查第一封信。"),
            (2, repeated + "\n\n他检查第二本档册。"),
            (3, repeated + "\n\n他检查第三枚封蜡。"),
        ]
        result = compare_current_to_corpus(repeated + "\n\n他再次抬手。", prior)
        self.assertEqual(result["chapters_analyzed"], [1, 2, 3])
        self.assertIn("不是禁词表", result["application_rule"])
        self.assertIn("repeated_opening_template", [item["code"] for item in result["blockers"]])

    def test_voice_gate_forces_full_revision_when_current_opening_repeats_bookwide_template(self):
        repeated = "雨水沿着钟楼的黑色石缝往下淌，阿贝尔在门前停住。"
        for number in (1, 2, 3):
            contract = ChapterContract(
                "demo", number, f"第{number}章", "调查钟声", "档案受阻", "得到一件新物证",
                next_first_beat="继续核验", target_word_count=40,
            )
            strict_approve(self.store, contract, repeated + f"\n\n他检查了第{number}件证物。")
        current = ChapterContract(
            "demo", 4, "第四章", "核验新物证", "守卫阻拦", "拿到原始卷宗",
            next_first_beat="比对卷宗", target_word_count=40,
        )
        self.store.save_chapter(current, status="planned")
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [4])
        engine.submit(run.run_id, self.foundation())
        engine.submit(run.run_id, self.design())
        engine.submit(run.run_id, self.passed_gate("design_review"))
        body = repeated + "\n\n他绕过守卫，拿到原始卷宗并当场拆开。"
        engine.submit(run.run_id, {"stage": "draft", "content": body})
        engine.submit(run.run_id, self.passed_gate("review_logic", evidence=repeated))
        result = engine.submit(run.run_id, self.passed_gate("review_voice", evidence=repeated))
        self.assertEqual(result["current_stage"], "revise_voice")
        review = json.loads((self.store.book_dir("demo") / "workflow" / run.run_id / "chapter-0004" / "review_voice.json").read_text(encoding="utf-8"))
        self.assertIn("全书文风重复", [item["category"] for item in review["findings"]])
        self.assertTrue(review["revision_brief"])

    def test_confirmed_revision_pair_is_bounded_and_preserves_author_direction(self):
        summary = summarize_confirmed_revision(
            "他感到十分震惊。\n\n他决定继续调查。",
            "杯沿在指间裂开。\n\n他把碎瓷推到书记官面前：‘把原卷拿来。’",
        )
        self.assertTrue(summary["changed_pairs"])
        self.assertLessEqual(len(summary["changed_pairs"]), 6)
        self.assertIn("不覆盖 Canon", summary["application_rule"])

    def test_stage_action_v2_rejects_stale_inputs_without_retrying(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        action = engine.next_action(run.run_id)
        self.assertEqual(action["schema_version"], "stage-action-v2")
        self.assertTrue(action["action_id"].startswith("action-"))
        self.assertEqual(action["output_schema"]["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(action["output_schema"]["properties"]["stage"]["const"], "story_foundation")
        master = self.store.load_master_outline("demo")
        master["core_conflict"] = "任务签发后被人工修改"
        self.store.save_master_outline("demo", master)
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, self.foundation(), action_id=action["action_id"])
        self.assertEqual(raised.exception.code, "stale_inputs")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(engine.status(run.run_id)["current_stage"], "story_foundation")

    def test_review_stage_action_exposes_the_exact_check_contract_to_the_generator(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        engine.submit(run.run_id, self.design())
        action = engine.next_action(run.run_id)
        expected = [item["name"] for item in self.passed_gate("design_review")["checks"]]
        checks_schema = action["output_schema"]["properties"]["checks"]
        self.assertEqual(checks_schema["minItems"], len(expected))
        self.assertEqual(checks_schema["maxItems"], len(expected))
        self.assertFalse(checks_schema["items"])
        self.assertEqual(
            [item["properties"]["name"]["const"] for item in checks_schema["prefixItems"]],
            expected,
        )
        self.assertEqual(action["required_submission"]["required_check_ids"], expected)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        for name in expected:
            self.assertIn(f"`{name}`", prompt)

        aliases = self.passed_gate("design_review")
        aliases["checks"] = [{"name": "contract_alignment", "passed": True, "evidence_refs": ["E1"]}]
        with self.assertRaises(WorkflowError) as rejected:
            engine.submit(run.run_id, aliases)
        self.assertEqual(rejected.exception.code, "artifact_schema_invalid")
        self.assertEqual(rejected.exception.field_path, "checks")
        self.assertEqual(engine.status(run.run_id)["revision_round"], 0)

    def test_canon_allows_unchanged_categories_without_inventing_deltas(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_canon_update(engine, run.run_id)
        result = engine.submit(run.run_id, {
            "stage": "canon_update", "facts": [], "character_states": [],
            "relationships": [], "open_threads": [], "foreshadowing": [], "state_facts": [],
            "evidence": ["封蜡信压在门缝下"],
        })
        self.assertEqual(result["status"], "completed")
        canon = self.store.load_canon("demo")
        for field in ["facts", "character_states", "relationships", "open_threads", "foreshadowing"]:
            self.assertEqual(canon[field], [])

    def test_state_fact_supersede_and_goal_shift_are_recorded(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.store.save_canon("demo", 0, {"state_facts": [
            {"subject": "阿贝尔", "predicate": "alive", "value": "alive"},
            {"subject": "阿贝尔", "predicate": "goal", "value": "核对钟声来源"},
        ]})
        self.advance_to_canon_update(engine, run.run_id)
        result = engine.submit(run.run_id, {
            "stage": "canon_update", "facts": [], "character_states": [], "relationships": [],
            "open_threads": [], "foreshadowing": [], "state_facts": [
                {"subject": "阿贝尔", "predicate": "goal", "value": "追查寄信人"},
                {"subject": "阿贝尔", "predicate": "location", "value": "档案室"},
            ],
            "evidence": ["封蜡信压在门缝下"],
        })
        self.assertEqual(result["status"], "completed")
        canon = self.store.load_canon("demo")
        by_key = {(item["subject"], item["predicate"]): item["value"] for item in canon["state_facts"]}
        # supersede：goal 被新值顶替。
        self.assertEqual(by_key[("阿贝尔", "goal")], "追查寄信人")
        self.assertEqual(by_key[("阿贝尔", "location")], "档案室")
        # 目标突变被记为可追溯的软提示。
        codes = [item["code"] for item in canon.get("state_regression_notes", [])]
        self.assertIn("goal_shift", codes)

    def test_alive_state_regression_blocks_canon_update(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.store.save_canon("demo", 0, {"state_facts": [
            {"subject": "阿贝尔", "predicate": "alive", "value": "dead"},
        ]})
        self.advance_to_canon_update(engine, run.run_id)
        result = engine.submit(run.run_id, {
            "stage": "canon_update", "facts": [], "character_states": [], "relationships": [],
            "open_threads": [], "foreshadowing": [], "state_facts": [
                {"subject": "阿贝尔", "predicate": "alive", "value": "alive"},
            ],
            "evidence": ["封蜡信压在门缝下"],
        })
        self.assertEqual(result["current_stage"], "revise_continuity")
        validation = json.loads((self.store.book_dir("demo") / "workflow" / run.run_id / "chapter-0001" / "final_validation.json").read_text(encoding="utf-8"))
        self.assertFalse(validation["passed"])
        self.assertTrue(any("alive" in item for item in validation["evidence"]))
        # 回归被拦下时，canon 不应被写坏。
        self.assertEqual(self.store.load_canon("demo")["state_facts"][0]["value"], "dead")

    def test_invalid_state_fact_predicate_is_rejected(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_canon_update(engine, run.run_id)
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, {
                "stage": "canon_update", "facts": [], "character_states": [], "relationships": [],
                "open_threads": [], "foreshadowing": [], "state_facts": [
                    {"subject": "阿贝尔", "predicate": "境界", "value": "元婴"},
                ],
                "evidence": ["封蜡信压在门缝下"],
            })
        self.assertEqual(raised.exception.code, "content_generation_invalid")
        self.assertIn("state_facts[0]", raised.exception.field_path)

    def test_canon_prompt_injects_fact_predicate_contract(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_canon_update(engine, run.run_id)
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn("确定性事实谓词契约", prompt)
        self.assertIn('"state_facts"', prompt)
        self.assertIn("supersede", prompt)
        self.assertIn("append", prompt)

    def test_author_world_mechanics_constraint_enforced_in_generation(self):
        # 绑定带世界观方法的作者版本。
        authors = AuthorService(self.root)
        profile = authors.create_profile("世界观约束作者")
        value = author_profile()
        value["story_design"] = {
            "worldbuilding_mechanics": [
                {"id": "wm-1", "axis": "worldbuilding_mechanics", "label": "机制代价",
                 "finding": "能力使用付代价", "trigger": "能力出场时",
                 "writing_instruction": "每次能力使用都产生可见代价",
                 "implementation_steps": ["明确能力", "施加代价"],
                 "allowed_variations": ["代价形式可变化"],
                 "acceptance_tests": ["能力使用后代价可见"],
                 "avoid": "无代价能力", "scope": "author_core",
                 "confidence": 82, "stability": 78,
                 "applies_to": ["book_design"], "evidence_ids": ["E1"]},
            ],
        }
        version = authors.create_version(profile["id"], value, status="published")
        authors.bind_book("demo", version["id"])

        # 1) 世界观方法进入 design_rules（规划对话室 selectAuthorPolicyPlanningInputs 的输入）。
        policy = authors.compile_policy("demo")
        design_rules = policy["author_book_contract"]["design_rules"]
        self.assertTrue(any(item.get("axis") == "worldbuilding_mechanics" for item in design_rules))

        # 2) story_foundation 的生成 prompt 含世界观约束。
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn("每次能力使用都产生可见代价", prompt)

        # 3) 提交 story_foundation 但未映射世界观 must 规则 → 被拒（约束在验收时强制）。
        foundation = self.foundation()
        foundation["constraint_application"] = []
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, foundation)
        self.assertEqual(raised.exception.code, "artifact_schema_invalid")

    def test_arc_review_schema_contains_every_field_the_submitter_validates(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        run.current_stage = "arc_review"
        run.completed_chapters = [1]
        self.store.save_workflow_run(run)
        action = engine.next_action(run.run_id)
        required = set(action["output_schema"]["required"])
        self.assertTrue({
            "conflict_escalation", "mainline_progress", "foreshadow_backlog",
            "ending_hook_repetition", "low_change_scenes", "reader_promise_fulfillment",
            "next_batch_adjustments", "affected_chapters", "preserve", "changes", "risks",
        }.issubset(required))
        context = engine._stage_context(run)
        self.assertIn("chapters", context)
        self.assertIn("body", context["chapters"][0])

    def test_failed_arc_review_automatically_starts_bounded_scope_rework(self):
        bodies = {}
        contracts = []
        for number in (1, 2, 3):
            contract = self.contract if number == 1 else ChapterContract(
                "demo", number, f"第{number}章", "继续追查", "证据被封锁", "得到新的代价",
                chapter_hook="有人敲门", next_first_beat="核验来客身份", target_word_count=10,
            )
            body = f"第{number}章的有效正文证据。\n\n阿贝尔承担了第{number}次选择的代价。"
            strict_approve(self.store, contract, body)
            contracts.append(contract)
            bodies[number] = body
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1, 2, 3])
        run.current_stage = "arc_review"
        run.current_chapter = 3
        run.completed_chapters = [1, 2, 3]
        self.store.save_workflow_run(run)
        action = engine.next_action(run.run_id)
        result = engine.submit(run.run_id, {
            "stage": "arc_review", "passed": False,
            "story_engine": "第三章重复第二章的取证循环",
            "pacing": "连续两章用相同阻拦方式，压力没有升级",
            "character_change": "人物承担代价但选择方式重复",
            "foreshadow_density": "伏笔推进存在，但没有新增反证",
            "pattern_repetition": "第二、三章均为受阻后得到线索",
            "conflict_escalation": "代价只增加次数，没有改变性质",
            "mainline_progress": "主线前进，但第三章场景结构需要重组",
            "foreshadow_backlog": [], "ending_hook_repetition": ["第2、3章均以敲门结束"],
            "low_change_scenes": ["第3章取证场景"],
            "reader_promise_fulfillment": "追查承诺仍在，解决方式趋同",
            "next_batch_adjustments": ["让第3章由主动选择造成不可逆后果"],
            "affected_chapters": [3], "preserve": ["前两章已确认事实与人物知识边界"],
            "changes": ["从第3章场景设计开始改写冲突升级方式"],
            "risks": ["不得改变第1、2章 Canon"],
            "evidence": ["阿贝尔承担了第3次选择的代价。"],
        }, action_id=action["action_id"])
        self.assertEqual(result["automatic_resolution"], "arc_scope_rework")
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["current_stage"], "chapter_design")
        self.assertEqual(engine.status(run.run_id)["status"], "superseded")
        marker = self.store.book_dir("demo") / "workflow" / result["redirect_run_id"] / "automatic-arc-repair.json"
        self.assertEqual(json.loads(marker.read_text(encoding="utf-8"))["round"], 1)

    def test_candidate_override_supersedes_lineage_and_invalidates_downstream_canon(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        action = engine.next_action(run.run_id)
        first = self.foundation()
        engine.submit(run.run_id, first, action_id=action["action_id"])
        self.store.save_chapter(self.contract, status="approved", content="原文")
        self.store.save_canon("demo", 1, {"facts": ["旧候选事实"], "evidence": ["原文"]})

        alternate = self.foundation()
        alternate["reader_promise"] = "改选后以人物选择的代价兑现核心悬念"
        alternate["differentiation"] = "把钟声规则落实为每次选择都会失去一条可验证证词"
        result = engine.supersede_with_candidate(
            run.run_id, alternate, source_stage="story_foundation",
        )

        replacement_id = result["candidate_override"]["replacement_run_id"]
        self.assertNotEqual(replacement_id, run.run_id)
        self.assertEqual(engine.status(run.run_id)["status"], "superseded")
        self.assertEqual(engine.status(replacement_id)["current_stage"], "chapter_design")
        self.assertTrue(result["candidate_override"]["old_artifacts_preserved"])
        self.assertEqual(self.store.load_canon("demo"), {})
        self.assertEqual(self.store.get_chapter("demo", 1)["status"], "modified_after_review")
        invalidation = self.root / "books" / "demo" / "workflow" / replacement_id / "dependency-invalidation.json"
        self.assertTrue(invalidation.is_file())

    def test_empty_review_evidence_is_rejected(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        engine.submit(run.run_id, self.design())
        gate = self.passed_gate("design_review")
        gate["evidence"] = []
        with self.assertRaisesRegex(WorkflowError, "evidence"):
            engine.submit(run.run_id, gate)

    def test_fabricated_review_evidence_is_rejected(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_logic_review(engine, run.run_id)
        gate = self.passed_gate("review_logic", "这段证据并没有出现在正文里。")
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, gate)
        self.assertEqual(raised.exception.code, "evidence_not_grounded")
        status = engine.status(run.run_id)
        self.assertEqual(status["current_stage"], "review_logic")
        self.assertEqual(status["revision_round"], 0)

    def test_fabricated_canon_evidence_is_a_retryable_technical_error(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_canon_update(engine, run.run_id)
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, {
                "stage": "canon_update",
                "facts": ["档册记载钟响次数"],
                "character_states": ["主角开始怀疑档册"],
                "relationships": ["主角与守钟人互不信任"],
                "open_threads": ["第十三响来源"],
                "foreshadowing": ["残缺档册"], "state_facts": [],
                "evidence": ["这是一段并未出现在正文中的概括性证据。"],
            })
        self.assertEqual(raised.exception.code, "evidence_not_grounded")
        self.assertEqual(raised.exception.failure_class, "evidence")
        self.assertEqual(raised.exception.field_path, "evidence[0]")
        self.assertTrue(raised.exception.retryable)
        status = engine.status(run.run_id)
        self.assertEqual(status["current_stage"], "canon_update")
        self.assertEqual(status["revision_round"], 0)

    def test_quality_scorecard_requires_current_text_evidence(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_logic_review(engine, run.run_id)
        gate = self.passed_gate("review_logic")
        gate["quality_scorecard"]["character_voice"].pop("evidence_refs")
        gate["quality_scorecard"]["character_voice"]["evidence"] = "这段评分证据是编造的。"
        with self.assertRaisesRegex(WorkflowError, "character_voice"):
            engine.submit(run.run_id, gate)

    def test_actual_review_logic_contract_regressions_do_not_consume_creative_revisions(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_logic_review(engine, run.run_id)

        wrong_brief = self.passed_gate("review_logic")
        wrong_brief.pop("revision_brief")
        wrong_brief["revision_brief_required_if_failed"] = False
        with self.assertRaises(WorkflowError) as missing:
            engine.submit(run.run_id, wrong_brief)
        self.assertEqual(missing.exception.code, "artifact_schema_invalid")
        self.assertEqual(missing.exception.field_path, "revision_brief")

        string_score = self.passed_gate("review_logic")
        string_score["quality_scorecard"]["scene_change"]["score"] = "1—5"
        with self.assertRaises(WorkflowError) as invalid_score:
            engine.submit(run.run_id, string_score)
        self.assertEqual(invalid_score.exception.code, "artifact_schema_invalid")
        self.assertEqual(invalid_score.exception.field_path, "quality_scorecard.scene_change.score")

        status = engine.status(run.run_id)
        self.assertEqual(status["current_stage"], "review_logic")
        self.assertEqual(status["revision_round"], 0)

    def test_failed_gate_requires_structured_revision_brief(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        self.advance_to_logic_review(engine, run.run_id)
        gate = self.passed_gate("review_logic")
        gate["passed"] = False
        gate["findings"] = [{
            "finding_id": "logic-1", "severity": "blocker", "category": "场景变化",
            "location": "第2段", "quote": "档册只记着十二次。", "diagnosis": "行动没有形成可见后果", "violated_rule": "场景必须有价值变化",
            "repair_requirement": "补出行动后果", "status": "open",
        }]
        with self.assertRaisesRegex(WorkflowError, "RevisionBrief"):
            engine.submit(run.run_id, gate)

    def test_final_body_validation_routes_to_logic_and_includes_actual_failure(self):
        self.contract.target_word_count = 1000
        self.store.save_outline_chapters("demo", [self.contract.to_dict()])
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        content = self.advance_to_logic_review(engine, run.run_id)
        for stage in ["review_logic", "review_voice", "review_continuity", "cold_review"]:
            engine.submit(run.run_id, self.passed_gate(stage))
        result = engine.submit(run.run_id, {
            "stage": "canon_update", "facts": ["阿贝尔听见第十三响"],
            "character_states": ["阿贝尔决定追查"], "relationships": ["证人主动接触阿贝尔"],
            "open_threads": ["寄信人身份"], "foreshadowing": ["处刑台徽记"], "state_facts": [],
            "evidence": ["封蜡信压在门缝下"],
        })
        self.assertEqual(result["current_stage"], "revise_logic")
        action = engine.next_action(run.run_id)
        prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
        self.assertIn('"repair_source": "final_validation"', prompt)
        self.assertIn("正文长度低于目标字数", prompt)
        self.assertIn(content.splitlines()[0], prompt)
        self.assertIn("repair_receipts", action["output_schema"]["required"])
        final_targets = engine._polish_ledger(engine._run(run.run_id))["targets"]
        self.assertTrue(any("正文长度低于目标字数" in target["requirement"] for target in final_targets))
        self.assertTrue(all(target["gate"] == "review_logic" for target in final_targets))

    def test_sixth_failed_review_blocks_after_five_revisions_and_keeps_two_drafts(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1], max_revisions=5)
        content = self.advance_to_logic_review(engine, run.run_id)
        finding = {"finding_id": "motivation", "severity": "blocker", "category": "行动动机", "location": "第2段", "quote": "决定去查寄信人", "diagnosis": "线索不足", "violated_rule": "行动必须有触发", "repair_requirement": "补出物证来源", "status": "open"}
        for index in range(6):
            failed = self.passed_gate("review_logic")
            failed.update({"passed": False, "findings": [finding], "revision_brief": self.revision_brief()})
            if index:
                failed["repair_verification"] = []
            status = engine.submit(run.run_id, failed)
            if index < 5:
                self.assertEqual(status["current_stage"], "revise_logic")
                updated = content + f"\n\n返工线索 {index + 1}。"
                repair_receipts = [{
                    "target_id": target["target_id"], "mode": "repaired", "before_quote": content,
                    "after_quote": updated, "explanation": "补充线索供重新审查；本测试审查仍判定不足",
                    "preservation": {"before_quote": "档册只记着十二次。", "after_quote": "档册只记着十二次。",
                                     "explanation": "保留钟声记录矛盾"},
                } for target in engine._polish_ledger(engine._run(run.run_id))["targets"]]
                engine.submit(run.run_id, {"stage": "revise_logic", "content": updated, "repair_receipts": repair_receipts})
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

    def test_chapter_design_cannot_omit_or_invent_current_foundation_rule_mappings(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        store_contract = BookPlanningTests.foundation_contract()
        saved = self.store.save_foundation_contract("demo", store_contract)
        design = self.design()
        design["constraint_application"] = [{
            "constraint_id": "constraint-0000000000000000", "source": "foundation", "scene_ids": ["s1"],
            "execution": "伪造一条看似完成的映射", "acceptance_test": "无法与真实规则对证", "conflict_status": "active",
            "suppressed_by": "", "conflict_reason": "", "conflict_dimensions": [],
        }]
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, design)
        self.assertEqual(raised.exception.code, "artifact_schema_invalid")
        self.assertIn("不存在或不适用于本章", str(raised.exception))
        self.assertTrue(saved["active_constraints"])

    def test_chapter_design_rejects_fabricated_canon_path(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        design = self.design()
        design["constraint_application"] = [{
            "constraint_id": "facts.999", "source": "canon", "scene_ids": ["s1"],
            "execution": "伪造不存在的 Canon 事实", "acceptance_test": "无法对证",
            "conflict_status": "active", "suppressed_by": "", "conflict_reason": "", "conflict_dimensions": [],
        }]
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, design)
        self.assertEqual(raised.exception.code, "artifact_schema_invalid")
        self.assertIn("不存在或为空的 Canon 事实", str(raised.exception))

    def test_chapter_design_rejects_empty_or_self_referential_suppression_authority(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        saved = self.store.save_foundation_contract("demo", BookPlanningTests.foundation_contract())
        rule_id = str(saved["active_constraints"][0]["constraint_id"])

        design = self.design()
        design["constraint_application"] = [{
            "constraint_id": rule_id, "source": "foundation", "scene_ids": ["s1"],
            "execution": "声称由空 Canon 压制", "acceptance_test": "必须能定位真实上位事实",
            "conflict_status": "suppressed_by_higher_rule", "suppressed_by": "facts",
            "conflict_reason": "声称 Canon 冲突但当前 facts 为空",
            "conflict_dimensions": [{"dimension": "世界机制", "suppressed_evidence": "facts", "suppressor_evidence": "facts"}],
        }]
        with self.assertRaises(WorkflowError) as empty_canon:
            engine.submit(run.run_id, design)
        self.assertIn("不存在或为空的上位规则", str(empty_canon.exception))

        design["constraint_application"][0]["suppressed_by"] = rule_id
        design["constraint_application"][0]["conflict_reason"] = "让规则声称被自身压制"
        with self.assertRaises(WorkflowError) as self_suppression:
            engine.submit(run.run_id, design)
        self.assertIn("不能自我压制", str(self_suppression.exception))

    def test_suppressed_by_requires_structured_conflict_dimensions(self):
        engine = WorkflowEngine(self.root, skill_root=SKILL_ROOT)
        run = engine.start("demo", [1])
        engine.submit(run.run_id, self.foundation())
        saved = self.store.save_foundation_contract("demo", BookPlanningTests.foundation_contract())
        rule_id = str(saved["active_constraints"][0]["constraint_id"])
        other_id = str(saved["active_constraints"][1]["constraint_id"])
        design = self.design()
        design["constraint_application"] = [{
            "constraint_id": rule_id, "source": "foundation", "scene_ids": ["s1"],
            "execution": "声称被上位规则压制", "acceptance_test": "必须提供结构化冲突维度",
            "conflict_status": "suppressed_by_higher_rule", "suppressed_by": other_id,
            "conflict_reason": "冲突说明",
        }]
        with self.assertRaises(WorkflowError) as raised:
            engine.submit(run.run_id, design)
        self.assertIn("conflict_dimensions", str(raised.exception))


class BookPlanningTests(unittest.TestCase):
    @staticmethod
    def foundation_contract():
        return {
            "source_job_id": "planning-job-1",
            "constraints": {
                "reader_promise": "读者能持续获得可核验的悬疑推进",
                "protagonist_goal": "找回失落记忆并保护同伴",
                "stakes_and_cost": "失败会失去同伴，成功也会永久损失部分记忆",
                "causal_chain": ["收留少女→遭到追捕→主动调查"],
                "character_constraints": ["主角谨慎，不会无证据相信陌生人"],
                "knowledge_boundaries": ["主角开篇不知道少女身份"],
                "world_rules": ["能力使用必须支付可见代价"],
                "relationship_arc": "陌生到有限信任",
                "foreshadowing_plan": ["黑伞坐标必须在第一卷兑现"],
                "pacing_rules": ["每章发生价值变化并把后果交给下一章"],
                "voice_and_platform_rules": ["中文自然，纯文字场景独立成立"],
                "forbidden_shortcuts": ["禁止巧合解围和机械降智"],
                "workflow_acceptance": ["正文与章纲、Canon和知识边界一致"],
                "unresolved_decisions": ["结局暂不锁定"],
            },
            "rationale": ["因果与人物代价已经逐项对证"],
            "warnings": [],
            "applied_fields": ["title", "outline", "chapters"],
        }

    def test_new_book_foundation_contract_is_hashed_persisted_and_injected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "规划契约", {})
            saved = store.save_foundation_contract("serial", self.foundation_contract())
            self.assertEqual(len(saved["contract_hash"]), 64)
            active = store.load_foundation_contract("serial")["active_constraints"]
            self.assertTrue(any(item["category"] == "reader_promise" and item["rule"] == "读者能持续获得可核验的悬疑推进" for item in active))
            contract = ChapterContract("serial", 1, "第一章", "收留少女", "追兵到来", "决定合作", next_first_beat="处理追兵后果")
            store.save_outline_chapters("serial", [contract.to_dict()])
            engine = WorkflowEngine(root, skill_root=SKILL_ROOT)
            run = engine.start("serial", [1])
            action = engine.next_action(run.run_id)
            prompt = Path(action["prompt_path"]).read_text(encoding="utf-8")
            self.assertIn("禁止巧合解围和机械降智", prompt)
            self.assertIn("books/serial/outlines/foundation-contract.json", action["input_files"])

    def test_author_application_persists_across_foundation_contract(self):
        # #6 锚点：规划阶段已决策的作者规则落地映射必须随 Connector 契约跨阶段
        # 持久化，story_foundation/chapter_design 据此延续转译而非重复推倒。
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "规划契约", {})
            foundation = self.foundation_contract()
            foundation["author_application"] = {
                "adopted": [{"rule_id": "author-rule-abc", "function": "因果转译", "realization": "把选择兑现为后果链", "proposal_paths": ["premise"], "surface_copy_avoided": "排除来源专名与母题"}],
                "deferred": [{"rule_id": "author-rule-def", "reason": "与用户题材冲突"}],
            }
            store.save_foundation_contract("serial", foundation)
            loaded = store.load_foundation_contract("serial")
            self.assertEqual(loaded["author_application"]["adopted"][0]["rule_id"], "author-rule-abc")
            self.assertEqual(loaded["author_application"]["deferred"][0]["reason"], "与用户题材冲突")
            effective = store.effective_foundation_contract("serial")
            self.assertEqual(effective["author_application"]["adopted"][0]["realization"], "把选择兑现为后果链")

    def test_existing_book_planning_delta_replaces_active_rule_and_filters_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "约束增量", {})
            initial = store.save_foundation_contract("serial", self.foundation_contract())
            old = next(item for item in initial["active_constraints"] if item["category"] == "pacing_rules")
            chapter1 = ChapterContract("serial", 1, "第一章", "目标", "阻碍", "变化", volume_id="volume-1", next_first_beat="下一拍")
            chapter2 = ChapterContract("serial", 2, "第二章", "目标", "阻碍", "变化", volume_id="volume-2", next_first_beat="下一拍")
            store.save_outline_chapters("serial", [chapter1.to_dict(), chapter2.to_dict()])
            updated = store.apply_foundation_contract_delta("serial", {
                "base_contract_hash": initial["contract_hash"],
                "source_job_id": "planning-volume-1",
                "source_job_ids": ["planning-volume-1"],
                "source_scope": "volume",
                "changes": [
                    {"operation": "update", "constraint_id": old["constraint_id"], "scope_type": "book", "scope_id": "book", "category": "pacing_rules", "rule": "每章选择必须留下不可逆后果", "priority": "must", "reason": "替换旧节奏要求"},
                    {"operation": "add", "constraint_id": "", "scope_type": "volume", "scope_id": "volume-1", "category": "volume_reveal", "rule": "本卷只兑现黑伞来源，不揭示幕后首脑", "priority": "must", "reason": "锁定本卷揭示边界"},
                ],
                "rationale": ["规划已改变节奏与揭示边界"], "warnings": [],
            })
            self.assertNotEqual(updated["contract_hash"], initial["contract_hash"])
            current = store.load_foundation_contract("serial")
            rules = [item["rule"] for item in current["active_constraints"]]
            self.assertNotIn("每章发生价值变化并把后果交给下一章", rules)
            self.assertIn("每章选择必须留下不可逆后果", rules)
            self.assertTrue((store.book_dir("serial") / "audit" / f"planning-contract-{initial['contract_hash'][:16]}.json").is_file())
            effective1 = store.effective_foundation_contract("serial", chapter_number=1)
            effective2 = store.effective_foundation_contract("serial", chapter_number=2)
            self.assertTrue(any(item["category"] == "volume_reveal" for item in effective1["active_constraints"]))
            self.assertFalse(any(item["category"] == "volume_reveal" for item in effective2["active_constraints"]))
            with self.assertRaisesRegex(ValueError, "stale foundation contract"):
                store.apply_foundation_contract_delta("serial", {"base_contract_hash": initial["contract_hash"], "changes": []})

    def test_full_rebuild_keeps_title_cover_and_author_binding_but_clears_derivatives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "只留书名封面", {"synopsis": "旧简介", "genre": "旧题材"})
            binding_before = AuthorService(root).get_binding("serial")
            cover = store.book_dir("serial") / "assets" / "cover.png"
            cover.write_bytes(b"cover-bytes")
            store.save_foundation_contract("serial", self.foundation_contract())
            chapter = ChapterContract("serial", 1, "旧章", "目标", "阻碍", "变化", next_first_beat="下一拍")
            store.save_outline_chapters("serial", [chapter.to_dict()])
            store.save_chapter(chapter, content="旧正文")
            store.append_event("serial", 1, "old_sensitive_feedback", {"feedback": "旧正文必须全部重写"})
            store.append_event("other-book", 1, "keep_other_book", {"feedback": "其他作品历史"})
            old_trash = store.book_dir("serial") / ".trash" / "legacy-rebuild" / "chapter-0001.md"
            old_trash.parent.mkdir(parents=True, exist_ok=True)
            old_trash.write_text("更早的旧正文与旧 Prompt", encoding="utf-8")
            preview = store.preview_rebuild("serial", "book", "book")
            self.assertIn("assets/ 中的封面", preview["retained"])
            self.assertTrue(preview["permanent"])
            result = store.apply_rebuild("serial", "book", "book", preview["confirmation_phrase"])
            self.assertFalse(result["recoverable"])
            self.assertEqual(store.get_book("serial")["title"], "只留书名封面")
            self.assertEqual(store.get_book("serial")["metadata"]["synopsis"], "")
            self.assertEqual(store.list_chapters("serial"), [])
            self.assertFalse((store.book_dir("serial") / "outlines" / "foundation-contract.json").exists())
            self.assertEqual(cover.read_bytes(), b"cover-bytes")
            self.assertEqual(AuthorService(root).get_binding("serial")["version_id"], binding_before["version_id"])
            self.assertEqual(list((store.book_dir("serial") / ".trash").rglob("*")), [])
            self.assertFalse((root / ".rebuild-staging").exists())
            surviving_text = "\n".join(
                path.read_text(encoding="utf-8", errors="ignore")
                for path in store.book_dir("serial").rglob("*") if path.is_file() and path != cover
            )
            self.assertNotIn("旧正文", surviving_text)
            self.assertNotIn("旧 Prompt", surviving_text)
            self.assertNotIn("旧简介", surviving_text)
            audit_text = (root / "audit" / "events.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("旧正文必须全部重写", audit_text)
            self.assertIn("其他作品历史", audit_text)

    def test_chapter_rebuild_removes_selected_contract_and_all_old_local_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "分级清空", {})
            first = ChapterContract("serial", 1, "第一章", "目标一", "阻碍", "变化", next_first_beat="第二章")
            second = ChapterContract("serial", 2, "第二章", "目标二", "阻碍", "变化", next_first_beat="第三章")
            store.save_outline_chapters("serial", [first.to_dict(), second.to_dict()])
            store.save_chapter(first, content="第一章正文")
            store.save_chapter(second, content="第二章正文")
            prior_archive = store.book_dir("serial") / ".trash" / "rebuild-chapter-0001-old" / "chapter-0001.md"
            prior_archive.parent.mkdir(parents=True, exist_ok=True)
            prior_archive.write_text("第一章更早正文", encoding="utf-8")
            preview = store.preview_rebuild("serial", "chapter", "1")
            result = store.apply_rebuild("serial", "chapter", "1", preview["confirmation_phrase"])
            self.assertFalse(result["recoverable"])
            self.assertIsNone(store.get_chapter("serial", 1))
            self.assertEqual(store.read_content("serial", 2), "第二章正文\n")
            self.assertEqual([item["chapter_number"] for item in json.loads((store.book_dir("serial") / "outlines" / "chapters.json").read_text(encoding="utf-8"))], [2])
            surviving_text = "\n".join(
                path.read_text(encoding="utf-8", errors="ignore")
                for path in store.book_dir("serial").rglob("*") if path.is_file()
            )
            self.assertNotIn("第一章正文", surviving_text)
            self.assertNotIn("第一章更早正文", surviving_text)

    def test_scoped_rebuild_preserves_book_rules_and_removes_only_selected_local_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "约束生命周期", {})
            first = ChapterContract("serial", 1, "第一章", "目标一", "阻碍", "变化", volume_id="volume-1", next_first_beat="第二章")
            second = ChapterContract("serial", 2, "第二章", "目标二", "阻碍", "变化", volume_id="volume-1", next_first_beat="第三章")
            store.save_outline_chapters("serial", [first.to_dict(), second.to_dict()])
            initial = store.save_foundation_contract("serial", self.foundation_contract())
            layered = store.apply_foundation_contract_delta("serial", {
                "base_contract_hash": initial["contract_hash"], "source_job_id": "planning-scoped",
                "changes": [
                    {"operation": "add", "constraint_id": "", "scope_type": "volume", "scope_id": "volume-1", "category": "volume_rule", "rule": "本卷必须兑现黑伞来源", "priority": "must", "reason": "卷级规划"},
                    {"operation": "add", "constraint_id": "", "scope_type": "chapter", "scope_id": "1", "category": "chapter_rule", "rule": "第一章必须出现封蜡信", "priority": "must", "reason": "章级规划"},
                ],
            })
            preview = store.preview_rebuild("serial", "chapter", "1")
            result = store.apply_rebuild("serial", "chapter", "1", preview["confirmation_phrase"])
            current = store.load_foundation_contract("serial")
            rules = {str(item["rule"]): item for item in current["active_constraints"]}
            self.assertIn("读者能持续获得可核验的悬疑推进", rules)
            self.assertIn("本卷必须兑现黑伞来源", rules)
            self.assertNotIn("第一章必须出现封蜡信", rules)
            self.assertEqual(len(result["removed_constraint_ids"]), 1)
            self.assertNotEqual(current["contract_hash"], layered["contract_hash"])

    def test_outline_planning_commit_rolls_back_all_surfaces_when_one_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "原规划", {"synopsis": "原简介"})
            master = store.save_master_outline("serial", {
                "completion_mode": "open_ended", "rolling_window": 5, "premise": "旧前提",
                "core_conflict": "旧冲突", "ending_direction": "旧结局", "major_beats": ["旧节点"],
                "volumes": [{"volume_id": "volume-1", "title": "旧卷", "objective": "旧目标", "main_conflict": "旧卷冲突", "character_change": "旧变化", "foreshadowing": "旧伏笔", "ending": "旧落点"}],
            })
            chapter = ChapterContract("serial", 1, "旧章", "旧目标", "旧阻碍", "旧变化", volume_id="volume-1", next_first_beat="旧下一拍")
            store.save_outline_chapters("serial", [chapter.to_dict()])
            foundation = store.save_foundation_contract("serial", self.foundation_contract())
            files_before = {
                name: (store.book_dir("serial") / "outlines" / name).read_bytes()
                for name in ["master.json", "chapters.json", "foundation-contract.json"]
            }
            changed_master = {**master, "premise": "不应残留的新前提"}
            changed_chapter = {**chapter.to_dict(), "objective": "不应残留的新目标"}
            with patch.object(store, "apply_foundation_contract_delta", side_effect=OSError("simulated contract write failure")):
                with self.assertRaisesRegex(OSError, "simulated contract"):
                    store.commit_outline_planning(
                        "serial", master=changed_master, chapters=[changed_chapter],
                        contract_update={"base_contract_hash": foundation["contract_hash"], "changes": []},
                        book_update={"title": "不应残留的新书名", "metadata": {"synopsis": "新简介"}},
                    )
            self.assertEqual(store.get_book("serial")["title"], "原规划")
            self.assertEqual(store.get_chapter("serial", 1)["contract"]["objective"], "旧目标")
            for name, content in files_before.items():
                self.assertEqual((store.book_dir("serial") / "outlines" / name).read_bytes(), content)
            self.assertFalse((root / ".planning-staging").exists())

    def test_outline_planning_rejects_orphaned_volume_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProjectStore(Path(directory))
            store.create_book("serial", "跨层校验", {})
            master = {
                "completion_mode": "open_ended", "rolling_window": 5, "premise": "前提",
                "core_conflict": "冲突", "ending_direction": "结局", "major_beats": ["节点"],
                "volumes": [{"volume_id": "volume-1", "title": "第一卷", "objective": "目标", "main_conflict": "卷冲突", "character_change": "变化", "foreshadowing": "伏笔", "ending": "落点"}],
            }
            chapter = ChapterContract("serial", 1, "孤儿章", "目标", "阻碍", "变化", volume_id="volume-2", next_first_beat="下一拍")
            with self.assertRaisesRegex(ValueError, "missing volume_id"):
                store.commit_outline_planning("serial", master=master, chapters=[chapter.to_dict()])
            self.assertFalse((Path(directory) / ".planning-staging").exists())

    def test_rebuild_write_failure_rolls_back_database_and_restores_every_staged_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "原子重建", {"synopsis": "必须恢复的简介"})
            chapter = ChapterContract("serial", 1, "旧章", "目标", "阻碍", "变化", next_first_beat="下一拍")
            store.save_outline_chapters("serial", [chapter.to_dict()])
            store.save_chapter(chapter, content="不能在失败中丢失的正文")
            preview = store.preview_rebuild("serial", "book", "book")
            original_write_json = store.write_json
            calls = 0

            def fail_first_json(path, value):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("simulated rebuild write failure")
                return original_write_json(path, value)

            with patch.object(store, "write_json", side_effect=fail_first_json):
                with self.assertRaisesRegex(OSError, "simulated rebuild"):
                    store.apply_rebuild("serial", "book", "book", preview["confirmation_phrase"])
            self.assertEqual(store.get_book("serial")["metadata"]["synopsis"], "必须恢复的简介")
            self.assertEqual(store.read_content("serial", 1), "不能在失败中丢失的正文\n")
            self.assertTrue((store.book_dir("serial") / "outlines" / "chapters.json").is_file())
            self.assertFalse((root / ".rebuild-staging").exists())

    def test_rebuild_move_failure_rolls_back_partial_staging(self):
        """A filesystem move failure must not leave a half-empty book behind."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root)
            store.create_book("serial", "移动失败回滚", {"synopsis": "原简介"})
            chapter = ChapterContract("serial", 1, "旧章", "目标", "阻碍", "变化", next_first_beat="下一拍")
            store.save_outline_chapters("serial", [chapter.to_dict()])
            store.save_chapter(chapter, content="必须恢复的正文")
            preview = store.preview_rebuild("serial", "book", "book")
            original_move = store_module.shutil.move
            calls = 0

            def fail_second_move(source, destination, *args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("simulated rebuild move failure")
                return original_move(source, destination, *args, **kwargs)

            with patch.object(store_module.shutil, "move", side_effect=fail_second_move):
                with self.assertRaisesRegex(OSError, "simulated rebuild move failure"):
                    store.apply_rebuild("serial", "book", "book", preview["confirmation_phrase"])
            self.assertEqual(store.read_content("serial", 1), "必须恢复的正文\n")
            self.assertEqual(store.get_book("serial")["metadata"]["synopsis"], "原简介")
            self.assertFalse((root / ".rebuild-staging").exists())

    def test_changing_generated_outline_invalidates_old_reviews_downstream_and_canon_without_deleting_text(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProjectStore(Path(directory))
            store.create_book("serial", "章纲失效链", {})
            first = ChapterContract("serial", 1, "第一章", "找到证人", "追兵阻拦", "拿到口供", next_first_beat="核验口供")
            second = ChapterContract("serial", 2, "第二章", "核验口供", "证词矛盾", "发现伪证", next_first_beat="追查伪证来源")
            store.save_outline_chapters("serial", [first.to_dict(), second.to_dict()])
            strict_approve(store, first, "第一章旧正文。\n\n他拿到了口供。")
            strict_approve(store, second, "第二章旧正文。\n\n口供里藏着矛盾。")
            store.save_canon("serial", 2, {"facts": ["两章旧事实"], "evidence": ["口供里藏着矛盾。"]})
            old_first = store.read_content("serial", 1)
            old_second = store.read_content("serial", 2)
            old_review_paths = [Path(store.get_chapter("serial", number)["review_path"]) for number in (1, 2)]

            changed = first.to_dict()
            changed["objective"] = "证人失踪后追查绑架路线"
            store.save_outline_chapters("serial", [changed, second.to_dict()])

            self.assertEqual(store.get_chapter("serial", 1)["status"], "modified_after_review")
            self.assertEqual(store.get_chapter("serial", 2)["status"], "invalidated")
            self.assertIsNone(store.get_chapter("serial", 1)["review_path"])
            self.assertIsNone(store.get_chapter("serial", 2)["review_path"])
            self.assertEqual(store.load_canon("serial"), {})
            self.assertEqual(store.read_content("serial", 1), old_first)
            self.assertEqual(store.read_content("serial", 2), old_second)
            self.assertTrue(all(path.is_file() for path in old_review_paths), "历史审查文件必须保留供追溯")

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
    def test_publication_content_removes_local_markdown_without_losing_scene_markers(self):
        source = "# 第一章 标题\n\n正文。\n\n###1.\n\n**关键句。**\n"
        self.assertEqual(publication_content(source), "正文。\n\n1.\n\n关键句。\n")

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
                "chapters": [{"chapter_number": 1, "status": "submitted", "platform_id": "fanqie-1", "content_fingerprint": job["chapters"][0]["content_fingerprint"], "source_fingerprint": job["chapters"][0]["source_fingerprint"]}],
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
                "chapters": [{"chapter_number": 1, "status": "submitted", "content_fingerprint": "wrong-hash", "source_fingerprint": "wrong-hash"}],
            }), encoding="utf-8")
            with self.assertRaises(BrowserJobError):
                publisher.reconcile_browser_job(batch)

    def test_browser_reconcile_validates_whole_batch_before_mutating_any_chapter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            SkillAdapter(root, SKILL_ROOT).refresh_lock()
            store = ProjectStore(root)
            store.create_book("demo", "测试书", {})
            for number in (1, 2):
                contract = ChapterContract(
                    "demo",
                    number,
                    f"标题{number}",
                    "目标",
                    "阻碍",
                    "变化",
                    chapter_hook="钩子",
                    next_first_beat="下一拍",
                    target_word_count=10,
                )
                strict_approve(store, contract, f"正文第{number}章。\n\n门开了。")
            publisher = FanqiePublisher(store, DryRunBrowserDriver())
            batch = publisher.prepare_batch("demo", [1, 2], {})
            job_path = publisher.export_browser_job(batch, confirmation=f"PUBLISH {batch.batch_id}")
            job = json.loads(job_path.read_text(encoding="utf-8"))
            first = job["chapters"][0]
            Path(job["result_path"]).write_text(json.dumps({
                "batch_id": batch.batch_id,
                "status": "submitted",
                "chapters": [{
                    "chapter_number": 1,
                    "status": "submitted",
                    "platform_id": "fanqie-1",
                    "content_fingerprint": first["content_fingerprint"],
                    "source_fingerprint": first["source_fingerprint"],
                }],
            }, ensure_ascii=False), encoding="utf-8")

            with self.assertRaises(BrowserJobError):
                publisher.reconcile_browser_job(batch)
            self.assertEqual(store.get_chapter("demo", 1)["status"], "approved")
            self.assertIsNone(store.get_chapter("demo", 1)["platform_id"])
            self.assertEqual(store.get_chapter("demo", 2)["status"], "approved")

    def test_browser_reconcile_accepts_night_window_stop_without_advancing_chapter(self):
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
                "status": "time_window_blocked",
                "chapters": [],
                "message": "北京时间 07:00 后可提交",
            }, ensure_ascii=False), encoding="utf-8")
            result = publisher.reconcile_browser_job(batch)
            self.assertEqual(result.status, "failed")
            self.assertEqual(store.get_chapter("demo", 1)["status"], "approved")


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


class QualityContextTests(unittest.TestCase):
    def test_quality_report_is_reproducible_and_explains_every_deduction(self):
        template = "就在这时，他心头一紧。这意味着危险已经到来。"
        text = "\n\n".join([template for _ in range(12)]) + "\n\n**残留标记**"
        first = analyze_prose_quality(text)
        second = analyze_prose_quality(text)
        self.assertEqual(first, second)
        self.assertGreater(first["ai_flavor_risk"], 0)
        self.assertIn("markdown_residue", [item["code"] for item in first["findings"]])
        self.assertTrue(all(item.get("quote") and item.get("repair") for item in first["findings"]))

    def test_book_quality_reads_every_supplied_chapter_and_reports_cross_chapter_shape(self):
        opening = "雨水沿着钟楼的石缝往下淌，守钟人在门前停住。"
        chapters = [(number, opening + f"\n\n他检查了第{number}件证物。") for number in range(1, 5)]
        report = analyze_book_quality(chapters)
        self.assertEqual(report["chapters_analyzed"], [1, 2, 3, 4])
        self.assertEqual(len(report["chapter_reports"]), 4)
        self.assertIn("book_repeated_opening", [item["code"] for item in report["cross_chapter_findings"]])


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
            self.assertNotIn("scan", manifest.module_names)
            self.assertNotIn("cover", manifest.module_names)
            pack = adapter.load_module("anti_ai_voice")
            self.assertIn("README.md", pack.artifacts)
            rendered = adapter.build_prompt_pack(
                task="全阶段隔离验证",
                stage="chapter",
                module_chain=["concept_planning", "opening", "plot_logic", "anti_ai_voice"],
                compact=False,
                include_templates=True,
            ).render()
            self.assertNotIn(str(self.OH_STORY_ROOT), rendered)
            for forbidden in ("黄金三章", "爽点", "金手指", "男女频", "打脸", "固定钩子"):
                self.assertNotIn(forbidden, rendered)

    def test_deslop_lint_and_normalization(self):
        from tomota.deslop import normalize_punctuation, run_deslop_lint
        raw = "门开了...空气仿佛凝固。他不禁感到--这一切刚刚开始。"
        normalized = normalize_punctuation(raw)
        self.assertIn("……", normalized)
        self.assertIn("——", normalized)

        findings = run_deslop_lint(raw, skill_root=self.OH_STORY_ROOT)
        rule_types = {finding.rule_type for finding in findings}
        self.assertIn("abstract-cliché", rule_types)
        self.assertIn("banned-word", rule_types)

        rich_sample = "她不知道的是，这意味着危险。她感到一阵紧张。不是一次意外，而是有人提前布置。"
        rich_findings = run_deslop_lint(rich_sample, skill_root=self.OH_STORY_ROOT)
        rich_types = {finding.rule_type for finding in rich_findings}
        self.assertIn("explanation-cliché", rich_types)
        self.assertIn("psychological-telling", rich_types)
        self.assertIn("not-is-comparison", rich_types)
        self.assertTrue(any(f.severity == "blocking" for f in rich_findings))

        functional = normalize_punctuation("真的吗？别走！等等……他挥手——")
        self.assertIn("？", functional)
        self.assertIn("！", functional)
        self.assertIn("……", functional)
        self.assertIn("——", functional)
        self.assertNotIn("?", functional)
        self.assertNotIn("!", functional)
        self.assertNotIn("...", functional)
        self.assertNotIn("--", functional)
        leaked = run_deslop_lint("【本章目标】解释设定", skill_root=self.OH_STORY_ROOT)
        self.assertTrue(any(f.rule_type == "engineering-leak" for f in leaked))

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
