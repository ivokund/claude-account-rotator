import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult, SessionRateLimit, ToolCallArgs } from 'claude-code'

import { DEFAULT_FOOTER, credentialFrom, keychainItem, roomColor } from './model'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const HOUR = 3600_000
const HOME = '/Users/tester'
const SLOT2 = `${HOME}/.claude/accounts/2`
/** Where Claude Code keeps logins 1 and 2 on Linux. */
const FILE1 = `${HOME}/.claude/.credentials.json`
const FILE2 = `${SLOT2}/.credentials.json`

type World = {
  /** The machine: macOS has a file of its own a Linux machine lacks */
  system: 'macOS' | 'Linux'
  /** keychain item name -> stored JSON */
  keychain: Record<string, string>
  /** credentials file -> stored text, or null where it cannot be read */
  files: Record<string, string | null>
  /** Per token, the 5-hour and the week percent used, null for a window the plan does not report; and when the week resets. */
  usage: Record<string, [number | null, number | null, string?]>
  /** Per token, its Fable week's percent, as the usage endpoint's `limits` lists it. */
  fable?: Record<string, number>
  /** The session's model, as `$.session.model()` answers it. */
  model?: string
  /** access token -> the email of the account it signs in, as the profile endpoint answers */
  owners: Record<string, string>
  /** The token a /login signs in, where the session reads its sign-in, and its plan. */
  loginToken?: string
  loginPlan?: string
  /** slot -> signed-in email */
  emails: Record<string, string>
  envSets: { name: string; value?: string }[]
  spawned: { argv: readonly string[]; env?: Record<string, string> }[]
  submitted: string[]
  /** What the session's last response reported, as `$.session.usage()` answers it. */
  limits: SessionRateLimit[]
  /** Ids of the panes open now. */
  panes: string[]
  toasts: string[]
  /** The session's environment beyond USER and HOME. */
  env: Record<string, string>
  /** Claude Code's security policy refuses every switch, as in a session on a Team seat. */
  refuseEnv?: boolean
  /**
   * Claude in Chrome, where the session has it: the slots of the accounts a
   * Chrome extension is signed in to, one per Chrome profile, and the slot its
   * connection was made as. `asText`: Claude Code words a call that finds no
   * browser as an ordinary result, not an error.
   */
  chrome?: { extensions: string[]; as?: string; asText?: boolean }
  /** The slot in use at each of the mod's calls to Claude in Chrome, the session having it or not. */
  chromeAsked: string[]
  /** The slash commands the mod ran, as typed. */
  commands: string[]
  /** Claude Code lends plugins the session's sign-in (`$.session.authorize`); false as where it has none to lend. */
  lendsSignIn?: boolean
  /** Claude Code never reads the sign-in again after a switch, so the switch never takes. */
  isCacheStuck?: boolean
  /** The usage endpoint answers 429, as Anthropic rate limits it. */
  isUsageLimited?: boolean
  /** The Retry-After header a rate-limited usage check comes back with. */
  retryAfter?: string
  /** The tokens the usage endpoint was asked about, in order. */
  usageAsked: string[]
}

/** Claude Code's words for a browser call that found no browser, as a session moved off its login gets them. */
const NO_BROWSER =
  'Browser extension is not connected: the OAuth token Claude Code is using belongs to a different claude.ai account than the one Claude Code is logged in as. ' +
  'If CLAUDE_CODE_OAUTH_TOKEN is set in your shell or CI profile, unset it (or re-mint it for this account), then run /logout and /login in Claude Code and make sure the browser extension is signed into the same claude.ai account.'

const blob = (token: string, expiresAt = NOW + 6 * HOUR, plan = 'max') =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `refresh-${token}`,
      expiresAt,
      refreshTokenExpiresAt: NOW + 20 * 24 * HOUR,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: plan,
    },
  })

const ran = (exitCode: number, stdout: string): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** Everything beneath the plugin: keychain or credentials files, `claude auth`, the usage API, the UI sinks. */
function world(on: On, w: World, store: Record<string, unknown>): MockClock {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  mock.env(on, { USER: 'tester', HOME, ...w.env })
  let slot = w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? ''
  // Claude Code reads a sign-in again only just before a request, once its 30 s read has run out:
  // until then it holds the slot it read before, whatever slot the session is on.
  let held = { slot, until: 0 }
  on('env.set', (_$, e) => {
    if (w.refuseEnv) return { deny: `env (managed): ${e.name} is not for plugins outside policy to change` }
    // The mod sets the slot in use at its start, to learn whether it may switch: not a switch.
    if ((e.value ?? '') === slot) return { value: {} }
    held = { slot: held.slot, until: Math.max(held.until, clock.now() + 30_000) }
    slot = e.value ?? ''
    w.envSets.push(e)
    return { value: {} }
  })
  on('turn.step', async function* (_$, e) {
    if (clock.now() >= held.until && !w.isCacheStuck) held = { slot, until: clock.now() + 30_000 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  const heldSlot = () => held.slot
  on('session.authorize', () => ({ value: w.lendsSignIn === false ? null : { handle: 'session-sign-in', kind: 'bearer' as const } }))
  on('process.run', (_$, e) => {
    const [cmd, sub, verb] = e.argv
    if (cmd === 'security') {
      const stored = w.keychain[e.argv[e.argv.length - 1] ?? '']
      return { value: stored === undefined ? ran(44, '') : ran(0, stored) }
    }
    if (cmd === 'claude' && sub === 'auth' && verb === 'status') {
      const email = w.emails[e.init?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '']
      const status = email ? { loggedIn: true, email, orgId: `org-${email}`, orgName: 'Org', subscriptionType: 'max' } : { loggedIn: false }
      return { value: ran(0, JSON.stringify(status)) }
    }
    throw new Error(`unexpected command: ${e.argv.join(' ')}`)
  })
  on('http.fetch', async (_$, e) => {
    // The session's own sign-in, by its handle: the token of the slot Claude Code holds now.
    const own = e.init?.auth === 'session-sign-in' ? credentialFrom(w.keychain[await keychainItem(heldSlot())] ?? '')?.accessToken : undefined
    const token = own ?? (e.init?.headers?.Authorization ?? '').replace('Bearer ', '')
    if (e.url === 'https://api.anthropic.com/api/oauth/profile') {
      const email = w.owners[token]
      if (email === undefined) return { value: { status: 404, ok: false, headers: {}, text: '' } }
      const profile = {
        account: { uuid: `account-${email}`, email },
        organization: { uuid: `org-${email}`, name: 'Org', organization_type: 'claude_max' },
      }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(profile) } }
    }
    w.usageAsked.push(token)
    if (w.isUsageLimited) {
      const headers: Record<string, string> = w.retryAfter === undefined ? {} : { 'retry-after': w.retryAfter }
      return { value: { status: 429, ok: false, headers, text: '' } }
    }
    const usage = w.usage[token]
    if (usage === undefined) return { value: { status: 401, ok: false, headers: {}, text: '' } }
    const [five, week, weekResetsAt = '2026-10-18T03:00:00Z'] = usage
    const fable = w.fable?.[token]
    const body = {
      five_hour: five === null ? null : { utilization: five, resets_at: '2026-10-12T12:00:00Z' },
      seven_day: week === null ? null : { utilization: week, resets_at: weekResetsAt },
      ...(fable === undefined
        ? {}
        : {
            limits: [
              { kind: 'weekly_all', percent: week, resets_at: weekResetsAt, scope: null },
              { kind: 'weekly_scoped', percent: fable, resets_at: weekResetsAt, scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
            ],
          }),
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  // Claude Code keeps a /login's sign-in where the session reads its own: the slot it is on.
  on('command.run', { command: 'login' }, async () => {
    if (w.loginToken !== undefined) w.keychain[await keychainItem(slot)] = blob(w.loginToken, NOW + 6 * HOUR, w.loginPlan)
    return { text: 'Login successful' }
  })
  // Claude in Chrome connects at its first call, as the slot the session is on then, until `/mcp reconnect`;
  // a browser answers only where that is an account a Chrome extension is signed in to.
  const isAnswered = (chrome: NonNullable<World['chrome']>) => {
    chrome.as ??= slot
    return chrome.extensions.includes(chrome.as)
  }
  on('mcp.call', (_$, e) => {
    w.chromeAsked.push(slot)
    if (w.chrome === undefined) return { deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }
    const browsers = isAnswered(w.chrome) ? [{ deviceId: 'device-1', name: 'Browser 1', osPlatform: 'macOS', isLocal: true }] : []
    return { value: { content: [{ type: 'text', text: JSON.stringify(browsers) }], isError: false } }
  })
  on('tool.call', { tool: /^mcp__claude-in-chrome__/ }, (_$, e) => {
    const isListed = e.tool.endsWith('__list_connected_browsers')
    if (w.chrome !== undefined && isAnswered(w.chrome)) {
      const text = isListed ? JSON.stringify([{ deviceId: 'device-1', name: 'Browser 1' }]) : 'Tabs: none'
      return { result: [{ type: 'text', text }], text }
    }
    if (isListed) return { result: [{ type: 'text', text: '[]' }], text: '[]' }
    if (w.chrome?.asText === true) return { result: [{ type: 'text', text: NO_BROWSER }], text: NO_BROWSER }
    return { isError: true as const, result: NO_BROWSER, text: NO_BROWSER }
  })
  on('command.run', { command: 'mcp' }, (_$, e) => {
    w.commands.push(`/mcp ${e.args}`)
    if (w.chrome !== undefined && e.args === 'reconnect claude-in-chrome') delete w.chrome.as
    return { text: 'Successfully reconnected to claude-in-chrome' }
  })
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: w.model ?? 'claude-opus-5-5' }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: w.limits } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'iterm2' } }))
  on('ui.open', (_$, e) => {
    if (!w.panes.includes(e.id)) w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: w.panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.close', (_$, e) => {
    w.panes = w.panes.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/System/Library/CoreServices/SystemVersion.plist' && w.system === 'macOS' }))
  on('fs.read', (_$, e) => {
    const text = w.files[e.path]
    if (text === null) return { deny: `EACCES: permission denied, open '${e.path}'` }
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  return clock
}

const fresh = (system: World['system'] = 'macOS'): World => ({
  system,
  keychain: {},
  files: {},
  usage: {},
  owners: {},
  emails: {},
  envSets: [],
  spawned: [],
  submitted: [],
  limits: [],
  panes: [],
  toasts: [],
  env: {},
  chromeAsked: [],
  commands: [],
  usageAsked: [],
})
const TWO_LOGINS ={ accounts: [{ id: '1', slot: '', email: 'one@example.com' }, { id: '2', slot: SLOT2, email: 'two@example.com' }] }

/** The props of every Text drawn with a color or on one, its hover with them, in document order. */
function painted(node: unknown): Record<string, unknown>[] {
  if (typeof node !== 'object' || node === null) return []
  const { type, props, hover, children } = node as { type?: string; props?: Record<string, unknown>; hover?: unknown; children?: unknown[] }
  const isPainted = props?.color !== undefined || props?.backgroundColor !== undefined
  const own = type === 'Text' && isPainted ? [{ ...props, ...(hover === undefined ? {} : { hover }) }] : []
  return [...own, ...(children ?? []).flatMap(painted)]
}

/** The footer's one control: its glyphs, opening the pane. */
const GLYPHS = { key: 'accounts' } as const

const PANE_PROPS = {
  title: 'Claude accounts',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

/** A model request, as a turn sends one: Claude Code reads the sign-in again first, once its last read has run out. */
async function request($: Engine, clock: MockClock): Promise<void> {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // The chunks say nothing here.
  }
  await stream.result
  await clock.settle()
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

test('a login with nothing in the keychain shows as needing a sign-in, with one button for it', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'account-rotator',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    })
    expect(await band.find({ text: /account 2 \(two@example.com\) needs a sign-in \(not signed in\)/ })).toBeDefined()
    expect(await band.find({ key: 'sign-in-all' })).toBeDefined()
    await band.unmount()
  }
  expect(w.envSets).toEqual([])
})

