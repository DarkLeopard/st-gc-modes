# Group Chat Modes (Smart / Alias)

A third-party UI extension for **SillyTavern** that adds two extra **group reply modes** to group chats:
**Smart** and **Alias**. Instead of the built-in Natural / List / Pooled activation strategies, these
modes decide *which* members of the group answer the user — by direct signals or by a small "director"
LLM request.

## What it does

- Adds two entries to the group **Reply strategy** dropdown: **Smart** (value 4) and **Alias** (value 5).
- When a user message arrives in a group chat with one of these modes, the extension runs a lightweight
  **cascade**: direct signal matching first (У1), optionally one quiet LLM request (У2/У3), and finally
  a "(nobody)" note (У4). The selected members are then triggered one at a time via the standard forced-reply
  (`/trigger`-style) mechanism.
- A configurable **responders cap** limits how many members may answer a single user message.
- The cap can be overridden **per group**; the override is stored inside the group object itself
  (custom field `st_gc_modes`) and survives server-side saves.
- A settings panel (**Extensions → st-gc-modes**) exposes all knobs: director instructions, context depth,
  level toggles, the "nobody" note, the default cap, and per-character **alias signals**.
- English and Russian UI strings are selected automatically from the locale.

## Modes

### Smart (strategy 4)

Smart decides who answers with a cascade of four levels:

1. **У1** — direct hit: the message mentions a member's name or one of its alias signals.
   If this alone finds someone, they respond immediately — no LLM request is made.
2. **У2** — indirect address: the message addresses a member through their profession, role, place, or a
   personal attribute instead of their name (detected by the quiet LLM request).
3. **У3** — motivation to join: the member has their own reason, duty, or interest to chime in right now
   (same quiet request).
4. **У4** — "(nobody)" note: when nothing matches and the option is enabled, a small note is pushed into
   the chat so the silence does not look like a bug.

### Alias (strategy 5)

Pure signal matching: a member answers only when the user message contains one of their alias signals or
their name. Alias mode never calls the LLM and never posts the "(nobody)" note — no signals means silence.

## How the cascade works (У1/У2/У3/У4)

| Level | Name | What it checks |
| ----- | ---- | -------------- |
| У1 | Direct / alias match | Message tokens are matched against the member's name and its alias signals with a Unicode-aware tokenizer — works for Latin, Cyrillic and any other script. |
| У2 | Indirect address | A quiet LLM request checks whether a member is addressed by a sign from their description instead of by name. |
| У3 | Motivation to join | The same quiet request checks whether a member has their own motive to join the conversation now. |
| У4 | "Nobody" note | A short system-style note "(Nobody joined the conversation.)" appears in the chat. |

The quiet LLM request is a single `generateRaw` call to the currently active API with the last N chat
messages (context depth, 1–50) and the participant list; it never touches presets. Both У2 and У3 are
decided by the same call; each can be enabled or disabled separately.

## Responders cap

The **responders cap** limits how many members are allowed to answer one user message: 2, 3, 4, 5 or
0 (= none / unlimited). The default cap is set in the settings panel; when the cap trims someone, the
extension logs which members were cut. Matching order is preserved.

## Per-group override

Each group can have its own cap instead of the global default. Open the group panel → right under the
Reply strategy select there is a new **Responders cap (this group)** dropdown with options
`(default)`, 2, 3, 4, 5 and none. The value is stored as the custom field `st_gc_modes.ceiling` on the
group object and persists in the group's JSON file — no extra storage is used.

## Settings panel

Open **Extensions → st-gc-modes** drawer:

