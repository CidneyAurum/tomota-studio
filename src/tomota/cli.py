from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path

from .authors import AuthorService
from .autopilot import AutopilotRunner, load_contracts
from .cleanup import CleanupManager
from .generator import MockGenerator, generator_from_environment
from .models import ChapterContract
from .pipeline import PipelineBlocked, TomotaPipeline
from .publisher import DryRunBrowserDriver, FanqiePublisher, PublishBlocked
from .quality_context import analyze_book_quality
from .scheduler import Scheduler, SHANGHAI
from .skill_adapter import SkillAdapter
from .store import ProjectStore
from .workflow import WorkflowEngine, WorkflowError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tomota", description="番茄小说本地写作工作流")
    parser.add_argument("--root", default=".", help="项目根目录，默认当前目录")
    sub = parser.add_subparsers(dest="command", required=True)

    skill = sub.add_parser("skill", help="管理已安装 oh-story / webnovel-writing skill")
    skill_sub = skill.add_subparsers(dest="skill_command", required=True)
    for name in ["status", "verify", "refresh-lock", "doctor"]:
        skill_sub.add_parser(name)

    init = sub.add_parser("init", help="创建书籍项目")
    init.add_argument("--book-id", required=True)
    init.add_argument("--title", required=True)
    init.add_argument("--synopsis", default="")
    init.add_argument("--genre", default="")

    book = sub.add_parser("book", help="Studio 作品资料与三级大纲接口")
    book_sub = book.add_subparsers(dest="book_command", required=True)
    book_create = book_sub.add_parser("create", help="创建开放式或定长作品")
    book_create.add_argument("--file", required=True)
    book_create.add_argument("--json", action="store_true")
    book_update = book_sub.add_parser("update", help="修改作品资料")
    book_update.add_argument("--book-id", required=True)
    book_update.add_argument("--file", required=True)
    book_update.add_argument("--json", action="store_true")
    book_outline = book_sub.add_parser("outline", help="读取或更新全书、分卷与章节大纲")
    book_outline.add_argument("--book-id", required=True)
    book_outline.add_argument("--file", default="")
    book_outline.add_argument("--json", action="store_true")
    book_sync = book_sub.add_parser("sync", help="从作品目录刷新数据库索引")
    book_sync.add_argument("--json", action="store_true")
    for name in ["rebuild-preview", "rebuild"]:
        item = book_sub.add_parser(name, help="预览或执行分级可恢复重建")
        item.add_argument("--book-id", required=True)
        item.add_argument("--scope-type", choices=["chapter", "volume", "book"], required=True)
        item.add_argument("--scope-id", required=True)
        if name == "rebuild":
            item.add_argument("--confirm", required=True)
        item.add_argument("--json", action="store_true")

    author = sub.add_parser("author", help="管理可复用作者档案、版本、来源与作品绑定")
    author_sub = author.add_subparsers(dest="author_command", required=True)
    author_list = author_sub.add_parser("list")
    author_list.add_argument("--include-system", action="store_true")
    author_list.add_argument("--json", action="store_true")
    author_get = author_sub.add_parser("get")
    author_get.add_argument("--author-id", required=True)
    author_get.add_argument("--json", action="store_true")
    author_version_get = author_sub.add_parser("version-get")
    author_version_get.add_argument("--version-id", required=True)
    author_version_get.add_argument("--json", action="store_true")
    author_delete = author_sub.add_parser("delete")
    author_delete.add_argument("--author-id", required=True)
    author_delete.add_argument("--json", action="store_true")
    for name in ["create", "update", "version-create"]:
        item = author_sub.add_parser(name)
        if name != "create":
            item.add_argument("--author-id", required=True)
        item.add_argument("--file", required=True)
        item.add_argument("--json", action="store_true")
    author_publish = author_sub.add_parser("version-publish")
    author_publish.add_argument("--author-id", required=True)
    author_publish.add_argument("--version-id", required=True)
    author_publish.add_argument("--json", action="store_true")
    author_archive = author_sub.add_parser("version-archive")
    author_archive.add_argument("--author-id", required=True)
    author_archive.add_argument("--version-id", required=True)
    author_archive.add_argument("--json", action="store_true")
    author_source_add = author_sub.add_parser("source-add")
    author_source_add.add_argument("--author-id", required=True)
    author_source_add.add_argument("--file", required=True)
    author_source_add.add_argument("--name", required=True)
    author_source_add.add_argument("--rights-confirmed", action="store_true")
    author_source_add.add_argument("--json", action="store_true")
    author_source_delete = author_sub.add_parser("source-delete")
    author_source_delete.add_argument("--author-id", required=True)
    author_source_delete.add_argument("--source-id", required=True)
    author_source_delete.add_argument("--json", action="store_true")
    author_source_reorder = author_sub.add_parser("source-reorder")
    author_source_reorder.add_argument("--author-id", required=True)
    author_source_reorder.add_argument("--sources", required=True)
    author_source_reorder.add_argument("--json", action="store_true")
    author_context = author_sub.add_parser("distill-context")
    author_context.add_argument("--author-id", required=True)
    author_context.add_argument("--sources", default="")
    author_context.add_argument("--json", action="store_true")
    for name in ["binding-preview", "binding-set"]:
        item = author_sub.add_parser(name)
        item.add_argument("--book-id", required=True)
        item.add_argument("--version-id", required=True)
        item.add_argument("--json", action="store_true")
    override_list = author_sub.add_parser("override-list")
    override_list.add_argument("--book-id", required=True)
    override_list.add_argument("--json", action="store_true")
    override_set = author_sub.add_parser("override-set")
    override_set.add_argument("--book-id", required=True)
    override_set.add_argument("--file", required=True)
    override_set.add_argument("--json", action="store_true")
    override_delete = author_sub.add_parser("override-delete")
    override_delete.add_argument("--book-id", required=True)
    override_delete.add_argument("--override-id", required=True)
    override_delete.add_argument("--json", action="store_true")
    override_import = author_sub.add_parser("override-import")
    override_import.add_argument("--book-id", required=True)
    override_import.add_argument("--file", required=True)
    override_import.add_argument("--json", action="store_true")
    policy_compile = author_sub.add_parser("policy-compile")
    policy_compile.add_argument("--book-id", required=True)
    policy_compile.add_argument("--json", action="store_true")

    scan = sub.add_parser("scan", help="按 oh-story-claudecode 进行题材扫榜与选材策划")
    scan.add_argument("--genre", required=True, help="目标题材/赛道标签，如'都市异能'、'年代军婚'")
    scan.add_argument("--short", action="store_true", help="短篇故事流赛道")
    scan.add_argument("--output", default="", help="保存分析结果的输出文件路径")

    analyze = sub.add_parser("analyze", help="按 oh-story-claudecode 对标范本文档进行逆向拆解")
    analyze.add_argument("--file", required=True, help="范本/对标文本路径")
    analyze.add_argument("--short", action="store_true", help="短篇范本拆解")
    analyze.add_argument("--output", default="", help="保存拆解结果的输出文件路径")

    plan = sub.add_parser("plan", help="按 concept_planning 创建规划 PromptPack")
    plan.add_argument("--book-id", required=True)
    plan.add_argument("--synopsis", default="")

    draft = sub.add_parser("draft", help="按正文模块链生成或创建章节 PromptPack")
    draft.add_argument("--book-id", required=True)
    draft.add_argument("--chapter", type=int, required=True)
    draft.add_argument("--title", required=True)
    draft.add_argument("--objective", required=True)
    draft.add_argument("--obstacle", required=True)
    draft.add_argument("--change", required=True)
    draft.add_argument("--next-first-beat", required=True)
    draft.add_argument("--hook", default="")
    draft.add_argument("--character-goal", default="")
    draft.add_argument("--relationship-state", default="")
    draft.add_argument("--body-info-state", default="")
    draft.add_argument("--target-words", type=int, default=2500)
    draft.add_argument("--problem-tag", action="append", default=[])
    draft.add_argument("--mock", action="store_true")

    deslop = sub.add_parser("deslop", help="对指定章节执行深度去 AI 味体检与标点精修")
    deslop.add_argument("--book-id", required=True)
    deslop.add_argument("--chapter", type=int, required=True)
    deslop.add_argument("--apply", action="store_true", help="自动修复并覆盖正文")
    deslop.add_argument("--quote-mode", choices=["keep", "yan", "ascii"], default="keep", help="引号规范模式")

    quality = sub.add_parser("quality", help="生成可复现的章节与全书文字质量报告")
    quality_sub = quality.add_subparsers(dest="quality_command", required=True)
    quality_report = quality_sub.add_parser("report", help="完整读取所选章节并执行跨章低 AI 味体检")
    quality_report.add_argument("--book-id", required=True)
    quality_report.add_argument("--chapters", default="", help="逗号分隔章节号；为空读取全部有正文的章节")
    quality_report.add_argument("--json", action="store_true", help="以稳定 JSON 输出")

    cover = sub.add_parser("cover", help="为小说生成目标平台封面设计方案与生图 Prompt")
    cover.add_argument("--book-id", required=True)
    cover.add_argument("--chapter", type=int, default=1, help="提取视觉高光的章节号")
    cover.add_argument("--output", default="", help="保存生图 Prompt 的输出文件路径")

    run = sub.add_parser("run", help="按章节契约队列运行写作与审查流水线")
    run.add_argument("--book-id", required=True)
    run.add_argument("--contracts", default="", help="章节契约 JSON 文件，默认 books/<book-id>/outlines/chapters.json")
    run.add_argument("--mock", action="store_true")
    run.add_argument("--generator", choices=["auto", "prompt", "command", "openai", "mock"], default="auto")
    run.add_argument("--no-release", action="store_true", help="只生成和审查，不自动准备发布批次")

    autopilot = sub.add_parser("autopilot", help="一次启动，自动跑完整章纲、审查、返工和发布队列")
    autopilot.add_argument("--book-id", required=True)
    autopilot.add_argument("--contracts", default="", help="章节契约 JSON 文件，默认 books/<book-id>/outlines/chapters.json")
    autopilot.add_argument("--generator", choices=["auto", "prompt", "command", "openai", "mock"], default="auto")
    autopilot.add_argument("--mock", action="store_true", help=argparse.SUPPRESS)
    autopilot.add_argument("--max-revisions", type=int, default=3)
    autopilot.add_argument("--no-release", action="store_true", help="只生成和审查，不自动准备发布批次")

    ingest = sub.add_parser("ingest", help="导入已生成正文并执行六项一致性审查")
    ingest.add_argument("--book-id", required=True)
    ingest.add_argument("--chapter", type=int, required=True)
    ingest.add_argument("--file", required=True, help="UTF-8 正文文件")
    ingest.add_argument("--title", default="")
    ingest.add_argument("--objective", default="")
    ingest.add_argument("--obstacle", default="")
    ingest.add_argument("--change", default="")
    ingest.add_argument("--next-first-beat", default="")

    ingest_outline = sub.add_parser("ingest-outline", help="导入规划文档或章节契约 JSON")
    ingest_outline.add_argument("--book-id", required=True)
    ingest_outline.add_argument("--file", required=True)
    ingest_outline.add_argument("--output-name", default="")

    review = sub.add_parser("review", help="执行 consistency_review")
    review.add_argument("--book-id", required=True)
    review.add_argument("--chapter", type=int, required=True)

    release = sub.add_parser("release", help="生成发布批次预览")
    release.add_argument("--book-id", required=True)
    release.add_argument("--chapters", default="", help="逗号分隔章节号；为空则选择全部 approved")
    release.add_argument("--start-now", action="store_true")
    release.add_argument("--schedule-mode", choices=["immediate", "scheduled"], default="scheduled")
    release.add_argument("--chapters-per-day", type=int, default=2)
    release.add_argument("--publish-hour", type=int, default=20)
    release.add_argument("--start-at", default="", help="ISO 8601 排期起点；仅 scheduled 模式使用")
    release.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    publish = sub.add_parser("publish", help="提交已准备好的批次")
    publish.add_argument("--batch", required=True)
    publish.add_argument("--confirm", default="", help="必须是 PUBLISH <batch-id>")
    publish.add_argument("--mode", choices=["dry-run", "browser"], default="dry-run")
    publish.add_argument("--dry-run", action="store_true", help=argparse.SUPPRESS)
    publish.add_argument("--result", default="", help="browser 模式可指定结果 JSON；默认读取批次 job 旁的 result 文件")
    publish.add_argument("--reconcile", action="store_true", help="browser 模式：只回写已有结果，不导出新任务")
    publish.add_argument("--unauthenticated", action="store_true")

    status = sub.add_parser("status", help="查看书籍/章节状态")
    status.add_argument("--book-id", default="")
    status.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    workflow = sub.add_parser("workflow", help="严格分阶段写作状态机")
    workflow_sub = workflow.add_subparsers(dest="workflow_command", required=True)
    workflow_start = workflow_sub.add_parser("start", help="启动可断点续跑的严格写作流程")
    workflow_start.add_argument("--book-id", required=True)
    workflow_start.add_argument("--chapters", required=True, help="逗号分隔章节号")
    workflow_start.add_argument("--max-revisions", type=int, default=5)
    workflow_start.add_argument("--exclusive", action="store_true", help="同书复用已有工作流，禁止并行共享 Canon")
    workflow_start.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_rework = workflow_sub.add_parser("rework", help="按作者反馈重开一个已通过章节，并保留旧版本与审查记录")
    workflow_rework.add_argument("--book-id", required=True)
    workflow_rework.add_argument("--chapter", type=int, required=True)
    workflow_rework.add_argument("--max-revisions", type=int, default=5)
    workflow_rework.add_argument("--file", required=True, help="包含 feedback 字段的 UTF-8 JSON")
    workflow_rework.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_scope_rework = workflow_sub.add_parser("rework-scope", help="按评估结果返工章节、分卷或全书中的已生成章节")
    workflow_scope_rework.add_argument("--book-id", required=True)
    workflow_scope_rework.add_argument("--chapters", required=True, help="逗号分隔章节号")
    workflow_scope_rework.add_argument("--scope-type", choices=["book", "volume", "chapter"], required=True)
    workflow_scope_rework.add_argument("--scope-id", default="")
    workflow_scope_rework.add_argument("--max-revisions", type=int, default=5)
    workflow_scope_rework.add_argument("--file", required=True, help="包含 feedback 字段的 UTF-8 JSON")
    workflow_scope_rework.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_status = workflow_sub.add_parser("status", help="查看流程状态")
    workflow_status.add_argument("--run-id", required=True)
    workflow_status.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_next = workflow_sub.add_parser("next", help="领取下一阶段紧凑任务包")
    workflow_next.add_argument("--run-id", required=True)
    workflow_next.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_submit = workflow_sub.add_parser("submit", help="提交阶段 JSON 产物并推进状态")
    workflow_submit.add_argument("--run-id", required=True)
    workflow_submit.add_argument("--file", required=True)
    workflow_submit.add_argument("--action-id", required=True, help="workflow next 签发的 StageActionV2 action_id")
    workflow_submit.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_supersede = workflow_sub.add_parser("supersede-candidate", help="改选已生成的关键节点候选并作废其下游依赖")
    workflow_supersede.add_argument("--run-id", required=True)
    workflow_supersede.add_argument("--source-stage", choices=["story_foundation", "chapter_design"], required=True)
    workflow_supersede.add_argument("--chapter", type=int)
    workflow_supersede.add_argument("--file", required=True)
    workflow_supersede.add_argument("--json", action="store_true", help="以稳定 JSON 输出")

    fanqie = sub.add_parser("fanqie", help="番茄作品运营的本地安全接口")
    fanqie_sub = fanqie.add_subparsers(dest="fanqie_command", required=True)
    fanqie_policy = fanqie_sub.add_parser("policy", help="查看允许与禁止的账号操作")
    fanqie_policy.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    fanqie_session = fanqie_sub.add_parser("session", help="读取本地记录的可见会话状态")
    fanqie_session.add_argument("--book-id", required=True)
    fanqie_session.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    fanqie_record = fanqie_sub.add_parser("record-session", help=argparse.SUPPRESS)
    fanqie_record.add_argument("--book-id", required=True)
    fanqie_record.add_argument("--file", required=True)
    fanqie_record.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    fanqie_batches = fanqie_sub.add_parser("batches", help="列出本地发布批次与预览")
    fanqie_batches.add_argument("--book-id", required=True)
    fanqie_batches.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    fanqie_export = fanqie_sub.add_parser("export", help="导出已确认批次的浏览器任务")
    fanqie_export.add_argument("--batch", required=True)
    fanqie_export.add_argument("--confirm", required=True)
    fanqie_export.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    fanqie_check = fanqie_sub.add_parser("check", help="只校验批次正文，不导出或覆盖任务")
    fanqie_check.add_argument("--batch", required=True)
    fanqie_check.add_argument("--json", action="store_true")
    fanqie_reconcile = fanqie_sub.add_parser("reconcile", help="安全回写浏览器执行结果")
    fanqie_reconcile.add_argument("--batch", required=True)
    fanqie_reconcile.add_argument("--result", default="")
    fanqie_reconcile.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    fanqie_abandon = fanqie_sub.add_parser("abandon", help="废弃尚未提交的本地发布预览")
    fanqie_abandon.add_argument("--batch", required=True)
    fanqie_abandon.add_argument("--json", action="store_true", help="以稳定 JSON 输出")

    studio = sub.add_parser("studio", help="启动 Tomota Studio 本地可视化工作台")
    studio.add_argument("--port", type=int, default=43127)
    studio.add_argument("--api-port", type=int, default=43128)
    studio.add_argument("--dev", action="store_true", help="使用开发服务器和热更新")
    studio.add_argument("--no-open", action="store_true", help="不自动打开工作台页面")

    studio_index = sub.add_parser("studio-index", help=argparse.SUPPRESS)
    studio_index.add_argument("--json", action="store_true", help=argparse.SUPPRESS)

    cleanup = sub.add_parser("cleanup", help="预览或清除七天回收区；默认仅预览")
    cleanup.add_argument("--book-id", required=True)
    cleanup.add_argument("--apply", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    from .book_lock import BookBusyError, delegated_cli
    import os
    args = build_parser().parse_args(argv)
    try:
        with delegated_cli(Path(args.root).resolve(), os.environ.get("TOMOTA_BOOK_TRANSACTION_BOOK", "")):
            return _main(argv)
    except BookBusyError as exc:
        _configure_unicode_stdio()
        print(json.dumps({"status": "error", "error_type": "BookBusyError", "message": str(exc)}, ensure_ascii=False))
        return 2


def _main(argv: list[str] | None = None) -> int:
    _configure_unicode_stdio()
    args = build_parser().parse_args(argv)
    root = Path(args.root).resolve()
    try:
        if args.command == "skill":
            return _skill_command(root, args.skill_command)
        if args.command == "init":
            store = ProjectStore(root)
            directory = store.create_book(args.book_id, args.title, {"synopsis": args.synopsis, "genre": args.genre, "target_platform": "番茄小说", "chapters_per_day": 2, "buffer_days": 7})
            AuthorService(root).compile_policy(args.book_id)
            print(directory)
            return 0
        if args.command == "book":
            return _book_command(root, args)
        if args.command == "author":
            return _author_command(root, args)
        if args.command == "scan":
            pipeline = TomotaPipeline(root)
            artifact = pipeline.scan(args.genre, is_short=args.short)
            text = artifact.metadata.get("prompt_text", "")
            if args.output:
                out_path = Path(args.output).resolve()
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(text, encoding="utf-8")
                print(f"扫榜选材提示包已生成至：{out_path}")
            else:
                print(text)
            return 0
        if args.command == "analyze":
            pipeline = TomotaPipeline(root)
            artifact = pipeline.analyze(args.file, is_short=args.short)
            text = artifact.metadata.get("prompt_text", "")
            if args.output:
                out_path = Path(args.output).resolve()
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(text, encoding="utf-8")
                print(f"对标拆解提示包已生成至：{out_path}")
            else:
                print(text)
            return 0
        if args.command == "cover":
            pipeline = TomotaPipeline(root)
            artifact = pipeline.cover(args.book_id, focus_chapter=args.chapter)
            text = artifact.metadata.get("prompt_text", "")
            if args.output:
                out_path = Path(args.output).resolve()
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(text, encoding="utf-8")
                print(f"封面图方案已生成至：{out_path}")
            else:
                print(text)
            return 0
        if args.command == "deslop":
            pipeline = TomotaPipeline(root)
            result = pipeline.deslop_chapter(args.book_id, args.chapter, apply=args.apply, quote_mode=args.quote_mode)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "quality":
            return _quality_command(root, args)
        if args.command == "plan":
            pipeline = TomotaPipeline(root)
            synopsis = args.synopsis or (pipeline.store.get_book(args.book_id) or {}).get("metadata", {}).get("synopsis", "")
            artifact = pipeline.plan(args.book_id, synopsis)
            print(artifact.text)
            return 0
        if args.command == "run":
            return _run_command(root, args)
        if args.command == "autopilot":
            return _autopilot_command(root, args)
        if args.command == "draft":
            generator = MockGenerator() if args.mock else None
            pipeline = TomotaPipeline(root, generator=generator)
            contract = ChapterContract(
                book_id=args.book_id, chapter_number=args.chapter, title=args.title, objective=args.objective,
                obstacle=args.obstacle, change=args.change, chapter_hook=args.hook,
                next_first_beat=args.next_first_beat, current_character_goal=args.character_goal,
                relationship_state=args.relationship_state, body_information_state=args.body_info_state,
                target_word_count=args.target_words, problem_tags=args.problem_tag,
            )
            path, report = pipeline.draft(contract)
            print(json.dumps({"path": str(path), "review": report.to_dict()}, ensure_ascii=False, indent=2))
            return 0 if report.passed else 2
        if args.command == "ingest":
            return _ingest_command(root, args)
        if args.command == "ingest-outline":
            pipeline = TomotaPipeline(root)
            output = pipeline.ingest_outline(args.book_id, args.file, output_name=args.output_name or None)
            print(output)
            return 0
        if args.command == "review":
            report = TomotaPipeline(root).review(args.book_id, args.chapter)
            print(report.to_markdown())
            return 0 if report.passed else 2
        if args.command == "release":
            return _release_command(root, args)
        if args.command == "publish":
            return _publish_command(root, args)
        if args.command == "status":
            return _status_command(root, args.book_id)
        if args.command == "workflow":
            return _workflow_command(root, args)
        if args.command == "fanqie":
            return _fanqie_command(root, args)
        if args.command == "studio":
            return _studio_command(root, args)
        if args.command == "studio-index":
            store = ProjectStore(root)
            print(json.dumps(store.index_existing_books(), ensure_ascii=False, indent=2))
            return 0
        if args.command == "cleanup":
            store = ProjectStore(root)
            store.initialize()
            report = CleanupManager(store).run(args.book_id, apply=args.apply)
            print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
            return 0
    except (PipelineBlocked, PublishBlocked, WorkflowError, RuntimeError, ValueError) as exc:
        if getattr(args, "json", False):
            payload = exc.to_dict() if isinstance(exc, WorkflowError) else {
                "status": "error",
                "error_type": type(exc).__name__,
                "error_code": "request_failed",
                "failure_class": "request",
                "message": str(exc),
                "retryable": False,
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"错误：{exc}", file=sys.stderr)
        return 2
    return 1


def _book_command(root: Path, args: argparse.Namespace) -> int:
    store = ProjectStore(root)
    store.initialize()
    if args.book_command == "sync":
        print(json.dumps(store.index_existing_books(), ensure_ascii=False, indent=2))
        return 0
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(args.book_id if hasattr(args, "book_id") else "")) and args.book_command != "create":
        raise ValueError("book_id 只能包含字母、数字、短横线和下划线")
    source = Path(args.file).resolve() if getattr(args, "file", "") else None
    value: dict[str, object] = {}
    if source:
        if not source.is_file():
            raise ValueError(f"输入文件不存在：{source}")
        parsed = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("输入文件顶层必须是 JSON 对象")
        value = parsed
    if args.book_command == "create":
        requested_id = str(value.get("book_id") or "").strip()
        if requested_id and not re.fullmatch(r"[A-Za-z0-9_-]+", requested_id):
            raise ValueError("book_id 只能包含字母、数字、短横线和下划线")
        book_id = requested_id or f"novel-{uuid.uuid4().hex[:12]}"
        while store.get_book(book_id) or store.book_dir(book_id).exists():
            book_id = f"novel-{uuid.uuid4().hex[:12]}"
        title = str(value.get("title") or "").strip()
        if not title:
            raise ValueError("作品标题不能为空")
        metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
        author_version_id = str(value.get("authorProfileVersionId") or value.get("author_profile_version_id") or "").strip() or None
        try:
            store.create_book(book_id, title, dict(metadata), author_profile_version_id=author_version_id)
            AuthorService(root).compile_policy(book_id)
            if isinstance(value.get("outline"), dict):
                store.save_master_outline(book_id, dict(value["outline"]))
            if isinstance(value.get("chapters"), list):
                store.save_outline_chapters(book_id, list(value["chapters"]))
            if isinstance(value.get("planning_contract"), dict):
                planning_contract = dict(value["planning_contract"])
                # 规划阶段已决策的作者规则落地映射随契约一并持久化，避免 story_foundation 重新推倒。
                if isinstance(value.get("author_application"), dict):
                    planning_contract["author_application"] = value["author_application"]
                contract = store.save_foundation_contract(book_id, planning_contract)
            else:
                contract = {}
        except Exception:
            # 创建失败时不留下半本书：清理目录与数据库记录后重新抛出。
            with store.connect() as connection:
                for table in ["book_author_bindings", "book_style_overrides", "chapters", "canon_snapshots", "publish_batches", "skill_runs", "workflow_runs", "events"]:
                    connection.execute(f"DELETE FROM {table} WHERE book_id=?", (book_id,))
                connection.execute("DELETE FROM books WHERE id=?", (book_id,))
            shutil.rmtree(store.book_dir(book_id), ignore_errors=True)
            raise
        print(json.dumps({"book": store.get_book(book_id), "outline": store.load_master_outline(book_id), "chapters": store.list_chapters(book_id), "foundation_contract": contract}, ensure_ascii=False, indent=2))
        return 0
    book_id = str(args.book_id)
    if args.book_command == "update":
        title = str(value.get("title") or (store.get_book(book_id) or {}).get("title") or "")
        metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
        book = store.update_book(book_id, title=title, metadata=dict(metadata))
        print(json.dumps({"book": book}, ensure_ascii=False, indent=2))
        return 0
    if args.book_command == "outline":
        if source:
            master = value.get("master") if isinstance(value.get("master"), dict) else value
            contract_update = value.get("planning_contract_update") if isinstance(value.get("planning_contract_update"), dict) else None
            book_update = value.get("book") if isinstance(value.get("book"), dict) else None
            chapters = value.get("chapters") if isinstance(value.get("chapters"), list) else [item.get("contract", item) for item in store.list_chapters(book_id)]
            committed = store.commit_outline_planning(
                book_id,
                master=dict(master),
                chapters=list(chapters),
                contract_update=dict(contract_update) if contract_update is not None else None,
                book_update=dict(book_update) if book_update is not None else None,
            )
            saved = committed["master"]
            foundation = committed["foundation_contract"]
        else:
            saved = store.load_master_outline(book_id)
            foundation = store.load_foundation_contract(book_id)
        print(json.dumps({"master": saved, "chapters": store.list_chapters(book_id), "foundation_contract": foundation}, ensure_ascii=False, indent=2))
        return 0
    if args.book_command == "rebuild-preview":
        print(json.dumps(store.preview_rebuild(book_id, args.scope_type, args.scope_id), ensure_ascii=False, indent=2))
        return 0
    if args.book_command == "rebuild":
        result = store.apply_rebuild(book_id, args.scope_type, args.scope_id, args.confirm)
        # Full rebuild deliberately purges every derived file while retaining
        # the immutable author binding.  Recreate the policy from that binding
        # before returning so the next planning request can never see a bound
        # book with a missing author contract.
        if args.scope_type == "book":
            policy = AuthorService(root).compile_policy(book_id)
            result["author_policy_recompiled"] = {
                "policy_hash": policy.get("policy_hash"),
                "profile_hash": (policy.get("author_binding") or {}).get("profile_hash"),
                "active_rule_count": len(policy.get("active_rules") or []),
            }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    raise ValueError(f"未知 book 命令：{args.book_command}")