test('moves to the login with room once the active one passes 90% of its 5-hour window', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [92, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  // Braille of what each login can serve now over bars of its week: login 1 (8% left now)
  // on standby, login 2 (90% left) in use, a line down each side of its column, its percents at the right.
  const button = await footer.find(GLYPHS)
  expect(button?.text).toBe(' ⣀│⣷│  90% \n ▅│▆│  70% ')
  // Every glyph in its room's color, the lines in the theme's dim gray.
  const [one, lineBefore, two, lineAfter, percent] = painted(button?.children[0])
  expect(one).toMatchObject({ color: roomColor(8) })
  expect(lineBefore).toMatchObject({ color: 'subtle' })
  expect(two).toMatchObject({ color: roomColor(90) })
  expect(lineAfter).toMatchObject({ color: 'subtle' })
  expect(percent).toMatchObject({ color: roomColor(90) })
  await footer.unmount()
})

test('on Linux each login is read from the credentials file in its folder, the normal one\'s in ~/.claude, even with a `security` there', async ($, on) => {
  const w = fresh('Linux')
  w.keychain['Claude Code-credentials'] = blob('stale-1')
  w.keychain[await keychainItem(SLOT2)] = blob('stale-2')
  w.files[FILE1] = blob('tok-1')
  w.files[FILE2] = blob('tok-2')
  w.usage['tok-1'] = [92, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toBe(' ⣀│⣷│  90% \n ▅│▆│  70% ')
  await footer.unmount()
})

test('on Linux a login whose file is missing, holds no Claude login, cannot be read or is not JSON needs a sign-in, as Claude Code counts it', async ($, on) => {
  const slot = (id: number) => `${HOME}/.claude/accounts/${id}`
  const w = fresh('Linux')
  w.files[FILE1] = blob('tok-1')
  // Claude Code keeps MCP servers' sign-ins in the same file.
  w.files[`${slot(3)}/.credentials.json`] = JSON.stringify({ mcpOAuth: {} })
  w.files[`${slot(4)}/.credentials.json`] = null
  w.files[`${slot(5)}/.credentials.json`] = blob('tok-5').slice(0, 40)
  w.usage['tok-1'] = [20, 30]
  const more = [3, 4, 5].map(id => ({ id: String(id), slot: slot(id), email: `${id}@example.com` }))
  const clock = world(on, w, { accounts: [...TWO_LOGINS.accounts, ...more] })
  await start($, clock)
  const band = await $.ui.mount({
    plugin: 'account-rotator',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  const names = /account 2 \(two@example.com\), 3 \(3@example.com\), 4 \(4@example.com\), 5 \(5@example.com\) needs a sign-in \(not signed in\)\./
  expect(await band.find({ text: names })).toBeDefined()
  expect(await band.find({ key: 'sign-in-all' })).toBeDefined()
  await band.unmount()
  expect(w.envSets).toEqual([])
})

test('on Linux the band\'s Sign in reads the new login from the file the browser sign-in wrote in its slot', async ($, on) => {
  const w = fresh('Linux')
  w.files[FILE1] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  const clock = world(on, w, TWO_LOGINS)
  on('process.spawn', async function* (_$, e) {
    w.spawned.push(e)
    yield { stream: 'stdout' as const, text: 'Opening browser to sign in…\n' }
    w.files[FILE2] = blob('tok-2')
    w.usage['tok-2'] = [5, 12]
    return { value: { code: 0, signal: null } }
  })
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⚠   80% \n│▆│    70% ')
  const band = await $.ui.mount({
    plugin: 'account-rotator',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  await band.press({ key: 'sign-in-all' })
  await clock.settle()
  await band.unmount()
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⣿   80% \n│▆│▇   70% ')
  await footer.unmount()
})

test('on Linux a switch held back for a token about to refresh is made once the file holds the refreshed one', async ($, on) => {
  const w = fresh('Linux')
  w.files[FILE1] = blob('tok-1', NOW + 5 * 60_000)
  w.files[FILE2] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  await pane.press({ key: 'rotate' })
  await clock.settle()
  await clock.advance(2 * 60_000)
  expect(w.envSets).toEqual([])
  w.files[FILE1] = blob('tok-1', NOW + 8 * HOUR)
  await clock.advance(3 * 60_000)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  await pane.unmount()
})

test('the band\'s Sign in signs a locked login in through the browser, in its own slot', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  const item2 = await keychainItem(SLOT2)
  const clock = world(on, w, TWO_LOGINS)
  on('process.spawn', async function* (_$, e) {
    w.spawned.push(e)
    yield { stream: 'stdout' as const, text: 'Opening browser to sign in…\n' }
    w.keychain[item2] = blob('tok-2')
    w.usage['tok-2'] = [5, 12]
    return { value: { code: 0, signal: null } }
  })
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: ['auto mode'] } })
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⚠   80% \n│▆│    70% ')
  const band = await $.ui.mount({
    plugin: 'account-rotator',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  await band.press({ key: 'sign-in-all' })
  await clock.settle()
  await band.unmount()
  expect(w.spawned).toEqual([
    {
      argv: ['claude', 'auth', 'login', '--claudeai', '--email', 'two@example.com'],
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: SLOT2, CLAUDE_CONFIG_DIR: SLOT2 },
    },
  ])
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⣿   80% \n│▆│▇   70% ')
  expect(await footer.find({ text: /auto mode/ })).toBeDefined()
  await footer.unmount()
})

test('with rotation disabled, a spent login or a turn that dies on the usage limit stays put, and the pane says so', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [92, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'rotate-to': 'off' })
  await start($, clock)
  await clock.advance(11 * 60_000)
  w.usage['tok-1'] = [100, 41]
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.settle()
  await clock.advance(36_000)
  expect(w.envSets).toEqual([])
  expect(w.submitted).toEqual([])
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ text: /^Rotation is disabled/ })).toBeDefined()
  await pane.unmount()
})

