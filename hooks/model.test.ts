import { expect, test } from 'claude-code/testing'

import type { Reading, RotateTo, View } from '../types'
import { DEFAULT_FOOTER, agoText, availableNow, blockedAdvice, braille, browsersFrom, chromeNote, credentialFrom, credentialsFile, footerStyleFrom, healthOf, identityFromProfile, isNoBrowser, isPolicyRefusal, isUnansweredCall, isSpent, keychainItem, nextReset, pickStart, pickTarget, pie, roomOf, readingFromUsage, restartSteps, retryAfter, scopeOf, rotateToFrom, shouldLeave, spentReading, roomColor, stuckText, usageReadAt, windowPct, withModelWeeks } from './model'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const LATER = '2026-10-12T12:00:00Z'
const WEEK_END = '2026-10-18T03:00:00Z'

function view(
  readings: Record<string, [number, number]>,
  health: Record<string, View['health'][string]> = {},
  rotateTo: RotateTo = 'room',
): View {
  const ids = Object.keys(readings)
  return {
    accounts: ids.map(id => ({ id, slot: id === '1' ? '' : `/h/.claude/accounts/${id}` })),
    readings: Object.fromEntries(
      ids.map(id => {
        const [five, week] = readings[id] ?? [0, 0]
        return [id, { fiveHour: { pct: five, resetsAt: LATER }, sevenDay: { pct: week, resetsAt: WEEK_END }, at: NOW }]
      }),
    ),
    health: Object.fromEntries(ids.map(id => [id, health[id] ?? { kind: 'ok' as const }])),
    holders: {},
    activeId: '1',
    footer: DEFAULT_FOOTER,
    rotateTo,
    startOn: 'login',
    hasFontBlocks: false,
  }
}

test('leaves at 90% of the 5-hour window or 95% of the week, and not before', () => {
  expect(shouldLeave(view({ '1': [89, 94] }), NOW)).toBe(false)
  expect(shouldLeave(view({ '1': [90, 10] }), NOW)).toBe(true)
  expect(shouldLeave(view({ '1': [10, 95] }), NOW)).toBe(true)
  expect(shouldLeave(view({ '1': [0, 0] }, { '1': { kind: 'login-needed', why: 'x' } }), NOW)).toBe(true)
})

test('picks the signed-in login with the most room, never a spent or locked one', () => {
  const v = view(
    { '1': [95, 50], '2': [40, 80], '3': [10, 20], '4': [5, 5] },
    { '4': { kind: 'login-needed', why: 'sign-in expired' } },
  )
  expect(pickTarget(v, NOW)?.id).toBe('3')
  expect(pickTarget(view({ '1': [95, 50], '2': [91, 10] }), NOW)).toBeUndefined()
})

test('ranks logins by what they can serve now: the 5-hour room, nothing once the week is spent', () => {
  // A fresh session with a busy week beats a half-used session with a fresh week.
  expect(pickTarget(view({ '1': [95, 50], '2': [10, 80], '3': [50, 0] }), NOW)?.id).toBe('2')
  expect(availableNow({ fiveHour: { pct: 10, resetsAt: LATER }, sevenDay: { pct: 80, resetsAt: WEEK_END }, at: NOW }, NOW)).toBe(90)
  expect(availableNow({ fiveHour: { pct: 10, resetsAt: LATER }, sevenDay: { pct: 96, resetsAt: WEEK_END }, at: NOW }, NOW)).toBe(0)
  // Nor once the Fable week is spent, for a session on Fable; one on another model has the 5-hour room.
  const fableSpent = { fiveHour: { pct: 10, resetsAt: LATER }, sevenDay: { pct: 50, resetsAt: WEEK_END }, models: { Fable: { pct: 96, resetsAt: WEEK_END } }, at: NOW }
  expect(availableNow(fableSpent, NOW, 'Fable')).toBe(0)
  expect(availableNow(fableSpent, NOW)).toBe(90)
  // Reset since it was read: unknown, which the rotation counts as fresh.
  expect(availableNow({ fiveHour: { pct: 97, resetsAt: LATER }, at: NOW }, Date.parse(LATER) + 1)).toBeUndefined()
  expect(pickTarget(view({ '1': [95, 50], '2': [97, 10] }), NOW + 3 * 3600_000)?.id).toBe('2')
})

