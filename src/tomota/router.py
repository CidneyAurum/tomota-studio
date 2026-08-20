from __future__ import annotations

from dataclasses import dataclass, field


PLANNING_CHAIN = ["concept_planning"]
OUTLINE_CHAIN = ["concept_planning", "volume_outline"]
OPENING_CHAIN = ["concept_planning", "opening"]
SCAN_CHAIN = ["scan", "concept_planning"]
ANALYZE_CHAIN = ["analyze", "volume_outline"]
COVER_CHAIN = ["cover"]
DESLOP_CHAIN = ["anti_ai_voice"]
CHAPTER_CHAIN = [
    "plot_logic",
    "character_consistency",
    "transition",
    "dialogue",
    "chapter_ending",
    "anti_ai_voice",
    "consistency_review",
]
REVIEW_CHAIN = ["consistency_review"]


@dataclass
class Route:
    stage: str
    module_chain: list[str]
    reasons: list[str] = field(default_factory=list)
    issue_tags: list[str] = field(default_factory=list)


class SkillRouter:
    """Deterministic task router based on the skill's module taxonomy."""

    TAG_TO_MODULE = {
        "因果": "plot_logic",
        "动机": "plot_logic",
        "触发": "plot_logic",
        "后果": "plot_logic",
        "人设": "character_consistency",
        "人物": "character_consistency",
        "目标": "character_consistency",
        "情绪": "character_consistency",
        "关系": "character_consistency",
        "伤势": "character_consistency",
        "信息": "character_consistency",
        "转场": "transition",
        "时间": "transition",
        "空间": "transition",
        "视角": "transition",
        "回忆": "transition",
        "对白": "dialogue",
        "台词": "dialogue",
        "章末": "chapter_ending",
        "钩子": "chapter_ending",
        "追更": "chapter_ending",
        "AI": "anti_ai_voice",
        "模板": "anti_ai_voice",
        "空泛": "anti_ai_voice",
        "套话": "anti_ai_voice",
        "反转": "reversal_toolkit",
        "打脸": "style_combat_face",
        "战斗": "style_combat_face",
        "女频": "female_audience",
        "情感": "emotion_system",
    }

    def route(self, task: str, stage: str | None = None, issue_tags: list[str] | None = None) -> Route:
        normalized = (stage or "").strip().lower()
        tags = list(issue_tags or [])
        if not normalized:
            normalized = self._infer_stage(task)
        if normalized in {"scan", "扫榜", "市场分析", "选材"}:
            return Route("scan", SCAN_CHAIN.copy(), ["扫榜选材任务分析热门赛道与读者期待"], tags)
        if normalized in {"analyze", "拆文", "对标"}:
            return Route("analyze", ANALYZE_CHAIN.copy(), ["拆文任务逆向提取故事引擎与节奏模板"], tags)
        if normalized in {"cover", "封面", "配图"}:
            return Route("cover", COVER_CHAIN.copy(), ["封面任务生成视觉高光与排版提示词"], tags)
        if normalized in {"deslop", "去ai味", "去味", "精修"}:
            return Route("deslop", DESLOP_CHAIN.copy(), ["去 AI 味任务进行套话与句式清洗"], tags)
        if normalized in {"concept", "planning", "plan", "选题", "前置规划"}:
            return Route("planning", PLANNING_CHAIN.copy(), ["简介或选题任务必须先经过 concept_planning"], tags)
        if normalized in {"outline", "volume", "章纲", "分卷"}:
            return Route("outline", OUTLINE_CHAIN.copy(), ["长篇结构任务需要 concept_planning 和 volume_outline"], tags)
        if normalized in {"opening", "开头", "黄金三章"}:
            return Route("opening", OPENING_CHAIN.copy(), ["开头任务需要先确认卖点和异常局面"], tags)
        if normalized in {"review", "审查", "完稿"}:
            return Route("review", REVIEW_CHAIN.copy(), ["每章完稿强制进入 consistency_review"], tags)
        if normalized in {"chapter", "draft", "正文", "章节", "续写"}:
            reasons = ["正文执行链先修底层逻辑和人物，再处理场景、对白、章末与去 AI 味", "每章写完强制 consistency_review"]
            chain = CHAPTER_CHAIN.copy()
            # If tags request specialized modules, inject them
            if "反转" in tags and "reversal_toolkit" not in chain:
                chain.insert(chain.index("chapter_ending"), "reversal_toolkit")
            if ("打脸" in tags or "战斗" in tags) and "style_combat_face" not in chain:
                chain.insert(chain.index("chapter_ending"), "style_combat_face")
            return Route("chapter", chain, reasons, tags)
        raise ValueError(f"unsupported writing stage: {stage or normalized}")

    def _infer_stage(self, task: str) -> str:
        text = task.lower()
        if any(token in text for token in ["扫榜", "选材", "市场"]):
            return "scan"
        if any(token in text for token in ["拆文", "对标", "逆向"]):
            return "analyze"
        if any(token in text for token in ["封面", "配图"]):
            return "cover"
        if any(token in text for token in ["去ai味", "去味", "精修"]):
            return "deslop"
        if any(token in text for token in ["章纲", "分卷", "黄金三章", "前20章"]):
            return "outline"
        if any(token in text for token in ["开头", "第一章"]):
            return "opening"
        if any(token in text for token in ["审查", "检查", "体检"]):
            return "review"
        if any(token in text for token in ["正文", "章节", "续写", "单章"]):
            return "chapter"
        return "planning"

    def issue_modules(self, issue_tags: list[str]) -> list[str]:
        result: list[str] = []
        for tag in issue_tags:
            module = self.TAG_TO_MODULE.get(tag, tag if tag in CHAPTER_CHAIN else None)
            if module and module not in result:
                result.append(module)
        return result

    def next_route_after_failure(self, category: str) -> list[str]:
        mapping = {
            "剧情逻辑": ["plot_logic"],
            "人物目标": ["character_consistency"],
            "情绪关系": ["character_consistency", "transition"],
            "身体信息": ["character_consistency", "plot_logic"],
            "场景转场": ["transition"],
            "章末承接": ["chapter_ending", "transition"],
            "去AI味": ["anti_ai_voice"],
        }
        return mapping.get(category, ["consistency_review"])
