import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionStatus, needsDecision, reviewItems, syncStatusLabel } from '../src/presentation.js'

test('only content choices appear under Needs your confirmation during recovery', () => {
  const state = { connected: true, auto_enabled: true, authorization: 'full_access',
    sync_result: { status: 'partial', checked_group_ids: [] },
    scan_claims: [{ group_id: 'one', state: 'uncertain' },
      { group_id: 'two', state: 'scanning', background_check: true }],
    operations: [{ id: 'task', action: 'complete', state: 'pending' }] }
  const rows = reviewItems(state, 'reminders')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.filter(needsDecision), [])
  assert.equal(syncStatusLabel(connectionStatus(state, false), rows, state), '部分内容暂未更新')
  state.conflicts = [{ todo_id: 'different', title: 'Two versions' }]
  const withConflict = reviewItems(state, 'reminders')
  assert.deepEqual(withConflict.filter(needsDecision).map(row => row.title), ['Two versions'])
  assert.equal(syncStatusLabel(connectionStatus(state, false), withConflict, state), '1 项需要你确认')
})