test('soonest reset moves to the login whose 5-hour window resets first, never a spent one; one with no window running comes last', () => {
  const resetsAt = (v: View, id: string, at: string | undefined) => {
    const r = v.readings[id]
    if (r?.fiveHour) r.fiveHour = { pct: r.fiveHour.pct, ...(at ? { resetsAt: at } : {}) }
  }
  const v = view({ '1': [95, 50], '2': [10, 10], '3': [60, 10], '4': [91, 10] }, {}, 'reset')
  resetsAt(v, '2', '2026-10-12T14:00:00Z')
  resetsAt(v, '3', '2026-10-12T11:00:00Z')
  resetsAt(v, '4', '2026-10-12T10:30:00Z')
  expect(pickTarget(v, NOW)?.id).toBe('3')
  // Login 3's window resets before the switch: no window is running, so it comes last.
  expect(pickTarget(v, Date.parse('2026-10-12T11:00:00Z') + 1)?.id).toBe('2')
  // Two resets at once: the more room wins.
  resetsAt(v, '2', '2026-10-12T11:00:00Z')
  expect(pickTarget(v, NOW)?.id).toBe('2')
})

test('a login whose plan reports no 5-hour window is ranked by its week: its room, and when it resets', () => {
  const weekOnly = (pct: number, resetsAt = WEEK_END): Reading => ({ sevenDay: { pct, resetsAt }, at: NOW })
  const v = view({ '1': [95, 50], '2': [0, 0], '3': [0, 0] })
  v.readings['2'] = weekOnly(60, '2026-10-16T03:00:00Z')
  v.readings['3'] = weekOnly(20, '2026-10-14T03:00:00Z')
  // Not 100% free each, which left the first on the list.
  expect(roomOf(v.readings['2'], NOW)).toBe(40)
  expect(pickTarget(v, NOW)?.id).toBe('3')
  v.readings['3'] = weekOnly(80, '2026-10-14T03:00:00Z')
  expect(pickTarget(v, NOW)?.id).toBe('2')
  // Soonest reset goes by when each week resets.
  expect(pickTarget({ ...v, rotateTo: 'reset' }, NOW)?.id).toBe('3')
  v.readings['3'] = weekOnly(95, '2026-10-14T03:00:00Z')
  expect(pickTarget({ ...v, rotateTo: 'reset' }, NOW)?.id).toBe('2')
  // Beside a login with a 5-hour window, each by its own limit.
  const mixed = view({ '1': [95, 50], '2': [0, 0], '3': [50, 10] })
  mixed.readings['2'] = weekOnly(70)
  expect(pickTarget(mixed, NOW)?.id).toBe('3')
  // A 5-hour window that reset since its reading stays fresh, not its week's room.
  expect(roomOf({ fiveHour: { pct: 97, resetsAt: LATER }, sevenDay: { pct: 60, resetsAt: WEEK_END }, at: NOW }, Date.parse(LATER) + 1)).toBeUndefined()
})

test('a limit hit before the usage shows it fills the window that limits the login, keeping its reset', () => {
  const five = { fiveHour: { pct: 40, resetsAt: LATER }, sevenDay: { pct: 60, resetsAt: WEEK_END }, at: NOW - 1 }
  expect(spentReading(five, NOW)).toEqual({ fiveHour: { pct: 100, resetsAt: LATER }, sevenDay: { pct: 60, resetsAt: WEEK_END }, at: NOW })
  expect(spentReading({ sevenDay: { pct: 60, resetsAt: WEEK_END }, at: NOW - 1 }, NOW)).toEqual({ sevenDay: { pct: 100, resetsAt: WEEK_END }, at: NOW })
  // No reading yet: the 5-hour window, as before.
  expect(spentReading(undefined, NOW)).toEqual({ fiveHour: { pct: 100 }, at: NOW })
})

