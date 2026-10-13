import type { EngineInterface, ProcessRunResult, Register, SessionRateLimit } from 'claude-code'

// Answers the account-rotator mod's calls on `$` with imitated logins, so a
// recording shows the real mod with nobody's accounts in it. The session's own
// requests stay on whatever login started it: a switch here is the mod's alone.
// The login in use drains once the recorder creates the file DEMO_DRAIN_FILE
// names, so it runs low while the camera is on the footer, with no prompt sent.
// DEMO_IN_USE picks how the footer marks the login in use, and the login
// DEMO_SIGNED_OUT names starts signed out, for a shot of the footer asking
// for a sign-in.

/** The mod whose calls are answered; every other plugin's go through. */
const MOD = 'account-rotator'
const HOME = '/home/you'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** The mod's clock runs this many times faster than the wall's, so a switch settles in seconds. */
const SPEED = 10
/** The mod's one-minute sync and ten-minute check both run this often. */
const TICK_MS = 500
/** How often the recorder's file is looked for. */
const POLL_MS = 250
/** How long the imitated browser sign-in takes. */
const SIGN_IN_MS = 4500

/**
 * One imitated login: who, percent used of its 5-hour window and its week,
 * how fast its window fills while it drains (percent a second), and when
 * each window resets, as an offset from the clock's first reading.
 */
type Login = {
  id: string
  email: string
  orgName: string
  plan: string
  five: number
  week: number
  fillPerSecond: number
  fiveResets: number
  weekResets: number
  isSignedIn: boolean
}

/** Login 1 runs low within seconds of draining. */
const logins: Login[] = [
  { id: '1', email: 'you@example.com', orgName: 'Personal', plan: 'max', five: 60, week: 38, fillPerSecond: 10, fiveResets: 2 * HOUR + 14 * MINUTE, weekResets: 2 * DAY + 5 * HOUR, isSignedIn: true },
  { id: '2', email: 'you@acme.example', orgName: 'Acme', plan: 'team', five: 6, week: 22, fillPerSecond: 1.5, fiveResets: 4 * HOUR + 41 * MINUTE, weekResets: 5 * DAY + 2 * HOUR, isSignedIn: true },
  { id: '3', email: 'you@example.com', orgName: 'Side gig', plan: 'pro', five: 41, week: 77, fillPerSecond: 1.5, fiveResets: 1 * HOUR + 3 * MINUTE, weekResets: 3 * DAY + 20 * HOUR, isSignedIn: true },
]
/** The login + Add a login signs in, its reset offsets counted from the sign-in. */
const ADDED = { email: 'you@studio.example', orgName: 'Studio', plan: 'max', five: 0, week: 9, fillPerSecond: 1.5, fiveIn: 5 * HOUR, weekIn: 6 * DAY + 9 * HOUR }

const slotOf = (id: string) => (id === '1' ? '' : `${HOME}/.claude/accounts/${id}`)
const idOf = (slot: string) => (slot === '' ? '1' : (slot.split('/').pop() ?? ''))

/** The mod's store, kept here: nothing reaches the file every session of the real mod shares. */
const store = new Map<string, unknown>([
  [
    'accounts',
    logins.map(l => ({ id: l.id, slot: slotOf(l.id), email: l.email, orgId: `org-${l.id}`, orgName: l.orgName, plan: l.plan })),
  ],
])

let activeSlot = ''
/** From the recorder's file until the mod moves off the login it drains. */
let isDraining = false
/** Wall-clock start, and the last time the fill was brought up to date. */
let start: number | undefined
let filledTo: number | undefined

const fakeNow = (wall: number) => {
  start ??= wall
  return start + (wall - start) * SPEED
}
const iso = (offset: number) => new Date((start ?? 0) + offset).toISOString()
/** Every 5-hour reset time handed out: a reading that carries none of them is the real session's. */
const isImitated = (value: unknown) => {
  const resetsAt = (value as { fiveHour?: { resetsAt?: unknown } } | null)?.fiveHour?.resetsAt
  return logins.some(l => iso(l.fiveResets) === resetsAt)
}