def _author_command(root: Path, args: argparse.Namespace) -> int:
    service = AuthorService(root)

    def payload() -> dict[str, object]:
        source = Path(str(args.file)).resolve()
        if not source.is_file():
            raise ValueError(f"输入文件不存在：{source}")
        value = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("输入文件顶层必须是 JSON 对象")
        return value

    command = args.author_command
    if command == "list":
        value: object = {"authors": service.list_profiles(include_system=args.include_system)}
    elif command == "get":
        value = {"author": service.get_profile(args.author_id)}
        if value["author"] is None:
            raise ValueError("作者档案不存在")
    elif command == "delete":
        value = {"author": service.delete_profile(args.author_id)}
    elif command == "create":
        raw = payload()
        value = {"author": service.create_profile(
            str(raw.get("name") or ""), str(raw.get("description") or ""),
            raw.get("persona") if isinstance(raw.get("persona"), dict) else None,
        )}
    elif command == "update":
        raw = payload()
        value = {"author": service.update_profile(
            args.author_id,
            name=None if "name" not in raw else str(raw["name"]),
            description=None if "description" not in raw else str(raw["description"]),
            status=None if "status" not in raw else str(raw["status"]),
            persona=None if "persona" not in raw else raw.get("persona") if isinstance(raw.get("persona"), dict) else {},
        )}
    elif command == "version-create":
        raw = payload()
        profile = raw.get("profile") if isinstance(raw.get("profile"), dict) else raw
        source_ids = [str(item) for item in raw.get("source_ids", [])] if isinstance(raw.get("source_ids"), list) else []
        value = {"version": service.create_version(args.author_id, dict(profile), source_ids=source_ids)}
    elif command == "version-get":
        version = service.get_version(args.version_id)
        if not version:
            raise ValueError("作者版本不存在")
        value = {"version": version}
    elif command == "version-publish":
        value = {"version": service.publish_version(args.author_id, args.version_id)}
    elif command == "version-archive":
        value = {"version": service.archive_version(args.author_id, args.version_id)}
    elif command == "source-add":
        value = {"source": service.add_source(
            args.author_id, Path(args.file), args.name, rights_confirmed=args.rights_confirmed,
        )}
    elif command == "source-delete":
        value = {"source": service.delete_source(args.author_id, args.source_id)}
    elif command == "source-reorder":
        source_ids = [item.strip() for item in args.sources.split(",") if item.strip()]
        value = {"sources": service.reorder_sources(args.author_id, source_ids)}
    elif command == "distill-context":
        source_ids = [item.strip() for item in args.sources.split(",") if item.strip()]
        value = service.distillation_context(args.author_id, source_ids or None)
    elif command == "binding-preview":
        value = service.preview_binding(args.book_id, args.version_id)
    elif command == "binding-set":
        value = service.bind_book(args.book_id, args.version_id)
    elif command == "override-list":
        value = {"overrides": service.list_overrides(args.book_id)}
    elif command == "override-set":
        value = {"override": service.upsert_override(args.book_id, payload()), "overrides": service.list_overrides(args.book_id)}
    elif command == "override-delete":
        value = {"override": service.delete_override(args.book_id, args.override_id), "overrides": service.list_overrides(args.book_id)}
    elif command == "override-import":
        raw = payload()
        values = raw.get("preferences") if isinstance(raw.get("preferences"), list) else raw.get("overrides")
        if not isinstance(values, list):
            raise ValueError("override-import 需要 preferences 数组")
        value = {"imported": service.import_legacy_overrides(args.book_id, values), "overrides": service.list_overrides(args.book_id)}
    elif command == "policy-compile":
        value = {"policy": service.compile_policy(args.book_id), "binding": service.get_binding(args.book_id)}
    else:
        raise ValueError(f"未知 author 命令：{command}")
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


