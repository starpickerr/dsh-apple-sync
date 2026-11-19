import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BusinessWorker, resolveBusinessPython } from '../../Alcor/packages/alcor-organizer/src/business.js'
import { modeConfig } from '../../Alcor/packages/alcor-plugin-info/src/host-policy.js'
import AlcorSync from './alcor-sync.ts'
import { directRemote, kindSchema, settingsSchema } from './direct-remote.js'
import { registerDirectTools } from './direct-tools.js'

export const inject = ['typert', 'tools']
export const Config = modeConfig('alcor')

class Settings extends TypertRemoteService {
  private worker
  private location
  private preferences

  constructor(ctx, options) {
    super(ctx, 'dshAppleSettings', { namespace: 'dshAppleSettings' })
    this.worker = options.worker
    this.location = options.location
    this.preferences = options.preferences
  }

  [Service.init]() {
    this.ctx.typert.register({ package: '@alcor/apple-sync/direct', face: 'host', schemas: [], invocations: directRemote.descriptors,
      model: { services: [], events: [], objects: [] } })
  }

  checkOwner() {
    const call = this.ctx.invocation
    if (call?.peer?.principal?.kind !== 'owner' || call.signal.aborted || call.peer.signal.aborted) {
      throw new Error('请在本机插件设置中管理 Apple 权限。')
    }
  }

  @Remote state() {
    this.checkOwner()
    return { settings: this.preferences.current, alcor: !!this.ctx.get('alcorAppleSync') }
  }

  @Remote sources(request) {
    this.checkOwner()
    return this.worker.call('direct', { action: 'sources', kind: kindSchema.parse(request.kind) })
  }

  @Remote authorize(request) {
    this.checkOwner()
    return this.worker.call('direct', { action: 'access', kind: kindSchema.parse(request.kind) })
  }

  @Remote save(request) {
    this.checkOwner()
    const value = settingsSchema.parse(request)
    const path = join(this.location, 'settings.json')
    const staging = path + '.' + randomUUID()
    mkdirSync(this.location, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(staging, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(staging, path)
    } finally { rmSync(staging, { force: true }) }
    this.preferences.current = value
    return { settings: value, alcor: !!this.ctx.get('alcorAppleSync') }
  }
}

export async function apply(ctx, config) {
  const profile = ctx.get('profileContext')
  if (!Array.isArray(profile?.startedBundles) || !isAbsolute(profile.dir ?? '')) throw new Error('无法确认当前 Profile。')
  if (profile.startedBundles.includes('@stella/apple-sync')) throw new Error('旧版 Stella 插件与 Alcor 不能同时启用，请先迁移 Profile。')
  const location = join(profile.dir, 'dsh-apple-sync')
  const preferences = { current: { calendar: [], reminders: [], writes: false } }
  try { preferences.current = settingsSchema.parse(JSON.parse(readFileSync(join(location, 'settings.json'), 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const pending = new Map()
  let alive = true
  const worker = new BusinessWorker(location, {
    worker: new URL('../python/worker.py', import.meta.url),
    python: await resolveBusinessPython(),
    onRequest: request => request?.route === 'direct_apple_write' && alive && pending.get(request.operation_id)?.() === true,
    diagnostic: (message, level = 'warn') => ctx.logger('dsh-apple-sync')[level](message),
  })
  ctx.effect(() => async () => { alive = false; pending.clear(); await worker.close() })
  await ctx.plugin(Settings, { worker, location, preferences }).await()
  registerDirectTools(ctx, worker, () => alive ? preferences.current : { calendar: [], reminders: [], writes: false }, pending)
  ctx.inject(['alcorOrganizer', 'credentials'], async function connectAlcor(inner) {
    await inner.plugin(AlcorSync, { productScope: config?.productScope?.get?.() ?? 'alcor' }).await()
  })
}
