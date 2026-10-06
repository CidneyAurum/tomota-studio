import unittest
from types import SimpleNamespace

from tomota.workflow import WorkflowEngine, WorkflowError, _rule_priority


class RuleExecutionGateTests(unittest.TestCase):
    def setUp(self):
        self.engine = WorkflowEngine.__new__(WorkflowEngine)
        self.run = SimpleNamespace(current_stage="draft", book_id="audit", current_chapter=1)
        self.rule = {"source": "distilled_dimension", "category": "dialogue", "axis": "dialogue",
                     "rule": "Use action for subtext", "avoid": "Do not explain the subtext",
                     "applies_to": ["drafting"], "application_requirement": "contextual"}

    def compile(self, context=None):
        return self.engine._compile_stage_writing_policy(
            self.run, {"active_rules": [self.rule]}, context or {},
        )["executable_style_rules"][0]

    def test_avoid_does_not_activate_contextual_method(self):
        result = self.compile()
        self.assertEqual(result["class"], "should")
        self.assertFalse(result["execution_required"])
        self.assertEqual(result["avoid"], self.rule["avoid"])

    def test_conditional_obligation_stays_required_without_conflict(self):
        self.rule.update(avoid="", application_requirement="required_unless_conflict")
        result = self.compile()
        self.assertEqual(result["class"], "must")
        self.assertTrue(result["execution_required"])

    def test_suppression_survives_draft_revision_and_review(self):
        self.rule["application_requirement"] = "required"
        rule_id = self.compile()["rule_id"]
        mapping = {"constraint_id": rule_id, "scene_ids": ["S1"], "execution": "Use higher rule",
                   "acceptance_test": "Check higher rule", "conflict_status": "suppressed_by_higher_rule",
                   "suppressed_by": "foundation-1", "conflict_reason": "Conflict",
                   "conflict_dimensions": [{"dimension": "voice", "suppressed_evidence": "a", "suppressor_evidence": "b"}]}
        self.rule["applies_to"] = ["drafting", "revision"]
        for stage in ("draft", "revise_voice", "review_voice"):
            with self.subTest(stage=stage):
                self.run.current_stage = stage
                result = self.compile({"design": {"constraint_application": [mapping]}})
                self.assertEqual(result["activation"], "suppressed")
                self.assertFalse(result["execution_required"])
                self.assertEqual(result["suppressed_by"], mapping["suppressed_by"])
                self.assertEqual(result["conflict_dimensions"], mapping["conflict_dimensions"])

    def test_source_precedence_is_not_erased_by_must_class(self):
        foundation = [{"constraint_id": "F", "priority": "must"}]
        rules = [{"rule_id": "B", "source": "book_override", "class": "must"},
                 {"rule_id": "A", "source": "distilled_dimension", "class": "must"}]
        rank = lambda key: _rule_priority(key, foundation, rules, {})
        self.assertGreater(rank("F"), rank("B"))
        self.assertGreater(rank("B"), rank("A"))

    def test_mutual_same_rank_suppression_rejected(self):
        self.engine.store = SimpleNamespace(effective_foundation_contract=lambda *a, **k: {},
                                            load_canon=lambda *a: {}, get_chapter=lambda *a: {})
        self.engine._writing_policy = lambda run: {"active": True}
        self.engine._stage_context = lambda run: {}
        self.engine._compile_stage_writing_policy = lambda *a: {"executable_style_rules": [
            {"rule_id": key, "class": "must", "source": "distilled_dimension"} for key in ("A", "B")]}
        mappings = [{"constraint_id": a, "source": "distilled_dimension", "scene_ids": ["S1"],
                     "conflict_status": "suppressed_by_higher_rule", "suppressed_by": b,
                     "conflict_reason": "Conflict", "conflict_dimensions": [
                         {"dimension": "voice", "suppressed_evidence": a, "suppressor_evidence": b}]}
                    for a, b in (("A", "B"), ("B", "A"))]
        with self.assertRaisesRegex(WorkflowError, "严格高于"):
            self.engine._validate_design_constraint_application(
                self.run, {"scenes": [{"scene_id": "S1"}], "constraint_application": mappings})
        self.engine._compile_stage_writing_policy = lambda *a: {"executable_style_rules": [
            {"rule_id": "A", "class": "must", "source": "distilled_dimension"},
            {"rule_id": "B", "class": "must", "source": "book_override"}]}
        mappings[1].update(source="book_override", conflict_status="active", suppressed_by="",
                           conflict_reason="", conflict_dimensions=[])
        self.engine._validate_design_constraint_application(
            self.run, {"scenes": [{"scene_id": "S1"}], "constraint_application": mappings})