/** Fills the login in use for the time it drained since the last look. */
function fill(wall: number): void {
  const elapsed = filledTo === undefined ? 0 : (wall - filledTo) / 1000
  filledTo = wall
  const active = logins.find(l => l.id === idOf(activeSlot))
  if (isDraining && active !== undefined) active.five = Math.min(100, active.five + active.fillPerSecond * elapsed)
}

const usageOf = (l: Login) => ({
  five_hour: { utilization: Math.round(l.five), resets_at: iso(l.fiveResets) },
  seven_day: { utilization: Math.round(l.week), resets_at: iso(l.weekResets) },
})

const limitsOf = (l: Login): SessionRateLimit[] => [
  { kind: 'five_hour', percentUsed: Math.round(l.five), resetsAt: iso(l.fiveResets) },
  { kind: 'seven_day', percentUsed: Math.round(l.week), resetsAt: iso(l.weekResets) },
]

const ran = (exitCode: number, stdout: string): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** The keychain entry Claude Code keeps a slot's login in, as the mod names it. */
async function keychainItem(slot: string): Promise<string> {
  if (slot === '') return 'Claude Code-credentials'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(slot.normalize('NFC')))
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `Claude Code-credentials-${hex.slice(0, 8)}`
}

/** A login's sign-in as Claude Code stores it, its token the one the usage answer knows. */
async function signInOf($: EngineInterface, l: Login): Promise<string> {
  const now = fakeNow(await $.clock.now())
  const oauth = { accessToken: `demo-${l.id}`, expiresAt: now + 6 * HOUR, refreshTokenExpiresAt: now + 25 * DAY, subscriptionType: l.plan }
  return JSON.stringify({ claudeAiOauth: oauth })
}

async function stored($: EngineInterface, item: string): Promise<ProcessRunResult> {
  for (const l of logins) {
    if (!l.isSignedIn || (await keychainItem(slotOf(l.id))) !== item) continue
    return ran(0, await signInOf($, l))
  }
  return ran(44, '')
}

/** Where there is no keychain (Linux): the signed-in login whose credentials file is `path`. */
const fileLogin = (path: string) =>
  logins.find(l => l.isSignedIn && `${slotOf(l.id) || `${HOME}/.claude`}/.credentials.json` === path)

