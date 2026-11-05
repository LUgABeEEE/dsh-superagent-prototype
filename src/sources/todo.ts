/**
 * The global-todo list as a Source kind.
 *
 * A Trigger is one record a person marked `可自动`: that tag is the same authorization the list's
 * own dispatch gate reads, so the two halves of this deployment agree on what "an agent may take
 * this" means. A record is a Thread — its `notes` and `activity` are the thread history — and a
 * reply is a note, which is where the list keeps every other event about a record too.
 *
 * Reads and writes go through the list's HTTP API, never its JSON file: the service owns the lock,
 * and a Source writing the file directly would be the overwrite the list was built to prevent.
 */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { ContextMessage, ContextPart, Localized, SourceKind } from './kind.ts'

/** Stable Source id: appears in Trigger `source`, Thread keys, `source:todo` settings and Policy. */
export const SOURCE = 'todo'

/** One record as the list's API prints it; only the fields this Source reads are typed. */
interface TodoRecord {
  id: string
  title: string
  description?: string
  status: string
  tags?: string[]
  originDir?: string
  createdAt?: number
  updatedAt?: number
  createdBy?: string
  updatedBy?: string
  sessionAlive?: boolean
  steps?: { text: string; done?: boolean }[]
  notes?: { at: number; by: string; text: string }[]
}

const TodoConfigSchema = z.object({
  endpoint: z.string().url().default('http://127.0.0.1:3080'),
  tag: z.string().min(1).default('可自动'),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  includeDoing: z.boolean().default(false),
  /** Hard cap on new Tickets per local day; 0 disables the cap. */
  dailyCap: z.number().int().min(0).max(200).default(2),
}).strict()
export type TodoConfig = z.infer<typeof TodoConfigSchema>

/** The list's API answers `{ ok, data }`; a non-200 or `ok: false` is a failure, not an empty list. */
async function api<T>(endpoint: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = (await response.json()) as { ok?: boolean; data?: T; error?: string }
  if (response.status === 404) throw Object.assign(new Error(body.error ?? 'not found'), { status: 404 })
  if (body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body.data as T
}

/** The records a person has asked an agent to take, as the list reports them now. */
async function eligibleTodos(endpoint: string, config: TodoConfig): Promise<TodoRecord[]> {
  const data = await api<{ todos?: TodoRecord[] }>(endpoint, '/api/global-todo/list?status=active&limit=1000')
  const todos = Array.isArray(data.todos) ? data.todos : []
  return todos.filter((todo) => todoTrigger(todo, config) !== undefined)
}

/**
 * One record as a Trigger, or `undefined` when it is not a request.
 *
 * The id includes `updatedAt`: editing a record after its Ticket ended is a new request, while
 * re-reading an unchanged one is the same id and the engine drops it as a duplicate.
 */
/** Whether a person has touched this record: its author, or whoever edited it last. */
export function isHumanRecord(todo: TodoRecord): boolean {
  return todo.createdBy !== 'agent' || todo.updatedBy === 'human'
}

export function todoTrigger(todo: TodoRecord, config: TodoConfig): Trigger | undefined {
  if (todo.status !== 'open' && !(config.includeDoing && todo.status === 'doing')) return undefined
  const tags = (todo.tags ?? []).map((tag) => tag.toLowerCase())
  if (!tags.includes(config.tag.toLowerCase())) return undefined
  // The same two rules as `lib/gate.js`: a record waiting in the inbox has not been confirmed by a
  // person yet, and one without a directory would start a worker in a place nobody chose.
  if (tags.includes('inbox')) return undefined
  if ((todo.originDir ?? '') === '') return undefined
  if (todo.sessionAlive === true) return undefined

  const updatedAt = Number(todo.updatedAt) || Date.now()
  const lines = [todo.title]
  if (todo.description !== undefined && todo.description !== '') lines.push('', todo.description)
  const steps = (todo.steps ?? []).filter((step) => step !== null && typeof step === 'object')
  if (steps.length > 0) {
    lines.push('', `步骤（共 ${steps.length} 步）：`)
    steps.forEach((step, index) => lines.push(`${index + 1}. ${step.done === true ? '[已完成] ' : ''}${step.text}`))
  }
  return {
    id: key(SOURCE, todo.id, String(updatedAt)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: todo.id }],
    // `human` means a person has touched this record — wrote it, or edited it last (which is how
    // the tag gets added to a record an agent captured). A record only an agent ever wrote is not
    // a request from anyone, and the Policy's allowed list is what stops it.
    actor: { source: SOURCE, id: isHumanRecord(todo) ? 'human' : 'agent' },
    human: isHumanRecord(todo),
    addressed: 'mention',
    at: new Date(updatedAt).toISOString(),
    text: lines.join('\n'),
    channel: {
      source: SOURCE,
      thread: `${SOURCE}:${todo.id}`,
      address: { todoId: todo.id, endpoint: config.endpoint },
    },
    meta: { todoId: todo.id, title: todo.title, dir: todo.originDir ?? '', tag: config.tag },
  }
}