def _configure_unicode_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def _skill_command(root: Path, command: str) -> int:
    adapter = SkillAdapter(root)
    if command == "refresh-lock":
        manifest = adapter.refresh_lock()
        print(json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2))
        return 0
    if command == "verify":
        result = adapter.verify_lock()
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        return 0 if result.ok else 2
    if command == "doctor":
        value = adapter.doctor()
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0 if value.get("ok") else 2
    manifest = adapter.inspect()
    result = adapter.verify_lock()
    print(json.dumps({"manifest": manifest.to_dict(), "lock": result.to_dict(), "runtime_policy": adapter.runtime_policy()}, ensure_ascii=False, indent=2))
    return 0


def _release_command(root: Path, args: argparse.Namespace) -> int:
    store = ProjectStore(root)
    book = store.get_book(args.book_id)
    if not book:
        raise RuntimeError(f"book does not exist: {args.book_id}")
    if args.chapters:
        numbers = [int(item.strip()) for item in args.chapters.split(",") if item.strip()]
    else:
        numbers = [item["chapter_number"] for item in store.list_chapters(args.book_id) if item["status"] == "approved"]
    if not numbers:
        raise RuntimeError("没有 approved 章节可进入发布队列")
    if not 1 <= args.chapters_per_day <= 5:
        raise RuntimeError("chapters-per-day 必须在 1—5 之间")
    if not 0 <= args.publish_hour <= 23:
        raise RuntimeError("publish-hour 必须在 0—23 之间")
    start = None
    if args.start_at:
        try:
            start = datetime.fromisoformat(args.start_at.replace("Z", "+00:00"))
            if start.tzinfo is None:
                start = start.replace(tzinfo=SHANGHAI)
        except ValueError as exc:
            raise RuntimeError("start-at 必须是有效的 ISO 8601 时间") from exc
    schedule_mode = "immediate" if args.start_now else args.schedule_mode
    schedule = {} if schedule_mode == "immediate" else Scheduler(args.chapters_per_day, 0, args.publish_hour).build_schedule(numbers, start=start)
    publisher = FanqiePublisher(store, DryRunBrowserDriver())
    batch = publisher.prepare_batch(args.book_id, numbers, schedule)
    print(json.dumps({"batch_id": batch.batch_id, "chapters": numbers, "schedule_mode": schedule_mode, "schedule": schedule, "confirmation": f"PUBLISH {batch.batch_id}"}, ensure_ascii=False, indent=2))
    return 0


