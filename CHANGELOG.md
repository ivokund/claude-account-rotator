# Changelog

What each version of the account rotator changed. To get each one as Claude Code starts, turn on auto-update: in `/plugin`, open **Marketplaces**, pick **claude-account-rotator** and choose **Enable auto-update**. To update by hand, run `claude plugin marketplace update claude-account-rotator`, then `claude plugin update account-rotator@claude-account-rotator`, and start a new session.

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
