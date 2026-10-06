"""F19 browser receipt regressions. Only temporary local fixtures; no cloud writes."""
import json
import hashlib
import copy
import sqlite3
import unittest
from pathlib import Path

import test_tomota as fixtures
from tomota.models import ChapterContract
from tomota.publisher import FanqiePublisher, DryRunBrowserDriver
from tomota.browser_job import BrowserJobError


class ReceiptAudit(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StrictStateMachineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.store, self.root = self.fixture.store, self.fixture.root
        self.publisher = FanqiePublisher(self.store, DryRunBrowserDriver())

    def prepare(self, count=1):
        for number in range(1, count + 1):
            contract = ChapterContract('demo', number, 'Fixture', 'Goal', 'Obstacle', 'Change')
            fixtures.strict_approve(self.store, contract, f'# 第{number}章 Fixture\n\nApproved **fixture** body.')
        batch = self.publisher.prepare_batch('demo', list(range(1, count + 1)), {})
        path = self.publisher.export_browser_job(batch, confirmation=f'PUBLISH {batch.batch_id}')
        return batch, json.loads(path.read_text(encoding='utf-8'))

    def reconcile(self, batch, items, status='submitted'):
        path = self.root / 'result.json'
        self.store.write_json(path, {'batch_id': batch.batch_id, 'status': status, 'chapters': items})
        return self.publisher.reconcile_browser_job(batch, path)

    def test_missing_fingerprints_must_not_reconcile_changed_body(self):
        batch, _ = self.prepare()
        before = self.store.get_chapter('demo', 1)
        Path(before['path']).write_text('Changed and not reviewed.', encoding='utf-8')
        with self.assertRaisesRegex(BrowserJobError, 'missing.*fingerprint'):
            self.reconcile(batch, [{'chapter_number': 1, 'status': 'submitted', 'platform_id': 'mock-only-no-cloud-write'}])
        self.assertEqual(self.store.get_chapter('demo', 1), before)
        self.assertEqual(self.store.get_batch(batch.batch_id).status, batch.status)
        self.assertFalse(self.store.is_release_ready('demo', 1))

    def test_all_advancing_statuses_require_valid_fingerprints_before_any_mutation(self):
        batch, job = self.prepare(2)
        before = [self.store.get_chapter('demo', n) for n in (1, 2)]
        for status in ('submitted', 'updated', 'scheduled', 'dry_run', 'already_exists', 'skipped'):
            for fields in ({}, {'source_fingerprint': ''}, {'source_fingerprint': None},
                           {'content_fingerprint': 123}, {'source_fingerprint': 'not-a-hash'}):
                with self.subTest(status=status, fields=fields), self.assertRaises(BrowserJobError):
                    self.reconcile(batch, [
                        {**job['chapters'][0], 'status': 'submitted', 'platform_id': 'fixture-1'},
                        {'chapter_number': 2, 'status': status, 'platform_id': 'fixture-2', **fields},
                    ])
                self.assertEqual([self.store.get_chapter('demo', n) for n in (1, 2)], before)
                self.assertEqual(self.store.get_batch(batch.batch_id).status, batch.status)

    def test_source_and_platform_fingerprints_keep_their_distinct_meanings(self):
        for keys in (('source_fingerprint',), ('content_fingerprint',), ('source_fingerprint', 'content_fingerprint')):
            with self.subTest(keys=keys):
                batch, job = self.prepare()
                chapter = job['chapters'][0]
                self.assertNotEqual(chapter['source_fingerprint'], chapter['content_fingerprint'])
                receipt = {'chapter_number': 1, 'status': 'submitted', 'platform_id': 'fixture',
                           **{key: chapter[key] for key in keys}}
                self.assertEqual(self.reconcile(batch, [receipt]).status, 'submitted')
                self.assertEqual(self.reconcile(batch, [receipt]).status, 'submitted', 'valid retries stay idempotent')

    def test_snapshot_binding_rejects_wrong_or_mixed_fingerprints_and_changed_source(self):
        batch, job = self.prepare()
        chapter = job['chapters'][0]
        before = self.store.get_chapter('demo', 1)
        for key in ('source_fingerprint', 'content_fingerprint'):
            with self.subTest(key=key), self.assertRaises(BrowserJobError):
                self.reconcile(batch, [{**chapter, 'status': 'submitted', key: '0' * 64}])
        Path(before['path']).write_text('Unreviewed replacement', encoding='utf-8')
        with self.assertRaisesRegex(BrowserJobError, 'content changed'):
            self.reconcile(batch, [{'chapter_number': 1, 'status': 'submitted', 'content_fingerprint': chapter['content_fingerprint']}])
        self.assertEqual(self.store.get_chapter('demo', 1), before)

    def test_missing_export_and_superseded_batches_cannot_advance(self):
        batch, job = self.prepare()
        path = self.publisher.browser_jobs.job_path(batch)
        held = path.with_suffix('.held')
        path.rename(held)
        with self.assertRaisesRegex(BrowserJobError, 'exported browser job'):
            self.reconcile(batch, [{**job['chapters'][0], 'status': 'submitted'}])
        held.rename(path)
        self.store.update_batch(batch.batch_id, 'superseded')
        with self.assertRaisesRegex(BrowserJobError, 'superseded'):
            self.reconcile(batch, [{**job['chapters'][0], 'status': 'submitted'}])

    def test_nonadvancing_failure_receipts_do_not_require_fingerprints(self):
        batch, _ = self.prepare()
        before = self.store.get_chapter('demo', 1)
        result = self.reconcile(batch, [{'chapter_number': 1, 'status': 'not_attempted'}], status='blocked')
        self.assertEqual(result.status, 'failed')
        self.assertEqual(self.store.get_chapter('demo', 1), before)

    def test_reconcile_transaction_rolls_back_and_consumes_a_receipt_only_once(self):
        batch, job = self.prepare(2)
        before = [self.store.get_chapter('demo', n) for n in (1, 2)]
        with self.store.connect() as connection:
            count = connection.execute('SELECT count(*) FROM events').fetchone()[0]
            connection.execute("CREATE TRIGGER receipt_fault BEFORE UPDATE ON chapters WHEN NEW.chapter_number=2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END")
        items = [{**ch, 'status': 'submitted', 'platform_id': f'fixture-{ch["chapter_number"]}'} for ch in job['chapters']]
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'injected'):
            self.reconcile(batch, items)
        self.assertEqual([self.store.get_chapter('demo', n) for n in (1, 2)], before)
        self.assertEqual(self.store.get_batch(batch.batch_id).status, batch.status)
        with self.store.connect() as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM events').fetchone()[0], count)
            connection.execute('DROP TRIGGER receipt_fault')
        self.assertEqual(self.reconcile(batch, items).status, 'submitted')
        with self.store.connect() as connection:
            count = connection.execute('SELECT count(*) FROM events').fetchone()[0]
        with self.assertRaisesRegex(RuntimeError, 'rollback fixture'):
            with self.store.recoverable_book_change('demo'):
                self.store.update_chapter_status('demo', 1, 'draft')
                raise RuntimeError('rollback fixture')
        self.assertEqual(self.reconcile(batch, items).status, 'submitted')
        with self.store.connect() as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM events').fetchone()[0], count)
            self.assertEqual(connection.execute('SELECT count(*) FROM browser_receipt_consumptions').fetchone()[0], 1)

    def test_export_preserves_snapshot_and_check_never_reexports(self):
        batch, job = self.prepare()
        path = self.publisher.browser_jobs.job_path(batch)
        job.update(schema_version=3, platform_work_id='7675620772693429273')
        self.store.write_json(path, job)
        before = path.read_bytes()
        self.publisher.export_browser_job(batch, confirmation=f'PUBLISH {batch.batch_id}')
        self.publisher.browser_jobs.check(batch)
        self.assertEqual(path.read_bytes(), before)
        self.store.write_json(path.with_suffix('.started.json'), {'batch_id': batch.batch_id})
        path.unlink()
        self.publisher.browser_jobs.check(batch)
        self.assertFalse(path.exists())
        with self.assertRaisesRegex(BrowserJobError, 'snapshot missing'):
            self.publisher.export_browser_job(batch, confirmation=f'PUBLISH {batch.batch_id}')

    def test_schema3_requires_full_bound_proof_before_mutating_any_chapter(self):
        batch, job = self.prepare()
        job.update(schema_version=3, platform_work_id='7675620772693429273')
        self.store.write_json(self.publisher.browser_jobs.job_path(batch), job)
        chapter = job['chapters'][0]
        normalized = '\n'.join(p.strip() for p in chapter['content'].splitlines() if p.strip())
        item = {**chapter, 'status': 'submitted', 'submission_started': True,
                'platform_id': '7675641066854302233', 'preexisting_platform_ids': [],
                'platform_verification': {'kind': 'chapter_content', 'platform_work_id': job['platform_work_id'],
                    'platform_chapter_id': '7675641066854302233', 'chapter_number': 1, 'title': chapter['title'],
                    'status': '审核中', 'content_fingerprint': chapter['content_fingerprint'],
                    'normalized_content_hash': hashlib.sha256(normalized.encode()).hexdigest()}}
        before = self.store.get_chapter('demo', 1)
        path = self.root / 'proof.result.json'
        for key, value in [('kind', 'chapter_directory'), ('platform_work_id', 'wrong'),
                           ('platform_chapter_id', 'other'), ('status', '草稿'),
                           ('normalized_content_hash', 'a' * 64), ('content_fingerprint', 'b' * 64)]:
            bad = copy.deepcopy(item)
            bad['platform_verification'][key] = value
            # Downgrading the receipt cannot bypass an exported schema3 job.
            self.store.write_json(path, {'schema_version': 2, 'book_id': 'demo', 'batch_id': batch.batch_id, 'status': 'submitted', 'chapters': [bad]})
            with self.subTest(key=key), self.assertRaises(BrowserJobError):
                self.publisher.reconcile_browser_job(batch, path)
            self.assertEqual(self.store.get_chapter('demo', 1), before)
        self.store.write_json(path, {'schema_version': 3, 'book_id': 'demo', 'batch_id': batch.batch_id, 'status': 'submitted', 'chapters': [item]})
        self.assertEqual(self.publisher.reconcile_browser_job(batch, path).status, 'submitted')


if __name__ == '__main__':
    unittest.main()
