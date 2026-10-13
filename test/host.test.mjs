/**
 * Host-half checks for DSH Chime.
 *
 * The pure functions, the wiring, and the volume route the page talks to. The
 * suite must never make a sound: the route plays a preview only when a request
 * asks for one, and nothing here ever asks. Run it with any Node 18+:
 *
 *   node test/host.test.mjs
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, classify, parseVolume, readVolumeOverride } from '../impl.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const OPTIONS = {
  enabled: true,
  onTurnEnd: true,
  onAsk: true,
  onProblem: true,
  minGapMs: 900,
  volume: 100,
}

let checks = 0
let failures = 0

function check(label, actual, expected) {
  checks += 1
  const ok = actual === expected
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

/** A root session, the kind the human is actually watching. */
const root = { header: { id: 's1', isSeeded: false } }
/** A delegated child session. */
const child = { header: { id: 's2', isSeeded: false, origin: 'subagent', delegationDepth: 1 } }

const turnEnd = (kind) => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } })
const toolCall = (name) => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name, arguments: '{}' } })

// ---------------------------------------------------------------- turn ends
check('completed turn dings', classify(root, turnEnd('completed'), OPTIONS), 'ding')
check('provider error sighs', classify(root, turnEnd('error'), OPTIONS), 'sad')
check('token ceiling sighs', classify(root, turnEnd('max-tokens'), OPTIONS), 'sad')
check('blocked turn alerts', classify(root, turnEnd('blocked'), OPTIONS), 'alert')
check('user abort is silent', classify(root, turnEnd('aborted'), OPTIONS), null)
check('interrupt is silent', classify(root, turnEnd('interrupted'), OPTIONS), null)
check('fork is silent', classify(root, turnEnd('forked'), OPTIONS), null)

// ------------------------------------------------------------------- asking
check('question tool alerts', classify(root, toolCall('ask_user_question'), OPTIONS), 'alert')
check(
  'approval prompt alerts',
  classify(root, { type: 'approval/asked', data: { id: 'a1' } }, OPTIONS),
  'alert',
)
check(
  'approval prompt is muted with onAsk false',
  classify(root, { type: 'approval/asked', data: { id: 'a1' } }, { ...OPTIONS, onAsk: false }),
  null,
)
check('other tools are silent', classify(root, toolCall('pwsh'), OPTIONS), null)
check('unknown events are silent', classify(root, { type: 'assistant/chunk', data: {} }, OPTIONS), null)
check('turn start is silent', classify(root, { type: 'turn/start', data: { turn: 1 } }, OPTIONS), null)

// ----------------------------------------------------------------- subagents
check('subagent turn end is silent', classify(child, turnEnd('completed'), OPTIONS), null)
check('subagent question is silent', classify(child, toolCall('ask_user_question'), OPTIONS), null)
check(
  'depth alone is enough',
  classify({ header: { delegationDepth: 2 } }, turnEnd('completed'), OPTIONS),
  null,
)

// -------------------------------------------------------------------- config
check(
  'onTurnEnd false mutes finished turns',
  classify(root, turnEnd('completed'), { ...OPTIONS, onTurnEnd: false }),
  null,
)
check(
  'onAsk false mutes questions',
  classify(root, toolCall('ask_user_question'), { ...OPTIONS, onAsk: false }),
  null,
)
check(
  'onProblem false mutes failures',
  classify(root, turnEnd('error'), { ...OPTIONS, onProblem: false }),
  null,
)

// -------------------------------------------------------------------- volume
check('volume defaults to 100', parseVolume(undefined), 100)
check('volume accepts a number', parseVolume(60), 60)
check('volume accepts a percent string', parseVolume('60%'), 60)
check('volume tolerates padding', parseVolume(' 150 '), 150)
check('volume rounds', parseVolume(66.6), 67)
check('volume clamps below', parseVolume(-5), 0)
check('volume clamps above', parseVolume(999), 200)
check('volume rejects nonsense', parseVolume('loud'), 100)
check('volume of zero is valid, not a fallback', parseVolume(0), 0)
check('strict mode returns null for nonsense', parseVolume('loud', null), null)
check('strict mode returns null for empty', parseVolume('   ', null), null)
check('missing override is null', readVolumeOverride(join(packageDir, 'no-such-volume.txt')), null)

