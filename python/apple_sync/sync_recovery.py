"""Scoped reconciliation of existing sync evidence, without replaying native writes."""
import json
import secrets

from apple_sync import group_scan_claims as claims
from apple_sync.approved_export import _hashes, _same_native_item, _shape
from apple_sync.categories import verify_category_source
from apple_sync.runtime import report_sync_error


def _source(sync, kind, group_id, source_id=None):
    reminder = kind == 'reminders'
    status = sync.bridge.call('reminder_status' if reminder else 'status')
    if status.get('authorization') != 'full_access':
        raise claims.ScanUnavailable('需要 Apple 完整访问权限')
    inventory = sync.bridge.call('reminder_lists' if reminder else 'calendars')
    matches = [row for row in inventory['lists' if reminder else 'calendars'] if row['id'] == group_id]
    if (len(matches) != 1 or not matches[0].get('source_id')
            or matches[0]['source_id'] not in inventory['source_ids']
            or source_id is not None and matches[0]['source_id'] != source_id):
        raise claims.ScanUnavailable('Apple 账户或来源身份无法核实')
    return matches[0]


def _lookup(sync, kind, row):
    reminder = kind == 'reminders'
    keys = ('list_id', 'reminder_id', 'external_id') if reminder else ('calendar_id', 'event_id', 'external_id', 'occurrence_date')
    singular = 'reminder' if reminder else 'event'
    return sync.bridge.call('reminder_lookup' if reminder else 'lookup', **{key:row[key] for key in keys}).get(singular)


def _matches_mapping(kind, mapping, native):
    return _same_native_item(kind, mapping, native) and native.get('external_id') == mapping['external_id']


def _legacy_scan_rows(db, attempt):
    group, token, source = attempt['group_id'], attempt['attempt_id'], attempt['source_id']
    current = db.execute(
        'SELECT a.* FROM calendar_scan_groups g JOIN calendar_scan_attempts a USING(attempt_id) '
        'WHERE g.group_id=? AND g.attempt_id=? AND g.source_id=?', (group, token, source)).fetchone()
    if not current or dict(current) != dict(attempt):
        return None
    from apple_sync.export_reservations import schema
    if schema(db):
        for table in ('trusted_export_reservations', 'ordinary_export_claims'):
            if db.execute(f'SELECT 1 FROM {table} WHERE group_id=? OR local_id IN '
                          '(SELECT local_id FROM calendar_scan_items WHERE attempt_id=?)', (group, token)).fetchone():
                return None
    link = db.execute('SELECT * FROM category_links WHERE apple_id=? AND enabled=1', (group,)).fetchone()
    if not link:
        return None
    held = [row[0] for row in db.execute('SELECT local_id FROM calendar_scan_items WHERE attempt_id=? ORDER BY local_id', (token,))]
    mapped = []
    for row in db.execute("SELECT m.*,s.value AS baseline FROM mappings m LEFT JOIN settings s ON s.key='item-metadata:'||m.alcor_id "
                          "WHERE m.calendar_id=? ORDER BY m.id", (group,)):
        mapping = dict(row)
        baseline = mapping.pop('baseline')
        mapped.append((mapping, json.loads(baseline) if baseline else None))
    return dict(link), held, mapped


def _legacy_scan_proof(sync, attempt, target, window, rows, locals_by_id, native_by_id):
    from apple_sync.calendar_rebind import _instant
    from apple_sync.metadata import metadata
    link, held, mapped = rows
    held_ids = set(held)
    if not held_ids:
        return None
    verify_category_source(sync.calendar.get_category(link['alcor_id']), link, target)
    lower, upper = map(_instant, window)
    live_ids, checked = set(), {}
    for mapping, baseline in mapped:
        identity = mapping['alcor_id']
        local = locals_by_id.get(identity)
        native = [item for item in native_by_id.get(mapping['event_id'], ())
                  if _matches_mapping('calendar', mapping, item)]
        if not native and not lower <= _instant(mapping['occurrence_date']) < upper and identity not in held_ids:
            continue
        if mapping['state'] == 'remote_deleted' and not native and not local and identity not in held_ids:
            continue  # Preserve established tombstones.
        if mapping['state'] != 'active' or mapping['missing_since'] or not local or len(native) != 1 or id(native[0]) in live_ids:
            return None
        apple = native[0]
        binding = local.get('apple') or {}
        if (local.get('category_id') != link['alcor_id'] or binding.get('group_id') != attempt['group_id']
                or binding.get('apple_id') != mapping['event_id'] or binding.get('source_id') != attempt['source_id']
                or _hashes('calendar', local, apple, mapping) != (mapping['local_hash'], mapping['remote_hash'])
                or baseline != [metadata(local), metadata(apple, True)]):
            return None
        checked[identity] = [local, apple]
        live_ids.add(id(apple))
    if len(live_ids) != sum(map(len, native_by_id.values())) or not held_ids.issubset(checked):
        return None
    if any(op['local_id'] in checked or op['local_id'] == link['alcor_id']
           or (op.get('binding') or {}).get('group_id') == attempt['group_id'] for op in sync.calendar.apple_operations()):
        return None
    return claims.digest([dict(attempt), target, rows, checked])


