import type { Account, Fill, FooterStyle, Glyphs, Health, Highlight, Reading, RotateTo, StartOn, UsageWindow, View } from '../types'

/** Leave a login once its 5-hour window is this full (percent). */
export const LEAVE_FIVE_HOUR = 90
/** Leave a login once its weekly window is this full (percent). */
export const LEAVE_SEVEN_DAY = 95
/** Warn this long before a login's refresh token runs out. */
export const SIGN_IN_WARN_MS = 3 * 24 * 3600_000

export const DEFAULT_FOOTER: FooterStyle = { session: 'braille', week: 'bars', sessionPercent: true, weekPercent: true, active: 'lines', fill: 'left' }

export const DEFAULT_ROTATE_TO: RotateTo = 'reset'

export const DEFAULT_START_ON: StartOn = 'login'

/** A new session starts on a fresh 5-hour window only where at least this much of the week is left (percent): less, and it would soon move on. */
export const START_WEEK_LEFT = 15
/** For this long after a new session picked an account to start on, the next new session counts its 5-hour window as started. */
export const START_CLAIM_MS = 10 * 60_000

export const EMPTY_VIEW: View = {
  accounts: [],
  readings: {},
  health: {},
  holders: {},
  activeId: '1',
  footer: DEFAULT_FOOTER,
  rotateTo: DEFAULT_ROTATE_TO,
  startOn: DEFAULT_START_ON,
  hasFontBlocks: false,
}

export const GLYPHS: readonly Glyphs[] = ['bars', 'pie', 'braille', 'none']
export const HIGHLIGHTS: readonly Highlight[] = ['lines', 'tile', 'dim']
export const FILLS: readonly Fill[] = ['left', 'used']
export const ROTATE_TOS: readonly RotateTo[] = ['reset', 'room', 'order', 'off']
export const START_ONS: readonly StartOn[] = ['login', 'fresh']

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)

/** Which login the rotation moves to, as stored; unknown is the default's. */
export function rotateToFrom(value: unknown): RotateTo {
  return isOneOf(value, ROTATE_TOS) ? value : DEFAULT_ROTATE_TO
}

/** Where new sessions start, as stored; unknown is the default's. */
export function startOnFrom(value: unknown): StartOn {
  return isOneOf(value, START_ONS) ? value : DEFAULT_START_ON
}

/** The footer's look as stored; any part missing or unknown is the default's. */
export function footerStyleFrom(value: unknown): FooterStyle {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    session: isOneOf(v.session, GLYPHS) ? v.session : DEFAULT_FOOTER.session,
    week: isOneOf(v.week, GLYPHS) ? v.week : DEFAULT_FOOTER.week,
    sessionPercent: typeof v.sessionPercent === 'boolean' ? v.sessionPercent : DEFAULT_FOOTER.sessionPercent,
    weekPercent: typeof v.weekPercent === 'boolean' ? v.weekPercent : DEFAULT_FOOTER.weekPercent,
    active: isOneOf(v.active, HIGHLIGHTS) ? v.active : DEFAULT_FOOTER.active,
    fill: isOneOf(v.fill, FILLS) ? v.fill : DEFAULT_FOOTER.fill,
  }
}

/** Whether a window's reset time has passed since it was read: what it has used since is unknown. */
export function hasReset(w: UsageWindow | undefined, now: number): boolean {
  return w?.resetsAt !== undefined && Date.parse(w.resetsAt) <= now
}

/**
 * A window's percent now; undefined once its reset time has passed, as the
 * reading says nothing of what was used since. The rotation counts that as
 * empty (`?? 0`), as it does a window never read; the footer and pane show it
 * as unknown.
 */
export function windowPct(w: UsageWindow | undefined, now: number): number | undefined {
  if (w === undefined || hasReset(w, now)) return undefined
  return w.pct
}

/**
 * What a login can serve right now, percent of its 5-hour window: a week's
 * percent is a far bigger budget, so the session decides until the week is
 * spent, and then nothing is; nor, for a session on a model with a week of
 * its own, once that week is spent. Undefined before any 5-hour reading, and
 * once the 5-hour window has reset since its reading, while the week has room.
 */
export function availableNow(r: Reading | undefined, now: number, scope?: string): number | undefined {
  if (r?.fiveHour === undefined) return undefined
  if ((windowPct(r.sevenDay, now) ?? 0) >= LEAVE_SEVEN_DAY) return 0
  if ((windowPct(modelWindow(r, scope), now) ?? 0) >= LEAVE_SEVEN_DAY) return 0
  return roomLeft(r.fiveHour, now)
}

/** A model's id or name as its words: runs of letters or digits, in lower case. */
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

