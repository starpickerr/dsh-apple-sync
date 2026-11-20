"""Three-way merge for independent text fields on a verified, bound item."""
import json

from apple_sync.approved_export import _hashes, _shape
from apple_sync.group_scan_claims import digest, schema
from apple_sync.metadata import metadata
from apple_sync.sync_recovery import _lookup, _source


class MergeInterrupted(RuntimeError):
    """Stop the claimed source while its exact merge receipt is pending."""


def _fields(kind):
    return ('title', 'notes') if kind == 'reminders' else ('title', 'description', 'location')


def merge_values(kind, mapping, local, remote, baseline):
    original = (local.get('apple') or {}).get('native')
    if (not baseline or not original or metadata(local) != baseline[0] or
            metadata(remote, True) != baseline[1] or metadata(original, True) != baseline[1]):
        return None
    base = {key: original.get(key) or '' for key in _fields(kind)}
    expected = mapping['local_hash'], mapping['remote_hash']
    if (_hashes(kind, {**local, **base}, {**remote, **base}, mapping) != expected or
            _hashes(kind, local, original, mapping)[1] != expected[1]):
        return None
    local_changes = {key: local.get(key) or '' for key in base if (local.get(key) or '') != base[key]}
    apple_changes = {key: remote.get(key) or '' for key in base if (remote.get(key) or '') != base[key]}
    if any(value != apple_changes[key] for key, value in local_changes.items() if key in apple_changes):
        return None
    return {key: value for key, value in local_changes.items() if key not in apple_changes}


def _record_phase(sync, token, group, identity, before, after, *, recover=False, finish=False):
    with sync._connect() as db:
        db.execute('BEGIN IMMEDIATE')
        schema(db)
        row = db.execute('SELECT a.state,a.evidence FROM calendar_scan_attempts a JOIN calendar_scan_groups g USING(attempt_id) '
                         'JOIN calendar_scan_items i USING(attempt_id) WHERE a.attempt_id=? AND a.group_id=g.group_id AND a.source_id=g.source_id '
                         'AND g.group_id=? AND i.local_id=?',
                         (token, group, identity)).fetchone()
        states = ('scanning', 'uncertain') if recover else ('scanning',)
        if not row or row['state'] not in states or json.loads(row['evidence']) != before:
            raise ValueError('Merge claim changed before item checkpoint')
        state = 'done' if finish else 'uncertain' if recover else 'scanning'
        db.execute('UPDATE calendar_scan_attempts SET evidence=?, state=? WHERE attempt_id=?', (json.dumps(after), state, token))
        if finish:
            db.execute('DELETE FROM calendar_scan_items WHERE attempt_id=?', (token,))
            db.execute('DELETE FROM calendar_scan_groups WHERE attempt_id=?', (token,))


def _receipt(sync, phase):
    if phase['patch'] == {} and phase['receipt_binding'] is None:
        return phase['before']
    binding = phase['receipt_binding']
    if not isinstance(binding, str) or len(binding) != 64 or any(c not in '0123456789abcdef' for c in binding):
        return None
    path = sync.db_path.parent / 'native-receipts' / (binding + '.json')
    if path.is_symlink() or not path.is_file():
        return None
    value = json.loads(path.read_text())
    saved = value.get('saved')
    if (not isinstance(saved, dict) or value != {'binding': binding, 'saved':saved}
            or {key:v for key,v in saved.items() if key != 'last_modified'}
            != {key:v for key,v in {**phase['before'], **phase['patch']}.items() if key != 'last_modified'}):
        return None
    return saved


def _apply(kind, owner, capture, native):
    local = capture['local']
    fields = {key: native.get(key) or '' for key in _fields(kind) if (local.get(key) or '') != (native.get(key) or '')}
    method = owner.apple_apply_reminder_inbound if kind == 'reminders' else owner.apple_apply_calendar_inbound
    return method(capture, fields, native, metadata_only=not fields), bool(fields)


def _commit(sync, kind, mapping, before, baselines, local, native, generation):
    commit = sync._commit_reminder_snapshot if kind == 'reminders' else sync._commit_inbound_snapshot
    commit(mapping, before, baselines, local, native, generation)