test('where Claude Code\'s security policy refuses switching, as on a Team seat, the session says so at its start and once, then stops trying; a press still answers', async ($, on) => {
  const w = fresh()
  w.refuseEnv = true
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const notice = (t: string) => /^Can't switch accounts in this session/.test(t) && /#team-and-enterprise-accounts/.test(t)
  expect(w.toasts.filter(notice)).toHaveLength(1)
  // On the normal login, a personal sign-in there gives the next session one that can switch.
  expect(w.toasts.find(notice)).toMatch(
    /session that starts on a Team or Enterprise account\. Fix: \/login with your personal \(Pro or Max\) account\. Quit \(in a background session, \/stop: \/exit only detaches\), then run: claude --resume session-1\./,
  )
  // The login in use runs out: no switch is tried, and what to do about it is said once.
  w.usage['tok-1'] = [95, 41]
  await clock.advance(21 * 60_000)
  w.usage['tok-1'] = [100, 41]
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.settle()
  await clock.advance(36_000)
  expect(w.toasts.filter(notice)).toHaveLength(1)
  expect(w.toasts.filter(t => /^Account 1 is out of usage, and this window can't switch accounts\. \/login with your personal/.test(t))).toHaveLength(1)
  expect(w.submitted).toEqual([])
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find({ type: 'Text', text: '⚠' }))?.props).toMatchObject({ color: 'warning' })
  await footer.press({ key: 'switch-blocked' })
  await clock.settle()
  expect(w.panes).toEqual(['claude-accounts'])
  await footer.unmount()
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect((await pane.find({ type: 'Text', text: /^Can't switch accounts in this session\. .*starts on a Team/ }))?.props).toMatchObject({ color: 'warning' })
  await pane.press({ key: 'rotate' })
  await clock.settle()
  expect(w.toasts.filter(notice)).toHaveLength(2)
  expect(w.toasts.filter(t => /Something went wrong|Switched to/.test(t))).toEqual([])
  await pane.unmount()
})

test('where the policy starts refusing once the mod has moved the session to a seat, it says to start again, not to /login, which would sign in the seat', async ($, on) => {
  const w = fresh()
  w.refuseEnv = true
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const notice = w.toasts.filter(t => /^Can't switch accounts/.test(t))
  expect(notice).toHaveLength(1)
  expect(notice[0]).toMatch(
    /starts or reloads plugins\. Fix: Quit \(in a background session, \/stop: \/exit only detaches\), then run: claude --resume session-1\. Not \/restart, which keeps this account\./,
  )
  expect(notice[0]).not.toMatch(/\/login/)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /^Can't switch accounts.*Fix: Quit \(in a background session, \/stop/ })).toBeDefined()
  await pane.unmount()
})

test('a window that can\'t switch, on a seat that runs out while another login has room, says once how to bring the conversation back where it can, /stop for a background session, which /exit leaves running', async ($, on) => {
  const w = fresh()
  w.refuseEnv = true
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  await spentTwo(w)
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const stuck =
    "Account 2 is out of usage, and this window can't switch accounts. Quit (in a background session, /stop: /exit only detaches), then run: claude --resume session-1"
  expect(w.toasts.filter(t => t === stuck)).toHaveLength(1)
  const band = await mountBand($)
  expect((await band.find({ type: 'Text', text: `⚠ ${stuck}` }))?.props).toMatchObject({ color: 'warning' })
  await band.unmount()
  // Said once: the minute's checks and the usage checks after say no more.
  await clock.advance(21 * 60_000)
  expect(w.toasts.filter(t => t === stuck)).toHaveLength(1)
  expect(w.envSets).toEqual([])
})

test('a switch that does not take, Claude Code still sending the old login\'s sign-in minutes later, blinks meanwhile, then points the session back and marks the old login in use, and the rotation does not try it again', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [93, 40]
  w.usage['tok-2'] = [10, 30]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com' }
  w.isCacheStuck = true
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  // Responses go on reporting login 1's usage.
  w.limits = [
    { kind: 'five_hour', percentUsed: 93, resetsAt: '2026-10-12T12:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-18T03:00:00Z' },
  ]
  // Minutes on, idle: no request has shown the switch, and the next would read the new sign-in, so login 2 shows in use.
  await clock.advance(3 * 60_000)
  const idle = await mountPane($)
  expect(await idle.find({ type: 'Text', text: '● in use' })).toBeDefined()
  await idle.unmount()
  expect(w.toasts.filter(t => /did not take/.test(t))).toEqual([])
  // A request goes out, and Claude Code still sends login 1's sign-in.
  await clock.advance(2 * 60_000)
  await request($, clock)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.settle()
  expect(w.toasts.filter(t => /did not take: responses still use account 1/.test(t))).toHaveLength(1)
  expect(w.envSets).toEqual([
    { name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 },
    { name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: undefined },
  ])
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  const ends = (await pane.findAll({ text: /^(Remove|Use now|● in use)$/ })).filter(e => e.type !== 'Box')
  expect(ends.map(e => e.text)).toEqual(['● in use', 'Remove', 'Use now'])
  // Still spent, but the rotation leaves login 2 be.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.advance(30 * 60_000)
  expect(w.envSets).toHaveLength(2)
  await pane.press({ key: 'use-2' })
  await clock.settle()
  expect(w.envSets).toHaveLength(3)
  await pane.unmount()
})

test('a turn that dies on the usage limit moves to the other login, then asks Claude to carry on', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [60, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([])
  w.usage['tok-1'] = [100, 41]
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.settle()
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  expect(w.submitted).toEqual([])
  await clock.advance(36_000)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/Continue where you left off/)
})

test('a turn that dies on the usage limit of a login with no 5-hour window moves on, its week counted as full, not a 5-hour window', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  // Ultra plans report a week alone.
  w.usage['tok-1'] = [null, 60]
  w.usage['tok-2'] = [null, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([])
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.settle()
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  const pane = await mountPane($)
  // Its week shows spent, and no made-up 5-hour window stands beside it.
  expect((await pane.find({ key: 'account-1' }))?.text).toMatch(/5h·{10} none reportedweek▱{10} 0% left/)
  await pane.unmount()
})

test('a turn that dies on the usage limit just after a switch, sent as the login left, leaves the new login be and carries on once the switch lands', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [93, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  // Claude Code still sends login 1's cached sign-in, and login 1 runs out.
  await clock.advance(17_000)
  w.usage['tok-1'] = [100, 40]
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.settle()
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toMatch(/ 90% \n.* 70% $/)
  await footer.unmount()
  expect(w.envSets).toHaveLength(1)
  expect(w.submitted).toEqual([])
  await clock.advance(18_000)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/Continue where you left off/)
})

test('where Claude Code lends plugins no sign-in, a switch is confirmed once a response reports the new login usage, and an idle session is not told it failed', async ($, on) => {
  const w = fresh()
  w.lendsSignIn = false
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [93, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  // Minutes with no response: the last one is still login 1's, which says nothing of the switch.
  w.limits = [{ kind: 'five_hour', percentUsed: 93, resetsAt: '2026-10-12T12:00:00Z' }]
  await clock.advance(5 * 60_000)
  expect(w.toasts.filter(t => /has not shown/.test(t))).toEqual([])
  w.limits = [
    { kind: 'five_hour', percentUsed: 11, resetsAt: '2026-10-12T12:00:00Z' },
    { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-10-18T03:00:00Z' },
  ]
  await $.session.measure({ context: { window: 200_000 }, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.settle()
  // Confirmed: the next response's usage is login 2's own again.
  w.limits = [
    { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-12T12:00:00Z' },
    { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-10-18T03:00:00Z' },
  ]
  await $.session.measure({ context: { window: 200_000 }, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  // Room left, as the footer counts it: login 2 has used 20% of its 5-hour window and 30% of its week.
  expect(await pane.find({ text: /^▰{8}▱{2} 80% left$/ })).toBeDefined()
  expect(await pane.find({ text: /^▰{7}▱{3} 70% left$/ })).toBeDefined()
  expect(w.toasts.filter(t => /has not shown/.test(t))).toEqual([])
  await pane.unmount()
})

test('after Use now the footer\'s in-use mark blinks and the pane says switching until Claude Code is seen sending the new account\'s sign-in, with no response needed; then the mark stays and the pane says in use', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com' }
  const clock = world(on, w, { ...TWO_LOGINS, footer: { ...DEFAULT_FOOTER, active: 'tile' } })
  await start($, clock)
  const pane = await mountPane($)
  await pane.press({ key: 'use-2' })
  await clock.settle()
  expect(slots(w)).toEqual([SLOT2])
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  /** The session row's glyphs drawn on the tile, a beat on: the column marked in use. */
  const tiled = async () => {
    await clock.advance(500)
    await footer.redraw()
    return painted((await footer.find(GLYPHS))?.children[0]).filter(run => run.backgroundColor === 'subtle').length
  }
  // Claude Code still sends login 1's sign-in: login 2's tile comes and goes, its line in the pane says switching, and no toast says it switched.
  const beats = [await tiled(), await tiled(), await tiled(), await tiled()]
  expect(beats.sort()).toEqual([0, 0, 1, 1])
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toEqual([])
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: '◌ switching…' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '● in use' })).toBeUndefined()
  // 35 s on, idle: Claude Code reads the new sign-in before its next request, so the tile stays on login 2, beat after beat, and a toast says so.
  await clock.advance(33_000)
  expect([await tiled(), await tiled(), await tiled()]).toEqual([1, 1, 1])
  expect((await footer.find(GLYPHS))?.text).toBe(' ⣷▐⣷▌  90% \n ▆▐▆▌  70% ')
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: '● in use' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '◌ switching…' })).toBeUndefined()
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toEqual(['Switched to Claude account 2 (two@example.com · Org): you picked it.'])
  // The next request goes out as login 2, which confirms the switch, told once; its responses are login 2's from now on.
  await request($, clock)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-12T12:00:00Z' }], changed: ['rateLimits'] })
  await clock.settle()
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toMatch(/ 70% \n/)
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toHaveLength(1)
  expect(w.toasts.filter(t => /did not take|has not shown/.test(t))).toEqual([])
  await footer.unmount()
  await pane.unmount()
})

test('a switch made while Claude is working lands with its next request 30 s on, and the mark stops blinking then', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com' }
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  await request($, clock)
  const pane = await mountPane($)
  await pane.press({ key: 'use-2' })
  await clock.settle()
  // Requests 10 s and 20 s on still go out as login 1: Claude Code read it under 30 s before.
  await clock.advance(10_000)
  await request($, clock)
  await clock.advance(10_000)
  await request($, clock)
  await clock.advance(1_000)
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: '◌ switching…' })).toBeDefined()
  // One 31 s on reads login 2's: the next check confirms it, before 35 s.
  await clock.advance(10_000)
  await request($, clock)
  await clock.advance(4_000)
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: '● in use' })).toBeDefined()
  expect(w.toasts.filter(t => /^Switched to Claude account 2/.test(t))).toHaveLength(1)
  await pane.unmount()
})

test('a reading from before its window reset says nothing of the usage since: the footer draws it unknown, not empty, and the pane says it reset', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  // Login 2's token ran out, so it is not read now.
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2', NOW - HOUR)
  w.usage['tok-1'] = [20, 30]
  const old = { fiveHour: { pct: 97, resetsAt: '2026-10-12T09:00:00Z' }, sevenDay: { pct: 40, resetsAt: '2026-10-18T03:00:00Z' }, at: NOW - 6 * HOUR }
  const clock = world(on, w, { ...TWO_LOGINS, 'reading:2': old })
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toMatch(/^│⣷│· +80% \n│▆│▅ +70% $/)
  await footer.unmount()
  const pane = await mountPane($)
  expect((await pane.find({ key: 'account-2' }))?.text).toMatch(/·{10} reset, not read since/)
  await pane.unmount()
})

test('a usage check Anthropic rate limits pauses every session\'s checks for 5 minutes, and the pane says so; a reading another session took lately is not asked for again', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 24 * HOUR)
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2', NOW + 24 * HOUR)
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  // Another session read login 2 a minute ago.
  const lately = { fiveHour: { pct: 10, resetsAt: '2026-10-12T12:00:00Z' }, at: NOW - 60_000 }
  const clock = world(on, w, { ...TWO_LOGINS, 'reading:2': lately })
  await start($, clock)
  expect(w.usageAsked).toEqual(['tok-1'])
  w.isUsageLimited = true
  await clock.advance(10 * 60_000)
  // Login 1's check is turned away, and login 2's is not asked at all.
  expect(w.usageAsked).toEqual(['tok-1', 'tok-1'])
  const pane = await mountPane($)
  expect(await pane.find({ text: /^Anthropic is rate limiting usage checks, so these may be a few minutes old\. Checks resume in 5m\.$/ })).toBeDefined()
  await pane.unmount()
  w.isUsageLimited = false
  await clock.advance(10 * 60_000)
  expect(w.usageAsked).toEqual(['tok-1', 'tok-1', 'tok-1', 'tok-2'])
})

test('a rate-limited usage check whose Retry-After asks for longer pauses every session that long, up to an hour', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 24 * HOUR)
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2', NOW + 24 * HOUR)
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  const lately = { fiveHour: { pct: 10, resetsAt: '2026-10-12T12:00:00Z' }, at: NOW - 60_000 }
  const clock = world(on, w, { ...TWO_LOGINS, 'reading:2': lately })
  await start($, clock)
  w.isUsageLimited = true
  w.retryAfter = '1800'
  await clock.advance(10 * 60_000)
  expect(w.usageAsked).toEqual(['tok-1', 'tok-1'])
  let pane = await mountPane($)
  expect(await pane.find({ text: /Checks resume in 30m\.$/ })).toBeDefined()
  await pane.unmount()
  w.isUsageLimited = false
  // Not asked again before the 30 minutes are up, where 5 would have let it.
  await clock.advance(20 * 60_000)
  expect(w.usageAsked).toEqual(['tok-1', 'tok-1'])
  await clock.advance(15 * 60_000)
  expect(w.usageAsked.length).toBeGreaterThan(2)
  // A Retry-After of a day holds the checks back an hour at most.
  w.isUsageLimited = true
  w.retryAfter = '86400'
  const asked = w.usageAsked.length
  await clock.advance(10 * 60_000)
  expect(w.usageAsked.length).toBe(asked + 1)
  pane = await mountPane($)
  const wait = /Checks resume in (\d+)m\./.exec((await pane.find({ text: /Checks resume in/ }))?.text ?? '')
  expect(Number(wait?.[1])).toBeGreaterThan(30)
  expect(Number(wait?.[1])).toBeLessThanOrEqual(60)
  await pane.unmount()
  w.isUsageLimited = false
  await clock.advance(45 * 60_000)
  expect(w.usageAsked.length).toBe(asked + 1)
  await clock.advance(20 * 60_000)
  expect(w.usageAsked.length).toBeGreaterThan(asked + 1)
})

