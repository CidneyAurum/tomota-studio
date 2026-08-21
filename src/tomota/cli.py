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

from .autopilot import AutopilotRunner, load_contracts
from .cleanup import CleanupManager
from .generator import MockGenerator, generator_from_environment
from .models import ChapterContract
from .pipeline import PipelineBlocked, TomotaPipeline
from .publisher import DryRunBrowserDriver, FanqiePublisher, PublishBlocked
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

    cover = sub.add_parser("cover", help="为小说生成番茄爆款封面设计方案与生图 Prompt")
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
    workflow_start.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_rework = workflow_sub.add_parser("rework", help="按作者反馈重开一个已通过章节，并保留旧版本与审查记录")
    workflow_rework.add_argument("--book-id", required=True)
    workflow_rework.add_argument("--chapter", type=int, required=True)
    workflow_rework.add_argument("--max-revisions", type=int, default=5)
    workflow_rework.add_argument("--file", required=True, help="包含 feedback 字段的 UTF-8 JSON")
    workflow_rework.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_status = workflow_sub.add_parser("status", help="查看流程状态")
    workflow_status.add_argument("--run-id", required=True)
    workflow_status.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_next = workflow_sub.add_parser("next", help="领取下一阶段紧凑任务包")
    workflow_next.add_argument("--run-id", required=True)
    workflow_next.add_argument("--json", action="store_true", help="以稳定 JSON 输出")
    workflow_submit = workflow_sub.add_parser("submit", help="提交阶段 JSON 产物并推进状态")
    workflow_submit.add_argument("--run-id", required=True)
    workflow_submit.add_argument("--file", required=True)
    workflow_submit.add_argument("--json", action="store_true", help="以稳定 JSON 输出")

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
    fanqie_reconcile = fanqie_sub.add_parser("reconcile", help="安全回写浏览器执行结果")
    fanqie_reconcile.add_argument("--batch", required=True)
    fanqie_reconcile.add_argument("--result", default="")
    fanqie_reconcile.add_argument("--json", action="store_true", help="以稳定 JSON 输出")

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
    _configure_unicode_stdio()
    args = build_parser().parse_args(argv)
    root = Path(args.root).resolve()
    try:
        if args.command == "skill":
            return _skill_command(root, args.skill_command)
        if args.command == "init":
            store = ProjectStore(root)
            directory = store.create_book(args.book_id, args.title, {"synopsis": args.synopsis, "genre": args.genre, "target_platform": "番茄小说", "chapters_per_day": 2, "buffer_days": 7})
            print(directory)
            return 0
        if args.command == "book":
            return _book_command(root, args)
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
            print(json.dumps({
                "status": "error",
                "error_type": type(exc).__name__,
                "message": str(exc),
            }, ensure_ascii=False, indent=2))
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
        store.create_book(book_id, title, dict(metadata))
        if isinstance(value.get("outline"), dict):
            store.save_master_outline(book_id, dict(value["outline"]))
        if isinstance(value.get("chapters"), list):
            store.save_outline_chapters(book_id, list(value["chapters"]))
        print(json.dumps({"book": store.get_book(book_id), "outline": store.load_master_outline(book_id), "chapters": store.list_chapters(book_id)}, ensure_ascii=False, indent=2))
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
            saved = store.save_master_outline(book_id, dict(master))
            if isinstance(value.get("chapters"), list):
                store.save_outline_chapters(book_id, list(value["chapters"]))
        else:
            saved = store.load_master_outline(book_id)
        print(json.dumps({"master": saved, "chapters": store.list_chapters(book_id)}, ensure_ascii=False, indent=2))
        return 0
    raise ValueError(f"未知 book 命令：{args.book_command}")


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
    print(json.dumps({"manifest": manifest.to_dict(), "lock": result.to_dict()}, ensure_ascii=False, indent=2))
    return 0 if result.ok else 2


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
        print(json.dumps({"book": store.get_book(book_id), "chapters": store.list_chapters(book_id), "workflows": store.list_workflow_runs(book_id)}, ensure_ascii=False, indent=2))
    else:
        with store.connect() as connection:
            rows = connection.execute("SELECT id,title,updated_at FROM books ORDER BY updated_at DESC").fetchall()
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
    return 0


def _workflow_command(root: Path, args: argparse.Namespace) -> int:
    engine = WorkflowEngine(root)
    if args.workflow_command == "start":
        chapters = [int(item.strip()) for item in args.chapters.split(",") if item.strip()]
        run = engine.start(args.book_id, chapters, max_revisions=args.max_revisions)
        print(json.dumps({"run": run.to_dict(), "next": engine.next_action(run.run_id)}, ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "rework":
        source = Path(args.file).resolve()
        if not source.is_file():
            raise RuntimeError(f"rework request does not exist: {source}")
        value = json.loads(source.read_text(encoding="utf-8"))
        run = engine.start_rework(args.book_id, args.chapter, str(value.get("feedback", "")), max_revisions=args.max_revisions)
        print(json.dumps({"run": run.to_dict(), "next": engine.next_action(run.run_id)}, ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "status":
        print(json.dumps(engine.status(args.run_id), ensure_ascii=False, indent=2))
        return 0
    if args.workflow_command == "next":
        print(json.dumps(engine.next_action(args.run_id), ensure_ascii=False, indent=2))
        return 0
    result = engine.submit_file(args.run_id, args.file)
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
    publisher = FanqiePublisher(store, DryRunBrowserDriver())
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