/**
 * Which of the logins' model weeks a model falls under, by name: `Fable` for
 * `claude-fable-5-2` or "Fable 5.2". By whole words, every one of the week's
 * name among the model's, so "Fable 5" or "Claude Fable" would be it too, and
 * "Fable 4" not; of two that are, the one that says more. Undefined for a
 * model with no week of its own (Opus, Sonnet), which only the login's week
 * limits.
 */
export function scopeOf(model: string | undefined, readings: Readonly<Record<string, Reading>>): string | undefined {
  if (model === undefined || model === '') return undefined
  const words = new Set(wordsOf(model))
  const names = [...new Set(Object.values(readings).flatMap(r => Object.keys(r.models ?? {})))]
  const fits = names.filter(name => wordsOf(name).length > 0 && wordsOf(name).every(word => words.has(word)))
  return fits.sort((a, b) => wordsOf(b).length - wordsOf(a).length || a.localeCompare(b))[0]
}

/** The model week this session's model falls under, if any. */
export function viewScope(view: View): string | undefined {
  return scopeOf(view.model, view.readings)
}

/**
 * A reading with the model weeks of whichever of it and `other` asked the
 * usage endpoint last. A response's report has none, and neither has a reading
 * a session on an older version of the mod stored: without this either would
 * drop them.
 */
export function withModelWeeks(reading: Reading, other: Reading | undefined): Reading {
  if (other?.usageAt === undefined || (reading.usageAt ?? -Infinity) >= other.usageAt) return reading
  const { models: _dropped, ...rest } = reading
  return { ...rest, ...(other.models === undefined ? {} : { models: other.models }), usageAt: other.usageAt }
}

/** The newer of two readings of a login, with the model weeks of whichever asked the usage endpoint last. */
export function newestReading(mine: Reading | undefined, theirs: Reading | undefined): Reading | undefined {
  const isMine = mine !== undefined && (theirs === undefined || mine.at >= theirs.at)
  const newest = isMine ? mine : theirs
  return newest === undefined ? undefined : withModelWeeks(newest, isMine ? theirs : mine)
}

/**
 * When a reading last told all the usage endpoint tells, epoch ms: undefined
 * before that endpoint answered for the login at all; where it reports a
 * model's own week, when it last answered, as a response's report says nothing
 * of that week; else when the reading was taken, a response's report serving.
 */
export function usageReadAt(r: Reading | undefined): number | undefined {
  if (r?.usageAt === undefined) return undefined
  return r.models === undefined ? r.at : r.usageAt
}

/** A login's week for one model family, by name. */
export function modelWindow(r: Reading | undefined, scope: string | undefined): UsageWindow | undefined {
  return scope === undefined ? undefined : r?.models?.[scope]
}

/** Past a leave threshold: the 5-hour window, the week, or, for a session on such a model, the model's own week. */
export function isSpent(r: Reading | undefined, now: number, scope?: string): boolean {
  return (
    (windowPct(r?.fiveHour, now) ?? 0) >= LEAVE_FIVE_HOUR ||
    (windowPct(r?.sevenDay, now) ?? 0) >= LEAVE_SEVEN_DAY ||
    (windowPct(modelWindow(r, scope), now) ?? 0) >= LEAVE_SEVEN_DAY
  )
}

export function shouldLeave(view: View, now: number): boolean {
  return view.health[view.activeId]?.kind === 'login-needed' || isSpent(view.readings[view.activeId], now, viewScope(view))
}

/**
 * The window that limits a login: its week where its reading has a week and
 * no 5-hour window, as an Ultra plan's does; else its 5-hour window.
 */
export function limitingWindow(r: Reading | undefined): 'fiveHour' | 'sevenDay' {
  return r?.fiveHour === undefined && r?.sevenDay !== undefined ? 'sevenDay' : 'fiveHour'
}

/**
 * The room a login has to rotate to: what it can serve right now, or, where
 * its plan reports no 5-hour window, its week's room. A 5-hour window that
 * reset since its reading stays unknown, which the rotation counts as fresh.
 * For a session on a model with a week of its own, the smaller of that and
 * the model week's room.
 */
export function roomOf(r: Reading | undefined, now: number, scope?: string): number | undefined {
  const room = limitingWindow(r) === 'sevenDay' ? roomLeft(r?.sevenDay, now) : availableNow(r, now, scope)
  const model = roomLeft(modelWindow(r, scope), now)
  return model === undefined ? room : room === undefined ? model : Math.min(room, model)
}

/** When the window that limits a login resets, epoch ms; Infinity while none is running. */
function limitReset(r: Reading | undefined, now: number): number {
  const w = r?.[limitingWindow(r)]
  if (w?.resetsAt === undefined || (windowPct(w, now) ?? 0) === 0) return Infinity
  return Date.parse(w.resetsAt)
}