test('one press on the footer opens the accounts pane, the next closes it', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  // Switching works here: no warning beside the glyphs.
  expect(await footer.find({ key: 'switch-blocked' })).toBeUndefined()
  await footer.press(GLYPHS)
  await clock.settle()
  expect(w.panes).toEqual(['claude-accounts'])
  await footer.press(GLYPHS)
  await clock.settle()
  expect(w.panes).toEqual([])
  await footer.unmount()
})

test('under the pointer the footer names its rows and lights its glyphs on a shade, drawn swapped for the inverting control', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await footer.find({ text: 'Session:' })).toBeDefined()
  expect(await footer.find({ text: 'Weekly:' })).toBeDefined()
  const [line, one] = painted((await footer.find(GLYPHS))?.children[0])
  expect(line).toMatchObject({ color: 'subtle', hover: { color: 'userMessageBackground', backgroundColor: 'inactive' } })
  expect(one).toMatchObject({ color: roomColor(80), hover: { color: 'userMessageBackground', backgroundColor: roomColor(80, true) } })
  await footer.unmount()
})

test('Rotate now moves to the login with the most room; it says switching at the right end until the move is seen to land, then in use', async ($, on) => {
  const w = fresh()
  const SLOT3 = '/Users/tester/.claude/accounts/3'
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.keychain[await keychainItem(SLOT3)] = blob('tok-3')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [60, 30]
  w.usage['tok-3'] = [40, 50]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com', 'tok-3': 'three@example.com' }
  const three = { accounts: [...TWO_LOGINS.accounts, { id: '3', slot: SLOT3, email: 'three@example.com' }] }
  const clock = world(on, w, three)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  await pane.press({ key: 'rotate' })
  await clock.settle()
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT3 }])
  await pane.redraw()
  expect((await pane.find({ key: 'account-3' }))?.text).toMatch(/◌ switching…/)
  expect(await pane.find({ type: 'Text', text: '● in use' })).toBeUndefined()
  await clock.advance(35_000)
  await pane.redraw()
  expect((await pane.find({ type: 'Text', text: /^● in use$/ }))?.props).toMatchObject({ color: 'warning' })
  expect(await pane.find({ text: /switching/ })).toBeUndefined()
  // Each line ends in its use, rightmost: Remove, where a login has one, stands before it.
  const ends = (await pane.findAll({ text: /^(Remove|Use now|● in use)$/ })).filter(e => e.type !== 'Box')
  expect(ends.map(e => e.text)).toEqual(['Use now', 'Remove', 'Use now', 'Remove', '● in use'])
  await pane.unmount()
})

test('with next in list picked, Rotate now moves to the login after the one in use, not the one with the most room', async ($, on) => {
  const w = fresh()
  const SLOT3 = '/Users/tester/.claude/accounts/3'
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.keychain[await keychainItem(SLOT3)] = blob('tok-3')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [60, 30]
  w.usage['tok-3'] = [40, 50]
  const three = { accounts: [...TWO_LOGINS.accounts, { id: '3', slot: SLOT3, email: 'three@example.com' }] }
  const clock = world(on, w, three)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ text: /moves to the account whose 5-hour window resets soonest/ })).toBeDefined()
  await pane.press({ key: 'rotate-to-order' })
  await clock.settle()
  await pane.redraw()
  expect(await pane.find({ text: /moves to the next account in the list with room/ })).toBeDefined()
  await pane.press({ key: 'rotate' })
  await clock.settle()
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  await pane.unmount()
})

test('a switch held back for a token about to refresh is said once and made once, when the refresh lands', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 5 * 60_000)
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com' }
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  await pane.press({ key: 'rotate' })
  await clock.settle()
  await clock.advance(2 * 60_000)
  expect(w.envSets).toEqual([])
  expect(w.toasts.filter(t => /Switching to Claude account 2/.test(t))).toHaveLength(1)
  // Claude Code refreshes the token: the next try goes through, once.
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 8 * HOUR)
  await clock.advance(3 * 60_000)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  // Told once the switch lands.
  await clock.advance(35_000)
  expect(w.toasts.filter(t => /Switched to Claude account 2/.test(t))).toHaveLength(1)
  await pane.unmount()
})

test('a login whose plan reports no weekly limit leaves its week blank in the footer', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, null]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  // Login 1, in use, has no week: blank below its braille, and no week percent at the right.
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⣷   80% \n│ │▆       ')
  await footer.unmount()
})

test('with no weekly limit on any login, the footer leaves the week row out', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, null]
  w.usage['tok-2'] = [10, null]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⣷   80% ')
  await footer.unmount()
})

test('the pane picks each footer row\'s style for every session, and previews it with demo values', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toBe('│⣷│⣷   80% \n│▆│▆   70% ')
  await pane.press({ key: 'footer-session-bars' })
  await pane.press({ key: 'footer-week-none' })
  await clock.settle()
  await footer.redraw()
  // The week's glyphs are off but its percent is still on: the row keeps just that, under the other's.
  expect((await footer.find(GLYPHS))?.text).toBe('│▇│▇   80% \n│ │    70% ')
  // Kept in the store every session reads: the next sync from it keeps the picks.
  await clock.advance(61_000)
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('│▇│▇   80% \n│ │    70% ')
  // The demo draws imitated usage (login 1: 85% now, 70% of its week; login 2: 60%, 40%), this session only.
  await pane.press({ key: 'footer-preview-demo' })
  await pane.press({ key: 'footer-week-pie' })
  await clock.settle()
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('│▇│▅   85% \n│◕│◑   70% ')
  // Each row's percent switches off on its own; a row with no glyphs keeps just its percent.
  await pane.press({ key: 'footer-percent-week' })
  await pane.press({ key: 'footer-session-none' })
  await clock.settle()
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('│ │    85% \n│◕│◑       ')
  // 'tile': the column in use on the theme's dim gray, padded half a cell each side, kept under the pointer.
  await pane.press({ key: 'footer-active-tile' })
  await clock.settle()
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('▐ ▌    85% \n▐◕▌◑       ')
  const [padBefore, tiledOne, padAfter, untiled] = painted((await footer.find(GLYPHS))?.children[2])
  expect(padBefore).toMatchObject({ color: 'subtle', hover: { color: 'userMessageBackground', backgroundColor: 'subtle' } })
  expect(tiledOne).toMatchObject({ color: roomColor(70), backgroundColor: 'subtle', hover: { color: 'subtle', backgroundColor: roomColor(70, true) } })
  expect(padAfter).toMatchObject({ color: 'subtle' })
  expect(untiled).toMatchObject({ color: roomColor(40), hover: { color: 'userMessageBackground' } })
  expect(untiled?.backgroundColor).toBeUndefined()
  // 'dim the rest': no marks beside the columns, the logins not in use dimmed.
  await pane.press({ key: 'footer-active-dim' })
  await clock.settle()
  await footer.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('       85% \n ◕ ◑       ')
  const [brightOne, dimTwo] = painted((await footer.find(GLYPHS))?.children[2])
  expect(brightOne?.dimColor).toBeUndefined()
  expect(dimTwo).toMatchObject({ color: roomColor(40), dimColor: true })
  // Showing what is used fills by it, in the footer and the pane; the colors still follow the room left.
  await pane.press({ key: 'footer-fill-used' })
  await clock.settle()
  await footer.redraw()
  await pane.redraw()
  expect((await footer.find(GLYPHS))?.text).toBe('       15% \n ◔ ◑       ')
  const [usedOne, usedTwo] = painted((await footer.find(GLYPHS))?.children[2])
  expect(usedOne).toMatchObject({ color: roomColor(70) })
  expect(usedTwo).toMatchObject({ color: roomColor(40) })
  expect(await pane.find({ text: /^▰{2}▱{8} 20% used$/ })).toBeDefined()
  await pane.unmount()
  await footer.unmount()
})

test('in Terminal.app, which draws block characters from its font, the tile pads its column with whole cells', async ($, on) => {
  const w = fresh()
  w.env.TERM_PROGRAM = 'Apple_Terminal'
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, footer: { active: 'tile' } })
  await start($, clock)
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find(GLYPHS))?.text).toBe(' ⣷ ⣷   80% \n ▆ ▆   70% ')
  const [padBefore, tiled, padAfter, untiled] = painted((await footer.find(GLYPHS))?.children[0])
  expect(padBefore).toMatchObject({ backgroundColor: 'subtle', hover: { color: 'subtle' } })
  expect(tiled).toMatchObject({ color: roomColor(80), backgroundColor: 'subtle' })
  expect(padAfter).toMatchObject({ backgroundColor: 'subtle', hover: { color: 'subtle' } })
  expect(untiled).toMatchObject({ color: roomColor(90) })
  expect(untiled?.backgroundColor).toBeUndefined()
  await footer.unmount()
})

const SLOT3 = `${HOME}/.claude/accounts/3`
const THREE_LOGINS = { accounts: [...TWO_LOGINS.accounts, { id: '3', slot: SLOT3, email: 'three@example.com' }] }
/** The person types /login at the prompt. */
const LOGIN = { command: 'login', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

/** Three logins, each signed in as its own account; the session on login 3, as the mod leaves it after a switch. */
async function onThree(w: World): Promise<void> {
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT3
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.keychain[await keychainItem(SLOT3)] = blob('tok-3')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  w.usage['tok-3'] = [40, 50]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com', 'tok-3': 'three@example.com' }
}

test('a /login in a session on login 3 that signs in login 2\'s account leaves 3 needing its own sign-in, and the session moves to 2', async ($, on) => {
  const w = fresh()
  await onThree(w)
  const clock = world(on, w, THREE_LOGINS)
  await start($, clock)
  expect(w.envSets).toEqual([])
  // The browser was signed in to claude.ai as login 2's account.
  w.loginToken = 'tok-2b'
  w.usage['tok-2b'] = [10, 30]
  w.owners['tok-2b'] = 'two@example.com'
  await $.command.run(LOGIN)
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} } })
  expect(await band.find({ text: /account 3 \(three@example.com\) needs a sign-in \(signed in as account 2 now\)/ })).toBeDefined()
  await band.unmount()
  // The session moves off it, to the login the rotation picks: 2, with the most room.
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  await clock.advance(35_000)
  expect(w.toasts.filter(t => /^Switched to Claude account 2 .*: account 3 needs a sign-in\.$/.test(t))).toHaveLength(1)
  // A later check, its token run out, keeps 3 needing a sign-in: the sign-in it holds is still 2's.
  w.keychain[await keychainItem(SLOT3)] = blob('tok-2b', NOW + 30 * 60_000)
  await clock.advance(41 * 60_000)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ text: /^⚠ signed in as account 2 now$/ })).toBeDefined()
  await pane.unmount()
  expect(w.envSets).toHaveLength(1)
})

