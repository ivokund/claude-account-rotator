import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  McpToolResult,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  SessionAuthorization,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { Account, FooterStyle, Health, Holder, Reading, RotateTo, StartOn, View } from '../types'
import {
  CHROME_SERVER,
  CHROME_TOOL,
  EMPTY_VIEW,
  LEAVE_FIVE_HOUR,
  LEAVE_SEVEN_DAY,
  blockedText,
  browsersFrom,
  canConnectChrome,
  chromeNote,
  credentialFrom,
  credentialsFile,
  fingerprint,
  footerStyleFrom,
  freeId,
  healthOf,
  identityFromProfile,
  identityFromStatus,
  isLoginOf,
  isPolicyRefusal,
  isUnansweredCall,
  isSpent,
  keychainItem,
  keychainUser,
  label,
  modelWindow,
  newestReading,
  pickStart,
  pickTarget,
  rotateToFrom,
  readingFromLimits,
  readingFromUsage,
  retryAfter,
  sameLogin,
  sameUsage,
  shouldLeave,
  slotEnv,
  startOnFrom,
  spentReading,
  startWhy,
  stuckText,
  usageReadAt,
  viewScope,
  windowPct,
  withModelWeeks,
} from './model'
import type { Credential, Identity } from './model'
import { Band, Footer, Pane } from './view'
import type { Actions } from './view'

type Host = EngineInterface

const PANE = 'claude-accounts'
const TITLE = 'Claude accounts'
/** The dock width the pane asks for: a login's line, its buttons and its usage rows fit on one line each. */
const PANE_COLUMNS = 64
/** Claude Code caches a keychain read for 30 s, so a switch lands within this. */
const SETTLE_MS = 35_000
/** A switch no response has shown after this long is reported as not taken. */
const CONFIRM_GIVE_UP_MS = 4 * 60_000
/** A beat of the in-use mark's blink while a switch is not yet seen to land: lit one beat, unlit the next. */
const BLINK_MS = 500
/** How often a switch asks who the session's sign-in is, for its first CONFIRM_POLL_FOR_MS, once a request has gone out since; the minute's timer asks after, while a verdict can still come. */
const CONFIRM_POLL_MS = 5_000
const CONFIRM_POLL_FOR_MS = SETTLE_MS + 15_000
/** How many of the minute's checks ask for a verdict on a switch after the request that tests it: giving up comes CONFIRM_GIVE_UP_MS after the switch, at one of them. */
const AWAIT_CHECKS = 10
/** On a timer, a request counts as a test of a switch this long after it set out: Claude Code reads the sign-in again as it sends it, once every hook has had its say. */
const REREAD_MS = 5_000
/** A reading this fresh, from any session, is not asked for again by the routine check: every session asking every login piles up. */
const USAGE_FRESH_MS = 5 * 60_000
/** After Anthropic rate limits a usage check, how long every session leaves the usage endpoint be, at least. */
const USAGE_PAUSE_MS = 5 * 60_000
/** The longest a Retry-After holds every session's usage checks back: a wrong one would leave readings old for good. */
const USAGE_PAUSE_MAX_MS = 60 * 60_000
/**
 * Claude Code refreshes a token 5 minutes before it expires. A refresh that
 * runs while the old login's read is still cached is saved under the new
 * slot, overwriting that login: so no switch this close to the expiry.
 */
const REFRESH_GUARD_MS = 8 * 60_000
/** How long the mod waits on Claude in Chrome to list its browsers, connecting first, before going on without. */
const CHROME_WAIT_MS = 15_000
/** A file only macOS has: there Claude Code keeps logins in the keychain, elsewhere (Linux) in a file each. */
const MACOS_MARKER = '/System/Library/CoreServices/SystemVersion.plist'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CONTINUE =
  'Claude Code switched to another of your Claude accounts because the previous one hit its usage limit or lost its sign-in. Continue where you left off.'

const viewAtom = atom({ plugin: 'account-rotator', key: 'view' } as const, EMPTY_VIEW)
/** Whether a pending switch's in-use mark is drawn this beat: only the footer reads it, and only while a switch is pending. */
const blinkAtom = atom({ plugin: 'account-rotator', key: 'blink' } as const, true)

/**
 * Whether this session's pane shows. A press opens or closes it in its own
 * turn, with no read before: the engine counts an open as the person's only
 * there, and places it at any width; one made after an await waits undrawn
 * below 144 columns. Kept in step with closes by the person and with reloads.
 */
let isPaneShown = false
/** The `claude auth login` child of the sign-in under way, so Cancel can end it. */
let running: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
/** The login this session is signing in; a stored 'logging-in' from a session that died is checked again. */
let signingIn: string | undefined
let signInQueue: Promise<void> = Promise.resolve()
/** A switch the refresh guard holds back: the latest one asked for, tried again each minute until it goes. */
let held: { target: Account; why: string; isOpening: boolean; isPicked: boolean; timer: Timer } | undefined
/** Logins a switch to did not take this session: the rotation leaves them be; Use now still tries. */
const untaken = new Set<string>()
/** When this session last moved to another login: until SETTLE_MS after, its requests may still go out as the one before. */
let movedAt: number | undefined
/** The timer that blinks a pending switch's mark and asks whether it has landed: one at a time. */
let watch: Timer | undefined
/** A check whether the pending switch has landed is under way: another waits for its turn rather than ask twice. */
let isSettling = false
/**
 * When this session last sent a model request. Claude Code reads a sign-in
 * again only before a request (or a claude.ai call), once its 30 s read has
 * run out: until a request goes out SETTLE_MS after a switch, the sign-in it
 * holds, which the profile check sees, may still be the one before.
 */
let lastRequestAt: number | undefined
/** The minute's checks that asked for a verdict on the switch waited on, since the last request. */
let checks = 0
/** Connect is under way: the rotation waits for it, and browser calls are held back. */
let isConnectingChrome = false

// ---------------------------------------------------------------- state
// The view is this session's; the store is one JSON file every session of the
// mod shares: the list of logins, each login's last reading and health under a
// key of its own, so sessions writing different logins never collide, the
// footer's look, and which login the rotation moves to.

/** The view survives a hot reload as the code before wrote it: what this code added starts as in a new session. */
const current = (v: View): View => ({ ...EMPTY_VIEW, ...v })
const getView = async ($: Host): Promise<View> => current(await read($, viewAtom))
const setView = ($: Host, fn: (v: View) => View): Promise<View> => update($, viewAtom, v => fn(current(v)))
/** Something the person should know that nothing on screen says: a toast, on screen for a while. */
const tell = ($: Host, text: string) => $.ui.toast(text, { timeoutMs: 8000 })
const debug = ($: Host, text: string) => $.ui.log(`account-rotator: ${text}`, { to: 'debug' })

function isAccount(value: unknown): value is Account {
  if (typeof value !== 'object' || value === null) return false
  const { id, slot } = value as Record<string, unknown>
  return typeof id === 'string' && typeof slot === 'string'
}

async function loadAccounts($: Host): Promise<Account[]> {
  const stored = await $.store.get('accounts')
  return Array.isArray(stored) ? stored.filter(isAccount) : []
}

async function saveAccounts($: Host, accounts: Account[]): Promise<void> {
  await $.store.set('accounts', accounts)
  await setView($, v => ({ ...v, accounts }))
}

/**
 * What only the usage endpoint tells of a login, the model weeks and when it
 * answered, as the store keeps them beside the reading: a session on an older
 * version of the mod stores its readings without them, over this version's.
 */
async function storedUsage($: Host, id: string): Promise<Reading | undefined> {
  const u = await $.store.get(`usage:${id}`)
  if (typeof u !== 'object' || u === null || typeof (u as Reading).usageAt !== 'number') return undefined
  const { models, usageAt } = u as Pick<Reading, 'models' | 'usageAt'>
  return { ...(models === undefined ? {} : { models }), usageAt, at: 0 }
}

/**
 * Stores a login's reading. Where another session asked the usage endpoint
 * after this one did, the model weeks it stored stay: a response's report,
 * saved with the weeks this session last saw, would put them back otherwise.
 */
async function saveReading($: Host, id: string, taken: Reading): Promise<void> {
  const usage = await storedUsage($, id)
  const reading = withModelWeeks(taken, usage)
  await $.store.set(`reading:${id}`, reading)
  if (reading.usageAt !== undefined && (usage?.usageAt === undefined || reading.usageAt > usage.usageAt)) {
    await $.store.set(`usage:${id}`, { ...(reading.models === undefined ? {} : { models: reading.models }), usageAt: reading.usageAt })
  }
  await setView($, v => ({ ...v, readings: { ...v.readings, [id]: reading } }))
}

/** A login's reading as the store has it, with the model weeks kept beside it. */
async function storedReading($: Host, id: string): Promise<Reading | undefined> {
  const r = await $.store.get(`reading:${id}`)
  if (typeof r !== 'object' || r === null || typeof (r as Reading).at !== 'number') return undefined
  return withModelWeeks(r as Reading, await storedUsage($, id))
}

