/**
 * DSH Chime — Host half.
 *
 * One job: when this machine finishes answering you, or when it is waiting for
 * you to decide something, play a short sound. Nothing else.
 *
 * Design notes:
 *   - It never talks to a model and adds nothing model-visible, so its runtime
 *     costs no tokens. The only side effect is one short-lived `chime.exe`.
 *   - Subagent sessions are ignored: a workflow that runs twenty children must
 *     not fire twenty dings.
 *   - Turning the sound off is a config edit, not a code edit.
 *   - The volume is read from `volume.txt` on every play, so it can be changed
 *     without restarting anything; see `tools/volume.ps1`.
 *
 * @module dsh-chime
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's own directory. */
const packageDir = dirname(fileURLToPath(import.meta.url))

/** The host has no visible console, so mirror every note into a file. */
const LOG_PATH = join(packageDir, 'chime.log')

/** The player built from `src/chime.cs`. */
const EXE_PATH = join(packageDir, 'bin', 'chime.exe')

/** Live volume override, written by `tools/volume.ps1`. Beats the config. */
const VOLUME_PATH = join(packageDir, 'volume.txt')

/** The quietest and loudest volume this will accept, in percent. */
const VOLUME_MIN = 0
const VOLUME_MAX = 200

/** Defaults, overridable from the Loader row's `config`. */
const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** A normal finished turn: one soft two-note ding. */
  onTurnEnd: true,
  /** The agent is waiting for you: a three-note alert. */
  onAsk: true,
  /** The turn died (provider error, hit the token ceiling): a low sigh. */
  onProblem: true,
  /** Never play two chimes closer together than this, in ms. */
  minGapMs: 900,
  /** Loudness in percent; 100 is the level this was tuned at. */
  volume: 100,
}

/**
 * Tool names that mean "the agent stopped and is waiting for your answer".
 * `ask_user_question` is the one this build ships; the second is kept for
 * forward compatibility and costs nothing.
 */
const ASK_TOOLS = new Set(['ask_user_question', 'request_user_input'])

/** Loudness order; a more urgent chime may cut through the debounce window. */
const PRIORITY = { ding: 1, sad: 2, alert: 3 }

/**
 * Coerce anything a config file might hold into a usable volume.
 *
 * Accepts `60`, `'60'`, `'60%'`, `' 60 '`; falls back on nonsense, clamps the
 * range, and rounds, because a YAML typo must never silence the reminder.
 *
 * @param value - raw config value.
 * @param fallback - what to return when there is nothing usable; `null` makes
 *   this a strict parser, which is what the live override wants.
 * @returns a volume in percent, or the fallback.
 */
export function parseVolume(value, fallback = DEFAULTS.volume) {
  if (value === null || value === undefined) return fallback
  const text = String(value).trim().replace(/%$/, '').trim()
  if (text === '') return fallback
  const number = Number(text)
  if (!Number.isFinite(number)) return fallback
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(number)))
}

/**
 * Read the live volume override, if one was written.
 *
 * Blank lines and `#` comments are skipped so the file can explain itself.
 *
 * @returns a volume in percent, or `null` when there is no usable override.
 */
export function readVolumeOverride(path = VOLUME_PATH) {
  try {
    if (!existsSync(path)) return null
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find((candidate) => candidate.trim() !== '' && !candidate.trim().startsWith('#'))
    if (line === undefined) return null
    return parseVolume(line, null)
  } catch {
    // An unreadable override must not take the reminder down with it.
    return null
  }
}

/**
 * Decide whether one session event deserves a sound. Pure: no I/O, no state,
 * which is what makes it directly testable.
 *
 * @param session - the session the event came from, or undefined.
 * @param event - the appended session event.
 * @param options - merged config.
 * @returns `'ding'`, `'alert'`, `'sad'`, or `null` for silence.
 */
export function classify(session, event, options) {
  const header = session?.header

  // A subagent answering is not news for the human.
  if (header?.origin === 'subagent') return null
  if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return null

  if (event?.type === 'tool/call') {
    const name = event.data?.name
    if (options.onAsk && typeof name === 'string' && ASK_TOOLS.has(name)) return 'alert'
    return null
  }

  // An approval prompt is the classic "it stopped and is waiting for you".
  // Silent in profiles with approvals off, armed for the day they are on.
  if (event?.type === 'approval/asked') return options.onAsk ? 'alert' : null

  if (event?.type !== 'turn/end') return null

  const kind = event.data?.reason?.kind
  // You stopped it yourself, or the session was forked: you already know.
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked') return null
  // `blocked` means the turn stopped because it needs a human decision.
  if (kind === 'blocked') return options.onAsk ? 'alert' : null
  if (kind === 'error' || kind === 'max-tokens') return options.onProblem ? 'sad' : null
  return options.onTurnEnd ? 'ding' : null
}

/**
 * Install the listener.
 *
 * @param ctx - host plugin context.
 * @param config - the Loader row's `config`.
 */