test('a /login in a session on login 3 that signs in an account not on the list makes 3 that account, and says /login signs in the account the session is on', async ($, on) => {
  const w = fresh()
  await onThree(w)
  const clock = world(on, w, THREE_LOGINS)
  await start($, clock)
  w.loginToken = 'tok-x'
  w.usage['tok-x'] = [5, 10]
  w.owners['tok-x'] = 'x@example.com'
  await $.command.run(LOGIN)
  await clock.settle()
  expect(w.toasts.filter(t => /^Claude account 3 is x@example.com · Org now: a \/login in a session on account 3 signs in there, not Claude Code's login\.$/.test(t))).toHaveLength(1)
  expect(w.envSets).toEqual([])
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ text: 'x@example.com' })).toBeDefined()
  expect(await pane.find({ text: 'three@example.com' })).toBeUndefined()
  await pane.unmount()
})

test('a /login in a session on login 3 as its own account again, as a new token is, changes nothing', async ($, on) => {
  const w = fresh()
  await onThree(w)
  const clock = world(on, w, THREE_LOGINS)
  await start($, clock)
  w.loginToken = 'tok-3b'
  w.usage['tok-3b'] = [40, 50]
  w.owners['tok-3b'] = 'three@example.com'
  await $.command.run(LOGIN)
  await clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.envSets).toEqual([])
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ text: /^⚠/ })).toBeUndefined()
  expect(await pane.find({ text: 'three@example.com' })).toBeDefined()
  await pane.unmount()
})

test('the pane names Claude Code\'s own login, where new sessions start, and its plan; on another login it says /login there signs that one in', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2', NOW + 6 * HOUR, 'team')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com' }
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: "Claude Code's login: account 1 (one@example.com), personal Max. New sessions start on it." })).toBeDefined()
  await pane.press({ key: 'rotate' })
  await clock.settle()
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: /^Claude Code's login: account 1 \(one@example\.com\), personal Max\. New sessions start on it\. \/login in this session signs in account 2 instead\.$/ })).toBeDefined()
  await pane.unmount()
})

test('a Team seat as Claude Code\'s own login is told in the pane: new sessions start on it, and can\'t switch', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 6 * HOUR, 'team')
  w.usage['tok-1'] = [20, 30]
  w.owners = { 'tok-1': 'one@example.com' }
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  const line = await pane.find({ type: 'Text', text: /^Claude Code's login: account 1 \(one@example\.com\), a Team seat\. New sessions start on it, and can't switch accounts: / })
  expect(line?.props).toMatchObject({ color: 'warning' })
  await pane.unmount()
})

test('a /login on Claude Code\'s login that signs in a Team seat on the list leaves login 1 needing its own sign-in, and the pane names the seat as Claude Code\'s login', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2', NOW + 6 * HOUR, 'team')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  w.owners = { 'tok-1': 'one@example.com', 'tok-2': 'two@example.com' }
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  w.loginToken = 'tok-2b'
  w.loginPlan = 'team'
  w.usage['tok-2b'] = [10, 30]
  w.owners['tok-2b'] = 'two@example.com'
  await $.command.run(LOGIN)
  await clock.settle()
  expect(w.toasts.filter(t => /^Claude account 1 \(one@example.com · Org\) needs a sign-in \(signed in as account 2 now\)/.test(t))).toHaveLength(1)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: SLOT2 }])
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  const line = await pane.find({ type: 'Text', text: /^Claude Code's login: account 1 \(two@example\.com\), a Team seat\. New sessions start on it, and can't switch accounts: .* \/login in this session signs in account 2 instead\.$/ })
  expect(line?.props).toMatchObject({ color: 'warning' })
  await pane.unmount()
})

test('a view kept from the code before a hot reload, which lacks what this code added, still draws and checks', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  w.owners = { 'tok-1': 'one@example.com' }
  const clock = world(on, w, TWO_LOGINS)
  // A hot reload keeps the view as the version before this one wrote it, with no `holders`: the first read finds that.
  const before ={ accounts: TWO_LOGINS.accounts, readings: {}, health: {}, activeId: '1', footer: DEFAULT_FOOTER, rotateTo: 'reset', hasFontBlocks: false }
  let isKept = false
  on('state.get', async (_$, e, next) => {
    const read = await next(e)
    if (isKept || e.plugin !== 'account-rotator' || e.key !== 'view') return read
    isKept = true
    return { value: { value: before, version: read.value?.version ?? 0 } }
  })
  await start($, clock)
  const pane = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: "Claude Code's login: account 1 (one@example.com), personal Max. New sessions start on it." })).toBeDefined()
  await pane.unmount()
})

const BAND_PROPS = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

/**
 * A call to one of Claude in Chrome's tools, as Claude makes one: its input
 * typed loosely, as the type root lists only the MCP tools this machine has.
 */
const browse = ($: Engine, tool: string, args: Record<string, unknown> = {}) =>
  $.tool.call({ tool: `mcp__claude-in-chrome__${tool}`, ...args } as unknown as ToolCallArgs)

/** Login 1 spent and login 2 with room, both signed in. */
async function spentOne(w: World): Promise<void> {
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [92, 40]
  w.usage['tok-2'] = [10, 30]
}

/** Login 1 with room and login 2 spent, both signed in. */
async function spentTwo(w: World): Promise<void> {
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [100, 30]
}

/** A session with no person at it, as `claude -p` runs. */
async function startHeadless($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await clock.settle()
}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'Pane', requestId: 'claude-accounts', props: PANE_PROPS })
const mountBand = ($: Engine) => $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
const slots = (w: World) => w.envSets.map(e => e.value ?? '')

test('before the rotation moves the session off Claude Code\'s login, Claude in Chrome connects there, where the extension answers, and goes on answering as the session moves', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.emails = { '': 'one@example.com', [SLOT2]: 'two@example.com' }
  await spentOne(w)
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  // Asked once, on login 1, and only then moved to login 2.
  expect(w.chromeAsked).toEqual([''])
  expect(slots(w)).toEqual([SLOT2])
  const learned = /^Claude in Chrome connects as Claude account 1 \(one@example\.com[^)]*\): your Chrome extension is signed in to it\.$/
  expect(w.toasts.filter(t => learned.test(t))).toHaveLength(1)
  // On login 2 a browser call is answered, the connection still login 1's, and Claude is told nothing more.
  const called = await browse($, 'tabs_context_mcp')
  expect(called.isError).toBeUndefined()
  expect(called.context).toBeUndefined()
  // Kept in the store every session reads: the next sync from it keeps it.
  await clock.advance(61_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'Org · max · Chrome' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Active Claude extension accounts from your Chrome windows:' })).toBeDefined()
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect(await pane.find({ key: 'chrome-use-1' })).toBeUndefined()
  // No Chrome extension has answered as login 2: it waits behind Other accounts.
  expect(await pane.find({ key: 'chrome-row-2' })).toBeUndefined()
  expect((await pane.find({ key: 'chrome-others' }))?.text).toBe('▸ Other accounts')
  await pane.unmount()
})

test('a Chrome opened later on an account the box hasn\'t listed is a press away: Other accounts lists the rest, and Try to connect connects there and lists it, the one before with Use for Chrome', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  // As it opened: connected on login 1, where the session is, and a browser answered there.
  expect(w.chromeAsked).toEqual([''])
  const pane = await mountPane($)
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect(await pane.find({ key: 'chrome-row-2' })).toBeUndefined()
  // Chrome opens in a second profile, signed in to login 2's account.
  w.chrome.extensions.push(SLOT2)
  await pane.press({ key: 'chrome-others' })
  await clock.settle()
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-others' }))?.text).toBe('▾ Other accounts')
  expect((await pane.find({ key: 'chrome-try-2' }))?.text).toBe('Try to connect')
  await pane.press({ key: 'chrome-try-2' })
  await clock.settle()
  expect(slots(w)).toEqual([SLOT2])
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome'])
  expect(w.chromeAsked).toEqual(['', SLOT2])
  expect(w.toasts).toContain('Claude in Chrome is connected as Claude account 2 (two@example.com).')
  expect(slots(w)).toEqual([SLOT2, ''])
  // Kept in the store every session reads: both listed from now on, login 2 in use, none left behind the press.
  await clock.advance(61_000)
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-row-2' }))?.text).toMatch(/● in use$/)
  expect((await pane.find({ key: 'chrome-use-1' }))?.text).toBe('Use for Chrome')
  expect(await pane.find({ key: 'chrome-others' })).toBeUndefined()
  await pane.unmount()
})

test('Try to connect as an account no Chrome answers as changes nothing: the box keeps the accounts that answered, lists none that didn\'t as active, and Claude in Chrome goes back to the one picked before', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  const pane = await mountPane($)
  await pane.press({ key: 'chrome-others' })
  await clock.settle()
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: 'No Chrome extension is known to answer as these:' })).toBeDefined()
  await pane.press({ key: 'chrome-try-2' })
  await clock.settle()
  expect(slots(w)).toEqual([SLOT2])
  await clock.advance(36_000)
  expect(w.chromeAsked).toEqual(['', SLOT2])
  expect(w.toasts).toContain(
    'No Chrome extension answers as Claude account 2 (two@example.com). Open Chrome and check its Claude extension is signed in with that email; if it is, restart Chrome and try again. ' +
      'Claude in Chrome goes back to account 1 (one@example.com).',
  )
  // Back on login 1, Claude in Chrome connects there again once the move lands.
  expect(slots(w)).toEqual([SLOT2, ''])
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome', '/mcp reconnect claude-in-chrome'])
  expect(w.chromeAsked).toEqual(['', SLOT2, ''])
  expect(w.toasts).toContain('Claude in Chrome is connected as Claude account 1 (one@example.com).')
  // Kept in the store every session reads: login 1 still picked, listed and in use; login 2 only behind Other accounts.
  await clock.advance(61_000)
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect(await pane.find({ key: 'chrome-try-2' })).toBeDefined()
  await pane.press({ key: 'chrome-others' })
  await clock.settle()
  await pane.redraw()
  expect(await pane.find({ key: 'chrome-row-2' })).toBeUndefined()
  expect((await pane.find({ key: 'account-1' }))?.text).toMatch(/one@example\.com.*Chrome/)
  expect((await pane.find({ key: 'account-2' }))?.text).toMatch(/two@example\.com/)
  expect((await pane.find({ key: 'account-2' }))?.text).not.toMatch(/Chrome/)
  await pane.unmount()
})

