from __future__ import annotations

from typing import Any

"""类型无关的确定性故事严谨性硬规则（deterministic story-rigor kernel）。

这里只实现"任何故事都成立"的连续性机制：存亡、持有、认知、地点、目标、关系
与健康。它刻意不包含题材/套路相关分类（没有境界、没有力量等级、没有金手指、
没有黄金三章、没有男频女频公式）——它描述的是"事实如何变化"，不是"故事讲什么"。

它是对 StoryForge 的 fact-predicate-registry 与 AI-Novel 的 stateConflictDetection
的可借鉴机制的重实现，服务于 Tomota 的 Canon 更新路径：AGY 按契约产出结构化
state_facts，Python 在 submit 时用冲突策略合并并对硬回归 fail-closed。
"""


# (1) 事实谓词表：类型无关 + 冲突策略。
#
#   conflict = "supersede"  -> 单值状态，新值顶旧值（地点/存亡/健康/目标）
#   conflict = "append"     -> 多值追加，只增不减（持有/认知）
#   conflict = "manual"     -> 异值必须人工裁决，不自动覆盖（关系）
FACT_PREDICATES: dict[str, dict[str, Any]] = {
    "alive": {
        "label": "存亡状态",
        "cardinality": "single",
        "conflict": "supersede",
        "value_kind": "enum",
        "enum": ["alive", "dead", "missing", "unknown"],
    },
    "location": {
        "label": "所在地点",
        "cardinality": "single",
        "conflict": "supersede",
        "value_kind": "text",
    },
    "health": {
        "label": "健康/伤病状态",
        "cardinality": "single",
        "conflict": "supersede",
        "value_kind": "text",
    },
    "goal": {
        "label": "当前目标/动机",
        "cardinality": "single",
        "conflict": "supersede",
        "value_kind": "text",
    },
    "owns": {
        "label": "持有/掌控",
        "cardinality": "multi",
        "conflict": "append",
        "value_kind": "text",
    },
    "knows": {
        "label": "知晓/认知",
        "cardinality": "multi",
        "conflict": "append",
        "value_kind": "text",
    },
    "relation": {
        "label": "人物关系",
        "cardinality": "multi",
        "conflict": "manual",
        "value_kind": "text",
    },
}

# 存亡状态的"硬回归"标记：这些值不能在没有明确复活/寻回证据时从"非存活"回到"存活"。
_NON_ALIVE_VALUES = {"dead", "missing"}


def predicate_spec(predicate: str) -> dict[str, Any] | None:
    return FACT_PREDICATES.get(predicate)


def normalize_state_fact(
    subject: str,
    predicate: str,
    value: str,
) -> dict[str, Any] | None:
    """把 AGY 产出的一条 state_fact 归一到规范形；非法返回 None。"""
    spec = predicate_spec(predicate)
    if not spec:
        return None
    subject = (subject or "").strip()
    value = (value or "").strip()
    if not subject or not value:
        return None
    if spec["value_kind"] == "enum":
        normalized = value.lower()
        if normalized not in spec.get("enum", []):
            return None
        value = normalized
    return {
        "subject": subject,
        "predicate": predicate,
        "value": value,
    }


def _single_state(entries: list[dict[str, Any]], subject: str, predicate: str) -> str | None:
    """返回 subject+predicate 的当前单值状态；不存在返回 None。"""
    for entry in reversed(entries):
        if entry.get("subject") == subject and entry.get("predicate") == predicate:
            return str(entry.get("value") or "")
    return None