def _release_category_check(sync, kind, attempt, document, target):
    # Category property writes must leave "claimed" before calling Apple or the owner.
    operation = document['evidence']
    group, source, token = attempt['group_id'], attempt['source_id'], attempt['attempt_id']
    link = operation['link']
    if (attempt['state'] != 'uncertain' or document.get('groups') != {group: source}
            or operation['native'].get('id') != group or operation['native'].get('source_id') != source
            or link.get('apple_id') != group or operation['expected'].get('local_id') != link.get('alcor_id')):
        return False
    owner = sync.todos if kind == 'reminders' else sync.calendar
    verify_category_source(owner.get_category(link['alcor_id']), link, target)
    local_key, group_key, _ = _shape(kind)
    mappings = operation['mappings']
    if (any(row[group_key] != group for row in mappings)
            or sorted(row[local_key] for row in mappings) != document['items']):
        return False
    with sync._connect() as db:
        db.execute('BEGIN IMMEDIATE')
        claims.schema(db)
        current = db.execute('SELECT a.* FROM calendar_scan_groups g JOIN calendar_scan_attempts a USING(attempt_id) '
                             'WHERE g.group_id=? AND g.source_id=? AND g.attempt_id=?', (group, source, token)).fetchone()
        linked = db.execute('SELECT alcor_id FROM category_links WHERE apple_id=?', (group,)).fetchone()
        held = [row[0] for row in db.execute('SELECT local_id FROM calendar_scan_items WHERE attempt_id=? ORDER BY local_id', (token,))]
        if not current or dict(current) != dict(attempt) or not linked or linked[0] != link['alcor_id'] or held != document['items']:
            return False
        audit = {**document, 'result': 'not_sent', 'completed_at': sync.clock()}
        db.execute("UPDATE calendar_scan_attempts SET state='not_sent', evidence=? WHERE attempt_id=?", (json.dumps(audit), token))
        db.execute('DELETE FROM calendar_scan_items WHERE attempt_id=?', (token,))
        db.execute('DELETE FROM calendar_scan_groups WHERE attempt_id=?', (token,))
    return True


def _finish_operation_receipt(sync, kind, attempt_id, operation):
    if operation.get('kind') == 'manual_item_restore':
        from apple_sync.item_restore import finish_pending
        owner = sync.todos if kind == 'reminders' else sync.calendar
        identity = operation['plan']['local_id']
        journal = sync._get('manual-item-restore:' + identity)
        if journal and journal['evidence'] == operation and finish_pending(sync, owner, kind, identity):
            return True
    if operation.get('kind') == 'bound_item_conflict':
        from apple_sync.bound_conflict import _key, run
        owner = sync.todos if kind == 'reminders' else sync.calendar
        journal = sync._get(_key(operation['item']['local_id']))
        if journal and journal['plan']['plan_fingerprint'] == operation['plan_fingerprint']:
            result = run(sync, owner, kind, journal['plan'], lambda *_: False, receipt_only=True)
            if result['status'] == 'success':
                return True
    if operation.get('action') in ('delete', 'truncate', 'exclude') and operation.get('id'):
        from apple_sync.approved_delete import finish_receipts
        finished, _, _, errors = finish_receipts(sync, operation_id=operation['id'])
        if finished and not errors:
            return not any(row['attempt_id'] == attempt_id for row in claims.status(sync))
    return False


