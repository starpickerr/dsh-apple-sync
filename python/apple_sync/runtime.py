"""One polling and change-watch lifecycle shared by EventKit sync adapters."""

from __future__ import annotations

import json
import math
import threading
import time

import logging
logger = logging.getLogger('stella.apple')


def report_sync_error(kind, phase, error):
    """Keep a caught EventKit failure visible in both the UI and desktop log."""
    logger.exception("[AppleSync] %s failed during %s", kind, phase)
    return f"{phase}失败：{error or type(error).__name__}"


def record_sync_result(sync, counts, error=''):
    checked = counts.get('checked_group_ids', [])
    outcome = {'status': 'partial' if checked and counts['status'] == 'error' else counts['status'],
               'checked_group_ids': checked,
               'failed_group_ids': counts.get('failed_calendar_ids', counts.get('failed_list_ids', [])),
               'checked_at': sync.clock()}
    if counts.get('retrying_group_ids'):
        outcome['retrying_group_ids'] = counts['retrying_group_ids']
    with sync._connect() as db:
        db.executemany('INSERT OR REPLACE INTO settings VALUES (?,?)',
                       [('error', json.dumps(error)), ('sync_result', json.dumps(outcome))])


class SourceRetries:
    def __init__(self):
        self.failed = {}

    def defer(self, group_id):
        delay, _ = self.failed.get(group_id, (5, 0))
        delay = min(delay * 2, 300)
        self.failed[group_id] = (delay, time.monotonic() + delay)

    def waiting(self, group_id):
        return time.monotonic() < self.failed.get(group_id, (0, 0))[1]

    def clear(self, group_id):
        self.failed.pop(group_id, None)

    def record(self, counts, selected):
        self.failed = {key: wait for key, wait in self.failed.items() if key in selected}
        if self.failed:
            counts['retrying_group_ids'] = sorted(self.failed)
            counts['retry_in'] = max(1, math.ceil(min(deadline for _, deadline in self.failed.values()) - time.monotonic()))


class EventKitAutoRunner:
    def __init__(self, bridge, connected, sync, *, kind="calendar", interval=300, watch_retry_interval=5):
        self.bridge = bridge
        self.connected = connected
        self.sync = sync
        self.kind = kind
        self.interval = interval
        self.watch_retry_interval = watch_retry_interval
        self.stop_event = threading.Event()
        self.watch_start_lock = threading.Lock()
        self.started = False

    def start(self):
        if self.started:
            return
        self.started = True

        def poll():
            while not self.stop_event.is_set():
                delay = self.interval
                if self.connected():
                    try:
                        result = self.sync() or {}
                        delay = min(delay, result.get('retry_in', delay))
                    except Exception:
                        logger.exception("EventKit %s poll failed", self.kind)
                self.stop_event.wait(delay)

        def watch():
            while not self.stop_event.is_set():
                if self.connected():
                    try:
                        if self.kind == "reminder":
                            result = self.bridge.watch(self.sync, self.stop_event, kind="reminder", start_lock=self.watch_start_lock)
                        else:
                            result = self.bridge.watch(self.sync, self.stop_event, start_lock=self.watch_start_lock)
                    except Exception:
                        result = None
                        logger.exception("EventKit %s watch failed", self.kind)
                    if result == 'unsupported':
                        self.stop_event.wait(self.interval)
                        continue
                    if not self.stop_event.is_set() and self.connected():
                        try:
                            self.sync()  # Reconcile any notifications missed during the outage.
                        except Exception:
                            logger.exception("EventKit %s watch recovery failed", self.kind)
                    self.stop_event.wait(self.watch_retry_interval)
                else:
                    self.stop_event.wait(self.interval)

        threading.Thread(target=poll, name=f"apple-{self.kind}-poll", daemon=True).start()
        threading.Thread(target=watch, name=f"apple-{self.kind}-watch", daemon=True).start()

    def stop(self):
        with self.watch_start_lock:
            self.stop_event.set()
        self.started = False
