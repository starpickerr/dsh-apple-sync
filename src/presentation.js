export function connectionStatus(state, busy, readFailed = false) {
  if (busy) return { label: '处理中', tone: 'pending' }
  if (readFailed) return { label: '状态读取失败', tone: 'error' }
  if (!state) return { label: readFailed ? '状态读取失败' : '读取中', tone: readFailed ? 'error' : 'pending' }
  if (state.authorization !== 'full_access') return { label: state.authorization === 'not_determined' ? '待授权' : '无法同步', tone: 'warning' }
  if (state.listing_error) return { label: '无法读取同步来源', tone: 'error' }
  if (state.sync_result?.retrying_group_ids?.length &&
      state.sync_result.failed_group_ids?.every(id => state.sync_result.retrying_group_ids.includes(id))) {
    return { label: '等待重试', tone: 'warning' }
  }
  if (state.sync_result?.status === 'partial' ||
      (state.error === 'Apple container is held by another unfinished operation' && state.scan_claims?.length) ||
      (!state.sync_result && state.error?.startsWith('部分') && !state.listing_error)) return { label: '部分同步 · 待处理', tone: 'warning' }
  if (state.error) return { label: '同步异常', tone: 'error' }
  if (state.marker_conflicts?.length || state.category_conflicts?.length || state.operations?.length || state.scan_claims?.length || state.category_creates?.length || state.retained_categories?.length || state.identity_candidates?.length || state.legacy_deletions?.length || state.links?.some(link => link.name_conflict)) return { label: '部分同步 · 待处理', tone: 'warning' }
  if (state.conflicts?.length) return { label: '待处理冲突', tone: 'warning' }
  if (state.readonly_issues?.length) return { label: '部分同步 · 含只读内容', tone: 'warning' }
  if (state.connected && state.auto_enabled) return { label: '自动同步已开启', tone: 'success' }
  return { label: state.connected || state.last_success || state.links?.length ? '已暂停' : '未开启', tone: 'neutral' }
}

export function formatSyncTime(value) {
  if (!value) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date)
}

const actions = { delete: '删除', exclude: '跳过本次', complete: '完成本次', edit: '编辑', truncate: '删除本次及将来' }

export function syncSource(state, id) {
  const native = (state?.calendars ?? state?.lists ?? []).find(row => row.id === id)
  const link = state?.links?.find(row => row.apple_id === id)
  const local = state?.categories?.find(row => row.id === link?.alcor_id)
  return { title: native?.title || link?.apple_name || local?.name, source: native?.source || local?.apple?.source_name || '' }
}

export function deletionPhaseLabel(item) {
  if (item.state === 'sending') return '正在提交'
  if (item.state === 'uncertain') return '结果待核对'
  if (item.deletion_phase === 'not_sent') return '明确未发送 · 可安全重试'
  if (item.deletion_phase === 'queued' || item.document?._confirmed_intent) return '已确认 · 等待同步'
  return '等待本次确认'
}

export function reviewItems(state, kind) {
  const groupLabel = kind === 'calendar' ? '日历' : '清单'
  const groups = state?.categories ?? []
  const links = state?.links ?? []
  const categories = [...(state?.category_conflicts ?? []), ...links.filter(link => link.name_conflict && !(state?.category_conflicts ?? []).some(item => item.apple_id === link.apple_id && item.kind === 'name')).map(link => ({ ...link, kind: 'name', reason: link.name_conflict }))]
  const scans = new Map()
  for (const row of state?.scan_claims ?? []) {
    const group = row.group_id || row.attempt_id
    if (!scans.has(group)) scans.set(group, [])
    scans.get(group).push(row)
  }
  return [
    ...(state?.marker_conflicts ?? []).map(item => ({ ...item, type:'marker_conflict', key:`marker:${item.local_id}`, label:'旧关联恢复待核对 · 内容已保留', source:item.source_id || '' })),
    ...(state?.retained_categories ?? []).map(item => ({ ...item, type:'category_retained', key:`retained:${item.old_group}`, label:`空容器已创建 · ${item.member_count} 项成员保留本地`, source:item.source_id || '' })),
    ...(state?.category_creates ?? []).map(item => ({ ...item, type: 'category_create', key: `create:${item.local_id}`, title: item.title || `${groupLabel}创建待核对`, label: ['owner_claiming','owner_committed'].includes(item.state) ? '本地分类提交待核对' : item.state === 'waiting' ? '分类创建等待重试' : '分类创建结果待核对', source: item.source_id || '' })),
    ...(state?.identity_candidates ?? []).map(item => ({ ...item, identity: item.key, type: 'identity_candidate', key: `identity:${item.key}`, title: item.native?.title || `${groupLabel}项目身份待核对`, label: '可能是同一项目', source: syncSource(state, item.native?.calendar_id ?? item.native?.list_id).source })),
    ...Array.from(scans, ([group, claims]) => {
      const item = claims.find(row => row.state === 'uncertain') ?? claims[0]
      const { title, source } = syncSource(state, item.group_id)
      return { ...item, claims, type: 'scan_claim', key: `claim:${group}`, title: title || `Apple ${groupLabel}`, source,
        label: item.state === 'uncertain' ? (['owner_claiming','owner_committed'].includes(item.stage) ? '本地提交结果待核对' : '同步结果待核对') : '同步操作仍占用此来源' }
    }),
    ...categories.filter(item => item.kind !== 'category_waiting' || !scans.has(item.apple_id)).map(item => {
      const local = groups.find(group => group.id === item.alcor_id)
      const link = links.find(link => link.apple_id === item.apple_id)
      const native = (state.calendars ?? state.lists ?? []).find(group => group.id === item.apple_id)
      return { ...item, type: 'category', key: `category:${item.apple_id}:${item.kind}`, title: local?.display_name || local?.name || link?.alcor_name || link?.apple_name || `${groupLabel}需要确认`,
        label: { name: `${groupLabel}名称冲突`, color: `${groupLabel}颜色冲突`, missing_source: `找不到 Apple ${groupLabel}`, category_waiting: '来源关联待核对', unverified_category_identity: '来源身份待核对', unverified_empty_category: '来源身份待核对', legacy_retained: '升级后保留的内容', legacy_delete: '旧删除尚未完成' }[item.kind] || `${groupLabel}需要确认`,
        local, native, source: native?.source || local?.apple?.source_name || '', groupLabel }
    }),
    ...(state?.conflicts ?? []).map(item => ({ ...item, type: 'record', key: `record:${item.alcor_id ?? item.todo_id}`, title: item.title || (kind === 'calendar' ? '日程内容冲突' : '事务内容冲突'), label: boundConflictPending(item) ? '冲突处理结果待核对' : item.local_restore_pending === true ? '本地恢复结果待核对' : item.source_check ? 'Apple 原项目待核对' : item.local_missing === true ? 'Alcor 本地项目缺失' : '两侧内容需要确认', source: groups.find(group => group.id === item.category_id)?.name || '' })),
    ...(state?.legacy_deletions ?? []).map(item => ({ ...item, type: 'legacy_deletion', key: `legacy:${item.alcor_id ?? item.todo_id}`, title: kind === 'calendar' ? '旧版日程删除待核对' : '旧版提醒删除待核对', label: 'Apple 内容与关联已保留', source: '' })),
    ...(state?.operations ?? []).map(item => ({ ...item, type: 'operation', key: `operation:${item.id}`, title: item.document?.title || item.binding?.native?.title || `${item.entity === 'category' ? groupLabel : kind === 'calendar' ? '日程' : '事务'}操作`, label: `${actions[item.action] || '更改'} · ${['delete','truncate','exclude'].includes(item.action) ? deletionPhaseLabel(item) : item.state === 'sending' ? '正在提交' : item.state === 'uncertain' ? '结果待核对' : '等待同步'}`, source: '' })),
  ]
}