def check_scan(sync, kind, attempt_id, revision=None):
    with sync._connect() as db:
        db.execute('BEGIN')
        if not claims.schema(db):
            return {'status': 'gone'}
        attempt = db.execute(
            'SELECT a.* FROM calendar_scan_attempts a JOIN calendar_scan_groups g USING(attempt_id) '
            'WHERE a.attempt_id=? AND a.group_id=g.group_id AND a.source_id=g.source_id', (attempt_id,)
        ).fetchone()
        if not attempt:
            return {'status': 'gone'}
        held = db.execute('SELECT count(*) FROM calendar_scan_items WHERE attempt_id=?', (attempt_id,)).fetchone()[0]
        evidence = json.loads(attempt['evidence'])
        legacy = kind == 'calendar' and attempt['state'] == 'uncertain' and evidence == {}
        rows = _legacy_scan_rows(db, attempt) if legacy else None
    if revision is not None and not rows:
        raise ValueError('旧同步范围已变化，请重新核对')
    reminder = kind == 'reminders'
    window = json.loads(attempt['window'])
    try:
        target = _source(sync, kind, attempt['group_id'], attempt['source_id'])
        if evidence.get('stage') in ('merge_sending', 'merge_rechecking'):
            from apple_sync.sync_merge import finish_merge_receipt
            if finish_merge_receipt(sync, kind, attempt_id, evidence):
                return {'status': 'receipt_finished'}
            return {'status': 'needs_evidence', 'held': held, 'checked': None}
        if reminder and window == {'kind': 'reminder_scan'}:
            group_key, rows_key, successful_key = 'list_id', 'reminders', 'successful_list_ids'
            inventory = sync.bridge.call('reminders', list_ids=[attempt['group_id']])
        elif not reminder and isinstance(window, list) and len(window) == 2:
            group_key, rows_key, successful_key = 'calendar_id', 'events', 'successful_calendar_ids'
            inventory = sync.bridge.call('events', calendar_ids=[attempt['group_id']], start=window[0], end=window[1])
        else:
            if window == {'kind': 'manager_work'} and claims.unstarted_category_check(evidence):
                if _release_category_check(sync, kind, attempt, evidence, target):
                    return {'status': 'released'}
                return {'status': 'needs_evidence', 'held': held, 'checked': None}
            if _finish_operation_receipt(sync, kind, attempt_id, evidence.get('evidence', {})):
                return {'status': 'receipt_finished'}
            return {'status': 'needs_evidence', 'held': held, 'checked': None}
        if (attempt['group_id'] not in inventory.get(successful_key, [])
                or attempt['group_id'] in inventory.get(successful_key.replace('successful_', 'failed_'), [])
                or any(row.get(group_key) != attempt['group_id'] or row.get('source_id') != attempt['source_id']
                       for row in inventory[rows_key])):
            raise claims.ScanUnavailable('Apple 来源的读取范围不完整')
    except claims.ScanUnavailable:
        return {'status': 'source_unavailable', 'held': held}
    if evidence == {'stage': 'reading'}:
        with sync._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            claims.schema(db)
            if claims._release_reading(db, attempt_id, attempt['source_id']):
                return {'status': 'released', 'checked': len(inventory[rows_key])}
    local_key, group_key, native_key = _shape(kind)
    local = (sync.todos.list_todos() if reminder else sync.calendar.list_events())
    locals_by_id = {row['id']:row for row in local}
    native_by_id = {}
    for row in inventory[rows_key]:
        native_by_id.setdefault(row[native_key], []).append(row)
    matched = unchanged = 0
    with sync._connect() as db:
        mappings = [dict(row) for row in db.execute('SELECT * FROM mappings WHERE ' + group_key + '=?', (attempt['group_id'],))]
    for row in mappings:
        native = [item for item in native_by_id.get(row[native_key], ())
                  if _matches_mapping(kind, row, item)]
        if len(native) == 1:
            matched += 1
            local = locals_by_id.get(row[local_key])
            if local and _hashes(kind, local, native[0], row) == (row['local_hash'], row['remote_hash']):
                unchanged += 1
    result = {'status': 'needs_evidence', 'held': held, 'checked': len(inventory[rows_key]), 'matched': matched, 'unchanged': unchanged}
    proof = _legacy_scan_proof(sync, attempt, target, window, rows, locals_by_id, native_by_id) if rows is not None else None
    if revision is None:
        return {**result, 'status': 'verified', 'revision': proof} if proof else result
    if not proof or revision != proof:
        raise ValueError('内容、关联或范围已变化，请重新核对')
    # Close the obsolete claim, preserving the observed baseline and original attempt.
    with sync._connect() as db:
        db.execute('BEGIN IMMEDIATE')
        claims.schema(db)
        if _legacy_scan_rows(db, attempt) != rows:
            raise ValueError('同步占用或范围已变化，请重新核对')
        audit = {'stage':'verified_baseline', 'previous_state':'uncertain', 'revision':proof,
                 'checked':result['checked'], 'held':held, 'completed_at':sync.clock()}
        db.execute("UPDATE calendar_scan_attempts SET state='done', evidence=? WHERE attempt_id=?", (json.dumps(audit), attempt_id))
        db.execute('DELETE FROM calendar_scan_items WHERE attempt_id=?', (attempt_id,))
        db.execute('DELETE FROM calendar_scan_groups WHERE attempt_id=?', (attempt_id,))
    return {**result, 'status': 'baseline_restored'}