/** Stores a login's health; answers what it was before. */
async function saveHealth($: Host, id: string, health: Health): Promise<Health | undefined> {
  const before = (await getView($)).health[id]
  await $.store.set(`health:${id}`, health)
  await setView($, v => ({ ...v, health: { ...v.health, [id]: health } }))
  return before
}

async function saveHolder($: Host, id: string, holder: Holder): Promise<void> {
  await $.store.set(`holder:${id}`, holder)
  await setView($, v => ({ ...v, holders: { ...v.holders, [id]: holder } }))
}

/** Folds what other sessions stored into this session's view. */
async function mergeStore($: Host): Promise<void> {
  const accounts = await loadAccounts($)
  const readings: Record<string, Reading> = {}
  const health: Record<string, Health> = {}
  const holders: Record<string, Holder> = {}
  for (const a of accounts) {
    const r = await storedReading($, a.id)
    if (r !== undefined) readings[a.id] = r
    const h = await $.store.get(`health:${a.id}`)
    if (typeof h === 'object' && h !== null && typeof (h as Health).kind === 'string') health[a.id] = h as Health
    const s = await $.store.get(`holder:${a.id}`)
    if (typeof s === 'object' && s !== null && typeof (s as Holder).token === 'string' && typeof (s as Holder).who?.email === 'string') {
      holders[a.id] = s as Holder
    }
  }
  const footer = footerStyleFrom(await $.store.get('footer'))
  const rotateTo = rotateToFrom(await $.store.get('rotate-to'))
  const startOn = startOnFrom(await $.store.get('start-on'))
  const chrome = await $.store.get('chrome-account')
  const chromeAccountId = typeof chrome === 'string' && accounts.some(a => a.id === chrome) ? chrome : undefined
  const seen = await $.store.get('chrome-accounts')
  const chromeAccountIds = (Array.isArray(seen) ? seen : []).filter((id): id is string => typeof id === 'string' && accounts.some(a => a.id === id))
  const paused = await $.store.get('usage-paused-until')
  const usagePausedUntil = typeof paused === 'number' ? paused : undefined
  await setView($, v => {
    const nextReadings: Record<string, Reading> = {}
    const nextHealth: Record<string, Health> = {}
    const nextHolders: Record<string, Holder> = {}
    for (const a of accounts) {
      const reading = newestReading(v.readings[a.id], readings[a.id])
      if (reading !== undefined) nextReadings[a.id] = reading
      const own = v.health[a.id]
      const h = signingIn === a.id ? own : (health[a.id] ?? own)
      if (h !== undefined) nextHealth[a.id] = h
      const holder = holders[a.id] ?? v.holders[a.id]
      if (holder !== undefined) nextHolders[a.id] = holder
    }
    return { ...v, accounts, readings: nextReadings, health: nextHealth, holders: nextHolders, footer, rotateTo, startOn, chromeAccountId, chromeAccountIds, usagePausedUntil }
  })
}

/** Changes the footer's look for every session. */
async function setFooter($: Host, change: Partial<FooterStyle>): Promise<void> {
  const footer = { ...(await getView($)).footer, ...change }
  await $.store.set('footer', footer)
  await setView($, v => ({ ...v, footer }))
}

/** Changes which login the rotation moves to, for every session. */
async function setRotateTo($: Host, rotateTo: RotateTo): Promise<void> {
  await $.store.set('rotate-to', rotateTo)
  await setView($, v => ({ ...v, rotateTo }))
}

/** Changes where new sessions start, for every session from now on. */
async function setStartOn($: Host, startOn: StartOn): Promise<void> {
  await $.store.set('start-on', startOn)
  await setView($, v => ({ ...v, startOn }))
}

/**
 * Where a new session's claim on the login it starts on is kept: when it was
 * made, under a key of the login's own, as readings are, so sessions claiming
 * different logins never write over each other. Two that open in the same
 * instant may still claim the same one: the store has no lock.
 */
const claimKey = (id: string) => `start-claim:${id}`

/**
 * Where this new session starts, with "a fresh 5-hour window" picked: the
 * login pickStart picks, claimed so the next new session starts elsewhere.
 */
async function startPick($: Host): Promise<Account | undefined> {
  const view = await getView($)
  const now = await $.clock.now()
  const claims: Record<string, number> = {}
  for (const a of view.accounts) {
    const at = await $.store.get(claimKey(a.id))
    if (typeof at === 'number') claims[a.id] = at
  }
  const pick = pickStart(view, now, claims)
  if (pick !== undefined) await $.store.set(claimKey(pick.id), now)
  return pick
}

/** Why a new session moves to `account` as it opens, as far as its reading tells now. */
async function startReason($: Host, account: Account): Promise<string> {
  return startWhy((await getView($)).readings[account.id], await $.clock.now())
}

/** Names the account the Chrome extension is signed in to, for every session; none forgets it. */
async function setChromeAccount($: Host, id: string | undefined): Promise<void> {
  if (id === undefined) await $.store.delete('chrome-account')
  else await $.store.set('chrome-account', id)
  await setView($, v => ({ ...v, chromeAccountId: id }))
}

/** A Chrome extension answered as `id`, or none did, or the account is gone: the Chrome box lists it, or not, for every session. */
async function noteChromeAccount($: Host, id: string, isSeen: boolean): Promise<void> {
  const stored = await $.store.get('chrome-accounts')
  const before = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
  const ids = isSeen ? [...new Set([...before, id])] : before.filter(x => x !== id)
  if (ids.length !== before.length) await $.store.set('chrome-accounts', ids)
  await setView($, v => ({ ...v, chromeAccountIds: ids }))
}

// ---------------------------------------------------------------- host

type Stored = { state: 'present'; credential: Credential | undefined } | { state: 'absent' } | { state: 'unreadable'; code: number }

/** A slot's stored login, from the keychain on macOS or its file elsewhere (Linux); the secret stays in this module. */
async function readStored($: Host, slot: string): Promise<Stored> {
  return (await $.fs.exists(MACOS_MARKER)) ? readKeychain($, slot) : readCredentialsFile($, slot)
}

async function readKeychain($: Host, slot: string): Promise<Stored> {
  const user = keychainUser(await $.env.get('USER'))
  const argv = ['security', 'find-generic-password', '-a', user, '-w', '-s', await keychainItem(slot)]
  const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 10_000 })
  if (exitCode === 44) return { state: 'absent' }
  if (exitCode !== 0) return { state: 'unreadable', code: exitCode }
  return { state: 'present', credential: credentialFrom(stdout.trim()) }
}

/**
 * A file that cannot be read holds no login, as Claude Code counts it: a
 * missing or locked file, and one caught mid-write (Claude Code renames a new
 * one into place, rewriting it in place only where that fails).
 */
async function readCredentialsFile($: Host, slot: string): Promise<Stored> {
  const path = credentialsFile(slot, await $.env.get('HOME'))
  const text = path === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
  return text === undefined ? { state: 'absent' } : { state: 'present', credential: credentialFrom(text) }
}

type UsageAnswer = { kind: 'ok'; body: unknown } | { kind: 'rejected' } | { kind: 'failed'; status: number; retryAfterMs?: number }

const OAUTH_BETA = { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }
const oauthHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, ...OAUTH_BETA })

/** The usage of the login a token belongs to, as `/usage` reads it. */
async function fetchUsage($: Host, accessToken: string): Promise<UsageAnswer> {
  const res = await $.http.fetch(USAGE_URL, { headers: oauthHeaders(accessToken) })
  if (res.status === 401 || res.status === 403) return { kind: 'rejected' }
  if (!res.ok) {
    const retryAfterMs = retryAfter(res.headers['retry-after'], await $.clock.now())
    return { kind: 'failed', status: res.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  }
  try {
    return { kind: 'ok', body: JSON.parse(res.text) }
  } catch {
    // A 2xx that is not JSON counts as a failed call; the next check asks again.
    return { kind: 'failed', status: res.status }
  }
}

/**
 * Who a sign-in belongs to, as Claude Code asks at a sign-in: email and
 * organization; undefined when the call fails. A login's, by its token, or the
 * session's own, by the handle `$.session.authorize()` answered.
 */
async function fetchIdentity($: Host, by: { token: string } | { auth: string }): Promise<Identity | undefined> {
  const init = 'token' in by ? { headers: oauthHeaders(by.token) } : { auth: by.auth, headers: OAUTH_BETA }
  const res = await $.http.fetch(PROFILE_URL, init)
  if (!res.ok) return undefined
  try {
    return identityFromProfile(JSON.parse(res.text))
  } catch {
    // A body that is not JSON says nothing of who; the next check asks again.
    return undefined
  }
}

/** Who a slot is signed in as: email, organization and plan. */
async function signedInAs($: Host, slot: string): Promise<Identity | undefined> {
  const { exitCode, stdout } = await $.process.run(['claude', 'auth', 'status', '--json'], {
    env: slotEnv(slot),
    timeoutMs: 20_000,
  })
  return exitCode === 0 ? identityFromStatus(stdout) : undefined
}

/**
 * A switch Claude Code itself held back: in a session that takes its settings
 * from its organization, the write resolves with why, where the security
 * default's refusal rejects. Either way the session can't switch.
 */
class SwitchHeld extends Error {}

/** Whether a switch failed because Claude Code won't let this session switch, however it said so. */
const isRefusal = (error: unknown): boolean => error instanceof SwitchHeld || isPolicyRefusal(error)

/** Points this session's requests, and every child it starts after, at a slot's login. */
async function useSlot($: Host, slot: string): Promise<void> {
  const set = slot === '' ? await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined) : await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', slot)
  if (set.deny !== undefined) throw new SwitchHeld(set.deny)
}

