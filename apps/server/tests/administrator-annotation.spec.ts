import { AgentIdSchema, ChannelMemberIdSchema, ConnectionIdSchema, type ChannelMemberId } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import {
  ADMINISTRATOR_ANNOTATION,
  administratorAnnotator,
  administratorNotes,
  type AdministratorAnnotationOptions,
} from '../src/administrator-annotation.js'

const connection = ConnectionIdSchema.parse('con_01M7TJBHYFBCV87J94RS6G89YY')
const agent = AgentIdSchema.parse('agt_01M7TJBCV93C92SF8Q7J817TG2')
const owner = ChannelMemberIdSchema.parse('mbr_01M7TKK3AYDY18MV5E1NTA8Y8G')
const member = ChannelMemberIdSchema.parse('mbr_01M7TKK3AYDY18MV5E1NTA8Y8H')
const users = new Map<ChannelMemberId, string>([
  [owner, '2201358747'],
  [member, '10001'],
])

const options = (admins: ReadonlySet<string>): AdministratorAnnotationOptions => ({
  hasAdministrators: () => admins.size > 0,
  isAdministrator: (connectionId, platformUserId) => connectionId === connection && admins.has(platformUserId),
  connectionOf: () => connection,
  platformUserId: (memberId) => users.get(memberId),
})

describe('administrator annotation', () => {
  it('marks only messages from administrators', () => {
    const admins = options(new Set(['2201358747']))
    expect(administratorAnnotator(admins).covers(agent)).toBe(true)
    expect(administratorNotes(admins, owner)).toEqual([ADMINISTRATOR_ANNOTATION])
    expect(administratorNotes(admins, member)).toEqual([])
    expect(administratorNotes(admins, undefined)).toEqual([])
  })

  it('stays out of the way while there is no administrator', () => {
    expect(administratorAnnotator(options(new Set())).covers(agent)).toBe(false)
  })
})