/**
 * A login's reading once a turn hit its usage limit before its usage showed
 * it: the window that limits it, full, which every session sees. For a
 * session on a model with a week of its own, that week instead, but only
 * where it is fuller than both the 5-hour window and the week: then the turn
 * more likely hit it, and sessions on other models still have the login's
 * room. Noted as the usage endpoint's answers are (`usageAt`), so a response
 * another session reports for the login doesn't undo it.
 */
export function spentReading(r: Reading | undefined, now: number, scope?: string): Reading {
  const key = limitingWindow(r)
  const model = modelWindow(r, scope)
  const used = (w: UsageWindow | undefined) => windowPct(w, now) ?? 0
  if (scope !== undefined && model !== undefined && used(model) > Math.max(used(r?.fiveHour), used(r?.sevenDay))) {
    return { ...r, models: { ...r?.models, [scope]: { pct: 100, ...(model.resetsAt ? { resetsAt: model.resetsAt } : {}) } }, usageAt: now, at: now }
  }
  const resetsAt = r?.[key]?.resetsAt
  return { ...r, [key]: { pct: 100, ...(resetsAt ? { resetsAt } : {}) }, at: now }
}

/**
 * The signed-in login below both thresholds to move to, as `rotateTo` picks:
 * the one that can serve the most right now (unread counts as fresh); the one
 * whose limit (its 5-hour window, or its week) resets soonest, so room about
 * to refill is used first, the most room breaking ties; or the next in the
 * list after the one in use. With the rotation off, Rotate now takes the one
 * with the most room.
 */
export function pickTarget(view: View, now: number): Account | undefined {
  const scope = viewScope(view)
  const ready = view.accounts.filter(
    a => a.id !== view.activeId && view.health[a.id]?.kind === 'ok' && !isSpent(view.readings[a.id], now, scope),
  )
  const available = (a: Account) => roomOf(view.readings[a.id], now, scope) ?? 100
  const byRoom = (a: Account, b: Account) => available(b) - available(a)
  switch (view.rotateTo) {
    case 'room':
    case 'off':
      return ready.sort(byRoom)[0]
    case 'reset': {
      const reset = (a: Account) => limitReset(view.readings[a.id], now)
      return ready.sort((a, b) => (reset(a) === reset(b) ? byRoom(a, b) : reset(a) < reset(b) ? -1 : 1))[0]
    }
    case 'order': {
      const at = view.accounts.findIndex(a => a.id === view.activeId)
      const after = [...view.accounts.slice(at + 1), ...view.accounts.slice(0, at + 1)]
      return after.find(a => ready.includes(a))
    }
  }
}

/**
 * Where a new session starts with "a fresh 5-hour window" picked: a signed-in
 * login with room whose 5-hour window hasn't started (at 0%, reset since its
 * reading, unread, or none on a week-only plan), with START_WEEK_LEFT of its
 * week left (and of the session's model week), and no other new session's
 * claim on it within START_CLAIM_MS. Claude Code's login where it is one: no
 * switch, and its connectors keep working. Else the one whose week resets
 * soonest, so its room is used before it refills, the most room breaking ties.
 */
export function pickStart(view: View, now: number, claims: Readonly<Record<string, number>>): Account | undefined {
  const scope = viewScope(view)
  const weekLeft = (r: Reading | undefined) => Math.min(roomLeft(r?.sevenDay, now) ?? 100, roomLeft(modelWindow(r, scope), now) ?? 100)
  const fresh = view.accounts.filter(a => {
    const r = view.readings[a.id]
    const claimed = claims[a.id]
    return (
      view.health[a.id]?.kind === 'ok' &&
      (windowPct(r?.fiveHour, now) ?? 0) === 0 &&
      weekLeft(r) >= START_WEEK_LEFT &&
      (claimed === undefined || now - claimed >= START_CLAIM_MS)
    )
  })
  const login = fresh.find(a => a.slot === '')
  if (login !== undefined) return login
  const reset = (a: Account) => {
    const at = Date.parse(view.readings[a.id]?.sevenDay?.resetsAt ?? '')
    return Number.isFinite(at) && at > now ? at : Infinity
  }
  const room = (a: Account) => weekLeft(view.readings[a.id])
  return fresh.sort((a, b) => (reset(a) === reset(b) ? room(b) - room(a) : reset(a) < reset(b) ? -1 : 1))[0]
}

/** A reading older than this (two of every session's checks) says how old it is: in the pane, and where a new session starts by it. */
export const READING_OLD_MS = 20 * 60_000

/**
 * Why a new session moved to a login as it opened, as far as its reading
 * tells. One not read lately says how long ago: the login may have been used
 * since from somewhere the mod doesn't see.
 */
