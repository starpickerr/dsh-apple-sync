import React, { useEffect, useState } from 'react'
import { Button, Checkbox, Switch, IconChecklistOutlineRegular, IconClockOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { withModeView } from '../../Alcor/packages/alcor-plugin-info/src/mode-view.jsx'
import { Notice } from '../../Alcor/packages/alcor-plugin-info/src/notice.jsx'
import noticeStyle from '../../Alcor/packages/alcor-plugin-info/src/notice.css'
import { AlcorSettings } from './alcor-settings.jsx'
import { SettingsDialog } from './settings-dialog.jsx'
import { directRemote } from './direct-remote.js'
import { remote } from './remote.js'
import style from './style.css'

const groups = [
  { kind: 'calendar', label: '日历', manage: '选择日历', Icon: IconClockOutlineRegular },
  { kind: 'reminders', label: '提醒事项', manage: '选择清单', Icon: IconChecklistOutlineRegular },
]
const authorization = { full_access: '已授权', denied: '访问已拒绝', not_determined: '待授权',
  restricted: '访问受系统限制', write_only: '仅有写入权限', helper_missing: '系统连接组件未安装', unsupported: '仅支持 macOS' }

function SourcePicker({ label, catalog, selected, close, apply }) {
  const [ids, setIds] = useState(selected)
  const visible = catalog.sources.filter(row => ids.includes(row.id)).length
  return <SettingsDialog title={label} close={close} actions={
    <Button variant="primary" onClick={() => apply(ids)}>应用选择</Button>
  }>
    <p className="apple-settings-caption">已选 {visible} 个来源供 DSH 对话访问</p>
    <ul className="apple-settings-list">
      {catalog.sources.map(row => <li key={row.id} className="apple-settings-list-row">
        <div className="apple-settings-text">
          <Checkbox label={row.title} checked={ids.includes(row.id)} onChange={checked => setIds(current =>
            checked ? [...new Set([...current, row.id])] : current.filter(id => id !== row.id)
          )} />
          {row.source && <small>{row.source}</small>}
        </div>
        <div className="apple-settings-badges">
          {row.id === catalog.default_id && <span className="apple-settings-tag">默认</span>}
          {!row.writable && <span className="apple-settings-tag">只读</span>}
        </div>
      </li>)}
    </ul>
  </SettingsDialog>
}

export function Settings({ api, AlcorView, sync, view }) {
  const [settings, setSettings] = useState(null)
  const [committed, setCommitted] = useState(null)
  const [alcor, setAlcor] = useState(false)
  const [lists, setLists] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [picker, setPicker] = useState(null)
  const call = async (method, request) => {
    const result = await api[method](request)
    if (!result.ok) throw new Error(result.error?.message ?? '操作未完成。')
    return result.value
  }
  const refreshSources = async () => {
    const results = await Promise.allSettled(groups.map(({ kind }) => call('sources', { kind })))
    setLists(Object.fromEntries(groups.map(({ kind }, index) => {
      const result = results[index]
      return [kind, result.status === 'fulfilled' ? result.value : { error: result.reason.message }]
    })))
  }
  const load = async () => {
    const state = await call('state', {})
    setSettings(state.settings); setCommitted(state.settings); setAlcor(state.alcor)
    await refreshSources()
  }
  const run = async operation => {
    setError(''); setBusy(true)
    try { await operation() }
    catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (view !== 'summary') void run(load) }, [api, view])
  if (view === 'summary') return '在 DSH 中查询和编辑 Apple 日历及提醒事项。安装 Alcor 后可启用双向同步。'
  const change = value => { setSettings(value); setSaved(false) }
  const dirty = settings && committed && (settings.writes !== committed.writes || groups.some(({ kind }) =>
    settings[kind].length !== committed[kind].length || settings[kind].some(id => !committed[kind].includes(id))
  ))
  return <div className="apple-sync-settings">
    <section className="apple-permission-panel" aria-label="权限和设置">
      <header className="apple-settings-heading">
        <h2>权限和设置</h2>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(settings ? refreshSources : load)}>
          <IconRefreshOutlineRegular size={15} aria-hidden="true" />刷新来源
        </Button>
      </header>
      <div className="apple-settings-card" role="group" aria-label="DSH 对话访问权限">
        {groups.map(({ kind, label, manage, Icon }) => {
          const catalog = lists[kind]
          const access = catalog?.authorization
          const allowed = access === 'full_access'
          const count = allowed ? catalog.sources.filter(row => settings?.[kind].includes(row.id)).length : 0
          const grantable = ['denied', 'not_determined', 'write_only'].includes(access)
          return <div className="apple-permission-entry" key={kind}>
            <div className="apple-permission-entry-main">
              <span className="apple-sync-service-icon"><Icon size={20} aria-hidden="true" /></span>
              <div className="apple-settings-text"><strong>{label}</strong>
                <small>{allowed ? (catalog.sources.length ? `已选 ${count} / ${catalog.sources.length} 个对话来源` : '没有可访问的来源')
                  : catalog?.error ? '来源读取失败' : authorization[access] ?? (busy ? '正在读取权限' : '权限状态不可用')}</small>
              </div>
              {allowed && <Button variant="outline" size="sm" disabled={busy || !settings || !catalog.sources.length} onClick={() => setPicker(kind)}>{manage}</Button>}
              {grantable && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => {
                const value = await call('authorize', { kind })
                setLists(previous => ({ ...previous, [kind]: value }))
              })}>授权{label}</Button>}
            </div>
            {catalog?.error && <Notice tone="warning">{catalog.error}</Notice>}
            {['denied', 'write_only', 'restricted'].includes(access) && <Notice tone="warning">请在 macOS 系统设置的「隐私与安全性」中检查权限。</Notice>}
          </div>
        })}
        <div className="apple-permission-entry apple-permission-write">
          <div className="apple-settings-text"><strong>允许对话写入</strong><small>每次写入由 DSH 请求确认</small></div>
          <Switch label="允许对话写入" checked={settings?.writes ?? false} disabled={busy || !settings}
            onChange={writes => change({ ...settings, writes })} />
        </div>
        <footer className="apple-permission-footer">
          <span className="apple-settings-caption" role="status">{saved ? '设置已保存' : dirty ? '有未保存的更改' : ''}</span>
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void run(async () => {
            const state = await call('save', settings)
            setSettings(state.settings); setCommitted(state.settings); setAlcor(state.alcor); setSaved(true)
          })}>保存设置</Button>
        </footer>
      </div>
      {error && <Notice tone="error" className="apple-sync-notice">{error}</Notice>}
    </section>
    {alcor && sync && <AlcorView api={sync} view={view} />}
    {picker && <SourcePicker key={picker} label={groups.find(group => group.kind === picker).manage} catalog={lists[picker]}
      selected={settings[picker]} close={() => setPicker(null)} apply={ids => { change({ ...settings, [picker]: ids }); setPicker(null) }} />}
  </div>
}

export const inject = ['configForms', 'slots', 'remote']
export async function apply(ctx) {
  ctx.effect(() => {
    const element = document.createElement('style')
    element.textContent = style + noticeStyle
    document.head.append(element)
    return () => element.remove()
  })
  await ctx.remote.$mount(directRemote)
  await ctx.remote.$mount(remote)
  const AlcorView = withModeView(ctx, '@alcor/apple-sync', AlcorSettings)
  ctx.inject(['remote.dshAppleSettings'], scope => {
    scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
      name: 'plugins.bundle.config', key: '@alcor/apple-sync',
      inject: () => ({ api: scope.remote.dshAppleSettings, sync: scope.get('remote.alcorAppleSync'), AlcorView }),
    }, Settings))
  })
}
