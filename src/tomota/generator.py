from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import urllib.error
import urllib.request
from dataclasses import asdict
from pathlib import Path
from typing import Protocol

from .models import ChapterContract, GenerationArtifact, PromptPack


class Generator(Protocol):
    def generate_outline(self, prompt_pack: PromptPack, synopsis: str) -> GenerationArtifact: ...

    def generate_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict) -> GenerationArtifact: ...

    def revise_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict, previous: str, feedback: str) -> GenerationArtifact: ...


class PromptOnlyGenerator:
    """Creates traceable prompt artifacts for the current Codex conversation.

    The installed skill is an instruction/knowledge runtime, not a local model
    endpoint. This generator is therefore the safe default for production: it
    never invents a fake model result and never stores API credentials.
    """

    def generate_outline(self, prompt_pack: PromptPack, synopsis: str) -> GenerationArtifact:
        text = prompt_pack.render() + f"\n\n## 用户简介\n{synopsis}\n\n请按 skill 路由先完成题材诊断，再输出最小可执行骨架。\n"
        return GenerationArtifact("prompt", text, prompt_pack, {"operation": "outline"})

    def generate_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict) -> GenerationArtifact:
        context = _contract_context(contract, canon)
        text = prompt_pack.render() + f"\n\n## 本章上下文\n{context}\n\n先写桥梁计划，再写正文；正文完成后输出 consistency_review 所需的审查数据。\n"
        return GenerationArtifact("prompt", text, prompt_pack, {"operation": "chapter", "chapter_number": contract.chapter_number})

    def revise_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict, previous: str, feedback: str) -> GenerationArtifact:
        text = prompt_pack.render() + f"\n\n## 原章节\n{previous}\n\n## 审查反馈\n{feedback}\n\n只修复反馈对应的问题，保留已成立的剧情和人物状态，重新输出完整章节。\n"
        return GenerationArtifact("prompt", text, prompt_pack, {"operation": "revise", "chapter_number": contract.chapter_number})


class GeneratorConfigurationError(RuntimeError):
    """Raised when an autonomous model runner has not been configured safely."""


