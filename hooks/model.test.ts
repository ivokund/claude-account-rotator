import { expect, test } from 'claude-code/testing'

import type { View } from '../types'
import { DEFAULT_FOOTER, availableNow, braille, credentialFrom, credentialsFile, footerStyleFrom, healthOf, keychainItem, pickTarget, pie, readingFromUsage, shouldLeave, roomColor, windowPct } from './model'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const LATER = '2026-10-12T12:00:00Z'
const WEEK_END = '2026-10-18T03:00:00Z'

function view(readings: Record<string, [number, number]>, health: Record<string, View['health'][string]> = {}): View {
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
    activeId: '1',
    footer: DEFAULT_FOOTER,
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
  expect(availableNow({ fiveHour: { pct: 97, resetsAt: LATER }, at: NOW }, Date.parse(LATER) + 1)).toBe(100)
})

test('a window counts as empty once its reset time has passed', () => {
  expect(windowPct({ pct: 97, resetsAt: LATER }, Date.parse(LATER) + 1)).toBe(0)
  expect(windowPct({ pct: 97, resetsAt: LATER }, NOW)).toBe(97)
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
