# Group Chat Modes (Smart / Alias)

**Group Chat Modes (Smart / Alias)** is a third-party UI extension for SillyTavern that adds two extra group-reply modes to group chats: **Smart** (reply strategy 4) and **Alias** (reply strategy 5). Smart picks its responders through a five-level cascade — from a direct name-or-alias hit, through a single quiet LLM request that decides who was addressed by a sign and who has a reason to join on their own, to a context auto-pick on an empty input — and posts a short note into the chat when nobody fits. Alias relies purely on the characters' aliases and never calls the LLM. This documentation covers version 1.3.3. Version 1.3.1 excludes the user's persona from all trigger and candidate levels, removes automatically the empty persona message that the ST 1.19.0 core fallback pushes on an empty send, and adds level 5 — the context auto-pick of the responder by dialogue logic on empty input. Version 1.3.3 removes the group-panel warning box and bulk generation — generation stays in the character card only.

## Overview

The extension does not patch the SillyTavern core. It adds two options — **Smart** (value 4) and **Alias** (value 5) — to the "reply strategy" dropdown in the group panel. The core knows nothing about these values, so groups set to either new mode are handled entirely by the extension: it watches chat events and decides itself which members answer a user message. A responders-cap widget is added to the group panel as well. The extension's own settings live under **Extensions → Group Chat Modes (Smart / Alias)**: the master switch, director instructions, context depth, cascade level toggles, the "(nobody)" note, and the default responders cap.

## Modes

**Smart (strategy 4)** — the "thinking" mode. Every user message goes through the four-level cascade (next section): local matching by names and aliases first; only when that finds nothing is a single quiet LLM request sent, looking for both indirect addresses and characters with a reason to join. As soon as responders are found, the cascade stops. If no one fits, the chat receives the "(nobody)" note (when that setting is on).

**Alias (strategy 5)** — the no-LLM mode. The user message is checked against the character aliases: every character's name is always checked, plus any listed signals (nicknames, shortenings, forms of address). Only the characters with a match respond; the LLM is never called at all.

## The level cascade (Smart mode)

- **Level 1: direct hit (name or alias)** — local matching of the message against the character aliases: the character name always counts, plus the signals. If members are found, they answer immediately and the cascade stops. No LLM call.
- **Level 2: indirect address (by attribute)** — when no direct match exists, the quiet LLM request asks who was addressed by a sign — a profession, a role, a look ("Hey, baker!") — instead of the name.
- **Level 3: who would join the conversation** — the same single request also asks who has their own reason to support the conversation right now, even if nobody addressed them directly.
- **Level 5: context auto-pick (empty input)** — Smart-only, and only for an empty input. When the cascade reaches the "nobody" point (levels 2/3 found no one in the quiet request), one extra quiet request asks: "who must speak next according to the dialogue logic?" — unfinished expectations, unanswered question-answer pairs, whose turn is due. The answer must be exactly one participant name, resolved strictly against the roster (an exact name-or-alias match, no fuzzy matching): a single clear pick has that participant respond instead of the "Nobody" note; any other outcome keeps the current behavior. The level has its own checkbox in the panel, on by default; the persona is never picked.
- **„Nobody“ note in chat** — when Smart matched nobody, the extension pushes a short user message into the chat: `(Nobody joined the conversation.)` (in a Russian UI — `(Никто не вступил в разговор.)`); one `localize()` call picks the language. No LLM call.

The LLM is reached only for quiet requests: levels 2 and 3 share a single quiet `generateRaw` request to the currently active API — no preset is touched — and level 5 makes one more quiet request, only on an empty input. Levels 1 and 4 are local, and Alias mode never calls the LLM at all. If the quiet request fails or returns an empty answer, that counts as "nobody": levels 2 and 3 are simply skipped and no exception is raised. A failed or empty level 5 request counts as "no clear pick".

## Responders cap (the ceiling)

How many members may answer one user message is limited by a "ceiling":

- **the default** is set by the **Responders cap (default)** setting in the extension panel: options 2, 3, 4, 5 and "none"; the stored value 0 means "none" — unlimited. The default is 2;
- **per group**, the **Responders cap (this group)** widget in the group panel offers "(default)", 2, 3, 4, 5 and "none". The value is stored in the group's custom field `st_gc_modes.ceiling` and takes priority over the default.

When more members matched than the ceiling allows, the extras are trimmed: the matched order is preserved and the trimmed members are logged to the console.

## Character card aliases

Aliases live in the character card itself — in the field `character.data.extensions.st_gc_modes_aliases`, a single comma-separated string (for example, "Kir, Kira-chan, baker"). Storing them in the card survives page reloads and extension reinstalls, and the aliases remain part of the character file: the card is exported and carried over together with them.

The advanced character editor has a **"Name aliases"** field (RU: «Заменители имени (алиасы)») — a one-line comma-separated input with a **"Generate with LLM"** button next to it. The button sends the character description to the active API in one quiet request, parses the answer, and puts the parsed alias list into the field. Like every other editor field in edit mode, this field is autosaved by the core itself — on focus loss the edit (including a fully cleared field) reaches the card, and after a page reload that is exactly what you see; the regular Save button still works too. If the model returns no candidates, the field is cleared and the emptiness is saved into the card through the same path. In "new character" mode the field is empty and the generate button stays disabled until the character exists and is saved. The field itself (manual save) works regardless of the extension master switch; only generation is gated by it.