def merge_state_facts(
    prior: list[dict[str, Any]],
    new: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """按冲突策略合并两批 state_facts。

    返回 (merged, conflicts)。merged 是合并后的全量 state_facts；
    conflicts 记录需要人工裁决的 manual 冲突（relation 异值）。
    """
    merged: list[dict[str, Any]] = list(prior)
    conflicts: list[dict[str, Any]] = []

    for entry in new:
        subject = str(entry.get("subject") or "")
        predicate = str(entry.get("predicate") or "")
        value = str(entry.get("value") or "")
        spec = predicate_spec(predicate)
        if not spec:
            continue

        if spec["cardinality"] == "single":
            # supersede：同 subject+predicate 的旧单值被新值顶替。
            merged = [
                item
                for item in merged
                if not (item.get("subject") == subject and item.get("predicate") == predicate)
            ]
            merged.append(entry)
        elif spec["conflict"] == "append":
            # append：同值不去重，直接追加。
            merged.append(entry)
        else:
            # manual：若同 subject+predicate 已有异值，记录冲突，不覆盖。
            existing = [
                item
                for item in merged
                if item.get("subject") == subject and item.get("predicate") == predicate
            ]
            if any(str(item.get("value") or "") != value for item in existing):
                conflicts.append({
                    "subject": subject,
                    "predicate": predicate,
                    "prior": [str(item.get("value") or "") for item in existing],
                    "incoming": value,
                })
            merged.append(entry)

    return merged, conflicts


def detect_state_regression(
    prior: list[dict[str, Any]],
    merged: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """确定性状态回归检测（类型无关，fail-closed 依据）。

    在合并后的 Canon 上比较"先前状态 vs 当前状态"。
    只对 supersede 单值谓词做回归判定；append 多值谓词（owns/knows）
    天然只增不减，不产生回归（失去/遗忘是独立事件，需另记）。

    返回 findings，每项 {severity, code, subject, predicate, detail}。
    只有 "hard"（存亡回退）应导致 Canon 更新被拒；
    "soft"（目标突变）作为可追溯提示随 canon 落盘。
    """
    findings: list[dict[str, Any]] = []

    subjects: set[str] = set()
    for entry in [*prior, *merged]:
        subject = str(entry.get("subject") or "")
        if subject:
            subjects.add(subject)

    for subject in subjects:
        # 存亡硬回归：dead/missing -> alive，且未提供复活/寻回证据。
        prior_alive = _single_state(prior, subject, "alive")
        merged_alive = _single_state(merged, subject, "alive")
        if prior_alive in _NON_ALIVE_VALUES and merged_alive == "alive":
            findings.append({
                "severity": "hard",
                "code": "alive_regression",
                "subject": subject,
                "predicate": "alive",
                "detail": f"{subject} 从 {prior_alive} 回到 alive，但 Canon 未提供可核验的复活/寻回证据",
            })

        # 目标突变（软提示）：goal 变化需要过渡触发，但不硬阻断。
        prior_goal = _single_state(prior, subject, "goal")
        merged_goal = _single_state(merged, subject, "goal")
        if prior_goal and merged_goal and prior_goal != merged_goal:
            findings.append({
                "severity": "soft",
                "code": "goal_shift",
                "subject": subject,
                "predicate": "goal",
                "detail": f"{subject} 目标从「{prior_goal}」变为「{merged_goal}」，需确认本章有清晰转折触发",
            })

    return findings


def fact_contract_prompt() -> str:
    """注入 canon_update 阶段 prompt 的事实谓词契约（AGY 据此产出 state_facts）。"""
    lines = [
        "## 确定性事实谓词契约（类型无关，硬规则）",
        "",
        "Canon 更新必须额外输出 `state_facts` 数组，把本章**有正文证据**的状态变化写成结构化事实。",
        "每条 state_fact 形如：",
        '`{"subject": "人物名", "predicate": "谓词", "value": "值"}`。',
        "state_fact 是顶层 `evidence`（逐字正文引文）的结构化摘要，不得包含正文里没有的状态变化。",
        "",
        "只允许以下类型无关的谓词（禁止自造题材/套路类谓词）：",
    ]
    for predicate, spec in FACT_PREDICATES.items():
        hint = f"（{spec['value_kind']}）" if spec["value_kind"] == "enum" else ""
        lines.append(
            f"- `{predicate}`：{spec['label']}；基数={spec['cardinality']}；冲突策略={spec['conflict']}{hint}"
        )
    lines.extend([
        "",
        "冲突策略含义：",
        "- `supersede`：单值状态，新值顶替旧值（地点/存亡/健康/目标）。",
        "- `append`：多值事实，只增不减（持有/认知）。",
        "- `manual`：出现异值不得自动覆盖，必须留冲突交作者裁决（关系）。",
        "",
        "硬回归禁止：",
        "- `alive` 从 dead/missing 回到 alive，必须有可核验的复活/寻回证据，否则系统拒绝 Canon 更新。",
        "- `knows` 已存在的事实不得在无解释时消失（认知回退）。",
        "- 没有变化的类别写空数组；禁止为了填满 state_facts 编造无正文证据的事实。",
    ])
    return "\n".join(lines)
