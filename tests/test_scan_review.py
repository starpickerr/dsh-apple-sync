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
from apple_sync.sync_recovery import check_scan


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