def recover_receipts(sync, kind):
    with sync._connect() as db:
        if not claims.schema(db):
            return
        pending = [row[0] for row in db.execute(
            "SELECT g.attempt_id FROM calendar_scan_groups g CROSS JOIN calendar_scan_attempts a USING(attempt_id) "
            "WHERE json_extract(a.evidence, '$.stage') IN ('merge_sending','merge_rechecking') "
            "OR json_extract(a.evidence, '$.evidence.kind') IN ('manual_item_restore','bound_item_conflict') "
            "OR (a.state='uncertain' AND json_extract(a.evidence, '$.stage')='claimed' "
            "AND json_extract(a.evidence, '$.evidence.kind')='category_properties')")]
    for attempt_id in pending:
        try:
            check_scan(sync, kind, attempt_id)
        except Exception as exc:
            report_sync_error(kind, '核对同步回执', exc)


def legacy_observation(sync, kind, identity):
    local_key, group_key, native_key = _shape(kind)
    owner = sync.todos if kind == 'reminders' else sync.calendar
    with sync._connect() as db:
        observed = db.execute('SELECT * FROM mappings WHERE ' + local_key + '=?', (identity,)).fetchone()
    if not observed or observed['state'] != 'pending_delete':
        raise ValueError('旧删除状态已变化，请刷新')
    mapping = dict(observed)
    group = mapping[group_key]
    matches = [row for row in sync._stored_links() if row['apple_id'] == group and row['enabled']]
    if len(matches) != 1:
        raise ValueError('原同步关联暂不可用')
    link = matches[0]
    target = _source(sync, kind, group)
    verify_category_source(owner.get_category(link['alcor_id']), link, target)
    if any(row['local_id'] == identity for row in owner.apple_operations()):
        raise ValueError('项目另有待处理操作，请先核对该操作')
    native = _lookup(sync, kind, mapping)
    if (not native or native.get('source_id') != target['source_id']
            or any(native.get(key) != mapping[key] for key in (group_key, native_key, 'external_id'))
            or kind == 'calendar' and native.get('occurrence_date') != mapping['occurrence_date']):
        raise ValueError('Apple 原项目身份无法核实')
    return {'mapping': mapping, 'link': link, 'target': target, 'native': native}


def preview_legacy(sync, kind, identity):
    observation = legacy_observation(sync, kind, identity)
    return {'revision': claims.digest(observation), 'title': observation['native']['title'],
            'source': observation['target']['title'], 'can_restore': sync._local(identity) is None}


def keep_legacy(sync, kind, identity, revision):
    expected = legacy_observation(sync, kind, identity)
    if claims.digest(expected) != revision:
        raise ValueError('Apple 内容或关联已变化，请重新核对')
    local_key, group_key, _ = _shape(kind)
    groups = {expected['mapping'][group_key]: expected['target']['source_id']}
    with claims.WorkClaim(sync, groups, [identity], {'kind': 'legacy_keep', 'revision': revision}) as claim:
        if legacy_observation(sync, kind, identity) != expected:
            raise ValueError('Apple 内容或关联已变化，请重新核对')
        with sync._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            claim._check(db)
            current = db.execute('SELECT * FROM mappings WHERE ' + local_key + '=?', (identity,)).fetchone()
            if not current or dict(current) != expected['mapping']:
                raise ValueError('旧删除状态已变化，请重新核对')
            # Persist the keep decision so a missing Alcor copy cannot queue this again.
            sync._save_map({**expected['mapping'], 'state': 'legacy_kept', 'conflict': '', 'updated_at': sync.clock()}, connection=db)
    return {'status': 'kept'}