test('Use for Chrome on a listed account whose Chrome has closed since finds no browser: the box lists it no more, Try to connect under Other accounts, and Claude in Chrome goes back to the one picked before', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: ['', SLOT2] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1', 'chrome-accounts': ['1', '2'] })
  await start($, clock)
  const pane = await mountPane($)
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect((await pane.find({ key: 'chrome-use-2' }))?.text).toBe('Use for Chrome')
  expect(await pane.find({ key: 'chrome-others' })).toBeUndefined()
  // The Chrome profile signed in to login 2's account closes.
  w.chrome.extensions = ['']
  await pane.press({ key: 'chrome-use-2' })
  await clock.settle()
  expect(slots(w)).toEqual([SLOT2])
  await clock.advance(36_000)
  expect(w.chromeAsked).toEqual(['', SLOT2])
  expect(w.toasts).toContain(
    'No Chrome extension answers as Claude account 2 (two@example.com). Open Chrome and check its Claude extension is signed in with that email; if it is, restart Chrome and try again. ' +
      'Claude in Chrome goes back to account 1 (one@example.com).',
  )
  expect(slots(w)).toEqual([SLOT2, ''])
  await clock.advance(36_000)
  expect(w.chromeAsked).toEqual(['', SLOT2, ''])
  // Kept in the store every session reads: login 1 picked and in use, login 2 behind Other accounts, to try again.
  await clock.advance(61_000)
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect(await pane.find({ key: 'chrome-row-2' })).toBeUndefined()
  await pane.press({ key: 'chrome-others' })
  await clock.settle()
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-try-2' }))?.text).toBe('Try to connect')
  await pane.unmount()
})

test('a window opening while the picked account\'s Chrome is closed lists that account no more, and a browser call answered there lists it in use again', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1', 'chrome-accounts': ['1', '2'] })
  await start($, clock)
  expect(w.chromeAsked).toEqual([''])
  // Kept in the store every session reads: login 2, not checked, still listed.
  await clock.advance(61_000)
  const pane = await mountPane($)
  expect(await pane.find({ key: 'chrome-row-1' })).toBeUndefined()
  expect((await pane.find({ key: 'chrome-use-2' }))?.text).toBe('Use for Chrome')
  expect((await pane.find({ key: 'chrome-others' }))?.text).toBe('▸ Other accounts')
  expect(
    await pane.find({
      type: 'Text',
      text: '⚠ No Chrome extension answers as account 1 (one@example.com). Open Chrome and check its Claude extension is signed in with that email; if it is, restart Chrome.',
    }),
  ).toBeDefined()
  // Chrome opens, signed in to login 1's account.
  w.chrome.extensions.push('')
  expect((await browse($, 'tabs_context_mcp')).isError).toBeUndefined()
  await clock.advance(61_000)
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect(await pane.find({ type: 'Text', text: /^⚠/ })).toBeUndefined()
  await pane.unmount()
})

test('as a session opens it visits the extension\'s account, which has room, to connect Claude in Chrome there, and comes back; browser calls wait meanwhile', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [SLOT2] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [40, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '2', 'chrome-accounts': ['2'] })
  await start($, clock)
  expect(slots(w)).toEqual([SLOT2])
  // Not asked before Claude Code reads login 2's sign-in, which a call would connect as.
  expect(w.chromeAsked).toEqual([])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '◌ Connecting Chrome as account 2 (two@example.com)…' })).toBeDefined()
  await band.unmount()
  // The visit is no switch: login 2's line says so, not "in use".
  const visiting = await mountPane($)
  expect(await visiting.find({ type: 'Text', text: '◌ Connecting Chrome…' })).toBeDefined()
  expect(await visiting.find({ type: 'Text', text: '● in use' })).toBeUndefined()
  await visiting.unmount()
  // The footer's mark on login 2 blinks while the visit's sign-in is not yet seen in use.
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const lines = [(await footer.find(GLYPHS))?.text.split('\n')[0]]
  await clock.advance(500)
  await footer.redraw()
  lines.push((await footer.find(GLYPHS))?.text.split('\n')[0])
  expect(lines.sort()).toEqual([' ⣷ ⣦   60% ', ' ⣷│⣦│  60% '])
  await footer.unmount()
  const held = await $.tool.check({ tool: 'mcp__claude-in-chrome__navigate', input: { url: 'https://example.com' } })
  expect(held.decision).toBe('deny')
  expect(held.reason).toMatch(/^The account-rotator mod is connecting Claude in Chrome as Claude account 2 \(two@example\.com\).* End your turn now/)
  await clock.advance(36_000)
  // A first connection, nothing to reconnect; then back on login 1, which has room. No switch was told: the visit is the band's.
  expect(w.chromeAsked).toEqual([SLOT2])
  expect(w.commands).toEqual([])
  expect(slots(w)).toEqual([SLOT2, ''])
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toEqual([])
  expect((await $.tool.check({ tool: 'mcp__claude-in-chrome__navigate', input: {} })).decision).toBe('allow')
  const pane = await mountPane($)
  expect((await pane.find({ key: 'chrome-row-2' }))?.text).toMatch(/● in use$/)
  await pane.unmount()
  // The connection stays login 2's on login 1.
  expect((await browse($, 'navigate', { url: 'https://example.com' })).isError).toBeUndefined()
})

test('as a session opens it leaves a spent extension account be; the first browser call that finds no browser connects there, comes back, and tells Claude to carry on', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [SLOT2] }
  await spentTwo(w)
  const spent = { fiveHour: { pct: 100, resetsAt: '2026-10-12T12:00:00Z' }, at: NOW - 60_000 }
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '2', 'chrome-accounts': ['2'], 'reading:2': spent })
  await start($, clock)
  await clock.advance(36_000)
  // A prompt sent now goes out as login 1, which has room: the window stays there.
  expect(slots(w)).toEqual([])
  expect(w.chromeAsked).toEqual([])
  // Claude in Chrome connects as login 1, which no extension answers: the mod visits login 2 now.
  const called = await browse($, 'navigate', { url: 'https://example.com' })
  expect(called.isError).toBe(true)
  expect(called.context?.[0]).toMatch(/^Claude in Chrome connected as Claude account 1 \(one@example\.com\) and found no browser\. The account-rotator mod is now connecting it as Claude account 2 \(two@example\.com\)/)
  await clock.settle()
  expect(slots(w)).toEqual([SLOT2])
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome'])
  expect(w.chromeAsked).toEqual([SLOT2])
  expect(slots(w)).toEqual([SLOT2, ''])
  await clock.advance(36_000)
  expect(w.submitted).toEqual(['Claude in Chrome is connected as Claude account 2 (two@example.com). Continue where you left off.'])
  expect((await browse($, 'navigate', { url: 'https://example.com' })).isError).toBeUndefined()
})

test('as a session opens it leaves be an extension account no browser answered as last time, while one did as another', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 30]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '2', 'chrome-accounts': ['1'] })
  await start($, clock)
  await clock.advance(36_000)
  expect(slots(w)).toEqual([])
  expect(w.chromeAsked).toEqual([])
  // The extension answers as login 1, the one in use: the first browser call just works.
  expect((await browse($, 'tabs_context_mcp')).isError).toBeUndefined()
  await clock.settle()
  expect(slots(w)).toEqual([])
})

test('a turn that hits the usage limit while the session visits an extension account it didn\'t know was spent carries on once it is back', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [SLOT2] }
  await spentTwo(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '2' })
  await start($, clock)
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.settle()
  await clock.advance(36_000)
  expect(slots(w)).toEqual([SLOT2, ''])
  expect(w.submitted).toEqual([])
  await clock.advance(36_000)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toMatch(/Continue where you left off/)
})

test('when the connection drops and comes back as the account in use, the next browser call has the mod reconnect it as the extension\'s account, not /login, and tell Claude to carry on once one answers', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  await spentOne(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  // As it opened: on login 1 to connect there, spent as it is, then back on login 2.
  await clock.advance(36_000)
  expect(w.chromeAsked).toEqual([''])
  expect(slots(w)).toEqual(['', SLOT2])
  await clock.advance(36_000)
  // The connection drops and comes back as login 2, which the extension doesn't answer.
  w.chrome.as = SLOT2
  const called = await browse($, 'navigate', { url: 'https://example.com' })
  expect(called.isError).toBe(true)
  expect(called.context?.[0]).toBe(
    'Claude in Chrome connected as Claude account 1 (one@example.com) and found no browser. ' +
      "The account-rotator mod is now reconnecting it as Claude account 1 (one@example.com), the account the user's Chrome extension is signed in to, which takes under a minute. " +
      "End your turn now: you'll get a message once it's connected. Don't suggest /login: it doesn't fix this.",
  )
  await clock.settle()
  expect(slots(w)).toEqual(['', SLOT2, ''])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '◌ Connecting Chrome as account 1 (one@example.com)…' })).toBeDefined()
  await band.unmount()
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome'])
  expect(w.chromeAsked).toEqual(['', ''])
  expect(w.toasts).toContain('Claude in Chrome is connected as Claude account 1 (one@example.com).')
  // Back on login 2, and Claude is told to carry on once that lands.
  expect(slots(w)).toEqual(['', SLOT2, '', SLOT2])
  expect(w.submitted).toEqual([])
  await clock.advance(36_000)
  expect(w.submitted).toEqual(['Claude in Chrome is connected as Claude account 1 (one@example.com). Continue where you left off.'])
  expect((await browse($, 'navigate', { url: 'https://example.com' })).isError).toBeUndefined()
  expect(w.toasts.filter(t => /Something went wrong/.test(t))).toEqual([])
})

test('a session Claude Code stops from switching, on another account than the extension\'s, can\'t connect Claude in Chrome: Claude and the band give the command that brings the conversation back connected', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  w.refuseEnv = true
  await spentOne(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  const called = await browse($, 'tabs_context_mcp')
  expect(called.context?.[0]).toMatch(
    /Tell the user that to use Chrome, they quit Claude Code \(in a background session, with \/stop: \/exit only detaches\) and run `claude --resume session-1` in a terminal/,
  )
  const band = await mountBand($)
  expect(
    await band.find({
      type: 'Text',
      text: "⚠ This window can't switch to account 1 (one@example.com). Quit (in a background session, /stop: /exit only detaches), then run: claude --resume session-1",
    }),
  ).toBeDefined()
  expect(await band.find({ key: 'chrome-connect-band' })).toBeUndefined()
  await band.unmount()
  expect(w.envSets).toEqual([])
  expect(w.commands).toEqual([])
  // Connected after all, the box says why the accounts behind Other accounts can't be tried here.
  await clock.advance(61_000)
  w.chrome.as = ''
  expect((await browse($, 'tabs_context_mcp')).isError).toBeUndefined()
  const pane = await mountPane($)
  expect(await pane.find({ key: 'chrome-use-2' })).toBeUndefined()
  await pane.press({ key: 'chrome-others' })
  await clock.settle()
  await pane.redraw()
  expect(await pane.find({ key: 'chrome-row-1' })).toBeDefined()
  expect(await pane.find({ key: 'chrome-try-1' })).toBeUndefined()
  expect(
    await pane.find({
      type: 'Text',
      text: "⚠ This window can't switch accounts, so Chrome can't move to another one here. Quit (in a background session, /stop: /exit only detaches), then run: claude --resume session-1",
    }),
  ).toBeDefined()
  await pane.unmount()
})

