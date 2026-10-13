import { useEffect, useRef, useState } from 'react'
import { TdClient } from './td'
import { CREDS } from './creds'
import { ftToMarkdown, type FT } from './tdmd'
import { ChatStore, type ChatRow } from './chats'
import { ChatList, Avatar } from './ChatList'
import { mediaOf, fileStateOf, autoDownload, MediaView, type Media, type FileState } from './media'
import { TdJson } from './td'
import { MessageMarkdown } from '@aircrew/components/MessageMarkdown'
import 'katex/dist/katex.min.css'
import '@aircrew/styles.css'   // the Mac app's own stylesheet — one design for both apps
import './app.css'

type Any = Record<string, any>
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
type Msg = { id: number; out: boolean; md: string; author: string; date: number; media?: Media; buttons?: { text: string; data?: string }[][] }
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
    ? (rm.rows as Any[][]).map((row) => row.map((b) => ({ text: b.text, data: b.type?.data }))) : undefined
}
function msgOf(m: Any, chat?: ChatRow): Msg {
  const { media, files } = mediaOf(m.content)
  if (files.length) seedFiles(files)
  return { id: m.id, out: !!m.is_outgoing, md: mdOf(m.content), author: store.authorOf(m, chat), date: m.date ?? 0, media, buttons: buttonsOf(m.reply_markup) }
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
  const msgsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    for (const m of msgs) {
      if (!m.media || requested.current.has(m.media.fileId)) continue
      if (autoDownload(m.media, files[m.media.fileId])) download(m.media.fileId, m.media.kind === 'photo' ? 8 : 4)
    }
  }, [msgs, files])
  // newest message at the bottom, like Telegram: stick to the end when messages change
  useEffect(() => { const el = msgsRef.current; if (el) el.scrollTop = el.scrollHeight }, [msgs])

  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await TdClient.create(); if (!alive) return
      td.current = c
      c.on('update', (u) => {
        store.handle(u as Any)
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
          if (r.files.length) seedFiles(r.files)
          setMsgs((prev) => prev.map((m) => (m.id === x.message_id ? { ...m, md, media: r.media } : m)))
        }
        if (here && x['@type'] === 'updateMessageEdited')
          setMsgs((prev) => prev.map((m) => (m.id === x.message_id ? { ...m, buttons: buttonsOf(x.reply_markup) } : m)))
        if (here && x['@type'] === 'updateDeleteMessages' && x.is_permanent)
          setMsgs((prev) => prev.filter((m) => !(x.message_ids as number[]).includes(m.id)))
        if (x['@type'] === 'updateMessageSendSucceeded' && openRef.current && x.message?.chat_id === openRef.current.id)
        {
          const nm = msgOf(x.message, openRef.current ?? undefined)
          setMsgs((prev) => prev.map((m) => (m.id === x.old_message_id ? nm : m)))
        }
      })
    })().catch((e) => setErr(String(e?.message ?? JSON.stringify(e))))
    return () => { alive = false }
  }, [])
  const openRef = useRef<Chat | null>(null)
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && openRef.current) void reloadHistory(openRef.current) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  useEffect(() => { openRef.current = open }, [open])

  async function onAuth(c: TdClient, s: Any) {
    switch (s['@type']) {
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
    setOpen(ch); setMsgs([])
    await c.invoke({ '@type': 'openChat', chat_id: ch.id })
    await reloadHistory(ch)
  }
  async function reloadHistory(ch: Chat) {
    const c = td.current!
    let all: Any[] = []; let from = 0
    for (let i = 0; i < 3 && all.length < 30; i++) {           // first call often returns 1 msg
      const r = await c.invoke<Any>({ '@type': 'getChatHistory', chat_id: ch.id, from_message_id: from, offset: 0, limit: 30, only_local: false })
      const ms = r.messages as Any[]; if (!ms?.length) break
      all = all.concat(ms); from = ms[ms.length - 1].id
    }
    setMsgs(all.reverse().map((m) => msgOf(m, ch)))
    if (all.length) void c.invoke({ '@type': 'viewMessages', chat_id: ch.id, message_ids: all.map((m) => m.id), force_read: true }).catch(() => undefined)
  }
  function closeOpen() {
    const c = td.current
    if (c && openRef.current) void c.invoke({ '@type': 'closeChat', chat_id: openRef.current.id }).catch(() => undefined)
    setOpen(null)
  }

  async function send() {
    if (!open || !draft.trim()) return
    const text = draft; setDraft('')
    await td.current!.invoke({ '@type': 'sendMessage', chat_id: open.id,
      input_message_content: { '@type': 'inputMessageText', text: { '@type': 'formattedText', text } } })
  }

  async function press(m: Msg, data?: string) {
    if (!open || !data) return
    await td.current!.invoke({ '@type': 'getCallbackQueryAnswer', chat_id: open.id, message_id: m.id,
      payload: { '@type': 'callbackQueryPayloadData', data } }).catch(() => undefined)
  }

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

  const list = <ChatList rows={chats} selected={open?.id} onOpen={(r) => void openChat(r)} />
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
      <div className="conv-scroll" ref={msgsRef}>
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.out ? 'out' : 'in'}`}>
            <div className="bubble">
              <div className="msg-head"><span className="author">{m.author}</span><span className="time">{fmtTime(m.date)}</span></div>
              {m.media && <MediaView media={m.media} f={files[m.media.fileId]} onDownload={() => download(m.media!.fileId)}
                onOpen={(p, mime, apk) => void openFile(p, mime, apk)} onZoom={setZoom} />}
              {m.md && <MessageMarkdown text={m.md} />}
              {m.buttons && <div className="msg-buttons">{m.buttons.map((row, i) => (
                <div key={i} className="msg-btn-row">{row.map((b, j) => (
                  <button key={j} className="msg-btn" onClick={() => void press(m, b.data)}>{b.text}</button>))}</div>))}</div>}
            </div>
          </div>))}
      </div>
      <div className="composer">
        <textarea className="composer-input" rows={1} value={draft} placeholder="Message…"
          onChange={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px` }} />
        <button className="composer-send" disabled={!draft.trim()} onClick={() => void send()} aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
        </button>
      </div>
    </div>) : <div className="conversation empty-pane"><img className="go-logo big" src="/logo.png" alt="" /><div>Pick a chat from your crew</div></div>

  const overlays = <>
    {zoom && <div className="go-zoom" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>}
    {notice && <div className="go-notice" onClick={() => setNotice('')}>{notice}</div>}
  </>
  if (wide) return <><div className={`split${listHidden && open ? ' hidden' : ''}`}>{!(listHidden && open) && list}{conv}</div>{overlays}</>
  return <>{open ? conv : list}{overlays}</>
}