def _run_command(root: Path, args: argparse.Namespace) -> int:
    mode = "mock" if args.mock else args.generator
    pipeline = TomotaPipeline(root, generator=generator_from_environment(mode))
    contracts_path = Path(args.contracts) if args.contracts else pipeline.store.book_dir(args.book_id) / "outlines" / "chapters.json"
    contracts = load_contracts(contracts_path, args.book_id)
    result = AutopilotRunner(pipeline).run(args.book_id, contracts, prepare_release=not args.no_release)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "completed" else 2


def _autopilot_command(root: Path, args: argparse.Namespace) -> int:
    mode = "mock" if args.mock else args.generator
    pipeline = TomotaPipeline(root, generator=generator_from_environment(mode))
    contracts_path = Path(args.contracts) if args.contracts else pipeline.store.book_dir(args.book_id) / "outlines" / "chapters.json"
    contracts = load_contracts(contracts_path, args.book_id)
    result = AutopilotRunner(pipeline).run(
        args.book_id,
        contracts,
        max_revisions=args.max_revisions,
        prepare_release=not args.no_release,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "completed" else 2


def _publish_command(root: Path, args: argparse.Namespace) -> int:
    store = ProjectStore(root)
    batch = store.get_batch(args.batch)
    if not batch:
        raise RuntimeError(f"batch does not exist: {args.batch}")
    if args.dry_run:
        args.mode = "dry-run"
    publisher = FanqiePublisher(store, DryRunBrowserDriver(authenticated=not args.unauthenticated))
    if args.mode == "browser":
        if args.reconcile:
            result = publisher.reconcile_browser_job(batch, args.result or None)
            print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
            return 0 if result.status in {"submitted", "partial"} else 2
        path = publisher.export_browser_job(batch, confirmation=args.confirm)
        print(json.dumps({
            "mode": "browser",
            "job": str(path),
            "bridge": str(root / "scripts" / "fanqie_browser_driver.mjs"),
            "next": "在已登录的番茄官方浏览器会话中运行桥接脚本；完成后用 --reconcile 回写结果",
        }, ensure_ascii=False, indent=2))
        return 0
    result = publisher.submit_batch(batch, confirmation=args.confirm)
    print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
    return 0 if result.status in {"submitted", "partial"} else 2


def _ingest_command(root: Path, args: argparse.Namespace) -> int:
    pipeline = TomotaPipeline(root)
    stored = pipeline.store.get_chapter(args.book_id, args.chapter)
    contract = None
    if not stored:
        required = {
            "title": args.title,
            "objective": args.objective,
            "obstacle": args.obstacle,
            "change": args.change,
            "next_first_beat": args.next_first_beat,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise RuntimeError(f"首次导入章节还缺少契约字段：{', '.join(missing)}")
        contract = ChapterContract(
            book_id=args.book_id,
            chapter_number=args.chapter,
            title=args.title,
            objective=args.objective,
            obstacle=args.obstacle,
            change=args.change,
            next_first_beat=args.next_first_beat,
        )
    path, report = pipeline.ingest_chapter(args.book_id, args.chapter, args.file, contract=contract)
    print(json.dumps({"path": str(path), "review": report.to_dict()}, ensure_ascii=False, indent=2))
    return 0 if report.passed else 2


def _status_command(root: Path, book_id: str) -> int:
    store = ProjectStore(root)
    store.initialize()
    if book_id:
        authors = AuthorService(root)
        policy_path = store.book_dir(book_id) / "canon" / "writing-policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8")) if policy_path.is_file() else None
        print(json.dumps({
            "book": store.get_book(book_id), "chapters": store.list_chapters(book_id),
            "workflows": store.list_workflow_runs(book_id), "author_binding": authors.get_binding(book_id),
            "writing_policy": policy,
        }, ensure_ascii=False, indent=2))
    else:
        with store.connect() as connection:
            rows = connection.execute("SELECT id,title,updated_at FROM books ORDER BY updated_at DESC").fetchall()
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
    return 0


