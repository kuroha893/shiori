import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CallLine, CallState } from '../../shared/types'
import type { CallBridge } from '../../preload/call'
import './styles/call.css'

declare global {
  interface Window {
    callBridge: CallBridge
  }
}

const bridge = window.callBridge

type Entry = { who: 'you' | 'her'; text: string; key: string }

/** Without a voice, a subtitle stays up about as long as the line would take to say. */
const readingTime = (zh: string) => Math.max(1600, zh.length * 220)

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
  const [subtitle, setSubtitle] = useState<CallLine>()
  const [history, setHistory] = useState<Entry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [text, setText] = useState('')
  const queue = useRef<CallLine[]>([])
  const playing = useRef(false)
  const audio = useRef<HTMLAudioElement>(null)
  const wait = useRef<number>(undefined)
  const listEnd = useRef<HTMLDivElement>(null)

  const playNext = () => {
    const line = queue.current.shift()
    if (!line) {
      playing.current = false
      window.clearTimeout(wait.current)
      wait.current = window.setTimeout(() => setSubtitle(undefined), 5000)
      return
    }
    playing.current = true
    window.clearTimeout(wait.current)
    setSubtitle(line)
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
    window.clearTimeout(wait.current)
    audio.current?.pause()
    setSubtitle(undefined)
  }

  useEffect(() => {
    bridge.init().then((init) => {
      setState(init.state)
      document.documentElement.style.setProperty('--ui-font', `'${init.uiFont}'`)
    })
    tone([660, 880])
    const offs = [
      bridge.onState(setState),
      bridge.onClear(stop),
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
  }

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
      {!showHistory && subtitle && (
        <div className="call-subtitle hit" key={subtitle.id}>
          <p>{subtitle.zh}</p>
          {subtitle.say !== subtitle.zh && <small>{subtitle.say}</small>}
        </div>
      )}
      {state.notice && <p className="call-notice hit">{state.notice}</p>}
      <div className="call-bar hit">
        <span className={`call-dot ${state.thinking ? 'thinking' : ''}`} />
        <span className="call-time">{state.startedAt ? clock(now - state.startedAt) : '0:00:00'}</span>
        <input
          placeholder="说点什么…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()}
        />
        <button className={showHistory ? 'on' : ''} title="这次通话的记录" onClick={() => setShowHistory((v) => !v)}>
          记录
        </button>
        <button className="hang" title="挂断" onClick={bridge.hangUp}>
          挂断
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Call />)