function status(slot: string): string {
  const l = logins.find(x => x.id === idOf(slot) && x.isSignedIn)
  if (l === undefined) return JSON.stringify({ loggedIn: false })
  return JSON.stringify({ loggedIn: true, email: l.email, orgId: `org-${l.id}`, orgName: l.orgName, subscriptionType: l.plan })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const inUse = await $.env.get('DEMO_IN_USE')
    if (inUse !== undefined && inUse !== '') store.set('footer', { active: inUse })
    const signedOut = await $.env.get('DEMO_SIGNED_OUT')
    for (const l of logins) if (l.id === signedOut) l.isSignedIn = false
    const started = await next(e)
    const trigger = await $.env.get('DEMO_DRAIN_FILE')
    if (trigger === undefined || trigger === '') return started
    const poll = $.clock.every(POLL_MS, () => {
      void $.fs.exists(trigger).then(async exists => {
        if (!exists || isDraining) return
        poll.cancel()
        fill(await $.clock.now())
        isDraining = true
      })
    })
    return started
  })

  on('clock.now', async ($, e, next) => {
    const wall = await next(e)
    return next.origin.plugin !== MOD || wall.deny !== undefined ? wall : { value: fakeNow(wall.value) }
  })

  on('clock.every', async ($, e, next) => (next.origin.plugin === MOD ? next({ ...e, ms: TICK_MS }) : next(e)))

  on('env.get', async ($, e, next) => {
    if (next.origin.plugin !== MOD) return next(e)
    if (e.name === 'USER') return { value: 'you' }
    if (e.name === 'HOME') return { value: HOME }
    if (e.name === 'CLAUDE_SECURESTORAGE_CONFIG_DIR') return { value: activeSlot === '' ? undefined : activeSlot }
    return next(e)
  })

  // A switch is the mod's alone: the session keeps the login it started with,
  // and the drain ends with the login that ran low.
  on('env.set', async ($, e, next) => {
    if (next.origin.plugin !== MOD || e.name !== 'CLAUDE_SECURESTORAGE_CONFIG_DIR') return next(e)
    fill(await $.clock.now())
    activeSlot = e.value ?? ''
    isDraining = false
    return { value: undefined }
  })

  on('process.run', async ($, e, next) => {
    if (next.origin.plugin !== MOD) return next(e)
    const [cmd, sub, verb] = e.argv
    if (cmd === 'security') return { value: await stored($, e.argv[e.argv.length - 1] ?? '') }
    if (cmd === 'claude' && sub === 'auth') {
      const slot = e.init?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? ''
      if (verb === 'status') return { value: ran(0, status(slot)) }
      if (verb === 'logout') {
        const l = logins.find(x => x.id === idOf(slot))
        if (l !== undefined) l.isSignedIn = false
        return { value: ran(0, '') }
      }
    }
    return next(e)
  })

  // The browser sign-in, imitated: a pause, then the new login is there.
  on('process.spawn', async function* ($, e, next) {
    if (next.origin.plugin !== MOD || e.argv[0] !== 'claude' || e.argv[2] !== 'login') return yield* next(e)
    const id = idOf(e.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '')
    yield { stream: 'stdout' as const, text: 'Opening browser to sign in…\n' }
    await $.clock.sleep(SIGN_IN_MS)
    const existing = logins.find(l => l.id === id)
    if (existing !== undefined) existing.isSignedIn = true
    else {
      const elapsed = fakeNow(await $.clock.now()) - (start ?? 0)
      const { fiveIn, weekIn, ...who } = ADDED
      logins.push({ id, ...who, fiveResets: elapsed + fiveIn, weekResets: elapsed + weekIn, isSignedIn: true })
    }
    return { value: { code: 0, signal: null } }
  })

  on('http.fetch', async ($, e, next) => {
    if (next.origin.plugin !== MOD || e.url !== USAGE_URL) return next(e)
    fill(await $.clock.now())
    const token = (e.init?.headers?.Authorization ?? '').replace('Bearer ', '')
    const l = logins.find(x => `demo-${x.id}` === token && x.isSignedIn)
    if (l === undefined) return { value: { status: 401, ok: false, headers: {}, text: '' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(usageOf(l)) } }
  })

  // What the session's last response reported, for the mod's check that a switch took.
  on('session.usage', async ($, e, next) => {
    const real = await next(e)
    if (next.origin.plugin !== MOD || real.deny !== undefined) return real
    fill(await $.clock.now())
    const active = logins.find(l => l.id === idOf(activeSlot))
    return { value: { ...real.value, rateLimits: active === undefined ? [] : limitsOf(active) } }
  })

  on('store.get', async ($, e, next) => (next.origin.plugin === MOD ? { value: store.get(e.key) } : next(e)))

  // The real responses' usage is the starting login's, not the imitated one in use: refused.
  on('store.set', async ($, e, next) => {
    if (next.origin.plugin !== MOD) return next(e)
    if (e.key.startsWith('reading:') && !isImitated(e.value)) return { deny: 'the demo shows imitated usage only' }
    store.set(e.key, e.value)
    return { value: undefined }
  })

  on('store.delete', async ($, e, next) => {
    if (next.origin.plugin !== MOD) return next(e)
    store.delete(e.key)
    return { value: undefined }
  })

  on('store.keys', async ($, e, next) => (next.origin.plugin === MOD ? { value: [...store.keys()] } : next(e)))

  on('fs.write', async ($, e, next) => (next.origin.plugin === MOD ? { value: undefined } : next(e)))

  on('fs.read', async ($, e, next) => {
    if (next.origin.plugin !== MOD || !e.path.endsWith('/.credentials.json')) return next(e)
    const l = fileLogin(e.path)
    return l === undefined ? { deny: 'no such file' } : { value: await signInOf($, l) }
  })

  on('ui.notify', async ($, e, next) => (next.origin.plugin === MOD ? { value: { isSent: false, reason: 'refused' } } : next(e)))
}
