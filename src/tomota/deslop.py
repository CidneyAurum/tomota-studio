from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_OH_STORY_SKILL_ROOT = Path.home() / ".codex" / "skills" / "oh-story-claudecode"


@dataclass
class DeslopFinding:
    rule_type: str
    severity: str  # "blocking" | "advisory" | "warning"
    line: int
    column: int
    message: str
    excerpt: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_type": self.rule_type,
            "severity": self.severity,
            "line": self.line,
            "column": self.column,
            "message": self.message,
            "excerpt": self.excerpt,
        }


def find_oh_story_root(skill_root: Path | str | None = None) -> Path | None:
    candidates = [
        Path(skill_root) if skill_root else None,
        Path(os.environ.get("TOMOTA_STORY_SKILL_ROOT", "")) if os.environ.get("TOMOTA_STORY_SKILL_ROOT") else None,
        DEFAULT_OH_STORY_SKILL_ROOT,
        Path.home() / ".codex" / "skills" / "webnovel-writing",
    ]
    for candidate in candidates:
        if candidate and candidate.is_dir() and ((candidate / "skills").is_dir() or (candidate / "SKILL.md").is_file()):
            return candidate.resolve()
    return None


def run_deslop_lint(
    content: str,
    *,
    skill_root: Path | str | None = None,
    allow_external_rules: bool = False,
) -> list[DeslopFinding]:
    """Run Tomota's deterministic, project-owned anti-template checks.

    External skill scripts are opt-in diagnostics only. They are disabled for
    normal generation/review paths so an installed package cannot silently
    change a book run.  The built-in Python rules always run and are the
    auditable baseline used by CLI, pipeline and strict workflow review.
    """
    findings: list[DeslopFinding] = []
    root = find_oh_story_root(skill_root) if allow_external_rules else None

    # 1. Try Node scripts if oh-story-claudecode scripts exist
    if root and (root / "skills" / "story-deslop" / "scripts" / "check-ai-patterns.js").is_file():
        script_dir = root / "skills" / "story-deslop" / "scripts"
        findings.extend(_run_node_script(script_dir / "check-ai-patterns.js", content))
        findings.extend(_run_node_script(script_dir / "check-degeneration.js", content))

    # 2. Python fallback & supplementary linting (ensures coverage even without node)
    python_findings = run_python_deslop_lint(content, root=root)

    # Merge and deduplicate findings by (line, rule_type, severity)
    seen = set()
    combined: list[DeslopFinding] = []
    for item in findings + python_findings:
        key = (item.line, item.rule_type, item.severity, item.message[:30])
        if key not in seen:
            seen.add(key)
            combined.append(item)

    return combined


def _run_node_script(script_path: Path, content: str) -> list[DeslopFinding]:
    findings: list[DeslopFinding] = []
    if not script_path.is_file():
        return findings
    try:
        import tempfile
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", delete=False) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)
        try:
            cmd = ["node", str(script_path), "--json", str(tmp_path)]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace")
            stdout = proc.stdout.strip()
            if stdout.startswith("{"):
                data = json.loads(stdout)
                for item in data.get("findings", []):
                    findings.append(DeslopFinding(
                        rule_type=item.get("type", "ai-pattern"),
                        severity=item.get("severity", "advisory"),
                        line=int(item.get("line", 1)),
                        column=int(item.get("column", 1)),
                        message=item.get("message", ""),
                        excerpt=item.get("excerpt", ""),
                    ))
        finally:
            if tmp_path.is_file():
                tmp_path.unlink(missing_ok=True)
    except Exception:
        pass
    return findings


