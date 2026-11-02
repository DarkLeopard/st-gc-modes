# Group Chat Modes (Smart / Alias)

**Group Chat Modes (Smart / Alias)** is a third-party UI extension for SillyTavern that adds two extra group-reply modes to group chats: **Smart** (reply strategy 4) and **Alias** (reply strategy 5). Smart picks its responders through a four-level cascade — from a direct name-or-alias hit to a single quiet LLM request that decides who was addressed by a sign and who has a reason to join on their own — and posts a short note into the chat when nobody fits. Alias relies purely on the alias table and never calls the LLM. This documentation covers version 1.1.0.

## Overview

The extension does not patch the SillyTavern core. It adds two options — **Smart** (value 4) and **Alias** (value 5) — to the "reply strategy" dropdown in the group panel. The core knows nothing about these values, so groups set to either new mode are handled entirely by the extension: it watches chat events and decides itself which members answer a user message. A responders-cap widget is added to the group panel as well. The extension's own settings live under **Extensions → Group Chat Modes (Smart / Alias)**: the master switch, director instructions, context depth, cascade level toggles, the "(nobody)" note, the default responders cap, and the alias table.

## Modes

**Smart (strategy 4)** — the "thinking" mode. Every user message goes through the four-level cascade (next section): local matching by names and aliases first; only when that finds nothing is a single quiet LLM request sent, looking for both indirect addresses and characters with a reason to join. As soon as responders are found, the cascade stops. If no one fits, the chat receives the "(nobody)" note (when that setting is on).

**Alias (strategy 5)** — the no-LLM mode. The user message is checked against the alias table: every character's name is always checked, plus any listed signals (nicknames, shortenings, forms of address). Only the characters with a match respond; the LLM is never called at all.

## The level cascade (Smart mode)

- **Level 1: direct hit (name or alias)** — local matching of the message against the alias table: the character name always counts, plus the signals. If members are found, they answer immediately and the cascade stops. No LLM call.
- **Level 2: indirect address (by attribute)** — when no direct match exists, the quiet LLM request asks who was addressed by a sign — a profession, a role, a look ("Hey, baker!") — instead of the name.
- **Level 3: who would join the conversation** — the same single request also asks who has their own reason to support the conversation right now, even if nobody addressed them directly.
- **„Nobody“ note in chat** — when Smart matched nobody, the extension pushes a short user message into the chat: `(Nobody joined the conversation.)` (in a Russian UI — `(Никто не вступил в разговор.)`); one `localize()` call picks the language. No LLM call.

The LLM is reached only for levels 2 and 3, and only once: a single quiet `generateRaw` request to the currently active API — no preset is touched. Levels 1 and 4 are local, and Alias mode never calls the LLM at all. If the quiet request fails or returns an empty answer, that counts as "nobody": levels 2 and 3 are simply skipped and no exception is raised.

## Responders cap (the ceiling)

How many members may answer one user message is limited by a "ceiling":

- **the default** is set by the **Responders cap (default)** setting in the extension panel: options 2, 3, 4, 5 and "none"; the stored value 0 means "none" — unlimited. The default is 2;
- **per group**, the **Responders cap (this group)** widget in the group panel offers "(default)", 2, 3, 4, 5 and "none". The value is stored in the group's custom field `st_gc_modes.ceiling` and takes priority over the default.

When more members matched than the ceiling allows, the extras are trimmed: the matched order is preserved and the trimmed members are logged to the console.

## Alias table

The **Member aliases** setting in the extension panel opens a two-column table — "Member" and "Alias words (comma separated)" — one row per character:

| Member | Alias words (comma separated) |
| --- | --- |
| Kira | Kir, Kira-chan, baker |

How it works:

- the character name is always checked by itself — you never need to list it among the signals;
- the signal field holds comma-separated extra signals: nicknames, shortenings, forms of address (the empty-field placeholder reads "Kir, Kira-chan, baker");
- a single-word signal requires the whole token: "Kir" matches "Kir" but not "Kirill";
- a multi-word signal matches only when all of its words are present in the message;
- new characters are prefilled with the name plus the first three letters of the name;
- the table is used by both modes — Smart and Alias alike;
- the **Update list** button rebuilds the table from the current character list.

