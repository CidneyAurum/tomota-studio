from __future__ import annotations

from .book_lock import book_operation

import hashlib
import json
import math
import re
import shutil
import statistics
import uuid
import zipfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote
from xml.etree import ElementTree

from .models import utc_now
from .store import ProjectStore


SOURCE_FILE_LIMIT = 50 * 1024 * 1024
AUTHOR_SOURCE_LIMIT = 500 * 1024 * 1024
EXTRACTED_TEXT_LIMIT = 10_000_000
ALLOWED_SOURCE_EXTENSIONS = {".txt": "text/plain", ".md": "text/markdown", ".epub": "application/epub+zip"}
CONFLICT_MARKERS = (
    "忽略canon", "覆盖canon", "跳过审查", "绕过审查", "不需要因果", "忽略知识边界",
    "允许人物知道一切", "直接发布无需校验", "覆盖发布规则",
)
HARD_POLICY_RULES = [
    "Canon、章节契约、人物知识边界和最终正文证据高于任何文风偏好",
    "先修剧情逻辑与人物连续性，再修转场、对白、章末，最后处理去 AI 味",
    "未通过严格审查的候选、推测和旧稿不得进入 Canon 或获得发布资格",
    "文风规则不得要求复制来源作品的原句、专名、人物或独特情节",
]
# 合法文风轴白名单（与 Studio 侧 AUTHOR_STYLE_AXES 对齐）。这是"合法轴"集合，
# 不是"数量上限"——新增世界观/人设机制轴后可继续扩展，深度蒸馏不限制轴数。
AUTHOR_STYLE_AXES = {
    "story_promise", "protagonist_engine", "relationship_dynamics", "conflict_escalation",
    "revelation_and_foreshadowing", "worldbuilding_delivery", "worldbuilding_mechanics", "volume_architecture",
    "chapter_architecture", "character_design_mechanics",
    "scene_causality", "serial_rhythm", "narrative_distance", "sentence_rhythm", "paragraph_rhythm", "dialogue_mechanics",
    "character_voice", "emotion_delivery", "transition_logic", "ending_hook", "lexical_texture", "revision_signature",
}

# 结构方法分组 → 其维度必须挂载的合法轴。MethodReference 引用的维度轴必须与分组一致，
# 否则即使 dimension_id 存在，也算引用错位（例如连载节奏引用分卷维度），fail-closed 拒绝。
_METHOD_GROUP_AXES = {
    "worldbuilding_mechanics": "worldbuilding_mechanics",
    "character_design_mechanics": "character_design_mechanics",
    "volume": "volume_architecture",
    "chapter": "chapter_architecture",
    "scene": "scene_causality",
    "serial": "serial_rhythm",
}

# These axes describe content-bearing tendencies rather than a transferable
# author method.  They remain contextual unless the profile explicitly marks
# them as required, matching the Studio planning contract.
OPTIONAL_AUTHOR_CONTENT_AXES = {
    "protagonist_engine", "relationship_dynamics", "story_promise", "ending_hook", "genre_tendency",
}


def _ground_quote(source_text: str, quote: str) -> str | None:
    """把引文归位到原文，返回精确原文片段；无法归位返回 None。

    与 Studio 侧 exactSpanIgnoringWhitespace 对齐：模型常把真实换行输出成
    字面量 ``\\n``，或把 ``"`` 输出成 ``\\"``，也常出现纯空白差异。这些属于
    可确定性修复的格式问题，不应因一个换行符触发整份产物重跑；只有真正的
    改写、错字或捏造证据才返回 None 并拒绝。
    """
    if quote in source_text:
        return quote
    unescaped = quote.replace("\\n", "\n").replace('\\"', '"')
    if unescaped in source_text:
        return unescaped
    wanted = [c for c in quote if not c.isspace()]
    if not wanted:
        return None
    available = [(c, i) for i, c in enumerate(source_text) if not c.isspace()]
    for start in range(len(available) - len(wanted) + 1):
        if all(available[start + k][0] == wanted[k] for k in range(len(wanted))):
            begin = available[start][1]
            end = available[start + len(wanted) - 1][1] + 1
            return source_text[begin:end]
    return None


def _dimension_semantic_similarity(a: dict[str, Any], b: dict[str, Any]) -> float:
    """比较两个维度的语义签名相似度（0—1），用于增长报告把"改名"识别为 renamed。

    签名取 finding / mechanism / writing_instruction 三个方法性字段的拼接文本，
    去掉空白后按 2-gram 字符重叠计算 Jaccard 相似度。题材词和专名不参与，因此
    同一方法换名字仍能匹配，而真正不同的方法不会误判为同一维度。
    """
    def _signature(dimension: dict[str, Any]) -> str:
        parts = [str(dimension.get(key) or "") for key in ("finding", "mechanism", "writing_instruction")]
        return " ".join(part for part in parts if part).strip().lower()

    def _ngrams(text: str) -> set[str]:
        chars = [c for c in text if not c.isspace()]
        if len(chars) < 2:
            return set()
        return {"".join(chars[i:i + 2]) for i in range(len(chars) - 1)}

    left = _ngrams(_signature(a))
    right = _ngrams(_signature(b))
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)

# Content-light signals used for transparent Chinese stylometry.  These are
# deliberately small and auditable: unlike topic words or character names,
# function words, punctuation and cadence are useful across different books.
CHINESE_FUNCTION_WORDS = (
    "的", "了", "着", "过", "地", "得", "把", "被", "让", "给", "向", "从", "在", "于",
    "与", "和", "或", "而", "但", "却", "也", "都", "就", "才", "又", "还", "仍", "只",
    "便", "竟", "若", "如果", "因为", "所以", "虽然", "然而", "于是", "那么", "已经", "正在",
    "没有", "不是", "无法", "并不", "什么", "怎么", "为何", "这里", "那里", "这个", "那个",
)
STYLE_SIGNAL_LEXICONS = {
    "cognition": ("想", "觉得", "意识到", "明白", "记得", "怀疑", "猜", "知道"),
    "perception": ("看", "听", "闻", "尝", "触", "望", "盯", "瞥", "察觉"),
    "action": ("走", "跑", "抬", "伸", "抓", "推", "拉", "转身", "起身", "退", "冲", "按"),
    "emotion_label": ("愤怒", "悲伤", "高兴", "害怕", "恐惧", "震惊", "绝望", "紧张", "尴尬"),
    "transition": ("与此同时", "片刻后", "不久后", "第二天", "当晚", "另一边", "随后", "转眼", "此时"),
    "explanation": ("也就是说", "换句话说", "这意味着", "显而易见", "不难看出", "值得一提的是"),
}
PUNCTUATION_MARKS = {
    "comma": "，,", "period": "。.", "question": "？?", "exclamation": "！!",
    "semicolon": "；;", "colon": "：:", "ellipsis": "…", "dash": "—", "pause": "、",
}
STYLE_SIGNATURE_PATHS: dict[str, tuple[tuple[str, ...], float]] = {
    "sentence_median": (("sentence_length", "median"), 18.0),
    "sentence_p90": (("sentence_length", "p90"), 35.0),
    "short_sentence_ratio": (("cadence", "short_sentence_ratio"), 0.25),
    "long_sentence_ratio": (("cadence", "long_sentence_ratio"), 0.20),
    "paragraph_median": (("paragraph_length", "median"), 80.0),
    "single_sentence_paragraph_ratio": (("paragraph_architecture", "single_sentence_ratio"), 0.35),
    "dialogue_ratio": (("dialogue", "character_ratio"), 0.30),
    "dialogue_turn_median": (("dialogue", "turn_length_median"), 24.0),
    "question_per_1000": (("punctuation_per_1000", "question"), 5.0),
    "exclamation_per_1000": (("punctuation_per_1000", "exclamation"), 5.0),
    "ellipsis_per_1000": (("punctuation_per_1000", "ellipsis"), 5.0),
    "dash_per_1000": (("punctuation_per_1000", "dash"), 4.0),
    "function_word_rate": (("function_words", "total_per_1000"), 80.0),
    "cognition_rate": (("narrative_signals_per_1000", "cognition"), 12.0),
    "perception_rate": (("narrative_signals_per_1000", "perception"), 12.0),
    "action_rate": (("narrative_signals_per_1000", "action"), 15.0),
}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash_json(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    temporary.replace(path)


def _canonical_source_text(text: str) -> str:
    """One cross-runtime representation for extracted source text and hashes."""
    return text.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"


def _read_local_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _quantile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(ordered[lower])
    return float(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower))


def _distribution(values: list[int | float]) -> dict[str, float]:
    numeric = [float(item) for item in values]
    if not numeric:
        return {"mean": 0.0, "p10": 0.0, "p25": 0.0, "median": 0.0, "p75": 0.0, "p90": 0.0, "cv": 0.0}
    mean = statistics.fmean(numeric)
    deviation = statistics.pstdev(numeric) if len(numeric) > 1 else 0.0
    return {
        "mean": round(mean, 2), "p10": round(_quantile(numeric, 0.10), 2),
        "p25": round(_quantile(numeric, 0.25), 2), "median": round(statistics.median(numeric), 2),
        "p75": round(_quantile(numeric, 0.75), 2), "p90": round(_quantile(numeric, 0.90), 2),
        "cv": round(deviation / max(1.0, mean), 4),
    }


def _sentences(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[。！？!?…])|(?<=\.)\s+", text) if item.strip()]


def _paragraphs(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"\n\s*\n|\n", text) if item.strip()]


def _analysis_chunks(text: str, target: int = 4_500, maximum: int = 72) -> list[str]:
    """Build evenly sampled, bounded units so a long book cannot dominate."""
    clean = text.strip()
    if not clean:
        return []
    chunks: list[str] = []
    paragraphs = _paragraphs(clean)
    buffer: list[str] = []
    size = 0
    for paragraph in paragraphs:
        if buffer and size + len(paragraph) > target:
            chunks.append("\n".join(buffer))
            buffer, size = [], 0
        if len(paragraph) > target * 2:
            if buffer:
                chunks.append("\n".join(buffer))
                buffer, size = [], 0
            chunks.extend(paragraph[start:start + target] for start in range(0, len(paragraph), target))
        else:
            buffer.append(paragraph)
            size += len(paragraph)
    if buffer:
        chunks.append("\n".join(buffer))
    if len(chunks) <= maximum:
        return chunks
    indexes = sorted({round(index * (len(chunks) - 1) / (maximum - 1)) for index in range(maximum)})
    return [chunks[index] for index in indexes]


def _nested_number(value: dict[str, Any], path: tuple[str, ...]) -> float:
    current: Any = value
    for key in path:
        if not isinstance(current, dict):
            return 0.0
        current = current.get(key)
    try:
        return float(current)
    except (TypeError, ValueError):
        return 0.0


def evaluate_statistical_targets(text: str, targets: list[dict[str, Any]]) -> dict[str, Any]:
    """对一段正文按作者的统计目标区间做确定性文体计量核对。

    只把实测值送进审查，绝不据此硬性否决：区间是作者风格的自然范围而非
    僵硬定额（对齐透明中文文体计量 "interval_not_quota" 原则）。未注册的
    metric 原样带回收进 unknown_metrics，由上层决定，不静默丢弃。
    """
    metrics = AuthorService._text_metrics(text)
    evaluated: list[dict[str, Any]] = []
    unknown: list[str] = []
    for target in targets:
        if not isinstance(target, dict):
            continue
        metric = str(target.get("metric") or "").strip()
        if not metric or STYLE_SIGNATURE_PATHS.get(metric) is None:
            unknown.append(metric)
            continue
        measured = _nested_number(metrics, STYLE_SIGNATURE_PATHS[metric][0])
        bounds = target.get("range") if isinstance(target.get("range"), dict) else {}
        low = float(bounds.get("low") or 0) if isinstance(bounds.get("low"), (int, float)) else 0.0
        high = float(bounds.get("high") or 0) if isinstance(bounds.get("high"), (int, float)) else 0.0
        in_range = bool(low <= measured <= high) if high > low else True
        direction = "low" if measured < low else ("high" if measured > high else "in_range")
        evaluated.append({
            "metric": metric,
            "measured": round(measured, 3),
            "range": {key: float(value) if isinstance(value, (int, float)) else value for key, value in bounds.items()},
            "writing_use": str(target.get("writing_use") or ""),
            "tolerance": str(target.get("tolerance") or ""),
            "in_range": in_range,
            "direction": direction,
        })
    return {
        "schema_version": "statistical-target-evaluation-v1",
        "authority": "interval_not_quota_below_user_canon_and_frozen_author_contract",
        "evaluated": evaluated,
        "unknown_metrics": unknown,
        "review_rule": (
            "这些是作者风格区间而非硬定额；审查据此判断节奏是否长期单调或偏离，"
            "不得为了追平数字破坏自然度、内容与人物声音。"
        ),
    }