/** Writes the reply as a note. Idempotent by the outbox message id, which is carried in the text. */
export async function sendTodoNote(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const todoId = String(message.channel.address.todoId ?? '')
  const endpoint = String(message.channel.address.endpoint ?? '')
  if (todoId === '' || endpoint === '') throw new Error('缺少待办 id 或清单地址，无法回复')
  const marker = `【superagent ${message.id}】`
  let todo: TodoRecord
  try {
    todo = await api<TodoRecord>(endpoint, `/api/global-todo/get?id=${encodeURIComponent(todoId)}`)
  } catch (error) {
    // A removed record is a destination that can never accept the reply again.
    if ((error as { status?: number }).status === 404) return 'gone'
    throw error
  }
  // A retry after a send that the list received but did not answer would duplicate the note;
  // the marker is what makes the second attempt a no-op.
  if ((todo.notes ?? []).some((note) => note.text.startsWith(marker))) return 'sent'
  await api(endpoint, '/api/global-todo/note', {
    method: 'POST',
    body: JSON.stringify({ id: todoId, text: `${marker} ${message.text}`, by: 'agent' }),
  })
  return 'sent'
}

/** The record and its notes as thread messages, so an assessment can read the history. */
async function readTodoThread(_commands: unknown, trigger: Trigger, _part: unknown, cursor: string | undefined,
  config: TodoConfig): Promise<ContextPart> {
  const todoId = String(trigger.meta.todoId ?? '')
  const todo = await api<TodoRecord>(config.endpoint, `/api/global-todo/get?id=${encodeURIComponent(todoId)}`)
  const messages: ContextMessage[] = [{
    id: 'record',
    from: todo.createdBy === 'agent' ? 'agent' : 'human',
    at: new Date(Number(todo.createdAt) || Date.now()).toISOString(),
    text: todo.title,
  }]
  for (const [index, note] of (todo.notes ?? []).entries()) {
    messages.push({
      id: `note:${index}`,
      from: note.by,
      at: new Date(Number(note.at) || Date.now()).toISOString(),
      text: note.text,
    })
  }
  // One page: a record's history is bounded by the store (notes and activity are capped), and a
  // cursor would pretend there is more to read than there is.
  return { messages, body: { todo: { id: todo.id, title: todo.title, status: todo.status, tags: todo.tags ?? [] } } }
}

