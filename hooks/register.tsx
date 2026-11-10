import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  McpToolResult,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { Account, FooterStyle, Health, Holder, Reading, RotateTo, View } from '../types'
import {
  CHROME_SERVER,
  CHROME_TOOL,
  EMPTY_VIEW,
  LEAVE_FIVE_HOUR,
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
  isNoBrowser,
  isPolicyRefusal,
  isSpent,
  keychainItem,
  keychainUser,
  label,
  pickTarget,
  rotateToFrom,
  readingFromLimits,
  readingFromUsage,
  sameLogin,
  sameUsage,
  shouldLeave,
  slotEnv,
  stuckText,
  windowPct,
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
let held: { target: Account; why: string; timer: Timer } | undefined
/** Logins a switch to did not take this session: the rotation leaves them be; Use now still tries. */
const untaken = new Set<string>()
/** When this session last moved to another login: until SETTLE_MS after, its requests may still go out as the one before. */
let movedAt: number | undefined
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

async function saveReading($: Host, id: string, reading: Reading): Promise<void> {
  await $.store.set(`reading:${id}`, reading)
  await setView($, v => ({ ...v, readings: { ...v.readings, [id]: reading } }))
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
    const r = await $.store.get(`reading:${a.id}`)
    if (typeof r === 'object' && r !== null && typeof (r as Reading).at === 'number') readings[a.id] = r as Reading
    const h = await $.store.get(`health:${a.id}`)
    if (typeof h === 'object' && h !== null && typeof (h as Health).kind === 'string') health[a.id] = h as Health
    const s = await $.store.get(`holder:${a.id}`)
    if (typeof s === 'object' && s !== null && typeof (s as Holder).token === 'string' && typeof (s as Holder).who?.email === 'string') {
      holders[a.id] = s as Holder
    }
  }
  const footer = footerStyleFrom(await $.store.get('footer'))
  const rotateTo = rotateToFrom(await $.store.get('rotate-to'))
  const chrome = await $.store.get('chrome-account')
  const chromeAccountId = typeof chrome === 'string' && accounts.some(a => a.id === chrome) ? chrome : undefined
  const seen = await $.store.get('chrome-accounts')
  const chromeAccountIds = (Array.isArray(seen) ? seen : []).filter((id): id is string => typeof id === 'string' && accounts.some(a => a.id === id))
  await setView($, v => {
    const nextReadings: Record<string, Reading> = {}
    const nextHealth: Record<string, Health> = {}
    const nextHolders: Record<string, Holder> = {}
    for (const a of accounts) {
      const mine = v.readings[a.id]
      const theirs = readings[a.id]
      const reading = mine !== undefined && (theirs === undefined || mine.at >= theirs.at) ? mine : theirs
      if (reading !== undefined) nextReadings[a.id] = reading
      const own = v.health[a.id]
      const h = signingIn === a.id ? own : (health[a.id] ?? own)
      if (h !== undefined) nextHealth[a.id] = h
      const holder = holders[a.id] ?? v.holders[a.id]
      if (holder !== undefined) nextHolders[a.id] = holder
    }
    return { ...v, accounts, readings: nextReadings, health: nextHealth, holders: nextHolders, footer, rotateTo, chromeAccountId, chromeAccountIds }
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

type UsageAnswer = { kind: 'ok'; body: unknown } | { kind: 'rejected' } | { kind: 'failed'; status: number }

const oauthHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  'anthropic-beta': 'oauth-2025-04-20',
  'Content-Type': 'application/json',
})

/** The usage of the login a token belongs to, as `/usage` reads it. */
async function fetchUsage($: Host, accessToken: string): Promise<UsageAnswer> {
  const res = await $.http.fetch(USAGE_URL, { headers: oauthHeaders(accessToken) })
  if (res.status === 401 || res.status === 403) return { kind: 'rejected' }
  if (!res.ok) return { kind: 'failed', status: res.status }
  try {
    return { kind: 'ok', body: JSON.parse(res.text) }
  } catch {
    // A 2xx that is not JSON counts as a failed call; the next check asks again.
    return { kind: 'failed', status: res.status }
  }
}

/** Who a token signs in, as Claude Code asks at a sign-in: email, organization and plan; undefined when the call fails. */
async function fetchIdentity($: Host, accessToken: string): Promise<Identity | undefined> {
  const res = await $.http.fetch(PROFILE_URL, { headers: oauthHeaders(accessToken) })
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

/** Points this session's requests, and every child it starts after, at a slot's login. */
async function useSlot($: Host, slot: string): Promise<void> {
  if (slot === '') await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined)
  else await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', slot)
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
    if (isPolicyRefusal(error)) await blocked($)
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
  const who = await fetchIdentity($, credential.accessToken)
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
 * Re-reads one login's stored sign-in: who it belongs to and, while its token
 * is live, its usage. One that is another login's on the list leaves this
 * login needing its own, its usage that other's.
 */
async function checkAccount($: Host, account: Account): Promise<void> {
  const now = await $.clock.now()
  if (signingIn === account.id) return
  const stored = await readStored($, account.slot)
  if (stored.state === 'unreadable') {
    tell($, `Could not read Claude account ${account.id} from the keychain (exit ${stored.code}); is it locked?`)
    return
  }
  const credential = stored.state === 'present' ? stored.credential : undefined
  let health = healthOf(credential, now)
  if (health.kind === 'ok' && credential !== undefined) {
    const isLive = credential.expiresAt > now + 60_000
    const holder = await holderOf($, account, credential, isLive)
    const twin = holder === undefined ? undefined : await followSignIn($, account, holder.who)
    if (twin !== undefined) health = { kind: 'login-needed', why: `signed in as account ${twin.id} now` }
    else if (isLive) {
      const usage = await fetchUsage($, credential.accessToken)
      if (usage.kind === 'rejected') health = { kind: 'login-needed', why: 'sign-in rejected' }
      if (usage.kind === 'failed') await debug($, `usage for account ${account.id}: HTTP ${usage.status}`)
      if (usage.kind === 'ok') {
        const reading = readingFromUsage(usage.body, now)
        if (reading !== undefined) await saveReading($, account.id, reading)
      }
    }
  }
  const before = await saveHealth($, account.id, health)
  if (health.kind === 'login-needed' && before?.kind !== 'login-needed') {
    await announceLockout($, account, health.why)
  }
}

async function checkAll($: Host): Promise<void> {
  for (const account of (await getView($)).accounts) {
    try {
      await checkAccount($, account)
    } catch (error) {
      await debug($, `checking account ${account.id} failed: ${String(error)}`)
    }
  }
  await maybeRotate($)
}

/** Why the login in use is left, counted the way the footer shows it: room left, or what is used. */
function whyLeave(view: View, now: number): string {
  if (view.health[view.activeId]?.kind === 'login-needed') return `account ${view.activeId} needs a sign-in`
  const r = view.readings[view.activeId]
  const five = windowPct(r?.fiveHour, now) ?? 0
  const [window, used] = five >= LEAVE_FIVE_HOUR ? ['5-hour window', five] : ['week', windowPct(r?.sevenDay, now) ?? 0]
  return view.footer.fill === 'left'
    ? `account ${view.activeId} has ${Math.round(100 - used)}% of its ${window} left`
    : `account ${view.activeId} has used ${Math.round(used)}% of its ${window}`
}

/**
 * Once the active login is spent or locked out, moves to the one the pane's
 * Rotation setting picks; never while it is off, Claude Code's policy refuses
 * it, or Connect holds the session where it is. Refused, it says once how to
 * get a session that can move: a background session nobody watches gets the
 * notification. Not from a turn that dies on the limit: Claude Code's security
 * default, seated in such a session, passes its StopFailure hook over.
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
  if (isConnectingChrome || view.rotateTo === 'off' || view.pending !== undefined || !shouldLeave(view, now)) return false
  // With none to move to, the band above the prompt says when the next login frees up.
  const target = pickTarget({ ...view, accounts: view.accounts.filter(a => !untaken.has(a.id)) }, now)
  return target === undefined ? false : switchTo($, target, whyLeave(view, now))
}

/** The login in use, when its token refreshes too soon for the refresh guard to let the session leave it for `target`. */
async function refreshingSoon($: Host, view: View, target: Account, now: number): Promise<Account | undefined> {
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active === undefined || active.id === target.id) return undefined
  const stored = await readStored($, active.slot)
  const credential = stored.state === 'present' ? stored.credential : undefined
  const isSoon = credential !== undefined && credential.expiresAt > now && credential.expiresAt - now < REFRESH_GUARD_MS
  return isSoon ? active : undefined
}

/** Points this session at `target`; false while the refresh guard holds it back, or Claude Code's policy refuses it. Quiet: no toast. */
async function switchTo($: Host, target: Account, why: string, isQuiet = false): Promise<boolean> {
  const active = await refreshingSoon($, await getView($), target, await $.clock.now())
  if (active !== undefined) {
    if (held === undefined) {
      tell($, `Switching to Claude account ${target.id} in a few minutes, once account ${active.id}'s token has refreshed.`)
      const retry = () => {
        if (held !== undefined) void switchTo($, held.target, held.why)
      }
      held = { target, why, timer: $.clock.every(60_000, retry) }
    } else held = { ...held, target, why }
    return false
  }
  held?.timer.cancel()
  held = undefined
  await keepChrome($)
  try {
    await useSlot($, target.slot)
  } catch (error) {
    if (!isPolicyRefusal(error)) throw error
    // A press of Use now or Rotate now gets an answer, even once the notice has shown.
    if (!(await blocked($))) tell($, blockedText(await getView($)))
    return false
  }
  const now = await $.clock.now()
  movedAt = now
  await setView($, v => ({
    ...v,
    activeId: target.id,
    pending: { id: target.id, from: v.activeId, since: now },
    removing: undefined,
  }))
  if (!isQuiet) $.ui.toast(`Switched to Claude account ${label(target)}: ${why}.`, { timeoutMs: 6000 })
  return true
}

/**
 * After a switch: which login answered the latest response? The new one
 * (confirmed), or too soon to say. Only a response still answered by the old
 * login minutes later is reported: an idle session has no new response to tell.
 * Then the session is pointed back at the old login, and the footer and pane
 * mark it in use again, as it is the one spending.
 */
async function settlePending($: Host, isResponse: boolean): Promise<void> {
  const { pending, accounts } = await getView($)
  if (pending === undefined) return
  const now = await $.clock.now()
  if (now - pending.since < SETTLE_MS) return
  const reading = readingFromLimits((await $.session.usage()).rateLimits, now)
  const target = accounts.find(a => a.id === pending.id)
  if (target !== undefined) await checkAccount($, target)
  if (sameUsage(reading, (await getView($)).readings[pending.id], now)) {
    untaken.delete(pending.id)
    await setView($, v => ({ ...v, pending: undefined }))
  } else if (isResponse && now - pending.since > CONFIRM_GIVE_UP_MS) {
    const from = accounts.find(a => a.id === pending.from)
    if (from !== undefined) await checkAccount($, from)
    if (from === undefined || !sameUsage(reading, (await getView($)).readings[from.id], now)) {
      await setView($, v => ({ ...v, pending: undefined }))
      tell($, `The switch to Claude account ${pending.id} has not shown in responses.`)
      return
    }
    untaken.add(pending.id)
    try {
      await useSlot($, from.slot)
      movedAt = now
    } catch (error) {
      await debug($, `switch back failed: ${String(error)}`)
    }
    await setView($, v => ({ ...v, activeId: from.id, pending: undefined }))
    tell(
      $,
      `The switch to Claude account ${pending.id} did not take: responses still use account ${label(from)}, so it shows in use again. ` +
        `The rotation leaves account ${pending.id} be in this session; Use now tries it again.`,
    )
  }
}

/** A response's own usage: the active login's, unless a switch is still settling. */
async function onMeasure($: Host, limits: readonly SessionRateLimit[]): Promise<void> {
  const view = await getView($)
  if (view.pending !== undefined) {
    await settlePending($, true)
    return
  }
  const reading = readingFromLimits(limits, await $.clock.now())
  if (reading === undefined) return
  await saveReading($, view.activeId, reading)
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
    if (from !== undefined) await checkAccount($, from)
    await checkAccount($, active)
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
    await checkAccount($, active)
    const now = await $.clock.now()
    const after = await getView($)
    if (!shouldLeave(after, now)) {
      // The limit was hit before the usage call shows it: count the 5-hour window as full.
      const r = after.readings[active.id]
      const resetsAt = r?.fiveHour?.resetsAt
      await saveReading($, active.id, { ...r, fiveHour: { pct: 100, ...(resetsAt ? { resetsAt } : {}) }, at: now })
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
    !isSpent(view.readings[target.id], now) &&
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
function connectChrome($: Host, isQuiet = false, tryId?: string): Promise<ChromeAnswer | undefined> {
  if (isConnectingChrome) return Promise.resolve(undefined)
  isConnectingChrome = true
  return (async () => {
    let done: { target: Account; answer: ChromeAnswer; isVisit: boolean } | undefined
    try {
      done = await connectingChrome($, isQuiet, tryId)
    } finally {
      isConnectingChrome = false
      await setView($, v => ({ ...v, chromeConnecting: undefined }))
    }
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
): Promise<{ target: Account; answer: ChromeAnswer; isVisit: boolean } | undefined> {
  const view = await getView($)
  const target = view.accounts.find(a => a.id === (tryId ?? view.chromeAccountId))
  const from = view.accounts.find(a => a.id === view.activeId)
  if (target === undefined || from === undefined || !canConnectChrome({ ...view, chromeAccountId: target.id })) return undefined
  // Tried for the extension: the account picked before stays its own until a browser answers as this one.
  const isTrial = target.id !== view.chromeAccountId
  const active = await refreshingSoon($, view, target, await $.clock.now())
  if (active !== undefined) {
    if (!isQuiet) tell($, `Chrome can connect as account ${target.id} once account ${active.id}'s token has refreshed: try again in a few minutes.`)
    return undefined
  }
  await setView($, v => ({ ...v, chromeConnecting: target.id }))
  const isVisit = from.id !== target.id
  if (isVisit && !(await switchTo($, target, 'Claude in Chrome connects as it', true))) return undefined
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
  if (isVisit) await leaveVisit($, from)
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
 * After Connect's visit: back to the login the session was on, while it can
 * serve, or with the rotation off; else on to the one the rotation picks. The
 * extension's account's usage is not the session's to spend.
 */
async function leaveVisit($: Host, from: Account): Promise<void> {
  const now = await $.clock.now()
  const view = await getView($)
  const health = view.health[from.id]?.kind
  const canServe = health !== 'login-needed' && health !== 'logging-in' && !shouldLeave({ ...view, activeId: from.id }, now)
  if (view.rotateTo === 'off' || canServe) {
    await switchTo($, from, 'back from connecting Claude in Chrome', true)
    return
  }
  const target = pickTarget({ ...view, accounts: view.accounts.filter(a => !untaken.has(a.id)) }, now)
  if (target !== undefined) await switchTo($, target, whyLeave({ ...view, activeId: from.id }, now))
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
  const code = await child.result.then(r => r.code, () => null)
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
  await checkAccount($, fresh)
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

/** The footer's one press: opens the pane, or closes it while it shows. */
function togglePane($: Host): Promise<unknown> {
  isPaneShown = !isPaneShown
  return isPaneShown ? $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS }) : $.ui.close({ id: PANE })
}

/** After a /login, which signs in the login this session is on: who it is now, and a move off it when that is another login's account. */
async function checkActive($: Host): Promise<void> {
  const view = await getView($)
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active !== undefined) await checkAccount($, active)
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
          return account === undefined ? false : switchTo($, account, 'you picked it')
        }),
      ),
    askRemove: id => background(setView($, v => ({ ...v, removing: id }))),
    remove: id => background(removeAccount($, id)),
    setFooter: change => background(setFooter($, change)),
    setRotateTo: rotateTo => background(setRotateTo($, rotateTo)),
    tryChromeAccount: id => background(tryChromeAccount($, id)),
    toggleChromeOthers: () => background(setView($, v => ({ ...v, isChromeOthersShown: !v.isChromeOthersShown }))),
    connectChrome: () => background(connectChrome($)),
    setDemo: on => background(setView($, v => ({ ...v, demo: on }))),
  }
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
  await mergeStore($)
  await setView($, v => ({ ...v, activeId, ...(sessionId === undefined ? {} : { sessionId }) }))
  await checkSwitching($, slot)
  // First, while the session can still move: the rotation waits for it.
  if (isInteractive && shouldConnectAtOpen(await getView($), await $.clock.now())) {
    void connectChrome($, true).catch(error => debug($, `Chrome connect failed: ${String(error)}`))
  }
  // A live sign-in names its login as it checks; one whose token has run out, from what `claude auth login` left in its folder.
  await checkAll($)
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
        .then(() => settlePending($, false))
        .then(() => maybeRotate($))
        .catch(error => debug($, `sync failed: ${String(error)}`))
    })
    $.clock.every(10 * 60_000, () => {
      void checkAll($).catch(error => debug($, `check failed: ${String(error)}`))
    })
    return started
  })

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
    if (done.deny !== undefined) return done
    const note = await onBrowserCall($, done.isError === true && isNoBrowser(done.text ?? '')).catch(async error => {
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
    return Footer($.ui.resolve(e), view, e.props.modes, await $.clock.now(), actions($))
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
