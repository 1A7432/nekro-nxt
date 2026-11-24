import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { AdmissionIdSchema, EpisodeIdSchema, LogicalMessageIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshHostRuntime } from '../src/index.js'

const OPTIONAL_REPLY_LINE = '群里每条消息你都能看到，不一定要回；不想接话就用 finish_channel_turn 结束。'

const systemText = (options: GenerateOptions): string =>
  options.messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
    .join('\n')

class QuietModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await Promise.resolve()
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '嗯。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

const firstRequest = async (optionalReplies: boolean | undefined): Promise<GenerateOptions> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nxt-optional-replies-'))
  disposers.push(() => rm(directory, { recursive: true, force: true }))
  const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
  disposers.push(() => database.close())
  const repository = new SqliteCoreRepository(database)
  let sequence = 0
  const core = new CoreService(repository, { nextUlid: () => `L${++sequence}` })
  const agent = core.createAgent({
    displayName: '群聊智能体',
    persona: '回复频道消息。',
    model: { provider: 'quiet-provider', model: 'quiet-model' },
  })
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'lobby', kind: 'internal' })
  const model = new QuietModel()
  let context: Context | undefined
  const host = await DshHostRuntime.create({
    sessionDatabasePath: path.join(directory, 'sessions.sqlite'),
    communication: {
      sendMessage: () =>
        Promise.resolve({
          logicalMessageId: LogicalMessageIdSchema.parse(`msg_OPTIONAL${++sequence}`),
          status: 'sent',
          receipts: [],
        }),
      ...(optionalReplies === undefined ? {} : { optionalReplies: () => optionalReplies }),
    },
    history: repository,
    assets: repository,
    assetService: new AssetService(repository, path.join(directory, 'assets')),
    resolveAgentRevision: (revisionId) => repository.getAgentRevision(revisionId),
    configureLlm: (ctx) => {
      context = ctx
      ctx.llm.registerAdapter(['quiet-provider'], model)
    },
  })
  disposers.push(() => host.dispose())
  const sessionId = await host.createSession({
    episodeId: EpisodeIdSchema.parse('eps_OPTIONALREPLIES'),
    channelId: channel.id,
    agentId: agent.definition.id,
    agentRevisionId: agent.revision.id,
  })
  if (!context?.agents.get(SessionId(sessionId))) throw new Error('Missing live agent')
  const event = core.appendInbound({
    connectionId: connection.id,
    channelId: channel.id,
    adapterKey: 'fixture-alpha',
    platformEventId: 'hello',
    kind: 'message-created',
    parts: [{ type: 'text', text: '大家好' }],
    platformTimestamp: Date.now(),
    receivedAt: Date.now(),
    dedupeKey: 'hello',
  }).event
  await host.admit({
    dshSessionId: sessionId,
    admissionId: AdmissionIdSchema.parse('adm_HELLO'),
    events: [event],
    mode: 'followup',
    replyRequired: false,
  })
  await host.whenIdle(sessionId)
  const first = model.calls[0]
  if (!first) throw new Error('No model request')
  return first
}

describe('optional replies in the channel prompt', () => {
  it('says once, in the system prompt, that plain messages need no reply', async () => {
    const request = await firstRequest(true)
    expect(systemText(request).split(OPTIONAL_REPLY_LINE)).toHaveLength(2)
    const userText = request.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
      .join('\n')
    expect(userText).not.toContain('finish_channel_turn')
  })

  it('leaves the line out where every message is not optional', async () => {
    expect(systemText(await firstRequest(false))).not.toContain(OPTIONAL_REPLY_LINE)
    expect(systemText(await firstRequest(undefined))).not.toContain(OPTIONAL_REPLY_LINE)
  })
})