/**
 * Claude Code's security policy refuses switching in this session: says so
 * once, as a toast and a notification, and the pane says so while it lasts.
 * False when it was said already.
 */
async function blocked($: Host): Promise<boolean> {
  const view = await getView($)
  if (view.isSwitchBlocked) return false
  await setView($, v => ({ ...v, isSwitchBlocked: true }))
  const text = blockedText(view)
  $.ui.toast(text, { timeoutMs: 15_000 })
  await $.ui.notify(text, { title: TITLE })
  return true
}

/**
 * Sets the slot already in use, which changes nothing: the policy that refuses
 * a switch refuses this too, so a session that cannot switch says so at its start.
 */
async function checkSwitching($: Host, slot: string): Promise<void> {
  try {
    await useSlot($, slot)
  } catch (error) {
    if (isRefusal(error)) await blocked($)
    else await debug($, `switch check failed: ${String(error)}`)
  }
}

// ---------------------------------------------------------------- checks and switching

async function announceLockout($: Host, account: Account, why: string): Promise<void> {
  const text = `Claude account ${label(account)} needs a sign-in (${why}). Click ⚠${account.id} under the prompt.`
  $.ui.toast(text, { timeoutMs: 8000 })
  await $.ui.notify(text, { title: TITLE })
}

/**
 * Who a login's sign-in belongs to: as answered for its token before, else
 * asked while the token is live. A /login in a session on a login signs in
 * there, and a new sign-in brings a new token, so it is asked about again.
 */
async function holderOf($: Host, account: Account, credential: Credential, isLive: boolean): Promise<Holder | undefined> {
  const token = await fingerprint(credential.refreshToken ?? credential.accessToken)
  const known = (await getView($)).holders[account.id]
  if (known?.token === token) return known
  if (!isLive) return undefined
  const who = await fetchIdentity($, { token: credential.accessToken })
  if (who?.email === undefined) return undefined
  const holder = { token, who: { ...who, email: who.email, ...(credential.plan === undefined ? {} : { plan: credential.plan }) } }
  await saveHolder($, account.id, holder)
  return holder
}

/**
 * A login's sign-in belongs to `who`. Another login on the list: this one
 * holds that one's sign-in, answered so it asks for its own again. Else the
 * login is who signed in, its name and plan kept current, and told when that
 * is another account than before: a /login in a session on it did that.
 */
async function followSignIn($: Host, account: Account, who: Identity): Promise<Account | undefined> {
  const accounts = await loadAccounts($)
  const own = accounts.find(a => a.id === account.id)
  if (own === undefined) return undefined
  const isSame = own.email === undefined || isLoginOf(own, who)
  const twin = isSame ? undefined : accounts.find(a => a.id !== own.id && isLoginOf(a, who))
  if (twin !== undefined) return twin
  const followed = { ...own, ...who }
  if (followed.email !== own.email || followed.orgId !== own.orgId || followed.orgName !== own.orgName || followed.plan !== own.plan) {
    await saveAccounts($, accounts.map(a => (a.id === own.id ? followed : a)))
  }
  if (!isSame) {
    const name = `${followed.email}${followed.orgName ? ` · ${followed.orgName}` : ''}`
    tell(
      $,
      own.slot === ''
        ? `Claude Code's login, account ${own.id}, is ${name} now: new sessions start on it.`
        : `Claude account ${own.id} is ${name} now: a /login in a session on account ${own.id} signs in there, not Claude Code's login.`,
    )
  }
  return undefined
}

/**
 * Whether to ask the usage endpoint about a login now: not while Anthropic
 * rate limits the checks, and, unless it is urgent, not while a reading of it
 * any session took is fresh: that one comes in with the store. Where the login
 * has a model's own week, only the usage endpoint's answer keeps it fresh: a
 * session at work on the login reports its week with every response, and never
 * that one.
 */
async function shouldAskUsage($: Host, id: string, now: number, isUrgent: boolean): Promise<boolean> {
  const paused = await $.store.get('usage-paused-until')
  if (typeof paused === 'number' && paused > now) return false
  if (isUrgent) return true
  const at = usageReadAt(newestReading((await getView($)).readings[id], await storedReading($, id)))
  return at === undefined || now - at >= USAGE_FRESH_MS
}

/**
 * Anthropic rate limited a usage check: every session leaves the usage
 * endpoint be for 5 minutes, or as long as its Retry-After asks, up to an
 * hour, and the pane says so.
 */
async function pauseUsage($: Host, now: number, retryAfterMs?: number): Promise<void> {
  const until = now + Math.max(USAGE_PAUSE_MS, Math.min(retryAfterMs ?? 0, USAGE_PAUSE_MAX_MS))
  await $.store.set('usage-paused-until', until)
  await setView($, v => ({ ...v, usagePausedUntil: until }))
}

/**
 * Re-reads one login's stored sign-in: who it belongs to and, while its token
 * is live, its usage, unless a fresh reading is in hand and the check is not
 * urgent. One that is another login's on the list leaves this login needing
 * its own, its usage that other's.
 */
async function checkAccount($: Host, account: Account, isUrgent = false): Promise<void> {
  const now = await $.clock.now()
  if (signingIn === account.id) return
  const stored = await readStored($, account.slot)
  if (stored.state === 'unreadable') {
    tell($, `Could not read Claude account ${account.id} from the keychain (exit ${stored.code}); is it locked?`)
    return
  }
  const credential = stored.state === 'present' ? stored.credential : undefined
  let health = healthOf(credential, now)
  const isIdle = health.kind === 'ok' && credential !== undefined && credential.expiresAt <= now + 60_000
  await setView($, v => {
    const idle = (v.idle ?? []).filter(id => id !== account.id)
    return { ...v, idle: isIdle ? [...idle, account.id] : idle }
  })
  if (health.kind === 'ok' && credential !== undefined) {
    const isLive = !isIdle
    const holder = await holderOf($, account, credential, isLive)
    const twin = holder === undefined ? undefined : await followSignIn($, account, holder.who)
    if (twin !== undefined) health = { kind: 'login-needed', why: `signed in as account ${twin.id} now` }
    else if (isLive && (await shouldAskUsage($, account.id, now, isUrgent))) {
      const usage = await fetchUsage($, credential.accessToken)
      if (usage.kind === 'rejected') health = { kind: 'login-needed', why: 'sign-in rejected' }
      if (usage.kind === 'failed') {
        await debug($, `usage for account ${account.id}: HTTP ${usage.status}`)
        if (usage.status === 429) await pauseUsage($, now, usage.retryAfterMs)
      }
      if (usage.kind === 'ok') {
        const reading = readingFromUsage(usage.body, now)
        if (reading !== undefined) await saveReading($, account.id, { ...reading, usageAt: now })
      }
    }
  }
  const before = await saveHealth($, account.id, health)
  if (health.kind === 'login-needed' && before?.kind !== 'login-needed') {
    await announceLockout($, account, health.why)
  }
}

/** Checks every login in turn: one whose check fails leaves the rest theirs. */
async function checkAccounts($: Host): Promise<void> {
  for (const account of (await getView($)).accounts) {
    try {
      await checkAccount($, account)
    } catch (error) {
      await debug($, `checking account ${account.id} failed: ${String(error)}`)
    }
  }
}

async function checkAll($: Host): Promise<void> {
  await checkAccounts($)
  await maybeRotate($)
}

/** Why the login in use is left, counted the way the footer shows it: room left, or what is used. */
function whyLeave(view: View, now: number): string {
  if (view.health[view.activeId]?.kind === 'login-needed') return `account ${view.activeId} needs a sign-in`
  const r = view.readings[view.activeId]
  const five = windowPct(r?.fiveHour, now) ?? 0
  const week = windowPct(r?.sevenDay, now) ?? 0
  const scope = viewScope(view)
  const model = windowPct(modelWindow(r, scope), now) ?? 0
  const [window, used] =
    five >= LEAVE_FIVE_HOUR ? ['5-hour window', five] : week < LEAVE_SEVEN_DAY && model >= LEAVE_SEVEN_DAY ? [`${scope} week`, model] : ['week', week]
  return view.footer.fill === 'left'
    ? `account ${view.activeId} has ${Math.round(100 - used)}% of its ${window} left`
    : `account ${view.activeId} has used ${Math.round(used)}% of its ${window}`
}