export function startWhy(r: Reading | undefined, now: number): string {
  if (r === undefined) return 'it had no usage reading yet'
  if (r.fiveHour === undefined) return 'its week resets soonest'
  if (hasReset(r.fiveHour, now)) return `its 5-hour window had reset since it was read ${agoText(r.at, now)}`
  return now - r.at > READING_OLD_MS ? `its 5-hour window hadn't started when read ${agoText(r.at, now)}` : "its 5-hour window hadn't started"
}

/**
 * When the first of the spent logins frees up, epoch ms: each once the last
 * of its spent windows has reset, the session's model week among them. A
 * window with room frees nothing, soon as it may reset. Undefined with none
 * spent, or none whose spent windows all say when they reset.
 */
export function nextReset(view: View, now: number): number | undefined {
  const scope = viewScope(view)
  const times = view.accounts.flatMap(a => {
    const r = view.readings[a.id]
    const windows: [UsageWindow | undefined, number][] = [
      [r?.fiveHour, LEAVE_FIVE_HOUR],
      [r?.sevenDay, LEAVE_SEVEN_DAY],
      [modelWindow(r, scope), LEAVE_SEVEN_DAY],
    ]
    const resets = windows.filter(([w, leave]) => (windowPct(w, now) ?? 0) >= leave).map(([w]) => Date.parse(w?.resetsAt ?? ''))
    return resets.length === 0 || resets.some(at => !Number.isFinite(at)) ? [] : [Math.max(...resets)]
  })
  return times.length === 0 ? undefined : Math.min(...times)
}

function windowFrom(value: unknown): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { utilization, resets_at } = value as { utilization?: unknown; resets_at?: unknown }
  if (typeof utilization !== 'number') return undefined
  return { pct: utilization, ...(typeof resets_at === 'string' ? { resetsAt: resets_at } : {}) }
}

/** A Retry-After header as milliseconds from now: seconds, or an HTTP date; undefined without one or past reading. */
export function retryAfter(header: string | undefined, now: number): number | undefined {
  if (header === undefined || header.trim() === '') return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/**
 * The weeks a model family has of its own, from the usage body's `limits`:
 * each `weekly_scoped` limit scoped to a model, by the model's display name.
 */
function modelWindowsFrom(limits: unknown): Record<string, UsageWindow> | undefined {
  if (!Array.isArray(limits)) return undefined
  const models: Record<string, UsageWindow> = {}
  for (const limit of limits as unknown[]) {
    if (typeof limit !== 'object' || limit === null) continue
    const { kind, percent, resets_at, scope } = limit as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: unknown }
    const model = (scope as { model?: { display_name?: unknown } } | null | undefined)?.model?.display_name
    const surface = (scope as { surface?: unknown } | null | undefined)?.surface
    if (kind !== 'weekly_scoped' || typeof model !== 'string' || model === '' || surface != null || typeof percent !== 'number') continue
    models[model] = { pct: percent, ...(typeof resets_at === 'string' ? { resetsAt: resets_at } : {}) }
  }
  return Object.keys(models).length === 0 ? undefined : models
}

/** A reading from the body of GET /api/oauth/usage. */
export function readingFromUsage(body: unknown, now: number): Reading | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const { five_hour, seven_day, limits } = body as { five_hour?: unknown; seven_day?: unknown; limits?: unknown }
  const fiveHour = windowFrom(five_hour)
  const sevenDay = windowFrom(seven_day)
  const models = modelWindowsFrom(limits)
  if (fiveHour === undefined && sevenDay === undefined && models === undefined) return undefined
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), ...(models ? { models } : {}), at: now }
}

/** A reading from the rate-limit windows the last response reported. */
export function readingFromLimits(
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  now: number,
): Reading | undefined {
  const pick = (kind: string): UsageWindow | undefined => {
    const w = limits.find(l => l.kind === kind)
    return w && { pct: w.percentUsed, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }
  }
  const fiveHour = pick('five_hour')
  const sevenDay = pick('seven_day')
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: now }
}

/** True when two readings agree within a few points on every shared window. */
export function sameUsage(a: Reading | undefined, b: Reading | undefined, now: number): boolean {
  if (a === undefined || b === undefined) return false
  const pairs: [UsageWindow | undefined, UsageWindow | undefined][] = [
    [a.fiveHour, b.fiveHour],
    [a.sevenDay, b.sevenDay],
  ]
  const shared = pairs.filter(([x, y]) => x !== undefined && y !== undefined)
  return (
    shared.length > 0 &&
    shared.every(([x, y]) => Math.abs((windowPct(x, now) ?? 0) - (windowPct(y, now) ?? 0)) <= 3)
  )
}

/** The part of a stored login Claude Code keeps in the keychain (on Linux, a file) that matters here. */
export type Credential = {
  accessToken: string
  expiresAt: number
  refreshTokenExpiresAt?: number
  /** A new sign-in brings a new one. */
  refreshToken?: string
  /** `subscriptionType`, the plan Claude Code reads from the sign-in: on a Team or Enterprise one it keeps plugins from switching. */
  plan?: string
}

