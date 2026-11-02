# Group Chat Modes (Smart / Alias)

A SillyTavern third-party extension that adds two extra group reply modes to
group chats: **Smart** and **Alias**. Smart runs a four-level cascade — direct
alias matching first, then one quiet "director" LLM request — and posts a
"(nobody)" note when no one fits. Alias is pure alias-signal matching with no
LLM calls at all.

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