"""Native Apple operations for DSH, with no Alcor business-store dependency."""
from datetime import datetime, timedelta
from hashlib import sha256
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from .bridge import BridgeError


def instant(value):
    point = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if point.tzinfo is None:
        raise ValueError('请提供带时区偏移的日期时间。')
    return point


class DirectApple:
    def __init__(self, root, bridge):
        self.root = Path(root)
        self.bridge = bridge

    def sources(self, kind):
        status = self.bridge.call('status' if kind == 'calendar' else 'reminder_status')
        if status['authorization'] != 'full_access':
            return {'authorization': status['authorization'], 'sources': [], 'default_id': ''}
        op, key = ('calendars', 'calendars') if kind == 'calendar' else ('reminder_lists', 'lists')
        result = self.bridge.call(op)
        return {'authorization': 'full_access', 'sources': result[key], 'default_id': result['default_id']}

    def access(self, kind):
        self.bridge.call('request_access' if kind == 'calendar' else 'reminder_request_access')
        return self.sources(kind)

    def query(self, kind, args, allowed):
        calendar = kind == 'calendar'
        field = 'calendar_id' if calendar else 'list_id'
        current = self.sources(kind)
        if current['authorization'] != 'full_access':
            raise PermissionError('请在 Apple 插件设置中授权系统访问。')
        visible = {row['id']: row for row in current['sources'] if row['id'] in allowed}
        requested = args.get(field)
        ids = [requested] if requested else list(visible)
        if not ids or any(identity not in visible for identity in ids):
            raise PermissionError('该来源未在 Apple 插件设置中启用。')
        if calendar:
            start, end = instant(args['start']), instant(args['end'])
            if not timedelta(0) < end - start <= timedelta(days=31):
                raise ValueError('请查询不超过 31 天的有效日期范围。')
            result = self.bridge.call('events', calendar_ids=ids, start=start.isoformat(), end=end.isoformat())
            rows = sorted(result['events'], key=lambda row: instant(row['start_at']))
            fields = ('calendar_id', 'event_id', 'occurrence_date', 'title', 'start_at', 'end_at', 'all_day', 'timezone', 'location', 'description', 'writable')
            failed = result['failed_calendar_ids']
        else:
            result = self.bridge.call('reminders', list_ids=ids)
            rows = sorted((row for row in result['reminders'] if args.get('include_completed') or not row['completed']),
                          key=lambda row: (row['due_on'] or '9999-12-31', row['due_time'] or ''))
            fields = ('list_id', 'reminder_id', 'title', 'due_on', 'due_time', 'timezone', 'completed', 'notes', 'writable')
            failed = result['failed_list_ids']
        filtered = [{k: row[k] for k in fields if k in row} for row in rows if row.get(field) in visible]
        return {'items': filtered[:100], 'total': len(filtered), 'failed_source_ids': failed,
                'sources': [{'id': k, 'title': v['title']} for k, v in visible.items()]}

    def prepare(self, kind, action, args, allowed, operation_id):
        calendar = kind == 'calendar'
        field, identity = ('calendar_id', 'event_id') if calendar else ('list_id', 'reminder_id')
        catalog = self.sources(kind)
        if catalog['authorization'] != 'full_access':
            raise PermissionError('请在 Apple 插件设置中授权系统访问。')
        selected = args.get(field) or catalog['default_id']
        destination = next((row for row in catalog['sources'] if row['id'] == selected and selected in allowed and row['writable']), None)
        if not destination:
            raise PermissionError('请选择已授权并可写的 Apple 来源。')
        if any(Path(self.root, 'native-receipts', operation_id + suffix).exists() for suffix in ('.json', '.submitted')):
            raise ValueError('此操作已有提交回执，请查询 Apple 中的实际结果。')
        where = {field: selected}
        current = None
        if action != 'create':
            where[identity] = args[identity]
            if calendar:
                instant(args['occurrence_date'])
                where['occurrence_date'] = args['occurrence_date']
            key = 'event' if calendar else 'reminder'
            current = self.bridge.call('lookup' if calendar else 'reminder_lookup', **where)[key]
            if not current or current[identity] != where[identity] or current[field] != selected or current['source_id'] != destination['source_id']:
                raise ValueError('找不到指定项目，请重新查询。')
        fields = {key: value for key, value in args.items() if key not in (field, identity, 'occurrence_date')}
        if action == 'complete':
            if current['completed']:
                raise ValueError('这条提醒事项已完成。')
            fields = {'completed': True}
        if not fields:
            raise ValueError('请提供要修改的字段。')
        if calendar:
            start = instant(fields.get('start_at', (current or {}).get('start_at')))
            end = instant(fields.get('end_at', (current or {}).get('end_at')))
            if end <= start:
                raise ValueError('日程结束时间必须晚于开始时间。')
            if action != 'create' and current['all_day'] and ('start_at' in fields or 'end_at' in fields):
                raise ValueError('全天日程的时间请在 Apple 日历中修改。')
            if action == 'create':
                ZoneInfo(fields['timezone'])
        elif action != 'complete':
            from datetime import date
            if fields.get('due_on') is not None:
                date.fromisoformat(fields['due_on'])
            if fields.get('due_time') and not fields.get('due_on', (current or {}).get('due_on')):
                raise ValueError('指定提醒时间时需要到期日期。')
            if fields.get('remind_at'):
                instant(fields['remind_at'])
            if fields.get('timezone'):
                ZoneInfo(fields['timezone'])
        op = ('upsert' if calendar else 'reminder_complete' if action == 'complete' else 'reminder_upsert')
        payload = {**where, **fields, 'expected_source_id': destination['source_id']}
        if action != 'complete':
            payload['expected_destination_snapshot'] = destination
        if current:
            payload.update(expected_snapshot=current)
            if action == 'complete':
                payload['require_exact_identity'] = True
                if current.get('due_on'):
                    payload['occurrence_on'] = current['due_on']
            else:
                payload['direct_patch'] = True
        else:
            payload['expected_absent'] = True
        return {'op': op, 'payload': payload, 'source': destination['source'], 'title': destination['title'],
                'item': (current or {}).get('title', fields.get('title')), 'changes': fields, 'operation_id': operation_id}

    def commit(self, plan, authorize):
        operation_id = plan['operation_id']
        if not authorize(operation_id):
            raise PermissionError('当前会话或来源权限已失效。')
        directory = self.root / 'native-receipts'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        native = directory / (operation_id + '.json')
        marker = directory / (operation_id + '.submitted')
        try:
            intent = marker.open('x')
        except FileExistsError:
            return {'status': 'needs_review', 'message': '该操作已有提交记录，请查询 Apple 中的结果。'}
        with intent:
            intent.write('submitted\n')
        if not authorize(operation_id):
            marker.unlink()
            raise PermissionError('当前会话或来源权限已失效。')
        binding = sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        try:
            result = self.bridge.call(plan['op'], **plan['payload'], receipt_file=str(native), receipt_binding=binding)
        except BridgeError:
            return {'status': 'needs_review', 'message': 'Apple 未返回明确结果，请查询原项目后再决定是否重试。'}
        row = result.get('completed_snapshot') or result.get('event') or result.get('reminder')
        if not row:
            return {'status': 'needs_review', 'message': 'Apple 未返回已保存项目，请查询原项目。'}
        fields = ('calendar_id', 'event_id', 'occurrence_date', 'start_at', 'end_at', 'list_id', 'reminder_id',
                  'due_on', 'due_time', 'title', 'completed')
        return {'status': 'saved', 'item': {key: row[key] for key in fields if key in row}}