## Settings panel

The panel opens under **Extensions → Group Chat Modes (Smart / Alias)**.

1. **Enabled** — on by default; the master switch. When it is off, the extension removes its Smart/Alias options from the reply-strategy dropdown and the per-group cap widget from the group panel, and stops reacting to messages — groups configured for Smart or Alias simply stay silent, because the SillyTavern core itself does not know strategy values 4 or 5. The settings panel stays available; the toggle saves itself through the standard extension-settings mechanism, and the switch is confirmed by a toast.
2. **Smart: director instructions** — an editable textarea filled with the default block (below). Tooltip: “System instructions for the quiet "director" LLM request used by Smart mode when no direct alias match. The model reads the participant list and the recent chat.”
3. **Context depth N (last messages)** — default 10, range 1–50. Tooltip: “How many of the last chat messages the director request sees (1-50).”
4. **Level 2: indirect address (by attribute)** — on by default.
5. **Level 3: who would join the conversation** — on by default.
6. **„Nobody“ note in chat** — on by default.
7. **Responders cap (default)** — default 2; options 2, 3, 4, 5, "none" (0).
8. **Member aliases** — the alias table described above, with its columns "Member" and "Alias words (comma separated)" and the **Update list** button.
9. **Responders cap (this group)** — in the group panel; options "(default)", 2, 3, 4, 5, "none" — takes priority over the default.
10. The top of the panel carries a link to the repository — <https://github.com/DarkLeopard/st-gc-modes> — captioned "Details in README".

The default text of the director instructions (from `DEFAULT_SMART_INSTRUCTIONS` in index.js):

```
You are the group-chat director choosing which characters join the conversation.
You receive: participant list (name + short description), recent chat, and the last user message.
Pick ONLY participants who would realistically respond:
1. They were addressed by an indirect sign instead of their name (their profession, role, place, or a personal attribute from their description).
2. They have their own motivation, reason, or duty to chime in right now.
Do not pick anyone out of politeness. If several fit, list all. Answer format: participant names separated by commas, copied exactly as given in the list. If no one fits, answer exactly: none.
```

## Behavior in chat

- The cascade reacts only to user messages: its trigger is the rendered-user-message event (`USER_MESSAGE_RENDERED`). Messages sent by characters themselves (self-calls) never trigger it.
- The "(nobody)" note is an ordinary user message, so later LLM requests see it in the chat context.
- Repeated triggers on the same message are filtered out: events are deduplicated by chat + message index + send date.
- The cascade starts slightly deferred (50 ms) and waits for the group to be idle.

## Limitations and known quirks

- After a SillyTavern core update, the DOM injection may stop working until the extension is patched (element ids change).
- A reasoning model may return an empty answer to the quiet request — the extension then treats it as "nobody"; the fix is prompt tuning.
- Aliases match whole words, not substrings.
- The quiet request sends recent chat context to the active API — a privacy and token-cost consideration.

## Installation, update, reinstall

**Installation.** In SillyTavern open **Extensions → Install extension** (the puzzle icon / "Install extension" button), paste the repo URL `https://github.com/DarkLeopard/st-gc-modes`, choose **for me only**, and reload the page (F5).

**Update.** Open **Extensions → Manage extensions**: the extension row shows an update button (download icon, hover hint "Update available") when the repo has a newer version. The update applies immediately, no confirmation prompt. Auto-update is off for version 1.1.0 — click the button manually. If no button appears, remove the extension and install it again by the same UI path: the settings (enabled state, aliases, instructions) survive a reinstall because they are stored in user settings, not in the extension folder.

**Reinstall / clean install.** Remove the old folder through the Extensions UI (**Uninstall** / **Remove**), then install by URL again.

The extension is built and verified against SillyTavern 1.19.0+; it is plain ES modules — no build step, no npm dependencies.

## License

MIT — see [LICENSE](LICENSE).

## Author

Created by [DarkLeopard](https://github.com/DarkLeopard).