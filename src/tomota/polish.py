"""Pure, fail-closed contracts for evidence-backed revision and re-review.

The ledger records public evidence, never model reasoning. Text matching proves
grounding and coverage; the independent reviewer must still judge repair quality.
Functions return copies so failed validation cannot partially close obligations.
"""
from __future__ import annotations

import hashlib
from copy import deepcopy
from typing import Any


def text_hash(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def _quote(value: Any, text: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value not in text:
        raise ValueError(f"{label} 必须逐字引用对应正文")
    return value


def _reason(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} 必须说明具体修复或保留依据")
    return value.strip()


def _rows(rows: Any, expected: set[str], label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        raise ValueError(f"{label} 必须逐项覆盖全部修复目标")
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError(f"{label} 每项必须是对象")
        key = row.get("target_id")
        if not isinstance(key, str) or key not in expected or key in result:
            raise ValueError(f"{label} 包含未知或重复 target_id")
        result[key] = row
    if set(result) != expected:
        raise ValueError(f"{label} 遗漏修复目标：{', '.join(sorted(expected - set(result)))}")
    return result


def add_findings(ledger: dict[str, Any], gate: str, findings: list[dict[str, Any]],
                 source: str, protected_content: list[str]) -> dict[str, Any]:
    result = deepcopy(ledger) if ledger else {"schema_version": "polish-ledger-v1", "targets": []}
    existing = {item["target_id"]: item for item in result["targets"]}
    seen = set()
    for finding in findings:
        finding_id = _reason(finding.get("finding_id"), "finding_id")
        if finding_id in seen:
            raise ValueError("修复目标 finding_id 不得重复")
        seen.add(finding_id)
        quote = _quote(finding.get("quote"), source, "finding.quote")
        target_id = "repair-" + hashlib.sha256(f"{gate}:{finding_id}".encode()).hexdigest()[:16]
        prior = existing.get(target_id)
        history = list(prior.get("history", [])) if prior else []
        if prior:
            history.append({key: value for key, value in prior.items() if key != "history"})
        existing[target_id] = {
            "target_id": target_id, "gate": gate, "finding_id": finding_id,
            "requirement": _reason(finding.get("repair_requirement"), "repair_requirement"),
            "violated_rule": str(finding.get("violated_rule") or ""),
            "anchor_quote": quote, "origin_hash": text_hash(source),
            "protected_content": list(protected_content), "status": "needs_revision",
            "history": history,
        }
    result["targets"] = list(existing.values())
    result["draft_hash"] = text_hash(source)
    return result


def apply_revision(ledger: dict[str, Any], receipts: Any, before: str, after: str) -> dict[str, Any]:
    if ledger.get("draft_hash") != text_hash(before):
        raise ValueError("修复台账与当前旧稿哈希不一致，拒绝使用过期修复依据")
    if " ".join(before.split()) == " ".join(after.split()):
        raise ValueError("仅空白变化不能作为有效打磨")
    result = deepcopy(ledger)
    targets = result.get("targets", [])
    rows = _rows(receipts, {item["target_id"] for item in targets}, "repair_receipts")
    for target in targets:
        row = rows[target["target_id"]]
        old = _quote(row.get("before_quote"), before, "before_quote")
        new = _quote(row.get("after_quote"), after, "after_quote")
        anchor = target["anchor_quote"]
        if anchor not in old:
            raise ValueError("before_quote 必须包含该目标的完整当前锚点，不能用无关段落代替修复")
        mode = row.get("mode")
        if mode not in {"repaired", "preserved"}:
            raise ValueError("mode 只能为 repaired 或 preserved")
        if target["status"] == "needs_revision" and mode != "repaired":
            raise ValueError("本轮未解决问题必须 repaired，不能声明保留原问题")
        if mode == "repaired" and " ".join(old.split()) == " ".join(new.split()):
            raise ValueError("修复前后证据不能相同；补充上下文时应引用包含新上下文的完整片段")
        if mode == "preserved" and old != new:
            raise ValueError("preserved 必须提供逐字保持的证据；有改写时使用 repaired")
        _reason(row.get("explanation"), "explanation")
        preservation = row.get("preservation")
        if not isinstance(preservation, dict):
            raise ValueError("每项修复必须提供 preservation 保留约束检查")
        _quote(preservation.get("before_quote"), before, "preservation.before_quote")
        _quote(preservation.get("after_quote"), after, "preservation.after_quote")
        _reason(preservation.get("explanation"), "preservation.explanation")
        target["revision_receipt"] = deepcopy(row)
        target["anchor_quote"] = new
        target["status"] = "needs_verification"
        target.pop("verification", None)
    result["draft_hash"] = text_hash(after)
    return result


def verify_repairs(ledger: dict[str, Any], gate: str, receipts: Any, content: str) -> dict[str, Any]:
    if ledger.get("draft_hash") != text_hash(content):
        raise ValueError("修复复核必须绑定当前正文，不能沿用旧稿结论")
    result = deepcopy(ledger)
    targets = [item for item in result.get("targets", []) if item["gate"] == gate]
    rows = _rows(receipts, {item["target_id"] for item in targets}, "repair_verification")
    for target in targets:
        if target["status"] == "needs_revision":
            raise ValueError("目标尚未提交修复，不能直接复核关闭")
        row = rows[target["target_id"]]
        if row.get("resolved") is not True:
            raise ValueError("未解决的修复目标不能通过审查；应返回 failed finding 和返工要求")
        _quote(row.get("quote"), content, "repair_verification.quote")
        _reason(row.get("explanation"), "repair_verification.explanation")
        _reason(row.get("preservation_check"), "preservation_check")
        target["status"] = "verified"
        target["verification"] = {**deepcopy(row), "draft_hash": text_hash(content)}
    return result
