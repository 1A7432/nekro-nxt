import type { ChannelId } from '@nekro-nxt/contracts'

/**
 * Short ids for what an agent reads: `#` and the last six characters of a message id, `@` for a member, `&` for an
 * asset. Ids end in random characters, so six of them tell a channel's messages, members and assets apart; full ids
 * stay valid everywhere, and a short one that matches nothing or more than one id in the channel is refused.
 */

export type ShortIdKind = 'message' | 'member' | 'asset'

const SUFFIX_LENGTH = 6
const MARK: Readonly<Record<ShortIdKind, string>> = { message: '#', member: '@', asset: '&' }
const KIND_BY_MARK: Readonly<Record<string, ShortIdKind>> = { '#': 'message', '@': 'member', '&': 'asset' }
const KIND_BY_PREFIX: Readonly<Record<string, ShortIdKind>> = { msg: 'message', mbr: 'member', ast: 'asset' }
const FULL_ID = /^(msg|mbr|ast)_[0-9A-Za-z]+$/u
const SHORT_ID = /^([#@&])([0-9A-Za-z]{6})$/u

/** The short form of a message, member or asset id; any other text is returned as it is. */
export const shortId = (id: string): string => {
  const match = FULL_ID.exec(id)
  const kind = match === null ? undefined : KIND_BY_PREFIX[match[1]!]
  return kind === undefined || id.length <= 4 + SUFFIX_LENGTH ? id : `${MARK[kind]}${id.slice(-SUFFIX_LENGTH)}`
}

/** Finds the ids of one kind in a channel that end with a suffix; two or more results mean it is ambiguous. */
export interface ShortIdLookup {
  findChannelIdsBySuffix(channelId: ChannelId, kind: ShortIdKind, suffix: string, limit?: number): readonly string[]
}

export class ShortIdError extends Error {
  override readonly name = 'ShortIdError'
}

const KIND_LABEL: Readonly<Record<ShortIdKind, string>> = { message: '消息', member: '成员', asset: '资源' }

/** A full id as given, or the one id a short form names in the channel; anything else is returned unchanged. */
export const resolveShortId = (value: string, channelId: ChannelId, lookup: ShortIdLookup): string => {
  const match = SHORT_ID.exec(value)
  if (match === null) return value
  const kind = KIND_BY_MARK[match[1]!]!
  const found = lookup.findChannelIdsBySuffix(channelId, kind, match[2]!, 2)
  if (found.length === 1) return found[0]!
  throw new ShortIdError(
    found.length === 0
      ? `这个频道里找不到${KIND_LABEL[kind]} ${value}。`
      : `${KIND_LABEL[kind]} ${value} 在这个频道里对应不止一个，请用 conversation_history_search 查到完整编号再用。`,
  )
}

/** Argument keys that carry a message, member or asset id. */
const ID_KEYS: ReadonlySet<string> = new Set([
  'assetId',
  'memberId',
  'messageId',
  'logicalMessageId',
  'about',
  'sender',
])

/** Tool arguments with every short id under an id key replaced by its full id; other values are left alone. */
export const resolveShortIdArgs = (args: unknown, channelId: ChannelId, lookup: ShortIdLookup): unknown => {
  const walk = (value: unknown, idKey: boolean): unknown => {
    if (typeof value === 'string') return idKey ? resolveShortId(value, channelId, lookup) : value
    if (Array.isArray(value)) return value.map((item) => walk(item, idKey))
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, ID_KEYS.has(key))]))
  }
  return walk(args, false)
}