test('reads each model\'s own week from the usage body\'s limits, and which one a session\'s model falls under', () => {
  const body = {
    five_hour: null,
    seven_day: { utilization: 80, resets_at: WEEK_END },
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 80, resets_at: WEEK_END, scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 100, resets_at: WEEK_END, scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      // A limit on a surface, not a model, is not a model's week.
      { kind: 'weekly_scoped', group: 'weekly', percent: 50, resets_at: WEEK_END, scope: { model: null, surface: 'cowork' } },
    ],
  }
  const reading = readingFromUsage(body, NOW)
  expect(reading).toEqual({ sevenDay: { pct: 80, resetsAt: WEEK_END }, models: { Fable: { pct: 100, resetsAt: WEEK_END } }, at: NOW })
  const readings = { '1': reading ?? { at: NOW } }
  expect(scopeOf('claude-fable-5-2', readings)).toBe('Fable')
  expect(scopeOf('Fable 5.2', readings)).toBe('Fable')
  expect(scopeOf('claude-opus-5-5', readings)).toBeUndefined()
  expect(scopeOf(undefined, readings)).toBeUndefined()
})

test('a Fable session leaves at 95% of the Fable week and picks by the smaller room; an Opus session goes by the week alone', () => {
  const v = view({ '1': [0, 80], '2': [0, 10], '3': [0, 30] })
  const fable = (pct: number) => ({ Fable: { pct, resetsAt: WEEK_END } })
  const readings: Record<string, Reading> = {
    '1': { sevenDay: { pct: 80, resetsAt: WEEK_END }, models: fable(95), at: NOW },
    '2': { sevenDay: { pct: 10, resetsAt: WEEK_END }, models: fable(94), at: NOW },
    '3': { sevenDay: { pct: 30, resetsAt: WEEK_END }, models: fable(20), at: NOW },
  }
  const opus = { ...v, readings, model: 'claude-opus-5-5' }
  const onFable = { ...opus, model: 'claude-fable-5-2' }
  expect(shouldLeave(opus, NOW)).toBe(false)
  expect(shouldLeave(onFable, NOW)).toBe(true)
  // Account 2 has the most week left, but only 6% of its Fable week.
  expect(pickTarget(onFable, NOW)?.id).toBe('3')
  expect(pickTarget(opus, NOW)?.id).toBe('2')
  expect(roomOf(readings['2'], NOW, 'Fable')).toBe(6)
  expect(roomOf(readings['2'], NOW)).toBe(90)
  // With a 5-hour window, the smaller of what it can serve now and the Fable week.
  expect(roomOf({ fiveHour: { pct: 10, resetsAt: LATER }, sevenDay: { pct: 30, resetsAt: WEEK_END }, models: fable(70), at: NOW }, NOW, 'Fable')).toBe(30)
})

test('the next account frees up once the last of its spent windows resets: a window with room, soon as it resets, frees nothing', () => {
  // Both spent by the week; their 5-hour windows, a third used, reset in two hours.
  expect(nextReset(view({ '1': [30, 96], '2': [20, 97] }), NOW)).toBe(Date.parse(WEEK_END))
  // Spent by the 5-hour window alone: that one's reset.
  expect(nextReset(view({ '1': [95, 50], '2': [91, 10] }), NOW)).toBe(Date.parse(LATER))
  // An account with both windows spent frees up at the later reset; another's sooner one is the next.
  expect(nextReset(view({ '1': [95, 96] }), NOW)).toBe(Date.parse(WEEK_END))
  expect(nextReset(view({ '1': [95, 96], '2': [91, 10] }), NOW)).toBe(Date.parse(LATER))
  // A Fable session's Fable week counts, for it alone; nothing spent, nothing to wait for.
  const v = view({ '1': [30, 50] })
  const fable: View = { ...v, readings: { '1': { ...v.readings['1'], models: { Fable: { pct: 96, resetsAt: WEEK_END } }, at: NOW } }, model: 'claude-fable-5-2' }
  expect(nextReset(fable, NOW)).toBe(Date.parse(WEEK_END))
  expect(nextReset({ ...fable, model: 'claude-opus-5-5' }, NOW)).toBeUndefined()
  // A spent window that doesn't say when it resets: unknown.
  expect(nextReset({ ...v, readings: { '1': { fiveHour: { pct: 95 }, at: NOW } } }, NOW)).toBeUndefined()
})

