import { Notice } from '../../Alcor/packages/alcor-plugin-info/src/notice.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal, IconCheckOutlineRegular, IconChecklistOutlineRegular, IconClockOutlineRegular, IconWarningOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { connectionStatus, formatSyncTime, reviewItems, resolutionRequest, deletionPhaseLabel, canRestoreLocalItem, boundConflictPending, syncSource, reviewAction, needsDecision, syncStatusLabel } from './presentation.js'
import { createCategoryRebuildPage } from './category-rebuild-page.js'
import { SettingsDialog } from './settings-dialog.jsx'

export const inject = ['configForms', 'slots', 'remote']
const authorizations = { not_determined: '同步前需要允许访问 Apple 日历或提醒事项。', denied: '请在 macOS 系统设置 → 隐私与安全性中允许完整访问。', restricted: '系统限制了访问权限。', write_only: '当前仅有写入权限，请在系统设置中允许完整访问。', unsupported: 'Apple 同步仅支持 macOS。', helper_missing: '系统连接组件未安装，请重新安装 Apple 同步插件。' }
const fieldLabels = { title:'标题', description:'备注', notes:'备注', start_at:'开始', end_at:'结束', all_day:'全天', location:'地点', timezone:'时区', due_on:'到期日', due_time:'到期时间', planned_on:'计划日期', priority:'优先级', remind_at:'提醒时间', repeat_frequency:'重复频率', repeat_days:'重复日期', repeat_until:'重复截至', repeat:'原生重复规则', completed:'已完成', completed_at:'完成时间', alarms:'提醒设置', url:'链接', floating:'浮动时间' }
const fieldValue = (field, value) => value == null || value === '' ? '无' : typeof value === 'boolean' ? value ? '是' : '否'
  : ['start_at','end_at','remind_at'].includes(field) ? formatSyncTime(value) || value
  : typeof value === 'object' ? JSON.stringify(value) : String(value)

function Choice({ value, selected, change, title, children, danger, disabled }) {
  return <label className="apple-sync-choice" data-selected={selected === value} data-danger={danger || undefined} data-disabled={disabled || undefined}>
    <input type="radio" name="apple-resolution" value={value} checked={selected === value} onChange={() => change(value)} disabled={disabled} />
    <span><strong>{title}</strong><span>{children}</span></span>
  </label>
}

