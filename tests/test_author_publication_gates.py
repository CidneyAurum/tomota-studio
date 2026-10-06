"""Regression tests for authoritative author publication boundaries."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tomota.authors import AuthorService
from test_tomota import author_profile


class AuthorPublicationGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.service = AuthorService(self.directory.name)
        self.author_id = self.service.create_profile("publication audit")["id"]

    def test_no_source_distilled_profile_rejected_before_insert(self):
        profile = author_profile()
        profile["provenance"] = {"kind": "distilled", "evidence": []}
        for status in ("draft", "published"):
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "source_manifest"):
                self.service.create_version(self.author_id, profile, status=status)
        with self.service.store.connect() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM author_profile_versions WHERE author_id=?", (self.author_id,),
            ).fetchone()[0], 0)

    def test_existing_invalid_distilled_draft_cannot_publish(self):
        version = self.service.create_version(self.author_id, author_profile())
        profile = version["profile"]
        profile["provenance"] = {"kind": "distilled", "evidence": []}
        with self.service.store.connect() as connection:
            connection.execute("UPDATE author_profile_versions SET profile_json=? WHERE id=?",
                               (json.dumps(profile), version["id"]))
        with self.assertRaisesRegex(ValueError, "source_manifest"):
            self.service.publish_version(self.author_id, version["id"])
        self.assertEqual(self.service.get_version(version["id"])["status"], "draft")

    def test_direct_publication_uses_quality_gate_before_insert(self):
        with patch.object(self.service, "_validate_publication_quality", side_effect=ValueError("quality blocked")):
            with self.assertRaisesRegex(ValueError, "quality blocked"):
                self.service.create_version(self.author_id, author_profile(), status="published")
        with self.service.store.connect() as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM author_profile_versions WHERE author_id=?", (self.author_id,),
            ).fetchone()[0], 0)

    def test_manual_publication_remains_supported(self):
        direct = self.service.create_version(self.author_id, author_profile(), status="published")
        draft = self.service.create_version(self.author_id, author_profile())
        self.assertEqual(direct["status"], "published")
        self.assertEqual(self.service.publish_version(self.author_id, draft["id"])["status"], "published")

    def test_unknown_creation_status_rejected(self):
        with self.assertRaisesRegex(ValueError, "status"):
            self.service.create_version(self.author_id, author_profile(), status="ready")

    def test_duplicate_sources_cannot_inflate_corpus(self):
        with self.assertRaisesRegex(ValueError, "不能重复"):
            self.service._source_manifest(self.author_id, ["same", "same"])

    def test_mutated_source_rejected_against_frozen_hash(self):
        path = Path(self.directory.name) / "source.txt"
        path.write_text("原始来源内容。" * 50, encoding="utf-8")
        source = self.service.add_source(self.author_id, path, "source.txt", rights_confirmed=True)
        manifest = self.service._source_manifest(self.author_id, [source["id"]])
        (self.service.root / source["text_path"]).write_text("已被替换的来源。", encoding="utf-8")
        profile = {"provenance": {"kind": "distilled", "evidence": []},
                   "style_dimensions": [{} for _ in range(66)], "application_blueprint": {},
                   "distillation_quality": {"corpus_coverage": 100}}
        with self.assertRaisesRegex(ValueError, "text_hash"):
            self.service._validate_distilled_profile(self.author_id, profile, manifest)