/**
 * Once the active login is spent or locked out, moves to the one the pane's
 * Rotation setting picks; never while it is off, Claude Code's policy refuses
 * it, or Connect holds the session where it is. Nor over a switch a verdict
 * may still come on, or one the person picked; one an idle session only shows
 * as made is a login like any other, to move on from once it is spent.
 * Refused, it says once how to get a session that can move: a background
 * session nobody watches gets the notification. Not from a turn that dies on
 * the limit: Claude Code's security default, seated in such a session, passes
 * its StopFailure hook over.
 */
async function maybeRotate($: Host): Promise<boolean> {
  const now = await $.clock.now()
  const view = await getView($)
  if (view.isSwitchBlocked) {
    const stuck = view.isStuckTold ? undefined : stuckText(view, now)
    if (stuck !== undefined) {
      await setView($, v => ({ ...v, isStuckTold: true }))
      $.ui.toast(stuck, { timeoutMs: 15_000 })
      await $.ui.notify(stuck, { title: TITLE })
    }
    return false
  }
  const { pending } = view
  const isWaiting = pending !== undefined && (pending.isPicked === true || isAwaited(pending))
  if (isConnectingChrome || view.rotateTo === 'off' || isWaiting || !shouldLeave(view, now)) return false
  // With none to move to, the band above the prompt says when the next login frees up.
  const target = pickTarget({ ...view, accounts: view.accounts.filter(a => !untaken.has(a.id)) }, now)
  return target === undefined ? false : switchTo($, target, whyLeave(view, now))
}

/**
 * The login in use, when its token refreshes too soon for the refresh guard
 * to let the session leave it for `target`. As a window opens, also one whose
 * token has run out, as overnight: Claude Code refreshes that at the session's
 * first request, which may come while its read of the login is still cached.
 */
async function refreshingSoon(
  $: Host,
  view: View,
  target: Account,
  now: number,
  isOpening = false,
): Promise<{ account: Account; hasRunOut: boolean } | undefined> {
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active === undefined || active.id === target.id) return undefined
  const stored = await readStored($, active.slot)
  const credential = stored.state === 'present' ? stored.credential : undefined
  if (credential === undefined || credential.expiresAt - now >= REFRESH_GUARD_MS) return undefined
  const hasRunOut = credential.expiresAt <= now
  return hasRunOut && !isOpening ? undefined : { account: active, hasRunOut }
}

/**
 * How a switch is made. `isQuiet`: no toast says so once it lands.
 * `isOpening`: the move a new session starts with, which also waits for a
 * token that has run out. `isPicked`: the person's own pick, which the
 * rotation leaves be until a request confirms it.
 */
type SwitchOptions = { isQuiet?: boolean; isOpening?: boolean; isPicked?: boolean }

/**
 * Points this session at `target`; false while the refresh guard holds it
 * back, or Claude Code's policy refuses it. A toast says so once the switch is
 * seen to land; a quiet one has none.
 */
async function switchTo($: Host, target: Account, why: string, { isQuiet = false, isOpening = false, isPicked = false }: SwitchOptions = {}): Promise<boolean> {
  const turning = await refreshingSoon($, await getView($), target, await $.clock.now(), isOpening)
  if (turning !== undefined) {
    if (held === undefined) {
      tell(
        $,
        turning.hasRunOut
          ? `Switching to Claude account ${target.id} once account ${turning.account.id}'s token has refreshed, as this session's first request does.`
          : `Switching to Claude account ${target.id} in a few minutes, once account ${turning.account.id}'s token has refreshed.`,
      )
      const retry = () => {
        if (held !== undefined) void switchTo($, held.target, held.why, { isOpening: held.isOpening, isPicked: held.isPicked })
      }
      held = { target, why, isOpening, isPicked, timer: $.clock.every(60_000, retry) }
    } else held = { ...held, target, why, isOpening, isPicked }
    return false
  }
  held?.timer.cancel()
  held = undefined
  await keepChrome($)
  try {
    await useSlot($, target.slot)
  } catch (error) {
    if (!isRefusal(error)) throw error
    // A press of Use now or Rotate now gets an answer, even once the notice has shown.
    if (!(await blocked($))) tell($, blockedText(await getView($)))
    return false
  }
  const now = await $.clock.now()
  movedAt = now
  await update($, blinkAtom, () => true)
  await setView($, v => ({
    ...v,
    activeId: target.id,
    pending: { id: target.id, from: v.activeId, since: now, ...(isQuiet ? {} : { why }), ...(isPicked ? { isPicked } : {}) },
    removing: undefined,
  }))
  watchSwitch($, now)
  return true
}

/**
 * While the switch made at `since` is pending: blinks the in-use mark, and
 * every CONFIRM_POLL_MS for a while asks whether it has landed. Stops once
 * nothing is pending, whatever cleared it, or another switch takes over.
 */
function watchSwitch($: Host, since: number): void {
  watch?.cancel()
  let beats = 0
  const beatsPerAsk = Math.round(CONFIRM_POLL_MS / BLINK_MS)
  const timer = $.clock.every(BLINK_MS, () => {
    void (async () => {
      const { pending } = await getView($)
      if (pending?.since !== since || pending.isDue === true) {
        timer.cancel()
        if (watch === timer) watch = undefined
        return
      }
      beats += 1
      await update($, blinkAtom, isLit => !isLit)
      if (beats % beatsPerAsk === 0 && (await $.clock.now()) - since <= CONFIRM_POLL_FOR_MS) await settleOnce($, false)
    })().catch(error => debug($, `switch watch failed: ${String(error)}`))
  })
  watch = timer
}

/**
 * Which login the session's requests go out as now: whom the sign-in Claude
 * Code holds belongs to, asked of the profile endpoint with that sign-in.
 * Claude Code rereads a sign-in at most every 30 s, so just after a switch
 * this is the login left. 'other' for an account not on the list; undefined
 * where it can't tell: no sign-in lent to plugins, or the call failed.
 */
async function liveAccount($: Host): Promise<Account | 'other' | undefined> {
  let auth: SessionAuthorization
  try {
    auth = await $.session.authorize()
  } catch (error) {
    await debug($, `the session's sign-in is not lent: ${String(error)}`)
    return undefined
  }
  if (auth === null || auth.kind !== 'bearer') return undefined
  const who = await fetchIdentity($, { auth: auth.handle }).catch(async error => {
    await debug($, `asking whom the session's sign-in belongs to failed: ${String(error)}`)
    return undefined
  })
  if (who === undefined) return undefined
  return (await getView($)).accounts.find(a => isLoginOf(a, who)) ?? 'other'
}

/** One check at a time whether the pending switch has landed: a check asked for meanwhile is dropped, as the one under way answers it. */
async function settleOnce($: Host, isResponse: boolean): Promise<void> {
  if (isSettling) return
  isSettling = true
  try {
    await settlePending($, isResponse)
  } finally {
    isSettling = false
  }
}

/**
 * After a switch: which login is the session's sign-in now? The new one
 * confirms the switch. Claude Code reads it again only before a request, so
 * another says the switch did not take only once a request went out SETTLE_MS
 * after it, and minutes have passed: the session goes back to that one, the
 * login it left or not. With none yet, the next request will read the new one:
 * SETTLE_MS on, the switch shows as made (due), and the first request after
 * confirms it. Where the session's sign-in can't be asked about, the latest
 * response's usage tells, once SETTLE_MS has passed; then only a response to
 * such a request, still answered by the old login minutes later, is reported.
 * A response always asks. The timers ask only once a request has gone out
 * since the switch, as until then Claude Code holds the sign-in it held, and
 * only while a verdict can still come: an idle session's switch, shown as
 * made, has nothing new to tell until a request.
 */
async function settlePending($: Host, isResponse: boolean): Promise<void> {
  const { pending, accounts } = await getView($)
  if (pending === undefined) return
  const at = await $.clock.now()
  if (!isResponse) {
    if (!hasSentSince(pending) || !isAwaited(pending)) {
      if (at - pending.since >= SETTLE_MS) await dueFor($, pending)
      return
    }
    if (pending.isDue === true) checks += 1
  }
  // Before asking: a request that goes out while the answer is on its way was not read for yet. Nor, on a timer, was one that only just set out.
  const hasRequested = isTried(pending) && (isResponse || (lastRequestAt !== undefined && at - lastRequestAt >= REREAD_MS))
  const live = await liveAccount($)
  const now = await $.clock.now()
  const isLate = now - pending.since > CONFIRM_GIVE_UP_MS
  if (live !== undefined) {
    if (live !== 'other' && live.id === pending.id) await confirmPending($, pending)
    else if (hasRequested && isLate) await giveUpPending($, pending, live === 'other' ? undefined : live)
    else if (now - pending.since >= SETTLE_MS) await dueFor($, pending)
    return
  }
  if (now - pending.since < SETTLE_MS) return
  const reading = readingFromLimits((await $.session.usage()).rateLimits, now)
  const target = accounts.find(a => a.id === pending.id)
  // Only a response changes what the session's usage says: a check on the minute takes a reading any session took lately. The one that shows the switch as made asks.
  if (target !== undefined) await checkAccount($, target, isResponse || pending.isDue !== true)
  if (sameUsage(reading, (await getView($)).readings[pending.id], now)) {
    await confirmPending($, pending)
  } else if (isResponse && isLate && hasRequested) {
    const from = accounts.find(a => a.id === pending.from)
    if (from !== undefined) await checkAccount($, from, true)
    const isFrom = from !== undefined && sameUsage(reading, (await getView($)).readings[from.id], now)
    await giveUpPending($, pending, isFrom ? from : undefined)
  } else await dueFor($, pending)
}

