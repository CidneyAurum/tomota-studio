from __future__ import annotations

import re
from collections import Counter
from difflib import SequenceMatcher
from math import sqrt
from statistics import mean, median
from typing import Any, Iterable


_VISIBLE = re.compile(r"[\u3400-\u9fffA-Za-z0-9]")
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?…])\s*")
_MARKDOWN_RESIDUE = re.compile(r"(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|>\s)|\*\*|__|`{1,3}")

# These are not forbidden words. A single hit is harmless; concentration and
# cross-chapter recurrence are the signals. Keeping the families explicit
# makes every diagnostic reproducible instead of asking a model whether prose
# merely "feels AI".
_PATTERN_FAMILIES: dict[str, tuple[str, ...]] = {
    "transition_template": ("然而", "于是", "就在这时", "与此同时", "下一刻", "这一刻", "不知过了多久"),
    "body_reaction_chain": ("心头一紧", "心中一凛", "瞳孔骤缩", "呼吸一滞", "下意识", "攥紧拳头", "咽了口唾沫"),
    "explanatory_voice": ("这意味着", "换句话说", "显而易见", "毫无疑问", "不得不说", "值得一提的是"),
    "vague_atmosphere": ("仿佛", "似乎", "某种", "莫名", "难以言喻", "说不清道不明"),
}


def _compact(text: str) -> str:
    return "".join(_VISIBLE.findall(text))


def _paragraphs(text: str) -> list[str]:
    return [item.strip() for item in _PARAGRAPH_SPLIT.split(text) if item.strip()]


def _sentences(text: str) -> list[str]:
    return [item.strip() for item in _SENTENCE_SPLIT.split(text) if len(_compact(item)) >= 2]


def _variation(values: Iterable[int | float]) -> float:
    items = [float(item) for item in values]
    if len(items) < 2 or mean(items) == 0:
        return 0.0
    average = mean(items)
    return round(sqrt(sum((item - average) ** 2 for item in items) / len(items)) / average, 4)


def _line_location(text: str, needle: str) -> str:
    index = text.find(needle)
    if index < 0:
        return "全文"
    return f"第 {text[:index].count(chr(10)) + 1} 行"


def _risk(
    code: str,
    severity: str,
    text: str,
    quote: str,
    diagnosis: str,
    repair: str,
    count: int = 1,
) -> dict[str, Any]:
    return {
        "code": code,
        "severity": severity,
        "location": _line_location(text, quote),
        "quote": quote[:120],
        "count": int(count),
        "diagnosis": diagnosis,
        "repair": repair,
    }