test('a turn on Fable that hits a limit fills the Fable week where it is the fullest window, else the window that limits the login', () => {
  const r = { sevenDay: { pct: 80, resetsAt: WEEK_END }, models: { Fable: { pct: 96, resetsAt: WEEK_END } }, usageAt: NOW - 60_000, at: NOW - 1 }
  // Noted as a usage check's answer is, so a response another session reports doesn't put the older week back.
  expect(spentReading(r, NOW, 'Fable')).toEqual({ sevenDay: { pct: 80, resetsAt: WEEK_END }, models: { Fable: { pct: 100, resetsAt: WEEK_END } }, usageAt: NOW, at: NOW })
  expect(spentReading(r, NOW)).toEqual({ sevenDay: { pct: 100, resetsAt: WEEK_END }, models: { Fable: { pct: 96, resetsAt: WEEK_END } }, usageAt: NOW - 60_000, at: NOW })
  const five = { fiveHour: { pct: 85, resetsAt: LATER }, sevenDay: { pct: 30, resetsAt: WEEK_END }, models: { Fable: { pct: 40, resetsAt: WEEK_END } }, at: NOW }
  expect(spentReading(five, NOW, 'Fable')).toEqual({ ...five, fiveHour: { pct: 100, resetsAt: LATER } })
  // The week fuller than the Fable week: the turn more likely ran out of week, which sessions on other models must see too.
  const week = { fiveHour: { pct: 20, resetsAt: LATER }, sevenDay: { pct: 94, resetsAt: WEEK_END }, models: { Fable: { pct: 30, resetsAt: WEEK_END } }, at: NOW }
  expect(spentReading(week, NOW, 'Fable')).toEqual({ ...week, fiveHour: { pct: 100, resetsAt: LATER } })
  expect(isSpent(spentReading(week, NOW, 'Fable'), NOW)).toBe(true)
  // Level, as all are once the windows reset: no reason to single the Fable week out.
  const level = { fiveHour: { pct: 0 }, sevenDay: { pct: 0, resetsAt: WEEK_END }, models: { Fable: { pct: 0, resetsAt: WEEK_END } }, at: NOW }
  expect(spentReading(level, NOW, 'Fable')).toEqual({ ...level, fiveHour: { pct: 100 } })
})

test('a new session starts where a 5-hour window hasn\'t started: Claude Code\'s login if it qualifies, else the week resetting soonest; claimed, short of week, or locked ones are passed over', () => {
  const soon = '2026-10-14T03:00:00Z'
  const later = '2026-10-16T03:00:00Z'
  const at = (v: View, id: string, five: number, week: number, weekResets: string) => {
    v.readings[id] = { fiveHour: { pct: five, ...(five > 0 ? { resetsAt: LATER } : {}) }, sevenDay: { pct: week, resetsAt: weekResets }, at: NOW }
  }
  const v = view({ '1': [0, 0], '2': [0, 0], '3': [0, 0], '4': [0, 0] })
  at(v, '1', 30, 40, later)
  at(v, '2', 0, 50, later)
  at(v, '3', 0, 20, soon)
  at(v, '4', 10, 5, soon)
  // Account 4's window is running; of 2 and 3, 3's week resets first.
  expect(pickStart(v, NOW, {})?.id).toBe('3')
  // Another new session claimed 3 a minute ago; ten minutes on, the claim has lapsed.
  expect(pickStart(v, NOW, { '3': NOW - 60_000 })?.id).toBe('2')
  expect(pickStart(v, NOW, { '3': NOW - 11 * 60_000 })?.id).toBe('3')
  // Too little of its week left: it would soon move on.
  at(v, '3', 0, 90, soon)
  expect(pickStart(v, NOW, {})?.id).toBe('2')
  // A login that needs a sign-in is no start.
  expect(pickStart({ ...v, health: { ...v.health, '2': { kind: 'login-needed', why: 'x' } } }, NOW, {})).toBeUndefined()
  // Claude Code's login, its own window not started, needs no switch.
  at(v, '1', 0, 40, later)
  expect(pickStart(v, NOW, {})?.id).toBe('1')
  // A window that reset since its reading hasn't started again as far as is known: once 1's and 4's have, 1 is the start.
  at(v, '1', 30, 40, later)
  expect(pickStart(v, NOW, { '2': NOW })).toBeUndefined()
  expect(pickStart(v, Date.parse(LATER) + 1, { '2': NOW })?.id).toBe('1')
  // A week-only plan has no 5-hour window to start.
  v.readings['3'] = { sevenDay: { pct: 20, resetsAt: soon }, at: NOW }
  expect(pickStart(v, NOW, {})?.id).toBe('3')
})