ABSTRACT_PATTERNS = [
    ("气氛很微妙", "氛围空洞总结"),
    ("空气仿佛凝固", "空气凝固套话"),
    ("不禁感到", "心理转折套话"),
    ("心中涌起", "情绪抽象说明"),
    ("目光复杂", "眼神套话"),
    ("时间仿佛静止", "时间静止套话"),
    ("这一刻她明白", "总结体领悟"),
    ("这一刻他明白", "总结体领悟"),
    ("命运的齿轮", "作者总结套话"),
    ("深吸了一口气", "无意义动作垫字"),
    ("仿佛在诉说着", "拟人套话"),
    ("嘴角勾起一抹", "公式化微表情"),
    ("眼中闪过一丝", "公式化微表情"),
    ("缓缓开口", "公式化对话引导"),
]

EXPLANATION_PATTERNS = [
    ("她不知道的是", "上帝视角剧透"),
    ("他不知道的是", "上帝视角剧透"),
    ("殊不知", "上帝视角剧透"),
    ("这意味着", "替读者解释因果"),
    ("换句话说", "替读者重复解释"),
    ("不得不说", "作者跳出场景评价"),
    ("值得一提的是", "说明文式插入"),
    ("之所以", "解释腔因果铺陈"),
    ("多年以来", "跳出当下概述"),
    ("原来这一切", "作者回收式解释"),
]

PSYCHOLOGY_PATTERNS = [
    (re.compile(r"(?:他|她|我|[\u4e00-\u9fff]{2,4})(?:感到|感觉到|意识到|明白了|知道了)(?:一阵|一丝|无比|十分|非常|有些|些许)?(?:紧张|害怕|恐惧|愤怒|悲伤|失落|震惊|不安|绝望|欣慰|庆幸)"), "直接告知情绪或认知"),
    (re.compile(r"心(?:中|里)(?:不禁|顿时|忽然)?(?:涌起|升起|泛起|生出)(?:一股|一阵|一丝)?"), "抽象心理反应"),
]

PARALLEL_MARKER_RE = re.compile(
    r"(?:不是|没有|不曾|既不|也不|并非|无法|不会|不愿|不敢|不想)[^，,。！？!?\n]{1,24}[，,]"
)

BANNED_WORDS_CORE = [
    "不免", "不禁", "赫然", "宛若", "依稀", "蓦然", "隐隐", "悄然",
    "不言而喻", "不可名状", "显而易见", "毫无疑问", "不难看出",
    "与此同时", "就在这时", "殊不知",
]

# Small, deterministic blocking subset.  These patterns are deliberately
# narrow: they catch high-risk explanatory scaffolding while leaving ordinary
# dialogue and genre-specific diction to the semantic reviewer.
BLOCKING_PATTERNS = [
    (re.compile(r"不是[^。！？!?\n]{1,32}[，,。！？!?]\s*(?:而是|是)[^。！？!?\n]{1,40}"), "not-is-comparison", "否定铺垫后接肯定翻转，建议直接写后项或改为动作/细节"),
    (re.compile(r"声音(?:并)?不[大高响亮][^。！？!?\n]{0,20}[却但偏]"), "voice-contrast", "音量反差腔把效果写成解释，建议直接呈现声音造成的现场变化"),
    (re.compile(r"(?:没有[^。！？!?\n，,]{1,16}[，,]){2}"), "negation-parade", "连续否定清单容易形成模板腔，建议合并为具体动作或结果"),
]


def _line_column(source_line: str, stripped_line: str, stripped_column: int) -> int:
    """Convert a column in stripped text back to the original source line."""
    return len(source_line) - len(source_line.lstrip()) + stripped_column


def _append_phrase_findings(
    findings: list[DeslopFinding],
    *,
    line_number: int,
    source_line: str,
    stripped_line: str,
    phrases: list[tuple[str, str]],
    rule_type: str,
    severity: str,
    label: str,
    repair: str,
) -> None:
    """Report every deterministic phrase hit with an exact line/column."""
    for phrase, description in phrases:
        start = 0
        while True:
            column = stripped_line.find(phrase, start)
            if column < 0:
                break
            findings.append(DeslopFinding(
                rule_type=rule_type,
                severity=severity,
                line=line_number,
                column=_line_column(source_line, stripped_line, column + 1),
                message=f"发现{label}「{phrase}」（{description}），{repair}",
                excerpt=stripped_line,
            ))
            start = column + len(phrase)


