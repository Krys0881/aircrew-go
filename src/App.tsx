import { useEffect, useRef, useState } from 'react'
import { TdClient } from './td'
import { CREDS } from './creds'
import { ftToMarkdown, type FT } from './tdmd'
import { ChatStore, type ChatRow } from './chats'
import { ChatList, Avatar } from './ChatList'
import { MessageMarkdown } from '@aircrew/components/MessageMarkdown'
import 'katex/dist/katex.min.css'
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
type Msg = { id: number; out: boolean; md: string; buttons?: { text: string; data?: string }[][] }

function msgOf(m: Any): Msg {
  const c = m.content ?? {}
  const md = c['@type'] === 'messageText' ? ftToMarkdown(c.text as FT)
    : c.caption ? ftToMarkdown(c.caption as FT) : `_[${String(c['@type'] ?? '?').replace('message', '')}]_`
  const rm = m.reply_markup
  const buttons = rm?.['@type'] === 'replyMarkupInlineKeyboard'
    ? (rm.rows as Any[][]).map((row) => row.map((b) => ({ text: b.text, data: b.type?.data }))) : undefined
  return { id: m.id, out: !!m.is_outgoing, md, buttons }
}

export default function App() {
  const td = useRef<TdClient | null>(null)
  const [auth, setAuth] = useState<Auth>('loading')
  const [authHint, setAuthHint] = useState('')
  const [input, setInput] = useState('')
  const [err, setErr] = useState('')
  const [chats, setChats] = useState<Chat[]>([])
  const wide = useWide()
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
  // newest message at the bottom, like Telegram: stick to the end when messages change
  useEffect(() => { const el = msgsRef.current; if (el) el.scrollTop = el.scrollHeight }, [msgs])

  useEffect(() => {
    let alive = true
    void (async () => {
      const c = await TdClient.create(); if (!alive) return
      td.current = c
      c.on('update', (u) => {
        store.handle(u as Any)
        if (u['@type'] === 'updateAuthorizationState') void onAuth(c, (u as Any).authorization_state)
        if (u['@type'] === 'updateNewMessage') {
          const m = (u as Any).message
          if (openRef.current && m.chat_id === openRef.current.id) {
            setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, msgOf(m)]))
            void c.invoke({ '@type': 'viewMessages', chat_id: m.chat_id, message_ids: [m.id], force_read: true }).catch(() => undefined)
          }
        }
      })
    })().catch((e) => setErr(String(e?.message ?? JSON.stringify(e))))
    return () => { alive = false }
  }, [])
  const openRef = useRef<Chat | null>(null)
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
    let all: Any[] = []; let from = 0
    for (let i = 0; i < 3 && all.length < 30; i++) {           // first call often returns 1 msg
      const r = await c.invoke<Any>({ '@type': 'getChatHistory', chat_id: ch.id, from_message_id: from, offset: 0, limit: 30, only_local: false })
      const ms = r.messages as Any[]; if (!ms?.length) break
      all = all.concat(ms); from = ms[ms.length - 1].id
    }
    setMsgs(all.reverse().map(msgOf))
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
    <div className="auth">
      <h1 className="authbrand"><img className="logo big" src="/logo.png" alt="" />Aircrew <span className="go">Go</span></h1>
      <p className="hint">{auth === 'loading' ? 'Starting TDLib…' : auth === 'phone' ? 'Your Telegram phone number (+971…)'
        : auth === 'code' ? `Login code (${authHint.replace('authenticationCodeType', '')})`
        : auth === 'password' ? `2FA password${authHint ? ` — hint: ${authHint}` : ''}` : authHint}</p>
      {['phone', 'code', 'password'].includes(auth) && <>
        <input value={input} onChange={(e) => setInput(e.target.value)} type={auth === 'password' ? 'password' : 'text'}
          inputMode={auth === 'password' ? 'text' : 'tel'} autoFocus onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        <button onClick={() => void submit()}>Continue</button></>}
      {err && <p className="err">{err}</p>}
    </div>)

  const list = <ChatList rows={chats} selected={open?.id} onOpen={(r) => void openChat(r)} />
  const conv = open ? (
    <div className="conv">
      <header className="convhead">
        {!wide && <button className="back" onClick={closeOpen}>‹</button>}
        {wide && <button className="paneBtn" onClick={toggleList} title={listHidden ? 'Show chats' : 'Hide chats'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="3" /><line x1="9" y1="4" x2="9" y2="20" />
            {listHidden ? <polyline points="13 10 15 12 13 14" /> : <polyline points="15 10 13 12 15 14" />}
          </svg></button>}
        <Avatar row={open} size={34} />
        <span className="ctitle">{open.title}</span>
      </header>
      <div className="msgs" ref={msgsRef}>
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.out ? 'out' : 'in'}`}>
            <MessageMarkdown text={m.md} />
            {m.buttons?.map((row, i) => <div key={i} className="btnrow">
              {row.map((b, j) => <button key={j} onClick={() => void press(m, b.data)}>{b.text}</button>)}</div>)}
          </div>))}
      </div>
      <footer><input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message"
        onKeyDown={(e) => e.key === 'Enter' && void send()} /><button onClick={() => void send()}>Send</button></footer>
    </div>) : <div className="conv placeholder"><div>Pick a chat</div></div>

  if (wide) return <div className={`split${listHidden && open ? ' hidden' : ''}`}>{!(listHidden && open) && list}{conv}</div>
  return open ? conv : list
}
