import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CallLine, CallMood, CallState } from '../../shared/types'
import type { CallBridge } from '../../preload/call'
import { Icon } from './components/Icon'
import './styles/call.css'

declare global {
  interface Window {
    callBridge: CallBridge
  }
}

const bridge = window.callBridge

type Entry = { who: 'you' | 'her'; text: string; key: string }

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
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

function Call() {
  const [state, setState] = useState<CallState>({ active: true, thinking: false })
  const [now, setNow] = useState(Date.now())
  const [contact, setContact] = useState<{ name: string; avatar?: string }>({ name: '' })
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
  const listEnd = useRef<HTMLDivElement>(null)
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
    setHistory((h) => [...h, { who: 'her', text: line.zh, key: line.id }])
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
    listEnd.current?.scrollIntoView()
  }, [history, showHistory])

  const send = () => {
    const clean = text.trim()
    if (!clean) return
    bridge.send(clean)
    setHistory((h) => [...h, { who: 'you', text: clean, key: `${Date.now()}` }])
    setText('')
    setYourLine(clean)
    window.clearTimeout(answerWait.current)
    answerWait.current = window.setTimeout(() => setYourLine(undefined), ANSWER_WAIT)
    window.clearTimeout(collapse.current)
    collapse.current = window.setTimeout(() => setOpen(false), COLLAPSE_AFTER_SEND)
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
  return (
    <div className="call">
      <audio ref={audio} onEnded={playNext} onError={playNext} />
      {showHistory && (
        <div className="call-history hit">
          {history.length === 0 && <p className="call-empty">还没说话</p>}
          {history.map((e) => (
            <p key={e.key} className={e.who}>
              {e.text}
            </p>
          ))}
          <div ref={listEnd} />
        </div>
      )}
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
      <div className={`call-capsule hit ${open ? 'open' : ''}`} title={open ? undefined : '点一下打字，按住拖动'} onPointerDown={onCapsuleDown} onPointerMove={onCapsuleMove} onPointerUp={onCapsuleUp}>
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
          <span className="call-time">{state.startedAt ? clock(now - state.startedAt) : '0:00:00'}</span>
        )}
        <button className="call-mood" title={MOODS[moodIndex].label} aria-label={MOODS[moodIndex].label} onClick={nextMood}>
          <i className={mood} />
        </button>
        {open && (
          <button
            className={`call-icon ${showHistory ? 'on' : ''}`}
            title="这次通话的记录"
            aria-label="这次通话的记录"
            onPointerDown={() => window.clearTimeout(collapse.current)}
            onClick={() => setShowHistory((v) => !v)}
          >
            <Icon name="history" size={15} />
          </button>
        )}
        <button className="call-hang" title="挂断" aria-label="挂断" onClick={bridge.hangUp}>
          <Icon name="hangUp" size={15} />
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Call />)