export function credentialFrom(text: string): Credential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // An entry that is not JSON is no usable login: the caller asks for a sign-in.
    return undefined
  }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return undefined
  const { accessToken, expiresAt, refreshTokenExpiresAt, refreshToken, subscriptionType } = oauth as Record<string, unknown>
  if (typeof accessToken !== 'string' || typeof expiresAt !== 'number') return undefined
  return {
    accessToken,
    expiresAt,
    ...(typeof refreshTokenExpiresAt === 'number' ? { refreshTokenExpiresAt } : {}),
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    ...(typeof subscriptionType === 'string' ? { plan: subscriptionType } : {}),
  }
}

/** A login's health from its stored credential alone. */
export function healthOf(cred: Credential | undefined, now: number): Health {
  if (cred === undefined) return { kind: 'login-needed', why: 'not signed in' }
  if (cred.refreshTokenExpiresAt !== undefined && cred.refreshTokenExpiresAt <= now) {
    return { kind: 'login-needed', why: 'sign-in expired' }
  }
  return { kind: 'ok', ...(cred.refreshTokenExpiresAt ? { refreshExpiresAt: cred.refreshTokenExpiresAt } : {}) }
}

/** The percent a glyph or bar fills to and the footer prints: the room left, or what is used. */
export function shown(fill: Fill, leftPct: number): number {
  return fill === 'left' ? leftPct : 100 - leftPct
}

/** Percent of a window still free; undefined when the window has no reading. */
export function roomLeft(w: UsageWindow | undefined, now: number): number | undefined {
  const pct = windowPct(w, now)
  return pct === undefined ? undefined : Math.round(100 - pct)
}

/**
 * The color for a percent of room left: green with all of it, through yellow,
 * to red with none (hue 120 down to 0); lighter while the pointer is over it.
 */