def _quality_command(root: Path, args: argparse.Namespace) -> int:
    store = ProjectStore(root)
    store.initialize()
    if not store.get_book(args.book_id):
        raise ValueError(f"作品不存在：{args.book_id}")
    requested = {
        int(item.strip()) for item in str(args.chapters or "").split(",") if item.strip()
    }
    available = [int(item.get("chapter_number") or 0) for item in store.list_chapters(args.book_id)]
    numbers = sorted(requested or {item for item in available if item > 0})
    chapters: list[tuple[int, str]] = []
    missing: list[int] = []
    for number in numbers:
        text = store.read_content(args.book_id, number)
        if text.strip():
            chapters.append((number, text))
        else:
            missing.append(number)
    report = analyze_book_quality(chapters)
    report["book_id"] = args.book_id
    report["requested_chapters"] = numbers
    report["missing_or_empty_chapters"] = missing
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _workflow_command(root: Path, args: argparse.Namespace) -> int:
    engine = WorkflowEngine(root)
    if args.workflow_command == "start":
        chapters = [int(item.strip()) for item in args.chapters.split(",") if item.strip()]
        run = engine.start(args.book_id, chapters, max_revisions=args.max_revisions, exclusive=args.exclusive)
        print(json.dumps({"run": run.to_dict(), "next": engine.next_action(run.run_id)}, ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "rework":
        source = Path(args.file).resolve()
        if not source.is_file():
            raise RuntimeError(f"rework request does not exist: {source}")
        value = json.loads(source.read_text(encoding="utf-8"))
        run = engine.start_rework(args.book_id, args.chapter, str(value.get("feedback", "")), max_revisions=args.max_revisions, request_id=str(value.get("request_id") or ""))
        print(json.dumps({"run": run.to_dict(), "next": engine.next_action(run.run_id)}, ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "rework-scope":
        source = Path(args.file).resolve()
        if not source.is_file():
            raise RuntimeError(f"rework request does not exist: {source}")
        value = json.loads(source.read_text(encoding="utf-8"))
        chapters = [int(item.strip()) for item in args.chapters.split(",") if item.strip()]
        start = engine.start_feedback_rework if "book_rules" in value else engine.start_scope_rework
        rule_options = {"book_rules": value["book_rules"]} if "book_rules" in value else {}
        run = start(
            args.book_id, chapters, str(value.get("feedback", "")),
            scope_type=args.scope_type, scope_id=args.scope_id,
            max_revisions=args.max_revisions, **rule_options,
        )
        print(json.dumps({"run": run.to_dict(), "next": engine.next_action(run.run_id)}, ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "status":
        print(json.dumps(engine.status(args.run_id), ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "next":
        print(json.dumps(engine.next_action(args.run_id), ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "supersede-candidate":
        source = Path(args.file).resolve()
        if not source.is_file():
            raise RuntimeError(f"candidate artifact does not exist: {source}")
        value = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError("candidate artifact 顶层必须是 JSON 对象")
        result = engine.supersede_with_candidate(
            args.run_id, value, source_stage=args.source_stage, chapter_number=args.chapter,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] in {"running", "completed"} else 2
    result = engine.submit_file(args.run_id, args.file, action_id=args.action_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in {"running", "completed"} else 2


def _fanqie_command(root: Path, args: argparse.Namespace) -> int:
    from .account import ALLOWED_OPERATIONS, FORBIDDEN_OPERATIONS

    store = ProjectStore(root)
    store.initialize()
    if args.fanqie_command == "policy":
        value = {
            "scope": "works_and_chapter_operations_only",
            "allowed_operations": sorted(ALLOWED_OPERATIONS),
            "forbidden_operations": sorted(FORBIDDEN_OPERATIONS),
            "credentials": "never_read_or_export",
            "cloud_deletion": "never_automatic",
        }
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    if args.fanqie_command == "session":
        path = store.book_dir(args.book_id) / "publish" / "fanqie-session.json"
        value = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {
            "status": "unknown",
            "writer_url": "https://fanqienovel.com/main/writer/home",
            "visible_works": [],
            "note": "尚无可见浏览器会话检查记录；不读取 Cookie、Token 或密码",
        }
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 0
    if args.fanqie_command == "record-session":
        from .account import FanqieAccountPolicy, FanqieSessionState

        source = Path(args.file).resolve()
        if not source.is_file():
            raise RuntimeError(f"session artifact does not exist: {source}")
        raw = json.loads(source.read_text(encoding="utf-8"))
        allowed = {"status", "writer_url", "writer_name", "visible_works", "checked_at", "note"}
        state = FanqieSessionState(**{key: value for key, value in raw.items() if key in allowed})
        FanqieAccountPolicy(store).record_session(args.book_id, state)
        print(json.dumps(state.to_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.fanqie_command == "batches":
        directory = store.book_dir(args.book_id) / "publish"
        values = []
        for path in sorted(directory.glob("batch-*.preview.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                values.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                values.append({"batch_id": path.stem.removesuffix(".preview"), "status": "invalid_local_preview", "path": str(path)})
        print(json.dumps(values, ensure_ascii=False, indent=2))
        return 0
    batch = store.get_batch(args.batch)
    if not batch:
        raise RuntimeError(f"batch does not exist: {args.batch}")
    if args.fanqie_command == "abandon":
        if batch.status not in {"prepared", "preview", "failed"}:
            raise RuntimeError(f"batch cannot be abandoned from status: {batch.status}")
        store.update_batch(batch.batch_id, "superseded")
        for suffix in (".json", ".preview.json"):
            path = store.book_dir(batch.book_id) / "publish" / f"{batch.batch_id}{suffix}"
            if not path.is_file():
                continue
            value = json.loads(path.read_text(encoding="utf-8"))
            value["status"] = "superseded"
            value["superseded_reason"] = "用户废弃待确认批次并准备按当前正文重新生成"
            store.write_json(path, value)
        store.append_event(batch.book_id, None, "publish_batch_superseded", {"batch_id": batch.batch_id, "reason": "user_abandoned_preview"})
        print(json.dumps({"batch_id": batch.batch_id, "book_id": batch.book_id, "status": "superseded", "cloud_write_performed": False}, ensure_ascii=False, indent=2))
        return 0
    publisher = FanqiePublisher(store, DryRunBrowserDriver())
    if args.fanqie_command == "check":
        print(json.dumps({"chapters": publisher.browser_jobs.check(batch)}, ensure_ascii=False))
        return 0
    if args.fanqie_command == "export":
        path = publisher.export_browser_job(batch, confirmation=args.confirm)
        print(json.dumps({"batch_id": batch.batch_id, "job": str(path), "status": "exported"}, ensure_ascii=False, indent=2))
        return 0
    result = publisher.reconcile_browser_job(batch, args.result or None)
    print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
    return 0 if result.status in {"submitted", "partial"} else 2


def _studio_command(root: Path, args: argparse.Namespace) -> int:
    studio_dir = root / "studio"
    package_path = studio_dir / "package.json"
    if not package_path.is_file():
        raise RuntimeError(f"Tomota Studio 尚未安装：{package_path}")
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise RuntimeError("Tomota Studio 需要 Node.js 20 或更高版本")
    if not (studio_dir / "node_modules").is_dir():
        raise RuntimeError(f"Studio 依赖尚未安装，请先在 {studio_dir} 运行 npm install")
    if not 1024 <= args.port <= 65535 or not 1024 <= args.api_port <= 65535:
        raise RuntimeError("Studio 端口必须在 1024 到 65535 之间")
    use_dev = args.dev or not (studio_dir / "dist" / "index.html").is_file()
    url = f"http://127.0.0.1:{args.port}"
    if not args.no_open:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    env = os.environ.copy()
    env.update({
        "TOMOTA_ROOT": str(root),
        "TOMOTA_STUDIO_PORT": str(args.port),
        "TOMOTA_STUDIO_API_PORT": str(args.api_port),
    })
    command = [npm, "run", "dev" if use_dev else "start"]
    print(f"Tomota Studio 本机地址：{url}")
    return subprocess.call(command, cwd=studio_dir, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
