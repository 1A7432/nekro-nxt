import { AssetService, CoreService } from '@nekro-nxt/core'
import { ChannelIdSchema, ChannelMemberIdSchema } from '@nekro-nxt/contracts'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { mentionLabel } from '../src/session-image-context.js'
import { resolveShortId, resolveShortIdArgs, shortId, ShortIdError, type ShortIdLookup } from '../src/short-ids.js'

const CHANNEL = ChannelIdSchema.parse('chn_FIXTURE')

const lookupOf = (ids: readonly string[]): ShortIdLookup => ({
  findChannelIdsBySuffix: (_channelId, kind, suffix, limit = 2) =>
    ids
      .filter((id) => id.startsWith({ message: 'msg_', member: 'mbr_', asset: 'ast_' }[kind]) && id.endsWith(suffix))
      .slice(0, limit),
})

describe('short ids', () => {
  it('shows the last six characters behind a mark for messages, members and assets', () => {
    expect(shortId('msg_01M861GPV7HJNAQPMZR8BJDJPW')).toBe('#BJDJPW')
    expect(shortId('mbr_01M7TKK3AYDY18MV5E1NTA8Y8G')).toBe('@TA8Y8G')
    expect(shortId('ast_01M85W28TJXZ9P3A63ZX71SJ2T')).toBe('&71SJ2T')
    // Other ids and text stay as they are.
    expect(shortId('chn_01M7TJYZWSN4KV07F21SMV628F')).toBe('chn_01M7TJYZWSN4KV07F21SMV628F')
    expect(shortId('msg_SHORT')).toBe('msg_SHORT')
    expect(shortId('你好')).toBe('你好')
  })

  it('turns a short id into the one full id it names in the channel, and refuses none or several', () => {
    const lookup = lookupOf([
      'msg_01M861GPV7HJNAQPMZR8BJDJPW',
      'mbr_01M7TKK3AYDY18MV5E1NTA8Y8G',
      'msg_AAAAAAAAAAAAAAAAAAAAADUPLIC',
      'msg_BBBBBBBBBBBBBBBBBBBBBDUPLIC',
    ])
    expect(resolveShortId('#BJDJPW', CHANNEL, lookup)).toBe('msg_01M861GPV7HJNAQPMZR8BJDJPW')
    expect(resolveShortId('@TA8Y8G', CHANNEL, lookup)).toBe('mbr_01M7TKK3AYDY18MV5E1NTA8Y8G')
    // A member suffix under the message mark is not that member.
    expect(() => resolveShortId('#TA8Y8G', CHANNEL, lookup)).toThrow(ShortIdError)
    expect(() => resolveShortId('#DUPLIC', CHANNEL, lookup)).toThrow('不止一个')
    expect(() => resolveShortId('&NOPE00', CHANNEL, lookup)).toThrow('找不到资源')
    // Full ids and other text pass through untouched.
    expect(resolveShortId('msg_01M861GPV7HJNAQPMZR8BJDJPW', CHANNEL, lookup)).toBe('msg_01M861GPV7HJNAQPMZR8BJDJPW')
    expect(resolveShortId('#话题', CHANNEL, lookup)).toBe('#话题')
  })

  it('resolves only values under id keys in tool arguments', () => {
    const lookup = lookupOf([
      'msg_01M861GPV7HJNAQPMZR8BJDJPW',
      'mbr_01M7TKK3AYDY18MV5E1NTA8Y8G',
      'ast_X1M85W28TJXZ9P3A63ZX71SJ2T',
    ])
    expect(
      resolveShortIdArgs(
        {
          target: { type: 'reply', messageId: '#BJDJPW' },
          parts: [
            { type: 'text', text: '@TA8Y8G 看这里 #BJDJPW' },
            { type: 'mention', memberId: '@TA8Y8G' },
            { type: 'image', assetId: '&71SJ2T' },
          ],
          about: '@TA8Y8G',
          images: [{ assetId: '&71SJ2T', focus: '&71SJ2T 的左上角' }],
        },
        CHANNEL,
        lookup,
      ),
    ).toEqual({
      target: { type: 'reply', messageId: 'msg_01M861GPV7HJNAQPMZR8BJDJPW' },
      parts: [
        { type: 'text', text: '@TA8Y8G 看这里 #BJDJPW' },
        { type: 'mention', memberId: 'mbr_01M7TKK3AYDY18MV5E1NTA8Y8G' },
        { type: 'image', assetId: 'ast_X1M85W28TJXZ9P3A63ZX71SJ2T' },
      ],
      about: 'mbr_01M7TKK3AYDY18MV5E1NTA8Y8G',
      images: [{ assetId: 'ast_X1M85W28TJXZ9P3A63ZX71SJ2T', focus: '&71SJ2T 的左上角' }],
    })
  })
})

