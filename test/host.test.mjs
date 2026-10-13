/**
 * Host-half checks for DSH Chime.
 *
 * Only the pure functions are exercised, plus the wiring: the suite must never
 * make a sound. Run it with any Node 18+:
 *
 *   node test/host.test.mjs
 */

import { existsSync, writeFileSync } from 'node:fs'
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
const ctx = {
  on(name, handler) {
    listeners.set(name, handler)
  },
  logger: { info() {} },
}
await apply(ctx, { minGapMs: 0 })
check('registers one session/event listener', listeners.has('session/event'), true)

check('player is built', existsSync(join(packageDir, 'bin', 'chime.exe')), true)
check('volume window is built', existsSync(join(packageDir, 'bin', 'chime-volume.exe')), true)

const summary = failures === 0 ? 'all checks passed' : `${failures} CHECK(S) FAILED`
writeFileSync(join(packageDir, 'test', 'last-run.txt'), `${checks} checks, ${summary}\n`)
console.log(`\n${checks} checks, ${summary}`)
process.exit(failures === 0 ? 0 : 1)
