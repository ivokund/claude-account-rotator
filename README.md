# Claude account rotator

A [Claude Code](https://code.claude.com) mod for people with more than one Claude account. It shows each account's usage under the prompt, and moves your session to another account before the one in use runs out.

![The footer up close as the account in use runs low; the session moves to another account and a notice says so; then the panel switches the footer's top row between bars, pies and braille](demo/demo.gif)

<sub>A real session fed imitated accounts (`demo/harness`), so no real account appears.</sub>

## Install

```
/plugin install account-rotator --marketplace ivokund/claude-account-rotator
```

Then click the usage in the footer, press **+ Add an account** and approve the sign-in in your browser. The account you are signed in with now is account 1.

## The footer

A column per account. The top row is the room it has right now (its 5-hour window, or none once its week is spent), the bottom row its week: green with plenty left, red with little. The percents are the account in use's.

Click it for the panel: each account's usage and reset times, **Sign in**, **Use now** and **Remove**, **+ Add an account**, **Rotate now**, and **Display**, which picks the footer's look:

![The footer's looks. Glyphs: bars, pies or braille. The account in use: between lines, on a tile, or with the rest dimmed. Counting what is used instead of the room left, without percents, or without glyphs. An account that needs a sign-in, one signing in, and the rows' names under the pointer.](demo/looks.png)

## What it does

- **Rotates.** Once the account in use is down to 10% of its 5-hour window or 5% of its week, the session moves to the account with the most room, and a notice says which and why.
- **Recovers.** A turn that still hits a usage limit or a rejected sign-in switches accounts and asks Claude to carry on.
- **Warns.** When every account is near its limit, a line above the prompt says when the next one frees up. When an account needs signing in again, the same line says so and signs it in with one click.

## Requirements

- macOS, where Claude Code keeps sign-ins in the keychain, or Linux, where it keeps them in files.
- Claude Code 2.1.296 or later, in its fullscreen renderer (`/tui fullscreen`), the only one that passes clicks on: the panel opens with a click.
- Any Mac terminal: Terminal.app, iTerm2, Ghostty, Warp, VS Code; on Linux, one with mouse reporting. In iTerm2 the profile's *Enable mouse reporting* must be on, in tmux `set -g mouse on`, and iTerm2's `tmux -CC` mode can't run fullscreen.
- Claude subscription accounts (tested with Max and Team seats).

Mods are early access in Claude Code, and this one relies on internals a release can change: where sign-ins are stored, and the usage endpoint behind `/usage`.

## How it works

- Each account you add gets a folder, `~/.claude/accounts/<n>`, and Claude Code keeps its sign-in in the keychain under that folder's name (on Linux, in that folder's `.credentials.json`), as for any config folder. A switch points the session at another account's sign-in.
- Its only network traffic: each account's usage every 10 minutes, from the endpoint `/usage` reads, with that account's own token. Tokens stay where Claude Code keeps them; the mod stores each account's email, organization, plan and last usage.

## Uninstall

Remove each account in the panel, which signs it out, then run `claude plugin uninstall account-rotator@claude-account-rotator` and delete `~/.claude/accounts`.

## Terms

As of October 2026, neither Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (October 8, 2025) nor its [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (June 17, 2025) forbid one person from holding more than one Claude account. The Consumer Terms forbid sharing an account's login details, so add only your own. Terms change; this is not legal advice. Not affiliated with or endorsed by Anthropic.

## Develop

```
claude --plugin-dir .     # a session with the mod loaded from this folder
claude plugin validate .
claude plugin test .
```

`demo/record.mjs` records the GIF and `demo/looks.mjs` draws the footer's looks, both from a real session fed imitated accounts; their headers say what they need.

## License

[MIT](LICENSE)
