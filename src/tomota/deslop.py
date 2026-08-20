from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
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


def run_deslop_lint(content: str, *, skill_root: Path | str | None = None) -> list[DeslopFinding]:
    """Run full deslop lint (Node scripts if available, plus Python rules)."""
    findings: list[DeslopFinding] = []
    root = find_oh_story_root(skill_root)

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
    ("命运的齿轮", "命运齿轮套话"),
    ("深吸了一口气", "无意义动作垫字"),
    ("仿佛在诉说着", "拟人套话"),
]

BANNED_WORDS_CORE = [
    "不免", "不禁", "赫然", "宛若", "依稀", "蓦然", "隐隐", "悄然",
    "不言而喻", "不可名状", "显而易见", "毫无疑问", "不难看出",
    "与此同时", "就在这时", "殊不知",
]


def run_python_deslop_lint(content: str, *, root: Path | None = None) -> list[DeslopFinding]:
    """Pure-Python deslop linter for deterministic checks."""
    findings: list[DeslopFinding] = []
    lines = content.splitlines()

    for idx, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped:
            continue

        # Check AI clichés
        for phrase, desc in ABSTRACT_PATTERNS:
            if phrase in stripped:
                col = stripped.find(phrase) + 1
                findings.append(DeslopFinding(
                    rule_type="abstract-cliché",
                    severity="warning",
                    line=idx,
                    column=col,
                    message=f"发现抽象套话「{phrase}」（{desc}），建议改为具体动作或感官细节",
                    excerpt=stripped,
                ))

        # Check banned words density
        hits = [w for w in BANNED_WORDS_CORE if w in stripped]
        if len(hits) >= 2:
            findings.append(DeslopFinding(
                rule_type="banned-words-density",
                severity="advisory",
                line=idx,
                column=1,
                message=f"单句聚集高频AI连接词：{', '.join(hits)}",
                excerpt=stripped,
            ))

        # Check placeholder / AI meta leakage
        if re.search(r"作为(一个)?(AI|人工智能|大语言模型|助手)", stripped):
            findings.append(DeslopFinding(
                rule_type="meta-leakage",
                severity="blocking",
                line=idx,
                column=1,
                message="检测到 AI 自指元信息泄漏",
                excerpt=stripped,
            ))

        # Check engineering leaks (e.g. 本章总结 / 细纲情节点 / 目标字数)
        if re.search(r"^(?:【?本章(?:字数|目标|小结|大纲|线索)|情节点\s*\d+)", stripped):
            findings.append(DeslopFinding(
                rule_type="engineering-leak",
                severity="blocking",
                line=idx,
                column=1,
                message="检测到工程/大纲标记泄漏进正文",
                excerpt=stripped,
            ))

    return findings


def normalize_punctuation(text: str, *, quote_mode: str = "keep") -> str:
    """Normalize novel text punctuation into standardized Chinese publishing format."""
    lines = text.splitlines()
    normalized_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        # Remove standalone markdown divider lines
        if re.match(r"^[-*_]{3,}$", stripped):
            continue

        s = line
        # Replace English ellipses and dashes
        s = re.sub(r"\.{3,}", "……", s)
        s = re.sub(r"…{3,}", "……", s)
        s = re.sub(r"-{2,}", "——", s)
        s = re.sub(r"—{3,}", "——", s)

        # Fix English commas and periods outside numbers
        s = re.sub(r"(?<!\d),(?!\d)", "，", s)
        s = re.sub(r"(?<!\d)\.(?!\d)", "。", s)
        s = re.sub(r"(?<!\d);(?!\d)", "；", s)
        s = re.sub(r"(?<!\d):(?!\d)", "：", s)
        s = re.sub(r"\?", "？", s)
        s = re.sub(r"!", "！", s)

        if quote_mode == "yan":
            s = s.replace("“", "「").replace("”", "」").replace("‘", "『").replace("’", "』")
        elif quote_mode == "ascii":
            s = s.replace("「", "“").replace("」", "”").replace("『", "‘").replace("』", "’")

        normalized_lines.append(s)

    return "\n".join(normalized_lines)
