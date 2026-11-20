import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { uiMode, withModeView } from '../../Alcor/packages/alcor-plugin-info/src/mode-view.jsx'
import noticeStyle from '../../Alcor/packages/alcor-plugin-info/src/notice.css'
import { AlcorSettings } from './alcor-settings.jsx'
import { directRemote } from './direct-remote.js'
import { remote } from './remote.js'
import style from './style.css'

const groups = [['calendar', '日历'], ['reminders', '提醒事项']]
const authorization = { full_access: '已授权', denied: '访问已拒绝', not_determined: '待授权',
  restricted: '访问受系统限制', write_only: '仅有写入权限', helper_missing: '系统连接组件未安装', unsupported: '仅支持 macOS' }
const subscribeMode = listener => {
  window.addEventListener('alcor-mode-changed', listener)
  return () => window.removeEventListener('alcor-mode-changed', listener)
}

export function Settings({ api, AlcorView, sync, view }) {
  const mode = useSyncExternalStore(subscribeMode, uiMode)
  const [settings, setSettings] = useState(null)
  const [alcor, setAlcor] = useState(false)
  const [lists, setLists] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const call = async (method, request) => {
    const result = await api[method](request)
    if (!result.ok) throw new Error(result.error?.message ?? '操作未完成。')
    return result.value
  }
  const refresh = async () => {
    const state = await call('state', {})
    setSettings(state.settings); setAlcor(state.alcor)
    const rows = await Promise.all(groups.map(async ([kind]) => [kind, await call('sources', { kind })]))
    setLists(Object.fromEntries(rows))
  }
  const run = async operation => {
    setError(''); setBusy(true)
    try { await operation() }
    catch (cause) { setError(cause.message) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (view !== 'summary') void run(refresh) }, [api, view])
  if (view === 'summary') return '在 DSH 中查询和编辑 Apple 日历及提醒事项。安装 Alcor 后可启用双向同步。'
  const change = value => { setSettings(value); setSaved(false) }
  const permissions = <>
    <p>勾选允许 DSH 对话访问的来源。关闭写入时仍可查询。</p>
    {groups.map(([kind, label]) => {
      const list = lists[kind]
      return <section key={kind} aria-label={label}>
        <h3>{label}</h3>
        <p>{authorization[list?.authorization] ?? (list ? '授权状态未知' : '正在读取权限')}</p>
        {list && list.authorization !== 'full_access' && !['unsupported', 'helper_missing'].includes(list.authorization) &&
          <Button disabled={busy} onClick={() => void run(async () => {
            const value = await call('authorize', { kind })
            setLists(previous => ({ ...previous, [kind]: value }))
          })}>授权{label}</Button>}
        {list && ['denied', 'write_only', 'restricted'].includes(list.authorization) &&
          <p>请在 macOS 系统设置的「隐私与安全性」中检查权限。</p>}
        {list?.sources.map(row => <label key={row.id} className="apple-direct-source">
          <input type="checkbox" disabled={busy || !settings} checked={settings?.[kind].includes(row.id) ?? false} onChange={event => {
            const next = event.target.checked ? [...new Set([...settings[kind], row.id])] : settings[kind].filter(id => id !== row.id)
            change({ ...settings, [kind]: next })
          }} />
          <span>{row.title} · {row.source}{row.id === list.default_id ? '（默认）' : ''}{row.writable ? '' : '（只读）'}</span>
        </label>)}
      </section>
    })}
    {settings && <>
      <label className="apple-direct-source"><input type="checkbox" disabled={busy} checked={settings.writes}
        onChange={event => change({ ...settings, writes: event.target.checked })} />允许写入，每次由 DSH 询问确认</label>
      <Button disabled={busy} onClick={() => void run(async () => {
        const state = await call('save', settings)
        setSettings(state.settings); setAlcor(state.alcor); setSaved(true)
      })}>保存对话访问权限</Button>
    </>}
    <Button disabled={busy} variant="ghost" onClick={() => void run(refresh)}>刷新来源</Button>
    {saved && <p role="status">已保存</p>}
    {error && <p role="alert">{error}</p>}
  </>
  return <div className="apple-sync-settings">
    {alcor && sync ? <>
      <AlcorView api={sync} view={view} />
      <details className="apple-direct-permissions" open={mode === 'dsh'}>
        <summary>DSH 对话访问权限</summary>
        <div>{permissions}</div>
      </details>
    </> : <><h2>Apple 日历与提醒事项</h2>{permissions}</>}
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