export function roomColor(leftPct: number, isLit = false): string {
  const hue = Math.max(0, Math.min(100, leftPct)) * 1.2
  const [s, l] = [0.75, isLit ? 0.72 : 0.55]
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** A vertical bar for a percentage, an eighth to full height. */
export function bar(pct: number): string {
  return BARS[Math.min(7, Math.max(0, Math.round((pct / 100) * 7)))] ?? '█'
}

const BRAILLE = ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿']

/** A braille cell filled from the bottom for a percentage, one dot to all eight. */
export function braille(pct: number): string {
  return BRAILLE[Math.min(7, Math.max(0, Math.round((pct / 100) * 7)))] ?? '⣿'
}

const PIES = ['○', '◔', '◑', '◕', '●']

/** A pie for a percentage, empty to full in quarters; a dot when unknown. */
export function pie(pct: number | undefined): string {
  if (pct === undefined) return '·'
  return PIES[Math.min(4, Math.max(0, Math.round(pct / 25)))] ?? '●'
}

/** One login's glyph for a percentage in a footer row's style. */
export function glyph(style: Glyphs, pct: number): string {
  switch (style) {
    case 'bars':
      return bar(pct)
    case 'pie':
      return pie(pct)
    case 'braille':
      return braille(pct)
    case 'none':
      return ''
  }
}

/** A ten-cell bar for the pane, filled by a percentage. */
export function longBar(pct: number | undefined): string {
  if (pct === undefined) return '··········'
  const full = Math.min(10, Math.max(0, Math.round(pct / 10)))
  return '▰'.repeat(full) + '▱'.repeat(10 - full)
}

/** "40m", "2h 5m", "3d 4h": a span of time, to the minute. */
function spanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "40m ago", "2h 5m ago": how long ago, relative as untilText is. */
export function agoText(at: number, now: number): string {
  return `${spanText(now - at)} ago`
}

/**
 * What the pane says of a reading's age once it is old, undefined while it is
 * current. An idle login's, whose token has run out so that its usage can't
 * be read, says when it is read again. Where responses keep the reading
 * current but its model weeks, which only the usage endpoint tells, are old,
 * it says so of those.
 */
export function readingAge(r: Reading | undefined, isIdle: boolean, now: number): string | undefined {
  if (r === undefined) return undefined
  if (now - r.at > READING_OLD_MS) return `read ${agoText(r.at, now)}${isIdle ? '; read again once a session uses the account' : ''}`
  const models = Object.keys(r.models ?? {}).sort()
  const isOld = models.length > 0 && r.usageAt !== undefined && now - r.usageAt > READING_OLD_MS
  return isOld && r.usageAt !== undefined ? `${models.join(', ')} read ${agoText(r.usageAt, now)}` : undefined
}

/** "in 1h 20m", "in 3d 4h": relative, so it needs no time zone. */
export function untilText(at: number | string | undefined, now: number): string {
  if (at === undefined) return ''
  const ms = (typeof at === 'string' ? Date.parse(at) : at) - now
  if (!Number.isFinite(ms)) return ''
  return ms <= 0 ? 'now' : `in ${spanText(ms)}`
}

export function label(account: Account | undefined): string {
  if (account === undefined) return '?'
  if (account.email === undefined) return account.id
  return `${account.id} (${account.email}${account.orgName ? ` · ${account.orgName}` : ''})`
}

/**
 * The keychain entry Claude Code keeps a slot's login in. Mirrors Claude Code
 * 2.1.296: the normal login has no suffix; any other slot is suffixed with
 * the first 8 hex digits of the SHA-256 of its directory, NFC-normalized.
 */
export async function keychainItem(slot: string): Promise<string> {
  if (slot === '') return 'Claude Code-credentials'
  return `Claude Code-credentials-${(await sha256(slot.normalize('NFC'))).slice(0, 8)}`
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** A digest of a sign-in's token: tells a new sign-in from the one asked about, without keeping the token. */
export async function fingerprint(token: string): Promise<string> {
  return (await sha256(token)).slice(0, 16)
}

/**
 * The file Claude Code keeps a slot's login in where there is no keychain
 * (Linux, Windows): where 2.1.296 puts it for a `claude` child run with
 * `slotEnv`, the normal login's in ~/.claude and any other slot's in its own
 * directory, NFC-normalized. Undefined for the normal login with no home.
 * Pass the slot through `storageDir` first, so a session started with
 * CLAUDE_CONFIG_DIR set reads its normal login from that directory.
 */
export function credentialsFile(slot: string, home: string | undefined): string | undefined {
  const dir = slot === '' ? home && `${home}/.claude` : slot
  return dir ? `${dir.normalize('NFC')}/.credentials.json` : undefined
}

/**
 * Where Claude Code keeps a slot's login, as the directory `keychainItem`,
 * `credentialsFile` and `slotEnv` take: the normal login lives in the
 * session's CLAUDE_CONFIG_DIR when one is set, as Claude Code itself pins a
 * child to its parent's login with `CLAUDE_SECURESTORAGE_CONFIG_DIR ??
 * CLAUDE_CONFIG_DIR ?? ''`. '' stays the one in ~/.claude.
 */
export function storageDir(slot: string, configDir: string | undefined): string {
  return slot === '' ? configDir || '' : slot
}

/** The slot a session started on, by its CLAUDE_SECURESTORAGE_CONFIG_DIR: its own CLAUDE_CONFIG_DIR's is the normal login. */
export function slotFromEnv(secureStorageDir: string | undefined, configDir: string | undefined): string {
  return !secureStorageDir || secureStorageDir === configDir ? '' : secureStorageDir
}

/**
 * The folder added accounts get a slot each in: `accounts` in the session's
 * CLAUDE_CONFIG_DIR, else in ~/.claude, so two config directories never share
 * a slot. Undefined with neither.
 */
export function accountsDir(configDir: string | undefined, home: string | undefined): string | undefined {
  const root = configDir || (home && `${home}/.claude`)
  return root ? `${root}/accounts` : undefined
}

/** The environment that points a `claude` child at a slot's login. */
export function slotEnv(slot: string): Record<string, string> {
  return slot === ''
    ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }
    : { CLAUDE_SECURESTORAGE_CONFIG_DIR: slot, CLAUDE_CONFIG_DIR: slot }
}

/**
 * Whether an error is Claude Code's security default refusing the switch: in
 * a session on a Team or Enterprise account, or on a machine with managed
 * settings, it keeps a plugin you install from changing where sign-ins are read.
 */
export function isPolicyRefusal(error: unknown): boolean {
  return String(error).includes('is not for plugins outside policy to change')
}

/** Whether this session reads the normal login, the one `/login` signs in, rather than a slot the mod moved it to. */
export function isOnNormalLogin(view: View): boolean {
  return (view.accounts.find(a => a.id === view.activeId)?.slot ?? '') === ''
}

/**
 * Why switching is blocked, and how to get a session that can switch. One on
 * the normal login started on a Team seat: signing that login in to a personal
 * account fixes the next session. One on a seat reloaded plugins there, or
 * started there, as `/restart` keeps the slot in use; a new session from the
 * terminal starts on the normal login already. `/login` there would sign in
 * the seat instead, as sign-ins follow the slot in use.
 */
export function blockedAdvice(view: View): string {
  return isOnNormalLogin(view)
    ? "Claude Code doesn't let plugins switch accounts in a session that starts on a Team or Enterprise account. " +
        `Fix: /login with your personal (Pro or Max) account. ${restartSteps(view)}.`
    : "Claude Code doesn't let plugins switch accounts once a session on a Team or Enterprise account starts or reloads plugins. " +
        `Fix: ${restartSteps(view)}. Not /restart, which keeps this account.`
}

/** What the mod says once Claude Code's security default refuses switching. */
export function blockedText(view: View): string {
  return (
    `Can't switch accounts in this session. ${blockedAdvice(view)} ` +
    'More: https://github.com/ivokund/claude-account-rotator#team-and-enterprise-accounts'
  )
}

/**
 * How to bring this conversation back in a new session, which starts on
 * Claude Code's login. A background session goes on running when /exit or ←
 * leaves it, and `claude --resume` then opens that same session again: /stop
 * ends it first.
 */
export function restartSteps(view: View): string {
  return `Quit (in a background session, /stop: /exit only detaches), then run: ${resumeCommand(view)}`
}

/**
 * A session that can't switch, on a login that is spent while another has
 * room: what the person does about it. Undefined otherwise; with every login
 * spent, a new session would not help either.
 */
export function stuckText(view: View, now: number): string | undefined {
  if (!view.isSwitchBlocked || !isSpent(view.readings[view.activeId], now, viewScope(view)) || pickTarget(view, now) === undefined) return undefined
  const login = isOnNormalLogin(view) ? '/login with your personal (Pro or Max) account. ' : ''
  return `Account ${view.activeId} is out of usage, and this window can't switch accounts. ${login}${restartSteps(view)}`
}

/** The MCP server Claude Code runs Claude in Chrome as, and the names of its tools. */
export const CHROME_SERVER = 'claude-in-chrome'
export const CHROME_TOOL = /^mcp__claude-in-chrome__/

/**
 * How many browsers `list_connected_browsers` lists: the Chrome extensions
 * signed in to the account Claude in Chrome connected as. Undefined for an
 * answer that is no list.
 */
export function browsersFrom(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.length : undefined
  } catch {
    // Words, not a list: an error, which counts no browsers either way.
    return undefined
  }
}