type Pending = NonNullable<View['pending']>

/** Whether `pending` is still the switch the session waits on: another may have taken its place meanwhile. */
const isStill = (v: View, pending: Pending) => v.pending?.id === pending.id && v.pending.since === pending.since

/**
 * Whether a request went out once `pending` could land: Claude Code read the
 * sign-in again before it, so what follows tells whether the switch took.
 */
const isTried = (pending: Pending) => lastRequestAt !== undefined && lastRequestAt >= pending.since + SETTLE_MS

/**
 * Whether a request has gone out since `pending` was made: only then can
 * Claude Code hold another sign-in than before it.
 */
const hasSentSince = (pending: Pending) => lastRequestAt !== undefined && lastRequestAt >= pending.since

/**
 * Whether a verdict on `pending` may still come: until it shows as made, and
 * after a request that tests it, for AWAIT_CHECKS of the minute's checks,
 * however long they take to come. Past that the session idles on the new
 * login, as far as anyone can tell, until its next request.
 */
const isAwaited = (pending: Pending) => pending.isDue !== true || (isTried(pending) && checks < AWAIT_CHECKS)

/** Says, unless the switch was quiet or it was said already, that the session switched. */
function toastSwitched($: Host, view: View, pending: Pending): void {
  if (pending.why === undefined) return
  const target = view.accounts.find(a => a.id === pending.id)
  $.ui.toast(`Switched to Claude account ${target === undefined ? pending.id : label(target)}: ${pending.why}.`, { timeoutMs: 6000 })
}

/** The switch has landed: the account switched to shows in use, steady, and a toast says so, unless it was quiet or said already. */
async function confirmPending($: Host, pending: Pending): Promise<void> {
  untaken.delete(pending.id)
  const view = await getView($)
  if (!isStill(view, pending)) return
  await setView($, v => (isStill(v, pending) ? { ...v, pending: undefined } : v))
  toastSwitched($, view, view.pending ?? pending)
}

/**
 * SETTLE_MS on, with no request to show the switch since: Claude Code reads
 * the new sign-in before the next one, so the switch shows as made, and is
 * told; the first request after confirms it, or finds it did not take.
 */
async function dueFor($: Host, pending: Pending): Promise<void> {
  const view = await getView($)
  const current = view.pending
  if (current === undefined || !isStill(view, pending) || current.isDue === true) return
  await setView($, v => (v.pending !== undefined && isStill(v, pending) ? { ...v, pending: { ...v.pending, isDue: true, why: undefined } } : v))
  toastSwitched($, view, current)
}

/**
 * The switch did not take, minutes on. Still on `from`, the login its
 * requests go out as, the session is pointed back at it, and it shows in use
 * again, as it is the one spending; the rotation leaves the other be. Where
 * that is no login on the list, or can't be told, it says so.
 */
async function giveUpPending($: Host, pending: Pending, from: Account | undefined): Promise<void> {
  if (!isStill(await getView($), pending)) return
  if (from === undefined) {
    await setView($, v => (isStill(v, pending) ? { ...v, pending: undefined } : v))
    tell($, `The switch to Claude account ${pending.id} has not shown in responses.`)
    return
  }
  untaken.add(pending.id)
  try {
    await useSlot($, from.slot)
    movedAt = await $.clock.now()
  } catch (error) {
    await debug($, `switch back failed: ${String(error)}`)
  }
  // Another switch made meanwhile is the one waited on now: its own check says how it went.
  const after = await setView($, v => (isStill(v, pending) ? { ...v, activeId: from.id, pending: undefined } : v))
  if (after.pending !== undefined || after.activeId !== from.id) return
  tell(
    $,
    `The switch to Claude account ${pending.id} did not take: responses still use account ${label(from)}, so it shows in use again. ` +
      `The rotation leaves account ${pending.id} be in this session; Use now tries it again.`,
  )
}

/** A response's own usage: the active login's, unless a switch is still settling. */
async function onMeasure($: Host, limits: readonly SessionRateLimit[]): Promise<void> {
  if ((await getView($)).pending !== undefined) await settleOnce($, true)
  // Still unsettled, the response may be either login's.
  const view = await getView($)
  if (view.pending !== undefined) return
  const reading = readingFromLimits(limits, await $.clock.now())
  if (reading === undefined) return
  // A response reports the 5-hour window and the week, not a model's own week: the usage check's stays.
  await saveReading($, view.activeId, withModelWeeks(reading, view.readings[view.activeId]))
  await maybeRotate($)
}

/** A turn that died on a usage limit or a rejected sign-in: switch, then carry on. */
async function onStopFailure($: Host, error: string): Promise<void> {
  if (error !== 'rate_limit' && error !== 'authentication_failed') return
  const view = await getView($)
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active === undefined) return
  const { pending } = view
  if (pending !== undefined && (await $.clock.now()) - pending.since < SETTLE_MS) {
    // Claude Code rereads a sign-in at most every 30 s: so soon after a switch, the turn may have gone out
    // as the login the session left. The usage endpoint says which one is spent or locked; neither is presumed.
    const from = view.accounts.find(a => a.id === pending.from)
    if (from !== undefined) await checkAccount($, from, true)
    await checkAccount($, active, true)
    if (!shouldLeave(await getView($), await $.clock.now())) {
      if (isConnectingChrome) isCutByVisit = true
      // Once the switch lands, as a turn the switch itself cut short would.
      else $.clock.after(Math.max(0, pending.since + SETTLE_MS - (await $.clock.now())), () => void $.prompt.submit({ text: CONTINUE }))
      return
    }
  } else if (error === 'authentication_failed') {
    const before = await saveHealth($, active.id, { kind: 'login-needed', why: 'sign-in rejected' })
    if (before?.kind !== 'login-needed') await announceLockout($, active, 'sign-in rejected')
  } else {
    await checkAccount($, active, true)
    const now = await $.clock.now()
    const after = await getView($)
    if (!shouldLeave(after, now)) {
      // The limit was hit before the usage call shows it: count the window that limits the login as full.
      await saveReading($, active.id, spentReading(after.readings[active.id], now, viewScope(after)))
    }
  }
  await setView($, v => ({ ...v, pending: undefined }))
  if (await maybeRotate($)) {
    $.clock.after(SETTLE_MS, () => void $.prompt.submit({ text: CONTINUE }))
  } else if (isConnectingChrome) isCutByVisit = true
}

// ---------------------------------------------------------------- Claude in Chrome
// The Chrome extension answers only connections made as the claude.ai account
// it is signed in to. Claude in Chrome connects at its first call, as the login
// the session's requests use then, and keeps that until it reconnects. So
// Connect moves the session to the extension's account and connects there: as
// the session opens, while it can still move, and when a browser call finds no
// browser. The connection stays as the rotation moves the session on.

type ChromeAnswer = 'paired' | 'unpaired' | 'failed' | 'absent'

/** Claude was held back from the browser, or found none: once Claude in Chrome connects, it is told to carry on. */
let isChromeAwaited = false
/** Connect found no browser as the extension's account: until one answers, a browser call that finds none asks the person instead. */
let hasChromeMissed = false
/** The mod's own call to Claude in Chrome is under way: Connect does not hold it back. */
let isAskingChrome = false
/** A turn hit a usage limit while Connect held the session on the extension's account: it carries on once the session is back. */
let isCutByVisit = false

/**
 * Asks Claude in Chrome which browsers answer, connecting it if this session
 * has not yet: 'failed' when it could not tell (no connection, or no answer in
 * time), 'absent' in a session without Claude in Chrome.
 */
async function askChrome($: Host): Promise<ChromeAnswer> {
  let answer: McpToolResult | undefined
  isAskingChrome = true
  try {
    const late = $.clock.sleep(CHROME_WAIT_MS).then(() => undefined)
    answer = await Promise.race([$.mcp.call(CHROME_SERVER, 'list_connected_browsers', {}), late])
  } catch (error) {
    // No Claude in Chrome tools in this session, or a hook refused the call.
    await debug($, `Claude in Chrome not reached: ${String(error)}`)
    return 'absent'
  } finally {
    isAskingChrome = false
  }
  if (answer === undefined || answer.isError) return 'failed'
  const browsers = browsersFrom(answer.content.map(block => block.text ?? '').join(''))
  return browsers === undefined ? 'failed' : browsers > 0 ? 'paired' : 'unpaired'
}

