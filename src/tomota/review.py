from __future__ import annotations

import hashlib
import re

from .deslop import run_deslop_lint
from .models import ChapterContract, ReviewFinding, ReviewGate, ReviewItem, ReviewReport
from .router import SkillRouter
from .skill_adapter import SkillAdapter


CATEGORIES = ["剧情逻辑", "人物目标", "情绪关系", "身体信息", "场景转场", "章末承接"]
ABSTRACT_PATTERNS = ["气氛很微妙", "空气仿佛凝固", "不禁感到", "心中涌起", "目光复杂", "时间仿佛静止", "这一刻她明白"]
STRICT_GATES = ["design_review", "review_logic", "review_voice", "review_continuity", "cold_review"]


class ChapterReviewer:
    """Fail-closed lint used alongside Codex semantic reviews."""

    def __init__(self, skill: SkillAdapter, router: SkillRouter):
        self.skill = skill
        self.router = router

    def review(self, contract: ChapterContract, content: str, revision_round: int = 0, *, gates: list[ReviewGate] | None = None) -> ReviewReport:
        items: list[ReviewItem] = []
        hard_failures: list[str] = []
        missing = [name for name, value in {
            "本章目标": contract.objective, "本章阻碍": contract.obstacle,
            "本章变化": contract.change, "下一章第一拍": contract.next_first_beat,
        }.items() if not value.strip()]
        if not content.strip():
            hard_failures.append("正文为空")
        if missing:
            hard_failures.append("章节契约缺少：" + ", ".join(missing))
        paragraphs = [item.strip() for item in re.split(r"\n\s*\n", content) if item.strip()]
        duplicate_count = len(paragraphs) - len(set(paragraphs))
        if duplicate_count:
            hard_failures.append(f"检测到重复段落 {duplicate_count} 个")

        for category in CATEGORIES:
            status, summary, evidence, severity = self._check_category(category, contract, content, paragraphs)
            route = self.router.next_route_after_failure(category) if status != "稳" else []
            items.append(ReviewItem(category, status, summary, evidence, route, severity))

        # Deep Deslop Lint from oh-story-claudecode engine
        deslop_findings = run_deslop_lint(content, skill_root=self.skill.root)
        blockers = [f for f in deslop_findings if f.severity == "blocking"]
        warnings = [f for f in deslop_findings if f.severity in ("warning", "advisory")]

        if blockers:
            hard_failures.extend(f"去AI味门禁@{f.line}行：{f.message}" for f in blockers)
            items.append(ReviewItem(
                "去AI味",
                "不稳",
                f"命中 {len(blockers)} 项高风险 AI 退化/套话硬性门禁",
                [f"第{f.line}行：{f.message} ({f.excerpt[:30]})" for f in blockers],
                ["anti_ai_voice"],
                "blocker",
            ))
        elif warnings:
            items.append(ReviewItem(
                "去AI味",
                "需修",
                f"发现 {len(warnings)} 处套话或连接词聚集提示",
                [f"第{f.line}行：{f.message}" for f in warnings[:5]],
                ["anti_ai_voice"],
                "warning",
            ))
        else:
            items.append(ReviewItem("去AI味", "稳", "未命中内置套话与退化样本", ["扫描范围：全文；规则集：oh-story deslop v0.7.6+"], [], "info"))

        deterministic = self.lint(content)
        if deterministic:
            hard_failures.extend(f"{item.category}@{item.location}：{item.diagnosis}" for item in deterministic)
            items.append(ReviewItem("专项回归", "不稳", f"命中 {len(deterministic)} 条已知失效模式", [f"{item.location}｜{item.quote}" for item in deterministic], sorted(set(item.gate for item in deterministic)), "blocker"))
        else:
            items.append(ReviewItem("专项回归", "稳", "未命中已知失效样本", ["规则集版本：tomota-regression-v2"], [], "info"))

        length = sum(1 for char in content if not char.isspace())
        if contract.target_word_count and length < max(50, int(contract.target_word_count * 0.75)):
            hard_failures.append(f"正文长度低于目标字数 75%：实有 {length}，目标 {contract.target_word_count}")
        if self._ending_is_summary(content):
            hard_failures.append("章末收在总结/讲理，未形成可承接的变化")

        supplied = {gate.gate: gate for gate in (gates or [])}
        strict_ready = set(supplied) == set(STRICT_GATES)
        for name in STRICT_GATES:
            semantic = supplied.get(name)
            if not semantic:
                hard_failures.append(f"缺少严格审查门：{name}")
            elif not semantic.evidence or not all(str(item).strip() for item in semantic.evidence):
                hard_failures.append(f"审查门证据为空：{name}")
            elif not semantic.passed or any(item.status == "open" for item in semantic.findings):
                hard_failures.append(f"审查门未关闭：{name}")

        passed = strict_ready and not hard_failures
        return ReviewReport(contract.book_id, contract.chapter_number, passed, items, list(dict.fromkeys(hard_failures)), revision_round, self.skill.inspect().skill_version_hash, list(gates or []), bool(gates))

    def lint(self, content: str, *, gate: str | None = None) -> list[ReviewFinding]:
        findings: list[ReviewFinding] = []

        def add(match: re.Match[str], item_gate: str, category: str, rule: str, repair: str, diagnosis: str) -> None:
            if gate and gate != item_gate:
                return
            line = content.count("\n", 0, match.start()) + 1
            quote = match.group(0).strip()
            digest = hashlib.sha1(f"{item_gate}:{line}:{quote}".encode("utf-8")).hexdigest()[:10]
            findings.append(ReviewFinding(f"lint-{digest}", item_gate, "blocker", category, f"第{line}行", quote, rule, repair, diagnosis))

        patterns = [
            (r"这里写的是维拉·安瑟[？?]", "review_voice", "姓名对白", "对白必须由说话者目的与既有信息驱动", "明确说话者，并改成符合其试探/核验目的的自然问法", "问句缺少可辨识的说话动机"),
            (r"她不让我叫名字", "review_voice", "隐瞒姓名", "中文对白应符合场景口语与人物关系", "改写为具体禁令或回避动作，避免逐词翻译腔", "表达生硬且信息对象不清"),
            (r"只有一行字[。；;：:]?\s*[“\"]?你杀错人了", "review_logic", "核心揭示", "改变主线判断的物证必须获得特写、读取与即时后果", "补足纸面细节、读取者反应及由此触发的选择", "核心信件被一句话带过"),
            (r"第十三(?:声|响)[\s\S]{0,240}?第二次敲击", "review_continuity", "计数连续性", "同一计数序列必须保持术语和次数连续", "明确第二次属于哪个新序列，或改写为第十四次并交代规则", "第十三响后出现无归属的第二次敲击"),
            (r"墙后有耳朵", "review_voice", "翻译腔", "固定表达必须符合中文习惯或世界内具体威胁", "改为“隔墙有耳”或写明墙后具体监听者/装置", "疑似英语表达直译"),
            (r"奥斯温没有回答", "review_voice", "悬空回应", "回答/沉默必须有紧邻且明确的问题对象", "在前文补出具体问题，或改写成与前一句动作对应的沉默", "“没有回答”缺少清晰提问对象"),
        ]
        for expression, item_gate, category, rule, repair, diagnosis in patterns:
            for match in re.finditer(expression, content):
                add(match, item_gate, category, rule, repair, diagnosis)

        # Regression patterns
        east_booth = re.search(r"东亭", content)
        anchored_east_booth = content.find("圣钟广场东侧的记录亭")
        if east_booth and (anchored_east_booth < 0 or anchored_east_booth > east_booth.start()):
            add(east_booth, "review_logic", "名词锚定", "地点简称首次出现前必须交代全称与功能", "先写出‘圣钟广场东侧的记录亭’及其记录职能，再使用‘东亭’", "读者无法从首次出现判断‘东亭’是什么")
        for expression, item_gate, category, rule, repair, diagnosis in [
            (r"手伸进桌下，握住短刀", "review_logic", "动作动机", "突发防卫动作必须有职业、威胁或前置状态支撑", "删除该动作，或在此前写明具体威胁与该人物的合理防卫程序", "记录员无可见威胁时突然握刀，反应与人物职业不连贯"),
            (r"这不证明寄信人是维拉。\s*但有人知道那枚戒指，也知道原判在谁手里。", "review_logic", "证据链", "推理必须把物证连接到可执行判断", "写清蜡印与原判问题分别证明什么、排除什么，以及因此为何锁定下一位对象", "用泛化结论代替了证据的推导过程"),
            (r"脸没看清", "review_logic", "信息来源", "关键身份来源不能以无支撑的视觉缺失搪塞", "改为可核验的交接流程、物证或明确限制，并说明其可信度边界", "‘脸没看清’无法解释为何接受或怀疑该命令"),
        ]:
            for match in re.finditer(expression, content):
                add(match, item_gate, category, rule, repair, diagnosis)
        for match in re.finditer(r"(?:去找|寻找|要见|找到了?)奥斯温", content):
            context = content[max(0, match.start() - 120):match.start()]
            if not any(marker in context for marker in ("因为", "为了", "线索", "信上", "纸条", "地址", "知道", "只有他", "问清")):
                add(match, "review_logic", "行动动机", "关键行动必须由前文线索或人物目标触发", "在行动前补出为何是奥斯温、线索从何而来及不去的代价", "寻找奥斯温缺少可见动机")
        return findings

    def build_review_prompt(self, contract: ChapterContract, content: str, gate: str = "review_logic") -> str:
        module = {"review_logic": "plot_logic", "review_voice": "dialogue", "review_continuity": "consistency_review", "cold_review": "consistency_review"}.get(gate, "consistency_review")
        pack = self.skill.build_prompt_pack(task=f"审查第{contract.chapter_number}章：{contract.title}", stage=gate, module_chain=[module], references=self.skill.build_reference_pack(module, keyword="章末"), compact=True)
        return pack.render() + f"\n\n## 待审正文\n{content}\n\n逐条输出位置、原文、分类、违反规则和修复要求；不得提交空 evidence。\n"

    def _check_category(self, category: str, contract: ChapterContract, content: str, paragraphs: list[str]) -> tuple[str, str, list[str], str]:
        if not content.strip():
            return "不稳", "没有正文可供审查", ["正文长度：0"], "blocker"
        if category == "剧情逻辑":
            if "[TODO]" in content or "待补" in content:
                return "不稳", "正文仍包含待补标记", ["全文命中 TODO/待补"], "blocker"
            return "稳", "完成基础结构扫描", [f"合同目标：{contract.objective}；阻碍：{contract.obstacle}；变化：{contract.change}"], "info"
        if category == "人物目标":
            value = contract.current_character_goal or contract.objective
            return ("稳", "人物目标已声明", [f"人物目标：{value}"], "info") if value else ("不稳", "缺少人物目标", ["契约字段 current_character_goal/objective 为空"], "blocker")
        if category == "情绪关系":
            return "需复核", "必须由人物专项审查确认，静态规则不代替语义检查", [f"关系状态：{contract.relationship_state or '未声明'}"], "warning"
        if category == "身体信息":
            return "需复核", "必须由逻辑专项审查确认知识与身体状态", [f"状态：{contract.body_information_state or '未声明'}"], "warning"
        if category == "场景转场":
            status = "稳" if len(paragraphs) >= 2 else "不稳"
            return status, "完成段落级转场前置检查", [f"非空段落数：{len(paragraphs)}"], "info" if status == "稳" else "blocker"
        if category == "章末承接":
            hook = contract.chapter_hook or contract.next_first_beat
            return ("稳", "契约含下一章入口", [f"入口：{hook}"], "info") if hook else ("不稳", "缺少下一章入口", ["chapter_hook/next_first_beat 均为空"], "blocker")
        return "需复核", "未覆盖的语义项", ["需人工/模型专项复核"], "warning"

    @staticmethod
    def _ending_is_summary(content: str) -> bool:
        paragraphs = [item.strip() for item in re.split(r"\n\s*\n", content) if item.strip()]
        return bool(paragraphs and paragraphs[-1].startswith(("总之", "综上", "这一章", "就这样", "看来事情已经")))