/** How Claude Code's words for a browser call that found no browser begin, as a whole result rather than words on a page. */
const NO_BROWSER_START = /^\s*(?:Error:\s*)?(?:Browser extension is not connected|No Chrome extension connected|[^\n]{0,80}isn't paired with your browser)/

/**
 * Whether a browser call found no browser. Claude Code answers that as an
 * error, or as an ordinary result: one counts when it begins with its words
 * (a page's own text that mentions them doesn't), and list_connected_browsers
 * when it lists none.
 */
export function isUnansweredCall(tool: string, text: string, isError: boolean): boolean {
  if (isNoBrowser(text) && (isError || NO_BROWSER_START.test(text))) return true
  return tool.endsWith('__list_connected_browsers') && browsersFrom(text) === 0
}

/** Whether a browser call's error says no browser answered, as Claude Code words it over its bridge or its local socket. */
export function isNoBrowser(text: string): boolean {
  return /Browser extension is not connected|isn't paired with your browser|No Chrome extension connected/.test(text)
}

/**
 * Whether Connect can run in a session: an account is named for the Chrome
 * extension, and the session is on it or free to move there.
 */
export function canConnectChrome(view: View): boolean {
  const own = view.chromeAccountId
  return own !== undefined && view.hasChrome !== false && (!view.isSwitchBlocked || view.activeId === own)
}

/** What brings this conversation back in a new session, which starts on Claude Code's login, free to switch. */
export function resumeCommand(view: View): string {
  return view.sessionId === undefined ? 'claude --continue' : `claude --resume ${view.sessionId}`
}

/**
 * Why Claude is told about Claude in Chrome: a call held back while Connect is
 * under way, or one that found no browser, and then the mod connects it now,
 * or no browser answered there before, or the session can't move to the
 * extension's account, or no account is named for the extension.
 */
export type ChromeNoteKind = 'held' | 'connecting' | 'no-browser' | 'blocked' | 'unset'

/**
 * What Claude reads about Claude in Chrome, in place of Claude Code's advice
 * to /login, which in a session the mod moved signs in the account the
 * session is on: what happens now, and what to tell the user.
 */
export function chromeNote(view: View, kind: ChromeNoteKind): string {
  const named = (id: string | undefined) => {
    const a = view.accounts.find(x => x.id === id)
    return a === undefined ? undefined : `Claude account ${a.id}${a.email === undefined ? '' : ` (${a.email})`}`
  }
  const own = `${named(view.chromeAccountId) ?? 'one account'}, the account the user's Chrome extension is signed in to`
  const as = named(view.chrome?.as)
  const found = as === undefined ? 'Claude in Chrome found no browser.' : `Claude in Chrome connected as ${as} and found no browser.`
  const wait = "End your turn now: you'll get a message once it's connected."
  const noLogin = "Don't suggest /login: it doesn't fix this."
  switch (kind) {
    case 'held':
      return `The account-rotator mod is connecting Claude in Chrome as ${own}, which takes under a minute; browser calls wait until then. ${wait}`
    case 'connecting':
      return `${found} The account-rotator mod is now ${view.chrome?.as === view.chromeAccountId ? 'reconnecting' : 'connecting'} it as ${own}, which takes under a minute. ${wait} ${noLogin}`
    case 'no-browser':
      return (
        `No Chrome extension answers as ${named(view.chromeAccountId) ?? 'that account'}, the account picked for it in the Claude accounts panel: Chrome may be closed, its Claude extension signed in with another email, or its connection stuck. ` +
        "Ask the user to open Chrome and check the email its Claude extension is signed in with. If it is another account, they press Use for Chrome or Try to connect next to it under Chrome in the Claude accounts panel (click the usage under the prompt; under Other accounts if it isn't listed). " +
        (canConnectChrome(view)
          ? `If it matches, they restart Chrome and press Connect above the prompt. You'll get a message once it's connected. ${noLogin}`
          : `If it matches, they restart Chrome, then you try again. ${noLogin}`)
      )
    case 'blocked':
      return (
        `${found} This session can't connect it as ${own}: Claude Code doesn't let this session switch accounts. ` +
        `Tell the user that to use Chrome, they quit Claude Code (in a background session, with /stop: /exit only detaches) and run \`${resumeCommand(view)}\` in a terminal, which brings this conversation back with Chrome connected. ${noLogin}`
      )
    case 'unset':
      return (
        `${found} The user's Chrome extension answers only the Claude account it is signed in to, and the account-rotator mod doesn't know which one that is. ` +
        `Ask the user to press Use for Chrome or Try to connect next to it under Chrome in the Claude accounts panel (click the usage under the prompt; under Other accounts if it isn't listed). You'll get a message once it's connected. ${noLogin}`
      )
  }
}

/** The keychain account name Claude Code files its entries under. */
export function keychainUser(user: string | undefined): string {
  return user !== undefined && /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

/** The first number from 2 up that no login uses yet. */
export function freeId(accounts: readonly Account[]): string {
  const taken = new Set(accounts.map(a => a.id))
  let n = 2
  while (taken.has(String(n))) n += 1
  return String(n)
}

export type Identity = Pick<Account, 'email' | 'orgId' | 'orgName' | 'plan'>

/** Who a slot is signed in as, from `claude auth status --json`; undefined when signed out. */
export function identityFromStatus(stdout: string): Identity | undefined {
  let status: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    status = parsed as Record<string, unknown>
  } catch {
    // Output that is not JSON leaves who it is unknown; the label falls back to the number.
    return undefined
  }
  if (status.loggedIn !== true || typeof status.email !== 'string') return undefined
  return {
    email: status.email,
    ...(typeof status.orgId === 'string' ? { orgId: status.orgId } : {}),
    ...(typeof status.orgName === 'string' ? { orgName: status.orgName } : {}),
    ...(typeof status.subscriptionType === 'string' ? { plan: status.subscriptionType } : {}),
  }
}

/** The same login: one email in one organization. */
export function sameLogin(a: Identity, b: Identity): boolean {
  return a.email !== undefined && a.email === b.email && (a.orgId ?? '') === (b.orgId ?? '')
}

/** A listed login is the account `who` signed in as, as far as it is known: by its email, and its organization once known. */
export function isLoginOf(a: Identity, who: Identity): boolean {
  return a.email !== undefined && a.email === who.email && (a.orgId === undefined || a.orgId === who.orgId)
}

/**
 * Who a token signs in, from the body of GET /api/oauth/profile, which Claude
 * Code asks at a sign-in: email and organization. The plan is the sign-in's own.
 */
export function identityFromProfile(body: unknown): Identity | undefined {
  const field = (value: unknown, key: string) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined)
  const { account, organization } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const [email, orgId, orgName] = [field(account, 'email'), field(organization, 'uuid'), field(organization, 'name')]
  if (typeof email !== 'string' || email === '') return undefined
  return {
    email,
    ...(typeof orgId === 'string' ? { orgId } : {}),
    ...(typeof orgName === 'string' ? { orgName } : {}),
  }
}

/** A Team or Enterprise plan: Claude Code keeps plugins from switching accounts in a session that starts on one. */
export const isSeatPlan = (plan: string | undefined): boolean => plan === 'team' || plan === 'enterprise'

/** A plan as the pane names it: personal Max or Pro, or a Team or Enterprise seat. */
export function planText(plan: string): string {
  switch (plan) {
    case 'max':
      return 'personal Max'
    case 'pro':
      return 'personal Pro'
    case 'team':
      return 'a Team seat'
    case 'enterprise':
      return 'an Enterprise seat'
    default:
      return plan
  }
}