def _mattr_characters(text: str, window: int = 500) -> float:
    characters = [char for char in text if "\u3400" <= char <= "\u9fff"]
    if not characters:
        return 0.0
    if len(characters) <= window:
        return round(len(set(characters)) / len(characters), 4)
    starts = sorted({round(index * (len(characters) - window) / 19) for index in range(20)})
    return round(statistics.fmean(len(set(characters[start:start + window])) / window for start in starts), 4)


def _full_text_batch_manifest(text: str, target: int = 24_000) -> list[dict[str, Any]]:
    """Partition every character exactly once, preferring natural boundaries."""
    batches: list[dict[str, Any]] = []
    start = 0
    while start < len(text):
        ideal = min(len(text), start + target)
        end = ideal
        if ideal < len(text):
            lower = min(len(text), start + max(8_000, target - 5_000))
            upper = min(len(text), start + target + 5_000)
            paragraph = text.rfind("\n\n", lower, upper)
            if paragraph >= lower:
                end = paragraph + 2
            else:
                sentence = max(text.rfind(mark, lower, upper) for mark in ("。", "！", "？", "…", "\n"))
                if sentence >= lower:
                    end = sentence + 1
        if end <= start:
            end = min(len(text), start + target)
        segment = text[start:end]
        batches.append({
            "batch_index": len(batches) + 1, "start": start, "end": end,
            "character_count": len(segment),
            "sha256": hashlib.sha256(segment.encode("utf-8")).hexdigest(),
        })
        start = end
    return batches


_CHAPTER_HEADING_RE = re.compile(
    r"(?im)^\s*(?:第[零一二三四五六七八九十百千万两〇0-9]+[章节回卷](?:[^\n]{0,60})?|Chapter\s+\d+(?:[^\n]{0,60})?)\s*$"
)


def _semantic_structure_manifest(text: str) -> dict[str, Any]:
    """Create deterministic chapter/segment and phase boundaries.

    Detected headings are treated as chapters. Text without reliable headings
    remains an explicitly labelled fixed segment; it is never presented to the
    model or UI as a fabricated chapter.
    """
    matches = list(_CHAPTER_HEADING_RE.finditer(text))
    segments: list[dict[str, Any]] = []
    if matches:
        if matches[0].start() > 0 and text[:matches[0].start()].strip():
            prefix = text[:matches[0].start()]
            segments.append({
                "segment_id": "front-matter", "kind": "front_matter", "ordinal": 0,
                "title": "正文前置内容", "start": 0, "end": matches[0].start(),
                "character_count": len(prefix), "sha256": hashlib.sha256(prefix.encode("utf-8")).hexdigest(),
            })
        for index, match in enumerate(matches):
            start = match.start()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            segment = text[start:end]
            segments.append({
                "segment_id": f"chapter-{index + 1}", "kind": "chapter", "ordinal": index + 1,
                "title": match.group(0).strip()[:80], "start": start, "end": end,
                "character_count": len(segment), "sha256": hashlib.sha256(segment.encode("utf-8")).hexdigest(),
            })
    else:
        for item in _full_text_batch_manifest(text, target=16_000):
            segments.append({
                "segment_id": f"segment-{item['batch_index']}", "kind": "fixed_segment",
                "ordinal": item["batch_index"], "title": f"固定段落 {item['batch_index']}",
                "start": item["start"], "end": item["end"],
                "character_count": item["character_count"], "sha256": item["sha256"],
            })

    phases: list[dict[str, Any]] = []
    group: list[dict[str, Any]] = []
    group_characters = 0
    for segment in segments:
        if group and (len(group) >= 12 or group_characters + int(segment["character_count"]) > 120_000):
            phase_index = len(phases) + 1
            phases.append({
                "phase_id": f"phase-{phase_index}", "ordinal": phase_index,
                "title": f"阶段 {phase_index}", "segment_ids": [item["segment_id"] for item in group],
                "start": group[0]["start"], "end": group[-1]["end"],
                "character_count": group_characters,
            })
            group, group_characters = [], 0
        group.append(segment)
        group_characters += int(segment["character_count"])
    if group:
        phase_index = len(phases) + 1
        phases.append({
            "phase_id": f"phase-{phase_index}", "ordinal": phase_index,
            "title": f"阶段 {phase_index}", "segment_ids": [item["segment_id"] for item in group],
            "start": group[0]["start"], "end": group[-1]["end"],
            "character_count": group_characters,
        })
    return {
        "segmentation_mode": "detected_chapters" if matches else "fixed_segments",
        "segments": segments,
        "phases": phases,
    }


def _safe_zip_member(name: str) -> str:
    decoded = unquote(name.replace("\\", "/"))
    path = PurePosixPath(decoded)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("EPUB 包含不安全的内部路径")
    return str(path)


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style", "svg", "nav"}:
            self.ignored_depth += 1
        elif tag.lower() in {"p", "div", "br", "h1", "h2", "h3", "h4", "li", "blockquote"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "svg", "nav"} and self.ignored_depth:
            self.ignored_depth -= 1
        elif tag.lower() in {"p", "div", "h1", "h2", "h3", "h4", "li", "blockquote"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.ignored_depth:
            self.parts.append(data)

    def text(self) -> str:
        value = "".join(self.parts).replace("\u3000", " ")
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines()]
        return "\n".join(line for line in lines if line).strip()


