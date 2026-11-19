import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

export const kindSchema = z.enum(['calendar', 'reminders'])
const id = z.string().min(1).max(500)
export const settingsSchema = z.object({
  calendar: z.array(id).max(100),
  reminders: z.array(id).max(100),
  writes: z.boolean(),
}).strict()

const methods = Object.fromEntries([
  ['state', z.object({}).strict()],
  ['sources', z.object({ kind: kindSchema }).strict()],
  ['authorize', z.object({ kind: kindSchema }).strict()],
  ['save', settingsSchema],
].map(([method, schema]) => ['dshAppleSettings/' + method, {
  service: 'dshAppleSettings', invocation: { kind: 'direct' },
  parameters: [{ name: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: '@alcor/apple-sync/direct#' + method, create: () => schema } }],
  result: { mode: 'strict', typeSymbol: '@alcor/apple-sync/direct#direct-response', create: () => z.json() },
}]))
export const directRemote = createTypertRemoteInfo({ package: '@alcor/apple-sync/direct', methods }, z)