test('with no account named for the Chrome extension, a browser call that finds no browser has Claude ask which it is; picked in the pane, Connect connects there, comes back, and tells Claude to carry on', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  const called = await browse($, 'tabs_context_mcp')
  expect(called.context?.[0]).toMatch(/^Claude in Chrome connected as Claude account 2 \(two@example\.com\) and found no browser\. .* Ask the user to press Use for Chrome or Try to connect next to it under Chrome in the Claude accounts panel/)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: '⚠ Claude in Chrome: which account is your Chrome extension signed in to?' })).toBeDefined()
  await band.press({ key: 'chrome-pick' })
  await clock.settle()
  expect(w.panes).toEqual(['claude-accounts'])
  await band.unmount()
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'No Chrome extension found yet. Which account is yours signed in to?' })).toBeDefined()
  expect(await pane.find({ key: 'chrome-try-2' })).toBeDefined()
  await pane.press({ key: 'chrome-try-1' })
  await clock.settle()
  expect(slots(w)).toEqual([''])
  await clock.advance(36_000)
  await pane.redraw()
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  expect(await pane.find({ key: 'chrome-row-2' })).toBeUndefined()
  await pane.unmount()
  // Back on login 2, where the session was; Claude is told once that lands.
  expect(slots(w)).toEqual(['', SLOT2])
  await clock.advance(36_000)
  expect(w.submitted).toEqual(['Claude in Chrome is connected as Claude account 1 (one@example.com). Continue where you left off.'])
})

test('a Connect that finds no browser says to check Chrome and its extension\'s email, and a call that finds none then asks the person instead of connecting again', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: ['a browser signed in elsewhere'] }
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  await spentOne(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  // As it opened: no browser as login 1, quietly, and back on login 2.
  await clock.advance(36_000)
  expect(w.chromeAsked).toEqual([''])
  expect(slots(w)).toEqual(['', SLOT2])
  expect(w.toasts.filter(t => /Chrome extension answers/.test(t))).toEqual([])
  const called = await browse($, 'tabs_context_mcp')
  expect(called.context?.[0]).toMatch(
    /^No Chrome extension answers as Claude account 1 \(one@example\.com\).*Ask the user to open Chrome and check the email its Claude extension is signed in with\..*press Connect above the prompt/,
  )
  await clock.settle()
  expect(slots(w)).toEqual(['', SLOT2])
  const band = await mountBand($)
  const noBrowser = '⚠ No Chrome extension answers as account 1 (one@example.com). Open Chrome and check its Claude extension is signed in with that email; if it is, restart Chrome.'
  expect(await band.find({ type: 'Text', text: noBrowser })).toBeDefined()
  await band.press({ key: 'chrome-connect-band' })
  await clock.settle()
  await band.unmount()
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome'])
  expect(w.toasts).toContain('No Chrome extension answers as Claude account 1 (one@example.com). Open Chrome and check its Claude extension is signed in with that email; if it is, restart Chrome.')
  expect(slots(w)).toEqual(['', SLOT2, '', SLOT2])
  await clock.advance(36_000)
  expect(w.submitted).toEqual([])
})

test('a browser answering as another account than the one picked for the extension lists that account in use, and leaves the pick as it is', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.usage['tok-1'] = [20, 40]
  w.usage['tok-2'] = [10, 30]
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '2' })
  // With no person at it, the session doesn't connect as it opens: the first browser call connects as login 1.
  await startHeadless($, clock)
  expect(w.envSets).toEqual([])
  expect((await browse($, 'tabs_context_mcp')).isError).toBeUndefined()
  await clock.advance(61_000)
  const pane = await mountPane($)
  expect((await pane.find({ key: 'chrome-row-1' }))?.text).toMatch(/● in use$/)
  // Login 2, picked but never answered as, isn't listed as active: it waits behind Other accounts.
  expect(await pane.find({ key: 'chrome-row-2' })).toBeUndefined()
  expect((await pane.find({ key: 'chrome-others' }))?.text).toBe('▸ Other accounts')
  // Still the account new sessions connect as.
  expect(await pane.find({ type: 'Text', text: 'Chrome' })).toBeDefined()
  await pane.unmount()
})

test('a guess at Claude Code\'s login that finds no browser leaves the extension\'s account to be picked, and is not tried again', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [SLOT2] }
  await spentOne(w)
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.chromeAsked).toEqual([''])
  expect(w.toasts.filter(t => /^Claude in Chrome connects as/.test(t))).toEqual([])
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'No Chrome extension found yet. Which account is yours signed in to?' })).toBeDefined()
  // Back on login 1 and off it again: no second guess.
  await pane.press({ key: 'use-1' })
  await clock.settle()
  await clock.advance(36_000)
  await pane.press({ key: 'use-2' })
  await clock.settle()
  expect(w.envSets).toHaveLength(3)
  expect(w.chromeAsked).toEqual([''])
  await pane.unmount()
})

test('a session that a guess at Claude Code\'s login found no browser for before does not guess it again', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [SLOT2] }
  await spentOne(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-miss': '1' })
  await start($, clock)
  expect(slots(w)).toEqual([SLOT2])
  expect(w.chromeAsked).toEqual([])
})

test('a session without Claude in Chrome is asked once, and its pane has no Chrome box', async ($, on) => {
  const w = fresh()
  await spentOne(w)
  const clock = world(on, w, TWO_LOGINS)
  await start($, clock)
  expect(w.chromeAsked).toEqual([''])
  const pane = await mountPane($)
  await pane.press({ key: 'use-1' })
  await clock.settle()
  await clock.advance(36_000)
  await pane.press({ key: 'use-2' })
  await clock.settle()
  expect(w.envSets).toHaveLength(3)
  expect(w.chromeAsked).toEqual([''])
  await pane.redraw()
  expect(await pane.find({ key: 'chrome-row-1' })).toBeUndefined()
  expect(await pane.find({ text: /Chrome/ })).toBeUndefined()
  await pane.unmount()
})

test('a sign-in Claude Code ends with no result, as it does after Cancel, ends as not finished and offers Sign in again', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [20, 30]
  const clock = world(on, w, TWO_LOGINS)
  // After Cancel's return(), Claude Code fulfills the spawn's result with undefined; the kit rejects it instead.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'Opening browser to sign in…\n' }
    return { value: undefined as never }
  })
  await start($, clock)
  const band = await $.ui.mount({
    plugin: 'account-rotator',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  await band.press({ key: 'sign-in-all' })
  await clock.settle()
  expect(w.toasts.at(-1)).toBe('Sign-in for Claude account 2 did not finish.')
  await band.redraw()
  expect(await band.find({ key: 'cancel-sign-in' })).toBeUndefined()
  expect(await band.find({ key: 'sign-in-all' })).toBeDefined()
  await band.unmount()
})

test('a dropped connection that Claude Code reports as an ordinary result, not an error, has the mod reconnect it all the same', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''], asText: true }
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  await spentOne(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  await clock.advance(36_000)
  await clock.advance(36_000)
  expect(slots(w)).toEqual(['', SLOT2])
  w.chrome.as = SLOT2
  const called = await browse($, 'tabs_context_mcp', { createIfEmpty: true })
  expect(called.isError).toBeUndefined()
  expect(called.context?.[0]).toMatch(/^Claude in Chrome connected as Claude account 1 \(one@example\.com\) and found no browser\. The account-rotator mod is now reconnecting it/)
  await clock.settle()
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome'])
  expect(w.toasts).toContain('Claude in Chrome is connected as Claude account 1 (one@example.com).')
  expect(slots(w)).toEqual(['', SLOT2, '', SLOT2])
})

test('list_connected_browsers listing none counts as a dropped connection, and has the mod reconnect it', async ($, on) => {
  const w = fresh()
  w.chrome = { extensions: [''] }
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  await spentOne(w)
  const clock = world(on, w, { ...TWO_LOGINS, 'chrome-account': '1' })
  await start($, clock)
  await clock.advance(36_000)
  await clock.advance(36_000)
  w.chrome.as = SLOT2
  const called = await browse($, 'list_connected_browsers')
  expect(called.text).toBe('[]')
  expect(called.context?.[0]).toMatch(/The account-rotator mod is now reconnecting it/)
  await clock.settle()
  await clock.advance(36_000)
  expect(w.commands).toEqual(['/mcp reconnect claude-in-chrome'])
  // Once connected, a list with a browser in it is no drop.
  expect((await browse($, 'list_connected_browsers')).context).toBeUndefined()
})

// Fable has a week of its own inside the account's week: Fable use counts toward both, other models toward the week alone.

/** Account 1, Claude Code's login, with 20% of its week left but its Fable week at 96%; account 2 has room in both. */
async function fableWorld(on: Parameters<typeof world>[0], model: string): Promise<{ w: World; clock: MockClock; slot2: string }> {
  const w = fresh()
  const slot2 = `${HOME}/.claude/accounts/2`
  w.model = model
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(slot2)] = blob('tok-2')
  w.usage['tok-1'] = [null, 80, '2026-10-13T03:00:00Z']
  w.usage['tok-2'] = [null, 10, '2026-10-18T03:00:00Z']
  w.fable = { 'tok-1': 96, 'tok-2': 5 }
  const clock = world(on, w, { accounts: [{ id: '1', slot: '', email: '1@example.com' }, { id: '2', slot: slot2, email: '2@example.com' }] })
  return { w, clock, slot2 }
}

/** A model request of the main loop, or of a subagent, on `model`. */
async function requestOn($: Engine, clock: MockClock, model: string, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model, messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _ of stream) {
    // The chunks say nothing here.
  }
  await stream.result
  await clock.settle()
}

test('a Fable session moves once its account\'s Fable week reaches 95%, though its week has room', async ($, on) => {
  const { w, clock, slot2 } = await fableWorld(on, 'claude-fable-5-2')
  await start($, clock)
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: slot2 }])
  await clock.advance(36_000)
  expect(w.toasts.filter(t => /^Switched to Claude account 2 .*: account 1 has 4% of its Fable week left\.$/.test(t))).toHaveLength(1)
})

test('an Opus session stays on an account whose Fable week is spent while its week has room', async ($, on) => {
  const { w, clock } = await fableWorld(on, 'claude-opus-5-5')
  await start($, clock)
  await clock.advance(6 * 60_000)
  expect(w.envSets).toEqual([])
})