export async function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const configured = parseVolume(options.volume)

  /** Log one diagnostic line to the package log and the harness logger. */
  function log(message) {
    try {
      appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${message}\n`)
    } catch {
      // A read-only install must not break the plugin.
    }
    try {
      ctx.logger?.info?.(`[dsh-chime] ${message}`)
    } catch {
      // No logger service in this composition.
    }
  }

  if (!options.enabled) {
    log('disabled by config; nothing armed')
    return
  }
  if (!existsSync(EXE_PATH)) {
    log(`player missing: ${EXE_PATH} — run tools/build.ps1 first`)
    return
  }

  let lastAt = 0
  let lastKind = ''

  /**
   * Play one chime, unless we just played one of equal or higher urgency.
   *
   * @param kind - `'ding'`, `'alert'`, or `'sad'`.
   */
  function play(kind) {
    const now = Date.now()
    const elapsed = now - lastAt
    if (elapsed < options.minGapMs) {
      const urgent = PRIORITY[kind] > (PRIORITY[lastKind] ?? 0)
      // A more urgent chime still gets through, but not instantly after.
      if (!urgent || elapsed < 250) return
    }
    lastAt = now
    lastKind = kind

    // Re-read every time: that is what makes the volume changeable live.
    const override = readVolumeOverride()
    const volume = override ?? configured
    try {
      spawn(EXE_PATH, [kind, String(volume)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
      log(`played ${kind} at ${volume}%${override === null ? '' : ' (volume.txt)'}`)
    } catch (error) {
      log(`cannot play ${kind}: ${error?.message ?? error}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    let kind = null
    try {
      kind = classify(session, event, options)
    } catch (error) {
      log(`classify failed: ${error?.message ?? error}`)
      return
    }
    if (kind !== null) play(kind)
  })

  // ------------------------------------------------------------- the slider's bridge
  // The browser half draws the volume control on this bundle's own page in the
  // Plugins panel, and a page cannot touch volume.txt itself. This route is that
  // bridge, and it is optional by design: without a webServer service the chime
  // still works exactly as before, and only the on-screen slider is missing.
  const routeDisposers = []
  try {
    ctx.effect?.(() => () => {
      for (const dispose of routeDisposers) {
        try {
          dispose()
        } catch {
          // Already gone; nothing to withdraw.
        }
      }
    })
  } catch {
    // An older context with no effect(): the row's own teardown still unregisters.
  }

  /** What the plugin would use for the next chime, override included. */
  function effectiveVolume() {
    return readVolumeOverride() ?? configured
  }

  /** One chime at an exact volume, straight away: the slider's own feedback. */
  function preview(volume) {
    try {
      spawn(EXE_PATH, ['ding', String(volume)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
    } catch {
      // No audio device; the save is still worth doing.
    }
  }

  /** Answer one JSON body, and never let a dead socket throw into the plugin. */
  function send(res, code, payload) {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    } catch {
      // The page navigated away mid-answer.
    }
  }

  /**
   * Only the local DSH page may drive this: the route writes a file, and the
   * volume is a local preference. Anything that is not a loopback authority
   * has to be approved by the host's own connection fence.
   */
  function sameOrigin(req) {
    const host = String(req?.headers?.host ?? '')
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return true
    try {
      const fence = ctx.get?.('connection')
      if (fence && typeof fence.requestRejection === 'function') {
        const code = fence.requestRejection(req)
        return code === undefined || code === null || code === false
      }
    } catch {
      // No fence to ask: fall through to the refusal.
    }
    return false
  }

  ctx.inject(['webServer'], (scoped) => {
    try {
      routeDisposers.push(
        scoped.webServer.register({
          kind: 'exact',
          path: '/dsh-chime/volume',
          handler: async (req, res) => {
            if (!sameOrigin(req)) return send(res, 403, { error: 'not a local page' })
            const method = String(req.method ?? 'GET').toUpperCase()

            if (method === 'GET') {
              return send(res, 200, { volume: effectiveVolume(), file: existsSync(VOLUME_PATH) })
            }
            if (method !== 'POST') return send(res, 405, { error: 'GET or POST only' })

            let body = ''
            try {
              for await (const chunk of req) body += chunk
            } catch {
              // The parse below reports it.
            }
            let asked
            try {
              asked = JSON.parse(body === '' ? '{}' : body)
            } catch {
              return send(res, 400, { error: 'body must be JSON' })
            }

            const volume = parseVolume(asked?.volume, null)
            if (volume === null) return send(res, 400, { error: 'volume must be 0-200' })

            try {
              const { writeFileSync } = await import('node:fs')
              writeFileSync(VOLUME_PATH, `${volume}\n`)
            } catch (error) {
              log(`cannot write volume.txt: ${error?.message ?? error}`)
              return send(res, 500, { error: 'volume.txt is not writable' })
            }

            if (asked?.preview === true) preview(volume)
            log(`volume set to ${volume}% from the page`)
            return send(res, 200, { volume, file: true })
          },
        }),
      )
      log('volume route armed at /dsh-chime/volume')
    } catch (error) {
      log(`cannot serve the volume route: ${error?.message ?? error}`)
    }
  })

  log(
    `armed (turnEnd=${options.onTurnEnd} ask=${options.onAsk} problem=${options.onProblem} ` +
      `gap=${options.minGapMs}ms volume=${configured}% exe=${EXE_PATH})`,
  )
}
