from __future__ import annotations

import hashlib
import re

from .deslop import run_deslop_lint
from .models import ChapterContract, ReviewFinding, ReviewGate, ReviewItem, ReviewReport
from .router import SkillRouter
from .skill_adapter import SkillAdapter


CATEGORIES = ["剧情逻辑", "人物目标", "情绪关系", "身体信息", "场景转场", "章末承接"]
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

        # Deterministic, project-owned anti-AI lint. External skill rules remain
        # opt-in in ``run_deslop_lint`` so an installed package cannot alter a
        # book run silently.
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
            labels = {
                "abstract-cliché": "抽象套话",
                "explanation-cliché": "解释腔",
                "psychological-telling": "心理告知",
                "formulaic-parallelism": "否定/排比模板",
                "banned-word": "高频禁词",
                "banned-words-density": "禁词聚集",
            }
            warning_labels = []
            for finding in warnings:
                label = labels.get(finding.rule_type, "句式退化")
                if label not in warning_labels:
                    warning_labels.append(label)
            label_text = "、".join(warning_labels[:5]) or "句式退化"
            items.append(ReviewItem(
                "去AI味",
                "需修",
                f"发现 {len(warnings)} 处去 AI 味提示：{label_text}",
                [f"第{f.line}行：{f.message}" for f in warnings[:5]],
                ["anti_ai_voice"],
                "warning",
            ))
        else:
            items.append(ReviewItem(
                "去AI味",
                "稳",
                "未命中项目内去 AI 味规则",
                ["扫描范围：全文；规则集：tomota-deterministic-deslop-v1"],
                [],
                "info",
            ))

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
            (r"\[(?:TODO|待补|TBD)\]", "review_logic", "工程标记", "正式正文不得残留工程占位符", "完成该处内容并删除占位符", "正文仍含未完成标记"),
            (r"^(?:#{1,6}\s+|\*\*.+\*\*)$", "review_voice", "排版残留", "小说正文不得泄漏 Markdown 结构标记", "改为正文排版或删除工程标题", "正文包含 Markdown 标记"),
            (r"这里写的是[^。！？\n]+[？?]", "review_voice", "核验目的缺失", "姓名核验必须体现说话者的目的与压力", "补出核验对象或让对白承担明确关系动作", "姓名问句只有表面核对，缺少说话者目的"),
            (r"她不让我叫名字。", "review_voice", "对白直译", "隐瞒姓名的禁令需要符合中文口语并明确对象", "改成自然中文对白并保留禁令对象", "隐瞒姓名的对白像直译句"),
            (r"只有一行字。你杀错人了。", "review_logic", "物证特写不足", "核心物证需要特写、反应、选择与后果", "补出物证如何改变人物选择，不增加新事件", "核心物证被提纲式带过"),
            (r"第十三响落下，随后传来第二次敲击。", "review_continuity", "计数锚点缺失", "计数序列必须说明重置对象", "明确第二次敲击属于什么计数序列", "连续计数缺少对象锚点"),
            (r"阿贝尔披上外衣，去找奥斯温。", "review_logic", "行动动机缺失", "关键行动必须由可见线索或目标触发", "补出触发行动的当前线索", "关键行动没有可核验触发"),
            (r"小声点，墙后有耳朵。", "review_voice", "直译表达", "威胁表达应符合中文习惯或世界内具体风险", "改成自然表达并保留墙后监听风险", "对白存在英语直译腔"),
            (r"奥斯温没有回答。", "review_voice", "悬空沉默", "沉默必须绑定紧邻提问对象或可见动作", "补出被回避的问题或沉默动作", "沉默没有明确回应对象"),
            (r"守夜人朝东亭喊了一声。", "review_logic", "地点锚点缺失", "地点简称第一次出现前必须有全称与功能", "先交代东亭的全称或功能", "地点简称未建立空间锚点"),
            (r"手伸进桌下，握住短刀。", "review_logic", "防卫动作缺前置", "突发防卫动作必须有职业、威胁或前置状态支撑", "补出威胁或人物已有的防卫准备", "防卫动作缺少前置依据"),
            (r"这不证明寄信人是维拉。\s*但有人知道那枚戒指，也知道原判在谁手里。", "review_logic", "推理跳跃", "推理必须把物证连接到可执行判断", "把戒指、原判与下一步核验动作连起来", "否定后直接跳到结论，缺少可执行推理"),
            (r"戴王室传令牌。脸没看清。", "review_logic", "身份证据缺失", "关键身份来源不能以无支撑的视觉缺失搪塞", "明确传令牌的来源或可验证特征", "关键身份同时缺少来源与证据"),
        ]
        for expression, item_gate, category, rule, repair, diagnosis in patterns:
            for match in re.finditer(expression, content):
                add(match, item_gate, category, rule, repair, diagnosis)

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