/** With no account named for the Chrome extension yet, the one a browser answered as is it, for every session. */
async function learnChrome($: Host, account: Account): Promise<void> {
  if ((await getView($)).chromeAccountId !== undefined) return
  await setChromeAccount($, account.id)
  tell($, `Claude in Chrome connects as Claude account ${label(account)}: your Chrome extension is signed in to it.`)
}

/**
 * What an answer tells, Claude in Chrome having connected as `as`: whether the
 * session has it, how its connection stands, whether the Chrome box lists the
 * account, and, a browser answering, the extension's account. A guess at
 * Claude Code's login that finds none is kept, so it is not tried again.
 */
async function noteChrome($: Host, as: Account, answer: ChromeAnswer): Promise<void> {
  if (answer === 'absent' || answer === 'failed') {
    await setView($, v => ({ ...v, hasChrome: answer === 'failed' }))
    return
  }
  const isPaired = answer === 'paired'
  await setView($, v => ({
    ...v,
    hasChrome: true,
    chrome: { as: as.id, isPaired, ...(!isPaired && v.chrome?.hasFailed ? { hasFailed: true } : {}) },
  }))
  await noteChromeAccount($, as.id, isPaired)
  if (isPaired) await learnChrome($, as)
  else if ((await getView($)).chromeAccountId === undefined && as.slot === '') await $.store.set('chrome-miss', as.id)
}

/**
 * Before the session moves off the login it is on: where that is the account
 * the Chrome extension is signed in to (or, none named yet, Claude Code's
 * login, where it most often is), connects Claude in Chrome there first, once a
 * session. The connection keeps that account as the session moves on.
 */
async function keepChrome($: Host): Promise<void> {
  const view = await getView($)
  if (view.chrome !== undefined || view.hasChrome === false || isConnectingChrome) return
  // Until a switch lands, the connection could be made as either login.
  if (movedAt !== undefined && (await $.clock.now()) - movedAt < SETTLE_MS) return
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active === undefined) return
  const isGuess = view.chromeAccountId === undefined && active.slot === '' && (await $.store.get('chrome-miss')) !== active.id
  if (view.chromeAccountId !== active.id && !isGuess) return
  await noteChrome($, active, await askChrome($))
}

/**
 * Whether the session connects Claude in Chrome as it opens: an account is
 * named for the extension, and the session is on it, or can visit it: signed
 * in, with room, and a browser answered there last time. Later, a session
 * Claude Code stops from switching couldn't go there. A spent one is left be:
 * a prompt sent during the visit would go out as it and hit its limit. One no
 * browser answered as, while another did, is likely the extension's no more.
 * Either connects at the first browser call that finds no browser instead.
 */
function shouldConnectAtOpen(view: View, now: number): boolean {
  const target = view.accounts.find(a => a.id === view.chromeAccountId)
  if (target === undefined || !canConnectChrome(view)) return false
  if (target.id === view.activeId) return true
  const health = view.health[target.id]?.kind
  const answered = view.chromeAccountIds ?? []
  return (
    health !== 'login-needed' &&
    health !== 'logging-in' &&
    !isSpent(view.readings[target.id], now, viewScope(view)) &&
    (answered.length === 0 || answered.includes(target.id))
  )
}

/**
 * Connect: visits the account the Chrome extension is signed in to, or one
 * tried for it, as Claude Code connects Claude in Chrome with the sign-in the
 * session uses: moves the session there, has Claude in Chrome connect once the
 * move lands (again, where it connected before), asks which browsers answer,
 * and moves back. The connection stays. Then Claude carries on: held back from
 * the browser, or cut by a usage limit on the way. Quiet as the session opens:
 * the pane says how it went. Answers what the browsers did, where it asked them.
 */
function connectChrome($: Host, isQuiet = false, tryId?: string, start?: Account): Promise<ChromeAnswer | undefined> {
  if (isConnectingChrome) return Promise.resolve(undefined)
  isConnectingChrome = true
  return (async () => {
    let done: { target: Account; answer: ChromeAnswer; isVisit: boolean } | undefined
    try {
      done = await connectingChrome($, isQuiet, tryId, start)
    } finally {
      isConnectingChrome = false
      await setView($, v => ({ ...v, chromeConnecting: undefined }))
    }
    // A new session that was to start elsewhere, and Connect never ran: it moves there now.
    if (done === undefined && start !== undefined) await switchTo($, start, await startReason($, start), { isOpening: true })
    const isMoved = (await maybeRotate($)) || done?.isVisit === true
    const isConnected = done?.answer === 'paired' && isChromeAwaited
    const text = isConnected && done !== undefined ? `Claude in Chrome is connected as Claude account ${label(done.target)}. Continue where you left off.` : isCutByVisit ? CONTINUE : undefined
    if (isConnected) isChromeAwaited = false
    isCutByVisit = false
    if (text !== undefined) {
      // Once the move back lands: until then the turn's requests may go out as the extension's account.
      if (isMoved) $.clock.after(SETTLE_MS, () => void $.prompt.submit({ text }))
      else void $.prompt.submit({ text })
    }
    return done?.answer
  })()
}

/**
 * Use for Chrome, on an account a browser answered as, or Try to connect, on
 * another: Claude in Chrome connects as the account, which once a browser
 * answers there is the extension's, in this session now and in every session
 * from now on. Where none answers, the Chrome box lists it no more, and Claude
 * in Chrome connects again as the account picked before.
 */
async function tryChromeAccount($: Host, id: string): Promise<void> {
  const answer = await connectChrome($, false, id)
  const picked = (await getView($)).chromeAccountId
  if (answer === 'paired') await setView($, v => ({ ...v, isChromeOthersShown: false }))
  else if ((answer === 'unpaired' || answer === 'failed') && picked !== undefined && picked !== id) await connectChrome($)
}

async function connectingChrome(
  $: Host,
  isQuiet: boolean,
  tryId: string | undefined,
  start?: Account,
): Promise<{ target: Account; answer: ChromeAnswer; isVisit: boolean } | undefined> {
  const view = await getView($)
  const target = view.accounts.find(a => a.id === (tryId ?? view.chromeAccountId))
  const from = view.accounts.find(a => a.id === view.activeId)
  if (target === undefined || from === undefined || !canConnectChrome({ ...view, chromeAccountId: target.id })) return undefined
  // Tried for the extension: the account picked before stays its own until a browser answers as this one.
  const isTrial = target.id !== view.chromeAccountId
  const turning = await refreshingSoon($, view, target, await $.clock.now())
  if (turning !== undefined) {
    if (!isQuiet) tell($, `Chrome can connect as account ${target.id} once account ${turning.account.id}'s token has refreshed: try again in a few minutes.`)
    return undefined
  }
  await setView($, v => ({ ...v, chromeConnecting: target.id }))
  const isVisit = from.id !== target.id
  if (isVisit && !(await switchTo($, target, 'Claude in Chrome connects as it', { isQuiet: true }))) return undefined
  const wait = movedAt === undefined ? 0 : movedAt + SETTLE_MS - (await $.clock.now())
  if (wait > 0) await $.clock.sleep(wait)
  // A connection made before, as whichever login the session was on then, is made again as this one.
  const before = await getView($)
  if (before.chrome !== undefined || before.hasChrome === true) {
    try {
      await $.command.run({ command: 'mcp', args: `reconnect ${CHROME_SERVER}` })
    } catch (error) {
      await debug($, `/mcp reconnect ${CHROME_SERVER} failed: ${String(error)}`)
    }
  }
  const answer = await askChrome($)
  if (isTrial && answer === 'paired') await setChromeAccount($, target.id)
  await noteChrome($, target, answer)
  // Whether a browser answers as the extension's account: a trial that found none didn't ask there.
  if (!isTrial || answer === 'paired') hasChromeMissed = answer === 'unpaired'
  if (answer === 'paired') {
    // A browser answering as the account shows the switch took: the rotation need not wait for a response to say so.
    untaken.delete(target.id)
    await setView($, v => (v.pending?.id === target.id ? { ...v, pending: undefined } : v))
  }
  // Back to the login the session was on, or on to the one a new session starts on.
  const to = start ?? from
  if (to.id !== target.id) await leaveVisit($, to, start === undefined ? undefined : await startReason($, start))
  // The visit is where the new session stays: said as any switch is, once made.
  else if (start !== undefined && isVisit) toastSwitched($, await getView($), { id: start.id, from: from.id, since: 0, why: await startReason($, start) })
  if (!isQuiet && answer === 'paired') tell($, `Claude in Chrome is connected as Claude account ${label(target)}.`)
  if (!isQuiet && answer === 'unpaired') {
    const back = isTrial ? view.accounts.find(a => a.id === view.chromeAccountId) : undefined
    tell(
      $,
      `No Chrome extension answers as Claude account ${label(target)}. Open Chrome and check its Claude extension is signed in with that email; if it is, restart Chrome${isTrial ? ' and try again' : ''}.` +
        (back === undefined ? '' : ` Claude in Chrome goes back to account ${label(back)}.`),
    )
  }
  return { target, answer, isVisit }
}

