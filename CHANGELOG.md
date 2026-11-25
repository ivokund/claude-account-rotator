# Changelog

What each version of the account rotator changed. To get each one as Claude Code starts, turn on auto-update: in `/plugin`, open **Marketplaces**, pick **claude-account-rotator** and choose **Enable auto-update**. To update by hand, run `claude plugin marketplace update claude-account-rotator`, then `claude plugin update account-rotator@claude-account-rotator`, and start a new session.

## Unreleased

- **`/clear` keeps the footer, the band and your accounts.** After a `/clear` the footer under the prompt and the band above it went blank, and the panel listed no accounts, until Claude Code restarted. A `/clear` starts a new session in the same window, and the mod lost what it knew about the old one. It now carries that over: the accounts, their usage, the account in use and a switch still on its way. The window stays on the account it was on.
- **The account shown in use is the one the session is on.** The mod reads which account a session is on when it starts, which it also does after `/clear`. A switch made while that read was under way could be overwritten by its older answer: the session then sent as one account while the footer marked another, and each response's usage was saved under the marked account, so two accounts showed the same numbers. A start and a switch now take turns, and a start shows what the session points at once it is done.
- **A switch back that fails no longer shows as made.** When a switch did not take and the session could not be pointed back either, the mod still marked the old account in use. It now keeps the account the session points at, and says the switch has not shown in responses.
- **The store keeps the last 50 moves.** Each start and each move of a session is kept under `moves` in the mod's store file, with what caused it, so a wrong account in the footer can be traced to the step that put it there.

## 0.5.2 - 2026-11-23

- **Each `CLAUDE_CONFIG_DIR` keeps its own accounts.** With the mod installed in two Claude homes, say `~/.claude` and one started with `CLAUDE_CONFIG_DIR=~/.claude-work`, both put added accounts in `~/.claude/accounts/<n>`. Account 2 of one home was account 2 of the other: signing it in from one home signed in the other's, and **Remove** in one signed the other's out. Added accounts now go in the `accounts` folder of the session's own config directory. Accounts added before keep the folder they have, so one that two homes already share stays shared. To split it, **Remove** it in the second home and add it again there, then **Sign in** to it again in the first, since **Remove** signed it out.
- **A home started with `CLAUDE_CONFIG_DIR` reads its own login.** The mod read account 1, Claude Code's login, from `~/.claude` whatever the session's config directory, while Claude Code read it from that directory. So the panel named the `~/.claude` login and showed the usage of the login really in use under its name: one account running out showed another as spent too. The mod now reads account 1 where Claude Code does, as do the `claude auth` commands it runs for it. A session Claude Code starts with its secure storage set to its own config directory is on account 1 too, not a new account.
- **A stale account name no longer blocks a sign-in.** The older version could save the wrong name for account 1 in a `CLAUDE_CONFIG_DIR` home. Signing in another account as that name then failed with "that was account 1 again". Before the mod says so now, it asks the other account's own login who it is. If that login is someone else, the mod renames that account and keeps the new sign-in.
- **Works on Windows.** The mod finds the home folder from `USERPROFILE` where `HOME` isn't set, as Claude Code does.

