import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CallLine, CallMood, CallState, PastCall } from '../../shared/types'
import type { CallBridge } from '../../preload/call'
import { Icon } from './components/Icon'
import './styles/call.css'

declare global {
  interface Window {
    callBridge: CallBridge
  }
}

const bridge = window.callBridge

type Entry = { who: 'you' | 'her'; zh: string; say?: string; at: number; key: string }
type Row = { kind: 'line'; entry: Entry } | { kind: 'time' | 'end'; text: string; key: string }

const MOODS: { id: CallMood; label: string }[] = [
  { id: 'chat', label: '想聊天' },
  { id: 'normal', label: '普通' },
  { id: 'quiet', label: '请勿打扰' }
]

/** Without a voice, a subtitle stays up about as long as the line would take to say. */
const readingTime = (zh: string) => Math.max(1600, zh.length * 220)

const FADE_AFTER = 5000
// Your line waits this long for an answer that may never come.
const ANSWER_WAIT = 20000
const COLLAPSE_AFTER_SEND = 6000
const DRAG_FROM = 4
// Inside a call, a time only shows after a silence this long.
const TIME_GAP = 5 * 60_000
// How far up the record has to be scrolled for the avatar to make room, and how close to the end to come back.
const LEAVE_BOTTOM = 24
const AT_BOTTOM = 4
// A window shorter than this has no room for the large header at all.
const TALL_ENOUGH = 620

/** Two soft notes up when connecting, down when hanging up; generated, so there is no sound file to ship. */
function tone(notes: number[]): void {
  const ctx = new AudioContext()
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const at = ctx.currentTime + i * 0.13
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.08, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.24)
  })
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { minutes: `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}`, seconds: `:${pad(s % 60)}` }
}

const pad = (n: number) => String(n).padStart(2, '0')

