import type { ChannelMemberId, ConnectionId } from '@nekro-nxt/contracts'
import type { InboundAnnotation } from '@nekro-nxt/channel-runtime'
import type { InboundHostAnnotator } from './extension-inbound-hooks.js'

export const ADMINISTRATOR_ANNOTATION: InboundAnnotation = { label: '管理员', text: '发这条消息的人是管理员。' }

export interface AdministratorAnnotationOptions {
  /** Whether any platform account is an administrator; without one, no message needs the note. */
  readonly hasAdministrators: () => boolean
  readonly isAdministrator: (connectionId: ConnectionId, platformUserId: string) => boolean
  readonly connectionOf: (memberId: ChannelMemberId) => ConnectionId | undefined
  readonly platformUserId: (memberId: ChannelMemberId) => string | undefined
}

/** The notes for one message: the administrator note when its sender is an administrator. */
export const administratorNotes = (
  options: AdministratorAnnotationOptions,
  senderMemberId: ChannelMemberId | undefined,
): readonly InboundAnnotation[] => {
  if (senderMemberId === undefined) return []
  const connectionId = options.connectionOf(senderMemberId)
  const platformUserId = options.platformUserId(senderMemberId)
  return connectionId !== undefined &&
    platformUserId !== undefined &&
    options.isAdministrator(connectionId, platformUserId)
    ? [ADMINISTRATOR_ANNOTATION]
    : []
}

/** Marks messages from NekroNXT administrators, so the agent knows who they are. */
export const administratorAnnotator = (options: AdministratorAnnotationOptions): InboundHostAnnotator => ({
  covers: () => options.hasAdministrators(),
  annotate: ({ event }) => Promise.resolve(administratorNotes(options, event.senderMemberId)),
})