There is no alias table in the extension settings panel anymore. The panel keeps: the master switch, the repository link, the director instructions, the context depth, the level 2/3/4 toggles, and the default responders cap — no alias widgets.

The resolution order is the same for Smart and Alias:

- the character card field is checked first;
- when the card field is empty, the old extension-setting aliases (`aliasSignals` stored under `extension_settings['st-gc-modes']`) serve as a fallback so previously configured groups keep working; this fallback is read-only;
- the character's full name is always checked on top of any aliases — unchanged.

For new setups, put aliases in the character card. The legacy storage is deprecated: nothing writes to it anymore, and its data is not deleted — the fallback merely reads it.

The matching mechanics are unchanged:

- the character name is always checked by itself — you never need to list it among the aliases;
- a multi-word signal matches only when all of its words are present in the message;
- a single-word signal requires the whole token: "Kir" matches "Kir" but not "Kirill";
- alias signals work in both modes — Smart and Alias alike.

## Settings panel

The panel opens under **Extensions → Group Chat Modes (Smart / Alias)**.

1. **Enabled** — on by default; the master switch. When it is off, the extension removes its Smart/Alias options from the reply-strategy dropdown and the per-group cap widget from the group panel, and stops reacting to messages — groups configured for Smart or Alias simply stay silent, because the SillyTavern core itself does not know strategy values 4 or 5. The settings panel stays available; the toggle saves itself through the standard extension-settings mechanism, and the switch is confirmed by a toast.
2. **Smart: director instructions** — an editable textarea filled with the default block (below). Tooltip: “System instructions for the quiet "director" LLM request used by Smart mode when no direct alias match. The model reads the participant list and the recent chat.”
3. **Context depth N (last messages)** — default 10, range 1–50. Tooltip: “How many of the last chat messages the director request sees (1-50).”
4. **Level 2: indirect address (by attribute)** — on by default.
5. **Level 3: who would join the conversation** — on by default.
6. **Level 5: context auto-pick (empty input)** — on by default. Tooltip: “When the user sends an empty message and levels 2/3 find nobody, make one extra quiet request: who must speak next according to the dialogue logic? One clearly named participant responds instead of the "(nobody)" note. The persona is never picked.”
7. **„Nobody“ note in chat** — on by default.
8. **Responders cap (default)** — default 2; options 2, 3, 4, 5, "none" (0).
9. There are no alias widgets in the panel anymore: aliases are set in the advanced character editor (see "Character card aliases").
10. **Responders cap (this group)** — in the group panel; options "(default)", 2, 3, 4, 5, "none" — takes priority over the default.
11. The top of the panel carries a link to the repository — <https://github.com/DarkLeopard/st-gc-modes> — captioned "Details in README".

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

Empty sends are a special case. In SillyTavern 1.19.0, a Smart (4) or Alias (5) group with an empty input box falls back to the core behavior "send the user message as is": an empty message named after the user's persona lands in the chat. The extension removes it immediately upon render. In Smart this counts as a continue signal, and the cascade runs with an empty input: when the dialogue logic has a clear next speaker, that participant responds (level 5); when there is no clear continuation, everything follows the usual rules — up to and including the "(nobody)" note. In Alias there are no signals and nothing happens. The persona is never chosen to answer at any level, and its own messages are left untouched.

## Limitations and known quirks

- After a SillyTavern core update, the DOM injection may stop working until the extension is patched (element ids change).
- A reasoning model may return an empty answer to the quiet request — the extension then treats it as "nobody"; the fix is prompt tuning.
- Aliases match whole words, not substrings.
- In "new character" mode, aliases are unavailable until the first save (the field is empty, the generate button is disabled) — a consequence of keeping them in the character card.
- The quiet request sends recent chat context to the active API — a privacy and token-cost consideration.

## Installation, update, reinstall

**Installation.** In SillyTavern open **Extensions → Install extension** (the puzzle icon / "Install extension" button), paste the repo URL `https://github.com/DarkLeopard/st-gc-modes`, choose **for me only**, and reload the page (F5).

**Update.** Open **Extensions → Manage extensions**: the extension row shows an update button (download icon, hover hint "Update available") when the repo has a newer version. The update applies immediately, no confirmation prompt. Auto-update is off for version 1.2.0 — click the button manually; the update procedure itself is unchanged. After the update the alias table is gone, while the old alias value from the settings is kept and still works as the legacy fallback (see "Character card aliases"). If no button appears, remove the extension and install it again by the same UI path: the settings (enabled state, instructions, legacy alias value) survive a reinstall because they are stored in user settings, not in the extension folder, and the character-card aliases stay intact as well.

**Reinstall / clean install.** Remove the old folder through the Extensions UI (**Uninstall** / **Remove**), then install by URL again.

The extension is built and verified against SillyTavern 1.19.0+; it is plain ES modules — no build step, no npm dependencies.

## License

MIT — see [LICENSE](LICENSE).

## Author

Created by [DarkLeopard](https://github.com/DarkLeopard).