def compare_record(sync, kind, identity):
    from apple_sync.bound_conflict import _prepare
    plan = _prepare(sync, kind, {'kind': kind, 'choice': 'keep_apple', 'identity': identity}, secrets.token_hex(32))
    item = plan['items'][0]
    raw_local, raw_native = item['owner_snapshot']['local'], item['native_snapshot']
    from apple_sync.metadata import metadata
    if kind == 'reminders':
        from apple_sync.reminders import _compatible
        local, native = _compatible(raw_local), _compatible(raw_native, remote=True)
    else:
        from apple_sync.calendar import _content
        local, native = _content(raw_local), _content(raw_native)
    for values, raw, apple in ((local, raw_local, False), (native, raw_native, True)):
        source = metadata(raw, apple)
        values.update({key: source[key] for key in ('timezone', 'url', 'alarms', 'floating')})
        values['repeat'] = source['native_recurrence']
    revision = conflict_revision(plan)
    try:
        outgoing = _prepare(sync, kind, {**plan['arguments'], 'choice':'keep_alcor'}, plan['operation_id'])
        can_write = conflict_revision(outgoing) == revision
    except (PermissionError, ValueError):
        can_write = False
    return {'revision': revision, 'can_write': can_write,
            'differences': [{'field': key, 'alcor': local[key], 'apple': native[key]}
                            for key in local if local[key] != native[key]]}


def compare_identity(sync, kind, identity):
    prefix = 'reminder' if kind == 'reminders' else 'calendar'
    record = sync._get(prefix + '-identity-candidate:' + identity)
    if not record:
        raise ValueError('候选已变化，请刷新同步状态')
    local_key, group_key, native_key = _shape(kind)
    saved = record['native']
    link_ids = {row['apple_id'] for row in sync._stored_links() if row['enabled']}
    if saved[group_key] not in link_ids:
        raise ValueError('原候选来源已取消关联')
    target = _source(sync, kind, saved[group_key], saved['source_id'])
    live = _lookup(sync, kind, saved)
    keys = (group_key, native_key, 'source_id', 'external_id') + (('occurrence_date',) if kind == 'calendar' else ())
    if not live or any(live.get(key) != saved.get(key) for key in keys):
        raise ValueError('无法核实 Apple 候选，请同步后重新查看')
    originals = []
    for mapping in sync._maps():
        if mapping[local_key] not in record['mapping_ids']:
            continue
        local = sync._local(mapping[local_key])
        if not local:
            continue
        binding = local.get('apple') or {}
        originals.append({'id':mapping[local_key], 'title':local['title'], 'source':binding.get('source_name') or '',
                          'date':local.get('start_at') or local.get('due_on')})
    return {'apple': {'title':live['title'], 'source':target.get('source') or '', 'date':live.get('start_at') or live.get('due_on')},
            'alcor': originals}


def check_missing(sync, kind, identity):
    prefix = 'reminder' if kind == 'reminders' else 'calendar'
    evidence = sync._get(prefix + '-inbound-conflict:' + identity) or {}
    observation = evidence.get('remote') or {}
    local_key, group_key, native_key = _shape(kind)
    mapping = next((row for row in sync._maps() if row[local_key] == identity and row['state'] == 'conflict'), None)
    local = sync._local(identity)
    binding = (local or {}).get('apple') or {}
    if (not mapping or evidence.get('reason') != mapping['conflict'] or not (observation.get('absence_evidence') or observation.get('absence'))
            or not binding.get('source_id') or binding.get('group_id') != mapping[group_key]
            or binding.get('apple_id') != mapping[native_key]):
        raise ValueError('原项目或关联已变化，请重新同步')
    target = _source(sync, kind, mapping[group_key], binding['source_id'])
    found = _lookup(sync, kind, mapping)
    present = bool(found and found.get('source_id') == target['source_id'] and _matches_mapping(kind, mapping, found))
    return {'status': 'present' if present else 'unconfirmed', 'source':target['title']}


def conflict_revision(plan):
    item = plan['items'][0]
    return claims.digest([plan['links_snapshot'], {key: item[key] for key in (
        'owner_snapshot', 'mapping_snapshot', 'native_snapshot', 'destination_snapshot', 'baseline_snapshot')}])