Thanks to @mhamri (#6).

## 0.5.1 - 2026-11-20

- **An idle window moves on again when its account runs low.** After a switch, a window with nothing going on shows the new account in use and waits for its next request to confirm it. Until then the rotation left it alone, so a window moved to an account that other windows then used up stayed there, and its next prompt could run into the limit. Now, once readings show that account low, the window moves on like any other. Claude.ai connectors and artifacts follow the account a window sits on, as after any switch. The idea comes from Nathan Broadbent's fork.
- **Use now holds until your next request.** An account you pick with **Use now** stays the window's until it sends something, low or not. It could be lost before that: when the pick had to wait a few minutes for a token to refresh, when Claude in Chrome connected in between, or when you picked the account the window was still really on.
- **Idle windows no longer ask every minute whether a switch landed.** Only a request makes Claude Code read the new sign-in, so an idle window had nothing new to learn, yet it asked Anthropic once a minute for as long as it idled. It now asks once a request has gone out. The routine usage check every 10 minutes is unchanged. This also follows a fix in Nathan Broadbent's fork.
- **A switch that didn't take goes back to the right account.** When a switch never lands, the mod points the window back and says so. After two switches in a row it could instead say the switch "has not shown in responses", go on showing the wrong account in use, and record its usage under that account. It now goes back to the account the window really uses. And a prompt sent at the very moment the mod was checking can no longer be told its switch did not take.

## 0.5.0 - 2026-11-19

- **Knows Fable's week.** Fable has a week of its own inside each account's week: Fable use counts toward both, other models only toward the week. A session on Fable now also moves on once its account's Fable week is down to 5%, and goes where both weeks have room; a session on another model isn't moved by it. The panel shows each account's Fable week under its week, the footer shows a Fable session whichever of the two is fuller, and the band above the prompt says when every account is near its Fable limit. The mod follows the model of your main conversation, `/model` included. This comes from Nathan Broadbent's fork of the rotator. Thanks, Nathan!
- **New windows can start on a fresh 5-hour window.** Under **Usage based rotation**, the new **Start on** picks where a new window starts: **Claude Code's login**, as before and still the default, or **a fresh 5-hour window**. With that, a window opening on Claude Code's login moves to an account whose 5-hour window hasn't started, so windows start early and refill early: Claude Code's login itself when its window hasn't started, else the account whose week resets soonest, with at least 15% of its week left. It reads the accounts' usage first, and the toast says why it moved, and how old the reading was for an account it couldn't read. Windows opened one after another spread over such accounts. Only a window that has just opened moves. Where the token of Claude Code's login ran out overnight, the window moves within a minute of its first request.
- **Good to know about Start on.** Claude.ai connectors and artifacts go out as the account a window moved to, as after any switch: a window loads its connectors for the account it opened on, so ones that only exist there may not answer. A Team or Enterprise seat counts like any other account, and a window that starts on one can be blocked from switching like one the rotation moved there.
- **The panel says how old a reading is.** A reading older than 20 minutes says its age under the account, as does a Fable week that old while responses keep the rest current. An account no session has used lately can't be read at all, and the panel says it is read again once a session uses it.
- **"The next frees up in…" names the right time.** With every account spent, the band named the soonest reset of any window with usage on it, even one with room left, which frees nothing. It now says when the first spent account really frees up.
- **A switch Claude Code holds back is said at once.** In a session that takes its settings from its organization, Claude Code can hold a switch back without refusing it. The mod showed that switch as under way, and only minutes later that it did not take. It now says right away that the session can't switch, as on a Team seat.

## 0.4.2 - 2026-11-18

- **Accounts on a plan with no 5-hour window rotate by their week.** Ultra plans report a week alone, and the rotation counted such an account as fully free with no reset time: **most room** and **soonest reset** both took the first one on the list, and a usage limit hit there marked a 5-hour window the plan doesn't have. Now the week decides for such an account: the room it has left, when it resets, and a limit hit fills it. Accounts with a 5-hour window rotate as before.
- **A dropped Claude in Chrome connection is caught however Claude Code reports it.** Claude Code sometimes reports a browser call that found no browser as an ordinary result, not an error, and `list_connected_browsers` can list none. The mod took both as a browser answering, so it never reconnected. Now both count as no browser, and the mod reconnects as it does after the error.
- **Rate-limited usage checks wait as long as Anthropic asks.** After a rate-limited check, every session waited 5 minutes. When Anthropic's answer asks for longer, they now wait that long, up to an hour, and the panel says when checks resume.

These come from Nathan Broadbent's fork of the rotator. Thanks, Nathan!

## 0.4.1 - 2026-11-18

- **Cancel during a browser sign-in now ends it cleanly.** Pressing **Cancel** while a **Sign in** or **+ Add an account** waited on the browser showed "Something went wrong: TypeError…", and the account stayed at "signing in…" with **Cancel** still up. Now the usual "Sign-in for Claude account N did not finish." toast shows, and the account offers **Sign in** again. Thanks to @andrest (#3).

## 0.4.0 - 2026-11-18

- **The footer's in-use mark blinks, and the panel says switching, until a switch lands.** Claude Code goes on sending the old account's sign-in for up to 30 seconds after a switch, so claude.ai actions taken then, like publishing an artifact, still belonged to the old account while the footer already showed the new one in use. Now the footer's mark (the tile, the lines, or the bright column) blinks, and the panel says **switching** in place of **in use**, for at most 35 seconds: until the mod sees the session send the new account (it asks Anthropic whose sign-in the session holds), or, in a session with nothing going on, until Claude Code will read the new sign-in before its next request. The toast that says which account the session switched to shows then, not as the switch starts. If the first request after still goes out as the old account, the session goes back to it, as before.
- **An account read before its window reset shows as unknown, not as fresh.** Such a reading said nothing of the usage since, but the footer drew it as 100% left: an account at 99% looked unused. Now its glyph shows `·`, and the panel says the window reset and wasn't read since.
- **Far fewer usage checks.** Every session checked every account every 10 minutes, and Anthropic began rate limiting the checks, so readings went stale with no sign. Sessions now share readings: an account read in the last 5 minutes by any session isn't checked again. After a rate-limited check, every session waits 5 minutes, and the panel says so.

## 0.3.2 - 2026-11-10

- **A window no longer opens on a spent account to connect Claude in Chrome.** Each window used to move to the account picked in the **Chrome** box for about 35 seconds as it opened, whatever usage that account had left, so a prompt sent then hit its limit. Now, while that account is out of usage, or while no browser answered as it last time but one did as another account, the window stays on its own account, and Claude in Chrome connects at the first browser call that finds no browser.
- **A window that can't switch says what to do once its account runs out.** On a Team or Enterprise seat where Claude Code blocks switching, the line above the prompt, a toast and a notification name the spent account and give the command that brings the conversation back in a session that can switch.
- **In a background session, the advice is now `/stop`, then `claude --resume <id>`.** `/exit` only detaches, so the session went on running on the blocked account, and `claude --resume` opened it again as it was.

## 0.3.1 - 2026-11-10

- **A usage limit hit just after a switch no longer marks the account switched to as spent.** For about 30 seconds after a switch, Claude Code still sends the account it left, so a limit hit then is usually that one's. Before, the new account showed 0% left in the footer and the session moved on again. Now the rotator checks both accounts' usage, stays on the new one while it has room, and continues the turn once the switch lands. A sign-in rejected in those seconds no longer marks the new account as needing a sign-in either.

## 0.3.0 - 2026-10-16

- **Other accounts** at the top of the panel's **Chrome** box lists the accounts no Chrome extension is known to answer as, each with **Try to connect**: for a Chrome opened on another account after the window started. The accounts that answer have **Use for Chrome**.
- **A press keeps an account only once a browser answers as it.** If none does, Claude in Chrome goes back to the account picked before, and a toast says what to check. This replaces **Use this account**, which made any account the extension's, and listed it as active, though no browser answered.
- **The box lists every account a browser answered as the last time the mod connected as it,** where before it kept only the one picked. One whose Chrome has closed leaves the list once a press or a new window finds no browser there.

## 0.2.1 - 2026-10-16

- **The Chrome box lists every account until an extension answers,** so you pick the extension's straight away: **Look for Chrome on another account** is gone. Once a browser has answered as an account, the box lists those, and the one picked for it.
- **A window that can't switch accounts says so in the Chrome box,** with the command that brings the conversation back in a session that can: `claude --resume <id>`.

## 0.2.0 - 2026-10-16

Every copy installed before this one said 0.1.0, whatever it held, so `claude plugin update` never offered an update. Updating once brings everything below.

- **Usage based rotation** in the panel picks where the session moves: by default the account whose 5-hour window resets soonest, so room about to refill is used before it does; else the one with the most room, or the next in the list; or disabled, which leaves switching to you.
- **Team and Enterprise seats.** Where Claude Code's security default stops a session from switching, the mod says so once, with why and how to get a session that can switch, marks the footer, and stops trying. **Use now** gives the same answer instead of an error. The README's [Team and Enterprise accounts](README.md#team-and-enterprise-accounts) lists the ways around it, best first.
- **Claude in Chrome stays connected** as the account its extension is signed in to. Pick it with **Use this account** in the panel's **Chrome** box. Each window connects there as it opens, whatever usage that account has left, reconnects by itself after a drop, and **Connect** above the prompt does it by hand. When no extension answers, the panel says what to check.
- **Shows the account really in use.** When responses minutes after a switch still show the old account's usage, the footer and panel go back to it, and the rotation leaves the other account be for the session.
- **Follows `/login`.** An account whose sign-in turns out to be another listed account's asks for its own again, and the session moves off it; one signed in as an account not on the list becomes that account. The panel's second line names Claude Code's own login, and whether it is personal or a Team or Enterprise seat.
- **Linux.** Sign-ins are read from each account's `.credentials.json`, where Claude Code keeps them there.
- **The footer's looks:** bars, pies or braille; the account in use between lines, on a tile or with the rest dimmed; room left or what is used. The panel adds **Rotate now**, notices became toasts, and the footer is the way into the panel: `/accounts` is gone.

## 0.1.0 - 2026-10-12

The first version: each account's usage under the prompt, and a session that moves to another account before the one in use runs out.
