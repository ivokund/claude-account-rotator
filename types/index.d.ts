/** One usage window of a login: percent used, and when it resets (ISO 8601). */
export type UsageWindow = { pct: number; resetsAt?: string }

/**
 * A login's usage as last read, `at` in epoch milliseconds. `models`: a model
 * family's own week, by its display name ("Fable"), inside the login's week.
 * `usageAt`: when the usage endpoint last answered for the login, which alone
 * reports `models` (or when a limit hit marked one of them full): a response's
 * report since, taken `at`, keeps them as read then.
 */
export type Reading = { fiveHour?: UsageWindow; sevenDay?: UsageWindow; models?: Record<string, UsageWindow>; usageAt?: number; at: number }

/** Whether a login can serve requests, or why not. */
export type Health =
  | { kind: 'ok'; refreshExpiresAt?: number }
  | { kind: 'login-needed'; why: string }
  | { kind: 'logging-in'; since: number }

/**
 * One Claude login. `slot` is the credentials directory Claude Code reads it
 * from: '' is the normal login, anything else an absolute directory.
 */
export type Account = {
  id: string
  slot: string
  email?: string
  /** One email can hold logins in several organizations (your Max plan, a Team seat). */
  orgId?: string
  orgName?: string
  /** `subscriptionType` as `claude auth status` reports it: max, team, pro. */
  plan?: string
}

/**
 * Who a login's sign-in belongs to, as the profile endpoint answered for the
 * token `token` digests; the plan as Claude Code reads it from the sign-in.
 */
export type Holder = { token: string; who: Pick<Account, 'email' | 'orgId' | 'orgName' | 'plan'> & { email: string } }

/** How the footer draws one of its rows: a glyph per login, or not at all. */
export type Glyphs = 'bars' | 'pie' | 'braille' | 'none'

/** How the footer marks the login in use: a dark line down each side of its column, a tile behind it, or the rest dimmed. */
export type Highlight = 'lines' | 'tile' | 'dim'

/** What glyphs and bars fill with: the room a login has left, or what it has used. */
export type Fill = 'left' | 'used'

/**
 * Which login the rotation moves to: the one whose 5-hour window resets
 * soonest, the one with the most room right now, or the next in the list; or
 * none, the rotation off: the session moves only when the person picks.
 */
export type RotateTo = 'reset' | 'room' | 'order' | 'off'

/**
 * Where a new session starts: on Claude Code's login, or on an account whose
 * 5-hour window hasn't started, so windows start early and refill early.
 */
export type StartOn = 'login' | 'fresh'

/** The footer's look, picked in the pane and kept across sessions. */
export type FooterStyle = {
  session: Glyphs
  week: Glyphs
  /** Whether a row ends with the login in use's percent. */
  sessionPercent: boolean
  weekPercent: boolean
  active: Highlight
  /** Either way the colors go from green with all the room left to red with none. */
  fill: Fill
}

/**
 * Claude in Chrome in one session: the account its connection was made as,
 * where known, and whether a browser answered there; `hasFailed` once a
 * browser call found none, until one is answered again.
 */
export type ChromeLink = { as?: string; isPaired: boolean; hasFailed?: boolean }

/** A run of the footer's text: its color, and the lighter one it takes while the pointer is over the footer. */
export type FooterRun = { text: string; color?: string; lit?: string; backgroundColor?: string; dimColor?: boolean }

/** Everything the footer, band and pane draw from. */
export type View = {
  accounts: Account[]
  readings: Record<string, Reading>
  health: Record<string, Health>
  /** Who each login's sign-in belongs to: a /login in a session on a login signs in there, whoever it signs in. */
  holders: Record<string, Holder>
  /** The login this session sends its requests with. */
  activeId: string
  /** This session only: the model its main loop asks for, as its last request named it. */
  model?: string
  /**
   * This session only: the logins whose token had run out at their last
   * check. Only Claude Code renews a token, as a session sends a request, so
   * no session has used such a login lately, and its usage isn't read until one does.
   */
  idle?: string[]
  /**
   * Set after a switch until Claude Code is seen sending the new login's
   * sign-in: meanwhile the footer blinks its in-use mark, and the pane says
   * switching. `why` the switch was made, told in a toast once it lands; none
   * for a quiet one, as Claude in Chrome's visits are, or once told. `isDue`:
   * SETTLE_MS on, with no request since to show it, so the next request reads
   * the new sign-in: it shows switched, and the first request after confirms it.
   */
  pending?: { id: string; from: string; since: number; why?: string; isDue?: boolean }
  /** Anthropic rate limited a usage check: no session asks again until then, epoch ms. */
  usagePausedUntil?: number
  /** Account id whose removal waits for a second press. */
  removing?: string
  footer: FooterStyle
  /** Which login the rotation moves to, picked in the pane and kept across sessions. */
  rotateTo: RotateTo
  /** Where new sessions start, picked in the pane and kept across sessions. */
  startOn: StartOn
  /** This session only: Claude Code's security default refuses switching, as on a Team or Enterprise account. */
  isSwitchBlocked?: boolean
  /** This session only: it was told that the login in use is spent and the session can't leave it. */
  isStuckTold?: boolean
  /**
   * The account the Chrome extension is signed in to, the only one it answers:
   * picked in the pane, or learned when Claude in Chrome paired; kept across sessions.
   */
  chromeAccountId?: string
  /** The accounts a Chrome extension has answered as, kept across sessions: the Chrome box lists them. */
  chromeAccountIds?: string[]
  /** This session only: the Chrome box also lists the accounts no Chrome extension has answered as yet. */
  isChromeOthersShown?: boolean
  /** This session only: whether it has Claude in Chrome, once a call to it told. */
  hasChrome?: boolean
  /** This session only: Claude in Chrome's connection, once made. */
  chrome?: ChromeLink
  /** This session only: Connect is under way, to this account. */
  chromeConnecting?: string
  /** This session's id, which `claude --resume` takes. */
  sessionId?: string
  /** This session only: the footer draws imitated usage, to judge its look. */
  demo?: boolean
  /** This session's terminal draws block characters from its font, short of the line, as Terminal.app does. */
  hasFontBlocks: boolean
}

declare module 'claude-code' {
  interface PluginState {
    /** `blink`: whether a pending switch's in-use mark is drawn in this beat. */
    'account-rotator': { view: View; blink: boolean }
  }
}
