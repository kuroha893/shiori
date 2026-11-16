import { app, ipcMain, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NowPlaying } from '../shared/types'

/*
 * What macOS says is playing (NetEase Cloud Music or any other player), and its play/pause/next/previous.
 * The work happens in native/nowplaying, run inside Apple's perl; each question is a fresh process of about 20 ms.
 * If Apple closes that door, every answer is empty and the room simply shows no player.
 */

// Packed, the library sits outside the asar so perl can load it.
const dir = () => join(app.getAppPath(), 'resources', 'native').replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked')
const lib = () => join(dir(), 'libShioriNowPlaying.dylib')

function run(args: string[]): Promise<any> {
  return new Promise((resolve) => {
    if (!existsSync(lib())) return resolve(undefined)
    execFile('/usr/bin/perl', [join(dir(), 'nowplaying.pl'), lib(), ...args], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(undefined)
      try {
        resolve(JSON.parse(out.split('\n')[0]))
      } catch {
        resolve(undefined)
      }
    })
  })
}

/** The cover only changes with the song, so it is sent once per song and the page keeps it. */
let lastCover = ''

export async function nowPlaying(withCover: boolean): Promise<NowPlaying | undefined> {
  const r = await run(['get'])
  if (!r || r.error || !r.app || !r.title) return undefined
  const song = `${r.app}|${r.title}|${r.artist ?? ''}`
  const cover = r.artwork ? `data:${r.artworkType};base64,${r.artwork}` : undefined
  const fresh = withCover || song !== lastCover
  if (fresh) lastCover = song
  return {
    app: r.app,
    appName: r.appName,
    playing: !!r.playing,
    title: r.title,
    artist: r.artist,
    album: r.album,
    duration: r.duration,
    elapsed: r.elapsed,
    at: Date.now(),
    ...(fresh ? { cover: cover ?? null } : {})
  }
}

const COMMANDS = { play: 0, pause: 1, toggle: 2, next: 4, previous: 5 } as const

export function initNowPlaying(): void {
  ipcMain.handle('np:get', (_e, withCover: boolean) => nowPlaying(withCover))
  ipcMain.handle('np:send', async (_e, command: keyof typeof COMMANDS) => {
    if (!(command in COMMANDS)) return
    await run(['send', String(COMMANDS[command])])
    // macOS reports the old state for a moment after play or pause (the first play after the player starts can
    // take a second while it loads the song), so wait until the player says it did it before the page looks again.
    if (command !== 'play' && command !== 'pause') return
    const until = Date.now() + 2500
    while (Date.now() < until) {
      const r = await run(['get'])
      if (!r || r.error || !!r.playing === (command === 'play')) return
      await new Promise((ok) => setTimeout(ok, 150))
    }
  })
  // The player's own window, for anything beyond the three buttons.
  ipcMain.handle('np:show', (_e, bundle: string) => {
    if (/^[\w.-]+$/.test(bundle)) execFile('/usr/bin/open', ['-b', bundle], () => {})
  })
  ipcMain.handle('np:icon', (_e, bundle: string) => appIcon(bundle))
}

/** The player's own icon, worn on the cover as the way back to it. */
const icons = new Map<string, Promise<string | null>>()
function appIcon(bundle: string): Promise<string | null> {
  if (!/^[\w.-]+$/.test(bundle)) return Promise.resolve(null)
  let p = icons.get(bundle)
  if (!p) {
    p = new Promise<string | null>((resolve) =>
      execFile('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundle}'`], { timeout: 4000 }, (err, out) => {
        const path = err ? undefined : out.split('\n').find((l) => l.endsWith('.app'))
        if (!path) return resolve(null)
        // The bundle's own .icns; Electron's file icon gives a blank placeholder for many apps on recent macOS.
        execFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', join(path, 'Contents', 'Info.plist')], (e2, name) => {
          const file = e2 ? '' : name.trim()
          const icns = file && join(path, 'Contents', 'Resources', file.endsWith('.icns') ? file : `${file}.icns`)
          const fallback = () =>
            app
              .getFileIcon(path, { size: 'normal' })
              .then((i) => resolve(i.isEmpty() ? null : i.toDataURL()))
              .catch(() => resolve(null))
          if (!icns || !existsSync(icns)) return fallback()
          // nativeImage can't read .icns; sips turns it into a small PNG.
          const png = join(app.getPath('temp'), `shiori-player-${bundle}.png`)
          execFile('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', png], (e3) => {
            const img = e3 ? undefined : nativeImage.createFromPath(png)
            if (!img || img.isEmpty()) return fallback()
            resolve(img.toDataURL())
          })
        })
      })
    )
    icons.set(bundle, p)
  }
  return p
}