def finish_merge_receipt(sync, kind, token, phase):
    saved = _receipt(sync, phase)
    if saved is None:
        return False
    reminder = kind == 'reminders'
    owner = sync.todos if reminder else sync.calendar
    identity = phase['local_id']
    local_key, group_key, _ = _shape(kind)
    before, expected = phase['mapping'], phase['owner']
    group = before[group_key]
    category = expected['local'].get('category_id')
    links = [row for row in sync._stored_links() if row['apple_id'] == group or row['alcor_id'] == category]
    if (len(links) != 1 or not links[0]['enabled'] or links[0]['apple_id'] != group or links[0]['alcor_id'] != category
            or _lookup(sync, kind, before) != saved or any(op['local_id'] == identity for op in owner.apple_operations())):
        return False
    # Fence the original scan before touching the owner. An in-flight owner call still
    # has to pass its incarnation check, and the fenced scan cannot advance to another item.
    fenced = {**phase, 'stage':'merge_rechecking'}
    _record_phase(sync, token, group, identity, phase, fenced, recover=True)
    capture = (owner.apple_capture_reminder_sync if reminder else owner.apple_capture_calendar_sync)(
        identity, expected['local'].get('category_id'))
    if (not capture or any(capture[key] != expected[key] for key in ('generation', 'categories', 'category_generations'))
            or capture['local'].get('category_id') != category):
        return False
    local = capture['local']
    if capture == expected:
        local, _ = _apply(kind, owner, capture, saved)
    elif ((local.get('apple') or {}).get('native') != saved or
          _hashes(kind, local, saved, before) != _hashes(kind, {**expected['local'],
              **{key:saved.get(key) or '' for key in _fields(kind)}}, saved, before)):
        return False
    with sync._connect() as db:
        row = db.execute('SELECT * FROM mappings WHERE ' + local_key + '=?', (identity,)).fetchone()
    if not row:
        return False
    current = dict(row)
    if current == before:
        _commit(sync, kind, current, before, phase['baselines'], local, saved, capture['generation'])
    else:
        same = sync._mapping_from_native(local, saved, before['origin'], before['source_key'])
        same.pop('updated_at')
        if any(current.get(key) != value for key,value in same.items()):
            return False
    _record_phase(sync, token, group, identity, fenced,
                  {**fenced, 'stage':'merge_done', 'completed_at':sync.clock()}, recover=True, finish=True)
    return True


def merge_bound_item(sync, kind, mapping, capture, remote, baselines, direction, token, counts):
    if direction != 'bidirectional' or not token or mapping['state'] != 'active':
        return False
    local = capture['local']
    reminder = kind == 'reminders'
    baseline = baselines['item-metadata:'] if reminder else baselines
    patch = merge_values(kind, mapping, local, remote, baseline)
    if patch is None:
        return False
    local_key, group_key, native_key = _shape(kind)
    identity, group, source = mapping[local_key], mapping[group_key], remote.get('source_id')
    native_id = mapping[native_key]
    binding = local.get('apple') or {}
    guard = {'generation': capture['generation'], 'source_id':source, 'group_id':group}
    stored_guard = baselines['reminder-binding-generation:'] if reminder else sync._get('calendar-binding-generation:'+identity)
    if (not source or not native_id or remote.get(native_key) != native_id or remote.get(group_key) != group
            or binding.get('apple_id') != native_id or binding.get('source_id') != source or binding.get('group_id') != group
            or stored_guard != guard or mapping['missing_since']
            or (remote.get('recurrence') or {}).get('frequency') not in (None, 'none')
            or remote.get('is_detached') or local.get('repeat_frequency') != 'none'):
        return False
    owner = sync.todos if reminder else sync.calendar
    links = [row for row in sync._stored_links() if row['apple_id'] == group and row['alcor_id'] == local.get('category_id')]
    if (len(links) != 1 or not links[0]['enabled'] or links[0]['direction'] != 'bidirectional'
            or any(op['local_id'] == identity for op in owner.apple_operations())):
        return False
    fresh = (owner.apple_capture_reminder_sync if reminder else owner.apple_capture_calendar_sync)(identity, local.get('category_id'))
    if fresh != capture:
        return False
    before = dict(mapping)
    binding_id = None
    if patch:
        if not (remote.get('writable') and binding.get('can_modify') and
                sync.bridge.call('reminder_status' if reminder else 'status').get('approved_export_version') == 1):
            return False
        destination = _source(sync, kind, group, source)
        if not destination.get('writable'):
            return False
        target = {group_key:group, native_key:native_id, 'external_id':mapping['external_id']}
        if not reminder:
            if remote.get('occurrence_date') != mapping['occurrence_date']:
                return False
            target['occurrence_date'] = mapping['occurrence_date']
        binding_id = digest([token, before, remote, patch])
        receipt = sync.db_path.parent / 'native-receipts' / (binding_id + '.json')
        receipt.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if receipt.exists() or receipt.is_symlink():
            raise ValueError('Merge already has a receipt')
    phase = {'stage':'merge_sending', 'local_id':identity, 'receipt_binding':binding_id,
             'before':remote, 'patch':patch, 'mapping':before, 'owner':capture, 'baselines':baselines}
    _record_phase(sync, token, group, identity, {}, phase)
    try:
        if patch:
            remote = sync.bridge.call('reminder_upsert' if reminder else 'upsert', **target, **patch,
                                      direct_patch=True, expected_source_id=source,
                                      expected_destination_snapshot=destination, expected_snapshot=remote,
                                      receipt_file=str(receipt), receipt_binding=binding_id)['reminder' if reminder else 'event']
            if _receipt(sync, phase) != remote:
                raise ValueError('Merge receipt or saved fields changed')
        applied, inbound = _apply(kind, owner, capture, remote)
        _commit(sync, kind, mapping, before, baselines, applied, remote, capture['generation'])
        _record_phase(sync, token, group, identity, phase, {})
    except Exception as exc:
        raise MergeInterrupted('自动合并结果待核对，已保留原操作证据') from exc
    counts['updated'] += int(inbound)
    counts['exported'] += int(bool(patch))
    return True