def analyze_prose_quality(text: str) -> dict[str, Any]:
    """Return deterministic prose diagnostics for one chapter.

    The score is an editing heuristic, never a claim that a chapter was
    written by AI. Every deduction is tied to a public, reproducible feature.
    """
    compact = _compact(text)
    paragraphs = _paragraphs(text)
    sentences = _sentences(text)
    sentence_lengths = [len(_compact(item)) for item in sentences]
    paragraph_lengths = [len(_compact(item)) for item in paragraphs]
    findings: list[dict[str, Any]] = []
    pattern_counts: dict[str, int] = {}
    visible = max(1, len(compact))

    for family, patterns in _PATTERN_FAMILIES.items():
        hits = [(pattern, text.count(pattern)) for pattern in patterns if text.count(pattern)]
        count = sum(item[1] for item in hits)
        pattern_counts[family] = count
        density = count * 1000 / visible
        if density >= 3.0 and hits:
            top = max(hits, key=lambda item: item[1])
            labels = {
                "transition_template": ("转场连接词过密，场景推进容易呈现同一套说明节拍", "保留时间因果，改用人物动作、环境变化或对白承接转场"),
                "body_reaction_chain": ("通用身体反应集中出现，人物情绪落地趋于模板化", "按人物当下目标改写为有后果的动作、选择或独特感官反应"),
                "explanatory_voice": ("叙述者替读者总结的句式过密，削弱现场感和潜台词", "删除可由行动推知的结论，把必要信息分配给证据、误判和对白"),
                "vague_atmosphere": ("模糊修饰集中出现，具体物象与判断承担不足", "只保留确有视角意义的模糊感，其余落到可见物、声音、阻力或选择"),
            }
            diagnosis, repair = labels[family]
            findings.append(_risk(family, "warning" if density < 5.0 else "blocker", text, top[0], diagnosis, repair, count))

    starter_counter: Counter[str] = Counter()
    for sentence in sentences:
        starter = _compact(sentence)[:4]
        if len(starter) == 4:
            starter_counter[starter] += 1
    repeated_starters = [(value, count) for value, count in starter_counter.most_common(8) if count >= 3]
    if repeated_starters and repeated_starters[0][1] >= max(4, len(sentences) // 10):
        starter, count = repeated_starters[0]
        findings.append(_risk(
            "sentence_starter_convergence", "warning", text, starter,
            "多个句子使用相同四字起手，局部节奏和观察顺序趋同",
            "不要逐句换同义词；重排谁先观察、谁先行动以及长短句关系", count,
        ))

    markdown_hits = _MARKDOWN_RESIDUE.findall(text)
    if markdown_hits:
        quote_match = _MARKDOWN_RESIDUE.search(text)
        findings.append(_risk(
            "markdown_residue", "blocker", text, quote_match.group(0).strip() if quote_match else "Markdown",
            "正文残留 Markdown 排版符号，会破坏小说阅读与平台排版",
            "清除标题号、粗体、列表或代码标记，仅保留小说正文标点", len(markdown_hits),
        ))

    sentence_cv = _variation(sentence_lengths)
    paragraph_cv = _variation(paragraph_lengths)
    if len(sentences) >= 16 and sentence_cv < 0.28:
        findings.append(_risk(
            "sentence_rhythm_flat", "warning", text, sentences[0] if sentences else text[:80],
            "句长变化长期偏低，叙述可能形成匀速播报感",
            "按场景压力重组句群：决定处收紧，观察处舒展，而非随机切短句",
        ))
    if len(paragraphs) >= 8 and paragraph_cv < 0.22:
        findings.append(_risk(
            "paragraph_rhythm_flat", "warning", text, paragraphs[0] if paragraphs else text[:80],
            "段落长度高度均匀，视觉和叙事节拍缺少层次",
            "让段落边界服从动作完成、话语权转移和信息落点，不按固定字数切段",
        ))

    blocker_count = sum(1 for item in findings if item["severity"] == "blocker")
    warning_count = sum(1 for item in findings if item["severity"] == "warning")
    risk_score = min(100, blocker_count * 18 + warning_count * 7 + min(12, sum(pattern_counts.values()) // 3))
    return {
        "schema_version": "prose-quality-v2",
        "interpretation": "启发式编辑风险，不用于证明作者身份；分数越高表示越值得人工复核",
        "visible_chars": len(compact),
        "paragraph_count": len(paragraphs),
        "sentence_count": len(sentences),
        "dialogue_ratio": _dialogue_ratio(text),
        "median_sentence_visible_chars": round(float(median(sentence_lengths)), 1) if sentence_lengths else 0,
        "sentence_length_cv": sentence_cv,
        "median_paragraph_visible_chars": round(float(median(paragraph_lengths)), 1) if paragraph_lengths else 0,
        "paragraph_length_cv": paragraph_cv,
        "pattern_counts": pattern_counts,
        "repeated_sentence_starters": [{"starter": value, "count": count} for value, count in repeated_starters],
        "ai_flavor_risk": risk_score,
        "naturalness_score": max(0, 100 - risk_score),
        "findings": findings,
    }


def _document_ngrams(text: str, size: int = 8) -> set[str]:
    value = _compact(text)
    if len(value) < size:
        return set()
    # A set makes this document frequency rather than raw frequency: a phrase
    # repeated ten times in one chapter is not mistaken for a book-wide habit.
    return {value[index:index + size] for index in range(0, len(value) - size + 1)}


def _dialogue_ratio(text: str) -> float:
    visible = max(1, len(_compact(text)))
    quoted = sum(len(_compact(match)) for match in re.findall(r"[“\"]([^”\"]+)[”\"]", text))
    return round(quoted / visible, 4)


def build_corpus_prose_guard(chapters: Iterable[tuple[int, str]]) -> dict[str, Any]:
    """Compress a whole approved-book corpus into executable prose warnings.

    The result deliberately contains signatures, not entire prior chapters.
    It is cheap to inject into every new chapter while still allowing a voice
    reviewer to compare the current draft against the complete local history.
    """
    values = [(int(number), text) for number, text in chapters if text.strip()]
    document_frequency: Counter[str] = Counter()
    opening_leads: Counter[str] = Counter()
    ending_leads: Counter[str] = Counter()
    paragraph_lengths: list[int] = []
    dialogue_ratios: list[float] = []
    for _, text in values:
        document_frequency.update(_document_ngrams(text))
        paragraphs = _paragraphs(text)
        if paragraphs:
            opening = _compact(paragraphs[0])[:18]
            ending = _compact(paragraphs[-1])[-18:]
            if len(opening) >= 10:
                opening_leads[opening] += 1
            if len(ending) >= 10:
                ending_leads[ending] += 1
            paragraph_lengths.extend(len(_compact(item)) for item in paragraphs)
        dialogue_ratios.append(_dialogue_ratio(text))
    minimum_documents = 2 if len(values) < 6 else 3
    recurring = [
        {"phrase": phrase, "chapter_count": count}
        for phrase, count in document_frequency.most_common()
        if count >= minimum_documents
    ][:24]
    return {
        "schema_version": "prose-corpus-guard-v1",
        "chapters_analyzed": [number for number, _ in values],
        "coverage": "all approved chapters before the current chapter",
        "recurring_phrase_candidates": recurring,
        "repeated_opening_leads": [
            {"lead": lead, "chapter_count": count}
            for lead, count in opening_leads.most_common(8) if count >= 2
        ],
        "repeated_ending_leads": [
            {"lead": lead, "chapter_count": count}
            for lead, count in ending_leads.most_common(8) if count >= 2
        ],
        "median_paragraph_visible_chars": round(float(median(paragraph_lengths)), 1) if paragraph_lengths else 0,
        "median_dialogue_ratio": round(float(median(dialogue_ratios)), 4) if dialogue_ratios else 0,
        "application_rule": (
            "这些是全书重复风险候选，不是禁词表。人物名、世界术语和必要事实可复用；"
            "无叙事功能的描写搭配、动作反应、开场模板和章末机制必须主动变体。"
        ),
    }


def compare_current_to_corpus(current_text: str, chapters: Iterable[tuple[int, str]]) -> dict[str, Any]:
    values = [(int(number), text) for number, text in chapters if text.strip()]
    guard = build_corpus_prose_guard(values)
    current_compact = _compact(current_text)
    current_opening = _compact((_paragraphs(current_text) or [current_text])[0])[:180]
    comparisons = []
    for number, text in values:
        prior_opening = _compact((_paragraphs(text) or [text])[0])[:180]
        comparisons.append({
            "chapter": number,
            "opening_similarity": round(SequenceMatcher(None, current_opening, prior_opening).ratio(), 4)
            if current_opening and prior_opening else 0,
        })
    comparisons.sort(key=lambda item: item["opening_similarity"], reverse=True)
    current_ngrams = _document_ngrams(current_text)
    recurring_hits = [
        item for item in guard["recurring_phrase_candidates"]
        if item["phrase"] in current_ngrams
    ][:16]
    exact_opening_matches = [
        item for item in guard["repeated_opening_leads"]
        if str(item["lead"]) and str(item["lead"]) in current_compact[:240]
    ]
    similar_openings = [item for item in comparisons if float(item["opening_similarity"]) >= 0.78]
    chapter_quality = analyze_prose_quality(current_text)
    blockers: list[dict[str, Any]] = [
        item for item in chapter_quality["findings"] if item.get("severity") == "blocker"
    ]
    if exact_opening_matches:
        lead = str(exact_opening_matches[0]["lead"])
        blockers.append({
            "code": "repeated_opening_template",
            "quote": lead,
            "diagnosis": "当前开场复用了至少两章已经出现的同一长开场骨架",
            "repair": "保留事实与入场因果，完整重写开场的感官入口、动作顺序和句段节奏",
        })
    if len(similar_openings) >= 2 and similar_openings[0]["opening_similarity"] >= 0.86:
        quote = current_text.strip()[:100]
        blockers.append({
            "code": "opening_shape_convergence",
            "quote": quote,
            "diagnosis": "当前开场与多章既有开场在句面顺序上高度趋同",
            "repair": "不要局部换词；从场景进入方式开始重写整段开场，同时保留章节契约要求",
        })
    if len(recurring_hits) >= 6:
        blockers.append({
            "code": "bookwide_phrase_concentration",
            "quote": current_text.strip()[:100],
            "diagnosis": "当前章继续集中复用全书高频描写搭配，形成系统性模板痕迹",
            "repair": "全文检查这些搭配承担的功能；保留必要术语，重写无功能的描写和身体反应链",
        })
    return {
        **guard,
        "chapter_quality": chapter_quality,
        "current_visible_chars": len(current_compact),
        "current_dialogue_ratio": _dialogue_ratio(current_text),
        "closest_openings": comparisons[:8],
        "recurring_phrase_hits": recurring_hits,
        "blockers": blockers,
    }


def analyze_book_quality(chapters: Iterable[tuple[int, str]]) -> dict[str, Any]:
    """Analyze complete supplied chapter bodies and aggregate book-wide risk."""
    values = [(int(number), text) for number, text in chapters if text.strip()]
    corpus = build_corpus_prose_guard(values)
    chapter_reports = [
        {"chapter": number, **analyze_prose_quality(text)} for number, text in values
    ]
    cross_chapter_findings: list[dict[str, Any]] = []
    for item in corpus["repeated_opening_leads"]:
        cross_chapter_findings.append({
            "code": "book_repeated_opening",
            "severity": "blocker" if int(item["chapter_count"]) >= 3 else "warning",
            "quote": item["lead"],
            "chapter_count": item["chapter_count"],
            "diagnosis": "多章使用相同开场骨架",
            "repair": "保留各章事实入口，但让触发事件、观察主体和节拍承担不同功能",
        })
    for item in corpus["repeated_ending_leads"]:
        cross_chapter_findings.append({
            "code": "book_repeated_ending",
            "severity": "blocker" if int(item["chapter_count"]) >= 3 else "warning",
            "quote": item["lead"],
            "chapter_count": item["chapter_count"],
            "diagnosis": "多章使用相同章末收束机制",
            "repair": "按信息揭示、关系改变、行动承诺或危险状态变化选择不同章末功能",
        })
    average_risk = round(mean([float(item["ai_flavor_risk"]) for item in chapter_reports]), 1) if chapter_reports else 0
    cross_penalty = min(25, sum(10 if item["severity"] == "blocker" else 4 for item in cross_chapter_findings))
    return {
        "schema_version": "book-prose-quality-v2",
        "interpretation": "完整读取所选章节后的确定性编辑报告；不是 AI 作者身份检测",
        "chapters_analyzed": [number for number, _ in values],
        "coverage_visible_chars": sum(len(_compact(text)) for _, text in values),
        "chapter_reports": chapter_reports,
        "corpus_guard": corpus,
        "cross_chapter_findings": cross_chapter_findings,
        "book_ai_flavor_risk": min(100, round(average_risk + cross_penalty, 1)),
        "book_naturalness_score": max(0, round(100 - average_risk - cross_penalty, 1)),
    }


def summarize_confirmed_revision(before: str, after: str) -> dict[str, Any]:
    """Create a bounded author-edit pair without retaining two whole chapters."""
    before_parts = _paragraphs(before)
    after_parts = _paragraphs(after)
    matcher = SequenceMatcher(None, before_parts, after_parts)
    pairs: list[dict[str, str]] = []
    for tag, first_start, first_end, second_start, second_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        old = "\n".join(before_parts[first_start:first_end]).strip()[:180]
        new = "\n".join(after_parts[second_start:second_end]).strip()[:180]
        if old or new:
            pairs.append({"operation": tag, "before": old, "after": new})
        if len(pairs) >= 6:
            break
    return {
        "before_visible_chars": len(_compact(before)),
        "after_visible_chars": len(_compact(after)),
        "before_paragraphs": len(before_parts),
        "after_paragraphs": len(after_parts),
        "before_dialogue_ratio": _dialogue_ratio(before),
        "after_dialogue_ratio": _dialogue_ratio(after),
        "changed_pairs": pairs,
        "application_rule": "这是用户确认返工形成的局部偏好证据；只在相似触发条件下参考，不覆盖 Canon、人物知识或章节契约。",
    }