test('a new Fable session starts only where the Fable week has room too', () => {
  const v = view({ '1': [30, 40], '2': [0, 10], '3': [0, 20] })
  v.readings['2'] = { ...v.readings['2']!, sevenDay: { pct: 10, resetsAt: '2026-10-14T03:00:00Z' }, models: { Fable: { pct: 90, resetsAt: WEEK_END } } }
  expect(pickStart(v, NOW, {})?.id).toBe('2')
  expect(pickStart({ ...v, model: 'claude-fable-5-2' }, NOW, {})?.id).toBe('3')
})

test('says how long ago, in minutes, hours or days', () => {
  expect(agoText(NOW - 40 * 60_000, NOW)).toBe('40m ago')
  expect(agoText(NOW - 125 * 60_000, NOW)).toBe('2h 5m ago')
  expect(agoText(NOW - 76 * 3600_000, NOW)).toBe('3d 4h ago')
  expect(agoText(NOW + 60_000, NOW)).toBe('0m ago')
})

test('a reading keeps the model weeks of whichever reading asked the usage endpoint last, and says when it last told all that endpoint tells', () => {
  const fable = (pct: number) => ({ Fable: { pct, resetsAt: WEEK_END } })
  const asked: Reading = { sevenDay: { pct: 40, resetsAt: WEEK_END }, models: fable(60), usageAt: NOW - 600_000, at: NOW - 600_000 }
  // A response's report, or an older version's reading: the week as it is now, the Fable week as last asked.
  const report: Reading = { sevenDay: { pct: 45, resetsAt: WEEK_END }, at: NOW }
  expect(withModelWeeks(report, asked)).toEqual({ sevenDay: { pct: 45, resetsAt: WEEK_END }, models: fable(60), usageAt: NOW - 600_000, at: NOW })
  expect(withModelWeeks(report, undefined)).toBe(report)
  // The later answer wins, whichever side has it, and one with no model weeks takes them away.
  const later: Reading = { sevenDay: { pct: 45, resetsAt: WEEK_END }, models: fable(70), usageAt: NOW, at: NOW }
  expect(withModelWeeks(later, asked)).toBe(later)
  expect(withModelWeeks(asked, { sevenDay: { pct: 50 }, usageAt: NOW, at: NOW })).toEqual({ sevenDay: { pct: 40, resetsAt: WEEK_END }, usageAt: NOW, at: NOW - 600_000 })
  // Never asked: unknown. With a model week: when asked. Without: when read, a response's report serving.
  expect(usageReadAt(report)).toBeUndefined()
  expect(usageReadAt(withModelWeeks(report, asked))).toBe(NOW - 600_000)
  expect(usageReadAt({ sevenDay: { pct: 45 }, usageAt: NOW - 600_000, at: NOW })).toBe(NOW)
})

test('next in list moves to the login after the one in use, wrapping, past spent and locked ones', () => {
  const at = (activeId: string, v: View) => pickTarget({ ...v, activeId }, NOW)?.id
  const v = view({ '1': [10, 10], '2': [95, 10], '3': [20, 10], '4': [80, 10] }, {}, 'order')
  expect(at('2', v)).toBe('3')
  expect(at('4', v)).toBe('1')
  expect(at('3', v)).toBe('4')
  expect(at('2', view({ '1': [10, 10], '2': [95, 10], '3': [91, 10], '4': [80, 10] }, {}, 'order'))).toBe('4')
  expect(at('2', view({ '1': [10, 10], '2': [95, 10], '3': [20, 10], '4': [0, 0] }, { '3': { kind: 'login-needed', why: 'x' } }, 'order'))).toBe('4')
})

test('a stored rotation choice is kept when known, else the soonest reset', () => {
  expect(rotateToFrom('order')).toBe('order')
  expect(rotateToFrom('off')).toBe('off')
  expect(rotateToFrom('room')).toBe('room')
  expect(rotateToFrom('nope')).toBe('reset')
  expect(rotateToFrom(undefined)).toBe('reset')
})