export const boundConflictPending = item => ['keep_alcor', 'keep_apple'].includes(item?.bound_conflict_pending?.choice)
  && ['owner_uncertain', 'native_saved', 'native_uncertain', 'finalizing'].includes(item.bound_conflict_pending.phase) ? item.bound_conflict_pending : undefined

export const canRestoreLocalItem = item => !boundConflictPending(item) && item?.type === 'record' && (item.local_missing === true || item.local_restore_pending === true)

export function reviewAction(item) {
  if (item.type === 'scan_claim' && (item.state === 'uncertain' || ['merge_sending','merge_rechecking'].includes(item.stage))) return 'check_scan'
  if (item.type === 'identity_candidate') return 'compare_identity'
  if (item.type === 'record' && item.source_check) return 'check_missing'
  if (item.type === 'legacy_deletion') return 'preview_legacy'
  if (item.type === 'record' && !canRestoreLocalItem(item) && !boundConflictPending(item)) return 'compare_record'
}

export function needsDecision(item) {
  return item.type === 'legacy_deletion' || (item.type === 'record' && !item.source_check && !boundConflictPending(item)
      && !item.local_restore_pending) || (item.type === 'category' && ['name','color','missing_source','legacy_retained'].includes(item.kind))
}

export function resolutionRequest(item, kind, choice, sourceId) {
  if (item.source_check || ['identity_candidate','scan_claim','category_create','category_retained','marker_conflict'].includes(item.type)) throw new Error('此状态仅供核对，不允许重发、合并或解除占用')
  if (item.type === 'legacy_deletion') {
    if (choice !== 'keep_legacy' && choice !== 'restore_legacy') throw new Error('请从历史删除核对入口保留项目')
    return { method: choice === 'keep_legacy' ? 'keep_legacy' : 'restore_local_item',
      arguments: { identity: item.alcor_id ?? item.todo_id } }
  }
  if (item.type === 'operation') {
    if (item.state && item.state !== 'pending') throw new Error('操作已开始或结果未知，不能取消或重发')
    return { method: 'cancel_operation', arguments: { operation_id: item.id } }
  }
  if (boundConflictPending(item) && choice !== boundConflictPending(item).choice) throw new Error('此操作结果待核对，只能核对原处理方式，不能改选后重复写入')
  if (canRestoreLocalItem(item) && choice === 'keep_apple') return { method: 'restore_local_item', arguments: { identity: item.alcor_id ?? item.todo_id } }
  if (item.type === 'record') return { method: 'resolve_conflict', arguments: { [kind === 'calendar' ? 'alcor_id' : 'todo_id']: item.alcor_id ?? item.todo_id, choice } }
  return { method: 'resolve_category_conflict', arguments: { apple_id: item.apple_id,
    ...(['name', 'color'].includes(item.kind) ? { field: item.kind } : {}),
    ...(choice.startsWith('rebind:') ? { choice: 'rebind', replacement_id: choice.slice(7) } : { choice }),
    ...(choice === 'keep_alcor' && item.kind === 'missing_source' && sourceId ? { source_id: sourceId } : {}),
  } }
}