def run_python_deslop_lint(content: str, *, root: Path | None = None) -> list[DeslopFinding]:
    """Pure-Python deterministic deslop checks.

    These are diagnostics rather than a prose authority: a finding asks for
    contextual review.  Engineering/meta leakage and a small set of highly
    formulaic explanatory constructions are blocking; the broader phrase and
    frequency checks remain warning/advisory signals.  This keeps the neutral
    writing kernel intact while preserving the dedicated anti-AI quality gate
    in every workflow review.
    """
    findings: list[DeslopFinding] = []
    lines = content.splitlines()

    for idx, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped:
            continue

        for pattern, rule_type, message in BLOCKING_PATTERNS:
            match = pattern.search(stripped)
            if match:
                findings.append(DeslopFinding(
                    rule_type=rule_type,
                    severity="blocking",
                    line=idx,
                    column=_line_column(line, stripped, match.start() + 1),
                    message=message,
                    excerpt=stripped,
                ))

        _append_phrase_findings(
            findings,
            line_number=idx,
            source_line=line,
            stripped_line=stripped,
            phrases=ABSTRACT_PATTERNS,
            rule_type="abstract-cliché",
            severity="warning",
            label="抽象套话",
            repair="建议改为具体动作或感官细节",
        )
        _append_phrase_findings(
            findings,
            line_number=idx,
            source_line=line,
            stripped_line=stripped,
            phrases=EXPLANATION_PATTERNS,
            rule_type="explanation-cliché",
            severity="warning",
            label="解释腔",
            repair="建议交给动作、物件或对白呈现",
        )

        for pattern, description in PSYCHOLOGY_PATTERNS:
            for match in pattern.finditer(stripped):
                findings.append(DeslopFinding(
                    rule_type="psychological-telling",
                    severity="warning",
                    line=idx,
                    column=_line_column(line, stripped, match.start() + 1),
                    message=f"发现心理告知「{match.group(0)}」（{description}），建议外化为身体反应、动作或选择",
                    excerpt=stripped,
                ))

        parallel_matches = list(PARALLEL_MARKER_RE.finditer(stripped))
        if len(parallel_matches) >= 3:
            findings.append(DeslopFinding(
                rule_type="formulaic-parallelism",
                severity="warning",
                line=idx,
                column=_line_column(line, stripped, parallel_matches[0].start() + 1),
                message=f"发现连续 {len(parallel_matches)} 组否定/并列铺排，建议保留必要信息并压成一次判断或动作",
                excerpt=stripped,
            ))

        hits = [word for word in BANNED_WORDS_CORE if word in stripped]
        for word in hits:
            findings.append(DeslopFinding(
                rule_type="banned-word",
                severity="advisory",
                line=idx,
                column=_line_column(line, stripped, stripped.find(word) + 1),
                message=f"命中高频 AI 套词「{word}」，需结合语境判断是否改为具体表达",
                excerpt=stripped,
            ))
        if len(hits) >= 2:
            findings.append(DeslopFinding(
                rule_type="banned-words-density",
                severity="advisory",
                line=idx,
                column=_line_column(line, stripped, 1),
                message=f"单句聚集高频 AI 连接词：{', '.join(hits)}",
                excerpt=stripped,
            ))

        # Check placeholder / AI meta leakage
        if re.search(r"作为(一个)?(AI|人工智能|大语言模型|助手)", stripped):
            findings.append(DeslopFinding(
                rule_type="meta-leakage",
                severity="blocking",
                line=idx,
                column=_line_column(line, stripped, 1),
                message="检测到 AI 自指元信息泄漏",
                excerpt=stripped,
            ))

        # Check engineering leaks (e.g. 本章总结 / 细纲情节点 / 目标字数)
        if re.search(r"^(?:【?本章(?:字数|目标|小结|大纲|线索)|情节点\s*\d+)", stripped):
            findings.append(DeslopFinding(
                rule_type="engineering-leak",
                severity="blocking",
                line=idx,
                column=_line_column(line, stripped, 1),
                message="检测到工程/大纲标记泄漏进正文",
                excerpt=stripped,
            ))

    return findings