export const todoKind: SourceKind<TodoConfig> = {
  kind: SOURCE,
  title: { zh: '全局待办', en: 'Global todo list' },
  description: {
    zh: '把全局待办清单里带「可自动」标签的记录当作工作请求；回复写回记录的进展 note。',
    en: 'Treats records tagged 可自动 in the global todo list as work requests; replies are written back as notes.',
  },
  schema: TodoConfigSchema,
  fields: [
    { key: 'endpoint', type: 'text', label: { zh: '清单地址', en: 'List endpoint' },
      hint: { zh: '全局待办所在的 DSH，例如 http://127.0.0.1:3080。本机默认值即可。', en: 'The DSH serving the list, such as http://127.0.0.1:3080. The default is this machine.' } },
    { key: 'tag', type: 'text', label: { zh: '授权标签', en: 'Authorization tag' },
      hint: { zh: '只有带这个标签的记录才会被当作请求。与清单派发闸门用的是同一个词。', en: 'Only records carrying this tag are requests. It is the same tag the list gate reads.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'includeDoing', type: 'switch', label: { zh: '进行中的记录也算请求', en: 'In-progress records count as requests' },
      hint: { zh: '关掉时只有 open 的记录会触发；打开后 doing 也会。', en: 'Off: only open records trigger. On: doing records do too.' } },
  ],
  health: [SOURCE],
  scope: ({ meta }) => typeof meta.todoId === 'string' && meta.todoId !== ''
    // `observed` stays false: a record only reaches this Source because a person tagged it, so
    // there is no unaddressed traffic to admit.
    ? { listened: true, observed: false, row: 'todo' }
    : { listened: false, reason: 'no_todo' },
  channel: {
    allowed: (address) => typeof address.todoId === 'string' && address.todoId !== '',
    send: (_host, message) => sendTodoNote(message),
    link: () => ({ url: '', label: { zh: '待办记录', en: 'Todo record' } }),
  },
  threadContext: { messageId: () => 'record', read: readTodoThread },
  find: (query) => {
    const ids = [...new Set(query.match(/\bt-[0-9a-f]{8}\b/g) ?? [])]
    return { threads: ids.map((id) => `${SOURCE}:${id}`), terms: ids }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]),
    }).strict(),
    fields: [{
      key: 'allowed',
      type: 'rows',
      label: { zh: '能发起工作的记录作者', en: 'Record authors who may originate work' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '作者', en: 'Author' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ],
    }],
    explicit: {
      zh: '记录的作者是名单里的人，并且这条记录打了授权标签。',
      en: 'The record was written by someone on the list and carries the authorization tag.',
    },
    rows: () => [{
      id: 'todo',
      label: { zh: '待办记录', en: 'Todo records' },
      note: { zh: '只看带授权标签的记录', en: 'Only records with the authorization tag' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false },
    }],
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TODO_ID', description: { zh: '工单对应的待办 id；不是待办来源时为空', en: 'The todo id this ticket came from; empty for other sources' } },
      { key: 'DSH_SUPERAGENT_TODO_TITLE', description: { zh: '待办标题', en: 'The todo title' } },
      { key: 'DSH_SUPERAGENT_TODO_DIR', description: { zh: '待办的来源目录，worker 在这里开工', en: 'The todo origin directory, where the worker starts' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_TODO_ID: trigger?.source === SOURCE ? String(trigger.meta.todoId ?? '') : '',
      DSH_SUPERAGENT_TODO_TITLE: trigger?.source === SOURCE ? String(trigger.meta.title ?? '') : '',
      DSH_SUPERAGENT_TODO_DIR: trigger?.source === SOURCE ? String(trigger.meta.dir ?? '') : '',
    }),
  },
}

export const name = 'dsh-superagent-todo'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(todoKind), 'todo: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, todoKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so an escape from the loop becomes health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TodoConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const todos = await eligibleTodos(config.endpoint, config)
        // Daily cap: remember which trigger ids were sent today, so a repeated poll does not
        // consume the budget twice and a backlog cannot flood the Executor.
        const day = new Date().toISOString().slice(0, 10)
        type Sent = { day: string; ids: string[] }
        let sent = ctx.state.get('todo.sent' as never) as Sent | undefined
        if (sent === undefined || sent.day !== day) sent = { day, ids: [] }
        const cap = config.dailyCap ?? 2
        let dispatched = 0
        for (const todo of todos) {
          if (cap > 0 && sent.ids.length >= cap) break
          const trigger = todoTrigger(todo, config)
          if (trigger === undefined) continue
          if (sent.ids.includes(trigger.id)) continue
          await ctx.receive(trigger)
          sent.ids.push(trigger.id)
          dispatched += 1
        }
        ctx.state.set('todo.sent' as never, sent)
        failures = 0
        const left = Math.max(0, todos.length - dispatched)
        ctx.report(SOURCE, { state: 'ready', detail: `${left} 条可派（今日已派 ${sent.ids.length}/${cap || '∞'}）`, at })
      } catch (error) {
        failures += 1
        // One failed poll is retried next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 60) * 1000, undefined, { signal }).catch(() => {})
  }
}
