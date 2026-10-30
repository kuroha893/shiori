// Open-licensed (OFL) fonts that ship with the app, and how the chosen ones reach the CSS.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/inter'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'

export interface FontChoice {
  /** CSS family name */
  family: string
  label: string
}

export const BUNDLED: Record<'ui' | 'mono', FontChoice[]> = {
  ui: [
    { family: 'Geist Variable', label: 'Geist' },
    { family: 'Inter Variable', label: 'Inter' },
    { family: 'Space Grotesk Variable', label: 'Space Grotesk' },
    { family: 'IBM Plex Sans Variable', label: 'IBM Plex Sans' },
    { family: 'Manrope Variable', label: 'Manrope' }
  ],
  mono: [
    { family: 'Geist Mono Variable', label: 'Geist Mono' },
    { family: 'JetBrains Mono Variable', label: 'JetBrains Mono' },
    { family: 'IBM Plex Mono', label: 'IBM Plex Mono' }
  ]
}

export const fontLabel = (family: string) =>
  [...BUNDLED.ui, ...BUNDLED.mono].find((f) => f.family === family)?.label ?? family

const q = (family: string) => `"${family.replace(/"/g, '')}"`

/** Point the font variables at the chosen families; Chinese falls back to PingFang. */
export function applyFonts(ui: string, mono: string): void {
  const root = document.documentElement.style
  root.setProperty('--font-ui', `${q(ui)}, 'PingFang SC', -apple-system, 'Helvetica Neue', sans-serif`)
  root.setProperty('--font-display', `${q(ui)}, 'PingFang SC', -apple-system, sans-serif`)
  root.setProperty('--font-mono', `${q(mono)}, 'SF Mono', Menlo, monospace`)
}

let installed: Promise<string[]> | undefined

/** Font families installed on this Mac (Local Font Access API), loaded once. */
export function installedFamilies(): Promise<string[]> {
  installed ??= ((window as any).queryLocalFonts?.() ?? Promise.resolve([]))
    .then((fonts: { family: string }[]) => [...new Set(fonts.map((f) => f.family))].filter((f) => !f.startsWith('.')).sort((a, b) => a.localeCompare(b)))
    .catch(() => [])
  return installed!
}