test('a subagent on Fable leaves an Opus session be; a /model to Fable in the main loop moves it on', async ($, on) => {
  const { w, clock, slot2 } = await fableWorld(on, 'claude-opus-5-5')
  await start($, clock)
  await requestOn($, clock, 'claude-fable-5-2', 'agent-1')
  expect(w.envSets).toEqual([])
  await requestOn($, clock, 'claude-fable-5-2')
  expect(w.envSets).toEqual([{ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: slot2 }])
})

test('a response keeps the Fable week the usage check read, and the pane shows it under the week', async ($, on) => {
  const w = fresh()
  w.model = 'claude-fable-5-2'
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.usage['tok-1'] = [null, 40, '2026-10-13T03:00:00Z']
  w.fable = { 'tok-1': 60 }
  const clock = world(on, w, { accounts: [{ id: '1', slot: '', email: 'one@example.com' }] })
  await start($, clock)
  w.limits = [{ kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-13T03:00:00Z' }]
  await $.session.measure({ context: { window: 200_000 }, rateLimits: w.limits, changed: ['rateLimits'] })
  await clock.settle()
  const pane = await mountPane($)
  const row = (await pane.find({ key: 'account-1' }))?.text ?? ''
  expect(row).toMatch(/week▰{6}▱{4} 59% left.*Fable▰{4}▱{6} 40% left/)
  expect(await pane.find({ text: /or 5% of its Fable week, as this session uses Fable\) left/ })).toBeDefined()
  await pane.unmount()
})

test('a Fable session\'s footer shows each account\'s fuller week, and with every Fable week spent the band says so', async ($, on) => {
  const { w, clock } = await fableWorld(on, 'claude-fable-5-2')
  w.fable = { 'tok-1': 96, 'tok-2': 97 }
  await start($, clock)
  expect(w.envSets).toEqual([])
  const footer = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  // Account 1's week has 20% left, its Fable week 4%: the footer shows 4%.
  expect((await footer.find(GLYPHS))?.text).toMatch(/ 4% $/)
  await footer.unmount()
  const band = await $.ui.mount({ plugin: 'account-rotator', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect((await band.find({ text: /^Every Claude account is near its/ }))?.text).toMatch(/^Every Claude account is near its Fable limit; the next frees up in /)
  await band.unmount()
})

// Start on "a fresh 5-hour window": a new session on Claude Code's login moves to an account whose 5-hour window hasn't started.

/** Three signed-in logins and their usage, read and checked before by another session too: [5-hour %, week %, week resets]. */
async function threeLogins(usage: Record<'1' | '2' | '3', [number, number, string]>): Promise<{ w: World; store: Record<string, unknown> }> {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2')
  w.keychain[await keychainItem(SLOT3)] = blob('tok-3')
  const store: Record<string, unknown> = { ...THREE_LOGINS }
  for (const id of ['1', '2', '3'] as const) {
    const [five, week, resetsAt] = usage[id]
    w.usage[`tok-${id}`] = [five, week, resetsAt]
    store[`reading:${id}`] = {
      fiveHour: { pct: five, ...(five > 0 ? { resetsAt: '2026-10-12T12:00:00Z' } : {}) },
      sevenDay: { pct: week, resetsAt },
      at: NOW - 60_000,
    }
    store[`health:${id}`] = { kind: 'ok' }
  }
  return { w, store }
}

const SOON = '2026-10-14T03:00:00Z'
const LATER_WEEK = '2026-10-17T03:00:00Z'

test('with Claude Code\'s login picked to start on, the default, a new session stays there though another account\'s 5-hour window hasn\'t started', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [0, 10, SOON], '3': [0, 20, LATER_WEEK] })
  const clock = world(on, w, store)
  await start($, clock)
  await clock.advance(36_000)
  expect(w.envSets).toEqual([])
  const pane = await mountPane($)
  expect(await pane.find({ text: /New sessions start on it\./ })).toBeDefined()
  await pane.unmount()
})

test('with a fresh 5-hour window picked, a new session moves where one hasn\'t started, the week resetting soonest, and says why; the next new session starts on another', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [0, 10, SOON], '3': [0, 20, LATER_WEEK] })
  const clock = world(on, w, { ...store, 'start-on': 'fresh' })
  await start($, clock)
  expect(slots(w)).toEqual([SLOT2])
  await clock.advance(36_000)
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toEqual([expect.stringMatching(/^Switched to Claude account 2 .*: its 5-hour window hadn't started\.$/)])
  const pane = await mountPane($)
  expect(await pane.find({ text: /New sessions start on an account whose 5-hour window hasn't started, the one whose week resets soonest\./ })).toBeDefined()
  expect(await pane.find({ text: /New sessions start on an account with a fresh 5-hour window, or on it when none has one\./ })).toBeDefined()
  await pane.unmount()
  // Another window opens on Claude Code's login: account 2 is claimed, so it starts on account 3. (This test's
  // second window shares the first's process, so its start on Claude Code's login reads as a move there.)
  await start($, clock)
  expect(slots(w).filter(slot => slot !== '')).toEqual([SLOT2, SLOT3])
})

test('with a fresh 5-hour window picked, a new session stays on Claude Code\'s login while its own window hasn\'t started', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [0, 40, LATER_WEEK], '2': [0, 10, SOON], '3': [0, 20, LATER_WEEK] })
  const clock = world(on, w, { ...store, 'start-on': 'fresh' })
  await start($, clock)
  await clock.advance(36_000)
  expect(w.envSets).toEqual([])
})

test('with a fresh 5-hour window picked and Claude in Chrome connecting as a window opens, the visit ends on the account the session starts on', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [20, 30, LATER_WEEK], '3': [0, 20, SOON] })
  w.chrome = { extensions: [SLOT2] }
  const clock = world(on, w, { ...store, 'start-on': 'fresh', 'chrome-account': '2', 'chrome-accounts': ['2'] })
  await start($, clock)
  expect(slots(w)).toEqual([SLOT2])
  await clock.advance(36_000)
  await clock.advance(36_000)
  expect(w.chromeAsked).toEqual([SLOT2])
  // Straight on from the visit to account 3, not back to account 1 first.
  expect(slots(w)).toEqual([SLOT2, SLOT3])
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toEqual([expect.stringMatching(/^Switched to Claude account 3 .*: its 5-hour window hadn't started\.$/)])
})

test('with a fresh 5-hour window picked on the Chrome extension\'s account, the visit to connect Claude in Chrome is where the session stays', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [0, 10, SOON], '3': [0, 20, LATER_WEEK] })
  w.chrome = { extensions: [SLOT2] }
  const clock = world(on, w, { ...store, 'start-on': 'fresh', 'chrome-account': '2', 'chrome-accounts': ['2'] })
  await start($, clock)
  await clock.advance(36_000)
  await clock.advance(36_000)
  expect(slots(w)).toEqual([SLOT2])
  expect(w.toasts.filter(t => /^Switched to/.test(t))).toEqual([expect.stringMatching(/^Switched to Claude account 2 .*: its 5-hour window hadn't started\.$/)])
})

test('with a fresh 5-hour window picked, where Connect can\'t run as the window opens, the session still moves to its start, once it may', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [20, 30, LATER_WEEK], '3': [0, 20, SOON] })
  // Account 1's token refreshes in a few minutes: no switch off it until then, Connect's visit included.
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 5 * 60_000)
  w.chrome = { extensions: [SLOT2] }
  const clock = world(on, w, { ...store, 'start-on': 'fresh', 'chrome-account': '2', 'chrome-accounts': ['2'] })
  await start($, clock)
  expect(slots(w)).toEqual([])
  expect(w.toasts).toContain("Switching to Claude account 3 in a few minutes, once account 1's token has refreshed.")
})

test('with a fresh 5-hour window picked, a session that isn\'t interactive stays where it starts', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [0, 10, SOON], '3': [0, 20, LATER_WEEK] })
  const clock = world(on, w, { ...store, 'start-on': 'fresh' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: false })
  await clock.settle()
  await clock.advance(36_000)
  expect(w.envSets).toEqual([])
})

test('with a fresh 5-hour window picked, a session started on another account\'s slot stays there', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [0, 40, LATER_WEEK], '2': [30, 10, LATER_WEEK], '3': [0, 20, SOON] })
  w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = SLOT2
  const clock = world(on, w, { ...store, 'start-on': 'fresh' })
  await start($, clock)
  await clock.advance(36_000)
  expect(slots(w)).toEqual([])
})

test('with a fresh 5-hour window picked, a session Claude Code won\'t let switch stays on its login', async ($, on) => {
  const { w, store } = await threeLogins({ '1': [30, 40, LATER_WEEK], '2': [0, 10, SOON], '3': [0, 20, LATER_WEEK] })
  w.refuseEnv = true
  const clock = world(on, w, { ...store, 'start-on': 'fresh' })
  await start($, clock)
  await clock.advance(36_000)
  expect(slots(w)).toEqual([])
})

test('the pane says how old a reading is once it is older than 20 minutes, and why it isn\'t read where no session has used the account lately', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1')
  // Login 2's token ran out an hour ago: no session has used it since, and its usage isn't read until one does.
  w.keychain[await keychainItem(SLOT2)] = blob('tok-2', NOW - HOUR)
  w.usage['tok-1'] = [20, 30]
  const old = { fiveHour: { pct: 30, resetsAt: '2026-10-12T12:00:00Z' }, sevenDay: { pct: 40, resetsAt: '2026-10-18T03:00:00Z' }, at: NOW - 2 * HOUR }
  const clock = world(on, w, { ...TWO_LOGINS, 'reading:2': old })
  await start($, clock)
  const pane = await mountPane($)
  expect((await pane.find({ key: 'account-2' }))?.text).toMatch(/read 2h 0m ago, when a session last used it; read again once one does$/)
  expect((await pane.find({ key: 'account-1' }))?.text).not.toMatch(/read .* ago/)
  await pane.unmount()
})

test('a reading Anthropic\'s rate limit keeps old says its age, with no word of an idle sign-in', async ($, on) => {
  const w = fresh()
  w.keychain['Claude Code-credentials'] = blob('tok-1', NOW + 24 * HOUR)
  w.usage['tok-1'] = [20, 30]
  w.isUsageLimited = true
  const old = { fiveHour: { pct: 30, resetsAt: '2026-10-12T12:00:00Z' }, sevenDay: { pct: 40, resetsAt: '2026-10-18T03:00:00Z' }, at: NOW - 25 * 60_000 }
  const clock = world(on, w, { accounts: [{ id: '1', slot: '', email: 'one@example.com' }], 'reading:1': old })
  await start($, clock)
  const pane = await mountPane($)
  expect(await pane.find({ text: /^Anthropic is rate limiting usage checks/ })).toBeDefined()
  expect((await pane.find({ key: 'account-1' }))?.text).toMatch(/read 25m ago$/)
  await pane.unmount()
})