class CommandGenerator:
    """Call a user-owned local model runner through stdin/stdout.

    The command receives one JSON request and may return either plain UTF-8
    text or ``{"text": "..."}``.  This keeps Tomota independent of a model
    vendor while allowing ``tomota autopilot`` to run without chapter-by-
    chapter intervention.  Secrets stay in the child process environment.
    """

    def __init__(self, command: str, *, timeout_seconds: int = 900):
        if not command.strip():
            raise GeneratorConfigurationError("TOMOTA_GENERATOR_COMMAND 为空")
        self.command = command
        self.timeout_seconds = timeout_seconds

    def generate_outline(self, prompt_pack: PromptPack, synopsis: str) -> GenerationArtifact:
        text = self._call({
            "operation": "outline",
            "prompt_pack": prompt_pack.render(),
            "synopsis": synopsis,
        })
        return GenerationArtifact("text", text, prompt_pack, {"operation": "outline", "runner": "command"})

    def generate_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict) -> GenerationArtifact:
        text = self._call({
            "operation": "chapter",
            "prompt_pack": prompt_pack.render(),
            "contract": contract.to_dict(),
            "canon": canon,
        })
        return GenerationArtifact("text", text, prompt_pack, {"operation": "chapter", "runner": "command"})

    def revise_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict, previous: str, feedback: str) -> GenerationArtifact:
        text = self._call({
            "operation": "revise",
            "prompt_pack": prompt_pack.render(),
            "contract": contract.to_dict(),
            "canon": canon,
            "previous": previous,
            "feedback": feedback,
        })
        return GenerationArtifact("text", text, prompt_pack, {"operation": "revise", "runner": "command"})

    def _call(self, payload: dict) -> str:
        try:
            command = shlex.split(self.command, posix=False)
            completed = subprocess.run(
                command,
                input=json.dumps(payload, ensure_ascii=False),
                text=True,
                capture_output=True,
                encoding="utf-8",
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            raise GeneratorConfigurationError(f"模型运行命令不存在：{command[0] if command else self.command}") from exc
        except subprocess.TimeoutExpired as exc:
            raise GeneratorConfigurationError(f"模型运行超时（>{self.timeout_seconds} 秒）") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()[-2000:]
            raise GeneratorConfigurationError(f"模型运行命令失败（{completed.returncode}）：{detail}")
        output = completed.stdout.strip()
        if not output:
            raise GeneratorConfigurationError("模型运行命令没有返回正文")
        try:
            value = json.loads(output)
        except json.JSONDecodeError:
            return output
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            return value["text"].strip()
        raise GeneratorConfigurationError("模型运行命令必须返回纯文本或 {\"text\": \"...\"}")


class OpenAIResponsesGenerator:
    """Minimal dependency-free OpenAI Responses API adapter.

    It is opt-in through ``OPENAI_API_KEY``/``TOMOTA_OPENAI_MODEL``.  The key
    is read only from the environment and is never written to project files.
    """

    def __init__(self, api_key: str, *, model: str = "gpt-5.4", timeout_seconds: int = 900, endpoint: str = "https://api.openai.com/v1/responses"):
        if not api_key:
            raise GeneratorConfigurationError("未找到 OPENAI_API_KEY")
        self.api_key = api_key
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.endpoint = endpoint

    def generate_outline(self, prompt_pack: PromptPack, synopsis: str) -> GenerationArtifact:
        text = self._call(prompt_pack.render(), f"请完成前置规划。\n\n简介：\n{synopsis}")
        return GenerationArtifact("text", text, prompt_pack, {"operation": "outline", "runner": "openai", "model": self.model})

    def generate_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict) -> GenerationArtifact:
        text = self._call(prompt_pack.render(), "请先输出桥梁计划，再输出完整正文。\n\n本章契约：\n" + _contract_context(contract, canon))
        return GenerationArtifact("text", text, prompt_pack, {"operation": "chapter", "runner": "openai", "model": self.model})

    def revise_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict, previous: str, feedback: str) -> GenerationArtifact:
        user_input = (
            "只修复审查反馈对应的问题，输出完整章节，不要解释修复过程。\n\n"
            f"本章契约：\n{_contract_context(contract, canon)}\n\n"
            f"原章节：\n{previous}\n\n审查反馈：\n{feedback}"
        )
        text = self._call(prompt_pack.render(), user_input)
        return GenerationArtifact("text", text, prompt_pack, {"operation": "revise", "runner": "openai", "model": self.model})

    def _call(self, instructions: str, user_input: str) -> str:
        payload = {
            "model": self.model,
            "instructions": instructions,
            "input": user_input,
        }
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                value = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[-2000:]
            raise GeneratorConfigurationError(f"模型接口返回 HTTP {exc.code}：{detail}") from exc
        except urllib.error.URLError as exc:
            raise GeneratorConfigurationError(f"模型接口无法连接：{exc.reason}") from exc
        text = value.get("output_text") if isinstance(value, dict) else None
        if not text and isinstance(value, dict):
            chunks = []
            for item in value.get("output", []):
                for content in item.get("content", []):
                    if isinstance(content, dict) and isinstance(content.get("text"), str):
                        chunks.append(content["text"])
            text = "\n".join(chunks)
        if not isinstance(text, str) or not text.strip():
            raise GeneratorConfigurationError("模型接口没有返回可用正文")
        return text.strip()