// --------------------------------------------------------------------- wiring
const listeners = new Map()
const routes = new Map()
let fence = null

const ctx = {
  on(name, handler) {
    listeners.set(name, handler)
  },
  logger: { info() {} },
  get(name) {
    return name === 'connection' ? fence : undefined
  },
  effect() {},
  /**
   * The host half asks for the web server and registers the volume route on it.
   * Handing it this fake registrar is what lets the suite drive that route.
   */
  inject(names, callback) {
    if (!names.includes('webServer')) return
    callback({
      webServer: {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      },
    })
  },
}

await apply(ctx, { minGapMs: 0 })
check('registers one session/event listener', listeners.has('session/event'), true)

check('player is built', existsSync(join(packageDir, 'bin', 'chime.exe')), true)
check('volume window is built', existsSync(join(packageDir, 'bin', 'chime-volume.exe')), true)

// --------------------------------------------------------------- volume route
const handler = routes.get('/dsh-chime/volume')
check('arms the volume route', typeof handler, 'function')

/**
 * One request through the real handler. `preview` is never sent on purpose:
 * this suite must stay silent, and the route plays only when asked.
 */
async function call(method, { host = '127.0.0.1:19387', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = {
    method,
    headers: { host },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text) {
      res.body = text === undefined ? null : JSON.parse(text)
    },
  }
  await handler(req, res)
  return { status: res.statusCode, body: res.body }
}

const volumeFile = join(packageDir, 'volume.txt')
const hadVolumeFile = existsSync(volumeFile)
const preserved = hadVolumeFile ? readFileSync(volumeFile, 'utf8') : null

const saved = await call('POST', { body: '{"volume":30}' })
check('route saves a volume', saved.body.volume, 30)
check('route reports it wrote the file', saved.body.file, true)
check('route writes volume.txt', readFileSync(volumeFile, 'utf8').trim(), '30')
check('route answers 200', saved.status, 200)

const read = await call('GET')
check('route reads back what it saved', read.body.volume, 30)
check('route reads the file flag', read.body.file, true)

check('route rounds like parseVolume', (await call('POST', { body: '{"volume":"66.6%"}' })).body.volume, 67)
check('route clamps like parseVolume', (await call('POST', { body: '{"volume":999}' })).body.volume, 200)
check('route accepts zero', (await call('POST', { body: '{"volume":0}' })).body.volume, 0)
check('route rejects nonsense', (await call('POST', { body: '{"volume":"loud"}' })).status, 400)
check('route rejects a missing volume', (await call('POST', { body: '{}' })).status, 400)
check('route rejects an empty body', (await call('POST', { body: '' })).status, 400)
check('route rejects a broken body', (await call('POST', { body: '{oops' })).status, 400)
check('route refuses other methods', (await call('PUT', { body: '{}' })).status, 405)
check('route allows localhost', (await call('GET', { host: 'localhost' })).status, 200)
check('route allows IPv6 loopback', (await call('GET', { host: '[::1]:19387' })).status, 200)

const foreign = await call('GET', { host: 'evil.example.com' })
check('route defers a foreign host to the connection fence', foreign.status, 403)
check('route says why it refused', foreign.body.error, 'not a local page')
fence = { requestRejection: () => 403 }
check('route obeys a fence that refuses', (await call('GET', { host: 'evil.example.com' })).status, 403)
fence = { requestRejection: () => undefined }
check('route trusts a fence that approves', (await call('GET', { host: 'evil.example.com' })).status, 200)
fence = null
check('route refuses a foreign host with no fence to ask', (await call('GET', { host: 'evil.example.com' })).status, 403)

// Put the human's own volume back exactly as it was.
if (preserved === null) rmSync(volumeFile, { force: true })
else writeFileSync(volumeFile, preserved)

const summary = failures === 0 ? 'all checks passed' : `${failures} CHECK(S) FAILED`
writeFileSync(join(packageDir, 'test', 'last-run.txt'), `${checks} checks, ${summary}\n`)
console.log(`\n${checks} checks, ${summary}`)
process.exit(failures === 0 ? 0 : 1)