- **Smart: director instructions** — the system instructions sent with the У2/У3 quiet request (editable).
- **Context depth N (last messages)** — how many recent messages are fed into the quiet request (1–50).
- **У2: indirect address (profession/attribute)** — toggle the indirect-address criterion.
- **У3: motivation to join** — toggle the motivation criterion.
- **У4: "(nobody)" note in chat** — show the note when nobody matches in Smart mode.
- **Responders cap (default)** — 2, 3, 4, 5 or none (0).
- **Alias signals** — one editable row per character: a comma-separated list of extra trigger words
  (for example foreign spellings of the name, profession, "doc", "boss"). The character's full name is
  always checked implicitly. **Update list** re-renders the table and prefills rows for new characters
  (`name` + first three letters).

## Install

1. Copy this folder into `public/scripts/extensions/third-party/st-gc-modes` (or into your configured
   extensions directory, if you use a custom one).
2. Restart SillyTavern or reload the browser page.
3. Open a group chat → group member management (pencil icon) → **Reply strategy** → pick **Smart** or **Alias**.

## Limitations (v1)

- The cascade reacts only to **user messages**; character messages do not trigger it.
- No character-to-character auto-continue: making one member continue after another would require
  patching SillyTavern core, which this extension refuses to do.
- Core SillyTavern is **not patched** — the extension only injects DOM elements and listens to events.
- The quiet request sends recent chat context to the currently active API — mind privacy and token cost.

## Compatibility

Built and verified against **SillyTavern 1.19.0+**. Plain ES modules, no build step, no npm dependencies.

---

## README (RU)

# Group Chat Modes (Smart / Alias)

Стороннее UI-расширение для **SillyTavern**, которое добавляет в групповые чаты два дополнительных
режима ответа — **Smart** («умный») и **Alias** («алиасы»). Вместо встроенных стратегий
Natural / List / Pooled эти режимы сами решают, *какие* участники группы ответят пользователю —
по прямым сигналам или с помощью маленького «режиссёрского» LLM-запроса.

## Что делает расширение

- Добавляет в выпадающий список **Reply strategy** группы два пункта: **Smart** (значение 4) и
  **Alias** (значение 5).
- Когда в групповом чате с одним из этих режимов приходит сообщение пользователя, расширение запускает
  лёгкую **каскадную проверку**: сначала прямое совпадение по сигналам (У1), затем — при необходимости —
  один тихий LLM-запрос (У2/У3) и, наконец, заметка «(никто)» (У4). Выбранные участники отвечают по
  очереди через штатный форсированный вызов (как `/trigger`).
- Настраиваемый **лимит отвечающих** ограничивает, сколько участников могут ответить на одно сообщение
  пользователя.
- Лимит можно переопределить **для каждой группы** отдельно; переопределение хранится внутри объекта
  группы (кастомное поле `st_gc_modes`) и сохраняется на сервере вместе с группой.
- Панель настроек (**Расширения → st-gc-modes**) открывает доступ ко всем опциям: инструкции режиссёра,
  глубина контекста, включатели уровней, заметка «(никто)», лимит по умолчанию и **сигналы-алиасы**
  для каждого персонажа.
- Английские и русские строки интерфейса выбираются автоматически по локали.

## Режимы

### Smart (стратегия 4)

Smart решает, кто ответит, каскадом из четырёх уровней:

1. **У1** — прямое попадание: в сообщении упомянуты имя участника или один из его сигналов-алиасов.
   Если этого достаточно, участники отвечают сразу — LLM-запрос не выполняется.
2. **У2** — косвенное обращение: сообщение обращается к участнику через профессию, роль, место или
   личный признак вместо имени (определяется тихим LLM-запросом).
3. **У3** — мотивация вступить: у участника есть собственный повод, обязанность или интерес
   присоединиться именно сейчас (тот же тихий запрос).
4. **У4** — заметка «(никто)»: если ничего не совпало и опция включена, в чат добавляется короткое
   примечание, чтобы тишина не выглядела как баг.

### Alias (стратегия 5)

Чистое сопоставление по сигналам: участник отвечает, только если сообщение пользователя содержит один
из его сигналов-алиасов или его имя. Alias никогда не вызывает LLM и не публикует заметку «(никто)» —
нет сигналов, значит тишина.