/**
 * After Connect's visit: to `to`, the login the session was on or the one a
 * new session starts on, while it can serve, or with the rotation off; else on
 * to the one the rotation picks. The extension's account's usage is not the
 * session's to spend. Quietly back, or said, with `why`, for a new session.
 */
async function leaveVisit($: Host, to: Account, why?: string): Promise<void> {
  const now = await $.clock.now()
  const view = await getView($)
  const health = view.health[to.id]?.kind
  const canServe = health !== 'login-needed' && health !== 'logging-in' && !shouldLeave({ ...view, activeId: to.id }, now)
  if (view.rotateTo === 'off' || canServe) {
    await switchTo($, to, why ?? 'back from connecting Claude in Chrome', { isQuiet: why === undefined })
    return
  }
  const target = pickTarget({ ...view, accounts: view.accounts.filter(a => !untaken.has(a.id)) }, now)
  if (target !== undefined) await switchTo($, target, whyLeave({ ...view, activeId: to.id }, now))
}

/**
 * After a call to one of Claude in Chrome's tools. One answered marks the
 * connection paired and, as the session's first, names the extension's
 * account where none is. One that found no browser marks it so, for the band,
 * and returns what Claude reads in place of Claude Code's advice to /login:
 * that the mod connects it now, or what to ask the person.
 */
async function onBrowserCall($: Host, isUnanswered: boolean): Promise<string | undefined> {
  const view = await getView($)
  const isSure = movedAt === undefined || (await $.clock.now()) - movedAt >= SETTLE_MS
  const as = view.chrome?.as ?? (isSure ? view.activeId : undefined)
  const chrome = { ...(as === undefined ? {} : { as }), isPaired: !isUnanswered, ...(isUnanswered ? { hasFailed: true } : {}) }
  const after = await setView($, v => ({ ...v, hasChrome: true, chrome }))
  if (!isUnanswered) {
    hasChromeMissed = false
    if (as !== undefined) await noteChromeAccount($, as, true)
    const active = view.accounts.find(a => a.id === view.activeId)
    if (view.chrome === undefined && isSure && active !== undefined) await learnChrome($, active)
    return undefined
  }
  if (after.chromeAccountId === undefined) {
    isChromeAwaited = true
    return chromeNote(after, 'unset')
  }
  // Where Connect can't run: connected as the extension's account already, so Chrome may be closed, or the session can't move there.
  if (!canConnectChrome(after)) return chromeNote(after, after.chrome?.as === after.chromeAccountId ? 'no-browser' : 'blocked')
  isChromeAwaited = true
  if (hasChromeMissed) return chromeNote(after, 'no-browser')
  // Once this hook is done: the turn waits on it, and Connect's /mcp reconnect waits on the turn.
  $.clock.after(0, () => void connectChrome($).catch(error => debug($, `Chrome connect failed: ${String(error)}`)))
  return chromeNote(after, 'connecting')
}

// ---------------------------------------------------------------- sign-in

/** Signs one login in through the browser; its slot gets the new credential. */
async function signIn($: Host, account: Account): Promise<void> {
  const since = await $.clock.now()
  await saveHealth($, account.id, { kind: 'logging-in', since })
  const argv = ['claude', 'auth', 'login', '--claudeai', ...(account.email ? ['--email', account.email] : [])]
  // The child opens the browser itself. The link it prints is the paste-a-code
  // flow, which a background child cannot finish, so stdout goes unread.
  const child = $.process.spawn({ argv, env: slotEnv(account.slot) })
  running = child
  signingIn = account.id
  let errors = ''
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') errors += text
    }
  } catch (error) {
    errors += String(error)
  } finally {
    running = undefined
    signingIn = undefined
  }
  // After Cancel's return(), Claude Code fulfills the result with undefined, against
  // its type. Reading r.code then would throw past the save below, stuck at 'logging-in'.
  const code = await child.result.then(r => r?.code ?? null, () => null)
  await saveHealth($, account.id, { kind: 'login-needed', why: 'sign-in not finished' })
  if (code !== 0) {
    tell($, `Sign-in for Claude account ${account.id} did not finish${errors.trim() ? `: ${errors.trim().slice(0, 160)}` : '.'}`)
    return
  }
  await adoptSignIn($, account)
}

/** After a browser sign-in: who signed in, and is it a login already on the list? */
async function adoptSignIn($: Host, account: Account): Promise<void> {
  const who = await signedInAs($, account.slot)
  const accounts = await loadAccounts($)
  const twin = who === undefined ? undefined : accounts.find(a => a.id !== account.id && sameLogin(a, who))
  if (twin !== undefined) {
    await saveHealth($, account.id, { kind: 'login-needed', why: `that was account ${label(twin)} again` })
    tell(
      $,
      `Claude account ${account.id} signed in as account ${label(twin)}. Sign out of claude.ai in your browser (or pick another organization), then sign in again.`,
    )
    return
  }
  const updated = accounts.map(a => (a.id === account.id && who !== undefined ? { ...a, ...who } : a))
  await saveAccounts($, updated)
  await saveHealth($, account.id, { kind: 'ok' })
  const fresh = updated.find(a => a.id === account.id) ?? account
  await checkAccount($, fresh, true)
  await maybeRotate($)
}

function queueSignIn(work: () => Promise<void>): Promise<void> {
  signInQueue = signInQueue.then(work, work)
  return signInQueue
}

/** Signs in, one after another, every login that needs it. */
const signInAll = ($: Host) =>
  queueSignIn(async () => {
    const view = await getView($)
    for (const account of view.accounts.filter(a => view.health[a.id]?.kind === 'login-needed')) {
      await signIn($, account)
    }
  })

const signInOne = ($: Host, id: string) =>
  queueSignIn(async () => {
    const account = (await getView($)).accounts.find(a => a.id === id)
    if (account !== undefined) await signIn($, account)
  })

/** Adds a login in a new slot under ~/.claude/accounts and signs it in. */
async function addAccount($: Host): Promise<void> {
  const accounts = await loadAccounts($)
  const id = freeId(accounts)
  const slot = `${(await $.env.get('HOME')) ?? ''}/.claude/accounts/${id}`
  await $.fs.write(`${slot}/README`, `Claude account ${id}, kept by the account-rotator mod.\n`)
  await saveAccounts($, [...accounts, { id, slot }])
  await saveHealth($, id, { kind: 'login-needed', why: 'not signed in yet' })
  await signInOne($, id)
}

/** The second press of Remove: signs the slot out, then drops it from the list. */
async function removeAccount($: Host, id: string): Promise<void> {
  const view = await getView($)
  const account = view.accounts.find(a => a.id === id)
  if (account === undefined || account.slot === '') return
  if (view.activeId === id) {
    const other = view.accounts.find(a => a.id !== id && view.health[a.id]?.kind === 'ok')
    if (other === undefined || !(await switchTo($, other, `account ${id} is being removed`))) {
      tell($, `Claude account ${id} is in use and no other account can take over yet; not removed.`)
      return
    }
  }
  await $.process.run(['claude', 'auth', 'logout'], { env: slotEnv(account.slot), timeoutMs: 20_000 })
  await saveAccounts($, view.accounts.filter(a => a.id !== id))
  if (view.chromeAccountId === id) await setChromeAccount($, undefined)
  await noteChromeAccount($, id, false)
  await $.store.delete(`reading:${id}`)
  await $.store.delete(`usage:${id}`)
  await $.store.delete(claimKey(id))
  await $.store.delete(`health:${id}`)
  await $.store.delete(`holder:${id}`)
  await setView($, v => {
    const readings = { ...v.readings }
    const health = { ...v.health }
    const holders = { ...v.holders }
    delete readings[id]
    delete health[id]
    delete holders[id]
    return { ...v, readings, health, holders, removing: undefined }
  })
}

// ---------------------------------------------------------------- wiring

/**
 * Whether the footer's in-use mark is drawn now: always, but in the off beats
 * of a pending switch's blink. The beat is read only while one is pending, so
 * only then does each beat draw the footer again. Where no watch blinks it,
 * as after a hot reload, which stops timers, the mark stays lit.
 */
async function markLit($: Host, view: View): Promise<boolean> {
  return view.pending === undefined || view.pending.isDue === true || watch === undefined || (await read($, blinkAtom))
}

/** The footer's one press: opens the pane, or closes it while it shows. */
function togglePane($: Host): Promise<unknown> {
  isPaneShown = !isPaneShown
  return isPaneShown ? $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS }) : $.ui.close({ id: PANE })
}

