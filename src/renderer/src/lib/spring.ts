/**
 * A damped spring as a CSS easing: the motion is simulated once and handed to the Web Animations API as linear()
 * with the time it takes to settle, so a transform moves like something with weight rather than along a curve.
 */

export interface Spring {
  easing: string
  duration: number
}

const cache = new Map<string, Spring>()

/** stiffness and damping per unit mass; damping below 2·√stiffness overshoots a little */
export function spring(stiffness: number, damping: number): Spring {
  const key = `${stiffness}/${damping}`
  const hit = cache.get(key)
  if (hit) return hit
  const dt = 1 / 240
  let x = 0
  let v = 0
  let t = 0
  const samples: number[] = [0]
  let still = 0
  // run until it has stayed within a hair of rest for a while
  while (t < 3 && still < 0.08) {
    for (let i = 0; i < 4; i++) {
      const a = stiffness * (1 - x) - damping * v
      v += a * dt
      x += v * dt
      t += dt
    }
    samples.push(x)
    still = Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.02 ? still + 4 * dt : 0
  }
  samples[samples.length - 1] = 1
  const step = Math.max(1, Math.round(samples.length / 70))
  const points = samples.filter((_, i) => i % step === 0 || i === samples.length - 1).map((s) => +s.toFixed(4))
  const out = { easing: `linear(${points.join(', ')})`, duration: Math.round(t * 1000) }
  cache.set(key, out)
  return out
}

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