class AuthorService:
    """Author profiles, immutable versions, private sources and book snapshots."""

    def __init__(self, project_root: Path | str):
        self.root = Path(project_root).resolve()
        self.store = ProjectStore(self.root)
        self.store.initialize()

    def list_profiles(self, *, include_system: bool = False) -> list[dict[str, Any]]:
        where = "" if include_system else "WHERE p.is_system=0"
        with self.store.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT p.*,
                    (SELECT id FROM author_profile_versions v WHERE v.author_id=p.id AND v.status='published' ORDER BY v.version_number DESC LIMIT 1) AS current_version_id,
                    (SELECT version_number FROM author_profile_versions v WHERE v.author_id=p.id AND v.status='published' ORDER BY v.version_number DESC LIMIT 1) AS current_version_number,
                    (SELECT COUNT(*) FROM author_profile_versions v WHERE v.author_id=p.id AND v.status='draft') AS draft_count,
                    (SELECT COUNT(*) FROM author_sources s WHERE s.author_id=p.id AND s.deleted_at IS NULL) AS source_count,
                    (SELECT COUNT(*) FROM book_author_bindings b WHERE b.author_id=p.id) AS binding_count
                FROM author_profiles p {where}
                ORDER BY p.updated_at DESC
                """
            ).fetchall()
        return [self._profile_row(row) for row in rows]

    def get_profile(self, author_id: str, *, include_system: bool = False) -> dict[str, Any] | None:
        with self.store.connect() as connection:
            row = connection.execute("SELECT * FROM author_profiles WHERE id=?", (author_id,)).fetchone()
            if not row or (row["is_system"] and not include_system):
                return None
            versions = connection.execute(
                "SELECT * FROM author_profile_versions WHERE author_id=? ORDER BY version_number DESC",
                (author_id,),
            ).fetchall()
            sources = connection.execute(
                """SELECT * FROM author_sources WHERE author_id=?
                   ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,sort_order,created_at,id""",
                (author_id,),
            ).fetchall()
            bindings = connection.execute(
                """
                SELECT b.book_id,b.version_id,b.bound_at,b.updated_at,k.title AS book_title,
                       v.version_number,v.profile_hash,
                       (SELECT w.id FROM workflow_runs w WHERE w.book_id=b.book_id ORDER BY w.updated_at DESC LIMIT 1) AS latest_workflow_id,
                       (SELECT w.status FROM workflow_runs w WHERE w.book_id=b.book_id ORDER BY w.updated_at DESC LIMIT 1) AS latest_workflow_status
                FROM book_author_bindings b
                JOIN books k ON k.id=b.book_id
                JOIN author_profile_versions v ON v.id=b.version_id
                WHERE b.author_id=? ORDER BY k.title,b.book_id
                """,
                (author_id,),
            ).fetchall()
        value = self._profile_row(row)
        value["versions"] = [self._version_row(item) for item in versions]
        value["sources"] = [self._source_row(item) for item in sources]
        enriched_bindings: list[dict[str, Any]] = []
        for raw in bindings:
            item = dict(raw)
            current_policy = _read_local_json(self.store.book_dir(item["book_id"]) / "canon" / "writing-policy.json")
            frozen_policy = _read_local_json(
                self.store.book_dir(item["book_id"]) / "workflow" / str(item.get("latest_workflow_id") or "") / "writing-policy.json"
            ) if item.get("latest_workflow_id") else {}
            frozen_version_id = ((frozen_policy.get("author_binding") or {}).get("version_id") if isinstance(frozen_policy, dict) else None)
            running = item.get("latest_workflow_status") == "running"
            item.update({
                "compiled_policy_hash": current_policy.get("policy_hash") if isinstance(current_policy, dict) else None,
                "frozen_policy_hash": frozen_policy.get("policy_hash") if isinstance(frozen_policy, dict) else None,
                "frozen_version_id": frozen_version_id,
                "effect_state": (
                    "active_and_next" if running and frozen_version_id == item["version_id"]
                    else "next_workflow_only" if running
                    else "next_workflow"
                ),
            })
            enriched_bindings.append(item)
        value["bindings"] = enriched_bindings
        return value

    @staticmethod
    def normalize_persona(value: Any) -> dict[str, Any]:
        raw = value if isinstance(value, dict) else {}
        result: dict[str, Any] = {}
        for field, maximum in {
            "public_identity": 600, "speaking_tone": 300, "reader_relationship": 300,
            "humor_style": 300, "emotional_openness": 300,
        }.items():
            text = str(raw.get(field) or "").strip()
            if len(text) > maximum:
                raise ValueError(f"作者个人人设 {field} 不能超过 {maximum} 个字符")
            result[field] = text
        for field in ["values", "preferred_topics", "avoided_topics", "interaction_habits", "authenticity_rules", "boundaries"]:
            items = raw.get(field, [])
            if not isinstance(items, list):
                raise ValueError(f"作者个人人设 {field} 必须是数组")
            cleaned = [str(item).strip() for item in items if str(item).strip()]
            if len(cleaned) > 30 or any(len(item) > 300 for item in cleaned):
                raise ValueError(f"作者个人人设 {field} 最多 30 项，单项不超过 300 个字符")
            result[field] = cleaned
        return result

    def create_profile(self, name: str, description: str = "", persona: dict[str, Any] | None = None) -> dict[str, Any]:
        clean_name = str(name).strip()
        if not clean_name or len(clean_name) > 80:
            raise ValueError("作者档案名称必须为 1—80 个字符")
        clean_description = str(description).strip()
        if len(clean_description) > 2000:
            raise ValueError("作者档案说明不能超过 2000 个字符")
        author_id = f"author-{uuid.uuid4().hex[:12]}"
        now = utc_now()
        normalized_persona = self.normalize_persona(persona)
        with self.store.connect() as connection:
            connection.execute(
                "INSERT INTO author_profiles(id,name,description,persona_json,status,is_system,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",
                (author_id, clean_name, clean_description, json.dumps(normalized_persona, ensure_ascii=False), "active", now, now),
            )
        (self.root / "authors" / author_id / "sources").mkdir(parents=True, exist_ok=True)
        return self.get_profile(author_id) or {}

    def update_profile(
        self, author_id: str, *, name: str | None = None, description: str | None = None,
        status: str | None = None, persona: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        current = self.get_profile(author_id)
        if not current:
            raise ValueError("作者档案不存在")
        next_name = current["name"] if name is None else str(name).strip()
        next_description = current["description"] if description is None else str(description).strip()
        next_status = current["status"] if status is None else str(status)
        next_persona = current.get("persona", {}) if persona is None else self.normalize_persona(persona)
        if not next_name or len(next_name) > 80:
            raise ValueError("作者档案名称必须为 1—80 个字符")
        if len(next_description) > 2000:
            raise ValueError("作者档案说明不能超过 2000 个字符")
        if next_status not in {"active", "archived"}:
            raise ValueError("作者档案状态无效")
        with self.store.connect() as connection:
            connection.execute(
                "UPDATE author_profiles SET name=?,description=?,persona_json=?,status=?,updated_at=? WHERE id=? AND is_system=0",
                (next_name, next_description, json.dumps(next_persona, ensure_ascii=False), next_status, utc_now(), author_id),
            )
        return self.get_profile(author_id) or {}

    def delete_profile(self, author_id: str) -> dict[str, Any]:
        """Delete an unbound user author while preserving local source files in trash."""
        profile = self.get_profile(author_id, include_system=True)
        if not profile:
            raise ValueError("作者档案不存在")
        if profile.get("is_system"):
            raise ValueError("系统兼容作者不能删除")
        bindings = list(profile.get("bindings") or [])
        if bindings:
            names = "、".join(str(item.get("book_title") or item.get("book_id")) for item in bindings)
            raise ValueError(f"作者仍被 {len(bindings)} 本书绑定：{names}；请先给这些书换绑作者版本")

        author_dir = (self.root / "authors" / author_id).resolve()
        authors_root = (self.root / "authors").resolve()
        if author_dir.parent != authors_root:
            raise ValueError("作者目录越界，拒绝删除")
        trash_path: Path | None = None
        if author_dir.is_dir():
            trash_path = authors_root / ".trash" / f"{author_id}-{uuid.uuid4().hex[:12]}"
            trash_path.parent.mkdir(parents=True, exist_ok=True)
            author_dir.replace(trash_path)
        try:
            with self.store.connect() as connection:
                connection.execute("DELETE FROM author_sources WHERE author_id=?", (author_id,))
                connection.execute("DELETE FROM author_profile_versions WHERE author_id=?", (author_id,))
                connection.execute("DELETE FROM author_profiles WHERE id=? AND is_system=0", (author_id,))
        except Exception:
            if trash_path and trash_path.is_dir() and not author_dir.exists():
                trash_path.replace(author_dir)
            raise
        tombstone = {
            "author_id": author_id,
            "name": profile["name"],
            "deleted_at": utc_now(),
            "versions_deleted": len(profile.get("versions") or []),
            "sources_moved_to_trash": len([item for item in profile.get("sources") or [] if not item.get("deleted_at")]),
        }
        if trash_path:
            _atomic_write_text(trash_path / "deletion.json", json.dumps(tombstone, ensure_ascii=False, indent=2) + "\n")
        return {
            **tombstone,
            "deleted": True,
            "source_archive": str(trash_path.relative_to(self.root)) if trash_path else None,
            "recoverable_sources": bool(trash_path),
        }

    def create_version(
        self,
        author_id: str,
        profile: dict[str, Any],
        *,
        source_ids: list[str] | None = None,
        status: str = "draft",
    ) -> dict[str, Any]:
        if not self.get_profile(author_id):
            raise ValueError("作者档案不存在")
        if status not in {"draft", "published"}:
            raise ValueError("新建作者版本 status 只能为 draft 或 published")
        normalized = self._normalize_profile(profile)
        source_manifest = self._source_manifest(author_id, source_ids or [])
        self._validate_distilled_profile(author_id, normalized, source_manifest)
        if status == "published":
            self._validate_publication_quality(normalized, source_manifest)
        with self.store.connect() as connection:
            prior_row = connection.execute(
                "SELECT * FROM author_profile_versions WHERE author_id=? ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END,version_number DESC LIMIT 1",
                (author_id,),
            ).fetchone()
            if source_manifest:
                prior_profile = json.loads(prior_row["profile_json"]) if prior_row else {}
                prior_manifest = json.loads(prior_row["source_manifest_json"]) if prior_row else []
                normalized["distillation_growth"] = self._distillation_growth_report(
                    prior_row["id"] if prior_row else None, prior_profile, prior_manifest, normalized, source_manifest,
                )
            row = connection.execute(
                "SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM author_profile_versions WHERE author_id=?",
                (author_id,),
            ).fetchone()
            version_number = int(row["next_version"])
            version_id = f"{author_id}-v{version_number}"
            now = utc_now()
            profile_hash = _hash_json(normalized)
            connection.execute(
                "INSERT INTO author_profile_versions(id,author_id,version_number,status,profile_json,source_manifest_json,profile_hash,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    version_id, author_id, version_number, status,
                    json.dumps(normalized, ensure_ascii=False), json.dumps(source_manifest, ensure_ascii=False),
                    profile_hash, now, now if status == "published" else None,
                ),
            )
            connection.execute("UPDATE author_profiles SET updated_at=? WHERE id=?", (now, author_id))
        return self.get_version(version_id) or {}

    @staticmethod
    def _distillation_growth_report(
        baseline_version_id: str | None,
        old_profile: dict[str, Any], old_manifest: list[dict[str, Any]],
        new_profile: dict[str, Any], new_manifest: list[dict[str, Any]],
    ) -> dict[str, Any]:
        old_sources = {str(item.get("source_id") or ""): str(item.get("text_hash") or "") for item in old_manifest if isinstance(item, dict)}
        new_sources = {str(item.get("source_id") or ""): str(item.get("text_hash") or "") for item in new_manifest if isinstance(item, dict)}
        old_dimensions = {str(item.get("id") or ""): item for item in old_profile.get("style_dimensions", []) if isinstance(item, dict) and item.get("id")}
        new_dimensions = {str(item.get("id") or ""): item for item in new_profile.get("style_dimensions", []) if isinstance(item, dict) and item.get("id")}
        ranks = {
            "contradicted": 0, "uncertain": 1, "character_specific": 2, "work_specific": 2,
            "work_cluster": 3, "author_core_candidate": 4, "author_core": 5, "author_core_strong": 5,
        }
        changes: list[dict[str, Any]] = []
        # 语义改名匹配：id 变了但方法语义相同的维度，识别为 renamed，避免误记 new + retired。
        renamed_old_to_new: dict[str, str] = {}
        for new_id, current in new_dimensions.items():
            if new_id in old_dimensions:
                continue
            best_old_id = ""
            best_score = 0.0
            for old_id, previous in old_dimensions.items():
                if old_id in new_dimensions:
                    continue
                score = _dimension_semantic_similarity(current, previous)
                if score > best_score:
                    best_score = score
                    best_old_id = old_id
            if best_score >= 0.6:
                renamed_old_to_new[best_old_id] = new_id
        for dimension_id, current in new_dimensions.items():
            previous = old_dimensions.get(dimension_id)
            renamed_from = None
            if previous is None:
                renamed_from = next((old_id for old_id, new_id in renamed_old_to_new.items() if new_id == dimension_id), None)
                change = "renamed" if renamed_from else "new"
            elif current.get("scope") == "contradicted" and previous.get("scope") != "contradicted":
                change = "contradicted"
            elif ranks.get(str(current.get("scope") or ""), 0) > ranks.get(str(previous.get("scope") or ""), 0):
                change = "upgraded"
            elif ranks.get(str(current.get("scope") or ""), 0) < ranks.get(str(previous.get("scope") or ""), 0):
                change = "downgraded"
            else:
                old_evidence = set(map(str, previous.get("evidence_ids", [])))
                new_evidence = set(map(str, current.get("evidence_ids", [])))
                if len(new_evidence) > len(old_evidence):
                    change = "strengthened"
                elif len(new_evidence) < len(old_evidence):
                    change = "weakened"
                else:
                    change = "unchanged"
            changes.append({
                "dimension_id": dimension_id, "label": str(current.get("label") or dimension_id), "change": change,
                "renamed_from": renamed_from,
                "old_scope": previous.get("scope") if previous else None, "new_scope": current.get("scope"),
                "old_evidence_count": len(previous.get("evidence_ids", [])) if previous else 0,
                "new_evidence_count": len(current.get("evidence_ids", [])),
            })
        for dimension_id, previous in old_dimensions.items():
            if dimension_id not in new_dimensions and dimension_id not in renamed_old_to_new:
                changes.append({
                    "dimension_id": dimension_id, "label": str(previous.get("label") or dimension_id), "change": "retired",
                    "old_scope": previous.get("scope"), "new_scope": None,
                    "old_evidence_count": len(previous.get("evidence_ids", [])), "new_evidence_count": 0,
                })
        return {
            "baseline_version_id": baseline_version_id,
            "source_changes": {
                "added": sorted(set(new_sources) - set(old_sources)),
                "removed": sorted(set(old_sources) - set(new_sources)),
                "changed": sorted(source_id for source_id in set(old_sources) & set(new_sources) if old_sources[source_id] != new_sources[source_id]),
                "unchanged": sorted(source_id for source_id in set(old_sources) & set(new_sources) if old_sources[source_id] == new_sources[source_id]),
            },
            "dimension_changes": changes,
            "summary": dict(Counter(item["change"] for item in changes)),
        }

    def get_version(self, version_id: str) -> dict[str, Any] | None:
        with self.store.connect() as connection:
            row = connection.execute("SELECT * FROM author_profile_versions WHERE id=?", (version_id,)).fetchone()
        return self._version_row(row) if row else None

    def publish_version(self, author_id: str, version_id: str) -> dict[str, Any]:
        version = self.get_version(version_id)
        if not version or version["author_id"] != author_id:
            raise ValueError("作者版本不存在")
        profile = version.get("profile") if isinstance(version.get("profile"), dict) else {}
        profile = self._normalize_profile(profile)
        manifest = version.get("source_manifest") or []
        self._validate_distilled_profile(author_id, profile, manifest)
        self._validate_publication_quality(profile, manifest)
        with self.store.connect() as connection:
            connection.execute(
                "UPDATE author_profile_versions SET status='published',published_at=COALESCE(published_at,?) WHERE id=?",
                (utc_now(), version_id),
            )
            connection.execute("UPDATE author_profiles SET updated_at=? WHERE id=?", (utc_now(), author_id))
        return self.get_version(version_id) or {}

    @staticmethod
    def _validate_publication_quality(profile: dict[str, Any], source_manifest: list[dict[str, Any]]) -> None:
        """All publication paths share the same quality gate before writing."""
        provenance = profile.get("provenance") if isinstance(profile.get("provenance"), dict) else {}
        if provenance.get("kind") == "distilled":
            quality = profile.get("distillation_quality") if isinstance(profile.get("distillation_quality"), dict) else {}
            failures: list[str] = []
            if str(quality.get("reliability_level") or "") == "low":
                failures.append("reliability_level 不能为 low")
            if float(quality.get("corpus_coverage") or 0) != 100:
                failures.append("corpus_coverage 必须为 100")
            if float(quality.get("actionability_score") or 0) < 60:
                failures.append("actionability_score 必须至少 60")
            if len(source_manifest) > 1:
                if float(quality.get("cross_source_consistency") or 0) < 60:
                    failures.append("多作品 cross_source_consistency 必须至少 60")
                if float(quality.get("holdout_consistency") or 0) < 60:
                    failures.append("多作品 holdout_consistency 必须至少 60")
            if str(quality.get("topic_leakage_risk") or "") == "high":
                failures.append("topic_leakage_risk 不能为 high")
            if failures:
                raise ValueError("作者蒸馏版本未达到发布质量门槛：" + "；".join(failures))

    def archive_version(self, author_id: str, version_id: str) -> dict[str, Any]:
        profile = self.get_profile(author_id)
        version = self.get_version(version_id)
        if not profile or profile.get("is_system") or not version or version["author_id"] != author_id:
            raise ValueError("作者版本不存在或不可归档")
        with self.store.connect() as connection:
            connection.execute("UPDATE author_profile_versions SET status='archived' WHERE id=? AND author_id=?", (version_id, author_id))
            connection.execute("UPDATE author_profiles SET updated_at=? WHERE id=?", (utc_now(), author_id))
        return self.get_version(version_id) or {}

    def get_binding(self, book_id: str) -> dict[str, Any] | None:
        with self.store.connect() as connection:
            row = connection.execute(
                """
                SELECT b.*,p.name AS author_name,p.is_system,v.version_number,v.profile_json,v.status AS version_status
                FROM book_author_bindings b
                JOIN author_profiles p ON p.id=b.author_id
                JOIN author_profile_versions v ON v.id=b.version_id
                WHERE b.book_id=?
                """,
                (book_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "book_id": row["book_id"], "author_id": row["author_id"], "author_name": row["author_name"],
            "version_id": row["version_id"], "version_number": row["version_number"],
            "version_status": row["version_status"], "profile_hash": row["profile_hash"],
            "is_system": bool(row["is_system"]),
            "profile": json.loads(row["profile_json"]), "bound_at": row["bound_at"], "updated_at": row["updated_at"],
        }

    def preview_binding(self, book_id: str, version_id: str) -> dict[str, Any]:
        if not self.store.get_book(book_id):
            raise ValueError("作品不存在")
        target = self.get_version(version_id)
        if not target or target["status"] != "published":
            raise ValueError("只能绑定已发布的作者版本")
        current = self.get_binding(book_id)
        old_profile = current.get("profile", {}) if current else {}
        new_profile = target["profile"]
        changed = sorted(key for key in set(old_profile) | set(new_profile) if old_profile.get(key) != new_profile.get(key))
        return {
            "book_id": book_id,
            "current": current,
            "target": target,
            "changed_fields": [{"field": key, "before": old_profile.get(key), "after": new_profile.get(key)} for key in changed],
            "requires_workflow_restart": True,
            "existing_prose_unchanged": True,
        }

    @book_operation(recoverable=True)
    def bind_book(self, book_id: str, version_id: str) -> dict[str, Any]:
        preview = self.preview_binding(book_id, version_id)
        version = preview["target"]
        now = utc_now()
        with self.store.connect() as connection:
            connection.execute(
                """
                INSERT INTO book_author_bindings(book_id,author_id,version_id,profile_hash,bound_at,updated_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(book_id) DO UPDATE SET
                    author_id=excluded.author_id,version_id=excluded.version_id,
                    profile_hash=excluded.profile_hash,updated_at=excluded.updated_at
                """,
                (book_id, version["author_id"], version_id, version["profile_hash"], now, now),
            )
        policy = self.compile_policy(book_id)
        return {"binding": self.get_binding(book_id), "policy": policy, "preview": preview}

    def list_overrides(self, book_id: str) -> list[dict[str, Any]]:
        with self.store.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM book_style_overrides WHERE book_id=? ORDER BY created_at DESC",
                (book_id,),
            ).fetchall()
        return [dict(row) | {"enabled": bool(row["enabled"])} for row in rows]

    @book_operation(recoverable=True)
    def upsert_override(self, book_id: str, value: dict[str, Any]) -> dict[str, Any]:
        if not self.store.get_book(book_id):
            raise ValueError("作品不存在")
        override_id = str(value.get("id") or f"override-{uuid.uuid4().hex[:12]}")
        category = str(value.get("category") or "题材偏好").strip()
        rule = str(value.get("rule") or "").strip()
        evidence = str(value.get("evidence") or "").strip()
        if not rule or len(rule) > 1000:
            raise ValueError("本书文风覆盖规则必须为 1—1000 个字符")
        now = utc_now()
        with self.store.connect() as connection:
            connection.execute(
                """
                INSERT INTO book_style_overrides(id,book_id,category,rule,evidence,enabled,source_id,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    category=excluded.category,rule=excluded.rule,evidence=excluded.evidence,
                    enabled=excluded.enabled,updated_at=excluded.updated_at
                """,
                (
                    override_id, book_id, category, rule, evidence, 1 if value.get("enabled", True) else 0,
                    value.get("source_id"), now, now,
                ),
            )
        self.compile_policy(book_id)
        return next(item for item in self.list_overrides(book_id) if item["id"] == override_id)

    @book_operation
    def import_legacy_overrides(self, book_id: str, values: list[dict[str, Any]]) -> int:
        """Idempotently absorb the old Studio/file preference representation."""
        if not self.store.get_book(book_id):
            return 0
        imported = 0
        existing = self.list_overrides(book_id)
        existing_sources = {str(item.get("source_id") or "") for item in existing}
        existing_rules = {(str(item["category"]), str(item["rule"])) for item in existing}
        now = utc_now()
        with self.store.connect() as connection:
            for item in values:
                if not isinstance(item, dict) or not str(item.get("rule") or "").strip():
                    continue
                category = str(item.get("category") or "题材偏好").strip()
                rule = str(item["rule"]).strip()
                source_id = "legacy-preference:" + str(item.get("id") or _hash_json({"category": category, "rule": rule})[:16])
                if source_id in existing_sources or (category, rule) in existing_rules:
                    continue
                override_id = f"override-{uuid.uuid4().hex[:12]}"
                connection.execute(
                    "INSERT INTO book_style_overrides(id,book_id,category,rule,evidence,enabled,source_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        override_id, book_id, category, rule, str(item.get("evidence") or ""),
                        0 if item.get("enabled") is False else 1, source_id, now, now,
                    ),
                )
                imported += 1
                existing_sources.add(source_id)
                existing_rules.add((category, rule))
        return imported

    @book_operation(recoverable=True)
    def delete_override(self, book_id: str, override_id: str) -> dict[str, Any]:
        current = next((item for item in self.list_overrides(book_id) if item["id"] == override_id), None)
        if not current:
            raise ValueError("本书文风覆盖规则不存在")
        with self.store.connect() as connection:
            connection.execute("DELETE FROM book_style_overrides WHERE id=? AND book_id=?", (override_id, book_id))
        self.compile_policy(book_id)
        return current

    @book_operation
    def compile_policy(self, book_id: str) -> dict[str, Any]:
        binding = self.get_binding(book_id)
        if not binding:
            raise ValueError("作品尚未绑定作者版本")
        profile = dict(binding["profile"])
        profile.pop("provenance", None)
        profile.pop("source_samples", None)
        dimensions = profile.pop("style_dimensions", [])
        quality = profile.pop("distillation_quality", None)
        application_blueprint = profile.pop("application_blueprint", {})
        statistical_signature = profile.pop("statistical_signature", {})
        story_design = profile.pop("story_design", {})
        book_architecture = profile.pop("book_architecture", {})
        overrides = self.list_overrides(book_id)
        active_rules: list[dict[str, Any]] = []
        conflicts: list[dict[str, Any]] = []
        withheld_rules: list[dict[str, Any]] = []

        def add_rule(
            source: str, category: str, rule: str, evidence: str = "", *,
            scope: str = "author_core", confidence: float | None = None,
            stability: float | None = None, applies_to: list[str] | None = None,
            axis: str = "", trigger: str = "", implementation_steps: list[str] | None = None,
            allowed_variations: list[str] | None = None, acceptance_tests: list[str] | None = None,
            avoid: str = "", application_requirement: str | None = None,
            links: list[dict[str, Any]] | None = None,
            evidence_ids: list[str] | None = None,
            counterevidence_ids: list[str] | None = None,
            failure_modes: list[str] | None = None,
            non_applicable_cases: list[str] | None = None,
            transfer_verdict: str | None = None,
        ) -> None:
            normalized = rule.strip()
            if not normalized:
                return
            if any(marker in normalized.lower().replace(" ", "") for marker in CONFLICT_MARKERS):
                conflicts.append({"source": source, "category": category, "rule": normalized, "reason": "与硬性质量/Canon 规则冲突，未注入"})
                return
            # 蒸馏维度若缺少置信度/稳定度，是浅方法卡而非完整深度维度，不得作为强制规则注入。
            incomplete_distilled_dimension = source == "distilled_dimension" and (confidence is None or stability is None)
            if scope not in {"author_core", "author_core_strong", "general"} or (confidence is not None and confidence < 60) or (stability is not None and stability < 50) or incomplete_distilled_dimension:
                withheld_rules.append({
                    "source": source, "category": category, "rule": normalized, "scope": scope,
                    "confidence": confidence, "stability": stability,
                    "reason": "该特点属于单本/角色/不确定特征、稳定度不足，或浅方法卡缺少置信度/稳定度；仅保留在作者分析中，不默认影响作品",
                })
                return
            declared_requirement = str(application_requirement or "").strip().lower()
            if declared_requirement in {"optional", "contextual", "should", "optional_content_tendency"}:
                normalized_requirement = "contextual"
            elif declared_requirement in {"required_unless_user_or_canon_conflict", "required_unless_conflict"}:
                # 保留"遇到用户要求或 Canon 冲突可暂缓"的语义，不被压成硬 required。
                # Studio 侧 isDeferrable 据此允许在冲突时公开暂缓。
                normalized_requirement = "required_unless_conflict"
            elif declared_requirement in {"required", "must", "method"}:
                normalized_requirement = "required"
            elif source == "book_override":
                normalized_requirement = "required"
            elif axis in OPTIONAL_AUTHOR_CONTENT_AXES:
                normalized_requirement = "contextual"
            else:
                # Ordinary author rules are methods by default.  A method
                # must be translated into the work; it is not a suggestion.
                normalized_requirement = "required"
            active_rules.append({
                "source": source, "category": category, "rule": normalized, "evidence": evidence,
                "scope": scope, "confidence": confidence, "stability": stability,
                "application_requirement": normalized_requirement,
                "applies_to": applies_to or ["book_design", "volume_design", "chapter_design", "drafting", "dialogue", "revision"],
                "axis": axis, "trigger": trigger,
                "implementation_steps": implementation_steps or [],
                "allowed_variations": allowed_variations or [],
                "acceptance_tests": acceptance_tests or [], "avoid": avoid,
                "links": links or [],
                "evidence_ids": evidence_ids or [],
                "counterevidence_ids": counterevidence_ids or [],
                "failure_modes": failure_modes or [],
                "non_applicable_cases": non_applicable_cases or [],
                "transfer_verdict": transfer_verdict or "",
            })

        dimension_by_id = {
            str(item.get("id") or ""): item
            for item in dimensions if isinstance(item, dict) and str(item.get("id") or "")
        }

        def compile_dimension(raw: Any, *, category: str, default_applies_to: list[str] | None = None, default_axis: str = "") -> None:
            """编译单条蒸馏维度（dict）或一段方法文字（str）成规则。

            世界观/人设/结构方法可能是结构化维度（含 links 关联），也可能是
            旧版本遗留的一段文字；两者都编译成规则，关联字段一并保留。
            """
            if isinstance(raw, str):
                text = raw.strip()
                if text:
                    add_rule(
                        "distilled_dimension", category, text,
                        axis=default_axis, applies_to=default_applies_to,
                        application_requirement="required",
                    )
                return
            if not isinstance(raw, dict):
                return
            if raw.get("dimension_id"):
                target = dimension_by_id.get(str(raw.get("dimension_id") or ""))
                if target is None:
                    withheld_rules.append({
                        "source": "distilled_dimension", "category": category,
                        "rule": "", "scope": "uncertain", "confidence": None, "stability": None,
                        "reason": f"MethodReference 指向不存在的完整维度：{raw.get('dimension_id')}",
                    })
                    return
                raw = target
            add_rule(
                "distilled_dimension",
                str(raw.get("label") or raw.get("id") or category),
                str(raw.get("writing_instruction") or raw.get("rule") or ""),
                scope=str(raw.get("scope") or "author_core"),
                confidence=float(raw["confidence"]) if isinstance(raw.get("confidence"), (int, float)) else None,
                stability=float(raw["stability"]) if isinstance(raw.get("stability"), (int, float)) else None,
                applies_to=[str(item) for item in raw.get("applies_to", [])] if isinstance(raw.get("applies_to"), list) and raw.get("applies_to") else default_applies_to,
                axis=str(raw.get("axis") or default_axis),
                trigger=str(raw.get("trigger") or ""),
                implementation_steps=[str(item) for item in raw.get("implementation_steps", [])] if isinstance(raw.get("implementation_steps"), list) else None,
                allowed_variations=[str(item) for item in raw.get("allowed_variations", [])] if isinstance(raw.get("allowed_variations"), list) else None,
                acceptance_tests=[str(item) for item in raw.get("acceptance_tests", [])] if isinstance(raw.get("acceptance_tests"), list) else None,
                avoid=str(raw.get("avoid") or ""),
                application_requirement=str(raw.get("application_requirement") or "") or None,
                links=[dict(item) for item in raw.get("links", [])] if isinstance(raw.get("links"), list) else None,
                evidence_ids=[str(item) for item in raw.get("evidence_ids", [])] if isinstance(raw.get("evidence_ids"), list) else None,
                counterevidence_ids=[str(item) for item in raw.get("counterevidence_ids", [])] if isinstance(raw.get("counterevidence_ids"), list) else None,
                failure_modes=[str(item) for item in raw.get("failure_modes", [])] if isinstance(raw.get("failure_modes"), list) else None,
                non_applicable_cases=[str(item) for item in raw.get("non_applicable_cases", [])] if isinstance(raw.get("non_applicable_cases"), list) else None,
                transfer_verdict=(str(raw["transfer_test"]["verdict"]) if isinstance(raw.get("transfer_test"), dict) and raw["transfer_test"].get("verdict") else None),
            )

        raw_rules = profile.get("rules", [])
        if isinstance(raw_rules, list):
            for raw in raw_rules:
                if isinstance(raw, dict):
                    add_rule(
                        "author_profile", str(raw.get("category") or "文风"), str(raw.get("rule") or ""),
                        scope=str(raw.get("scope") or "author_core"),
                        confidence=float(raw["confidence"]) if isinstance(raw.get("confidence"), (int, float)) else None,
                        stability=float(raw["stability"]) if isinstance(raw.get("stability"), (int, float)) else None,
                        applies_to=[str(item) for item in raw.get("applies_to", [])] if isinstance(raw.get("applies_to"), list) else None,
                        axis=str(raw.get("axis") or raw.get("category") or raw.get("id") or ""),
                        application_requirement=str(raw.get("application_requirement") or "") or None,
                    )
                else:
                    add_rule("author_profile", "文风", str(raw))
        if isinstance(dimensions, list):
            for raw in dimensions:
                if isinstance(raw, dict):
                    compile_dimension(raw, category="文风")
        if isinstance(story_design, dict):
            for key, category, axis, applies in (
                ("worldbuilding_mechanics", "世界观方法", "worldbuilding_mechanics", ["book_design", "volume_design", "chapter_design"]),
                ("character_design_mechanics", "人设方法", "character_design_mechanics", ["book_design", "chapter_design"]),
            ):
                value = story_design.get(key)
                if isinstance(value, list):
                    for item in value:
                        compile_dimension(item, category=category, default_axis=axis, default_applies_to=applies)
                else:
                    compile_dimension(value, category=category, default_axis=axis, default_applies_to=applies)
        if isinstance(book_architecture, dict):
            for key, axis, applies in (
                ("volume", "volume_architecture", ["volume_design"]),
                ("chapter", "chapter_architecture", ["chapter_design"]),
                ("scene", "scene_causality", ["chapter_design"]),
                ("serial", "serial_rhythm", ["volume_design", "chapter_design"]),
            ):
                value = book_architecture.get(key)
                if isinstance(value, list):
                    for item in value:
                        compile_dimension(item, category="结构方法", default_axis=axis, default_applies_to=applies)
                else:
                    compile_dimension(value, category="结构方法", default_axis=axis, default_applies_to=applies)
        for item in reversed(overrides):
            if item["enabled"]:
                add_rule("book_override", str(item["category"]), str(item["rule"]), str(item["evidence"]))

        # Method references resolve to full dimensions already compiled above.
        # Collapse exact duplicates without merging genuinely different scopes.
        active_rules = list({_hash_json(item): item for item in active_rules}.values())

        value: dict[str, Any] = {
            "schema_version": "compiled-writing-policy-v2",
            "book_id": book_id,
            "author_binding": {
                "author_id": binding["author_id"], "author_name": binding["author_name"],
                "version_id": binding["version_id"], "version_number": binding["version_number"],
                "profile_hash": binding["profile_hash"], "is_system": bool(binding.get("is_system")),
            },
            "precedence": ["hard_quality_canon_release", "chapter_contract_and_facts", "book_overrides", "author_profile", "generic_skill_rules"],
            "hard_rules": HARD_POLICY_RULES,
            "style_profile": profile,
            "active_rules": active_rules,
            "conflicts": conflicts,
            "withheld_rules": withheld_rules,
            "author_book_contract": {
                "design_rules": [item for item in active_rules if set(item.get("applies_to") or []) & {"book_design", "volume_design", "chapter_design"}],
                "expression_rules": [item for item in active_rules if set(item.get("applies_to") or []) & {"drafting", "dialogue", "revision"}],
                "application_blueprint": application_blueprint if isinstance(application_blueprint, dict) else {},
                "statistical_targets": (statistical_signature.get("targets") if isinstance(statistical_signature, dict) else []) or [],
                "quality_summary": {
                    "reliability_level": quality.get("reliability_level") if isinstance(quality, dict) else None,
                    "cross_source_consistency": quality.get("cross_source_consistency") if isinstance(quality, dict) else None,
                    "holdout_consistency": quality.get("holdout_consistency") if isinstance(quality, dict) else None,
                },
            },
            "compiled_at": utc_now(),
        }
        author_contract = value["author_book_contract"]
        author_contract["schema_version"] = "author-book-contract-v1"
        author_contract["book_id"] = book_id
        author_contract["author_version_id"] = binding["version_id"]
        author_contract["profile_hash"] = binding["profile_hash"]
        author_contract["precedence"] = ["user_and_canon", "foundation_contract", "author_design_contract", "author_expression_contract"]
        author_contract["contract_hash"] = _hash_json({key: item for key, item in author_contract.items() if key != "contract_hash"})
        value["policy_hash"] = _hash_json({key: item for key, item in value.items() if key not in {"compiled_at", "policy_hash"}})
        target = self.store.book_dir(book_id) / "canon" / "writing-policy.json"
        _atomic_write_text(target, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        _atomic_write_text(
            self.store.book_dir(book_id) / "canon" / "author-book-contract.json",
            json.dumps(author_contract, ensure_ascii=False, indent=2) + "\n",
        )
        return value

    def add_source(self, author_id: str, source_path: Path | str, original_name: str, *, rights_confirmed: bool) -> dict[str, Any]:
        if not rights_confirmed:
            raise ValueError("上传前必须确认拥有作品或具有分析授权")
        if not self.get_profile(author_id):
            raise ValueError("作者档案不存在")
        source = Path(source_path).resolve()
        if not source.is_file():
            raise ValueError("上传临时文件不存在")
        extension = Path(original_name).suffix.lower()
        if extension not in ALLOWED_SOURCE_EXTENSIONS:
            raise ValueError("只支持 TXT、MD、EPUB")
        size = source.stat().st_size
        if size <= 0 or size > SOURCE_FILE_LIMIT:
            raise ValueError("单个作品文件必须大于 0 且不超过 50 MB")
        with self.store.connect() as connection:
            used = connection.execute(
                "SELECT COALESCE(SUM(size_bytes),0) AS total FROM author_sources WHERE author_id=? AND deleted_at IS NULL",
                (author_id,),
            ).fetchone()["total"]
        if int(used) + size > AUTHOR_SOURCE_LIMIT:
            raise ValueError("单个作者的原作品总量不能超过 500 MB")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        with self.store.connect() as connection:
            duplicate = connection.execute(
                "SELECT * FROM author_sources WHERE author_id=? AND sha256=?",
                (author_id, digest),
            ).fetchone()
            next_order = int(connection.execute(
                "SELECT COALESCE(MAX(sort_order),-1)+1 AS value FROM author_sources WHERE author_id=? AND deleted_at IS NULL",
                (author_id,),
            ).fetchone()["value"])
        if duplicate and not duplicate["deleted_at"]:
            return self._source_row(duplicate) | {"deduplicated": True}
        source_id = str(duplicate["id"]) if duplicate else f"source-{uuid.uuid4().hex[:12]}"
        author_dir = self.root / "authors" / author_id
        stored = author_dir / "sources" / f"{source_id}{extension}"
        stored.parent.mkdir(parents=True, exist_ok=True)
        temporary = stored.with_name(f".{stored.name}.{uuid.uuid4().hex}.tmp")
        shutil.copy2(source, temporary)
        temporary.replace(stored)
        try:
            text = self._extract_source(stored, extension)
        except Exception:
            stored.unlink(missing_ok=True)
            raise
        if not text.strip():
            stored.unlink(missing_ok=True)
            raise ValueError("作品文件没有提取到可分析正文")
        if len(text) > EXTRACTED_TEXT_LIMIT:
            stored.unlink(missing_ok=True)
            raise ValueError("单个作品提取正文不能超过 1000 万字符")
        text = _canonical_source_text(text)
        text_path = author_dir / "extracted" / f"{source_id}.txt"
        _atomic_write_text(text_path, text)
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        metrics = self._text_metrics(text)
        now = utc_now()
        try:
            with self.store.connect() as connection:
                if duplicate:
                    connection.execute(
                        """
                        UPDATE author_sources
                        SET original_name=?,stored_path=?,media_type=?,size_bytes=?,text_path=?,text_hash=?,metrics_json=?,
                            status='ready',rights_confirmed=1,sort_order=?,deleted_at=NULL
                        WHERE id=? AND author_id=? AND sha256=?
                        """,
                        (
                            Path(original_name).name, str(stored.relative_to(self.root)), ALLOWED_SOURCE_EXTENSIONS[extension],
                            size, str(text_path.relative_to(self.root)), text_hash, json.dumps(metrics, ensure_ascii=False),
                            next_order, source_id, author_id, digest,
                        ),
                    )
                else:
                    connection.execute(
                        """
                        INSERT INTO author_sources(id,author_id,original_name,stored_path,media_type,size_bytes,sha256,text_path,text_hash,metrics_json,status,rights_confirmed,sort_order,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)
                        """,
                        (
                            source_id, author_id, Path(original_name).name, str(stored.relative_to(self.root)),
                            ALLOWED_SOURCE_EXTENSIONS[extension], size, digest, str(text_path.relative_to(self.root)),
                            text_hash, json.dumps(metrics, ensure_ascii=False), "ready", next_order, now,
                        ),
                    )
                connection.execute("UPDATE author_profiles SET updated_at=? WHERE id=?", (now, author_id))
        except Exception:
            stored.unlink(missing_ok=True)
            text_path.unlink(missing_ok=True)
            raise
        restored = self.get_source(author_id, source_id) or {}
        return restored | ({"restored": True} if duplicate else {})

    def get_source(self, author_id: str, source_id: str) -> dict[str, Any] | None:
        with self.store.connect() as connection:
            row = connection.execute(
                "SELECT * FROM author_sources WHERE id=? AND author_id=?",
                (source_id, author_id),
            ).fetchone()
        return self._source_row(row) if row else None

    def delete_source(self, author_id: str, source_id: str) -> dict[str, Any]:
        source = self.get_source(author_id, source_id)
        if not source or source.get("deleted_at"):
            raise ValueError("作者来源不存在")
        trash = self.root / "authors" / author_id / ".trash" / source_id
        trash.mkdir(parents=True, exist_ok=True)
        deletion_archive = trash / f"deleted-{uuid.uuid4().hex[:12]}"
        deletion_archive.mkdir(parents=True, exist_ok=False)
        for field in ("stored_path", "text_path"):
            path = (self.root / str(source[field])).resolve()
            author_root = (self.root / "authors" / author_id).resolve()
            if path.is_file() and (path == author_root or author_root in path.parents):
                shutil.move(str(path), str(deletion_archive / path.name))
        now = utc_now()
        with self.store.connect() as connection:
            connection.execute("UPDATE author_sources SET status='deleted',deleted_at=? WHERE id=? AND author_id=?", (now, source_id, author_id))
        return self.get_source(author_id, source_id) or source

    def reorder_sources(self, author_id: str, source_ids: list[str]) -> list[dict[str, Any]]:
        profile = self.get_profile(author_id)
        if not profile:
            raise ValueError("作者档案不存在")
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("来源顺序不能包含重复编号")
        active_ids = [str(item["id"]) for item in profile["sources"] if not item.get("deleted_at")]
        if set(source_ids) != set(active_ids) or len(source_ids) != len(active_ids):
            raise ValueError("来源顺序必须完整包含当前作者的全部可用作品")
        now = utc_now()
        with self.store.connect() as connection:
            for sort_order, source_id in enumerate(source_ids):
                connection.execute(
                    "UPDATE author_sources SET sort_order=? WHERE id=? AND author_id=? AND deleted_at IS NULL",
                    (sort_order, source_id, author_id),
                )
            connection.execute("UPDATE author_profiles SET updated_at=? WHERE id=?", (now, author_id))
        refreshed = self.get_profile(author_id)
        return [item for item in (refreshed or {}).get("sources", []) if not item.get("deleted_at")]

    def distillation_context(self, author_id: str, source_ids: list[str] | None = None) -> dict[str, Any]:
        profile = self.get_profile(author_id)
        if not profile:
            raise ValueError("作者档案不存在")
        active = [item for item in profile["sources"] if not item.get("deleted_at")]
        if source_ids:
            if len(source_ids) != len(set(source_ids)):
                raise ValueError("蒸馏来源不能重复")
            by_id = {str(item["id"]): item for item in active}
            missing = [source_id for source_id in source_ids if source_id not in by_id]
            if missing:
                raise ValueError("蒸馏来源不可用：" + ", ".join(missing))
            selected = [by_id[source_id] for source_id in source_ids]
        else:
            selected = active
        if not selected:
            raise ValueError("至少需要一个可用来源作品")
        sources: list[dict[str, Any]] = []
        source_texts: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
        for item in selected:
            stored_path = (self.root / item["stored_path"]).resolve()
            text_path = (self.root / item["text_path"]).resolve()
            if not stored_path.is_file() or hashlib.sha256(stored_path.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError(f"来源原文件哈希已变化：{item['id']}")
            text = _canonical_source_text(text_path.read_text(encoding="utf-8")) if text_path.is_file() else ""
            text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest() if text else ""
            if text_hash != item["text_hash"]:
                # Older Windows uploads hashed the pre-write LF text but wrote
                # CRLF bytes. Rebuild from the still hash-locked original so a
                # modified extracted cache is never silently trusted.
                text = _canonical_source_text(self._extract_source(stored_path, stored_path.suffix.lower()))
                if not text.strip():
                    raise ValueError(f"来源原文件无法重新提取正文：{item['id']}")
                _atomic_write_text(text_path, text)
                text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                metrics = self._text_metrics(text)
                with self.store.connect() as connection:
                    connection.execute(
                        "UPDATE author_sources SET text_hash=?,metrics_json=?,status='ready' WHERE id=? AND author_id=? AND deleted_at IS NULL",
                        (text_hash, json.dumps(metrics, ensure_ascii=False), item["id"], author_id),
                    )
                item = dict(item) | {"text_hash": text_hash, "metrics": metrics}
            else:
                metrics = self._text_metrics(text)
            source_texts.append((item, text, metrics))

        source_count = len(source_texts)
        total_excerpt_budget = 72_000
        kinds_per_source = 5 if source_count <= 4 else 3 if source_count <= 16 else 2 if source_count <= 40 else 1
        excerpt_window = max(320, min(1_400, total_excerpt_budget // max(1, source_count * kinds_per_source)))
        preferred_kinds = ["opening", "middle", "ending", "dialogue", "narration"]
        for index, (item, text, metrics) in enumerate(source_texts):
            all_excerpts = self._representative_excerpts(text, window=excerpt_window)
            if kinds_per_source == 1 and all_excerpts:
                preferred = preferred_kinds[index % len(preferred_kinds)]
                chosen = next((entry for entry in all_excerpts if entry["kind"] == preferred), all_excerpts[index % len(all_excerpts)])
                excerpts = [chosen]
            else:
                excerpts = all_excerpts[:kinds_per_source]
            sources.append({
                "source_id": item["id"], "original_name": item["original_name"],
                "sha256": item["sha256"], "text_hash": item["text_hash"],
                "metrics": metrics, "representative_excerpts": excerpts,
            })
        corpus_analysis = self._corpus_style_analysis(sources)
        semantic_sources = []
        for item, text, _ in source_texts:
            batches = _full_text_batch_manifest(text)
            structure = _semantic_structure_manifest(text)
            semantic_sources.append({
                "source_id": item["id"], "original_name": item["original_name"],
                "text_path": item["text_path"], "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "character_count": len(text), "batch_count": len(batches), "batches": batches,
                "segmentation_mode": structure["segmentation_mode"],
                "segments": structure["segments"], "phases": structure["phases"],
            })
        return {
            "schema_version": "style-distillation-context-v2",
            "author": {"id": author_id, "name": profile["name"], "description": profile["description"]},
            "sources": sources,
            "corpus_analysis": corpus_analysis,
            "semantic_sampling_plan": {
                "method": "supplemental_preview_only_not_semantic_coverage",
                "source_count": source_count, "excerpt_kinds_per_source": kinds_per_source,
                "excerpt_window_characters": excerpt_window, "maximum_total_excerpt_characters": total_excerpt_budget,
                "longest_source_cannot_dominate": True,
            },
            "semantic_full_read_plan": {
                "schema_version": "full-text-semantic-read-v1", "required": True,
                "sampling_only": False, "partition_rule": "every_character_exactly_once",
                "batch_target_characters": 24_000,
                "total_characters": sum(item["character_count"] for item in semantic_sources),
                "total_batches": sum(item["batch_count"] for item in semantic_sources),
                "sources": semantic_sources,
            },
            "distillation_contract": {
                "minimum_style_dimensions": 66,
                "minimum_distinct_axes": 12,
                "method_axis_minimum": 10,
                "minimum_evidence_per_source": 3,
                "scopes": ["author_core_strong", "author_core_candidate", "work_cluster", "work_specific", "character_specific", "uncertain", "contradicted"],
                "author_core_rule": "强作者核心至少覆盖 60% 作品且跨多个章节/阶段；40% 以上为候选核心；仅两部复现但不足 40% 为作品簇",
                "single_source_rule": "只有一个来源时不得声称跨作品稳定，核心规则置信度上限为 75",
                "application_layers": ["book_design", "volume_design", "chapter_design", "drafting", "dialogue", "revision"],
                "quality_axes": ["style_strength", "content_independence", "naturalness", "cross_source_stability", "actionability"],
                "style_axes": sorted(AUTHOR_STYLE_AXES),
            },
            "rules": [
                "先逐部作品独立分析，再求跨作品交集；不得把多本书直接合并后用最长作品代表作者",
                "区分作者稳定风格、单本题材特征、角色声音和不确定特征；只有作者核心规则可默认进入写作策略",
                "提炼故事设计、分卷结构、人物关系、冲突因果递进、揭示节奏、场景语法、叙事、对白和修订规则",
                "结构方法（世界观机制、人设机制、分卷/章节/场景/连载节奏）每类必须产出至少 10 个不同侧面的完整维度，六个方法分组各引用至少 10 条，不得用近义维度凑数",
                "每条结论必须同时给出发现、可执行写作指令、反例/禁忌、适用阶段、置信度、稳定度和证据 ID",
                "统计目标使用区间而非僵硬定额；不得为了追分破坏自然度、内容和人物声音",
                "只提炼可执行的结构、节奏、叙事距离和人物声音规则，不复制专名、人物、情节或长原句",
                "证据引文每条最多 80 个字符，生成阶段不会注入这些引文",
                "剧情逻辑、人物连续性、Canon 与平台规则高于文风规则",
            ],
        }

    @staticmethod
    def _corpus_style_analysis(sources: list[dict[str, Any]]) -> dict[str, Any]:
        source_vectors: list[dict[str, float]] = []
        for source in sources:
            metrics = source.get("metrics") if isinstance(source.get("metrics"), dict) else {}
            source_vectors.append({name: _nested_number(metrics, path) for name, (path, _) in STYLE_SIGNATURE_PATHS.items()})
        stable_features: list[dict[str, Any]] = []
        for name, (_, scale) in STYLE_SIGNATURE_PATHS.items():
            values = [vector[name] for vector in source_vectors]
            center = statistics.median(values) if values else 0.0
            spread = _quantile(values, 0.90) - _quantile(values, 0.10) if len(values) > 1 else 0.0
            stability = 100.0 if len(values) == 1 else max(0.0, 100.0 * (1.0 - min(1.0, spread / max(scale, abs(center), 0.0001))))
            stable_features.append({
                "metric": name, "source_values": [round(value, 4) for value in values],
                "cross_source_median": round(center, 4), "p10": round(_quantile(values, 0.10), 4),
                "p90": round(_quantile(values, 0.90), 4), "stability": round(stability, 1),
            })
        pair_scores: list[float] = []
        source_distances: list[float] = []
        corpus_center = {name: statistics.median([vector[name] for vector in source_vectors]) for name in STYLE_SIGNATURE_PATHS} if source_vectors else {}
        for vector in source_vectors:
            distances = [min(1.0, abs(vector[name] - corpus_center[name]) / max(scale, 0.0001)) for name, (_, scale) in STYLE_SIGNATURE_PATHS.items()]
            source_distances.append(statistics.fmean(distances) if distances else 0.0)
        for left in range(len(source_vectors)):
            for right in range(left + 1, len(source_vectors)):
                distances = [min(1.0, abs(source_vectors[left][name] - source_vectors[right][name]) / max(scale, 0.0001)) for name, (_, scale) in STYLE_SIGNATURE_PATHS.items()]
                pair_scores.append(100.0 * (1.0 - statistics.fmean(distances)))
        total_characters = sum(int((source.get("metrics") or {}).get("non_whitespace_characters") or 0) for source in sources)
        sizes = [int((source.get("metrics") or {}).get("non_whitespace_characters") or 0) for source in sources]
        balance = min(sizes) / max(sizes) if sizes and max(sizes) else 1.0
        holdout_values = [float(((source.get("metrics") or {}).get("validation") or {}).get("holdout_consistency") or 0) for source in sources]
        cross_source = round(statistics.fmean(pair_scores), 1) if pair_scores else None
        reliability = (
            "high" if len(sources) >= 2 and total_characters >= 80_000 and (cross_source or 0) >= 70
            else "medium" if total_characters >= 25_000 and (len(sources) == 1 or (cross_source or 0) >= 50)
            else "low"
        )
        outliers = [
            {"source_id": str(source.get("source_id") or ""), "original_name": str(source.get("original_name") or ""), "distance_from_corpus": round(distance, 4)}
            for source, distance in zip(sources, source_distances) if len(sources) > 2 and distance >= 0.38
        ]
        return {
            "aggregation": "equal_weight_per_work",
            "source_count": len(sources), "total_non_whitespace_characters": total_characters,
            "source_balance_ratio": round(balance, 4), "cross_source_consistency": cross_source,
            "holdout_consistency": round(statistics.fmean(holdout_values), 1) if holdout_values else 0.0,
            "reliability_level": reliability, "source_outliers": outliers,
            "stable_feature_table": stable_features,
            "interpretation": (
                "多作品画像按作品等权聚合；稳定度衡量跨作品复现，不等于文学质量。"
                if len(sources) > 1 else "单作品只能验证跨片段稳定性，不能证明跨作品作者核心。"
            ),
        }

    def _source_manifest(self, author_id: str, source_ids: list[str]) -> list[dict[str, Any]]:
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("蒸馏来源不能重复，重复来源不能冒充跨作品证据")
        values: list[dict[str, Any]] = []
        for source_id in source_ids:
            source = self.get_source(author_id, source_id)
            if not source or source.get("deleted_at"):
                raise ValueError(f"作者来源不可用：{source_id}")
            values.append({
                "source_id": source_id, "original_name": source["original_name"],
                "sha256": source["sha256"], "text_hash": source["text_hash"],
            })
        return values

    @staticmethod
    def _normalize_profile(profile: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(profile, dict):
            raise ValueError("作者版本 profile 必须是对象")
        required = [
            "narrative", "rhythm", "dialogue", "character_voice", "emotion", "scene_pacing",
            "openings", "transitions", "endings", "lexical_preferences", "forbidden_patterns",
            "platform_constraints", "genre_tendencies", "rules",
        ]
        missing = [field for field in required if field not in profile]
        if missing:
            raise ValueError("作者版本缺少字段：" + ", ".join(missing))
        normalized = json.loads(json.dumps(profile, ensure_ascii=False))
        if not isinstance(normalized.get("rules"), list) or not normalized["rules"]:
            raise ValueError("作者版本至少需要一条可执行 rules")
        allowed_scopes = {
            "author_core", "author_core_strong", "author_core_candidate", "work_cluster",
            "work_specific", "character_specific", "uncertain", "contradicted", "general",
        }
        for index, raw in enumerate(normalized["rules"]):
            if not isinstance(raw, dict):
                continue
            if not str(raw.get("rule") or "").strip():
                raise ValueError(f"作者规则 rules[{index}] 不能为空")
            scope = str(raw.get("scope") or "author_core")
            if scope not in allowed_scopes:
                raise ValueError(f"作者规则 rules[{index}].scope 无效")
            raw["scope"] = scope
            for field in ("confidence", "stability"):
                if raw.get(field) is not None:
                    number = raw[field]
                    if not isinstance(number, (int, float)) or isinstance(number, bool) or not 0 <= float(number) <= 100:
                        raise ValueError(f"作者规则 rules[{index}].{field} 必须是 0—100 数字")
            if raw.get("applies_to") is not None and not isinstance(raw.get("applies_to"), list):
                raise ValueError(f"作者规则 rules[{index}].applies_to 必须是数组")

        dimensions = normalized.get("style_dimensions")
        if dimensions is not None:
            if not isinstance(dimensions, list):
                raise ValueError("style_dimensions 必须是数组")
            identifiers: set[str] = set()
            for index, raw in enumerate(dimensions):
                if not isinstance(raw, dict):
                    raise ValueError(f"style_dimensions[{index}] 必须是对象")
                identifier = str(raw.get("id") or "").strip()
                if not identifier or identifier in identifiers:
                    raise ValueError("style_dimensions.id 必须非空且唯一")
                identifiers.add(identifier)
                for field in ("label", "finding", "writing_instruction", "avoid"):
                    if not str(raw.get(field) or "").strip():
                        raise ValueError(f"style_dimensions[{index}].{field} 不能为空")
                if isinstance(normalized.get("provenance"), dict) and normalized["provenance"].get("kind") == "distilled":
                    if str(raw.get("axis") or "") not in AUTHOR_STYLE_AXES:
                        raise ValueError(f"style_dimensions[{index}].axis 无效")
                    if not str(raw.get("trigger") or "").strip():
                        raise ValueError(f"style_dimensions[{index}].trigger 不能为空")
                    for field in ("implementation_steps", "allowed_variations", "acceptance_tests"):
                        if not isinstance(raw.get(field), list) or not raw[field]:
                            raise ValueError(f"style_dimensions[{index}].{field} 必须是非空数组")
                    if normalized["provenance"].get("ledger_run_id"):
                        for field in ("failure_modes", "non_applicable_cases", "counterevidence_ids"):
                            if not isinstance(raw.get(field), list):
                                raise ValueError(f"style_dimensions[{index}].{field} 必须是数组")
                        transfer = raw.get("transfer_test")
                        if not isinstance(transfer, dict) or str(transfer.get("verdict") or "") not in {"pass", "partial", "fail"}:
                            raise ValueError(f"style_dimensions[{index}].transfer_test 无效")
                        trials = transfer.get("trials")
                        if not isinstance(trials, list) or len(trials) < 2:
                            raise ValueError(f"style_dimensions[{index}].transfer_test 至少需要两个迁移题材")
                scope = str(raw.get("scope") or "uncertain")
                if scope not in allowed_scopes - {"general"}:
                    raise ValueError(f"style_dimensions[{index}].scope 无效")
                raw["scope"] = scope
                for field in ("confidence", "stability"):
                    number = raw.get(field)
                    if not isinstance(number, (int, float)) or isinstance(number, bool) or not 0 <= float(number) <= 100:
                        raise ValueError(f"style_dimensions[{index}].{field} 必须是 0—100 数字")
                for field in ("applies_to", "evidence_ids"):
                    if not isinstance(raw.get(field), list) or not raw[field]:
                        raise ValueError(f"style_dimensions[{index}].{field} 必须是非空数组")
                links = raw.get("links")
                if links is not None:
                    if not isinstance(links, list):
                        raise ValueError(f"style_dimensions[{index}].links 必须是数组")
                    for link_index, link in enumerate(links):
                        if not isinstance(link, dict) or not str(link.get("dimension_id") or "").strip():
                            raise ValueError(f"style_dimensions[{index}].links[{link_index}] 必须包含非空 dimension_id")
                        relation = str(link.get("relation") or "")
                        if relation not in {"realized_via", "constrains", "informs"}:
                            raise ValueError(f"style_dimensions[{index}].links[{link_index}].relation 无效")
                        link["relation"] = relation

        blueprint = normalized.get("application_blueprint")
        if blueprint is not None:
            if not isinstance(blueprint, dict):
                raise ValueError("application_blueprint 必须是对象")
            for field in ("book_design", "volume_design", "chapter_design", "drafting", "dialogue", "revision"):
                if not isinstance(blueprint.get(field), list):
                    raise ValueError(f"application_blueprint.{field} 必须是数组")

        signature = normalized.get("statistical_signature")
        if signature is not None:
            if not isinstance(signature, dict) or not isinstance(signature.get("targets"), list):
                raise ValueError("statistical_signature.targets 必须是数组")
            for index, target in enumerate(signature["targets"]):
                if not isinstance(target, dict) or not str(target.get("metric") or "").strip() or not str(target.get("writing_use") or "").strip():
                    raise ValueError(f"statistical_signature.targets[{index}] 缺少 metric/writing_use")
                bounds = target.get("range")
                if not isinstance(bounds, dict) or not all(isinstance(bounds.get(key), (int, float)) for key in ("low", "typical", "high")):
                    raise ValueError(f"statistical_signature.targets[{index}].range 必须包含 low/typical/high 数字")

        quality = normalized.get("distillation_quality")
        if quality is not None:
            if not isinstance(quality, dict) or str(quality.get("reliability_level") or "") not in {"low", "medium", "high"}:
                raise ValueError("distillation_quality.reliability_level 必须是 low/medium/high")
            for field in ("corpus_coverage", "cross_source_consistency", "holdout_consistency", "actionability_score"):
                number = quality.get(field)
                if not isinstance(number, (int, float)) or isinstance(number, bool) or not 0 <= float(number) <= 100:
                    raise ValueError(f"distillation_quality.{field} 必须是 0—100 数字")
        provenance = normalized.get("provenance")
        if isinstance(provenance, dict) and isinstance(provenance.get("evidence"), list):
            ledger_backed = bool(provenance.get("ledger_run_id"))
            normalized_evidence: list[dict[str, Any]] = []
            for item in provenance["evidence"]:
                if not isinstance(item, dict):
                    continue
                quote = str(item.get("quote") or "")
                if ledger_backed:
                    # This quote was reconstructed by Tomota from immutable byte
                    # offsets.  Truncating it here would silently sever the ledger
                    # grounding after the model-facing stages had already passed.
                    if len(quote) > 120:
                        raise ValueError("证据账本引文超过 120 字符")
                else:
                    quote = quote[:80]
                normalized_evidence.append({**item, "quote": quote})
            provenance["evidence"] = normalized_evidence
        return normalized

    def _validate_distilled_profile(self, author_id: str, profile: dict[str, Any], source_manifest: list[dict[str, Any]]) -> None:
        provenance = profile.get("provenance")
        if not isinstance(provenance, dict) or provenance.get("kind") != "distilled":
            return
        if not source_manifest:
            raise ValueError("蒸馏作者必须绑定真实来源，不能使用空 source_manifest")
        dimensions = profile.get("style_dimensions")
        blueprint = profile.get("application_blueprint")
        quality = profile.get("distillation_quality")
        if not isinstance(dimensions, list) or len(dimensions) < 66:
            raise ValueError("深度蒸馏至少需要 66 个 style_dimensions（六个方法轴各 10 个 + 文风轴覆盖）")
        if not isinstance(blueprint, dict) or not isinstance(quality, dict):
            raise ValueError("深度蒸馏缺少 application_blueprint 或 distillation_quality")
        if float(quality.get("corpus_coverage") or 0) != 100.0:
            raise ValueError("全文深度蒸馏 corpus_coverage 必须为 100")
        evidence = provenance.get("evidence") if isinstance(provenance.get("evidence"), list) else []
        evidence_by_id = {
            str(item.get("evidence_id") or ""): item for item in evidence
            if isinstance(item, dict) and str(item.get("evidence_id") or "")
        }
        allowed_sources = {str(item["source_id"]) for item in source_manifest}
        if any(str(item.get("source_id") or "") not in allowed_sources for item in evidence if isinstance(item, dict)):
            raise ValueError("蒸馏证据引用了未锁定的来源")
        raw_sources: dict[str, str] = {}
        for manifest_item in source_manifest:
            source = self.get_source(author_id, str(manifest_item["source_id"]))
            if not source or source.get("deleted_at"):
                raise ValueError("蒸馏来源已不可用，拒绝发布")
            text = (self.root / source["text_path"]).read_text(encoding="utf-8")
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != manifest_item.get("text_hash"):
                raise ValueError("蒸馏来源与冻结 text_hash 不一致，必须重新蒸馏")
            raw_sources[str(manifest_item["source_id"])] = text
        for evidence_item in evidence:
            if not isinstance(evidence_item, dict):
                continue
            quote = str(evidence_item.get("quote") or "").strip()
            source_id = str(evidence_item.get("source_id") or "")
            grounded = _ground_quote(raw_sources.get(source_id, ""), quote) if quote else None
            if not quote or grounded is None:
                raise ValueError(f"蒸馏证据未在来源原文中找到：{evidence_item.get('evidence_id') or source_id}")
            if grounded != quote:
                evidence_item["quote"] = grounded
        minimum_evidence = max(16, len(source_manifest) * 3)
        if len(evidence) < minimum_evidence:
            raise ValueError(f"深度蒸馏至少需要 {minimum_evidence} 条跨全文短证据")
        for source_id in allowed_sources:
            if sum(1 for item in evidence if isinstance(item, dict) and str(item.get("source_id") or "") == source_id) < 3:
                raise ValueError(f"来源 {source_id} 至少需要 3 条分散短证据")
        covered_axes = {str(item.get("axis") or "") for item in dimensions if isinstance(item, dict)}
        if len(covered_axes & AUTHOR_STYLE_AXES) < 12:
            raise ValueError("深度蒸馏必须覆盖至少 12 类不同文风轴")
        axis_counts: dict[str, int] = {}
        for item in dimensions:
            if isinstance(item, dict):
                axis_name = str(item.get("axis") or "")
                axis_counts[axis_name] = axis_counts.get(axis_name, 0) + 1
        for method_axis in ("worldbuilding_mechanics", "character_design_mechanics", "volume_architecture", "chapter_architecture", "scene_causality", "serial_rhythm"):
            axis_count = axis_counts.get(method_axis, 0)
            if axis_count < 10:
                raise ValueError(f"深度蒸馏的 {method_axis} 轴至少需要 10 个不同侧面的完整维度（当前 {axis_count} 个）；该轴将支撑对应方法分组的 10 条引用")
        for index, dimension in enumerate(dimensions):
            identifiers = [str(item) for item in dimension.get("evidence_ids", [])]
            if any(identifier not in evidence_by_id for identifier in identifiers):
                raise ValueError(f"style_dimensions[{index}] 引用了不存在的 evidence_id")
            cited_sources = {str(evidence_by_id[identifier].get("source_id") or "") for identifier in identifiers}
            cited_zones = {
                f"{evidence_by_id[identifier].get('source_id') or ''}:{evidence_by_id[identifier].get('phase_id') or evidence_by_id[identifier].get('segment_id') or evidence_by_id[identifier].get('location') or ''}"
                for identifier in identifiers
            }
            if dimension.get("scope") == "author_core" and len(source_manifest) > 1 and len(cited_sources) < 2:
                raise ValueError(f"跨作品作者核心 style_dimensions[{index}] 至少需要两部作品的证据")
            if dimension.get("scope") == "author_core" and len(source_manifest) == 1:
                dimension["confidence"] = min(float(dimension.get("confidence") or 0), 75.0)
            source_count = len(source_manifest)
            strong_minimum = max(2, math.ceil(source_count * 0.60))
            candidate_minimum = max(2, math.ceil(source_count * 0.40))
            scope = str(dimension.get("scope") or "uncertain")
            if scope == "author_core_strong":
                if source_count < 2 or len(cited_sources) < strong_minimum or len(cited_zones) < 2:
                    raise ValueError(f"style_dimensions[{index}] 未达到 60% 跨作品且跨阶段的强作者核心门槛")
                transfer = dimension.get("transfer_test")
                if not isinstance(transfer, dict) or transfer.get("verdict") != "pass":
                    raise ValueError(f"style_dimensions[{index}] 未通过题材反事实迁移，不能成为强作者核心")
            elif scope == "author_core_candidate" and len(cited_sources) < candidate_minimum:
                raise ValueError(f"style_dimensions[{index}] 未达到候选作者核心支持率")
            elif scope == "work_cluster" and len(cited_sources) < 2:
                raise ValueError(f"style_dimensions[{index}] 未达到作品簇支持率")

        # 关联引用必须指向同一 profile 内的真实维度，悬空引用 fail-closed。
        # 维度集合 = style_dimensions + story_design(世界观/人设方法) + book_architecture(结构方法)。
        story_design = profile.get("story_design")
        book_architecture = profile.get("book_architecture")
        ledger_run_id = str(provenance.get("ledger_run_id") or "") if isinstance(provenance, dict) else ""
        all_dimension_lists: list[tuple[str, list[Any]]] = []
        if isinstance(story_design, dict):
            for key in ("worldbuilding_mechanics", "character_design_mechanics"):
                value = story_design.get(key)
                if isinstance(value, list):
                    if ledger_run_id and len(value) < 10:
                        raise ValueError(f"story_design.{key} 方法分组必须至少引用 10 条不同侧面的完整维度（当前 {len(value)} 条）")
                    all_dimension_lists.append((key, value))
        if isinstance(book_architecture, dict):
            for key in ("volume", "chapter", "scene", "serial"):
                value = book_architecture.get(key)
                if isinstance(value, list):
                    if ledger_run_id and len(value) < 10:
                        raise ValueError(f"book_architecture.{key} 结构方法必须至少引用 10 条不同侧面的完整维度（当前 {len(value)} 条）")
                    all_dimension_lists.append((key, value))
        dimension_by_id = {str(item.get("id") or ""): item for item in dimensions if isinstance(item, dict)}
        dimension_ids = set(dimension_by_id)
        for group_name, dim_list in all_dimension_lists:
            expected_axis = _METHOD_GROUP_AXES.get(group_name)
            for item in dim_list:
                if not isinstance(item, dict):
                    continue
                reference = str(item.get("dimension_id") or "")
                if reference:
                    if reference not in dimension_ids:
                        raise ValueError(f"MethodReference 引用了不存在的完整维度 {reference}")
                    if expected_axis:
                        actual_axis = str((dimension_by_id.get(reference) or {}).get("axis") or "")
                        if actual_axis and actual_axis != expected_axis:
                            raise ValueError(f"{group_name} 结构方法引用的维度轴 {actual_axis} 与预期 {expected_axis} 不匹配")
                elif str(item.get("id") or ""):
                    dimension_ids.add(str(item.get("id") or ""))
        for index, dimension in enumerate(dimensions):
            for link in dimension.get("links", []) if isinstance(dimension.get("links"), list) else []:
                target = str((link or {}).get("dimension_id") or "") if isinstance(link, dict) else ""
                if target and target not in dimension_ids:
                    raise ValueError(f"style_dimensions[{index}] 的 links 引用了不存在的维度 {target}")

        # Evidence quotes are stored for audit, but no source wording may leak
        # into writing-facing rules or contracts.
        outward = json.loads(json.dumps(profile, ensure_ascii=False))
        outward.pop("provenance", None)
        candidate_strings: list[str] = []

        def collect(value: Any) -> None:
            if isinstance(value, str):
                candidate_strings.append(value)
            elif isinstance(value, list):
                for item in value:
                    collect(item)
            elif isinstance(value, dict):
                for item in value.values():
                    collect(item)

        collect(outward)
        source_texts = [re.sub(r"\s+", "", raw_source) for raw_source in raw_sources.values()]
        for candidate in candidate_strings:
            normalized = re.sub(r"\s+", "", candidate)
            if len(normalized) < 32:
                continue
            fragments = {normalized[start:start + 32] for start in range(0, len(normalized) - 31, 8)}
            if any(fragment in source for fragment in fragments for source in source_texts):
                raise ValueError("蒸馏候选包含来源原句片段；请改写为抽象、可执行的文风规则")

    @staticmethod
    def _extract_source(path: Path, extension: str) -> str:
        if extension in {".txt", ".md"}:
            raw = path.read_bytes()
            try:
                return raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                return raw.decode("gb18030")
        return AuthorService._extract_epub(path)

    @staticmethod
    def _extract_epub(path: Path) -> str:
        with zipfile.ZipFile(path) as archive:
            if sum(item.file_size for item in archive.infolist()) > 100 * 1024 * 1024:
                raise ValueError("EPUB 解压后内容超过 100 MB 安全限制")
            names = {_safe_zip_member(name): name for name in archive.namelist() if not name.endswith("/")}
            container_name = "META-INF/container.xml"
            if container_name not in names:
                raise ValueError("EPUB 缺少 META-INF/container.xml")
            container = ElementTree.fromstring(archive.read(names[container_name]))
            rootfile = next((item for item in container.iter() if item.tag.endswith("rootfile")), None)
            if rootfile is None or not rootfile.attrib.get("full-path"):
                raise ValueError("EPUB 缺少 OPF rootfile")
            opf_name = _safe_zip_member(rootfile.attrib["full-path"])
            if opf_name not in names:
                raise ValueError("EPUB OPF 文件不存在")
            opf = ElementTree.fromstring(archive.read(names[opf_name]))
            manifest: dict[str, str] = {}
            for item in opf.iter():
                if item.tag.endswith("item") and item.attrib.get("id") and item.attrib.get("href"):
                    manifest[item.attrib["id"]] = item.attrib["href"]
            spine = [item.attrib.get("idref", "") for item in opf.iter() if item.tag.endswith("itemref")]
            base = PurePosixPath(opf_name).parent
            parts: list[str] = []
            for item_id in spine:
                href = manifest.get(item_id)
                if not href:
                    continue
                member = _safe_zip_member(str(base / unquote(href.split("#", 1)[0])))
                if member not in names:
                    continue
                parser = _TextExtractor()
                parser.feed(archive.read(names[member]).decode("utf-8", errors="replace"))
                text = parser.text()
                if text:
                    parts.append(text)
            if not parts:
                raise ValueError("EPUB spine 没有可提取正文")
            return "\n\n".join(parts)

    @staticmethod
    def _text_metrics(text: str) -> dict[str, Any]:
        paragraphs = _paragraphs(text)
        sentences = _sentences(text)
        sentence_lengths = [sum(not char.isspace() for char in item) for item in sentences]
        paragraph_lengths = [sum(not char.isspace() for char in item) for item in paragraphs]
        dialogue_turns = [match.group(1).strip() for match in re.finditer(r"[“「『]([^”」』]{1,1000})[”」』]", text)]
        dialogue_lengths = [sum(not char.isspace() for char in item) for item in dialogue_turns]
        dialogue_characters = sum(dialogue_lengths)
        non_whitespace = sum(not char.isspace() for char in text)
        chapter_count = len(re.findall(r"(?m)^\s*(?:第[零一二三四五六七八九十百千万\d]+[章节回卷]|Chapter\s+\d+)", text, re.I))
        punctuation = Counter(char for char in text if any(char in marks for marks in PUNCTUATION_MARKS.values()))
        punctuation_rates = {
            name: round(sum(punctuation[char] for char in marks) * 1000 / max(1, non_whitespace), 3)
            for name, marks in PUNCTUATION_MARKS.items()
        }
        function_counts = {word: text.count(word) for word in CHINESE_FUNCTION_WORDS}
        signal_rates = {
            name: round(sum(text.count(word) for word in words) * 1000 / max(1, non_whitespace), 3)
            for name, words in STYLE_SIGNAL_LEXICONS.items()
        }
        paragraph_sentence_counts = [len(_sentences(item)) for item in paragraphs]
        chapter_units = [item for item in re.split(r"(?m)(?=^\s*(?:第[零一二三四五六七八九十百千万\d]+[章节回卷]|Chapter\s+\d+))", text, flags=re.I) if item.strip()]
        if chapter_count < 1:
            chapter_units = _analysis_chunks(text, target=8_000, maximum=36)
        opening_windows = [item[:400] for item in chapter_units]
        ending_windows = [item[-400:] for item in chapter_units]

        chunks = _analysis_chunks(text)
        chunk_signatures: list[dict[str, float]] = []
        for chunk in chunks:
            chunk_sentences = _sentences(chunk)
            chunk_paragraphs = _paragraphs(chunk)
            chunk_sentence_lengths = [sum(not char.isspace() for char in item) for item in chunk_sentences]
            chunk_dialogue = sum(len(match.group(1)) for match in re.finditer(r"[“「『]([^”」』]{1,1000})[”」』]", chunk))
            chunk_size = sum(not char.isspace() for char in chunk)
            chunk_signatures.append({
                "sentence_median": statistics.median(chunk_sentence_lengths) if chunk_sentence_lengths else 0.0,
                "paragraph_median": statistics.median([len(item) for item in chunk_paragraphs]) if chunk_paragraphs else 0.0,
                "dialogue_ratio": chunk_dialogue / max(1, chunk_size),
                "question_per_1000": sum(chunk.count(char) for char in "？?") * 1000 / max(1, chunk_size),
                "exclamation_per_1000": sum(chunk.count(char) for char in "！!") * 1000 / max(1, chunk_size),
                "cognition_per_1000": sum(chunk.count(word) for word in STYLE_SIGNAL_LEXICONS["cognition"]) * 1000 / max(1, chunk_size),
                "action_per_1000": sum(chunk.count(word) for word in STYLE_SIGNAL_LEXICONS["action"]) * 1000 / max(1, chunk_size),
            })
        chunk_stability: dict[str, Any] = {}
        for key in (chunk_signatures[0].keys() if chunk_signatures else []):
            values = [item[key] for item in chunk_signatures]
            center = statistics.median(values)
            spread = _quantile(values, 0.90) - _quantile(values, 0.10)
            scale = max(abs(center), 1.0 if "ratio" not in key else 0.05)
            chunk_stability[key] = {
                "median": round(center, 4), "p10": round(_quantile(values, 0.10), 4),
                "p90": round(_quantile(values, 0.90), 4),
                "stability": round(max(0.0, 100.0 * (1.0 - min(1.0, spread / scale))), 1),
            }
        even = chunk_signatures[::2]
        odd = chunk_signatures[1::2]
        holdout_scores: list[float] = []
        if even and odd:
            for key in even[0]:
                left = statistics.median(item[key] for item in even)
                right = statistics.median(item[key] for item in odd)
                scale = max(abs(left), abs(right), 1.0 if "ratio" not in key else 0.05)
                holdout_scores.append(1.0 - min(1.0, abs(left - right) / scale))
        markdown_artifacts = len(re.findall(r"(?m)^\s*(?:#{1,6}\s|[-*+]\s|```)|\*\*[^*]+\*\*", text))
        return {
            "schema_version": "transparent-chinese-stylometry-v2",
            "characters": len(text), "non_whitespace_characters": non_whitespace,
            "paragraphs": len(paragraphs), "sentences": len(sentences), "detected_chapters": chapter_count,
            "chapter_count": chapter_count or len(chapter_units),
            "average_sentence_length": round(sum(len(item) for item in sentences) / max(1, len(sentences)), 2),
            "average_paragraph_length": round(sum(len(item) for item in paragraphs) / max(1, len(paragraphs)), 2),
            "dialogue_character_ratio": round(dialogue_characters / max(1, non_whitespace), 4),
            "sentence_length": _distribution(sentence_lengths),
            "paragraph_length": _distribution(paragraph_lengths),
            "cadence": {
                "short_sentence_ratio": round(sum(length <= 12 for length in sentence_lengths) / max(1, len(sentence_lengths)), 4),
                "long_sentence_ratio": round(sum(length >= 35 for length in sentence_lengths) / max(1, len(sentence_lengths)), 4),
                "length_variation": _distribution(sentence_lengths)["cv"],
            },
            "paragraph_architecture": {
                "single_sentence_ratio": round(sum(count <= 1 for count in paragraph_sentence_counts) / max(1, len(paragraph_sentence_counts)), 4),
                "dialogue_only_ratio": round(sum(bool(re.fullmatch(r"\s*[“「『].*[”」』]\s*", item, re.S)) for item in paragraphs) / max(1, len(paragraphs)), 4),
            },
            "dialogue": {
                "character_ratio": round(dialogue_characters / max(1, non_whitespace), 4),
                "turn_count": len(dialogue_turns), "turn_length": _distribution(dialogue_lengths),
                "turn_length_median": _distribution(dialogue_lengths)["median"],
                "question_turn_ratio": round(sum(any(mark in item for mark in "？?") for item in dialogue_turns) / max(1, len(dialogue_turns)), 4),
                "exclamation_turn_ratio": round(sum(any(mark in item for mark in "！!") for item in dialogue_turns) / max(1, len(dialogue_turns)), 4),
            },
            "punctuation_per_1000": punctuation_rates,
            "function_words": {
                "total_per_1000": round(sum(function_counts.values()) * 1000 / max(1, non_whitespace), 3),
                "per_1000": {word: round(count * 1000 / max(1, non_whitespace), 3) for word, count in function_counts.items()},
            },
            "narrative_signals_per_1000": signal_rates,
            "lexical_shape": {"moving_character_type_token_ratio": _mattr_characters(text)},
            "chapter_architecture": {
                "unit_count": len(chapter_units),
                "opening_dialogue_ratio": round(sum(bool(re.search(r"[“「『]", item)) for item in opening_windows) / max(1, len(opening_windows)), 4),
                "ending_dialogue_ratio": round(sum(bool(re.search(r"[”」』]", item)) for item in ending_windows) / max(1, len(ending_windows)), 4),
                "ending_question_ratio": round(sum(bool(re.search(r"[？?]\s*$", item)) for item in ending_windows) / max(1, len(ending_windows)), 4),
                "ending_exclamation_ratio": round(sum(bool(re.search(r"[！!]\s*$", item)) for item in ending_windows) / max(1, len(ending_windows)), 4),
            },
            "format_quality": {"markdown_artifact_count": markdown_artifacts},
            "within_work_stability": {"chunk_count": len(chunks), "features": chunk_stability},
            "validation": {
                "method": "alternating_chunk_holdout",
                "holdout_consistency": round(100.0 * statistics.fmean(holdout_scores), 1) if holdout_scores else 0.0,
                "note": "留出一致性只验证文体信号跨片段稳定，不代表作品质量。",
            },
        }

    @staticmethod
    def _representative_excerpts(text: str, *, window: int = 1_200) -> list[dict[str, Any]]:
        clean = text.strip()
        values: list[dict[str, Any]] = []
        positions = [("opening", 0), ("middle", max(0, len(clean) // 2 - window // 2)), ("ending", max(0, len(clean) - window))]
        for label, start in positions:
            values.append({"kind": label, "offset": start, "text": clean[start:start + window]})
        dialogue = re.search(r"[“「『][^”」』]{80,1600}[”」』]", clean)
        if dialogue:
            start = max(0, dialogue.start() - 300)
            values.append({"kind": "dialogue", "offset": start, "text": clean[start:start + window]})
        narration = next((match for match in re.finditer(r"[^“「『\n]{300,1800}", clean) if "。" in match.group(0)), None)
        if narration:
            values.append({"kind": "narration", "offset": narration.start(), "text": narration.group(0)[:window]})
        return values

    @staticmethod
    def _profile_row(row: Any) -> dict[str, Any]:
        try:
            persona = json.loads(str(row["persona_json"] or "{}")) if "persona_json" in row.keys() else {}
        except json.JSONDecodeError:
            persona = {}
        return {
            "id": str(row["id"]), "name": str(row["name"]), "description": str(row["description"]),
            "persona": AuthorService.normalize_persona(persona),
            "status": str(row["status"]), "is_system": bool(row["is_system"]),
            "current_version_id": str(row["current_version_id"]) if "current_version_id" in row.keys() and row["current_version_id"] else None,
            "current_version_number": int(row["current_version_number"]) if "current_version_number" in row.keys() and row["current_version_number"] is not None else None,
            "draft_count": int(row["draft_count"]) if "draft_count" in row.keys() and row["draft_count"] is not None else 0,
            "source_count": int(row["source_count"]) if "source_count" in row.keys() and row["source_count"] is not None else 0,
            "binding_count": int(row["binding_count"]) if "binding_count" in row.keys() and row["binding_count"] is not None else 0,
            "created_at": str(row["created_at"]), "updated_at": str(row["updated_at"]),
        }

    @staticmethod
    def _version_row(row: Any) -> dict[str, Any]:
        return {
            "id": str(row["id"]), "author_id": str(row["author_id"]), "version_number": int(row["version_number"]),
            "status": str(row["status"]), "profile": json.loads(row["profile_json"]),
            "source_manifest": json.loads(row["source_manifest_json"]), "profile_hash": str(row["profile_hash"]),
            "created_at": str(row["created_at"]), "published_at": str(row["published_at"]) if row["published_at"] else None,
        }

    @staticmethod
    def _source_row(row: Any) -> dict[str, Any]:
        return {
            "id": str(row["id"]), "author_id": str(row["author_id"]), "original_name": str(row["original_name"]),
            "stored_path": str(row["stored_path"]), "media_type": str(row["media_type"]), "size_bytes": int(row["size_bytes"]),
            "sha256": str(row["sha256"]), "text_path": str(row["text_path"]), "text_hash": str(row["text_hash"]),
            "metrics": json.loads(row["metrics_json"]), "status": str(row["status"]),
            "rights_confirmed": bool(row["rights_confirmed"]), "created_at": str(row["created_at"]),
            "sort_order": int(row["sort_order"]),
            "deleted_at": str(row["deleted_at"]) if row["deleted_at"] else None,
        }
