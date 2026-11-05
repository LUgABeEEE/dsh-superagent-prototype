import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isHumanRecord, sendTodoNote, todoTrigger } from '../src/sources/todo.ts'
import type { OutboundMessage } from '../src/core/index.ts'

/**
 * The todo list as a Source.
 *
 * Two halves are worth pinning. Which records count as a request — the tag is a person's
 * authorization, but a record in the inbox, without a directory, already being worked, or left
 * behind by an agent is not one. And what a reply does: it goes back as a *note* attributed to
 * the agent, once, and never as a change of status — a worker does not finish a person's work.
 */

const config = { endpoint: 'http://list.test', tag: 'auto:3', pollSeconds: 60, includeDoing: false, dailyCap: 2 } as const

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    title: '做一件事',
    status: 'open',
    tags: ['auto:3'],
    originDir: '/work/thing',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    createdBy: 'human',
    updatedBy: 'human',
    ...overrides,
  } as Parameters<typeof todoTrigger>[0]
}

describe('which records are requests', () => {
  it('takes a record a person tagged and gave a directory', () => {
    const trigger = todoTrigger(record(), config)
    expect(trigger).toBeDefined()
    // The id is a digest of (source, record, updatedAt): stable while the record is unchanged.
    expect(trigger?.id).toMatch(/^[0-9a-f]{32}$/)
    expect(trigger?.meta.todoId).toBe('t-1')
    expect(trigger?.meta.dir).toBe('/work/thing')
    expect(trigger?.human).toBe(true)
    expect(trigger?.text).toContain('做一件事')
  })

  it('leaves a record without the authorization tag alone', () => {
    expect(todoTrigger(record({ tags: ['某项工作'] }), config)).toBeUndefined()
  })

  it('reads the tag case-insensitively', () => {
    expect(todoTrigger(record({ tags: ['AUTO:3'] }), config)).toBeDefined()
  })

  it('leaves alone a record waiting in the inbox, or one with no directory', () => {
    expect(todoTrigger(record({ tags: ['auto:3', 'inbox'] }), config)).toBeUndefined()
    expect(todoTrigger(record({ originDir: '' }), config)).toBeUndefined()
  })

  it('leaves alone a record whose session is still alive, unless doing counts', () => {
    expect(todoTrigger(record({ sessionAlive: true }), config)).toBeUndefined()
    expect(todoTrigger(record({ status: 'doing' }), config)).toBeUndefined()
    expect(todoTrigger(record({ status: 'doing' }), { ...config, includeDoing: true })).toBeDefined()
  })

  it('does not take a record an agent wrote and nobody has touched', () => {
    const trigger = todoTrigger(record({ createdBy: 'agent', updatedBy: 'agent' }), config)
    expect(trigger).toBeDefined()
    expect(trigger?.human).toBe(false)
    expect(trigger?.actor.id).toBe('agent')
  })

  it('changes the identity when the record is edited, so an edit is a new request', () => {
    const first = todoTrigger(record(), config)
    const edited = todoTrigger(record({ updatedAt: 1_700_000_200_000 }), config)
    expect(first?.id).not.toBe(edited?.id)
    expect(todoTrigger(record(), config)?.id).toBe(first?.id)
  })

  it('counts a person\'s last edit as theirs, which is how a tag reaches an agent-captured record', () => {
    expect(isHumanRecord(record({ createdBy: 'agent', updatedBy: 'human' }) as never)).toBe(true)
    expect(isHumanRecord(record({ createdBy: 'agent', updatedBy: 'agent' }) as never)).toBe(false)
    expect(isHumanRecord(record({ createdBy: undefined, updatedBy: 'agent' }) as never)).toBe(true)
  })

  it('carries the steps in the prompt without claiming they are done', () => {
    const trigger = todoTrigger(record({ steps: [{ text: '先读一遍' }, { text: '再改', done: true }] }), config)
    expect(trigger?.text).toContain('1. 先读一遍')
    expect(trigger?.text).toContain('2. [已完成] 再改')
  })
})

describe('the reply', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function reply(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
    return {
      id: 'msg-1',
      text: '改好了，测试通过',
      channel: { source: 'todo', thread: 'todo:t-1', address: { todoId: 't-1', endpoint: 'http://list.test' } },
      ...overrides,
    } as unknown as OutboundMessage
  }

  function answer(body: unknown, status = 200) {
    return { status, json: async () => body } as Response
  }

  it('writes a note attributed to the agent, marked so a retry is a no-op', async () => {
    fetchMock.mockResolvedValueOnce(answer({ ok: true, data: { id: 't-1', status: 'open', notes: [] } }))
    fetchMock.mockResolvedValueOnce(answer({ ok: true, data: { note: { by: 'agent' } } }))

    await expect(sendTodoNote(reply())).resolves.toBe('sent')

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('http://list.test/api/global-todo/note')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.id).toBe('t-1')
    expect(body.by).toBe('agent')
    expect(body.text).toContain('【superagent msg-1】')
    expect(body.text).toContain('改好了，测试通过')
    // A reply is a note, never a status change: finishing is the person's judgement.
    expect(fetchMock.mock.calls.some(([target]) => String(target).includes('/status'))).toBe(false)
  })

  it('does not write twice when the marker is already in the record', async () => {
    fetchMock.mockResolvedValueOnce(answer({
      ok: true,
      data: { id: 't-1', status: 'open', notes: [{ at: 1, by: 'agent', text: '【superagent msg-1】改好了，测试通过' }] },
    }))
    await expect(sendTodoNote(reply())).resolves.toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a removed record as gone instead of retrying forever', async () => {
    fetchMock.mockResolvedValueOnce(answer({ ok: false, error: '没有这条待办' }, 404))
    await expect(sendTodoNote(reply())).resolves.toBe('gone')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a message with no destination', async () => {
    await expect(sendTodoNote(reply({ channel: { source: 'todo', thread: '', address: {} } } as never)))
      .rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