def generator_from_environment(mode: str = "auto") -> Generator:
    """Resolve the one autonomous runner used by a batch job.

    ``auto`` prefers a local command, then the Responses API, and finally
    returns PromptOnlyGenerator so a run can produce one consolidated handoff
    instead of failing chapter by chapter.
    """
    selected = (mode or "auto").lower()
    if selected == "mock":
        return MockGenerator()
    if selected == "prompt":
        return PromptOnlyGenerator()
    if selected in {"command", "auto"} and os.environ.get("TOMOTA_GENERATOR_COMMAND"):
        return CommandGenerator(os.environ["TOMOTA_GENERATOR_COMMAND"], timeout_seconds=int(os.environ.get("TOMOTA_GENERATOR_TIMEOUT", "900")))
    if selected in {"openai", "auto"} and os.environ.get("OPENAI_API_KEY"):
        return OpenAIResponsesGenerator(
            os.environ["OPENAI_API_KEY"],
            model=os.environ.get("TOMOTA_OPENAI_MODEL", "gpt-5.4"),
            timeout_seconds=int(os.environ.get("TOMOTA_GENERATOR_TIMEOUT", "900")),
        )
    if selected in {"command", "openai"}:
        raise GeneratorConfigurationError(
            "没有可用的自动生成运行时；请设置 TOMOTA_GENERATOR_COMMAND 或 OPENAI_API_KEY。"
        )
    return PromptOnlyGenerator()


class MockGenerator:
    """Deterministic generator used by tests and local pipeline smoke runs."""

    def generate_outline(self, prompt_pack: PromptPack, synopsis: str) -> GenerationArtifact:
        outline = "# 一句话 Hook\n主角在异常局面中被迫作出选择，并因此启动一条持续升级的故事引擎。\n\n# 第一卷\n- 卷目标：建立主线冲突\n- 卷核心冲突：主角与持续阻力正面碰撞\n- 卷高潮：主角完成一次不可逆选择\n- 卷末变化：局面升级，旧规则失效\n\n# 前20章章纲\n- 第1章：异常事件迫使主角行动\n- 第2章：卖点显形，代价出现\n- 第3章：主角第一次反制\n"
        return GenerationArtifact("text", outline, prompt_pack, {"operation": "outline", "mock": True})

    def generate_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict) -> GenerationArtifact:
        paragraphs = [
            f"{contract.title}",
            f"{contract.objective}。主角没有等到局面自行变好，而是先做出了决定。",
            f"{contract.obstacle}立刻出现，原本简单的选择被推到了更高的代价上。",
            f"{contract.change}。这一拍之后，主角已经不能回到原来的位置。",
            contract.chapter_hook or contract.next_first_beat or "门外传来第二次敲门声。",
        ]
        return GenerationArtifact("text", "\n\n".join(paragraphs) + "\n", prompt_pack, {"operation": "chapter", "mock": True})

    def revise_chapter(self, prompt_pack: PromptPack, contract: ChapterContract, canon: dict, previous: str, feedback: str) -> GenerationArtifact:
        # Keep the revision deterministic and visibly different for the retry test.
        suffix = "\n\n" + (contract.next_first_beat or "新的信息打断了原计划。") + "\n"
        return GenerationArtifact("text", previous.rstrip() + suffix, prompt_pack, {"operation": "revise", "mock": True})


def _contract_context(contract: ChapterContract, canon: dict) -> str:
    lines = [
        f"章节：第{contract.chapter_number}章《{contract.title}》",
        f"本章目标：{contract.objective}",
        f"本章阻碍：{contract.obstacle}",
        f"本章变化：{contract.change}",
        f"本章新信息：{contract.new_information}",
        f"章末拉力：{contract.chapter_hook}",
        f"上一章遗留力量：{contract.previous_force}",
        f"下一章第一拍：{contract.next_first_beat}",
        f"人物当前目标：{contract.current_character_goal}",
        f"关系状态：{contract.relationship_state}",
        f"身体与信息状态：{contract.body_information_state}",
        f"未兑现伏笔：{contract.unresolved_foreshadowing}",
        f"章末类型：{contract.ending_type}",
        f"目标字数：{contract.target_word_count}",
        f"当前 Canon：{canon}",
    ]
    return "\n".join(lines)