const stamp = (ms: number) => {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (days === 0) return time
  if (days === 1) return `昨天 ${time}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  return `${h ? `${h}:${pad(Math.floor(s / 60) % 60)}` : pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function buildRows(past: PastCall[], startedAt: number | undefined, live: Entry[]): Row[] {
  const rows: Row[] = []
  const lines = (entries: Entry[]) => {
    entries.forEach((entry, i) => {
      if (i > 0 && entry.at - entries[i - 1].at >= TIME_GAP) rows.push({ kind: 'time', text: stamp(entry.at), key: `t${entry.key}` })
      rows.push({ kind: 'line', entry })
    })
  }
  past.forEach((call, c) => {
    if (!call.cut) rows.push({ kind: 'time', text: `${stamp(call.startedAt)} 接通`, key: `s${c}` })
    lines(call.lines.map((l, i) => ({ who: l.who, zh: l.zh ?? l.text, say: l.zh ? l.text : undefined, at: l.at, key: `p${c}-${i}` })))
    rows.push({ kind: 'end', text: `通话已结束 · 时长 ${duration(call.endedAt - call.startedAt)}`, key: `e${c}` })
  })
  if (startedAt && live.length) {
    rows.push({ kind: 'time', text: `${stamp(startedAt)} 接通`, key: 'now' })
    lines(live)
  }
  return rows
}

function Call() {
  const [state, setState] = useState<CallState>({ active: true, thinking: false })
  const [now, setNow] = useState(Date.now())
  const [contact, setContact] = useState<{ name: string; avatar?: string; portrait?: string }>({ name: '' })
  const [past, setPast] = useState<PastCall[]>([])
  const [raised, setRaised] = useState(false)
  const [tall, setTall] = useState(true)
  const [unread, setUnread] = useState(false)
  const [subtitle, setSubtitle] = useState<CallLine>()
  const [yourLine, setYourLine] = useState<string>()
  const [speaking, setSpeaking] = useState(false)
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<Entry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [text, setText] = useState('')
  const [mood, setMood] = useState<CallMood>('normal')
  const [moodHint, setMoodHint] = useState(false)
  const hintTimer = useRef<number>(undefined)
  const queue = useRef<CallLine[]>([])
  const playing = useRef(false)
  const current = useRef<CallLine>(undefined)
  const audio = useRef<HTMLAudioElement>(null)
  const wait = useRef<number>(undefined)
  const talk = useRef<HTMLDivElement>(null)
  const raisedNow = useRef(false)
  const collapse = useRef<number>(undefined)
  const answerWait = useRef<number>(undefined)
  const grip = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean }>(undefined)

  const playNext = () => {
    const line = queue.current.shift()
    if (!line) {
      playing.current = false
      setSpeaking(false)
      window.clearTimeout(wait.current)
      wait.current = window.setTimeout(() => {
        setSubtitle(undefined)
        setYourLine(undefined)
      }, FADE_AFTER)
      return
    }
    playing.current = true
    current.current = line
    setSpeaking(true)
    window.clearTimeout(wait.current)
    setSubtitle(line)
    // What you said last only stays above her answer to it, or it would read as what she is answering.
    if (!line.reply) setYourLine(undefined)
    else window.clearTimeout(answerWait.current)
    setHistory((h) => [...h, { who: 'her', zh: line.zh, say: line.say !== line.zh ? line.say : undefined, at: Date.now(), key: line.id }])
    const el = audio.current
    if (line.audio && el) {
      el.src = URL.createObjectURL(new Blob([line.audio as BlobPart], { type: line.type }))
      el.play().catch(playNext)
    } else {
      wait.current = window.setTimeout(playNext, readingTime(line.zh))
    }
  }

  const stop = () => {
    queue.current = []
    playing.current = false
    setSpeaking(false)
    window.clearTimeout(wait.current)
    audio.current?.pause()
    setSubtitle(undefined)
  }

  useEffect(() => {
    bridge.init().then((init) => {
      setState(init.state)
      setContact(init.contact)
      setPast(init.past)
      document.documentElement.style.setProperty('--accent', init.contact.accent)
      setMood(init.mood)
      document.documentElement.style.setProperty('--ui-font', `'${init.uiFont}'`)
    })
    tone([660, 880])
    const offs = [
      bridge.onState(setState),
      bridge.onClear(stop),
      bridge.onDropUnprompted(() => {
        queue.current = queue.current.filter((l) => !l.unprompted)
        if (!playing.current || !current.current?.unprompted) return
        audio.current?.pause()
        setSubtitle(undefined)
        window.clearTimeout(wait.current)
        playNext()
      }),
      bridge.onEnded(() => {
        stop()
        tone([880, 660])
      }),
      bridge.onLine((line) => {
        queue.current.push(line)
        if (!playing.current) playNext()
      })
    ]
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    // Only the visible parts catch the mouse; the rest of the window lets clicks through.
    let over = false
    const move = (e: MouseEvent) => {
      const on = !!(e.target as Element).closest?.('.hit')
      if (on !== over) bridge.setInteractive((over = on))
    }
    document.addEventListener('mousemove', move)
    return () => {
      offs.forEach((off) => off())
      window.clearInterval(tick)
      document.removeEventListener('mousemove', move)
    }
  }, [])

  useEffect(() => {
    if (!showHistory) return
    bridge.focus()
    const measure = () => setTall(window.innerHeight >= TALL_ENOUGH)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [showHistory])

  useEffect(() => bridge.setScreen(showHistory), [showHistory])

  const toLatest = () => {
    if (talk.current) talk.current.scrollTop = talk.current.scrollHeight
    raisedNow.current = false
    setRaised(false)
    setUnread(false)
  }

  // It always opens on the latest line. Reading further back isn't interrupted by a new one, only told about it.
  useLayoutEffect(() => {
    if (showHistory) toLatest()
  }, [showHistory, past])
  useLayoutEffect(() => {
    if (!showHistory) return
    if (raisedNow.current) setUnread(true)
    else if (talk.current) talk.current.scrollTop = talk.current.scrollHeight
  }, [history])

  const onTalkScroll = () => {
    const el = talk.current
    if (!el) return
    const left = el.scrollHeight - el.clientHeight - el.scrollTop
    const next = raisedNow.current ? left > AT_BOTTOM : left > LEAVE_BOTTOM
    raisedNow.current = next
    setRaised(next)
    if (!next) setUnread(false)
  }

  const send = () => {
    const clean = text.trim()
    if (!clean) return
    bridge.send(clean)
    setHistory((h) => [...h, { who: 'you', zh: clean, at: Date.now(), key: `${Date.now()}` }])
    // What you just said is what you want to see.
    if (showHistory) window.setTimeout(toLatest)
    setText('')
    setYourLine(clean)
    window.clearTimeout(answerWait.current)
    answerWait.current = window.setTimeout(() => setYourLine(undefined), ANSWER_WAIT)
    window.clearTimeout(collapse.current)
    // The history has its only way out on the open capsule, so it stays open under the list.
    if (!showHistory) collapse.current = window.setTimeout(() => setOpen(false), COLLAPSE_AFTER_SEND)
  }

  // Click the capsule to open it, or hold and drag to move the call.
  const onCapsuleDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, input')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    grip.current = { x: e.clientX, y: e.clientY, startX: e.screenX, startY: e.screenY, moved: false }
  }
  const onCapsuleMove = (e: React.PointerEvent) => {
    const g = grip.current
    if (!g) return
    if (!g.moved && Math.hypot(e.screenX - g.startX, e.screenY - g.startY) < DRAG_FROM) return
    g.moved = true
    bridge.moveTo(e.screenX - g.x, e.screenY - g.y)
  }
  // The call screen is dragged by its top, wherever nothing else wants the mouse.
  const onScreenDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, input, .call-talk, .call-capsule')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    grip.current = { x: e.clientX, y: e.clientY, startX: e.screenX, startY: e.screenY, moved: false }
  }
  const onScreenUp = () => {
    const g = grip.current
    grip.current = undefined
    if (g?.moved) bridge.moved()
  }
  const onCapsuleUp = () => {
    const g = grip.current
    grip.current = undefined
    if (!g) return
    if (g.moved) return bridge.moved()
    window.clearTimeout(collapse.current)
    setOpen((v) => {
      if (v) setShowHistory(false)
      else bridge.focus()
      return !v
    })
  }
  const closeIfIdle = () => {
    if (!text && !showHistory) setOpen(false)
  }

  const moodIndex = MOODS.findIndex((m) => m.id === mood)
  const nextMood = () => {
    const next = MOODS[(moodIndex + 1) % MOODS.length].id
    setMood(next)
    bridge.setMood(next)
    setMoodHint(true)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setMoodHint(false), 1400)
  }

  const showing = !showHistory && (yourLine || subtitle)
  const time = clock(state.startedAt ? now - state.startedAt : 0)
  const moodButton = (
    <button className="call-mood" title={MOODS[moodIndex].label} aria-label={MOODS[moodIndex].label} onClick={nextMood}>
      <i className={mood} />
    </button>
  )
  const hangButton = (
    <button className="call-hang" title="挂断" aria-label="挂断" onClick={bridge.hangUp}>
      <Icon name="hangUp" size={15} />
    </button>
  )
  const picture = contact.portrait ?? contact.avatar
  const rows = showHistory ? buildRows(past, state.startedAt, history) : []
  if (showHistory)
    return (
      <div className="call">
        <audio ref={audio} onEnded={playNext} onError={playNext} />
        <div className={`call-screen hit ${raised || !tall ? 'raised' : ''}`} onPointerDown={onScreenDown} onPointerMove={onCapsuleMove} onPointerUp={onScreenUp}>
          <div className="call-backdrop" style={picture ? { backgroundImage: `url("${picture}")` } : undefined} />
          <div className="call-veil" />
          <button className="call-close" title="收起通话界面" aria-label="收起通话界面" onClick={() => setShowHistory(false)}>
            <Icon name="x" size={14} />
          </button>
          <div className="call-talk" ref={talk} onScroll={onTalkScroll}>
            <div className="call-lines">
              {rows.map((row) =>
                row.kind === 'line' ? (
                  <div key={row.entry.key} className={`call-line ${row.entry.who}`}>
                    {row.entry.zh}
                    {row.entry.say && <small>{row.entry.say}</small>}
                  </div>
                ) : (
                  <div key={row.key} className={`call-${row.kind}`}>
                    {row.text}
                  </div>
                )
              )}
            </div>
          </div>
          {unread && (
            <button className="call-unread" onClick={toLatest}>
              新消息
            </button>
          )}
          <span className="call-portrait">
            {contact.avatar ? <img src={contact.avatar} alt="" draggable={false} /> : <b>{contact.name.trim().slice(0, 1).toUpperCase()}</b>}
          </span>
          <h1 className="call-name">{contact.name}</h1>
          <div className="call-status">
            <span className={`call-status-wave ${speaking ? 'on' : ''}`}>
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className={`call-status-dots ${!speaking && state.thinking ? 'on' : ''}`} aria-label={!speaking && state.thinking ? '正在想' : undefined}>
              <i />
              <i />
              <i />
            </span>
            <span className="call-time">
              {time.minutes}
              <s>{time.seconds}</s>
            </span>
          </div>
          {state.notice && <p className="call-notice">{state.notice}</p>}
          {moodHint && <span className="call-mood-hint">{MOODS[moodIndex].label}</span>}
          <div className="call-capsule open" onMouseDown={(e) => (e.target as Element).closest('button') && e.preventDefault()}>
            <input
              autoFocus
              placeholder="说点什么…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setShowHistory(false)
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
              }}
            />
            {moodButton}
            {hangButton}
          </div>
        </div>
      </div>
    )
  return (
    <div className="call">
      <audio ref={audio} onEnded={playNext} onError={playNext} />
      {showing && (
        <div className="call-subtitles">
          {yourLine && <span className="call-you">{yourLine}</span>}
          {subtitle && (
            <div className="call-her" key={subtitle.id}>
              <p>{subtitle.zh}</p>
              {subtitle.say !== subtitle.zh && <small>{subtitle.say}</small>}
            </div>
          )}
        </div>
      )}
      {state.notice && <p className="call-notice hit">{state.notice}</p>}
      {moodHint && <span className="call-mood-hint">{MOODS[moodIndex].label}</span>}
      <div
        className={`call-capsule hit ${open ? 'open' : ''}`}
        title={open ? undefined : '点一下打字，按住拖动'}
        onPointerDown={onCapsuleDown}
        onPointerMove={onCapsuleMove}
        onPointerUp={onCapsuleUp}
        // A button taking the focus would blur the input and collapse the capsule before the click lands.
        onMouseDown={(e) => (e.target as Element).closest('button') && e.preventDefault()}
      >
        <span className={`call-avatar ${!speaking && state.thinking ? 'thinking' : ''}`}>
          {contact.avatar ? <img src={contact.avatar} alt="" draggable={false} /> : <b>{contact.name.trim().slice(0, 1).toUpperCase()}</b>}
        </span>
        {open ? (
          <input
            autoFocus
            placeholder="说点什么…"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              window.clearTimeout(collapse.current)
            }}
            onBlur={closeIfIdle}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeIfIdle()
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
            }}
          />
        ) : speaking ? (
          <span className="call-wave" aria-label="正在说话">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className="call-time">
            {time.minutes}
            <s>{time.seconds}</s>
          </span>
        )}
        {/* Its place is kept whether she is speaking or not, so the text you are typing doesn't jump. */}
        {open && (
          <span className="call-wave mini">
            {speaking && (
              <>
                <i />
                <i />
                <i />
              </>
            )}
          </span>
        )}
        {moodButton}
        {open && (
          <button className="call-icon" title="通话记录" aria-label="通话记录" onPointerDown={() => window.clearTimeout(collapse.current)} onClick={() => setShowHistory(true)}>
            <Icon name="history" size={15} />
          </button>
        )}
        {hangButton}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Call />)
