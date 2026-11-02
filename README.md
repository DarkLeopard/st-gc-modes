# Group Chat Modes (Smart / Alias)

A SillyTavern third-party extension that adds two extra group reply modes to
group chats: **Smart** and **Alias**. Smart runs a five-level cascade — direct
alias matching first, then one quiet "director" LLM request — and posts a
"(nobody)" note when no one fits; when the user sends an empty message and the
dialogue logic has a clear next speaker, level 5 makes that participant
respond — while the user's persona can never be chosen. Alias is pure
alias-signal matching with no LLM calls at all.

Aliases live in the character card itself
(`character.data.extensions.st_gc_modes_aliases`, a single comma-separated
string): the advanced character editor has a **Name aliases** field with a
**Generate with LLM** button. The alias table in the extension settings panel
is gone; the group-level bulk generation is gone too (removed in v1.3.3) —
the user generates aliases per character card, card by card, with the
**Generate with LLM** button in the editor.

## Documentation

* [Русская документация](doc-ru.md)
* [English documentation](doc-en.md)

## Installation

In SillyTavern open **Extensions → Install extension**, paste
`https://github.com/DarkLeopard/st-gc-modes`, choose **for me only**, and
reload the page (F5). Update through the same Extensions UI.

## License

MIT — see [LICENSE](LICENSE).

Created by [DarkLeopard](https://github.com/DarkLeopard).