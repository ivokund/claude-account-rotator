import type { Account, Fill, FooterStyle, Glyphs, Health, Highlight, Reading, UsageWindow, View } from '../types'

/** Leave a login once its 5-hour window is this full (percent). */
export const LEAVE_FIVE_HOUR = 90
/** Leave a login once its weekly window is this full (percent). */
export const LEAVE_SEVEN_DAY = 95
/** Warn this long before a login's refresh token runs out. */
export const SIGN_IN_WARN_MS = 3 * 24 * 3600_000

export const DEFAULT_FOOTER: FooterStyle = { session: 'braille', week: 'bars', sessionPercent: true, weekPercent: true, active: 'lines', fill: 'left' }

export const EMPTY_VIEW: View = { accounts: [], readings: {}, health: {}, activeId: '1', footer: DEFAULT_FOOTER, hasFontBlocks: false }

export const GLYPHS: readonly Glyphs[] = ['bars', 'pie', 'braille', 'none']
export const HIGHLIGHTS: readonly Highlight[] = ['lines', 'tile', 'dim']
export const FILLS: readonly Fill[] = ['left', 'used']

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)

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

/** A window's percent now: 0 once its reset time has passed. */
export function windowPct(w: UsageWindow | undefined, now: number): number | undefined {
  if (w === undefined) return undefined
  if (w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now) return 0
  return w.pct
}

/**
 * What a login can serve right now, percent of its 5-hour window: a week's
 * percent is a far bigger budget, so the session decides until the week is
 * spent, and then nothing is. Undefined before any 5-hour reading.
 */
export function availableNow(r: Reading | undefined, now: number): number | undefined {
  const five = roomLeft(r?.fiveHour, now)
  if (five === undefined) return undefined
  return (windowPct(r?.sevenDay, now) ?? 0) >= LEAVE_SEVEN_DAY ? 0 : five
}

export function isSpent(r: Reading | undefined, now: number): boolean {
  return (
    (windowPct(r?.fiveHour, now) ?? 0) >= LEAVE_FIVE_HOUR ||
    (windowPct(r?.sevenDay, now) ?? 0) >= LEAVE_SEVEN_DAY
  )
}

export function shouldLeave(view: View, now: number): boolean {
  return view.health[view.activeId]?.kind === 'login-needed' || isSpent(view.readings[view.activeId], now)
}

/** The signed-in login below both thresholds that can serve the most right now; unread counts as fresh. */
export function pickTarget(view: View, now: number): Account | undefined {
  const ready = view.accounts.filter(
    a => a.id !== view.activeId && view.health[a.id]?.kind === 'ok' && !isSpent(view.readings[a.id], now),
  )
  const available = (a: Account) => availableNow(view.readings[a.id], now) ?? 100
  return ready.sort((a, b) => available(b) - available(a))[0]
}

/** When the soonest spent window among all logins resets, epoch ms. */
export function nextReset(view: View, now: number): number | undefined {
  const times = view.accounts.flatMap(a => {
    const r = view.readings[a.id]
    return [r?.fiveHour, r?.sevenDay]
      .filter((w): w is UsageWindow => w !== undefined && w.resetsAt !== undefined && (windowPct(w, now) ?? 0) > 0)
      .map(w => Date.parse(w.resetsAt ?? ''))
  })
  return times.length === 0 ? undefined : Math.min(...times)
}

function windowFrom(value: unknown): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { utilization, resets_at } = value as { utilization?: unknown; resets_at?: unknown }
  if (typeof utilization !== 'number') return undefined
  return { pct: utilization, ...(typeof resets_at === 'string' ? { resetsAt: resets_at } : {}) }
}

/** A reading from the body of GET /api/oauth/usage. */
export function readingFromUsage(body: unknown, now: number): Reading | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const { five_hour, seven_day } = body as { five_hour?: unknown; seven_day?: unknown }
  const fiveHour = windowFrom(five_hour)
  const sevenDay = windowFrom(seven_day)
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: now }
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
export type Credential = { accessToken: string; expiresAt: number; refreshTokenExpiresAt?: number }

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
  const { accessToken, expiresAt, refreshTokenExpiresAt } = oauth as Record<string, unknown>
  if (typeof accessToken !== 'string' || typeof expiresAt !== 'number') return undefined
  return {
    accessToken,
    expiresAt,
    ...(typeof refreshTokenExpiresAt === 'number' ? { refreshTokenExpiresAt } : {}),
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

/** "in 1h 20m", "in 3d 4h": relative, so it needs no time zone. */
export function untilText(at: number | string | undefined, now: number): string {
  if (at === undefined) return ''
  const ms = (typeof at === 'string' ? Date.parse(at) : at) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(slot.normalize('NFC')))
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `Claude Code-credentials-${hex.slice(0, 8)}`
}

/**
 * The file Claude Code keeps a slot's login in where there is no keychain
 * (Linux): where 2.1.296 puts it for a `claude` child run with `slotEnv`, the
 * normal login's in ~/.claude and any other slot's in its own directory,
 * NFC-normalized. Undefined for the normal login with no home. A session
 * started with CLAUDE_CONFIG_DIR set keeps its normal login in that directory
 * instead, which this misses as `keychainItem` does on macOS.
 */
export function credentialsFile(slot: string, home: string | undefined): string | undefined {
  const dir = slot === '' ? home && `${home}/.claude` : slot
  return dir ? `${dir.normalize('NFC')}/.credentials.json` : undefined
}

/** The environment that points a `claude` child at a slot's login. */
export function slotEnv(slot: string): Record<string, string> {
  return slot === ''
    ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }
    : { CLAUDE_SECURESTORAGE_CONFIG_DIR: slot, CLAUDE_CONFIG_DIR: slot }
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

