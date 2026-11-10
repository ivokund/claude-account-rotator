import { expect, test } from 'claude-code/testing'

import type { RotateTo, View } from '../types'
import { DEFAULT_FOOTER, availableNow, blockedAdvice, braille, browsersFrom, chromeNote, credentialFrom, credentialsFile, footerStyleFrom, healthOf, identityFromProfile, isNoBrowser, isPolicyRefusal, keychainItem, pickTarget, pie, readingFromUsage, restartSteps, rotateToFrom, shouldLeave, roomColor, stuckText, windowPct } from './model'

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