function Review({ item, kind, state, blocker, queued, withdraw, select, finishReview, busy: outsideBusy, error: outsideError, close, resolve, api, finishRebuild }) {
  const boundPending = boundConflictPending(item)
  const [choice, setChoice] = useState(boundPending?.choice ?? '')
  const [rebuildPlan, setRebuildPlan] = useState(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState('')
  const [checked, setChecked] = useState(null)
  const [showDiagnostic, setShowDiagnostic] = useState(false)
  const mounted = useRef(true)
  const rebuildPage = useRef(null)
  if (!rebuildPage.current) rebuildPage.current = createCategoryRebuildPage({ api, kind, appleId:item.apple_id })
  useEffect(() => { mounted.current = true; rebuildPage.current.activate(); return () => { mounted.current = false; rebuildPage.current.dispose() } }, [])
  const busy = outsideBusy || rebuilding, error = rebuildError || outsideError
  const [source, setSource] = useState(state.default_source_id || '')
  const [confirm, setConfirm] = useState(false)
  const backButton = useRef(null)
  useEffect(() => { if (confirm) backButton.current?.focus() }, [confirm])
  const missing = item.kind === 'missing_source'
  const localRestore = canRestoreLocalItem(item), restorePending = item.local_restore_pending === true
  const destructive = missing && choice === 'keep_apple'
  const groupLabel = kind === 'calendar' ? '日历' : '清单'
  const uncertain = item.type === 'operation' && ['sending', 'uncertain'].includes(item.state)
  const pendingDelete = item.type === 'operation' && ['delete', 'truncate', 'exclude'].includes(item.action)
  const completion = kind === 'reminders' && item.type === 'operation' && item.entity === 'item' && item.action === 'complete' && item.state === 'pending'
  const appName = kind === 'reminders' ? '提醒事项' : '日历'
  const retained = ['identity_candidate','scan_claim','category_create','category_retained','marker_conflict'].includes(item.type)
  const categoryWaiting = ['category_waiting', 'unverified_category_identity', 'unverified_empty_category'].includes(item.kind)
  const review = reviewAction(item)
  const legacy = item.type === 'legacy_deletion'
  const compare = review === 'compare_record'
  const detailsOnly = retained || categoryWaiting || item.source_check
  const single = item.type === 'operation' || item.kind === 'legacy_retained'
  const diagnostic = !item.source_check && !['scan_claim', 'category_create', 'category_retained'].includes(item.type) && (item.reason || item.error)
  const actionable = !queued && !detailsOnly && !uncertain && (!compare || !!checked) && (single || item.type === 'record' || ['name', 'color', 'missing_source'].includes(item.kind))
  const title = rebuildPlan ? `确认创建空 Apple ${groupLabel}？` : detailsOnly ? '同步详情' : confirm ? `删除 Alcor ${groupLabel}？` : uncertain ? item.state === 'sending' ? '正在向 Apple 提交' : '请核对 Apple 操作结果' : item.type === 'operation' ? pendingDelete ? deletionPhaseLabel(item) : '等待同步' : '处理同步冲突'
  const apply = async () => {
    if (missing && choice === 'keep_alcor') {
      setRebuilding(true); setRebuildError('')
      try {
        if (!rebuildPlan) { const plan = await rebuildPage.current.preview(source); if (mounted.current) setRebuildPlan(plan) }
        else { const value = await rebuildPage.current.confirm(rebuildPlan); if (mounted.current) finishRebuild(value) }
      } catch (e) { if (mounted.current) { setRebuildPlan(null); setRebuildError(e.message) } }
      finally { if (mounted.current) setRebuilding(false) }
      return
    }
    if (destructive && !confirm) setConfirm(true); else resolve(single ? item.type === 'operation' ? 'cancel' : 'acknowledge' : choice, source, checked?.revision) }
  async function inspect(action = review) {
    setRebuilding(true); setRebuildError(''); setChecked(null); setChoice('')
    try {
      const result = await api.reviewSync({ kind, action, identity:item.type === 'operation' ? item.id : item.attempt_id ?? item.identity ?? item.alcor_id ?? item.todo_id ?? item.key })
      if (!result.ok) throw new Error(result.error?.message ?? '暂时无法核对，请重试。')
      if (mounted.current) {
        if (['completed','receipt_finished','released','gone'].includes(result.value.status)) {
          await finishReview(result.value.status === 'completed' ? '这条提醒的完成状态已同步。' : result.value.status === 'gone' ? '原操作已结束，已刷新同步状态。' : '已完成核对，此来源可继续同步。')
        } else if (action !== 'open_apple_app') setChecked(result.value)
      }
    } catch (failure) { if (mounted.current) setRebuildError(failure.message) }
    finally { if (mounted.current) setRebuilding(false) }
  }
  async function resumeVerifiedScan() {
    setRebuilding(true); setRebuildError('')
    try {
      const result = await api.reviewSync({ kind, action:'resume_verified_scan', identity:item.attempt_id, revision:checked.revision })
      if (!result.ok) throw new Error(result.error?.message ?? '暂时无法恢复同步，请重新核对。')
      if (mounted.current) {
        if (result.value.status === 'baseline_restored') await finishReview(result.value.differences?.length ? '已恢复此清单，请在「需要你确认」中逐项比较有变化的提醒。' : '已恢复此来源的同步。')
        else if (result.value.status === 'gone') await finishReview('原操作已结束，已刷新同步状态。')
        else setChecked(result.value)
      }
    } catch (failure) {
      if (mounted.current) { setChecked(null); setRebuildError(failure.message) }
    } finally { if (mounted.current) setRebuilding(false) }
  }
  async function withdrawAndCompare() {
    setRebuilding(true); setRebuildError('')
    try {
      const fresh = await withdraw(queued.id)
      if (mounted.current && !fresh.operations?.some(op => op.entity === 'item' && op.local_id === item.todo_id))
        await inspect()
    } catch (failure) { if (mounted.current) setRebuildError(failure.message) }
    finally { if (mounted.current) setRebuilding(false) }
  }
  return <Modal open title={title} headless className="apple-sync-review" onClose={() => { if (!busy) close() }}>
    <header className="apple-sync-review-header"><h2>{title}</h2><Button variant="ghost" size="sm" aria-label="关闭处理窗口" disabled={busy} onClick={close}><IconCloseOutlineRegular size={18} /></Button></header>
    <div className="apple-sync-review-body">
      <div className="apple-sync-subject"><span className="apple-sync-eyebrow">{item.label}</span><h3>{item.title}</h3>{item.source && <p>{item.source}</p>}{localRestore && <p>Alcor ID：{item.alcor_id ?? item.todo_id}</p>}</div>
      {rebuildPlan ? <Notice tone="warning" className="apple-sync-notice"><strong>在 {rebuildPlan.source.title || rebuildPlan.source.name || rebuildPlan.source_id} 创建空{groupLabel}「{rebuildPlan.title}」</strong><p>只创建容器，不上传原成员。以下 {rebuildPlan.retained_members.length} 项及旧关联证据保留在本地，等待重新关联。</p><ul>{rebuildPlan.retained_members.map(member => <li key={member.id}>{member.title}</li>)}</ul></Notice> : confirm ? <Notice tone="warning" className="apple-sync-danger-note"><strong>将删除此{groupLabel}及其中全部{kind === 'calendar' ? '日程' : '事务'}。</strong><p>只有确认 Apple 中的来源已被删除时，才选择此操作。Alcor 中的删除无法撤销。</p></Notice> : <>
        {item.type === 'scan_claim' ? <>
          {checked?.status !== 'baseline_restored' && <Notice tone="warning" className="apple-sync-notice">{item.background_check ? '上次分类检查停在提交之前。可以重新检查此来源，后续同步会重新读取分类。' : item.state === 'uncertain' ? `上次操作结果待核对，此${groupLabel}暂停更新。可继续同步其他来源。` : `此${groupLabel}仍有同步操作在处理，请稍后查看。`}</Notice>}
          {checked && <p role="status">{checked.status === 'baseline_restored' ? '已解除旧同步占用。后续同步会沿用核实过的关联。'
            : checked.status === 'verified' ? `已核对原来源及项目关联。恢复后，${checked.differences?.length ? checked.differences.length + ' 项有变化的提醒将转入「需要你确认」，保留两侧内容' : '将继续处理后续同步'}。`
            : checked.status === 'receipt_finished' ? '已根据原回执完成本地收尾。'
            : checked.status === 'released' ? '此来源可以继续同步。'
            : checked.status === 'gone' ? '该操作已结束，请刷新同步状态。' : checked.status === 'source_unavailable'
            ? '暂时无法完整读取原来源，请检查 Apple 账户和权限。'
            : checked.message || `请打开 Apple ${appName}，在原账户和「${item.title}」中核对上次更改，再回到这里重新核对。`}</p>}
          {!!checked?.differences?.length && <ul>{checked.differences.map((name, index) => <li key={index}>{name}</li>)}</ul>}
        </> : item.source_check ? <>
          <Notice tone="warning" className="apple-sync-notice">{item.reason}</Notice>
          {checked && <p role="status">{checked.status === 'present' ? `已在「${checked.source}」找到原项目。可重新同步以核对当前内容。` : `未在「${checked.source}」找到原项目。仍需核对是否被移动或删除，现有内容已保留。`}</p>}
        </> : item.type === 'identity_candidate' ? <>
          <Notice tone="warning" className="apple-sync-notice">原项目与 Apple 候选均已保留。只有能核实身份和来源时才能更改关联。</Notice>
          {checked && <table className="apple-sync-differences"><thead><tr><th>位置</th><th>项目</th><th>账户</th></tr></thead><tbody>
            <tr><th scope="row">Apple 候选</th><td>{checked.apple.title}{checked.apple.date && <p>{formatSyncTime(checked.apple.date) || checked.apple.date}</p>}</td><td>{checked.apple.source || '未知'}</td></tr>
            {checked.alcor.map(original => <tr key={original.id}><th scope="row">Alcor 原项目</th><td>{original.title}{original.date && <p>{formatSyncTime(original.date) || original.date}</p>}</td><td>{original.source || '未知'}</td></tr>)}
          </tbody></table>}
        </> : categoryWaiting ? <Notice tone="warning" className="apple-sync-notice">已保留原关联和内容。Alcor 会在下次同步时重新检查 Apple 来源。</Notice> : retained ? <Notice tone="warning" className="apple-sync-notice"><strong>{item.label}</strong><p>{item.type === 'marker_conflict' ? '旧关联来源或当前内容尚未核实。两侧内容和核对证据已保留，此项目不会自动重新关联或发送，其他正常项目继续同步。' : item.reason}</p><p>{formatSyncTime(item.observed_at || item.started_at)}</p></Notice> : item.type === 'operation' ? uncertain ? <Notice tone="warning" className="apple-sync-notice"><strong>{item.state === 'sending' ? '正在向 Apple 提交' : 'Apple 操作结果未知'}</strong><p>{item.state === 'sending' ? '请等待本机操作结果；暂不能取消此请求。' : '本地内容和证据已保留，请核对；此操作不会自动重试，不能当作尚未发送。'}</p></Notice> : <>
          <Notice className="apple-sync-notice"><strong>本地内容仍然保留</strong><p>{pendingDelete ? item.document?._confirmed_intent ? '本次具体删除已确认。断线或重启后，目标、内容、范围与权限不变且明确尚未发送时会继续；可取消此次操作或暂停同步。' : 'Alcor 将请求 Apple 删除，并在本机操作完成后处理本地记录。等待本次具体确认，可取消此请求。' : blocker ? '这项操作已记录，正在等待所属来源完成核对。' : '这项操作已记录，尚未提交到 Apple。'}</p></Notice>
          {blocker && <Notice tone="warning">{blocker.type === 'record' ? '这条提醒的两侧内容有变化。先处理内容冲突，再决定是否完成提醒。' : `「${blocker.title}」的上次同步尚待核对。先处理这个${groupLabel}，再同步本项。`}</Notice>}
          <ol className="apple-sync-progress"><li data-done><IconCheckOutlineRegular size={15} /><span>已记录操作</span></li><li aria-current="step"><IconClockOutlineRegular size={15} /><span>{pendingDelete ? deletionPhaseLabel(item) : '等待同步'}</span></li><li><span className="apple-sync-progress-dot" /><span>完成同步</span></li></ol>
          <Notice className="apple-sync-support">取消仅撤回这次待处理操作，保留现有内容。</Notice>
        </> : queued ? <Notice tone="warning">这条提醒还有一项「{queued.label}」。{queued.state === 'pending' ? '可以先撤回尚未发送的请求，再比较两侧内容。' : '请先查看原操作的提交结果。'}</Notice> : legacy || item.kind === 'legacy_delete' ? <Notice tone="warning" className="apple-sync-notice">
          <strong>{checked?.title || '旧版删除需要重新核对'}</strong>
          <p>{checked ? `Apple ${checked.source} · 保留此项目会撤销原删除待办。` : '当前内容已保留。先核实原 Apple 项目，再选择如何保留。'}</p>
        </Notice> : item.kind === 'legacy_retained' ? <Notice className="apple-sync-support">旧版遗留内容已保留。确认后会移除此提示，不会删除内容。</Notice> : <>
          <Notice className="apple-sync-instruction">{boundPending ? boundPending.phase === 'native_saved' ? 'Apple 已有成功更新回执，但 Alcor 本地提交尚未确认。可在此核对原操作回执，不再次发送；仍未确认时请在 Apple 核对内容，保留两侧，勿重复操作。' : '先前的冲突处理结果待核对。这里只核对原操作回执，不重新写入，也不改用另一侧覆盖。' : restorePending ? '先前的本地恢复结果待核对。这里只核对已有回执，不重复创建项目，Apple 保持不变。' : localRestore ? 'Alcor 项目已缺失。可从已关联的 Apple 来源恢复到本地，Apple 保持不变。' : missing ? `来源可能暂时不可用，或账户中的${groupLabel}已发生变化。请选择如何继续。` : `选择要保留的一侧，确认后会更新另一侧。`}{item.type === 'record' && !localRestore && !boundPending && '仅处理双方都存在且关联明确的项目，不从此入口删除内容。'}</Notice>
          {compare && checked && (checked.differences.length ? <table className="apple-sync-differences"><thead><tr><th>字段</th><th>Apple</th><th>Alcor</th>{choice && <th>保存结果</th>}</tr></thead><tbody>
            {checked.differences.map(({ field, apple, alcor }) => <tr key={field}><th scope="row">{fieldLabels[field] || field}</th><td>{fieldValue(field, apple)}</td><td>{fieldValue(field, alcor)}</td>{choice && <td>{fieldValue(field, choice === 'keep_apple' ? apple : alcor)}</td>}</tr>)}
          </tbody></table> : <Notice>当前没有可比较的字段差异。请查看具体原因，或重新同步。</Notice>)}
          {(!compare || checked) && <fieldset className="apple-sync-choices" disabled={busy}><legend className="apple-sync-sr-only">选择处理方式</legend>
            {missing ? <>
              {(item.candidates ?? []).map(candidate => <Choice key={candidate.id} value={`rebind:${candidate.id}`} selected={choice} change={setChoice} title={`重新关联到「${candidate.title}」`}>{candidate.source || 'Apple'} · 保留本地内容并恢复关联</Choice>)}
              <Choice value="keep_alcor" selected={choice} change={setChoice} title={`保留 Alcor，重建 Apple ${groupLabel}`} disabled={!state.sources?.length}>保留本地内容，并在所选账户中创建同名{groupLabel}。</Choice>
              {choice === 'keep_alcor' && <label className="apple-sync-account">Apple 账户<select value={source} onChange={event => setSource(event.target.value)}><option value="">选择账户</option>{(state.sources ?? []).map(account => <option key={account.id} value={account.id}>{account.title || account.name}</option>)}</select></label>}
              <Choice value="keep_apple" selected={choice} change={setChoice} title="确认 Apple 已删除此来源" danger>同步删除 Alcor 对应{groupLabel}及其中全部内容。下一步需再次确认。</Choice>
            </> : ['keep_alcor', 'keep_apple'].map(value => {
              const local = value === 'keep_alcor'
              const version = local ? item.local : item.native
              const detail = item.kind === 'name' ? version?.display_name || version?.name || version?.title : item.kind === 'color' ? version?.color : null
              const blocked = boundPending ? value !== boundPending.choice : local && (localRestore || compare && !checked?.can_write || item.native && item.local?.apple?.can_rename === false)
              return <Choice key={value} value={value} selected={choice} change={setChoice} title={local ? '保留 Alcor' : restorePending ? '核对本地恢复结果' : localRestore ? '仅恢复 Alcor 本地' : '采用 Apple'} disabled={blocked}>{detail && <span className="apple-sync-version">{item.kind === 'color' && <i style={{ background: detail }} />}{detail}</span>}{boundPending ? value === boundPending.choice ? '仅核对原处理结果，不重复写入。' : '原操作结果未核对，不能改用另一侧覆盖。' : localRestore ? local ? '此处不会删除或更改 Apple 内容。' : restorePending ? '只核对先前恢复的回执，不再次写入本地项目。' : '恢复缺失项目，不覆盖现有项目，不向 Apple 写入。' : blocked ? '当前来源或项目无法安全写入 Apple。' : local ? '用 Alcor 当前内容更新 Apple。' : '用 Apple 当前内容更新 Alcor。'}</Choice>
            })}
          </fieldset>}
        </>}
        {diagnostic && <div className="apple-sync-diagnostic">
          <Button variant="outline" size="sm" aria-expanded={showDiagnostic} onClick={() => setShowDiagnostic(open => !open)}>
            {showDiagnostic ? '收起诊断' : '查看诊断'}
          </Button>
          {showDiagnostic && <pre>{[].concat(diagnostic).join('\n')}</pre>}
        </div>}
      </>}
      {error && <Notice tone="error" role="alert" className="apple-sync-error">{error}{completion && <p>也可在 Apple 提醒事项中核对这一项。若已手动完成，可取消仍在等待的这次请求。</p>}</Notice>}
    </div>
    <footer className="apple-sync-review-footer">{!detailsOnly && <span>{rebuildPlan ? '仅创建空容器，不上传原成员' : confirm ? '此操作无法撤销' : '确认前不会更改内容'}</span>}<div><Button ref={backButton} variant="outline" disabled={busy} onClick={() => { if (rebuildPlan) { rebuildPage.current.invalidate(); setRebuildPlan(null) } else if (confirm) setConfirm(false); else close() }}>{confirm || rebuildPlan ? '返回' : detailsOnly ? '关闭' : '暂不处理'}</Button>
      {(uncertain || completion && error || detailsOnly) && <Button variant="outline" disabled={busy} onClick={() => void inspect('open_apple_app')}>打开 Apple {appName}</Button>}
      {queued && (queued.state === 'pending' && compare
        ? <Button variant="primary" disabled={busy} onClick={() => void withdrawAndCompare()}>撤回待同步请求并比较</Button>
        : <Button variant="primary" disabled={busy} onClick={() => select(queued.key)}>查看待处理操作</Button>)}
      {review && !queued && checked?.status !== 'baseline_restored' && <Button variant={checked && (review !== 'check_scan' || checked.status === 'verified') ? 'outline' : 'primary'} disabled={busy} onClick={() => void inspect()}>{review === 'compare_record' ? '比较差异' : review === 'compare_identity' ? '比较候选' : review === 'restart_category_check' ? '重新检查此来源' : '重新核对'}</Button>}
      {checked?.status === 'verified' && <Button variant="primary" disabled={busy} onClick={() => void resumeVerifiedScan()}>恢复同步</Button>}
      {legacy && checked?.revision && <>
        {checked.can_restore && <Button variant="outline" disabled={busy} onClick={() => resolve('restore_legacy', null, checked.revision)}>恢复到 Alcor</Button>}
        <Button variant="primary" disabled={busy} onClick={() => resolve('keep_legacy', null, checked.revision)}>{kind === 'reminders' ? '保留提醒' : '保留日程'}</Button>
      </>}
      {actionable && <Button variant={completion || blocker ? 'outline' : 'primary'} className={confirm ? 'apple-sync-destructive' : ''} disabled={busy || (!single && !choice) || (missing && choice === 'keep_alcor' && !source)} onClick={apply}>{busy ? '处理中…' : rebuildPlan ? `确认创建空${groupLabel}` : missing && choice === 'keep_alcor' ? '查看创建预览' : confirm ? `删除 Alcor ${groupLabel}` : destructive ? '继续…' : item.type === 'operation' ? '取消此次操作' : item.kind === 'legacy_retained' ? '确认保留' : boundPending ? '核对处理结果' : restorePending ? '核对恢复结果' : localRestore ? '恢复到 Alcor' : '确认并同步'}</Button>}
      {blocker ? <Button variant="primary" disabled={busy} onClick={() => select(blocker.key)}>{blocker.type === 'record' ? '处理内容冲突' : `处理阻塞的${groupLabel}`}</Button> : completion && <Button variant="primary" disabled={busy} onClick={() => void inspect('sync_completion')}>立即同步此项</Button>}</div></footer>
  </Modal>
}

function coverageLabel(period) {
  return [period.start, period.end].map(date => date.slice(0, 10).replaceAll('-', '/')).join(' – ')
}

function SyncDetails({ title, sources, issues, coverage, error, close }) {
  return <SettingsDialog title={`${title}同步明细`} close={close}>
    {!!(sources.length || issues.length) && <section className="apple-sync-detail-section">
      <h3>只读来源</h3>
      <p className="apple-settings-caption">可导入 Alcor，更改在 Apple 中完成。</p>
      {!!sources.length && <ul className="apple-settings-list">{sources.map(source => <li key={source.id} className="apple-settings-list-row">
        <div className="apple-settings-text"><strong>{source.title}</strong>{source.source && <small>{source.source}</small>}</div>
        <span className="apple-settings-tag">只读</span>
      </li>)}</ul>}
      {issues.map(issue => <Notice key={issue.todo_id} tone="warning">{issue.reason}</Notice>)}
    </section>}
    {!!coverage.length && <section className="apple-sync-detail-section">
      <h3>已同步的时间范围</h3>
      <ul className="apple-settings-list">{coverage.map(period => <li key={`${period.start}:${period.checked_at}`} className="apple-settings-list-row">
        <div className="apple-settings-text"><strong>{coverageLabel(period)}</strong>
          <small>检查于 {formatSyncTime(period.checked_at)}</small></div>
      </li>)}</ul>
      <p className="apple-settings-caption">查看其他日期时按需加载，暂停同步时显示已保存的内容。</p>
    </section>}
    {error && <section className="apple-sync-detail-section"><h3>诊断</h3><pre>{error}</pre></section>}
  </SettingsDialog>
}

function Connection({ kind, api }) {
  const title = kind === 'calendar' ? 'Apple 日历' : 'Apple 提醒事项'
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [readError, setReadError] = useState('')
  const [selected, setSelected] = useState(null)
  const [showDetails, setShowDetails] = useState(false)
  const revision = useRef(0)
  const working = useRef(false)
  const call = async (method, args = {}) => {
    const result = await api.invoke({ method, arguments: { kind, ...args } })
    if (!result.ok) throw new Error(result.error?.message ?? '操作未成功，请重试。')
    return result.value
  }
  async function run(operation) {
    revision.current++
    working.current = true
    setBusy(true); setMessage(''); setNotice('')
    try { await operation() }
    catch (error) { setMessage(error.message) }
    finally { revision.current++; working.current = false; setBusy(false) }
  }
  useEffect(() => {
    let disposed = false
    let refreshing = false
    const refresh = async () => {
      if (refreshing || working.current) return
      refreshing = true
      const started = revision.current
      try { const value = await call('status'); if (!disposed && started === revision.current) { setState(value); setReadError('') } }
      catch (error) { if (!disposed && started === revision.current) setReadError(error.message) }
      finally { refreshing = false }
    }
    void refresh()
    const timer = setInterval(refresh, 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [api, kind])
  const options = state?.calendars ?? state?.lists ?? []
  const active = state?.connected && state?.auto_enabled
  async function sync() {
    if (state?.authorization !== 'full_access') {
      const authorized = await call('request_access')
      setState(authorized)
      if (authorized.authorization !== 'full_access') throw new Error(authorizations[authorized.authorization] ?? '需要系统完整访问授权。')
    }
    if (active) {
      await call('sync', { manual: true })
      setState(await call('status'))
    } else {
      const { state: saved } = await call('start_sync')
      setState(saved)
    }
  }
  const status = connectionStatus(state, busy, Boolean(readError))
  const items = reviewItems(state, kind)
  const backgroundChecks = (state?.scan_claims ?? []).filter(row => row.background_check && row.state === 'uncertain')
  const retrying = state?.authorization === 'full_access' ? [...new Set([
    ...(state.sync_result?.retrying_group_ids ?? []), ...backgroundChecks.map(row => row.group_id),
  ])] : []
  const retryingNames = retrying.map(id => syncSource(state, id).title).filter(Boolean)
  const failed = [...new Set([...(state?.sync_result?.failed_group_ids ?? []), ...(state?.sync_result?.held_group_ids ?? [])])].filter(id => !retrying.includes(id) && !items.some(item => item.group_id === id || item.apple_id === id))
  const failedNames = failed.map(id => syncSource(state, id).title).filter(Boolean)
  const checked = state?.sync_result?.checked_group_ids?.length
  const syncError = message || readError || (status.tone === 'error' ? state?.error : '')
  const current = items.find(item => item.key === selected)
  const blocker = current?.type === 'operation' && (items.find(item => item.type === 'scan_claim' && item.group_id && item.group_id === current.binding?.group_id)
    || items.find(item => item.type === 'record' && item.todo_id && item.todo_id === current.local_id))
  const queued = current?.type === 'record' && items.find(item => item.type === 'operation' && item.entity === 'item' && item.local_id && item.local_id === current.todo_id)
  async function finishReview(text) {
    const started = ++revision.current
    const fresh = await call('status')
    if (started === revision.current) {
      ++revision.current
      setState(fresh); setSelected(null); setNotice(text); setMessage('')
    }
  }
  useEffect(() => { if (selected && !current) setSelected(null) }, [selected, current])
  const readOnly = options.filter(source => !source.writable)
  const readOnlyIssues = state?.readonly_issues ?? []
  const coverage = kind === 'calendar' ? (state?.coverage ?? []).slice(-3).reverse() : []
  const diagnostic = !syncError && !busy && state?.error && ((!items.length && !backgroundChecks.length) || !!failed.length) ? state.error : ''
  const hasDetails = !!(readOnly.length || readOnlyIssues.length || coverage.length || diagnostic)
  const Icon = kind === 'calendar' ? IconClockOutlineRegular : IconChecklistOutlineRegular
  return <section className="apple-sync-connection" aria-label={title}>
    <div className="apple-sync-heading"><div className="apple-sync-service"><span className="apple-sync-service-icon"><Icon size={22} /></span><div><h3>{title}</h3><span className="apple-sync-badge" data-tone={status.tone} role="status"><span className="apple-sync-dot" aria-hidden="true" />{syncStatusLabel(status, items, state)}</span></div></div><div className="apple-sync-actions"><Button variant="outline" size="sm" disabled={busy || !active} onClick={() => void run(async () => setState(await call('disconnect')))}>暂停同步</Button><Button variant="primary" size="sm" disabled={busy || !state?.supported} onClick={() => void run(sync)}>{busy ? '处理中…' : '同步'}</Button></div></div>
    <div className="apple-sync-metadata">{formatSyncTime(state?.last_success) && <span>上次成功同步 <time dateTime={state.last_success}>{formatSyncTime(state.last_success)}</time></span>}{!!state?.links?.length && <span>{state.links.length} 个{kind === 'calendar' ? '日历' : '清单'}已关联</span>}</div>
    {state && state.authorization !== 'full_access' && <Notice tone="warning" className="apple-sync-notice"><p>{authorizations[state.authorization] || '需要系统完整访问授权。'}</p></Notice>}
    {state?.watch_degraded && <Notice tone="warning" className="apple-sync-notice"><p>当前 Apple 连接组件不支持实时监听，将继续定期同步。更新连接组件后可恢复实时监听。</p></Notice>}
    {syncError && !current && <Notice tone="error" className="apple-sync-notice" role="alert"><strong>{readError ? '暂时无法读取同步状态' : '同步未完成'}</strong><p>{syncError}</p></Notice>}
    {status.tone === 'warning' && (checked != null || !!failed.length || !!retrying.length) && <div className="apple-sync-metadata">
      {checked != null && <span>本次已检查 {checked} 个{kind === 'calendar' ? '日历' : '清单'}</span>}
      {!!retrying.length && <span>{retryingNames.length === retrying.length ? retryingNames.join('、') : `${retrying.length} 个来源`}{active ? '稍后自动重试' : '将在下次同步时重试'}</span>}
      {!!failed.length && <span>{failedNames.length === failed.length ? failedNames.join('、') : `${failed.length} 个来源`}暂时无法更新</span>}
    </div>}
    {[true, false].map(decision => {
      const rows = items.filter(item => needsDecision(item) === decision)
      return !!rows.length && <div key={String(decision)} className="apple-sync-inbox"><div className="apple-sync-inbox-heading"><h4>{decision ? '需要你确认' : '同步状态'} <span>{rows.length}</span></h4></div><div className="apple-sync-rows">{rows.map(item => <button type="button" key={item.key} className="apple-sync-row" disabled={busy} onClick={() => {setMessage(''); setSelected(item.key)}}><span className="apple-sync-row-icon" data-pending={item.type === 'operation'}>{item.type === 'operation' ? <IconClockOutlineRegular size={18} /> : <IconWarningOutlineRegular size={18} />}</span><span className="apple-sync-row-text"><strong>{item.title}</strong><span>{item.label}{item.source && ` · ${item.source}`}</span></span><span className="apple-sync-row-action">{decision ? '处理' : item.type === 'scan_claim' && reviewAction(item) ? '核对来源' : item.type === 'operation' && item.state === 'pending' ? '处理操作' : '查看'}<IconChevronRightOutlineRegular size={14} /></span></button>)}</div></div>
    })}
    {hasDetails && <div className="apple-sync-facts">
      <dl>
        {!!(readOnly.length || readOnlyIssues.length) && <div><dt>只读来源</dt><dd>{readOnly.length} 个来源{readOnlyIssues.length ? ` · ${readOnlyIssues.length} 项保留` : ''}</dd></div>}
        {!!coverage.length && <div><dt>已同步的时间范围</dt><dd>{coverageLabel(coverage[0])}</dd></div>}
      </dl>
      <Button variant="outline" size="sm" aria-label={`查看${title}同步明细`} onClick={() => setShowDetails(true)}>
        同步明细<IconChevronRightOutlineRegular size={14} aria-hidden="true" />
      </Button>
    </div>}
    {showDetails && <SyncDetails title={title} sources={readOnly} issues={readOnlyIssues} coverage={coverage}
      error={diagnostic} close={() => setShowDetails(false)} />}
    {notice && <Notice className="apple-sync-success" role="status"><IconCheckOutlineRegular size={16} />{notice}</Notice>}
    {current && <Review key={current.key} item={current} kind={kind} state={state} api={api} blocker={blocker} queued={queued} select={setSelected}
      withdraw={async id => { ++revision.current; const fresh = await call('cancel_operation', { operation_id:id }); ++revision.current; setState(fresh); return fresh }} finishReview={finishReview} finishRebuild={value => { setState(value); setSelected(null); setNotice('空 Apple 容器已创建；原成员保留本地，尚未重新关联。') }} busy={busy} error={message} close={() => setSelected(null)} resolve={(choice, source, revision) => void run(async () => {const request = resolutionRequest(current,kind,choice,source)
      if (request.method === 'keep_legacy') {
        const kept = await api.reviewSync({ kind, action:'keep_legacy', ...request.arguments, revision })
        if (!kept.ok) throw new Error(kept.error?.message ?? '保留项目未完成。')
        setState(await call('status')); setSelected(null); setNotice('已保留 Apple 项目，并撤销旧删除待办。')
      } else if (request.method === 'restore_local_item') {
        const restored = await api.restoreLocalItem({ kind, ...request.arguments, ...(revision && { revision }) })
        if (!restored.ok) throw new Error(restored.error?.message ?? '本地恢复未完成。')
        if (restored.value.status !== 'success') throw new Error(restored.value.message ?? '本地恢复结果待核对，未重复写入。')
        setState(await call('status')); setSelected(null); setNotice(current.local_restore_pending === true ? '已核对本地恢复结果，Apple 保持不变。' : '已恢复 Alcor 本地项目，Apple 保持不变。')
      } else if (request.method === 'resolve_conflict') {
        const resolved = await api.resolveItemConflict({ kind, identity: request.arguments[kind === 'calendar' ? 'alcor_id' : 'todo_id'], choice, ...(revision && { revision }) })
        if (!resolved.ok) throw new Error(resolved.error?.message ?? '冲突处理未完成。')
        if (resolved.value.status !== 'success') throw new Error(resolved.value.message ?? '冲突处理结果待核对，不会重发。')
        setState(await call('status')); setSelected(null); setNotice(choice === 'keep_apple' ? '已采用 Apple 内容更新 Alcor，Apple 保持不变。' : '已采用 Alcor 内容更新原 Apple 项目。')
      } else {
        setState(await call(request.method,request.arguments)); setSelected(null); setNotice(current.type === 'operation' ? '已取消此次操作，内容已保留。' : '已处理，将按所选方式同步。')
      }})} />}
  </section>
}

export function AlcorSettings({ api, view }) {
  if (view === 'summary') return '双向同步 Apple 日历与提醒事项，保留分类和清单。'
  return <div className="apple-sync-panel"><h2>Apple 同步设置</h2><Connection kind="calendar" api={api} /><Connection kind="reminders" api={api} /></div>
}
