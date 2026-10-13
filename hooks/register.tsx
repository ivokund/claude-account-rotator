import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  SessionRateLimit,
  Timer,
} from 'claude-code'

import type { Account, FooterStyle, Health, Reading, View } from '../types'
import {
  EMPTY_VIEW,
  LEAVE_FIVE_HOUR,
  credentialFrom,
  credentialsFile,
  footerStyleFrom,
  freeId,
  healthOf,
  identityFromStatus,
  keychainItem,
  keychainUser,
  label,
  pickTarget,
  readingFromLimits,
  readingFromUsage,
  sameLogin,
  sameUsage,
  shouldLeave,
  slotEnv,
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
/** A file only macOS has: there Claude Code keeps logins in the keychain, elsewhere (Linux) in a file each. */
const MACOS_MARKER = '/System/Library/CoreServices/SystemVersion.plist'
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

// ---------------------------------------------------------------- state
// The view is this session's; the store is one JSON file every session of the
// mod shares: the list of logins, each login's last reading and health under a
// key of its own, so sessions writing different logins never collide, and the
// footer's look.

const getView = ($: Host): Promise<View> => read($, viewAtom)
const setView = ($: Host, fn: (v: View) => View): Promise<View> => update($, viewAtom, fn)
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

/** Folds what other sessions stored into this session's view. */
async function mergeStore($: Host): Promise<void> {
  const accounts = await loadAccounts($)
  const readings: Record<string, Reading> = {}
  const health: Record<string, Health> = {}
  for (const a of accounts) {
    const r = await $.store.get(`reading:${a.id}`)
    if (typeof r === 'object' && r !== null && typeof (r as Reading).at === 'number') readings[a.id] = r as Reading
    const h = await $.store.get(`health:${a.id}`)
    if (typeof h === 'object' && h !== null && typeof (h as Health).kind === 'string') health[a.id] = h as Health
  }
  const footer = footerStyleFrom(await $.store.get('footer'))
  await setView($, v => {
    const nextReadings: Record<string, Reading> = {}
    const nextHealth: Record<string, Health> = {}
    for (const a of accounts) {
      const mine = v.readings[a.id]
      const theirs = readings[a.id]
      const reading = mine !== undefined && (theirs === undefined || mine.at >= theirs.at) ? mine : theirs
      if (reading !== undefined) nextReadings[a.id] = reading
      const own = v.health[a.id]
      const h = signingIn === a.id ? own : (health[a.id] ?? own)
      if (h !== undefined) nextHealth[a.id] = h
    }
    return { ...v, accounts, readings: nextReadings, health: nextHealth, footer }
  })
}

/** Changes the footer's look for every session. */
async function setFooter($: Host, change: Partial<FooterStyle>): Promise<void> {
  const footer = { ...(await getView($)).footer, ...change }
  await $.store.set('footer', footer)
  await setView($, v => ({ ...v, footer }))
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

/** The usage of the login a token belongs to, as `/usage` reads it. */
async function fetchUsage($: Host, accessToken: string): Promise<UsageAnswer> {
  const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  })
  if (res.status === 401 || res.status === 403) return { kind: 'rejected' }
  if (!res.ok) return { kind: 'failed', status: res.status }
  try {
    return { kind: 'ok', body: JSON.parse(res.text) }
  } catch {
    // A 2xx that is not JSON counts as a failed call; the next check asks again.
    return { kind: 'failed', status: res.status }
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

// ---------------------------------------------------------------- checks and switching

async function announceLockout($: Host, account: Account, why: string): Promise<void> {
  const text = `Claude account ${label(account)} needs a sign-in (${why}). Click ⚠${account.id} under the prompt.`
  $.ui.toast(text, { timeoutMs: 8000 })
  await $.ui.notify(text, { title: TITLE })
}

/** Re-reads one login's stored sign-in and, while its token is live, its usage. */
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
  if (health.kind === 'ok' && credential !== undefined && credential.expiresAt > now + 60_000) {
    const usage = await fetchUsage($, credential.accessToken)
    if (usage.kind === 'rejected') health = { kind: 'login-needed', why: 'sign-in rejected' }
    if (usage.kind === 'failed') await debug($, `usage for account ${account.id}: HTTP ${usage.status}`)
    if (usage.kind === 'ok') {
      const reading = readingFromUsage(usage.body, now)
      if (reading !== undefined) await saveReading($, account.id, reading)
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

/** Once the active login is spent or locked out, moves to the one that can serve the most right now. */
async function maybeRotate($: Host): Promise<boolean> {
  const now = await $.clock.now()
  const view = await getView($)
  if (view.pending !== undefined || !shouldLeave(view, now)) return false
  // With none to move to, the band above the prompt says when the next login frees up.
  const target = pickTarget(view, now)
  return target === undefined ? false : switchTo($, target, whyLeave(view, now))
}

/** Points this session at `target`; false while the refresh guard holds it back. */
async function switchTo($: Host, target: Account, why: string): Promise<boolean> {
  const now = await $.clock.now()
  const view = await getView($)
  const active = view.accounts.find(a => a.id === view.activeId)
  if (active !== undefined && active.id !== target.id) {
    const stored = await readStored($, active.slot)
    const credential = stored.state === 'present' ? stored.credential : undefined
    if (credential !== undefined && credential.expiresAt > now && credential.expiresAt - now < REFRESH_GUARD_MS) {
      if (held === undefined) {
        tell($, `Switching to Claude account ${target.id} in a few minutes, once account ${active.id}'s token has refreshed.`)
        const retry = () => {
          if (held !== undefined) void switchTo($, held.target, held.why)
        }
        held = { target, why, timer: $.clock.every(60_000, retry) }
      } else held = { ...held, target, why }
      return false
    }
  }
  held?.timer.cancel()
  held = undefined
  await useSlot($, target.slot)
  await setView($, v => ({
    ...v,
    activeId: target.id,
    pending: { id: target.id, from: v.activeId, since: now },
    removing: undefined,
  }))
  $.ui.toast(`Switched to Claude account ${label(target)}: ${why}.`, { timeoutMs: 6000 })
  return true
}

/**
 * After a switch: which login answered the latest response? The new one
 * (confirmed), or too soon to say. Only a response still answered by the old
 * login minutes later is reported: an idle session has no new response to tell.
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
    await setView($, v => ({ ...v, pending: undefined }))
  } else if (isResponse && now - pending.since > CONFIRM_GIVE_UP_MS) {
    await setView($, v => ({ ...v, pending: undefined }))
    tell($, `The switch to Claude account ${pending.id} has not shown in responses; usage still looks like account ${pending.from}.`)
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
  if (error === 'authentication_failed') {
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
  }
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
  await $.store.delete(`reading:${id}`)
  await $.store.delete(`health:${id}`)
  await setView($, v => {
    const readings = { ...v.readings }
    const health = { ...v.health }
    delete readings[id]
    delete health[id]
    return { ...v, readings, health, removing: undefined }
  })
}

// ---------------------------------------------------------------- wiring

/** The footer's one press: opens the pane, or closes it while it shows. */
function togglePane($: Host): Promise<unknown> {
  isPaneShown = !isPaneShown
  return isPaneShown ? $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS }) : $.ui.close({ id: PANE })
}

/** Rotate now: moves to the login that can serve the most right now, as the rotation would once this one runs low. */
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
    setDemo: on => background(setView($, v => ({ ...v, demo: on }))),
  }
}

/** First run makes the normal login number 1; then: which login this session uses. */
async function boot($: Host): Promise<void> {
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
  await mergeStore($)
  await setView($, v => ({ ...v, activeId }))
  for (const account of accounts.filter(a => a.email === undefined || a.orgId === undefined)) {
    const who = await signedInAs($, account.slot)
    if (who === undefined) continue
    const latest = await loadAccounts($)
    await saveAccounts($, latest.map(a => (a.id === account.id ? { ...a, ...who } : a)))
  }
  await checkAll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void boot($).catch(error => debug($, `start failed: ${String(error)}`))
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
