import { createHash } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const id = z.string().min(1).max(500)
const iso = z.iso.datetime({ offset: true })
const title = z.string().trim().min(1).max(300)
const notes = z.string().max(4000)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const zone = z.string().min(1).max(100)
const eventPatch = { title, description: notes, location: z.string().max(500), start_at: iso, end_at: iso }
const reminderPatch = { title, notes, due_on: z.iso.date().nullable(), due_time: time.nullable() }
const providerIdentity = provider => provider?.[symbols.original] ?? provider

export const operations = [
  ['apple_calendar_list', 'List Apple events in a <=31 day range. Use ISO 8601 timestamps with time zone offsets. Returns exact event IDs and occurrence dates for edits.', 'calendar', 'query',
    z.object({ calendar_id: id.optional(), start: iso, end: iso }).strict()],
  ['apple_calendar_create', 'Create one Apple event with explicit start, end, and IANA time zone. Omit calendar_id to use the system default if enabled.', 'calendar', 'create',
    z.object({ calendar_id: id.optional(), ...eventPatch, description: notes.optional(), location: z.string().max(500).optional(), timezone: zone }).strict()],
  ['apple_calendar_update', 'Edit one Apple event occurrence. Use exact IDs and occurrence_date from the list tool. Omitted fields stay unchanged.', 'calendar', 'update',
    z.object(eventPatch).partial().extend({ calendar_id: id, event_id: id, occurrence_date: iso }).strict()],
  ['apple_reminders_list', 'List Apple reminders in enabled lists, excluding completed by default. Returns precise IDs for edits and completion.', 'reminders', 'query',
    z.object({ list_id: id.optional(), include_completed: z.boolean().optional() }).strict()],
  ['apple_reminder_create', 'Create one Apple reminder. For a timed alert include due_on, due_time, IANA timezone and remind_at (ISO 8601 with offset). Use the enabled default list unless list_id is supplied.', 'reminders', 'create',
    z.object(reminderPatch).partial().extend({ title, list_id: id.optional(), timezone: zone.optional(), remind_at: iso.optional() }).strict()],
  ['apple_reminder_update', 'Edit one Apple reminder using exact IDs. Omitted fields and existing notification alarms stay unchanged.', 'reminders', 'update',
    z.object(reminderPatch).partial().extend({ list_id: id, reminder_id: id }).strict()],
  ['apple_reminder_complete', 'Mark one current Apple reminder as completed. For repeats, Apple advances the series.', 'reminders', 'complete',
    z.object({ list_id: id, reminder_id: id }).strict()],
]

function parameters(schema) {
  const json = z.toJSONSchema(schema)
  return Object.fromEntries(Object.entries(json.properties).map(([name, property]) => {
    const type = property.type === 'boolean' ? 'boolean' : 'string'
    const base = { type, ...(json.required?.includes(name) ? { required: true } : {}) }
    return [name, property.anyOf?.some(item => item.type === 'null') ? { oneOf: [{ type }, { type: 'null' }] } : base]
  }))
}

export function registerDirectTools(ctx, worker, settings, pending) {
  const provenance = new WeakMap()
  const turnOf = agent => agent?.session && ctx.get('agents')?.turnBoundaryOf(agent.session)
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.length) {
      const turn = turnOf(agent)
      const previous = provenance.get(agent)
      const same = previous?.session === agent.session && previous.start === turn?.openTurnStartSeq && previous.turn === turn?.lastTurn
      if (turn?.openTurnStartSeq != null && Number.isSafeInteger(turn.lastTurn)) {
        provenance.set(agent, { session: agent.session, start: turn.openTurnStartSeq, turn: turn.lastTurn,
          user: messages.every(message => message.source.kind === 'user') && (!same || previous.user) })
      } else provenance.delete(agent)
    }
    return next()
  })
  function activeTurn(agent) {
    const header = agent?.session?.header
    if (!header || header.origin === 'subagent' || header.parentSession || /^(?:workbench-)?onebot-/.test(agent.session.id)) return
    const saved = provenance.get(agent), turn = turnOf(agent)
    if (saved?.user && saved.session === agent.session && saved.start === turn?.openTurnStartSeq && saved.turn === turn?.lastTurn) return saved.turn
  }
  ctx.tools.guard(execution => operations.some(([name]) => name === execution.name) && activeTurn(execution.agent) == null
    ? 'Apple 工具仅供用户主动发起的本机主对话使用。' : undefined)

  for (const [name, description, kind, action, schema] of operations) {
    ctx.tools.register(defineTool({
      name, description, parameters: parameters(schema), timeoutMs: 245000,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(input, execution) {
        const args = schema.parse(input)
        const { agent, signal, callId, toolSet } = execution
        const turn = activeTurn(agent), session = agent?.session, selection = settings()
        const allowed = selection[kind]
        const valid = () => !!signal && !signal.aborted && turn != null && activeTurn(agent) === turn &&
          agent.session === session && settings() === selection && ctx.tools.executable(name, agent, toolSet) !== undefined
        if (!valid() || !allowed.length) throw new Error('请从当前本机对话使用，并在插件设置中选择 Apple 来源。')
        if (action === 'query') {
          const result = await worker.call('direct', { action, kind, args, allowed })
          if (!valid()) throw new Error('Apple 读取权限已变化。')
          return result
        }
        const approval = ctx.get('approval')
        const canWrite = () => valid() && selection.writes && providerIdentity(ctx.get('approval')) === providerIdentity(approval) &&
          (approval?.overrideOf(session) ?? approval?.config?.policy ?? 'ask') === 'ask'
        if (!callId || !approval?.request || !canWrite()) throw new Error('请启用 Apple 写入，并使用 DSH 的询问审批模式。')
        const operation_id = createHash('sha256').update(JSON.stringify([session.id, turn, callId])).digest('hex')
        if (pending.has(operation_id)) throw new Error('相同操作正在执行。')
        pending.set(operation_id, () => false)
        try {
          const plan = await worker.call('direct', { action, kind, args, allowed, operation_id })
          if (!canWrite()) throw new Error('Apple 写入权限已变化。')
          const verb = { create: '新建', update: '修改', complete: '完成' }[action]
          const reason = `${verb} Apple ${kind === 'calendar' ? '日程' : '提醒事项'}\n来源：${JSON.stringify([plan.source, plan.title])}\n项目：${JSON.stringify(plan.item)}\n本次写入：${JSON.stringify(plan.changes)}`
          const outcome = await approval.request({ agent, toolName: name, callId, reason, signal })
          if (outcome !== 'allowed-once' || !canWrite()) throw new Error('Apple 写入未获本次批准。')
          pending.set(operation_id, canWrite)
          return await worker.call('direct', { action: 'commit', plan })
        } finally { pending.delete(operation_id) }
      },
    }))
  }
}
