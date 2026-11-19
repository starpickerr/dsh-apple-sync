import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from apple_sync.bridge import BridgeError
from apple_sync.direct import DirectApple


class Native:
    def __init__(self):
        self.calls = []
        self.error = False
        self.current = {'event_id': 'e', 'calendar_id': 'chosen', 'source_id': 'a', 'title': 'old',
                        'start_at': '2026-11-19T01:00:00Z', 'end_at': '2026-11-19T02:00:00Z',
                        'occurrence_date': '2026-11-19T01:00:00Z', 'all_day': False, 'writable': True}

    def call(self, op, **payload):
        self.calls.append((op, payload))
        if op == 'status':
            return {'authorization': 'full_access'}
        if op == 'calendars':
            return {'default_id': 'chosen', 'calendars': [
                {'id': 'chosen', 'source': 'Synthetic', 'source_id': 'a', 'title': 'Work', 'writable': True},
                {'id': 'other', 'source': 'Synthetic', 'source_id': 'b', 'title': 'Other', 'writable': False},
            ]}
        if op == 'events':
            return {'events': [self.current, dict(self.current, calendar_id='other')], 'failed_calendar_ids': []}
        if op == 'lookup':
            return {'event': self.current}
        if op == 'upsert':
            if self.error:
                raise BridgeError('simulated loss after dispatch')
            return {'event': dict(self.current, title=payload['title'])}
        raise AssertionError(op)


class DirectTests(unittest.TestCase):
    def setUp(self):
        root = self.enterContext(tempfile.TemporaryDirectory())
        self.native = Native()
        self.apple = DirectApple(root, self.native)

    def edit(self):
        return self.apple.prepare('calendar', 'update', {
            'calendar_id': 'chosen', 'event_id': 'e', 'occurrence_date': self.native.current['occurrence_date'],
            'title': 'new',
        }, ['chosen'], 'b' * 64)

    def test_queries_are_limited_to_selected_sources(self):
        window = {'start': '2026-11-19T00:00:00Z', 'end': '2026-11-20T00:00:00Z'}
        result = self.apple.query('calendar', window, ['chosen'])
        self.assertEqual([row['calendar_id'] for row in result['items']], ['chosen'])
        self.assertEqual(self.native.calls[-1][1]['calendar_ids'], ['chosen'])
        with self.assertRaises(PermissionError):
            self.apple.query('calendar', dict(window, calendar_id='other'), ['chosen'])

    def test_edit_is_bound_to_current_item_and_needs_live_approval(self):
        plan = self.edit()
        self.assertEqual(plan['payload']['expected_snapshot'], self.native.current)
        self.assertEqual(plan['changes'], {'title': 'new'})
        with self.assertRaises(PermissionError):
            self.apple.commit(plan, lambda _: False)
        self.assertFalse(any(op == 'upsert' for op, _ in self.native.calls))
        result = self.apple.commit(plan, lambda _: True)
        self.assertEqual(result['item']['title'], 'new')
        self.assertEqual(self.apple.commit(plan, lambda _: True)['status'], 'needs_review')
        self.assertEqual(sum(op == 'upsert' for op, _ in self.native.calls), 1)

    def test_uncertain_outcome_is_not_replayed(self):
        plan = self.edit()
        self.native.error = True
        self.assertEqual(self.apple.commit(plan, lambda _: True)['status'], 'needs_review')
        self.native.error = False
        self.assertEqual(self.apple.commit(plan, lambda _: True)['status'], 'needs_review')
        self.assertEqual(sum(op == 'upsert' for op, _ in self.native.calls), 1)