test('a window whose reset time has passed since its reading is unknown, and not spent', () => {
  expect(windowPct({ pct: 97, resetsAt: LATER }, Date.parse(LATER) + 1)).toBeUndefined()
  expect(windowPct({ pct: 97, resetsAt: LATER }, NOW)).toBe(97)
  expect(isSpent({ fiveHour: { pct: 97, resetsAt: LATER }, at: NOW }, Date.parse(LATER) + 1)).toBe(false)
})

test('reads the usage endpoint body as /usage serves it', () => {
  const body = {
    five_hour: { utilization: 39.0, resets_at: '2026-10-12T12:10:00.246761+00:00', locked_reason: null },
    seven_day: { utilization: 55.0, resets_at: '2026-10-18T03:00:00.246781+00:00', locked_reason: null },
    seven_day_opus: null,
  }
  expect(readingFromUsage(body, NOW)).toEqual({
    fiveHour: { pct: 39, resetsAt: '2026-10-12T12:10:00.246761+00:00' },
    sevenDay: { pct: 55, resetsAt: '2026-10-18T03:00:00.246781+00:00' },
    at: NOW,
  })
})

test('a stored login whose refresh token ran out needs a sign-in', () => {
  const blob = (refreshTokenExpiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: NOW + 1000, refreshTokenExpiresAt } })
  expect(healthOf(credentialFrom(blob(NOW - 1)), NOW)).toEqual({ kind: 'login-needed', why: 'sign-in expired' })
  expect(healthOf(credentialFrom(blob(NOW + 1000)), NOW).kind).toBe('ok')
  expect(healthOf(credentialFrom('not json'), NOW)).toEqual({ kind: 'login-needed', why: 'not signed in' })
})

test('reads who a token signs in from the profile endpoint body: its email and organization', () => {
  const body = {
    account: { uuid: 'a-1', email: 'you@example.com', full_name: 'You' },
    organization: { uuid: 'o-1', name: 'Acme', organization_type: 'claude_team', rate_limit_tier: 'default_raven', seat_tier: 'team_standard' },
  }
  expect(identityFromProfile(body)).toEqual({ email: 'you@example.com', orgId: 'o-1', orgName: 'Acme' })
  expect(identityFromProfile({ account: { email: 'you@example.com' } })).toEqual({ email: 'you@example.com' })
  expect(identityFromProfile({ organization: { uuid: 'o-1' } })).toBeUndefined()
  expect(identityFromProfile(null)).toBeUndefined()
})

test('a stored sign-in carries its plan, which Claude Code reads to tell a Team seat, and the refresh token a new sign-in replaces', () => {
  const text = JSON.stringify({ claudeAiOauth: { accessToken: 't', refreshToken: 'r', expiresAt: NOW, subscriptionType: 'team' } })
  expect(credentialFrom(text)).toEqual({ accessToken: 't', expiresAt: NOW, refreshToken: 'r', plan: 'team' })
})

test('names keychain entries as Claude Code does', async () => {
  expect(await keychainItem('')).toBe('Claude Code-credentials')
  // sha256("/Users/tester/.claude/accounts/2") starts with these 8 hex digits.
  expect(await keychainItem('/Users/tester/.claude/accounts/2')).toBe(`Claude Code-credentials-${EXPECTED_SLOT2_HASH}`)
})

const EXPECTED_SLOT2_HASH = 'a296c876'

test('names credentials files as Claude Code does where there is no keychain', () => {
  expect(credentialsFile('', '/home/tester')).toBe('/home/tester/.claude/.credentials.json')
  expect(credentialsFile('', undefined)).toBeUndefined()
  expect(credentialsFile('', '')).toBeUndefined()
  expect(credentialsFile('/home/tester/.claude/accounts/2', undefined)).toBe('/home/tester/.claude/accounts/2/.credentials.json')
  // Claude Code keeps it in the directory's NFC spelling, which Linux tells apart from others.
  expect(credentialsFile('/home/rene\u0301/.claude/accounts/2', undefined)).toBe('/home/ren\u00e9/.claude/accounts/2/.credentials.json')
})

test('room left is colored green with all of it, through yellow, to red with none', () => {
  expect(roomColor(100)).toBe('#36e236')
  expect(roomColor(50)).toBe('#e2e236')
  expect(roomColor(0)).toBe('#e23636')
})

test('a pie fills by quarters', () => {
  expect([0, 12, 13, 50, 87, 88, 100].map(pie)).toEqual(['○', '○', '◔', '◑', '◕', '●', '●'])
  expect(pie(undefined)).toBe('·')
})

