import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { TdClient } from './td'
import { CREDS } from './creds'
import { ftToMarkdown, type FT } from './tdmd'
import { ChatStore, type ChatRow } from './chats'
import { ChatList, Avatar } from './ChatList'
import { mediaOf, fileStateOf, autoDownload, MediaView, type Media, type FileState } from './media'
import { TdJson } from './td'
import { diag, diagText } from './diag'
import { isHardwareEnterSend, isPhysicalTypingKey } from './keys'
import { App as CapApp } from '@capacitor/app'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { PaperclipIcon, XIcon } from '@aircrew/components/icons'
import { MessageMarkdown } from '@aircrew/components/MessageMarkdown'
import 'katex/dist/katex.min.css'
import '@aircrew/styles.css'   // the Mac app's own stylesheet — one design for both apps
import './app.css'

type Any = Record<string, any>
const APP_VERSION = '0.5.8'
type Auth = 'loading' | 'phone' | 'code' | 'password' | 'ready' | 'other'
type Chat = ChatRow
const store = new ChatStore()
const wantedPhotos = new Set<number>()
function useWide(): boolean {
  const mq = '(min-width: 720px)'
  const [w, setW] = useState(() => window.matchMedia(mq).matches)
  useEffect(() => { const m = window.matchMedia(mq); const f = () => setW(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  return w
}
type Btn = { text: string; data?: string; insert?: string }   // data = callback · insert = "✏️ Edit" text (0.5.8)
type Msg = { id: number; out: boolean; md: string; plain: string; author: string; date: number; media?: Media; buttons?: Btn[][]
  state?: 'pending' | 'failed'; err?: string     // outgoing delivery state (0.5.3): pending 🕓 · failed ⚠️ + Retry
  replyTo?: number; quote?: string }              // 0.5.8: this message replies to message `replyTo` (same chat)
const sendErrOf = (x: Any | undefined): string => x?.message ?? x?.error_message ?? ''
const fmtTime = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function mdOf(c: Any = {}): string {
  if (c['@type'] === 'messageText') return ftToMarkdown(c.text as FT)
  if (mediaOf(c).media) return c.caption ? ftToMarkdown(c.caption as FT) : ''   // the media itself is rendered
  if (c['@type'] === 'messageSticker') return c.sticker?.emoji ?? ''
  return c.caption ? ftToMarkdown(c.caption as FT) : `_[${String(c['@type'] ?? '?').replace('message', '')}]_`
}
// TDLib file objects seen in messages -> initial download state (shared by all bubbles)
let seedFiles: (files: Any[]) => void = () => {}
function buttonsOf(rm: Any | undefined): Msg['buttons'] {
  return rm?.['@type'] === 'replyMarkupInlineKeyboard'
    ? (rm.rows as Any[][]).map((row) => row.map((b): Btn => {
        const t = b.type ?? {}
        // 0.5.8: "✏️ Edit" is a switch_inline_query_current_chat button (TDLib inlineKeyboardButtonTypeSwitchInline,
        // no callback data) — ≤0.5.7 only knew callback buttons, so tapping it did nothing. It now puts the text in the box.
        if (t['@type'] === 'inlineKeyboardButtonTypeSwitchInline') return { text: b.text, insert: String(t.query ?? '') }
        return { text: b.text, data: t.data }
      })) : undefined
}
const MEDIA_LABEL: Record<string, string> = { photo: '📷 Photo', sticker: 'Sticker', animation: 'GIF', audio: '🎵 Audio', file: '📎 File' }
// one-line preview of a message (reply bar, quotes, long-press menu)
function snippetOf(m: Pick<Msg, 'plain' | 'md' | 'media'>): string {
  const t = (m.plain || m.md).replace(/\s+/g, ' ').trim()
  const label = m.media ? (m.media.kind === 'audio' && m.media.voice ? '🎤 Voice message' : MEDIA_LABEL[m.media.kind] ?? '📎 File') : ''
  const s = t || label || '…'
  return s.length > 90 ? `${s.slice(0, 89)}…` : s
}
function msgOf(m: Any, chat?: ChatRow): Msg {
  const { media, files } = mediaOf(m.content)
  if (files.length) seedFiles(files)
  const ss = m.sending_state
  const st = ss?.['@type'] === 'messageSendingStatePending' ? 'pending' : ss?.['@type'] === 'messageSendingStateFailed' ? 'failed' : undefined
  const rt = m.reply_to?.['@type'] === 'messageReplyToMessage' && (!m.reply_to.chat_id || m.reply_to.chat_id === m.chat_id) ? m.reply_to : undefined
  return { id: m.id, out: !!m.is_outgoing, md: mdOf(m.content), plain: String(m.content?.text?.text ?? m.content?.caption?.text ?? ''),
    author: store.authorOf(m, chat), date: m.date ?? 0, media, buttons: buttonsOf(m.reply_markup),
    state: st, err: st === 'failed' ? sendErrOf(ss.error ?? ss) : undefined,
    replyTo: rt ? Number(rt.message_id) : undefined, quote: rt?.quote?.text?.text || undefined }
}

export default function App() {
  const td = useRef<TdClient | null>(null)
  const [auth, setAuth] = useState<Auth>('loading')
  const [authHint, setAuthHint] = useState('')
  const [input, setInput] = useState('')
  const [err, setErr] = useState('')
  const [chats, setChats] = useState<Chat[]>([])
  const wide = useWide()
  const [files, setFiles] = useState<Record<number, FileState>>({})
  const [zoom, setZoom] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [conn, setConn] = useState('')    // '' = connected; else "Connecting…" etc. (updateConnectionState)
  const connRef = useRef('')
  useEffect(() => { connRef.current = conn }, [conn])
  const hiddenAt = useRef(0)
  const requested = useRef(new Set<number>())
  seedFiles = (fs) => setFiles((prev) => {
    let next = prev
    for (const f of fs) { const st = fileStateOf(f); if (st && !prev[st.id]) next = { ...next, [st.id]: st } }
    return next
  })
  function download(fileId: number, priority = 32) {
    const c = td.current; if (!c) return
    requested.current.add(fileId)
    setFiles((prev) => ({ ...prev, [fileId]: { ...(prev[fileId] ?? { id: fileId, size: 0, got: 0, done: false }), busy: true } }))
    void c.invoke<Any>({ '@type': 'downloadFile', file_id: fileId, priority, offset: 0, limit: 0, synchronous: false })
      .then((f) => { const st = fileStateOf(f); if (st) setFiles((prev) => ({ ...prev, [st.id]: { ...st, busy: !st.done } })) })
      .catch(() => setFiles((prev) => ({ ...prev, [fileId]: { ...(prev[fileId] as FileState), busy: false } })))
  }
  async function openFile(path: string, mime: string, apk: boolean) {
    try {
      const r = await TdJson.openFile({ path, mime })
      if (r?.needsPermission) setNotice(apk ? 'Allow “Install unknown apps” for Aircrew Go, then tap the file again.' : 'Permission needed — tap again after allowing it.')
    } catch (e) { setNotice((e as Any)?.message ?? 'Cannot open this file') }
  }
  const [listHidden, setListHidden] = useState(() => localStorage.getItem('ago.listHidden') === '1')
  const toggleList = () => setListHidden((h) => { localStorage.setItem('ago.listHidden', h ? '0' : '1'); return !h })
  useEffect(() => store.onChange(() => {
    setChats(store.sorted())
    const c = td.current; if (!c) return
    for (const r of store.rows.values()) {           // fetch avatars lazily, once each
      if (r.photoFileId && !r.photoPath && !wantedPhotos.has(r.photoFileId)) {
        wantedPhotos.add(r.photoFileId)
        void c.invoke({ '@type': 'downloadFile', file_id: r.photoFileId, priority: 1, offset: 0, limit: 0, synchronous: false }).catch(() => undefined)
      }
    }
  }), [])
  const [open, setOpen] = useState<Chat | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  type Outgoing = { path: string; name: string; mime: string; size: number; thumb?: string }
  const [attach, setAttach] = useState<Outgoing | null>(null)
  const [sending, setSending] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  // 0.5.7 (Chris, Bluetooth keyboard: "focus on the chat"): with a hardware keyboard connected, keep the message box
  // focused — opening a chat, after sending/attaching, back in the app — so he can just type. Without one, nothing
  // changes (auto-focus would pop up the on-screen keyboard). Connection state comes from Android (TdJson.keyboard).
  const composer = useRef<HTMLTextAreaElement | null>(null)
  const [hwKbd, setHwKbd] = useState(false)
  const hwKbdRef = useRef(false)
  function focusComposer(why: string) {
    const el = composer.current
    if (!hwKbdRef.current || !el || document.activeElement === el) return
    el.focus({ preventScroll: true })
    diag(`focus: message box (${why})`)
  }
  // 0.5.8: put text in the message box and focus it on purpose (opens the on-screen keyboard: the user wants to type).
  function fillComposer(text: string | null, why: string) {
    if (text !== null) setDraft(text)
    window.setTimeout(() => {                       // after React has rendered the new value
      const el = composer.current; if (!el) return
      el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`
      el.focus({ preventScroll: true }); const n = el.value.length; el.setSelectionRange(n, n)
      diag(`focus: message box (${why})`)
    }, 0)
  }
  // 0.5.8 Reply: long-press (or right-click) a message -> menu (Reply · Copy text) -> reply bar above the box -> the
  // next message is sent as a reply (sendMessage.reply_to = inputMessageReplyToMessage). Replies show a quote on top.
  const [replyTo, setReplyTo] = useState<Msg | null>(null)
  const [menu, setMenu] = useState<Msg | null>(null)
  const [flash, setFlash] = useState(0)
  const [replied, setReplied] = useState<Record<number, { author: string; text: string }>>({})   // quoted msgs not in view
  const repliedAsked = useRef(new Set<number>())
  const pressT = useRef<number | null>(null)
  const pressXY = useRef({ x: 0, y: 0 })
  function openMenu(m: Msg) { endPress(); window.getSelection()?.removeAllRanges(); setMenu(m); diag(`menu: message ${m.id}`) }
  function startPress(e: RPointerEvent, m: Msg) {
    if (e.pointerType === 'mouse') return            // mouse: right-click (contextmenu) opens the menu
    endPress(); pressXY.current = { x: e.clientX, y: e.clientY }
    pressT.current = window.setTimeout(() => { pressT.current = null; openMenu(m) }, 450)
  }
  function movePress(e: RPointerEvent) {
    if (pressT.current && (Math.abs(e.clientX - pressXY.current.x) > 10 || Math.abs(e.clientY - pressXY.current.y) > 10)) endPress()
  }
  function endPress() { if (pressT.current) { window.clearTimeout(pressT.current); pressT.current = null } }
  function startReply(m: Msg) { setMenu(null); setReplyTo(m); diag(`reply: to message ${m.id}`); fillComposer(null, 'reply') }
  async function copyText(m: Msg) {
    const t = m.plain || m.md
    setMenu(null)
    try { await navigator.clipboard.writeText(t) } catch {
      const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); ta.remove()
    }
    setNotice('Copied.'); window.setTimeout(() => setNotice((n) => (n === 'Copied.' ? '' : n)), 1500)
  }
  function jumpTo(id: number) {
    const el = document.getElementById(`msg-${id}`); if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id); window.setTimeout(() => setFlash((f) => (f === id ? 0 : f)), 1300)
  }
  async function pickFile(file: File | undefined) {
    if (!file) return
    try {
      setNotice('')
      const b64 = await new Promise<string>((res, rej) => {
        const r = new FileReader(); r.onerror = () => rej(r.error); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(file)
      })
      const safe = file.name.replace(/[^\w.\- ]+/g, '_') || 'file'
      const w = await Filesystem.writeFile({ path: `outgoing/${Date.now()}_${safe}`, data: b64, directory: Directory.Cache, recursive: true })
      const thumb = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      setAttach({ path: decodeURIComponent(w.uri.replace(/^file:\/\//, '')), name: file.name, mime: file.type || 'application/octet-stream', size: file.size, thumb })
      focusComposer('attached')
    } catch (e) { setNotice(`Couldn't attach this file: ${(e as Any)?.message ?? e}`) }
  }
  const msgsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    for (const m of msgs) {
      if (!m.media || requested.current.has(m.media.fileId)) continue
      if (autoDownload(m.media, files[m.media.fileId])) download(m.media.fileId, m.media.kind === 'photo' ? 8 : 4)
    }
  }, [msgs, files])
  // newest message at the bottom, like Telegram: stick to the end when messages change
  useEffect(() => { const el = msgsRef.current; if (el) el.scrollTop = el.scrollHeight }, [msgs])
  // quotes: a reply to a message that isn't loaded (older history) -> ask TDLib for it once
  useEffect(() => {
    const c = td.current; const ch = open; if (!c || !ch) return
    const have = new Set(msgs.map((x) => x.id))
    for (const m of msgs) {
      const target = m.replyTo
      if (target === undefined || have.has(target) || repliedAsked.current.has(target)) continue
      repliedAsked.current.add(target)
      void c.invoke<Any>({ '@type': 'getRepliedMessage', chat_id: ch.id, message_id: m.id }).then((r) => {
        const x = msgOf(r, ch); setReplied((p) => ({ ...p, [target]: { author: x.author, text: snippetOf(x) } }))
      }).catch(() => undefined)
    }
  }, [msgs, open?.id])

  useEffect(() => {
    let alive = true
    void (async () => {
      diag(`app: start Aircrew Go ${APP_VERSION}`)
      const c = await TdClient.create(); if (!alive) return
      td.current = c
      c.on('update', (u) => {
        store.handle(u as Any)
        if (u['@type'] === 'updateConnectionState') {
          const t = String((u as Any).state?.['@type'] ?? '')
          diag(`conn: ${t.replace('connectionState', '')}`)
          setConn(t === 'connectionStateReady' ? '' : t === 'connectionStateWaitingForNetwork' ? 'Waiting for network…'
            : t === 'connectionStateUpdating' ? 'Updating…' : 'Connecting…')
        }
        if (u['@type'] === 'updateFile') {
          const st = fileStateOf((u as Any).file)
          if (st) setFiles((prev) => (prev[st.id] || requested.current.has(st.id) ? { ...prev, [st.id]: { ...st, busy: !st.done } } : prev))
        }
        if (u['@type'] === 'updateAuthorizationState') void onAuth(c, (u as Any).authorization_state)
        if (u['@type'] === 'updateNewMessage') {
          const m = (u as Any).message
          if (openRef.current && m.chat_id === openRef.current.id) {
            const nm = msgOf(m, openRef.current ?? undefined)
            setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, nm]))
            void c.invoke({ '@type': 'viewMessages', chat_id: m.chat_id, message_ids: [m.id], force_read: true }).catch(() => undefined)
          }
        }
        // Agents STREAM: the bot sends "⏳ working…" and then EDITS that message until the final answer —
        // without these handlers Go kept showing the placeholder (Chris, 2026-10-13).
        const x = u as Any
        const here = openRef.current && x.chat_id === openRef.current.id
        if (here && x['@type'] === 'updateMessageContent') {
          const md = mdOf(x.new_content); const r = mediaOf(x.new_content)
          const plain = String(x.new_content?.text?.text ?? x.new_content?.caption?.text ?? '')
          if (r.files.length) seedFiles(r.files)
          setMsgs((prev) => prev.map((m) => (m.id === x.message_id ? { ...m, md, plain, media: r.media } : m)))
        }
        if (here && x['@type'] === 'updateMessageEdited')
          setMsgs((prev) => prev.map((m) => (m.id === x.message_id ? { ...m, buttons: buttonsOf(x.reply_markup) } : m)))
        if (here && x['@type'] === 'updateDeleteMessages' && x.is_permanent)
          setMsgs((prev) => prev.filter((m) => !(x.message_ids as number[]).includes(m.id)))
        if (x['@type'] === 'updateMessageSendSucceeded') diag(`send: delivered chat=${x.message?.chat_id} id=${x.message?.id}`)
        if (x['@type'] === 'updateMessageSendSucceeded' && openRef.current && x.message?.chat_id === openRef.current.id)
        {
          const nm = msgOf(x.message, openRef.current ?? undefined)
          setMsgs((prev) => prev.map((m) => (m.id === x.old_message_id ? nm : m)))
        }
        // 0.5.2 ignored this: a message Telegram refused still LOOKED sent.
        if (x['@type'] === 'updateMessageSendFailed') {
          const e = sendErrOf(x.error ?? x)
          diag(`send: FAILED chat=${x.message?.chat_id} code=${x.error?.code ?? x.error_code ?? '?'} ${e}`)
          if (openRef.current && x.message?.chat_id === openRef.current.id) {
            const nm = { ...msgOf(x.message, openRef.current ?? undefined), state: 'failed' as const, err: e }
            setMsgs((prev) => prev.map((m) => (m.id === x.old_message_id ? nm : m)))
          }
        }
      })
      // A reused TDLib client (JS restarted, process kept) won't repeat its auth update — ask for the state.
      if (c.reused) void c.invoke<Any>({ '@type': 'getAuthorizationState' }, 10000).then((st) => onAuth(c, st))
        .catch((e) => diag(`auth: getAuthorizationState failed: ${(e as Any)?.message ?? e}`))
    })().catch((e) => setErr(String(e?.message ?? JSON.stringify(e))))
    return () => { alive = false }
  }, [])
  const openRef = useRef<Chat | null>(null)
  useEffect(() => {
    const onVis = () => {
      diag(`app: ${document.visibilityState}`)
      if (document.visibilityState !== 'visible') { hiddenAt.current = Date.now(); return }
      // 0.5.4 (Chris: "Connecting…" for a while after EVERY app switch, on his Samsung): Android cuts a backgrounded
      // app's connection. Stock Android: TDLib is back in ~2 s on its own (measured on the emulator) — and an
      // immediate setNetworkType there made it SLOWER (interrupts a reconnect in flight). Samsung: background network
      // stays blocked while the app lives, TDLib's retry backoff grows, and the next retry can be far away.
      // Measured (emulator, 26 switches): TDLib reconnects by itself in ~1.8 s, but ~1/3 of the time it gets stuck;
      // a nudge lands ~1.3 s later. A nudge BEFORE ~2.5 s restarts a healthy reconnect (median 4.3 s). So: leave it
      // alone; if still not connected after 3 s, force a reopen; then every 4 s, max 3 times.
      const away = hiddenAt.current ? Math.round((Date.now() - hiddenAt.current) / 1000) : 0
      let tries = 0
      const rescue = () => {
        if (!connRef.current || document.visibilityState !== 'visible' || tries >= 3) return
        tries++
        void nudgeNetwork(`resume after ${away} s away: still "${connRef.current}" (try ${tries})`)
        window.setTimeout(rescue, 4000)
      }
      window.setTimeout(rescue, 3000)
      void healthCheck()
      if (openRef.current) void reloadHistory(openRef.current, true)
      window.setTimeout(() => focusComposer('back in app'), 300)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => {
    const set = (on: boolean, why: string) => {
      if (on !== hwKbdRef.current) diag(`kbd: hardware keyboard ${on ? 'connected' : 'disconnected'} (${why})`)
      hwKbdRef.current = on; setHwKbd(on)
    }
    TdJson.keyboard().then((r) => set(!!r.hardware, 'start')).catch(() => undefined)
    const h = TdJson.addListener('keyboard', (e) => set(!!e.hardware, 'Android'))
    // Typing that starts outside the message box (after tapping a message, a button…) goes into it. A physical key
    // also proves a keyboard is there, in case Android didn't report it.
    const onKey = (e: KeyboardEvent) => {
      if (!isPhysicalTypingKey(e)) return
      if (!hwKbdRef.current) set(true, 'key pressed')
      const t = e.target as HTMLElement | null
      if (!openRef.current || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return
      focusComposer('typing')                         // no preventDefault: the key itself lands in the box
    }
    document.addEventListener('keydown', onKey, true)
    return () => { void h.then((x) => x.remove()); document.removeEventListener('keydown', onKey, true) }
  }, [])
  useEffect(() => { if (open) focusComposer('chat opened') }, [open?.id, hwKbd])

  async function onAuth(c: TdClient, s: Any) {
    diag(`auth: ${String(s['@type']).replace('authorizationState', '')}`)
    switch (s['@type']) {
      case 'authorizationStateClosed':     // client is gone for good — start a fresh one on the next page load
        void TdJson.create({ fresh: true }).then(() => location.reload()); break
      case 'authorizationStateWaitTdlibParameters':
        await c.invoke({
          '@type': 'setTdlibParameters', use_test_dc: false,
          database_directory: `${c.filesDir}/tdlib`, files_directory: `${c.filesDir}/tdfiles`,
          database_encryption_key: '', use_file_database: true, use_chat_info_database: true,
          use_message_database: true, use_secret_chats: false,
          api_id: CREDS.apiId, api_hash: CREDS.apiHash,
          system_language_code: 'en', device_model: 'Aircrew Go (Android)', system_version: '',
          application_version: '0.1.0-spike',
        }); break
      case 'authorizationStateWaitPhoneNumber': setAuth('phone'); break
      case 'authorizationStateWaitCode': setAuth('code'); setAuthHint(s.code_info?.type?.['@type'] ?? ''); break
      case 'authorizationStateWaitPassword': setAuth('password'); setAuthHint(s.password_hint ?? ''); break
      case 'authorizationStateReady': setAuth('ready'); void loadChats(c); break
      default: setAuth('other'); setAuthHint(s['@type'])
    }
  }

  async function submit() {
    const c = td.current; if (!c) return
    setErr('')
    try {
      if (auth === 'phone') await c.invoke({ '@type': 'setAuthenticationPhoneNumber', phone_number: input.trim() })
      if (auth === 'code') await c.invoke({ '@type': 'checkAuthenticationCode', code: input.trim() })
      if (auth === 'password') await c.invoke({ '@type': 'checkAuthenticationPassword', password: input })
      setInput('')
    } catch (e) { setErr((e as Any).message ?? JSON.stringify(e)) }
  }

  async function loadChats(c: TdClient) {
    const me = await c.invoke<Any>({ '@type': 'getMe' }).catch(() => null)
    if (me) store.myId = me.id
    if (c.reused) {
      // The previous page already loaded the chat list, so TDLib won't stream updateNewChat again: rebuild it.
      const r = await c.invoke<Any>({ '@type': 'getChats', chat_list: { '@type': 'chatListMain' }, limit: 500 }).catch(() => null)
      const ids = (r?.chat_ids ?? []) as number[]
      for (const id of ids) {
        const chat = await c.invoke<Any>({ '@type': 'getChat', chat_id: id }).catch(() => null); if (!chat) continue
        if (chat.type?.['@type'] === 'chatTypePrivate') {
          const u = await c.invoke<Any>({ '@type': 'getUser', user_id: chat.type.user_id }).catch(() => null)
          if (u) store.handle({ '@type': 'updateUser', user: u })
        }
        store.handle({ '@type': 'updateNewChat', chat })
      }
      diag(`chats: rebuilt ${ids.length} from the reused client`)
    }
    // TDLib streams updateNewChat for every chat it loads; loadChats returns 404 once all are in.
    for (let i = 0; i < 6; i++) {
      const ok = await c.invoke({ '@type': 'loadChats', chat_list: { '@type': 'chatListMain' }, limit: 100 }).then(() => true).catch(() => false)
      if (!ok) break
    }
    setChats(store.sorted())
  }

  async function openChat(ch: Chat) {
    const c = td.current!
    if (openRef.current && openRef.current.id !== ch.id) void c.invoke({ '@type': 'closeChat', chat_id: openRef.current.id }).catch(() => undefined)
    if (openRef.current?.id !== ch.id) { setReplyTo(null); setMenu(null); setReplied({}); repliedAsked.current.clear() }
    setOpen(ch); setMsgs([])
    await c.invoke({ '@type': 'openChat', chat_id: ch.id })
    await reloadHistory(ch)
  }
  async function reloadHistory(ch: Chat, merge = false) {
    const c = td.current!
    let all: Any[] = []; let from = 0
    for (let i = 0; i < 3 && all.length < 30; i++) {           // first call often returns 1 msg
      const r = await c.invoke<Any>({ '@type': 'getChatHistory', chat_id: ch.id, from_message_id: from, offset: 0, limit: 30, only_local: false })
      const ms = r.messages as Any[]; if (!ms?.length) break
      all = all.concat(ms); from = ms[ms.length - 1].id
    }
    if (openRef.current?.id !== ch.id) return          // user switched chats meanwhile
    const fetched = all.reverse().map((m) => msgOf(m, ch))
    // On resume, MERGE: a message sent while this reload was in flight must not vanish from view (0.5.2 overwrote).
    setMsgs((prev) => {
      if (!merge || !prev.length) return fetched
      const ids = new Set(fetched.map((m) => m.id)); const newest = fetched.length ? fetched[fetched.length - 1].date : 0
      const extra = prev.filter((m) => !ids.has(m.id) && m.date >= newest)
      return [...fetched, ...extra].sort((a, b) => a.date - b.date || a.id - b.id)
    })
    if (all.length) void c.invoke({ '@type': 'viewMessages', chat_id: ch.id, message_ids: all.map((m) => m.id), force_read: true }).catch(() => undefined)
  }
  function closeOpen() {
    const c = td.current
    if (c && openRef.current) void c.invoke({ '@type': 'closeChat', chat_id: openRef.current.id }).catch(() => undefined)
    setOpen(null); setReplyTo(null); setMenu(null)
  }

  // Resume self-heal: if TDLib doesn't answer a trivial request, the page lost its bridge — reload re-attaches
  // to the SAME TDLib client (native keeps it) instead of leaving a deaf UI.
  // TDLib: "setNetworkType … forces all network connections to reopen … must be called whenever the network is
  // changed, even if the network type remains the same" — the official clients do this; Go never did (≤0.5.3).
  async function nudgeNetwork(reason: string) {
    const c = td.current; if (!c) return
    const nt = String((navigator as Any).connection?.type ?? '')
    const type = !navigator.onLine || nt === 'none' ? 'networkTypeNone' : nt === 'wifi' ? 'networkTypeWiFi'
      : nt === 'cellular' ? 'networkTypeMobile' : 'networkTypeOther'
    diag(`net: setNetworkType ${type.replace('networkType', '')} (${reason})`)
    await c.invoke({ '@type': 'setNetworkType', type: { '@type': type } }, 5000)
      .catch((e) => diag(`net: setNetworkType failed: ${(e as Any)?.message ?? e}`))
  }

  async function healthCheck() {
    const c = td.current; if (!c) return
    try { await c.invoke({ '@type': 'getOption', name: 'version' }, 6000) }
    catch { diag('health: TDLib not answering on resume -> reloading the page'); location.reload() }
  }

  async function send() {
    if (!open || (!draft.trim() && !attach)) return
    const text = draft
    const caption = { '@type': 'formattedText', text }
    let content: Any
    if (attach) {
      // TDLib (built 2026-10) wraps the file: inputMessagePhoto.photo = inputPhoto, inputMessageDocument.document = inputDocument.
      // Passing the bare inputFileLocal there leaves the file null -> "InputFile is not specified" (0.5.6 fix).
      const local = { '@type': 'inputFileLocal', path: attach.path }
      content = /^image\/(jpeg|png|webp)$/.test(attach.mime)
        ? { '@type': 'inputMessagePhoto', caption, show_caption_above_media: false, has_spoiler: false,
            photo: { '@type': 'inputPhoto', photo: local, added_sticker_file_ids: [], width: 0, height: 0 } }
        : { '@type': 'inputMessageDocument', caption,
            document: { '@type': 'inputDocument', document: local, disable_content_type_detection: false } }
    } else {
      content = { '@type': 'inputMessageText', text: caption }
    }
    setSending(true)
    const rt = replyTo && !replyTo.state ? replyTo.id : 0
    diag(`send: chat=${open.id} ${content['@type']} chars=${text.length}${attach ? ` file=${attach.size}B` : ''}${rt ? ` reply=${rt}` : ''}`)
    try {
      // sendMessage answers at once with the queued message (Telegram delivery is async) — 15 s means the app is stuck.
      const r = await td.current!.invoke<Any>({ '@type': 'sendMessage', chat_id: open.id, input_message_content: content,
        ...(rt ? { reply_to: { '@type': 'inputMessageReplyToMessage', message_id: rt } } : {}) }, 15000)
      diag(`send: queued id=${r?.id} ${String(r?.sending_state?.['@type'] ?? '').replace('messageSendingState', '')}`)
      setDraft(''); setAttach(null); setReplyTo(null)
      focusComposer('sent')
    } catch (e) {
      const m = (e as Any)?.message ?? 'error'
      diag(`send: ERROR ${m}`)
      setNotice(`Not sent: ${m}. Your text is still in the box — tap Send to try again.`)
    }
    finally { setSending(false) }
  }

  async function resend(m: Msg) {
    if (!open) return
    diag(`send: retry id=${m.id}`)
    try {
      const r = await td.current!.invoke<Any>({ '@type': 'resendMessages', chat_id: open.id, message_ids: [m.id] }, 15000)
      const nm = (r?.messages as Any[] | undefined)?.find(Boolean)
      if (nm) setMsgs((prev) => prev.map((x) => (x.id === m.id ? msgOf(nm, open) : x)))
    } catch (e) {
      const em = (e as Any)?.message ?? 'error'
      diag(`send: retry ERROR ${em}`)
      setNotice(`Couldn't resend: ${em}`)
    }
  }

  // "Send log to Ada": the diagnostics ring (events only, no message text) as a .txt into Ada's chat.
  async function sendDiag() {
    const c = td.current; if (!c) return
    const ada = [...store.rows.values()].find((r) => r.kind === 'bot' && /^ada\b/i.test(r.title))
    if (!ada) { setNotice("Couldn't find Ada's chat."); return }
    try {
      const head = [`Aircrew Go ${APP_VERSION} diagnostics`, `client ${c.id}${c.reused ? ' (reused)' : ''} · connection: ${conn || 'ready'}`,
        `UA: ${navigator.userAgent}`, `sent: ${new Date().toISOString()}`, '---'].join('\n')
      const w = await Filesystem.writeFile({ path: `diag/aircrew-go-diag-${Date.now()}.txt`, data: `${head}\n${diagText()}\n`,
        directory: Directory.Cache, recursive: true, encoding: Encoding.UTF8 })
      const path = decodeURIComponent(w.uri.replace(/^file:\/\//, ''))
      await c.invoke({ '@type': 'sendMessage', chat_id: ada.id, input_message_content: { '@type': 'inputMessageDocument',
        document: { '@type': 'inputDocument', document: { '@type': 'inputFileLocal', path }, disable_content_type_detection: true },
        caption: { '@type': 'formattedText', text: `Aircrew Go ${APP_VERSION} diagnostics` } } }, 15000)
      diag('diag: sent to Ada')
      setNotice('Diagnostics sent to Ada.')
    } catch (e) { setNotice(`Couldn't send diagnostics: ${(e as Any)?.message ?? e}`) }
  }

  async function press(m: Msg, b: Btn) {
    if (!open) return
    if (b.insert !== undefined) {                    // "✏️ Edit": the suggestion goes into the box, ready to change and send
      diag(`button: "${b.text}" -> message box (${b.insert.length} chars)`)
      fillComposer(b.insert, 'edit suggestion'); return
    }
    if (!b.data) return
    await td.current!.invoke({ '@type': 'getCallbackQueryAnswer', chat_id: open.id, message_id: m.id,
      payload: { '@type': 'callbackQueryPayloadData', data: b.data } }).catch(() => undefined)
  }

  // Android back = Go's own navigation (Capacitor would otherwise exit the app):
  // photo viewer / notice -> chat -> list -> background (minimize, never kill: TDLib stays connected).
  const backRef = useRef<() => void>(() => {})
  backRef.current = () => {
    if (zoom) return setZoom(null)
    if (notice) return setNotice('')
    if (menu) return setMenu(null)
    if (replyTo) return setReplyTo(null)
    if (open) {
      if (wide && listHidden) return toggleList()       // unfolded + list hidden: first bring the list back
      return closeOpen()
    }
    void CapApp.minimizeApp()
  }
  useEffect(() => {
    const h = CapApp.addListener('backButton', () => backRef.current())
    return () => { void h.then((x) => x.remove()) }
  }, [])

  if (auth !== 'ready') return (
    <div className="go-auth">
      <div className="go-auth-brand"><img className="go-logo big" src="/logo.png" alt="" /><div className="go-brand">Aircrew <span className="go-word">Go</span></div></div>
      <p className="go-hint">{auth === 'loading' ? 'Starting TDLib…' : auth === 'phone' ? 'Your Telegram phone number (+971…)'
        : auth === 'code' ? `Login code (${authHint.replace('authenticationCodeType', '')})`
        : auth === 'password' ? `2FA password${authHint ? ` — hint: ${authHint}` : ''}` : authHint}</p>
      {['phone', 'code', 'password'].includes(auth) && <>
        <input className="search" value={input} onChange={(e) => setInput(e.target.value)} type={auth === 'password' ? 'password' : 'text'}
          inputMode={auth === 'password' ? 'text' : 'tel'} autoFocus onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        <button className="composer-send go-wide-btn" onClick={() => void submit()}>Continue</button></>}
      {err && <p className="go-err">{err}</p>}
    </div>)

  const connBar = conn ? <div className="go-conn">{conn}</div> : null
  const list = <ChatList rows={chats} selected={open?.id} onOpen={(r) => void openChat(r)} onDiag={() => void sendDiag()} banner={connBar} />
  const conv = open ? (
    <div className="conversation go-conv">
      <div className="conv-head">
        {!wide && <button className="go-icon-btn" onClick={closeOpen} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg></button>}
        {wide && <button className="go-icon-btn" onClick={toggleList} title={listHidden ? 'Show chats' : 'Hide chats'}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="3" /><line x1="9" y1="4" x2="9" y2="20" />
            {listHidden ? <polyline points="13 10 15 12 13 14" /> : <polyline points="15 10 13 12 15 14" />}
          </svg></button>}
        <Avatar row={open} size={28} />
        <span className="conv-title">{open.title}</span>
      </div>
      {connBar}
      <div className="conv-scroll" ref={msgsRef}>
        {msgs.map((m) => {
          const q = m.replyTo === undefined ? undefined : (() => {
            const t = msgs.find((x) => x.id === m.replyTo)
            const r = t ? { author: t.author, text: snippetOf(t) } : replied[m.replyTo]
            return { author: r?.author ?? 'Reply', text: m.quote || r?.text || '…' }
          })()
          return (
          <div key={m.id} id={`msg-${m.id}`} className={`msg ${m.out ? 'out' : 'in'}${flash === m.id ? ' go-flash' : ''}`}
            onContextMenu={(e) => { e.preventDefault(); openMenu(m) }}
            onPointerDown={(e) => startPress(e, m)} onPointerMove={movePress} onPointerUp={endPress} onPointerCancel={endPress}>
            <div className="bubble">
              <div className="msg-head"><span className="author">{m.author}</span><span className="time">{fmtTime(m.date)}</span>
                {m.out && <span className={`go-st${m.state ? ` ${m.state}` : ''}`} title={m.state ?? 'sent'}>{m.state === 'pending' ? '🕓' : m.state === 'failed' ? '⚠️' : '✓'}</span>}</div>
              {q && <div className="go-quote" onClick={() => jumpTo(m.replyTo!)}>
                <span className="go-quote-who">{q.author}</span><span className="go-quote-text">{q.text}</span></div>}
              {m.media && <MediaView media={m.media} f={files[m.media.fileId]} onDownload={() => download(m.media!.fileId)}
                onOpen={(p, mime, apk) => void openFile(p, mime, apk)} onZoom={setZoom} />}
              {m.md && <MessageMarkdown text={m.md} />}
              {m.state === 'failed' && <div className="go-failed">Not sent{m.err ? ` — ${m.err}` : ''}
                <button className="go-retry" onClick={() => void resend(m)}>Retry</button></div>}
              {m.buttons && <div className="msg-buttons">{m.buttons.map((row, i) => (
                <div key={i} className="msg-btn-row">{row.map((b, j) => (
                  <button key={j} className="msg-btn" onClick={() => void press(m, b)}>{b.text}</button>))}</div>))}</div>}
            </div>
          </div>)})}
      </div>
      {replyTo && <div className="go-replybar">
        <div className="go-replybar-body" onClick={() => jumpTo(replyTo.id)}>
          <span className="go-quote-who">↩ {replyTo.author}</span><span className="go-quote-text">{snippetOf(replyTo)}</span></div>
        <button className="attach-chip-x" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><XIcon size={14} /></button>
      </div>}
      {attach && <div className="attach-tray"><div className="attach-chip">
        {attach.thumb ? <img className="attach-chip-thumb" src={attach.thumb} alt="" /> : <span className="attach-chip-ico">📎</span>}
        <span className="attach-chip-name">{attach.name}</span>
        <button className="attach-chip-x" onClick={() => setAttach(null)} aria-label="Remove"><XIcon size={14} /></button>
      </div></div>}
      <div className="composer">
        <button className="composer-attach" onClick={() => fileInput.current?.click()} aria-label="Attach"><PaperclipIcon size={18} /></button>
        <input ref={fileInput} type="file" hidden onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = '' }} />
        <textarea ref={composer} className="composer-input" rows={1} value={draft} placeholder={attach ? "Add a caption…" : "Message…"}
          onChange={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px` }}
          onKeyDown={(e) => {
            // 0.5.5: hardware (Bluetooth) keyboard Enter = send, Shift+Enter = new line; on-screen Enter stays a new line
            if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReplyTo(null); return }   // 0.5.8: Esc cancels the reply
            if (e.key === 'Enter') diag(`key: Enter code=${e.code || '-'} shift=${e.shiftKey ? 1 : 0}`)
            if (isHardwareEnterSend({ key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey,
              metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); if (!sending) void send() }
          }} />
        <button className="composer-send" disabled={sending || (!draft.trim() && !attach)} onClick={() => void send()} aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
        </button>
      </div>
    </div>) : <div className="conversation empty-pane"><img className="go-logo big" src="/logo.png" alt="" /><div>Pick a chat from your crew</div></div>

  const overlays = <>
    {zoom && <div className="go-zoom" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>}
    {notice && <div className="go-notice" onClick={() => setNotice('')}>{notice}</div>}
    {menu && <div className="go-sheet-bg" onClick={() => setMenu(null)}>
      <div className="go-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="go-sheet-preview"><span className="go-quote-who">{menu.author}</span><span className="go-quote-text">{snippetOf(menu)}</span></div>
        {!menu.state && <button className="go-sheet-btn" onClick={() => startReply(menu)}>↩&nbsp; Reply</button>}
        {(menu.plain || menu.md) && <button className="go-sheet-btn" onClick={() => void copyText(menu)}>⧉&nbsp; Copy text</button>}
        <button className="go-sheet-btn muted" onClick={() => setMenu(null)}>Cancel</button>
      </div></div>}
  </>
  if (wide) return <><div className={`split${listHidden && open ? ' hidden' : ''}`}>{!(listHidden && open) && list}{conv}</div>{overlays}</>
  return <>{open ? conv : list}{overlays}</>
}