/** After a /login, which signs in the login this session is on: who it is now, and a move off it when that is another login's account. */
async function checkActive($: Host): Promise<void> {
  const view = await getView($)
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active !== undefined) await checkAccount($, active, true)
  await maybeRotate($)
}

/** Rotate now: moves to the login the pane's Rotation setting picks, as the rotation would once this one runs low; with it off, the most room. */
async function rotate($: Host): Promise<void> {
  const view = await getView($)
  const target = pickTarget(view, await $.clock.now())
  if (target === undefined) tell($, 'No other Claude account can take over right now.')
  else await switchTo($, target, 'you pressed Rotate now')
}

/** Every press starts its work in the background: a sign-in outlives the press. */
function actions($: Host): Actions {
  const background = (work: Promise<unknown>) => {
    work.catch(error => tell($, `Something went wrong: ${String(error)}`))
  }
  return {
    togglePane: () => background(togglePane($)),
    rotate: () => background(rotate($)),
    signInAll: () => background(signInAll($)),
    signInOne: id => background(signInOne($, id)),
    cancelSignIn: () => background(Promise.resolve(running?.return({ code: null, signal: 'SIGTERM' }))),
    add: () => background(addAccount($)),
    use: id =>
      background(
        getView($).then(view => {
          const account = view.accounts.find(a => a.id === id)
          return account === undefined ? false : switchTo($, account, 'you picked it', { isPicked: true })
        }),
      ),
    askRemove: id => background(setView($, v => ({ ...v, removing: id }))),
    remove: id => background(removeAccount($, id)),
    setFooter: change => background(setFooter($, change)),
    setRotateTo: rotateTo => background(setRotateTo($, rotateTo)),
    setStartOn: startOn => background(setStartOn($, startOn)),
    tryChromeAccount: id => background(tryChromeAccount($, id)),
    toggleChromeOthers: () => background(setView($, v => ({ ...v, isChromeOthersShown: !v.isChromeOthersShown }))),
    connectChrome: () => background(connectChrome($)),
    setDemo: on => background(setView($, v => ({ ...v, demo: on }))),
  }
}

/** Notes the main loop's model; true where it changed, and the rotation should look again: the new one may have a week of its own. */
async function noteModel($: Host, model: string): Promise<boolean> {
  if (model === (await getView($)).model) return false
  await setView($, v => ({ ...v, model }))
  return true
}

/** First run makes the normal login number 1; then: which login this session uses, and Claude in Chrome connected as the extension's account. */
async function boot($: Host, isInteractive: boolean): Promise<void> {
  // Terminal.app is the terminal that names itself so and draws block characters from its font.
  const hasFontBlocks = (await $.env.get('TERM_PROGRAM')) === 'Apple_Terminal'
  await setView($, v => ({ ...v, hasFontBlocks }))
  let accounts = await loadAccounts($)
  if (accounts.length === 0) {
    accounts = [{ id: '1', slot: '' }]
    await saveAccounts($, accounts)
  }
  const slot = (await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR')) ?? ''
  let active = accounts.find(a => a.slot === slot)
  if (active === undefined) {
    // Started on a slot nobody registered (set by hand, or by another tool): adopt it.
    active = { id: freeId(accounts), slot }
    accounts = [...accounts, active]
    await saveAccounts($, accounts)
  }
  const activeId = active.id
  const sessionId = await $.session.id().catch(() => undefined)
  const model = await $.session.model().catch(() => undefined)
  // The mod starts again at every reload of its code, in a session by then at work: only its first start is a window opening.
  const isOpening = (await getView($)).hasStarted !== true
  await mergeStore($)
  await setView($, v => ({ ...v, activeId, hasStarted: true, ...(sessionId === undefined ? {} : { sessionId }), ...(model === undefined ? {} : { model }) }))
  await checkSwitching($, slot)
  // A window opening on Claude Code's login, with "a fresh 5-hour window" picked, may start elsewhere.
  const opened = await getView($)
  const isStarting = isInteractive && isOpening && slot === '' && opened.startOn === 'fresh' && opened.isSwitchBlocked !== true
  // The pick goes by readings taken now, as far as the logins can be read: the store's may be old, and say nothing of a sign-in lost since.
  if (isStarting) await checkAccounts($)
  const start = isStarting
    ? await startPick($).catch(async error => {
        await debug($, `picking where to start failed: ${String(error)}`)
        return undefined
      })
    : undefined
  const startOn = start !== undefined && start.id !== activeId ? start : undefined
  // First, while the session can still move: the rotation waits for it. Connect's visit ends where the session starts.
  if (isInteractive && shouldConnectAtOpen(await getView($), await $.clock.now())) {
    void connectChrome($, true, undefined, startOn).catch(error => debug($, `Chrome connect failed: ${String(error)}`))
  } else if (startOn !== undefined) {
    // A move that fails leaves the session on Claude Code's login, and the checks below their turn.
    await switchTo($, startOn, await startReason($, startOn), { isOpening: true }).catch(error => debug($, `starting on account ${startOn.id} failed: ${String(error)}`))
  }
  // A live sign-in names its login as it checks; one whose token has run out, from what `claude auth login` left in its folder.
  if (isStarting) await maybeRotate($)
  else await checkAll($)
  for (const account of (await loadAccounts($)).filter(a => a.email === undefined || a.orgId === undefined)) {
    const who = await signedInAs($, account.slot)
    if (who === undefined) continue
    const latest = await loadAccounts($)
    await saveAccounts($, latest.map(a => (a.id === account.id ? { ...a, ...who } : a)))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void boot($, e.isInteractive).catch(error => debug($, `start failed: ${String(error)}`))
    void $.ui.panes().then(panes => {
      isPaneShown = panes.some(p => p.id === PANE && p.isShown)
    })
    $.clock.every(60_000, () => {
      void mergeStore($)
        .then(() => settleOnce($, false))
        .then(() => maybeRotate($))
        .catch(error => debug($, `sync failed: ${String(error)}`))
    })
    $.clock.every(10 * 60_000, () => {
      void checkAll($).catch(error => debug($, `check failed: ${String(error)}`))
    })
    return started
  })

  // Claude Code reads the sign-in again just before a request: the profile check is sure of a switch only after one.
  on('turn.step', async function* ($, e, next) {
    lastRequestAt = await $.clock.now()
    checks = 0
    // The main loop's model, where no /model told it; a subagent's requests name their own.
    if (e.agentId === undefined && (await noteModel($, e.model))) {
      void maybeRotate($).catch(error => debug($, `rotate failed: ${String(error)}`))
    }
    return yield* next(e)
  })

  // A /model, as it is made: where the new model's own week is spent on the account in use, the session moves before its next request.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (await noteModel($, e.to_model)) void maybeRotate($).catch(error => debug($, `rotate failed: ${String(error)}`))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      void onMeasure($, e.rateLimits).catch(error => debug($, `measure failed: ${String(error)}`))
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    void onStopFailure($, e.error).catch(error => debug($, `stop failure handling failed: ${String(error)}`))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Typed at the prompt, /login answers once its sign-in is done; run mid-turn, at once, and the checks find it later.
  on('command.run', { command: 'login' }, async ($, e, next) => {
    const ran = await next(e)
    void checkActive($).catch(error => debug($, `check after /login failed: ${String(error)}`))
    return ran
  }).catch(($, e, next) => next(e))

  // While Connect is under way a browser call would connect as the login being left: Claude waits, and is told when to carry on.
  on('tool.check', { tool: CHROME_TOOL }, async ($, e, next) => {
    if (!isConnectingChrome || isAskingChrome) return next(e)
    if (e.tool_use_id !== undefined) isChromeAwaited = true
    return { decision: 'deny' as const, reason: chromeNote(await getView($), 'held') }
  }).catch(($, e, next) => next(e))

  // Claude Code's words for a browser call that found no browser send the person to /login, which here signs in the wrong account.
  on('tool.call', { tool: CHROME_TOOL }, async ($, e, next) => {
    const done = await next(e)
    // The mod's own question to Claude in Chrome is answered where it asked.
    if (done.deny !== undefined || isAskingChrome) return done
    const note = await onBrowserCall($, isUnansweredCall(e.tool, done.text ?? '', done.isError === true)).catch(async error => {
      await debug($, `browser call handling failed: ${String(error)}`)
      return undefined
    })
    return note === undefined ? done : { ...done, context: [...(done.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isPaneShown = false
    return next(e)
  })


  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const view = await getView($)
    if (view.accounts.length === 0) return next(e)
    const isMarkLit = await markLit($, view)
    return Footer($.ui.resolve(e), view, e.props.modes, await $.clock.now(), actions($), isMarkLit)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const view = await getView($)
    return Band($.ui.resolve(e), view, await $.clock.now(), actions($)) ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await getView($)
    return Pane($.ui.resolve(e), view, await $.clock.now(), actions($))
  })
}