describe('mentions', () => {
  it('reads a mention of the agent itself as 「@你」 and others by name and short id', () => {
    const self = ChannelMemberIdSchema.parse('mbr_01M7TJYZX5KKBM7YW4D6VJY5KQ')
    const other = ChannelMemberIdSchema.parse('mbr_01M7TKK3AYDY18MV5E1NTA8Y8G')
    expect(mentionLabel({ memberId: self, displayName: '机器人账号', relation: { kind: 'self' } })).toBe('@你')
    expect(mentionLabel({ memberId: other, displayName: '成员乙' })).toBe('@成员乙（@TA8Y8G）')
  })
})

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

describe('finding channel ids by suffix', () => {
  it('finds messages, members and assets of one channel only', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nxt-short-ids-'))
    disposers.push(() => rm(directory, { recursive: true, force: true }))
    const database = await openMigratedCoreDatabase(path.join(directory, 'core.sqlite'))
    disposers.push(() => database.close())
    const repository = new SqliteCoreRepository(database)
    let sequence = 0
    const core = new CoreService(repository, { nextUlid: () => `L${String(++sequence).padStart(25, '0')}` })
    const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
    const channel = core.createChannel({ connectionId: connection.id, platformChannelId: 'lobby', kind: 'internal' })
    const other = core.createChannel({ connectionId: connection.id, platformChannelId: 'other', kind: 'internal' })
    const append = (channelId: typeof channel.id, key: string) =>
      core.appendInbound({
        connectionId: connection.id,
        channelId,
        adapterKey: 'fixture-alpha',
        platformEventId: key,
        kind: 'message-created',
        parts: [{ type: 'text', text: key }],
        platformTimestamp: 1_000,
        receivedAt: 1_000,
        dedupeKey: key,
        senderMemberId: core.observeChannelMember({
          connectionId: connection.id,
          channelId,
          platformUserId: `user-${key}`,
          displayName: key,
          observedAt: 1_000,
        }).member.id,
      }).event
    const here = append(channel.id, 'here')
    const there = append(other.id, 'there')
    const suffix = (id: string) => id.slice(-6)
    expect(repository.findChannelIdsBySuffix(channel.id, 'message', suffix(here.logicalMessageId))).toEqual([
      here.logicalMessageId,
    ])
    expect(repository.findChannelIdsBySuffix(channel.id, 'message', suffix(there.logicalMessageId))).toEqual([])
    expect(here.senderMemberId).toBeDefined()
    expect(repository.findChannelIdsBySuffix(channel.id, 'member', suffix(here.senderMemberId ?? ''))).toEqual([
      here.senderMemberId,
    ])
    expect(repository.findChannelIdsBySuffix(other.id, 'member', suffix(here.senderMemberId ?? ''))).toEqual([])
    const assets = new AssetService(repository, path.join(directory, 'assets'))
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
      .png()
      .toBuffer()
    const { asset } = await assets.prepare({ bytes: new Uint8Array(bytes), declaredMediaType: 'image/png' })
    repository.grantAssetAccess({ assetId: asset.id, channelId: channel.id, source: 'agent-tool', grantedAt: 1000 })
    expect(repository.findChannelIdsBySuffix(channel.id, 'asset', suffix(asset.id))).toEqual([asset.id])
    expect(repository.findChannelIdsBySuffix(other.id, 'asset', suffix(asset.id))).toEqual([])
    // Characters outside ids never reach the query.
    expect(repository.findChannelIdsBySuffix(channel.id, 'message', '%')).toEqual([])
  })
})