test('a braille cell fills from one dot to eight', () => {
  expect([0, 14, 50, 93, 100].map(braille)).toEqual(['⡀', '⣀', '⣦', '⣿', '⣿'])
})

test('a stored footer look keeps what it knows and defaults the rest', () => {
  expect(footerStyleFrom({ session: 'pie', week: 'nope', weekPercent: false, active: 'bright', fill: 'used' })).toEqual({
    session: 'pie',
    week: 'bars',
    sessionPercent: true,
    weekPercent: false,
    active: 'lines',
    fill: 'used',
  })
  expect(footerStyleFrom(undefined)).toEqual({ session: 'braille', week: 'bars', sessionPercent: true, weekPercent: true, active: 'lines', fill: 'left' })
})

test('a switch Claude Code\'s security policy refuses is told from any other failure', () => {
  const refused = 'HooksError: account-rotator: $.env.set: env (managed): CLAUDE_SECURESTORAGE_CONFIG_DIR is not for plugins outside policy to change'
  expect(isPolicyRefusal(new Error(refused))).toBe(true)
  expect(isPolicyRefusal(refused)).toBe(true)
  expect(isPolicyRefusal(new Error('HooksError: account-rotator: $.env.set: timed out'))).toBe(false)
  expect(isPolicyRefusal(undefined)).toBe(false)
})