_PAUSE_TOKEN_RE = re.compile(r"\.{3,}|…{2,}|-{2,}|—{2,}")
_SENTENCE_PUNCTUATION = "，,。.!！?？;；:：、…—"
_CLOSING_DELIMITERS = "”」』）)]】"
_OPENING_DELIMITERS = "“「『（([【"


def _previous_non_space(text: str, index: int) -> str:
    while index >= 0:
        if not text[index].isspace():
            return text[index]
        index -= 1
    return ""


def _next_non_space(text: str, index: int) -> str:
    while index < len(text):
        if not text[index].isspace():
            return text[index]
        index += 1
    return ""


def _normalize_pause_token(text: str, match: re.Match[str]) -> str:
    """Normalize malformed pause tokens without deleting functional pauses."""
    token = match.group(0)
    before = _previous_non_space(text, match.start() - 1)
    after = _next_non_space(text, match.end())

    # Numeric ranges are data, not dialogue pauses.
    if before.isdigit() and after.isdigit() and ("-" in token or "—" in token):
        return "—"
    # Do not manufacture punctuation immediately inside a quote/bracket edge.
    if before in _OPENING_DELIMITERS or after in _CLOSING_DELIMITERS and before in _SENTENCE_PUNCTUATION:
        return ""
    if "." in token or "…" in token:
        return "……"
    return "——"


def _normalize_quotes(text: str, quote_mode: str) -> str:
    if quote_mode == "keep":
        return text
    if quote_mode == "ascii":
        return text.translate(str.maketrans({"「": '"', "」": '"', "『": "'", "』": "'", "“": '"', "”": '"', "‘": "'", "’": "'"}))

    output: list[str] = []
    double_open = True
    single_open = True
    for char in text:
        if char in {'"', "“", "”"}:
            output.append("「" if double_open else "」")
            double_open = not double_open
        elif char in {"'", "‘", "’"}:
            output.append("『" if single_open else "』")
            single_open = not single_open
        else:
            output.append(char)
    return "".join(output)


def normalize_punctuation(text: str, *, quote_mode: str = "keep") -> str:
    """Repair mechanical punctuation residue while preserving narrative use.

    The normalizer deliberately does not remove functional question marks,
    exclamation marks, ellipses or em dashes.  It only canonicalizes malformed
    ASCII/repeated forms, markdown divider lines and an explicitly requested
    quote style.  Original line endings and a final newline are preserved.
    """
    if quote_mode not in {"keep", "yan", "ascii"}:
        raise ValueError(f"unsupported quote_mode: {quote_mode}")

    parts = re.split(r"(\r\n|\n|\r)", text)
    normalized_parts: list[str] = []
    for index, part in enumerate(parts):
        if index % 2 == 1:
            normalized_parts.append(part)
            continue

        if re.fullmatch(r"\s*[-*_]{3,}\s*", part):
            # Drop the divider content but leave its captured newline in place.
            continue

        normalized = _PAUSE_TOKEN_RE.sub(lambda match: _normalize_pause_token(part, match), part)
        normalized = re.sub(r"(?<!\d),(?!\d)", "，", normalized)
        normalized = re.sub(r"(?<!\d)\.(?!\d)", "。", normalized)
        normalized = re.sub(r"(?<!\d);(?!\d)", "；", normalized)
        normalized = re.sub(r"(?<!\d):(?!\d)", "：", normalized)
        normalized = normalized.replace("?", "？").replace("!", "！")
        normalized_parts.append(_normalize_quotes(normalized, quote_mode))

    return "".join(normalized_parts)