## Как работает каскад (У1/У2/У3/У4)

| Уровень | Название | Что проверяется |
| ------- | -------- | --------------- |
| У1 | Прямое совпадение / алиас | Токены сообщения сопоставляются с именем участника и его сигналами-алиасами юникод-токенайзером — работает с латиницей, кириллицей и любыми другими алфавитами. |
| У2 | Косвенное обращение | Тихий LLM-запрос проверяет, обращаются ли к участнику по признаку из его описания, а не по имени. |
| У3 | Мотивация вступить | Тот же тихий запрос проверяет, есть ли у участника собственный повод вступить в разговор сейчас. |
| У4 | Заметка «(никто)» | В чате появляется короткое примечание «(Никто не вступил в разговор.)». |

Тихий LLM-запрос — это один вызов `generateRaw` к текущему активному API с последними N сообщениями чата
(глубина контекста, 1–50) и списком участников; пресеты при этом не затрагиваются. У2 и У3 определяются
одним вызовом; каждый уровень можно включить или отключить отдельно.

## Лимит отвечающих

**Лимит отвечающих** ограничивает, сколько участников могут ответить на одно сообщение пользователя:
2, 3, 4, 5 или 0 (= нет / без ограничений). Лимит по умолчанию задаётся в панели настроек; когда лимит
отрезает кого-то, расширение пишет в консоль, кто именно был отрезан. Порядок совпадений сохраняется.

## Переопределение для группы

У каждой группы может быть собственный лимит вместо глобального. Откройте панель группы → прямо под
выпадающим списком Reply strategy появится **Responders cap (this group)** с вариантами
`(по умолчанию)`, 2, 3, 4, 5 и «нет». Значение сохраняется в кастомном поле `st_gc_modes.ceiling`
объекта группы и хранится в её JSON-файле — отдельное хранилище не используется.

## Панель настроек

Откройте ящик **Расширения → st-gc-modes**:

- **Smart: инструкции режиссёра** — системные инструкции для тихого запроса У2/У3 (можно редактировать).
- **Глубина контекста N (последние сообщения)** — сколько последних сообщений уходит в тихий запрос (1–50).
- **У2: косвенное обращение (профессия/признак)** — включатель критерия косвенного обращения.
- **У3: мотивация вступить** — включатель критерия мотивации.
- **У4: заметка «(никто)» в чате** — показывать заметку, когда в режиме Smart никого не нашлось.
- **Лимит отвечающих (по умолчанию)** — 2, 3, 4, 5 или «нет» (0).
- **Сигналы-алиасы** — по одной редактируемой строке на персонажа: список дополнительных слов-триггеров
  через запятую (например, иное написание имени, профессия, «док», «начальник»). Полное имя персонажа
  всегда проверяется неявно. Кнопка **Обновить список** перерисовывает таблицу и добавляет строки для
  новых персонажей (`имя` + первые три буквы).

## Установка

1. Скопируйте эту папку в `public/scripts/extensions/third-party/st-gc-modes` (или в свой каталог
   расширений, если он переопределён).
2. Перезапустите SillyTavern или обновите страницу в браузере.
3. Откройте групповой чат → управление участниками группы (карандаш) → **Reply strategy** → выберите
   **Smart** или **Alias**.

## Ограничения (v1)

- Каскад реагирует только на **сообщения пользователя**; сообщения персонажей его не запускают.
- Нет персонаж-персонаж авто-продолжения: заставить одного участника продолжить за другим без правки
  ядра SillyTavern невозможно, а ядро это расширение принципиально не патчит.
- Ядро SillyTavern **не патчится** — расширение только внедряет DOM-элементы и слушает события.
- Тихий запрос отправляет недавний контекст чата в текущий активный API — учитывайте приватность
  и расход токенов.

## Совместимость

Собрано и проверено для **SillyTavern 1.19.0+**. Чистые ES-модули, без сборки, без npm-зависимостей.