test('a session that can\'t switch says to stop a background session, which /exit leaves running, and to resume this conversation by its id', () => {
  const onSeat = { ...view({ '1': [10, 10], '2': [100, 30] }), activeId: '2', sessionId: 'session-1', isSwitchBlocked: true }
  expect(restartSteps(onSeat)).toBe('Quit (in a background session, /stop: /exit only detaches), then run: claude --resume session-1')
  expect(restartSteps({ ...onSeat, sessionId: undefined })).toMatch(/then run: claude --continue$/)
  expect(blockedAdvice(onSeat)).toMatch(/starts or reloads plugins\. Fix: Quit \(in a background session, \/stop: \/exit only detaches\), then run: claude --resume session-1\. Not \/restart/)
  expect(blockedAdvice(onSeat)).not.toMatch(/\/login/)
  // Started on a seat as Claude Code's login: a personal sign-in there first, or the new session starts on the seat again.
  const onLogin = { ...view({ '1': [100, 30], '2': [10, 10] }), sessionId: 'session-1', isSwitchBlocked: true }
  expect(blockedAdvice(onLogin)).toMatch(/Fix: \/login with your personal \(Pro or Max\) account\. Quit .*claude --resume session-1\.$/)
  // Spent where it can't leave, while another login has room: what to do.
  expect(stuckText(onSeat, NOW)).toBe(
    "Account 2 is out of usage, and this window can't switch accounts. Quit (in a background session, /stop: /exit only detaches), then run: claude --resume session-1",
  )
  expect(stuckText(onLogin, NOW)).toMatch(/^Account 1 is out of usage, and this window can't switch accounts\. \/login with your personal \(Pro or Max\) account\. Quit /)
  // Free to switch, with room, or with nowhere to go: nothing to say.
  expect(stuckText({ ...onSeat, isSwitchBlocked: false }, NOW)).toBeUndefined()
  expect(stuckText({ ...onSeat, activeId: '1' }, NOW)).toBeUndefined()
  expect(stuckText({ ...view({ '1': [95, 30], '2': [100, 30] }), activeId: '2', isSwitchBlocked: true }, NOW)).toBeUndefined()
})

test('a browser call found no browser when Claude Code says so as an error or as a whole result, or the list of browsers is empty; not when a page mentions it', () => {
  const words = 'Browser extension is not connected: the OAuth token Claude Code is using belongs to a different claude.ai account.'
  expect(isUnansweredCall('mcp__claude-in-chrome__tabs_context_mcp', words, true)).toBe(true)
  expect(isUnansweredCall('mcp__claude-in-chrome__tabs_context_mcp', words, false)).toBe(true)
  expect(isUnansweredCall('mcp__claude-in-chrome__tabs_context_mcp', `Error: ${words}`, false)).toBe(true)
  expect(isUnansweredCall('mcp__claude-in-chrome__get_page_text', `Troubleshooting\n\nIf you see "${words}", sign in again.`, false)).toBe(false)
  expect(isUnansweredCall('mcp__claude-in-chrome__list_connected_browsers', '[]', false)).toBe(true)
  expect(isUnansweredCall('mcp__claude-in-chrome__list_connected_browsers', '[{"deviceId":"d"}]', false)).toBe(false)
  expect(isUnansweredCall('mcp__claude-in-chrome__get_page_text', '[]', false)).toBe(false)
})

test('reads a Retry-After header as seconds or an HTTP date, from now', () => {
  expect(retryAfter('120', NOW)).toBe(120_000)
  expect(retryAfter(new Date(NOW + 30 * 60_000).toUTCString(), NOW)).toBe(30 * 60_000)
  expect(retryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0)
  expect(retryAfter('soon', NOW)).toBeUndefined()
  expect(retryAfter('', NOW)).toBeUndefined()
  expect(retryAfter(undefined, NOW)).toBeUndefined()
})

test('counts the browsers Claude in Chrome lists, and knows its words for none answering', () => {
  expect(browsersFrom('[{"deviceId":"d","name":"Browser 1","osPlatform":"macOS","isLocal":true}]')).toBe(1)
  expect(browsersFrom('[]')).toBe(0)
  expect(browsersFrom('Browser extension is not connected.')).toBeUndefined()
  expect(isNoBrowser('Browser extension is not connected. Please ensure the Claude browser extension is installed and running')).toBe(true)
  expect(isNoBrowser("[Claude in Chrome] Claude in Chrome isn't paired with your browser (reported by the extension, unverified: account_mismatch)")).toBe(true)
  expect(isNoBrowser('Tab 12 no longer exists')).toBe(false)
})

test('the notes about Claude in Chrome say what the mod does now and what to tell the user, never /login', () => {
  const accounts = [
    { id: '1', slot: '', email: 'one@example.com' },
    { id: '2', slot: '/h/.claude/accounts/2', email: 'two@example.com' },
  ]
  const base = { ...view({ '1': [10, 10], '2': [10, 10] }), accounts, chromeAccountId: '1', activeId: '2', sessionId: 'session-1' }
  const onTwo = { ...base, chrome: { as: '2', isPaired: false, hasFailed: true } }
  expect(chromeNote(onTwo, 'connecting')).toBe(
    'Claude in Chrome connected as Claude account 2 (two@example.com) and found no browser. ' +
      "The account-rotator mod is now connecting it as Claude account 1 (one@example.com), the account the user's Chrome extension is signed in to, which takes under a minute. " +
      "End your turn now: you'll get a message once it's connected. Don't suggest /login: it doesn't fix this.",
  )
  expect(chromeNote(base, 'held')).toMatch(/^The account-rotator mod is connecting Claude in Chrome as Claude account 1 \(one@example\.com\).* End your turn now/)
  expect(chromeNote(onTwo, 'no-browser')).toMatch(/^No Chrome extension answers as Claude account 1 \(one@example\.com\), the account picked for it in the Claude accounts panel: .* If it is another account, they press Use for Chrome or Try to connect next to it .* If it matches, they restart Chrome and press Connect above the prompt\./)
  const blocked = { ...onTwo, isSwitchBlocked: true }
  expect(chromeNote(blocked, 'blocked')).toMatch(
    /Claude Code doesn't let this session switch accounts\. Tell the user that to use Chrome, they quit Claude Code \(in a background session, with \/stop: \/exit only detaches\) and run `claude --resume session-1` in a terminal/,
  )
  // Connected as the extension's account in a session that can't move: no Connect to press, Chrome to open.
  expect(chromeNote({ ...blocked, chrome: { as: '1', isPaired: false } }, 'no-browser')).toMatch(/If it matches, they restart Chrome, then you try again\./)
  expect(chromeNote({ ...onTwo, chromeAccountId: undefined }, 'unset')).toMatch(/doesn't know which one that is\. Ask the user to press Use for Chrome or Try to connect next to it under Chrome in the Claude accounts panel/)
  for (const kind of ['held', 'connecting', 'no-browser', 'blocked', 'unset'] as const) expect(chromeNote(onTwo, kind)).not.toMatch(/Run \/login|run \/login/)
})
