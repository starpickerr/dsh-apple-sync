"""Owner-directed recovery must preserve both versions and never replay Apple writes."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from apple_sync import group_scan_claims as claims
from apple_sync.metadata import metadata
from apple_sync.reminders import AppleReminderSync, _hash
from apple_sync.sync_recovery import check_scan, recover_receipts


class ReminderScanReview(unittest.TestCase):
    def setUp(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        self.native = {'list_id': 'list', 'source_id': 'account', 'reminder_id': 'remote',
                       'external_id': 'external', 'title': 'Reminder'}
        binding = {'group_id': 'list', 'source_id': 'account', 'apple_id': 'remote'}
        self.local = {'id': 'local', 'category_id': 'category', 'apple': binding, 'title': 'Reminder'}
        owner = Mock()
        owner.get_category.return_value = {'id': 'category', 'apple': {**binding, 'apple_id': 'list'}}
        owner.list_todos.return_value = [self.local]
        self.pending = {'id': 'operation', 'state': 'pending', 'entity': 'item', 'action': 'complete',
                        'local_id': 'local', 'binding': binding, 'document': {'completed': True}}
        owner.apple_operations.return_value = [self.pending]
        reads = {'reminder_status': {'authorization': 'full_access'},
                 'reminder_lists': {'source_ids': ['account'], 'lists': [{'id': 'list', 'source_id': 'account'}]},
                 'reminders': {'successful_list_ids': ['list'], 'reminders': [self.native]}}
        bridge = Mock()
        bridge.call.side_effect = lambda method, **args: reads[method]
        self.sync = AppleReminderSync(bridge=bridge, db_path=Path(folder) / 'reminders.sqlite3', todo_port=owner)
        with self.sync._connect() as db:
            db.execute("INSERT INTO category_links VALUES ('list','category','bidirectional',1,'List','List','','now')")
            db.execute("INSERT INTO mappings VALUES ('local','key','list','remote','external','apple',?,?,'active','','','now')",
                       (_hash(self.local), _hash(self.native, remote=True)))
            db.execute("INSERT INTO mappings VALUES ('removed','oldkey','list','gone','gone','apple','','','deleted','','','now')")
        self.sync._set('item-metadata:local', [metadata(self.local), metadata(self.native, True)])
        self.token = claims.acquire(self.sync, 'account', 'list', {'kind': 'reminder_scan'})
        claims.claim_items(self.sync, self.token, ['local', 'removed'])
        claims.uncertain(self.sync, self.token)

    def review(self, revision=None):
        return check_scan(self.sync, 'reminders', self.token, revision)

    def test_pending_completion_survives_manual_conflict_handoff(self):
        stable = self.review()
        self.assertEqual(stable['differences'], [])
        self.native['title'] = 'Edited in Apple'
        with self.assertRaisesRegex(ValueError, '重新核对'):
            self.review(stable['revision'])
        preview = self.review()
        self.assertEqual(preview['differences'], ['Reminder'])
        self.assertEqual(self.review(preview['revision'])['status'], 'baseline_restored')
        self.assertFalse(claims.status(self.sync))
        self.assertEqual({row['todo_id']: row['state'] for row in self.sync._maps()},
                         {'local': 'conflict', 'removed': 'deleted'})
        self.assertEqual(self.local['title'], 'Reminder')
        self.assertEqual(self.native['title'], 'Edited in Apple')
        self.assertEqual(self.pending['state'], 'pending')

    def test_unknown_send_or_changed_identity_keeps_claim(self):
        self.pending['state'] = 'sending'
        self.assertEqual(self.review()['status'], 'needs_evidence')
        self.pending['state'] = 'pending'
        self.native['external_id'] = 'unrelated'
        result = self.review()
        self.assertIn('Reminder', result['message'])
        self.assertNotIn('revision', result)
        self.assertEqual(len(claims.status(self.sync)), 1)

    def test_background_resume_keeps_completion_times_on_both_sides(self):
        self.local.update(status='completed', completed_at='2026-11-23T12:00:00Z')
        self.native.update(completed=True, completed_at='2026-11-24T07:00:00Z')
        for _ in range(2):
            recover_receipts(self.sync, 'reminders')
            self.assertFalse(claims.status(self.sync))
            self.assertEqual(self.sync._maps()[0]['state'], 'active')
        self.assertEqual(self.local['completed_at'], '2026-11-23T12:00:00Z')
        self.assertEqual(self.native['completed_at'], '2026-11-24T07:00:00Z')
        self.assertEqual(self.pending['state'], 'pending')

    def test_background_hands_off_only_the_changed_item(self):
        self.native['title'] = 'Other version'
        recover_receipts(self.sync, 'reminders')
        self.assertFalse(claims.status(self.sync))
        self.assertEqual({row['todo_id']: row['state'] for row in self.sync._maps()},
                         {'local': 'conflict', 'removed': 'deleted'})
        self.assertEqual(self.local['title'], 'Reminder')
        self.assertEqual(self.native['title'], 'Other version')

    def test_background_preserves_an_unverified_reminder_scan(self):
        self.native['external_id'] = 'other'
        recover_receipts(self.sync, 'reminders')
        self.assertEqual([row['attempt_id'] for row in claims.status(self.sync)], [self.token])

    def test_only_stale_presend_category_check_can_be_replaced(self):
        from apple_sync import sync_recovery
        self.review(self.review()['revision'])
        with self.sync._connect() as db:
            link = dict(db.execute('SELECT * FROM category_links').fetchone())
        mappings = self.sync._maps()
        evidence = {'kind': 'category_properties', 'native': {'id': 'list', 'source_id': 'account'},
                    'link': link, 'expected': {'local_id': 'category'}, 'mappings': mappings}
        claim = claims.WorkClaim(self.sync, {'list': 'account'}, [m['todo_id'] for m in mappings], evidence)
        with self.assertRaisesRegex(ValueError, 'claim or evidence changed'):
            with claim:
                sync_recovery.recover_receipts(self.sync, 'reminders')
                self.assertEqual(claims.status(self.sync)[0]['attempt_id'], claim.tokens[0])
                with self.sync._connect() as db:
                    db.execute("UPDATE calendar_scan_attempts SET started_at='2001-01-01' WHERE attempt_id=?", claim.tokens)
                sync_recovery.recover_receipts(self.sync, 'reminders')
                self.assertFalse(claims.status(self.sync))
                claim.started()
        self.assertEqual(self.sync._maps(), mappings)

    def test_background_leaves_an_interrupted_write_held(self):
        self.review(self.review()['revision'])
        claim = claims.WorkClaim(self.sync, {'list': 'account'}, [], {'kind': 'category_properties'})
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            with claim:
                claim.started()
                raise RuntimeError('interrupted')
        recover_receipts(self.sync, 'reminders')
        self.assertEqual(claims.status(self.sync)[0]['stage'], 'sending')
