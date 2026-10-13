// Live chat-list store fed by TDLib updates (updateNewChat, updateChatLastMessage, updateChatPosition, …).
type Any = Record<string, any>
export type Kind = 'self' | 'bot' | 'private' | 'group' | 'channel'
export type ChatRow = {
  id: number; title: string; kind: Kind; userId?: number; ownedBot: boolean
  order: bigint; pinned: boolean; unread: number; markedUnread: boolean; muted: boolean
  lastText: string; lastOut: boolean; lastDate: number; photoFileId?: number; photoPath?: string
}

export function previewOf(content: Any | undefined): string {
  const t = content?.['@type']
  const cap = (c: Any) => (c?.caption?.text ? ` ${c.caption.text}` : '')
  switch (t) {
    case 'messageText': return content!.text?.text ?? ''
    case 'messagePhoto': return `📷 Photo${cap(content!)}`
    case 'messageVideo': return `🎬 Video${cap(content!)}`
    case 'messageDocument': return `📎 ${content!.document?.file_name ?? 'File'}${cap(content!)}`
    case 'messageVoiceNote': return '🎤 Voice message'
    case 'messageAudio': return `🎵 ${content!.audio?.title ?? 'Audio'}`
    case 'messageSticker': return `${content!.sticker?.emoji ?? ''} Sticker`
    case 'messageAnimation': return `GIF${cap(content!)}`
    case 'messageVideoNote': return '📹 Video message'
    case 'messageLocation': return '📍 Location'
    case 'messageContact': return '👤 Contact'
    case 'messagePoll': return `📊 ${content!.poll?.question?.text ?? 'Poll'}`
    default: return t ? 'Message' : ''
  }
}

export class ChatStore {
  rows = new Map<number, ChatRow>()
  myId = 0
  private bots = new Map<number, boolean>()   // userId -> owned (can_be_edited)
  private listeners = new Set<() => void>()
  private dirty = false
  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  private touch() {
    if (this.dirty) return
    this.dirty = true
    requestAnimationFrame(() => { this.dirty = false; for (const l of this.listeners) l() })
  }
  private kindOf(r: ChatRow): Kind {
    if (r.userId && r.userId === this.myId) return 'self'
    if (r.userId && this.bots.has(r.userId)) return 'bot'
    return r.kind
  }
  private refreshKind(r: ChatRow) {
    r.kind = this.kindOf(r)
    r.ownedBot = !!(r.userId && this.bots.get(r.userId))
    if (r.kind === 'self') r.title = 'Saved Messages'
  }
  private applyPositions(r: ChatRow, positions: Any[] | undefined) {
    for (const p of positions ?? []) {
      if (p.list?.['@type'] !== 'chatListMain') continue
      r.order = BigInt(p.order ?? '0'); r.pinned = !!p.is_pinned
    }
  }
  private applyLast(r: ChatRow, m: Any | undefined) {
    if (!m) return
    r.lastText = previewOf(m.content).replace(/\s+/g, ' ').trim()
    r.lastOut = !!m.is_outgoing; r.lastDate = m.date ?? 0
  }
  handle(u: Any): void {
    switch (u['@type']) {
      case 'updateUser': {
        const t = u.user?.type
        if (t?.['@type'] === 'userTypeBot') this.bots.set(u.user.id, !!t.can_be_edited)
        for (const r of this.rows.values()) if (r.userId === u.user.id) this.refreshKind(r)
        break
      }
      case 'updateNewChat': {
        const c = u.chat; const ty = c.type?.['@type']
        const r: ChatRow = {
          id: c.id, title: c.title ?? '', userId: ty === 'chatTypePrivate' ? c.type.user_id : undefined,
          kind: ty === 'chatTypePrivate' ? 'private' : ty === 'chatTypeSupergroup' && c.type.is_channel ? 'channel' : 'group',
          ownedBot: false, order: 0n, pinned: false, unread: c.unread_count ?? 0, markedUnread: !!c.is_marked_as_unread,
          muted: (c.notification_settings?.mute_for ?? 0) > 0, lastText: '', lastOut: false, lastDate: 0,
          photoFileId: c.photo?.small?.id,
          photoPath: c.photo?.small?.local?.is_downloading_completed ? c.photo.small.local.path : undefined,
        }
        this.applyPositions(r, c.positions); this.applyLast(r, c.last_message); this.refreshKind(r)
        this.rows.set(r.id, r); break
      }
      case 'updateChatTitle': { const r = this.rows.get(u.chat_id); if (r && r.kind !== 'self') r.title = u.title; break }
      case 'updateChatPhoto': {
        const r = this.rows.get(u.chat_id); if (!r) break
        r.photoFileId = u.photo?.small?.id
        r.photoPath = u.photo?.small?.local?.is_downloading_completed ? u.photo.small.local.path : undefined; break
      }
      case 'updateChatLastMessage': {
        const r = this.rows.get(u.chat_id); if (!r) break
        this.applyLast(r, u.last_message); this.applyPositions(r, u.positions); break
      }
      case 'updateChatPosition': { const r = this.rows.get(u.chat_id); if (r) this.applyPositions(r, [u.position]); break }
      case 'updateChatReadInbox': { const r = this.rows.get(u.chat_id); if (r) r.unread = u.unread_count ?? 0; break }
      case 'updateChatIsMarkedAsUnread': { const r = this.rows.get(u.chat_id); if (r) r.markedUnread = !!u.is_marked_as_unread; break }
      case 'updateChatNotificationSettings': {
        const r = this.rows.get(u.chat_id); if (r) r.muted = (u.notification_settings?.mute_for ?? 0) > 0; break
      }
      case 'updateFile': {
        const f = u.file; if (!f?.local?.is_downloading_completed) return
        for (const r of this.rows.values()) if (r.photoFileId === f.id) r.photoPath = f.local.path
        break
      }
      default: return
    }
    this.touch()
  }
  sorted(): ChatRow[] {
    return [...this.rows.values()].filter((r) => r.order > 0n).sort((a, b) => (a.order === b.order ? 0 : a.order > b.order ? -1 : 1))
  }
}
