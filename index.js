// st-gc-modes — SillyTavern third-party UI extension.
// Adds two extra group-reply modes to group chats:
//   4 = Smart — direct alias matching (level1), then one quiet director request (level2/level3), then a "(nobody)" note in chat (level4);
//   5 = Alias — pure alias-signal matching (level1) with no LLM request at all.
// ES2022, plain ES module, no build step, no npm dependencies.
// Core SillyTavern is never patched: the extension only injects DOM and listens to events.

import { eventSource, event_types, Generate, generateRaw, addOneMessage, chat, characters, name1, saveChatConditional, is_send_press, saveSettingsDebounced, this_chid, getRequestHeaders, getOneCharacter } from '../../../../script.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { groups, selected_group, editGroup, is_group_generating } from '../../../group-chats.js';
import { getCurrentLocale } from '../../../i18n.js';
import { waitUntilCondition } from '../../../utils.js';
import { Fuse } from '../../../../lib.js';

// ---- constants ----

const MODULE_NAME = 'st-gc-modes';
const LOG_PREFIX = '[GCModes]';

// Group reply strategy values owned by this extension (core uses 0..3).
const STRATEGY_SMART = 4;
const STRATEGY_ALIAS = 5;

// Unicode-aware word tokenizer: a word starts with a letter and may continue with letters, marks,
// digits, apostrophes and hyphens. Works for Latin, Cyrillic and any other script.
const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'-]*/gu;

// Lowercased tokens that mean "no one" in a quiet-model reply (English + Russian).
const NONE_TOKENS = new Set(['none', 'no one', 'nobody', 'noone', 'нико', 'никто', 'никого', 'никем', 'никуда', 'никому']);

// Marker stored on message.extra for the level4 "nobody" note pushed by this extension.
const NOTE_FLAG = 'st_gc_modes_note';

// Bounds and delays (all timeouts in milliseconds).
const PROCESSED_LIMIT = 100;       // size of the dedupe FIFO for processed cascade keys
const CASCADE_DELAY = 50;          // defer so the core group wrapper finishes before any Generate call
const IDLE_WAIT_TIMEOUT = 15000;   // wait for the group to become idle before running a cascade
const IDLE_WAIT_INTERVAL = 100;
const MEMBER_IDLE_TIMEOUT = 60000; // wait for idle before each forced member reply
const MEMBER_IDLE_INTERVAL = 200;
const QUIET_RAW_LIMIT = 300;       // quietRaw kept in debug stats, truncated
const ANSWER_LEN_WARN = 400;       // warn (but still parse) above this answer length
const DESC_LIMIT = 200;            // description slice shown to the director prompt

// ---- i18n ----

// All user-visible strings. Chosen once per render via isRussianUI(); no live language switching.
const UI_TEXT = {
    en: {
        panelTitle: 'Smart / Alias group modes', panelInstructions: 'Smart: director instructions',
        panelDepth: 'Context depth {n} (last messages)', panelL2: 'Level 2: indirect address (by attribute)',
        panelL3: 'Level 3: who would join the conversation', panelNote: '"Nobody" note in chat',
        panelCeiling: 'Responders cap (default)', ceilingNone: 'none',
        groupCeilingLabel: 'Responders cap (this group)', groupCeilingDefault: '(default)', groupCeilingNone: 'none',
        unknownNamesToast: 'st-gc-modes: unknown name in reply: {names}',
        quietFailedToast: 'st-gc-modes: quiet request failed, skipping levels 2/3',
        noteNobody: '(Nobody joined the conversation.)',
        enabledLabel: 'Enabled', repoLink: 'Details in README',
        aliasPlaceholder: 'Kir, Kira-chan, baker',
        charAliasLabel: 'Name aliases', charAliasGenButton: 'Generate with LLM',
        charAliasInputTitle: 'Comma-separated forms of this name (nicknames, shortenings, forms of address). The full name is always checked too. Saved into the character card (data.extensions) and survives page reloads.',
        charAliasGenTitle: 'The model reads the character description and returns a list of alias forms (Russian and English where appropriate).',
        charAliasGenBusyToast: 'Generating aliases…',
        charAliasEmptyToast: 'st-gc-modes: the model returned an empty alias list',
        charAliasFailedToast: 'st-gc-modes: alias generation failed',
        charAliasGenUnavailable: 'Available after the character is created and saved: aliases live in the character card.',
        groupAliasWarning: 'Character aliases from the character card fields are used.',
        groupAliasMissing: 'No aliases: {names}',
        groupAliasAllSet: 'All members have aliases.',
        groupAliasFill: 'Fill with LLM',
        groupAliasFillTitle: 'For every member without aliases, the model reads their description and writes a generated alias list into their character card (saved immediately).',
        bulkProgressToast: 'Generating aliases: {current} of {total}…',
        bulkDoneToast: 'Aliases filled: {ok} of {total} members.',
        bulkMemberFailedToast: 'st-gc-modes: aliases for {name} failed — skipped',
        toggleOffToast: 'st-gc-modes disabled: Smart/Alias options hidden', toggleOnToast: 'st-gc-modes enabled',
        ttEnabled: 'Master switch. When off, the extension removes its Smart/Alias options and the per-group cap widget and stops reacting to messages; the panel itself stays available.',
        ttInstructions: 'System instructions for the quiet "director" LLM request used by Smart mode when no direct alias match. The model reads the participant list and the recent chat.',
        ttDepth: 'How many of the last chat messages the director request sees (1-50).',
        ttL2: 'Ask the quiet request who is addressed indirectly, by a sign from their description (profession, role, look) instead of their name.',
        ttL3: 'Ask the quiet request who would have their own reason to join the conversation right now.',
        ttNote: 'When Smart matches nobody, push a short user message into the chat so the silence is visible.',
        ttCeiling: 'Default limit on how many members one cascade may invoke (2-5; none = unlimited).',
        ttGroupCeiling: 'Per-group responders cap; it takes priority over the default value.',
        hintInstructions: 'Read by the quiet director request in Smart mode when signals do not match.',
        hintDepth: 'Recent messages the director sees.',
        hintCeiling: 'Max members answering one user message.',
    },
    ru: {
        panelTitle: 'Smart / Alias режимы группы', panelInstructions: 'Smart: инструкции режиссёра',
        panelDepth: 'Глубина контекста {n} (последние сообщения)', panelL2: 'Уровень 2: косвенный вызов (по признаку)',
        panelL3: 'Уровень 3: кто мог бы поддержать разговор', panelNote: 'Заметка „никто не откликнулся“ в чате',
        panelCeiling: 'Лимит отвечающих (по умолчанию)', ceilingNone: 'нет',
        groupCeilingLabel: 'Лимит отвечающих (группа)', groupCeilingDefault: '(по умолчанию)', groupCeilingNone: 'нет',
        unknownNamesToast: 'st-gc-modes: неизвестные имена в ответе: {names}',
        quietFailedToast: 'st-gc-modes: тихий запрос не удался, уровни 2/3 пропущены',
        noteNobody: '(Никто не вступил в разговор.)',
        enabledLabel: 'Включено', repoLink: 'Подробности — в README',
        aliasPlaceholder: 'Кир, Кирочка, печница',
        charAliasLabel: 'Заменители имени (алиасы)', charAliasGenButton: 'Сгенерировать через LLM',
        charAliasInputTitle: 'Формы имени через запятую (клички, сокращения, обращения). Само имя проверяется всегда. Хранится в карточке персонажа (data.extensions) и переживает перезагрузку страницы.',
        charAliasGenTitle: 'Модель читает описание персонажа и возвращает список форм имени (рус и англ, где уместно).',
        charAliasGenBusyToast: 'Генерирую алиасы…',
        charAliasEmptyToast: 'st-gc-modes: модель вернула пустой список алиасов',
        charAliasFailedToast: 'st-gc-modes: генерация алиасов не удалась',
        charAliasGenUnavailable: 'Доступно после создания и сохранения персонажа: алиасы живут в его карточке.',
        groupAliasWarning: 'Используются алиасы из полей персонажей.',
        groupAliasMissing: 'Без алиасов: {names}',
        groupAliasAllSet: 'Все участники имеют алиасы.',
        groupAliasFill: 'Заполнить через LLM',
        groupAliasFillTitle: 'Для каждого участника без алиасов модель читает его описание и записывает сгенерированный список алиасов в его карточку (сразу сохраняет).',
        bulkProgressToast: 'Генерирую алиасы: {current} из {total}…',
        bulkDoneToast: 'Алиасы заполнены: {ok} из {total} участников.',
        bulkMemberFailedToast: 'st-gc-modes: не удалось для {name} — пропущен',
        toggleOffToast: 'st-gc-modes выключен: пункты Smart/Alias скрыты', toggleOnToast: 'st-gc-modes включён',
        ttEnabled: 'Главный выключатель. Когда выключено, расширение убирает свои пункты Smart/Alias и виджет лимита группы и перестаёт реагировать на сообщения; сама панель остаётся доступной.',
        ttInstructions: 'Системные инструкции тихого «режиссёрского» запроса к LLM в режиме Smart, когда прямого совпадения по алиасам нет. Модель читает список участников и последние сообщения.',
        ttDepth: 'Сколько последних сообщений чата видит режиссёрский запрос (1-50).',
        ttL2: 'Спросить у тихого запроса, к кому обращаются косвенно — по признаку из описания (профессия, роль, внешность), а не по имени.',
        ttL3: 'Спросить у тихого запроса, у кого сейчас есть своя причина поддержать разговор.',
        ttNote: 'Если в Smart не совпал никто, отправить в чат короткое сообщение пользователя, чтобы тишина была заметна.',
        ttCeiling: 'Сколько участников максимум может вызвать один каскад по умолчанию (2-5; «нет» = без лимита).',
        ttGroupCeiling: 'Лимит отвечающих для этой группы; приоритет выше общего значения.',
        hintInstructions: 'Их читает тихий режиссёрский запрос в режиме Smart, когда сигналы не сработали.',
        hintDepth: 'Сколько последних сообщений видит режиссёр.',
        hintCeiling: 'Максимум участников на одно сообщение пользователя.',
    },
};

/** Tells whether the current UI locale is Russian. @returns {boolean} True when the locale string starts with "ru". */
function isRussianUI() {
    try {
        return String(getCurrentLocale()).toLowerCase().startsWith('ru');
    } catch {
        return false;
    }
}

/** Looks up a UI string for the active locale, falling back to English, then to the key itself.
 * @param {string} key Key inside UI_TEXT. @returns {string} Localized string. */
function localize(key) {
    const lang = isRussianUI() ? 'ru' : 'en';
    const table = UI_TEXT[lang] ?? UI_TEXT.en;
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    return Object.prototype.hasOwnProperty.call(UI_TEXT.en, key) ? UI_TEXT.en[key] : key;
}

// ---- settings ----

// Default instructions for the Smart "director" quiet request (level2/level3). Editable in the panel.
const DEFAULT_SMART_INSTRUCTIONS = [
    'You are the group-chat director choosing which characters join the conversation.',
    'You receive: participant list (name + short description), recent chat, and the last user message.',
    'Pick ONLY participants who would realistically respond:',
    '1. They were addressed by an indirect sign instead of their name (their profession, role, place, or a personal attribute from their description).',
    '2. They have their own motivation, reason, or duty to chime in right now.',
    'Do not pick anyone out of politeness. If several fit, list all. Answer format: participant names separated by commas, copied exactly as given in the list. If no one fits, answer exactly: none.',
].join('\n');

// Module settings: merged one level deep from defaults on init. aliasSignals is DEPRECATED (v1.2.0): kept only as
// a read-only fallback for group chats saved by v1.0/v1.1; new aliases live in
// character.data.extensions.st_gc_modes_aliases (written by the character editor field).
const DEFAULT_SETTINGS = {
    enabled: true,            // master switch: when false, injected UI is removed and hooks stop reacting
    smart_instructions: DEFAULT_SMART_INSTRUCTIONS,
    context_depth: 10,        // integer 1..50, how many last chat messages go into a quiet request
    level2Enabled: true,      // level2 (indirect address)
    level3Enabled: true,      // level3 (motivation to join)
    nobodyNote: true,         // level4 "(nobody)" note in chat
    ceiling: 2,               // default responders cap: 2 | 3 | 4 | 5 | 0 (= none/unlimited)
    aliasSignals: {},         // DEPRECATED (v1.2.0): kept as a read-only fallback; new aliases live in character.data.extensions.st_gc_modes_aliases
};

let settings = null;

/** Master switch guard used by every hook and injection path; the settings panel itself stays available when disabled.
 * @returns {boolean} True when the extension is enabled and may inject its UI and react to messages. */
function isEnabled() {
    return !!settings?.enabled;
}

/** Ensures extension_settings[MODULE_NAME] exists and merges missing default keys (one level deep, cloning object
 * defaults to avoid shared references), saving once when something was added.
 * @returns {object} The module settings object (live reference into extension_settings). */
function loadSettings() {
    if (typeof extension_settings[MODULE_NAME] !== 'object' || extension_settings[MODULE_NAME] === null || Array.isArray(extension_settings[MODULE_NAME])) {
        extension_settings[MODULE_NAME] = {};
    }
    const stored = extension_settings[MODULE_NAME];
    let added = false;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) continue;
        const value = DEFAULT_SETTINGS[key];
        stored[key] = (typeof value === 'object' && value !== null) ? structuredClone(value) : value;
        added = true;
    }
    if (added) saveSettingsDebounced();
    return stored;
}

/** Reads the context depth setting, clamped to the supported 1..50 range. @returns {number} Clamped context depth. */
function clampDepth() {
    const value = Math.round(Number(settings?.context_depth));
    if (!Number.isFinite(value)) return DEFAULT_SETTINGS.context_depth;
    return Math.min(50, Math.max(1, value));
}

// ---- utils ----

/** Tokenizes text into lowercase Unicode words (letters, marks, digits, apostrophes, hyphens).
 * @param {string} text Arbitrary input text. @returns {string[]} Lowercased word tokens. */
function tokenize(text) {
    return String(text ?? '').toLowerCase().match(WORD_RE) ?? [];
}

/** Collapses all whitespace runs into single spaces and trims the result.
 * @param {string} text Arbitrary input text. @returns {string} Whitespace-collapsed text. */
function collapseWhitespace(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Finds the index of a character in the global characters array by its avatar filename.
 * @param {string} avatar Avatar filename (e.g. "seraphina.png"). @returns {number} Index into characters, or -1 when not found. */
function findCharacterIndex(avatar) {
    if (typeof avatar !== 'string' || avatar.length === 0) return -1;
    return characters.findIndex(c => c?.avatar === avatar);
}

/** Resolves a member's display name from its avatar filename.
 * @param {string} avatar Avatar filename. @returns {string} Character name, or the avatar string when the character is gone. */
function avatarToName(avatar) {
    const index = findCharacterIndex(avatar);
    if (index === -1) return String(avatar);
    return String(characters[index]?.name ?? avatar);
}

/** Splits a raw user-entered signal line into a clean list: split on ',;|', trim, drop empties and duplicates,
 * keep the original order. @param {string} text Comma-separated signal input. @returns {string[]} Clean signal strings. */
function parseSignalList(text) {
    const out = [];
    const seen = new Set();
    for (const piece of String(text ?? '').split(/[,;|]+/u)) {
        const trimmed = piece.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

// ---- state ----

// Queued { messageId, chatId, sendDate } items waiting for their cascade to run (FIFO, serialized).
const pendingCascades = [];
let cascadeScheduled = false; // a runner timeout is pending (or in its first tick)
let isCascadeActive = false;  // a cascade is currently awaiting inside runCascadeFor
const processedKeys = new Set(); // bounded FIFO Set of dedupe keys `${chatId}::${idx}::${send_date}`
let lastCascade = null;       // debug stats object of the most recent cascade run
let injectLogged = false;     // the single one-time "options injected" debug line
let removeLogged = false;     // the single one-time "options removed (disabled)" debug line
let editorAliasesObserver = null; // the single MutationObserver switching the editor alias field between edit/create modes
let editorAliasAnchorLogged = false; // the single one-time "editor alias block anchor missing" debug line
let editorAliasGenerateBusy = false; // an editor alias generation request is currently in flight
let bulkAliasFillBusy = false; // a bulk "Fill with LLM" run over the group alias widget is currently in flight
const cascadeStats = { messagesSeen: 0, cascadesRun: 0, level1Hits: 0, quietCalls: 0, generationsPushed: 0, notes: 0 };

// ---- group helpers ----

/** Finds the currently open group; selected_group is normally a string id but the comparison stays tolerant.
 * @returns {object|null} The active group object, or null when no group is open. */
function getActiveGroup() {
    if (!selected_group) return null;
    return groups.find(g => typeof selected_group === 'string' ? String(g.id) === selected_group : g.id === selected_group) ?? null;
}

/** Reads the reply strategy value of the active group for the debug hook.
 * @returns {number|null} Strategy number, or null when no group is open. */
function activeGroupStrategy() {
    const group = getActiveGroup();
    if (!group) return null;
    const strategy = Number(group.activation_strategy);
    return Number.isFinite(strategy) ? strategy : null;
}

/** Ensures the group object has the custom st_gc_modes field used for per-group overrides; it persists server-side
 * because /api/groups/edit writes the whole group object.
 * @param {object} group Active group object. @returns {object} The (existing or newly created) st_gc_modes object. */
function ensureStGcModes(group) {
    if (!group) return null;
    if (typeof group.st_gc_modes !== 'object' || group.st_gc_modes === null) group.st_gc_modes = {};
    return group.st_gc_modes;
}

const CEILING_VALUES = new Set([0, 2, 3, 4, 5]);

/** Effective responders cap: the per-group override when it is an allowed value, otherwise the module default
 * (also clamped); 0 means unlimited. @param {object|null} group Active group object (may be null). @returns {number} Cap value (0 = unlimited). */
function effectiveCeiling(group) {
    const stored = group?.st_gc_modes;
    if (stored && stored.ceiling !== null && CEILING_VALUES.has(Number(stored.ceiling))) return Number(stored.ceiling);
    const fallback = Number(settings?.ceiling);
    return CEILING_VALUES.has(fallback) ? fallback : DEFAULT_SETTINGS.ceiling;
}

/** Applies the responders cap to a matched avatar list, preserving order; logs the trimmed names when somebody gets cut.
 * @param {string[]} avatars Matched member avatar filenames (group member order). @param {object} group Active group object.
 * @returns {string[]} Trimmed list (same array when no trimming happened). */
function applyCeiling(avatars, group) {
    if (!Array.isArray(avatars) || avatars.length === 0) return [];
    const ceiling = effectiveCeiling(group);
    if (!(ceiling > 0) || avatars.length <= ceiling) return avatars;
    const trimmedNames = avatars.slice(ceiling).map(avatarToName);
    if (lastCascade) lastCascade.trimmedByCeiling = trimmedNames;
    console.log(LOG_PREFIX, `ceiling ${ceiling} trimmed [${trimmedNames.join(', ')}]`);
    return avatars.slice(0, ceiling);
}

/** Members of a group that are currently enabled (not muted) in group member order.
 * @param {object} group Active group object. @returns {string[]} Enabled member avatar filenames. */
function enabledMembersOf(group) {
    const members = Array.isArray(group?.members) ? group.members : [];
    const disabled = new Set(Array.isArray(group?.disabled_members) ? group.disabled_members : []);
    return members.filter(avatar => !disabled.has(avatar));
}

// ---- alias signals ----

/** Alias signals of a member: the character card (data.extensions.st_gc_modes_aliases, written by the editor
 * field) is the source of truth — its comma string split through parseSignalList, and whenever that yields a
 * non-empty (trimmed/deduped) list the card wins and the legacy storage is never read; otherwise the legacy
 * per-avatar array from the v1.0/v1.1 settings storage is returned as a read-only fallback (DEPRECATED in v1.2.0,
 * kept so existing group chats keep working). Null when neither source has anything.
 * @param {string} avatar Avatar filename. @param {string} _name Character name (unused, kept for signature clarity:
 * the card is keyed by character, not by name).
 * @returns {string[]|null} Card or legacy signals, or null when no entry exists. */
function memberSignals(avatar, _name) {
    // 1) Character card (v1.2.0 source of truth); readCardAliases tolerates a missing character (returns '').
    const fromCard = parseSignalList(readCardAliases(characters[findCharacterIndex(avatar)]));
    if (fromCard.length > 0) return fromCard;
    // 2) Legacy fallback (DEPRECATED v1.2.0): read-only per-avatar array from the v1.0/v1.1 settings storage.
    const entry = settings?.aliasSignals?.[avatar];
    if (Array.isArray(entry) && entry.length > 0) return entry;
    // 3) Neither source has anything.
    return null;
}

/** Whether a member already has usable alias signals: memberSignals folds the card-first source and the legacy
 * fallback into a single call, so a non-empty result is enough.
 * @param {string} avatar Avatar filename. @returns {boolean} True when the member resolves at least one signal. */
function memberHasAliases(avatar) {
    const signals = memberSignals(avatar, '');
    return Array.isArray(signals) && signals.length > 0;
}

/** Enabled members of the group that have no aliases at all, in enabledMembersOf order; members whose character no
 * longer exists are skipped silently (nothing can generate for them).
 * @param {object|null} group Active group object (may be null). @returns {string[]} Avatar filenames without aliases. */
function membersWithoutAliases(group) {
    return enabledMembersOf(group).filter(avatar => findCharacterIndex(avatar) !== -1 && !memberHasAliases(avatar));
}

/** Effective signal list for level1 (direct/alias matching): the alias table entry unioned with the character's full
 * name, which is always checked implicitly. Deduplicated case-insensitively.
 * @param {string} avatar Avatar filename. @param {string} name Character name.
 * @returns {string[]} Signals (may be single- or multi-word strings). */
function effectiveSignals(avatar, name) {
    const out = [];
    const seen = new Set();
    const add = (signal) => {
        const key = String(signal).toLowerCase();
        if (key.length > 0 && !seen.has(key)) {
            seen.add(key);
            out.push(String(signal));
        }
    };
    const table = memberSignals(avatar, name);
    if (Array.isArray(table)) {
        for (const signal of table) {
            if (typeof signal === 'string') add(signal);
        }
    }
    if (typeof name === 'string') add(name);
    return out;
}

/** Whether any of the member's signals matches the message token set: single-word signals require exact token
 * equality, multi-word signals require ALL of their tokens to be present (unordered).
 * @param {Set<string>} tokenSet Lowercased message tokens. @param {string[]} signals Full name + table signals.
 * @returns {boolean} True when at least one signal matched. */
function memberSignalsMatch(tokenSet, signals) {
    for (const signal of signals) {
        const signalTokens = tokenize(signal);
        if (signalTokens.length === 0) continue;
        if (signalTokens.length === 1) {
            if (tokenSet.has(signalTokens[0])) return true;
        } else if (signalTokens.every(token => tokenSet.has(token))) {
            return true;
        }
    }
    return false;
}

// ---- level 1 (direct/alias matching) ----

/** level1: members whose name or alias signals appear in the user message, in group member order.
 * @param {string} inputText Raw user message text. @param {string[]} memberList Enabled member avatar filenames.
 * @returns {string[]} Matched member avatar filenames. */
function level1Matches(inputText, memberList) {
    const tokenSet = new Set(tokenize(inputText));
    if (tokenSet.size === 0) return [];
    const matched = [];
    for (const avatar of memberList) {
        const index = findCharacterIndex(avatar);
        if (index === -1) continue;
        const signals = effectiveSignals(avatar, String(characters[index]?.name ?? ''));
        if (signals.length > 0 && memberSignalsMatch(tokenSet, signals)) matched.push(avatar);
    }
    return matched;
}

// ---- quiet request (level2/level3 smart part) ----

/** Builds the two-sentence closing question for the director prompt depending on enabled levels.
 * @returns {string} The Question: line content. */
function buildQuietQuestion() {
    const l2 = !!settings.level2Enabled;
    const l3 = !!settings.level3Enabled;
    if (l2 && l3) {
        return 'Which of the participants should respond to the LAST message according to the enabled criteria? Answer only with participant names copied exactly from the list, separated by commas, or reply none if nobody fits.';
    }
    if (l2) {
        return 'Which of the participants is addressed in the LAST message by an indirect sign instead of their name? Answer only with participant names copied exactly from the list, separated by commas, or reply none if nobody fits.';
    }
    return 'Which of the participants has their own motivation or duty to chime in after the LAST message? Answer only with participant names copied exactly from the list, separated by commas, or reply none if nobody fits.';
}

/** Builds the single-string director prompt: instructions, optional single-criterion line, participant list
 * (name, aka signals, collapsed description), recent chat transcript and the question.
 * @param {string} inputText Raw user message text. @param {string[]} memberList Enabled member avatar filenames.
 * @returns {string} Prompt text. */
function buildQuietPrompt(inputText, memberList) {
    const blocks = [];
    blocks.push(String(settings.smart_instructions ?? ''));

    const l2 = !!settings.level2Enabled;
    const l3 = !!settings.level3Enabled;
    if (l2 && !l3) {
        blocks.push('Apply ONLY criterion 2 (indirect address) and ignore criterion 3.');
    } else if (!l2 && l3) {
        blocks.push('Apply ONLY criterion 3 (their own motivation to chime in) and ignore criterion 2.');
    }

    const participantLines = [];
    for (const avatar of memberList) {
        const index = findCharacterIndex(avatar);
        if (index === -1) {
            continue;
        }
        const memberName = String(characters[index]?.name ?? '');
        const signals = (memberSignals(avatar, memberName) ?? []).filter(signal => typeof signal === 'string' && signal.trim().length > 0);
        const description = collapseWhitespace(String(characters[index]?.description ?? '')).slice(0, DESC_LIMIT) || '(no description)';
        let line = `- Name: ${memberName}`;
        if (signals.length > 0) {
            line += ` (aka: ${signals.join(', ')})`;
        }
        line += ` — description: ${description}`;
        participantLines.push(line);
    }
    blocks.push(['Participants:', ...participantLines].join('\n'));

    const depth = clampDepth();
    const transcript = [];
    const recent = chat.filter(item => item && item.is_system !== true).slice(-depth);
    for (const item of recent) {
        let senderName;
        if (item.is_user) {
            senderName = String(item.name || name1);
        } else {
            const cid = Number(item.character_id ?? item.force_chid ?? Number.NaN);
            senderName = String(item.name || (Number.isInteger(cid) ? characters[cid]?.name : undefined) || '?');
        }
        transcript.push(`${senderName}: ${String(item.mes ?? '')}`);
    }
    blocks.push([`Recent chat (oldest first, last ${depth} messages):`, ...transcript].join('\n'));

    blocks.push(`Question: ${buildQuietQuestion()}`);
    return blocks.join('\n\n');
}

/** Runs ONE quiet (raw) LLM request implementing the level2/level3 checks for Smart mode: generateRaw goes to the active
 * API without a preset. Failures and empty answers are treated as "nobody" inputs downstream, never thrown.
 * @param {string} inputText Raw user message text. @param {string[]} memberList Enabled member avatar filenames.
 * @returns {Promise<string>} Trimmed model answer (may be empty). */
async function quietLevelRequest(inputText, memberList) {
    if (lastCascade) lastCascade.quietCalls += 1;
    cascadeStats.quietCalls += 1;
    console.log(LOG_PREFIX, `quiet request: start (${memberList.length} participants)`);

    const prompt = buildQuietPrompt(inputText, memberList);
    let answer = '';
    try {
        answer = await generateRaw({ prompt, systemPrompt: '' });
    } catch (err) {
        console.error(LOG_PREFIX, 'quiet request failed', err);
        if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') toastr.error(localize('quietFailedToast'), 'st-gc-modes');
        return '';
    }

    const trimmed = String(answer ?? '').trim();
    if (trimmed.length === 0) {
        console.log(LOG_PREFIX, 'quiet request returned empty content (reasoning model?)');
        return '';
    }
    if (trimmed.length > ANSWER_LEN_WARN) {
        console.log(LOG_PREFIX, `quiet answer longer than ${ANSWER_LEN_WARN} chars (${trimmed.length}), parsing the first usable tokens anyway`);
    }
    if (lastCascade) lastCascade.quietRaw = trimmed.slice(0, QUIET_RAW_LIMIT);
    return trimmed;
}

// ---- character-card aliases (editor + bulk fill) ----

// Shared instruction block for the quiet alias-generation request (editor generate button; reused by the bulk fill later).
const ALIASES_PROMPT_INSTRUCTIONS = [
    'Read the character description below.',
    'Produce a list of name aliases: forms of address, shortenings, nicknames, diminutives,',
    'and well-known alternative forms of the name (Russian and English variants where appropriate).',
    'Answer with a single line of comma-separated items only. No explanations, no numbering, no quotes.',
    'Between 2 and 8 items. Never include the exact full name itself.',
];

/** Builds the alias-generation prompt for one character: the shared instruction lines plus two final lines carrying
 * the character name and its description; when data.description is empty the collapsed personality and scenario
 * fields are used instead, and null is returned when there is nothing readable at all (caller shows the failed toast).
 * @param {object} ch Character object (may be sparse). @returns {string|null} Raw generateRaw prompt text, or null. */
function buildAliasPrompt(ch) {
    let text = collapseWhitespace(ch?.data?.description);
    if (text.length === 0) {
        const personality = collapseWhitespace(ch?.data?.personality ?? ch?.personality);
        const scenario = collapseWhitespace(ch?.data?.scenario ?? ch?.scenario);
        text = [personality, scenario].filter(part => part.length > 0).join(': ');
    }
    if (text.length === 0) return null;
    return [...ALIASES_PROMPT_INSTRUCTIONS, `Character name: ${ch?.name}`, `Description: ${text}`].join('\n');
}

/** Parses a raw alias-generation answer into a clean list: split on commas/semicolons/newlines/pipes, trim, drop
 * empties, drop duplicates case-insensitively (parseSignalList dedupes case-sensitively; this parser is stricter),
 * drop any item equal to the
 * character name case-insensitively, cap at 8 items (a stricter, case-insensitive variant of parseSignalList).
 * @param {string} answer Raw model answer. @param {string} name Character full name to exclude.
 * @returns {string[]} Up to 8 cleaned alias strings, original order. */
function parseAliasAnswer(answer, name) {
    const out = [];
    const seen = new Set();
    const nameLower = String(name ?? '').trim().toLowerCase();
    for (const piece of String(answer ?? '').split(/[,;\n\r;|]+/u)) {
        const trimmed = piece.trim();
        if (trimmed.length === 0) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        if (nameLower.length > 0 && key === nameLower) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out.slice(0, 8);
}

/** Reads the alias comma-string stored in a character card (data.extensions.st_gc_modes_aliases).
 * @param {object} ch Character object (may be null). @returns {string} The stored comma string, or '' when absent. */
function readCardAliases(ch) {
    return String(ch?.data?.extensions?.st_gc_modes_aliases ?? '');
}

/** Resolves the character the editor currently works on: this_chid (Number()-ed, it may arrive as a string) while
 * the form is in edit mode, else null.
 * @returns {number|null} Index into characters, or null outside edit mode / without a valid id. */
function getEditorChid() {
    if ($('#form_create').attr('actiontype') !== 'editcharacter') return null;
    if (this_chid === null || typeof this_chid === 'undefined') return null; // Number(null) would lie as 0
    const chid = Number(this_chid);
    return Number.isInteger(chid) ? chid : null;
}

/** Idempotently injects the character-editor alias widgets: the hidden extensions carrier input on #form_create
 * (its JSON value is deep-merged into char.data.extensions by the server on save), the visible block (label + text
 * field + LLM generate button) after the creator-notes row, one MutationObserver switching edit/create handling on
 * the persistent form, and the input/change/click wiring. Reruns are no-ops; never throws. */
function ensureEditorAliasesField() {
    try {
        const form = $('#form_create');
        if (form.length === 0) return; // Page not loaded yet; retried by init and every context event.
        // Hidden carrier: must always exist on the form (even without the visible block), so it is created first.
        if ($('#stgcmodes_char_extensions').length === 0) {
            form.append($('<input>').attr({ id: 'stgcmodes_char_extensions', type: 'hidden' }));
        }
        // One observer on the persistent form: core flips actiontype between editcharacter/createcharacter.
        if (editorAliasesObserver === null) {
            editorAliasesObserver = new MutationObserver(() => {
                try {
                    syncEditorAliasesMode();
                } catch (err) {
                    console.error(LOG_PREFIX, 'editor alias mode observer failed:', err);
                }
            });
            editorAliasesObserver.observe(form.get(0), { attributes: true, attributeFilter: ['actiontype'] });
        }
        if ($('#stgcmodes_char_aliases').length > 0) return; // Already injected (idempotent re-entry).
        const block = $('<div>').attr('id', 'stgcmodes_char_alias_block').addClass('flex1');
        const label = $('<label>').attr({ for: 'stgcmodes_char_aliases', title: localize('charAliasInputTitle') });
        label.append($('<span>').text(localize('charAliasLabel')));
        const row = $('<div>').addClass('flex-container flexnowrap');
        const input = $('<input>').attr({ id: 'stgcmodes_char_aliases', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: localize('aliasPlaceholder') }).addClass('text_pole flex1');
        const genButton = $('<div>').attr({ id: 'stgcmodes_char_alias_gen', title: localize('charAliasGenTitle') }).addClass('menu_button');
        genButton.append($('<i>').addClass('fa-solid fa-wand-magic-sparkles'));
        genButton.append($('<span>').text(localize('charAliasGenButton')));
        row.append(input).append(genButton);
        block.append(label).append(row);
        const anchor = $('#creator_notes_textarea').closest('div.flex-container.flexnowrap');
        if (anchor.length > 0) {
            anchor.after(block);
        } else {
            // Layout anchor missing: keep the field functional by appending it to the form; log this once.
            form.append(block);
            if (!editorAliasAnchorLogged) {
                editorAliasAnchorLogged = true;
                console.log(LOG_PREFIX, 'editor alias block: creator notes anchor missing, appended to the form');
            }
        }
        input.on('input', syncEditorAliasesHiddenOnly).on('change', syncEditorAliasesFromInput);
        genButton.on('click', onEditorAliasGenerate);
        syncEditorAliasesMode();
        console.log(LOG_PREFIX, 'editor alias field injected into the character form');
    } catch (err) {
        console.error(LOG_PREFIX, 'editor alias field injection failed:', err);
    }
}

/** input-event variant of the editor sync: mirrors the typed text into the hidden extensions carrier WITHOUT
 * rewriting the visible field — rewriting mid-typing would jump the caret and eat trailing commas/spaces; the visible
 * value normalization happens on change (blur) via syncEditorAliasesFromInput instead. */
function syncEditorAliasesHiddenOnly() {
    try {
        const field = $('#stgcmodes_char_aliases');
        if (field.length === 0) return;
        setHiddenExtensions(parseSignalList(String(field.val() ?? '')).join(', '));
    } catch (err) {
        console.error(LOG_PREFIX, 'editor alias hidden sync failed:', err);
    }
}

/** Normalizes the editor alias text field (parseSignalList joined with ', '), writes the normalized value back into
 * the field only when it differs (no caret jumps while typing) and mirrors the result into the hidden extensions
 * carrier so the next form save submits a fresh st_gc_modes_aliases value. */
function syncEditorAliasesFromInput() {
    try {
        const field = $('#stgcmodes_char_aliases');
        if (field.length === 0) return;
        const raw = String(field.val() ?? '');
        const normalized = parseSignalList(raw).join(', ');
        if (raw !== normalized) field.val(normalized);
        setHiddenExtensions(normalized);
    } catch (err) {
        console.error(LOG_PREFIX, 'editor alias field sync failed:', err);
    }
}

/** Writes the value the next form save will submit as the extensions body field: a JSON object with the
 * st_gc_modes_aliases key only (the server deep-merges it into char.data.extensions). The key is written even when
 * the string is empty, so clearing the field erases a previously stored list.
 * @param {string} aliasString Comma-separated alias string (may be empty). */
function setHiddenExtensions(aliasString) {
    $('#stgcmodes_char_extensions').val(JSON.stringify({ st_gc_modes_aliases: String(aliasString ?? '') }));
}

/** Applies the current editor mode to the alias widgets. Edit mode: the hidden carrier gets name="extensions" (so
 * FormData submits it), the field is populated from the currently loaded card and the generate button enabled state
 * follows the master switch. Create mode: the name attribute is REMOVED (core appends its own extensions field in
 * create mode and a duplicate would break the server parse), the field is cleared and the button stays disabled
 * with an explanatory title.
 * This is the FULL sync, so its call sites are deliberately limited to the moments the mode itself flips or the card
 * behind the form was swapped: the MutationObserver callback, onCharacterEditorOpened and the initial sync at the end
 * of ensureEditorAliasesField. Everywhere else use the half-syncs: syncEditorAliasesButtonState (button + carrier
 * name attribute only) and refreshEditorAliasesFromCard (field + carrier populated from the card only). */
function syncEditorAliasesMode() {
    const field = $('#stgcmodes_char_aliases');
    const genButton = $('#stgcmodes_char_alias_gen');
    if ($('#form_create').attr('actiontype') === 'editcharacter') {
        $('#stgcmodes_char_extensions').attr('name', 'extensions');
        const chid = getEditorChid();
        const card = Number.isInteger(chid) ? characters[chid] : null;
        const aliases = readCardAliases(card);
        if (field.length > 0 && String(field.val() ?? '') !== aliases) field.val(aliases);
        setHiddenExtensions(aliases); // re-init the hidden carrier from the card: an untouched save re-submits the stored list instead of an empty string
        genButton.prop('disabled', !isEnabled());
        genButton.attr('title', localize('charAliasGenTitle'));
    } else {
        $('#stgcmodes_char_extensions').removeAttr('name');
        if (field.length > 0 && String(field.val() ?? '') !== '') field.val('');
        setHiddenExtensions(''); // defensive: the name attribute is removed here, but a stale carrier value must not linger
        genButton.prop('disabled', true);
        genButton.attr('title', localize('charAliasGenUnavailable'));
    }
}

/** Population half of the mode sync: re-reads ONLY the aliases stored in the card behind the open editor form into
 * the visible field (written only when the value differs, so no caret jumps) and re-initializes the hidden carrier
 * from them via setHiddenExtensions (an untouched save re-submits the stored list instead of an empty string).
 * Used ONLY for genuine card changes — e.g. a member freshly saved from the bulk fill that is open in the editor at
 * that very moment; it no-ops outside edit mode ("nothing to populate") and, when an expected chid is passed,
 * whenever the editor is open on a different member. Never touches the generate button; for mere button/state
 * updates use syncEditorAliasesButtonState instead.
 * @param {number} [expectedChid] Index into characters the editor must currently work on for the refresh to apply. */
function refreshEditorAliasesFromCard(expectedChid) {
    try {
        const field = $('#stgcmodes_char_aliases');
        if ($('#form_create').attr('actiontype') !== 'editcharacter') return; // nothing to populate in create mode
        const chid = getEditorChid();
        if (expectedChid !== undefined && expectedChid !== chid) return; // editor is open on a different member
        const card = Number.isInteger(chid) ? characters[chid] : null;
        const aliases = readCardAliases(card);
        if (field.length > 0 && String(field.val() ?? '') !== aliases) field.val(aliases);
        setHiddenExtensions(aliases);
    } catch (err) {
        console.error(LOG_PREFIX, 'editor alias card refresh failed:', err);
    }
}

/** Button-state half of the mode sync: re-states ONLY the generate button disabled/title (plus, in edit mode, the
 * carrier's name="extensions" submit-ability) — never touches the visible field and never rewrites the carrier
 * VALUE, so it is safe to run at any moment (generate finally, master-switch change, context hooks) without wiping
 * fresh/unsaved input. Edit mode: name="extensions" is kept on the hidden carrier (idempotent) and the button
 * follows the master switch. Create mode: the name attribute removal stays a mode-change concern — it is cleared
 * only when actually present (checked via the attribute so it can persist being absent; the removeAttr call itself
 * is harmless but must not re-clear the field) and the button stays disabled with an explanatory title. */
function syncEditorAliasesButtonState() {
    try {
        const genButton = $('#stgcmodes_char_alias_gen');
        if ($('#form_create').attr('actiontype') === 'editcharacter') {
            $('#stgcmodes_char_extensions').attr('name', 'extensions'); // idempotent: FormData must submit the carrier
            genButton.prop('disabled', !isEnabled());
            genButton.attr('title', localize('charAliasGenTitle'));
        } else {
            if ($('#stgcmodes_char_extensions').attr('name') !== undefined) {
                $('#stgcmodes_char_extensions').removeAttr('name'); // mode-change concern: clear only when present, the attribute must persist being absent
            }
            genButton.prop('disabled', true);
            genButton.attr('title', localize('charAliasGenUnavailable'));
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'editor alias button sync failed:', err);
    }
}

/** Click handler for the editor "Generate with LLM" alias button: one quiet generateRaw request over the character
 * card text, parsed into the field (which syncs the hidden carrier through the same change path as manual editing).
 * Gated by the master switch, edit mode and the busy flag (no parallel runs); every failure stays a toast and the
 * button is restored in finally — nothing thrown reaches the editor.
 * @returns {Promise<void>} Resolves once the run finished. */
async function onEditorAliasGenerate() {
    if (!isEnabled()) return;
    if ($('#form_create').attr('actiontype') !== 'editcharacter') return; // Button is disabled in create mode anyway.
    if (editorAliasGenerateBusy) return;
    const chid = getEditorChid();
    const capturedChid = chid;
    const ch = Number.isInteger(chid) ? characters[chid] : null;
    if (!ch) {
        if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') toastr.error(localize('charAliasFailedToast'), MODULE_NAME);
        return;
    }
    editorAliasGenerateBusy = true;
    try {
        if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') toastr.info(localize('charAliasGenBusyToast'), MODULE_NAME);
        $('#stgcmodes_char_alias_gen').prop('disabled', true);
        const prompt = buildAliasPrompt(ch);
        if (prompt === null) {
            console.log(LOG_PREFIX, 'editor alias generation skipped: nothing readable in the character card');
            if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') toastr.error(localize('charAliasFailedToast'), MODULE_NAME);
            return;
        }
        let answer = '';
        try {
            answer = await generateRaw({ prompt, systemPrompt: '' });
        } catch (err) {
            console.error(LOG_PREFIX, 'editor alias generation failed:', err);
            if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') toastr.error(localize('charAliasFailedToast'), MODULE_NAME);
            return;
        }
        const aliases = parseAliasAnswer(answer, ch?.name);
        if (aliases.length === 0) {
            // Empty answer: keep the field untouched, tell the user.
            if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') toastr.info(localize('charAliasEmptyToast'), MODULE_NAME);
            return;
        }
        if (getEditorChid() !== capturedChid) {
            // The user switched editor targets mid-flight: discard the answer without touching any field.
            console.log(LOG_PREFIX, 'editor alias generation discarded: editor target changed');
            return;
        }
        $('#stgcmodes_char_aliases').val(aliases.join(', ')).trigger('change');
        console.log(LOG_PREFIX, `editor aliases generated: ${aliases.length} items`);
    } finally {
        editorAliasGenerateBusy = false;
        syncEditorAliasesButtonState(); // restore in finally: re-states the button disabled/title per the current mode and master switch WITHOUT re-reading the card — that would wipe the answer just written into the field
    }
}

/** CHARACTER_EDITOR_OPENED handler: core fires it at the end of the editor populate function, so the card behind
 * this_chid is fully loaded and the alias field can be synced to it. */
function onCharacterEditorOpened() {
    try {
        syncEditorAliasesMode();
    } catch (err) {
        console.error(LOG_PREFIX, 'character editor opened handling failed:', err);
    }
}

// ---- programmatic character save ----

/** Builds the FULL form-like FormData payload for /api/characters/edit, mirroring the core save form field by field:
 * charaFormatData REBUILDS the card from these body fields (missing standard fields become empty and char.chat /
 * char.create_date are explicitly overwritten from the body), so every standard field must ride along; v2 data
 * fields are authoritative over any legacy top-level duplicates and character_book survives through json_data.
 * extensions is a SHALLOW copy of ch.data.extensions with the st_gc_modes_aliases key set to aliasString — shallow
 * so the existing payload keys (depth_prompt, world, fav, talkativeness, character_book) ride along unchanged and
 * stay authoritative; the server JSON.parses the value and deep-merges it into char.data.extensions.
 * @param {number} chid Index into characters of the character to save. @param {string} aliasString Comma-separated alias string to write.
 * @returns {FormData} The ready-to-submit request body. */
function buildCharacterEditPayload(chid, aliasString) {
    const ch = characters[chid];
    const data = ch?.data ?? null;
    const ext = data?.extensions ?? null;
    const formData = new FormData();
    formData.append('avatar_url', String(ch?.avatar ?? ''));
    formData.append('ch_name', String(ch?.name ?? ''));
    formData.append('description', String(data?.description ?? ch?.description ?? ''));
    formData.append('personality', String(data?.personality ?? ch?.personality ?? ''));
    formData.append('scenario', String(data?.scenario ?? ch?.scenario ?? ''));
    formData.append('first_mes', String(data?.first_mes ?? ch?.first_mes ?? ''));
    formData.append('mes_example', String(data?.mes_example ?? ch?.mes_example ?? ''));
    formData.append('creator_notes', String(data?.creator_notes ?? ''));
    formData.append('system_prompt', String(data?.system_prompt ?? ''));
    formData.append('post_history_instructions', String(data?.post_history_instructions ?? ''));
    formData.append('tags', Array.isArray(data?.tags) ? data.tags.join(', ') : '');
    formData.append('creator', String(data?.creator ?? ''));
    formData.append('character_version', String(data?.character_version ?? ''));
    formData.append('talkativeness', String(ext?.talkativeness ?? ch?.talkativeness ?? 0.5));
    formData.append('fav', String(ext?.fav === true || ch?.fav === true || ch?.fav === 'true'));
    formData.append('world', String(ext?.world ?? ''));
    formData.append('depth_prompt_prompt', String(ext?.depth_prompt?.prompt ?? ''));
    formData.append('depth_prompt_depth', String(ext?.depth_prompt?.depth ?? 4));
    formData.append('depth_prompt_role', String(ext?.depth_prompt?.role ?? 'system'));
    formData.append('chat', String(ch?.chat ?? ''));
    formData.append('create_date', String(ch?.create_date ?? ''));
    formData.append('json_data', String(ch?.json_data ?? ''));
    const extensions = { ...(ext ?? {}), st_gc_modes_aliases: String(aliasString ?? '') };
    formData.append('extensions', JSON.stringify(extensions));
    const alternateGreetings = Array.isArray(data?.alternate_greetings) ? data.alternate_greetings : [];
    for (const greeting of alternateGreetings) {
        formData.append('alternate_greetings', String(greeting));
    }
    return formData;
}

/** Performs the programmatic alias save for one character: builds the full payload and performs ONE
 * /api/characters/edit request with the same headers factory the core save path uses, then refreshes the single
 * character in place via getOneCharacter — the same refresh the core save handler runs after every edit. The
 * avatar filename is captured BEFORE the fetch (the fetched result replaces characters[chid] in place, the avatar
 * itself does not change). Every failure is logged and reported as a boolean false; this function never throws.
 * @param {number} chid Index into characters of the character to save. @param {string} aliasString Comma-separated alias string to write.
 * @returns {Promise<boolean>} True on success, false on any failure. */
async function saveCharacterAliases(chid, aliasString) {
    try {
        const ch = characters[chid];
        if (!ch) throw new Error(`character #${chid} not found`);
        const avatarUrl = String(ch.avatar ?? ''); // captured BEFORE the fetch: getOneCharacter replaces characters[chid] in place
        const formData = buildCharacterEditPayload(chid, aliasString);
        const response = await fetch('/api/characters/edit', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await getOneCharacter(avatarUrl);
        return true;
    } catch (err) {
        console.error(LOG_PREFIX, 'character alias save failed:', err);
        return false;
    }
}

// ---- parsing the model answer ----

/** Parses the director reply into a chosen avatar list (in model order, deduped) and a list of unrecognized raw
 * tokens; "nobody" answers (NONE_TOKENS) collapse to an empty list.
 * @param {string} answer Raw model answer. @param {string[]} memberList Enabled member avatar filenames.
 * @returns {{chosen: string[], unknown: string[]}} Chosen avatars and unresolved tokens. */
function parseQuietAnswer(answer, memberList) {
    const chosen = [];
    const unknown = [];
    const rawParts = String(answer ?? '').split(/[,;\n\r]+/u).map(part => part.trim()).filter(part => part.length > 0);

    // Drop tokens that are themselves a NONE_TOKEN ("none", "никто", "no one", ...). Surrounding punctuation
    // and other non-letters are stripped first, so "None." or "None:" collapse to nobody too.
    const stripEdges = (part) => part.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, '');
    let tokens = rawParts.filter(part => !NONE_TOKENS.has(stripEdges(part).toLowerCase()));
    // When a single remaining token merely STARTS with a NONE_TOKEN word ("никто не подходит"), treat as nobody.
    if (tokens.length === 1) {
        const lower = tokens[0].toLowerCase();
        const startsWithNoneWord = Array.from(NONE_TOKENS).some(token => lower === token || (lower.startsWith(token) && (lower.charAt(token.length) === ' ' || lower.length === token.length)));
        if (startsWithNoneWord) tokens = [];
    }
    if (tokens.length === 0) return { chosen, unknown };

    // Exact-match index: lowercased name and lowercased table signals -> avatar.
    const exactIndex = new Map();
    const labels = [];
    for (const avatar of memberList) {
        const index = findCharacterIndex(avatar);
        if (index === -1) continue;
        const memberName = String(characters[index]?.name ?? '');
        if (memberName.length > 0) {
            exactIndex.set(memberName.toLowerCase(), avatar);
            labels.push({ label: memberName, avatar, name: memberName });
        }
        for (const signal of (memberSignals(avatar, memberName) ?? [])) {
            if (typeof signal === 'string' && signal.trim().length > 0) {
                exactIndex.set(signal.toLowerCase(), avatar);
                labels.push({ label: signal, avatar, name: memberName });
            }
        }
    }

    // One Fuse over the flat labels of all enabled members for fuzzy fallback.
    const fuse = new Fuse(labels, { keys: ['label'], ignoreLocation: true, threshold: 0.45, includeScore: true });
    const taken = new Set();
    for (const token of tokens) {
        let avatar = exactIndex.get(token.toLowerCase());
        if (!avatar && token.replace(/[^\p{L}\p{N}'-]/gu, '').length >= 4) {
            // Fuzzy fallback only for reasonably long tokens: short ones and 3-letter prefill stems
            // would fuzzy-match far too permissively.
            const hits = fuse.search(token);
            if (Array.isArray(hits) && hits.length > 0 && hits[0]?.item?.avatar) avatar = hits[0].item.avatar;
        }
        if (avatar) {
            if (!taken.has(avatar)) {
                taken.add(avatar);
                chosen.push(avatar);
            }
        } else {
            unknown.push(token);
        }
    }
    return { chosen, unknown };
}

// ---- nobody note (level4) ----

/** Pushes the localized "(nobody)" note into the chat as a user message flagged with extra[NOTE_FLAG].
 * addOneMessage does not emit USER_MESSAGE_RENDERED, so no cascade recursion happens; the flag and the exact-text
 * guard in the hook are defense in depth. */
async function pushNobodyNote() {
    const noteText = localize('noteNobody');
    const message = {
        name: name1,
        is_user: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: noteText,
        extra: { isSmallSys: false, [NOTE_FLAG]: true },
    };
    chat.push(message);
    addOneMessage(message);
    await saveChatConditional();
    cascadeStats.notes += 1;
    if (lastCascade) lastCascade.notePushed = true;
    console.log(LOG_PREFIX, 'nobody note pushed');
}

// ---- cascade runner ----

/** USER_MESSAGE_RENDERED handler. Returns immediately when the master switch is off; otherwise it validates the
 * rendered user message, then — never awaiting — queues a cascade item and schedules the detached runner. Nothing
 * here may await generation: while the core wrapper is still executing, is_group_generating is true and any nested
 * Generate call would be silently ignored.
 * @param {number} idx Chat array INDEX of the rendered message (not the message object). */
function onUserMessageRendered(idx) {
    try {
        if (!isEnabled()) return; // Master switch off: never react to messages.
        const message = chat[Number(idx)];
        if (!message) return;
        cascadeStats.messagesSeen += 1;
        if (message.is_user !== true || message.is_system !== false) return;
        if (message.extra?.[NOTE_FLAG]) return;
        if (String(message.mes ?? '') === localize('noteNobody')) return;
        const group = getActiveGroup();
        if (!group) return;
        const strategy = Number(group.activation_strategy);
        if (strategy !== STRATEGY_SMART && strategy !== STRATEGY_ALIAS) return;
        pendingCascades.push({ messageId: idx, chatId: String(getContext()?.chatId ?? ''), sendDate: String(message.send_date ?? '') });
        enqueueCascadeRunner();
        // Return immediately — the cascade runs detached.
    } catch (err) {
        console.error(LOG_PREFIX, 'user message hook failed:', err);
    }
}

/** Schedules the single cascade runner (detached setTimeout with CASCADE_DELAY, so the core group wrapper finishes
 * first); the while loop serializes cascades — a second queued user message waits for the first cascade to finish. */
function enqueueCascadeRunner() {
    if (cascadeScheduled) return;
    cascadeScheduled = true;
    setTimeout(async () => {
        try {
            while (pendingCascades.length > 0) {
                const item = pendingCascades.shift();
                isCascadeActive = true;
                try {
                    await runCascadeFor(item);
                } catch (err) {
                    console.error(LOG_PREFIX, 'cascade runner error:', err);
                } finally {
                    isCascadeActive = false;
                }
            }
        } finally {
            // The flag stays true for the whole drain, so a USER_MESSAGE_RENDERED arriving mid-loop cannot
            // schedule a second runner; re-arm synchronously when items arrived after the final check.
            cascadeScheduled = false;
            if (pendingCascades.length > 0) enqueueCascadeRunner();
        }
    }, CASCADE_DELAY);
}

/** Waits until the group is idle (no pending send and no running group wrapper); used before the cascade and again
 * before each sequential forced member reply.
 * @param {number} timeout Wait limit in milliseconds. @param {number} interval Poll interval in milliseconds.
 * @returns {Promise<boolean>} True when idle was confirmed, false on timeout. */
async function waitGroupIdle(timeout, interval) {
    try {
        await waitUntilCondition(() => !is_send_press && !is_group_generating, timeout, interval);
        return true;
    } catch {
        return false;
    }
}

/** Clears the send textarea exactly like the core /trigger pattern does, once per cascade before the first
 * invocation; silently skips when the textarea is missing (UI variants). */
function clearTextboxDefensively() {
    try {
        const textbox = $('#send_textarea');
        if (textbox.length > 0) textbox.val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
        // Non-fatal: the textarea may not exist in this UI variant.
    }
}

/** Runs the full cascade for one queued item: idle wait, master-switch re-check, re-validation, dedupe, level1
 * (direct/alias) matching, optional quiet request (level2/level3), level4 note and sequential forced member
 * invocation.
 * @param {{messageId: number|string, chatId: string, sendDate: string}} item Queued cascade item. */
async function runCascadeFor(item) {
    // 1) Wait until the group chat is idle (wrapper finished, nothing being sent).
    if (!(await waitGroupIdle(IDLE_WAIT_TIMEOUT, IDLE_WAIT_INTERVAL))) {
        console.warn(LOG_PREFIX, 'cascade dropped: group still busy (idle wait timeout)');
        return;
    }

    // 1b) Defense in depth: drop the cascade before any Generate/note side effects when the master switch is off.
    if (!isEnabled()) return;

    // 2) Re-validate the queued item against the current state; drop silently stale ones.
    const currentChatId = String(getContext()?.chatId ?? '');
    if (currentChatId !== item.chatId) {
        console.log(LOG_PREFIX, 'cascade dropped: chat changed since enqueue');
        return;
    }
    const group = getActiveGroup();
    if (!group) {
        console.log(LOG_PREFIX, 'cascade dropped: no active group');
        return;
    }
    const strategy = Number(group.activation_strategy);
    if (strategy !== STRATEGY_SMART && strategy !== STRATEGY_ALIAS) {
        console.log(LOG_PREFIX, 'cascade dropped: reply strategy changed');
        return;
    }
    const index = Number(item.messageId);
    const message = chat[index];
    if (!message || message.is_user !== true || String(message.send_date ?? '') !== String(item.sendDate ?? '')) {
        console.log(LOG_PREFIX, 'cascade dropped: queued message changed (stale or swipe)');
        return;
    }
    if (message.extra?.[NOTE_FLAG]) return;

    // 3) Cheap dedupe: mark processed (bounded FIFO Set keyed by chat, index and send date).
    const dedupeKey = `${currentChatId}::${index}::${String(message.send_date ?? '')}`;
    if (processedKeys.has(dedupeKey)) {
        console.log(LOG_PREFIX, 'cascade skipped: duplicate event for the same message');
        return;
    }
    processedKeys.add(dedupeKey);
    while (processedKeys.size > PROCESSED_LIMIT) processedKeys.delete(processedKeys.values().next().value);

    // 4) Debug stats object for this run.
    const mode = strategy === STRATEGY_ALIAS ? 'alias' : 'smart';
    const inputText = String(message.mes ?? '');
    lastCascade = {
        startedAt: Date.now(), finishedAt: null, mode: mode, input: inputText,
        level1HitNames: [], quietCalls: 0, quietRaw: '', parsedNames: [], unknownNames: [],
        chosenNames: [], trimmedByCeiling: [], notePushed: false, invocations: [], error: null,
    };
    cascadeStats.cascadesRun += 1;

    try {
        const members = enabledMembersOf(group);

        // level1 — direct signals.
        const level1 = level1Matches(inputText, members);
        lastCascade.level1HitNames = level1.map(avatarToName);

        if (mode === 'smart' && level1.length > 0) {
            // Smart fast path: direct match found, no quiet request at all.
            cascadeStats.level1Hits += 1;
            const chosen = applyCeiling(level1, group);
            lastCascade.chosenNames = chosen.map(avatarToName);
            console.log(LOG_PREFIX, 'level1 hit (no quiet request)');
            await invokeMembers(chosen, item);
            return;
        }

        if (mode === 'alias') {
            // Alias only has level1; empty means silence — never a note.
            if (level1.length > 0) {
                cascadeStats.level1Hits += 1;
                const chosen = applyCeiling(level1, group);
                lastCascade.chosenNames = chosen.map(avatarToName);
                console.log(LOG_PREFIX, `Alias: signals hit: ${lastCascade.level1HitNames.join(', ')}`);
                await invokeMembers(chosen, item);
            } else {
                console.log(LOG_PREFIX, 'Alias: no signals');
            }
            return;
        }

        // Smart, level1 empty: one quiet request covering the enabled levels, or nobody path.
        let parsed = { chosen: [], unknown: [] };
        if (settings.level2Enabled || settings.level3Enabled) {
            const answer = await quietLevelRequest(inputText, members);
            parsed = parseQuietAnswer(answer, members);
            lastCascade.parsedNames = parsed.chosen.map(avatarToName);
            lastCascade.unknownNames = parsed.unknown.slice();
            console.log(LOG_PREFIX, `quiet request: end, parsed: [${lastCascade.parsedNames.join(', ')}]`);
            if (parsed.unknown.length > 0) {
                const rawUnknownText = localize('unknownNamesToast').replace('{names}', parsed.unknown.join(', '));
                console.log(LOG_PREFIX, rawUnknownText);
                // toastr renders the message as HTML: strip HTML-special characters from model-derived
                // tokens before they are joined into the toast text.
                const safeNames = parsed.unknown.map(token => String(token).replace(/[<>&"'\u0060]/g, '')).join(', ');
                const unknownText = localize('unknownNamesToast').replace('{names}', () => safeNames);
                if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') toastr.info(unknownText, 'st-gc-modes');
            }
        }

        const chosen = applyCeiling(parsed.chosen, group);
        lastCascade.chosenNames = chosen.map(avatarToName);
        if (chosen.length === 0) {
            // Nobody path: Smart mode only, honor the level4 setting.
            if (settings.nobodyNote) {
                await pushNobodyNote();
            } else {
                console.log(LOG_PREFIX, 'nobody matched: staying silent (level4 note is disabled)');
            }
            return;
        }
        await invokeMembers(chosen, item);
    } catch (err) {
        lastCascade.error = String(err?.message ?? err);
        console.error(LOG_PREFIX, 'cascade failed:', err);
    } finally {
        lastCascade.finishedAt = Date.now();
    }
}

// ---- invocation ----

/** Triggers the chosen members sequentially with the /trigger pattern (Generate('normal') with force_chid), one
 * member at a time as the core queue requires; aborts the loop when the chat changed or the strategy is no longer
 * Smart/Alias.
 * @param {string[]} chosen Member avatar filenames to invoke. @param {{chatId: string}} item Originating cascade item (for context checks). */
async function invokeMembers(chosen, item) {
    if (!Array.isArray(chosen) || chosen.length === 0) return;
    // Defensive textarea clear exactly once, before the FIRST invocation (like /trigger).
    clearTextboxDefensively();
    for (const avatar of chosen) {
        // Abort when the chat changed or the strategy no longer applies.
        if (String(getContext()?.chatId ?? '') !== item.chatId) {
            console.log(LOG_PREFIX, 'invocation stopped: chat changed');
            break;
        }
        const group = getActiveGroup();
        const strategy = group ? Number(group.activation_strategy) : Number.NaN;
        if (strategy !== STRATEGY_SMART && strategy !== STRATEGY_ALIAS) {
            console.log(LOG_PREFIX, 'invocation stopped: reply strategy changed');
            break;
        }
        const chid = findCharacterIndex(avatar);
        if (chid === -1) {
            console.log(LOG_PREFIX, `invocation skipped: character for avatar ${avatar} not found`);
            continue;
        }
        await invokeMember(chid);
    }
}

/** Invokes a single group member: waits for idle, then forces its reply via Generate; every failure is logged and
 * swallowed so the next member still gets its turn.
 * @param {number} chid Character index (into characters) of the member to invoke. */
async function invokeMember(chid) {
    const memberName = String(characters[chid]?.name ?? 'unknown');
    const invocationEntry = { name: memberName, ok: false };
    if (!(await waitGroupIdle(MEMBER_IDLE_TIMEOUT, MEMBER_IDLE_INTERVAL))) {
        console.warn(LOG_PREFIX, `idle wait timed out before invoking ${memberName}`);
        invocationEntry.error = 'idle wait timeout';
        if (lastCascade) lastCascade.invocations.push(invocationEntry);
        return;
    }
    try {
        await Generate('normal', { force_chid: chid });
        cascadeStats.generationsPushed += 1;
        invocationEntry.ok = true;
    } catch (err) {
        console.error(LOG_PREFIX, `generation for ${memberName} failed:`, err);
        invocationEntry.error = String(err?.message ?? err);
    }
    if (lastCascade) lastCascade.invocations.push(invocationEntry);
}

// ---- injection (strategy options + per-group ceiling widget) ----

/** Idempotently injects the Smart/Alias options into the group reply strategy select, installs the per-group
 * responders-cap widget and the group alias warning widget right after the strategy select's flex container, and
 * syncs all injected widgets. When the master switch is off, it removes
 * the previously injected DOM instead of injecting. Runs cheaply on every context hook and retries automatically
 * when the DOM is not ready yet; never throws. */
function injectStrategyOptions() {
    let injected = false;
    try {
        if (settings && !isEnabled()) {
            removeInjected();
            return;
        }
        const select = $('#rm_group_activation_strategy');
        if (select.length === 0) return; // Page not loaded yet; retried on every APP_READY / CHAT_CHANGED / GROUP_UPDATED.
        if (select.find('option[value="4"]').length === 0) {
            select.append('<option value="4">Smart</option>');
            select.append('<option value="5">Alias</option>');
            injected = true;
        }
        injected = injectCeilingWidget(select) || injected;
        injected = injectAliasWarning(select) || injected;
        syncStrategySelect();
        syncGroupCeilingWidget();
        syncGroupAliasWarning();
        if (injected && !injectLogged) {
            injectLogged = true;
            removeLogged = false; // the next removal may log its one line again
            console.log(LOG_PREFIX, 'strategy options and responders-cap widget injected');
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'injection failed:', err);
    }
}

/** Removes the injected Smart/Alias options, the per-group responders-cap widget and the group alias warning
 * widget from the DOM; used whenever the master switch is off (context hooks and the panel toggle). Idempotent and
 * wrapped in try/catch: never throws. Resets the one-time injection log flag so re-enabling logs the next injection again. */
function removeInjected() {
    try {
        $('#rm_group_activation_strategy').find('option[value="4"],option[value="5"]').remove();
        $('#stgcmodes_group_ceiling_wrap').remove();
        $('#stgcmodes_group_aliaswarn').remove();
        injectLogged = false; // a re-enable must log the injection again
        if (!removeLogged) {
            removeLogged = true;
            console.log(LOG_PREFIX, 'Smart/Alias options removed (disabled)');
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'injection removal failed:', err);
    }
}

/** Creates and mounts the per-group responders-cap widget once, directly after the flex container that holds the
 * strategy select; the widget is only visible while the group panel is open because it lives in the same group
 * form container. The widget label carries the ttGroupCeiling tooltip.
 * @param {JQuery} strategySelect The #rm_group_activation_strategy element. @returns {boolean} True when the widget was created by this call. */
function injectCeilingWidget(strategySelect) {
    if ($('#stgcmodes_group_ceiling_wrap').length > 0) return false;
    const anchor = strategySelect.closest('div.flex1');
    if (anchor.length === 0) return false; // Anchor layout differs; retried on the next context hook.
    const wrap = $('<div>').attr('id', 'stgcmodes_group_ceiling_wrap').addClass('flex1 flexGap5');
    const label = $('<label>').attr('for', 'stgcmodes_group_ceiling').addClass('flexnowrap width100p whitespacenowrap');
    const labelText = $('<span>').attr('id', 'stgcmodes_group_ceiling_label').text(localize('groupCeilingLabel'));
    label.attr('title', localize('ttGroupCeiling'));
    const valueSelect = $('<select>').attr('id', 'stgcmodes_group_ceiling');
    $('<option>').attr('value', 'default').text(localize('groupCeilingDefault')).appendTo(valueSelect);
    for (const value of ['2', '3', '4', '5']) {
        $('<option>').attr('value', value).text(value).appendTo(valueSelect);
    }
    $('<option>').attr('value', '0').text(localize('groupCeilingNone')).appendTo(valueSelect);
    label.append(labelText);
    wrap.append(label).append(valueSelect);
    anchor.after(wrap);
    valueSelect.on('change', onGroupCeilingChange);
    return true;
}

/** Change handler for the per-group ceiling widget: writes st_gc_modes.ceiling onto the open group object (null
 * for "default") and persists the whole group via editGroup. */
function onGroupCeilingChange() {
    try {
        const raw = String($('#stgcmodes_group_ceiling').val() ?? 'default');
        const group = getActiveGroup();
        if (!group || !selected_group) {
            console.warn(LOG_PREFIX, 'ceiling change ignored: no active group');
            return;
        }
        const stored = ensureStGcModes(group);
        stored.ceiling = (raw === 'default') ? null : Number(raw);
        editGroup(selected_group, true, false).catch(err => console.error(LOG_PREFIX, 'failed to save group ceiling override:', err));
        console.log(LOG_PREFIX, `group ceiling override set to ${raw === 'default' ? 'default' : String(stored.ceiling)}`);
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to save group ceiling override:', err);
    }
}

/** Syncs the strategy select with the open group — only filling gaps: it never overwrites a value the user has
 * just selected mid-edit. */
function syncStrategySelect() {
    const select = $('#rm_group_activation_strategy');
    if (select.length === 0) return;
    const group = getActiveGroup();
    if (!group) return;
    const strategy = Number(group.activation_strategy);
    if (strategy !== STRATEGY_SMART && strategy !== STRATEGY_ALIAS) return;
    const value = String(strategy);
    if (select.val() !== value) select.val(value);
}

/** Syncs the per-group ceiling widget with the open group's stored override: a number shows as that option,
 * null/absent shows as "(default)". */
function syncGroupCeilingWidget() {
    const valueSelect = $('#stgcmodes_group_ceiling');
    if (valueSelect.length === 0) return;
    const override = getActiveGroup()?.st_gc_modes;
    const value = (override && Number.isFinite(override.ceiling) && override.ceiling !== null) ? String(Number(override.ceiling)) : 'default';
    if (valueSelect.val() !== value) valueSelect.val(value);
}

// ---- group alias warning widget ----

/** Creates and mounts the group alias warning widget once, right after the per-group ceiling widget when present,
 * else after the strategy select's own flex container: a first line (the alias warning), a second line (members
 * without aliases, or "all members have aliases") and the bulk "Fill with LLM" button. Idempotent; returns false
 * when the anchor layout differs (retried on the next context hook). All texts go through .text()/.attr('title').
 * @param {JQuery} strategySelect The #rm_group_activation_strategy element. @returns {boolean} True when the widget was created by this call. */
function injectAliasWarning(strategySelect) {
    if ($('#stgcmodes_group_aliaswarn').length > 0) return false;
    const anchor = strategySelect.closest('div.flex1');
    if (anchor.length === 0) return false; // Anchor layout differs; retried on the next context hook.
    const widget = $('<div>').attr('id', 'stgcmodes_group_aliaswarn').addClass('flex1');
    $('<div>').attr('id', 'stgcmodes_group_aliaswarn_text').append($('<span>')).appendTo(widget);
    $('<div>').attr('id', 'stgcmodes_group_aliaswarn_missing').append($('<span>')).appendTo(widget);
    const fillButton = $('<div>').attr({ id: 'stgcmodes_group_aliaswarn_fill', title: localize('groupAliasFillTitle') }).addClass('menu_button');
    fillButton.append($('<i>').addClass('fa-solid fa-wand-magic-sparkles'));
    fillButton.append($('<span>').text(localize('groupAliasFill')));
    fillButton.on('click', onBulkAliasFill);
    widget.append(fillButton);
    const ceilingWrap = $('#stgcmodes_group_ceiling_wrap');
    if (ceilingWrap.length > 0) ceilingWrap.after(widget); else anchor.after(widget);
    return true;
}

/** Refreshes the group alias warning widget for the open group: hidden unless an active group uses the Smart or
 * Alias strategy, the first line always shows the groupAliasWarning text, the second line shows either
 * groupAliasAllSet or the groupAliasMissing list (member names sanitized exactly like the cascade unknown-name
 * toast, replaced through a function argument against HTML-special characters) and the bulk button is disabled
 * when there is nothing to fill or a bulk run is in flight. Called from injectStrategyOptions right after
 * syncGroupCeilingWidget (so it reruns on every context hook) and again in the bulk fill finally block. */
function syncGroupAliasWarning() {
    const widget = $('#stgcmodes_group_aliaswarn');
    if (widget.length === 0) return;
    const group = getActiveGroup();
    const strategy = Number(group?.activation_strategy);
    if (!group || (strategy !== STRATEGY_SMART && strategy !== STRATEGY_ALIAS)) {
        widget.hide();
        return;
    }
    widget.show();
    const missing = membersWithoutAliases(group);
    $('#stgcmodes_group_aliaswarn_text span').text(localize('groupAliasWarning'));
    // toastr renders the message as HTML: strip HTML-special characters from every member name before the join.
    const safeNames = missing.map(avatarToName).map(name => String(name).replace(/[<>&"'\u0060]/g, '')).join(', ');
    $('#stgcmodes_group_aliaswarn_missing span').text(missing.length === 0
        ? localize('groupAliasAllSet')
        : localize('groupAliasMissing').replace('{names}', () => safeNames));
    $('#stgcmodes_group_aliaswarn_fill').prop('disabled', missing.length === 0 || isBulkAliasFillRunning());
}

// ---- group alias bulk fill ----

/** Whether a bulk "Fill with LLM" run is currently in flight; keeps re-entrants out and the widget button disabled.
 * @returns {boolean} True while onBulkAliasFill is running. */
function isBulkAliasFillRunning() {
    return bulkAliasFillBusy;
}

/** Per-member failure toast of the bulk fill: the localized bulkMemberFailedToast with {name} replaced by the
 * sanitized member name (HTML-special characters stripped, function-argument replace like the unknown-names toast).
 * @param {string} name Member display name (may be undefined). @returns {void} Nothing. */
function showBulkMemberFailedToast(name) {
    if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') {
        toastr.error(localize('bulkMemberFailedToast').replace('{name}', () => String(name ?? '').replace(/[<>&"'\u0060]/g, '')), MODULE_NAME);
    }
}

/** Click handler for the group alias widget's "Fill with LLM" button: for every enabled member of the active group
 * that still has no aliases (existing character only), one quiet generateRaw request over buildAliasPrompt, parsed
 * by parseAliasAnswer and saved straight into the character card through saveCharacterAliases (programmatic FULL
 * form save + in-place single-character refresh). Members run strictly sequentially like the invokeMembers loop;
 * every per-member failure is a toast + skip (never a throw out of the loop) and the run always ends with the
 * bulkDoneToast; the busy flag and the button state are restored in finally — syncGroupAliasWarning recomputes
 * both the now-possibly-empty missing list and the disabled state (the widget disappears or shows "all set").
 * @returns {Promise<void>} Resolves once the run finished. */
async function onBulkAliasFill() {
    if (!isEnabled() || bulkAliasFillBusy) return;
    const group = getActiveGroup();
    if (!group) {
        console.warn(LOG_PREFIX, 'bulk alias fill skipped: no active group');
        return;
    }
    const strategy = Number(group.activation_strategy);
    if (strategy !== STRATEGY_SMART && strategy !== STRATEGY_ALIAS) return;
    const targets = membersWithoutAliases(group);
    if (targets.length === 0) return;
    bulkAliasFillBusy = true;
    try {
        $('#stgcmodes_group_aliaswarn_fill').prop('disabled', true); // queried by id each time: the widget can be re-injected
        let ok = 0;
        for (let i = 0; i < targets.length; i++) {
            const avatar = targets[i];
            const chid = findCharacterIndex(avatar);
            if (chid === -1) continue;
            // Progress toast once per member, both numbers replaced through function arguments.
            if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') {
                toastr.info(localize('bulkProgressToast').replace('{current}', () => String(i + 1)).replace('{total}', () => String(targets.length)), MODULE_NAME);
            }
            const ch = characters[chid];
            const prompt = buildAliasPrompt(ch);
            if (prompt === null) {
                showBulkMemberFailedToast(ch?.name);
                continue;
            }
            let answer = '';
            try {
                answer = await generateRaw({ prompt, systemPrompt: '' });
            } catch (err) {
                console.error(LOG_PREFIX, `bulk alias generation for ${String(ch?.name ?? avatar)} failed:`, err);
                showBulkMemberFailedToast(ch?.name);
                continue;
            }
            const aliases = parseAliasAnswer(answer, ch?.name);
            if (aliases.length === 0) {
                showBulkMemberFailedToast(ch?.name);
                continue;
            }
            const aliasString = aliases.join(', ');
            const saved = await saveCharacterAliases(chid, aliasString);
            if (!saved) {
                showBulkMemberFailedToast(ch?.name);
                continue;
            }
            ok += 1;
            console.log(LOG_PREFIX, 'bulk aliases written:', ch.name, '->', aliases.length, 'items');
            refreshEditorAliasesFromCard(chid); // the character is open in the editor: re-read the freshly saved card into the form
        }
        if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') {
            toastr.info(localize('bulkDoneToast').replace('{ok}', () => String(ok)).replace('{total}', () => String(targets.length)), MODULE_NAME);
        }
    } finally {
        bulkAliasFillBusy = false;
        syncGroupAliasWarning(); // recomputes the missing list (now possibly empty) and the button disabled state
    }
}

// ---- settings panel ----

/** Renders the st-gc-modes settings drawer into the extensions settings container: master switch row, repo link,
 * director instructions, context depth, the level2/level3/level4 checkboxes and the default responders cap.
 * Appends the static theme-safe CSS block to the head exactly once. The static HTML skeleton contains no dynamic
 * values: every label is filled through .text() from UI_TEXT, every tooltip goes through .attr('title', ...) and
 * every dynamic value goes through .val()/.prop(). */
function renderSettingsPanel() {
    const target = $('#extensions_settings2').length > 0 ? $('#extensions_settings2') : $('#extensions_settings');
    if (target.length === 0) {
        console.warn(LOG_PREFIX, 'settings container not found, panel not rendered');
        return;
    }
    if ($('#stgcmodes_content').length > 0) return; // Already rendered (idempotent).

    // Theme-safe CSS, added once: all colors come from SillyTavern CSS variables, never from hex literals.
    if ($('#stgcmodes_css').length === 0) {
        $('head').append([
            '<style id="stgcmodes_css">',
            '.stgcmodes input[type="text"], .stgcmodes input[type="number"], .stgcmodes textarea, .stgcmodes select,',
            '#stgcmodes_group_ceiling {',
            '    background-color: var(--black30a);',
            '    color: var(--SmartThemeBodyColor);',
            '    border: 1px solid var(--SmartThemeBorderColor);',
            '    border-radius: 5px;',
            '}',
            '/* group alias warning widget */',
            '#stgcmodes_group_aliaswarn { border: 1px solid var(--SmartThemeBorderColor); border-radius: 10px; background-color: var(--black30a); padding: 5px 8px; margin-top: 5px; display: none; }',
            '.stgcmodes input::placeholder { color: var(--grey30); opacity: 1; }',
            '.stgcmodes .stgcmodes_hint { opacity: 0.65; font-size: 11px; margin-top: 3px; }',
            '.stgcmodes .stgcmodes_repo_row { margin: 4px 0 8px 0; font-size: 12px; }',
            '.stgcmodes .stgcmodes_repo_row a { color: var(--SmartThemeAccentColor); text-decoration: none; }',
            '.stgcmodes .stgcmodes_repo_row a:hover { text-decoration: underline; }',
            '</style>',
        ].join('\n'));
    }

    const skeleton = [
        '<div class="stgcmodes"><div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b><span class="stgcmodes_i18n" data-key="panelTitle"></span></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content" id="stgcmodes_content" style="display:none">',
        '<label class="flex1 checkbox_label" id="stgcmodes_enabled_row" for="stgcmodes_enabled"><input id="stgcmodes_enabled" type="checkbox" /><span class="stgcmodes_i18n" data-key="enabledLabel"></span></label>',
        '<div class="stgcmodes_repo_row"><a id="stgcmodes_repo_link" href="https://github.com/DarkLeopard/st-gc-modes" target="_blank" rel="noopener"><span class="stgcmodes_i18n" data-key="repoLink"></span></a></div>',
        '<div class="flex1">',
        '<label for="stgcmodes_instructions" class="stgcmodes_label"><span class="stgcmodes_i18n" data-key="panelInstructions"></span></label>',
        '<textarea id="stgcmodes_instructions" rows="6" spellcheck="false"></textarea>',
        '<div class="stgcmodes_hint stgcmodes_i18n" data-key="hintInstructions"></div>',
        '</div>',
        '<div class="flex1">',
        '<label for="stgcmodes_depth" class="stgcmodes_label"><span id="stgcmodes_depth_label" class="stgcmodes_i18n" data-key="panelDepth"></span></label>',
        '<input id="stgcmodes_depth" type="number" min="1" max="50" step="1" />',
        '<div class="stgcmodes_hint stgcmodes_i18n" data-key="hintDepth"></div>',
        '</div>',
        '<label class="flex1 checkbox_label" for="stgcmodes_l2"><input id="stgcmodes_l2" type="checkbox" /><span class="stgcmodes_i18n" data-key="panelL2"></span></label>',
        '<label class="flex1 checkbox_label" for="stgcmodes_l3"><input id="stgcmodes_l3" type="checkbox" /><span class="stgcmodes_i18n" data-key="panelL3"></span></label>',
        '<label class="flex1 checkbox_label" for="stgcmodes_note"><input id="stgcmodes_note" type="checkbox" /><span class="stgcmodes_i18n" data-key="panelNote"></span></label>',
        '<div class="flex1">',
        '<label for="stgcmodes_ceiling" class="stgcmodes_label"><span class="stgcmodes_i18n" data-key="panelCeiling"></span></label>',
        '<select id="stgcmodes_ceiling"></select>',
        '<div class="stgcmodes_hint stgcmodes_i18n" data-key="hintCeiling"></div>',
        '</div>',
        '</div></div></div>',
    ].join('\n');

    target.append(skeleton);

    // Fill every localized label through .text() — scan the WHOLE drawer root (the header title lives outside
    // #stgcmodes_content) — never interpolated into HTML strings.
    $('.stgcmodes').find('.stgcmodes_i18n').each(function () {
        $(this).text(localize(String($(this).attr('data-key'))));
    });

    // Tooltips: title attributes only, filled once at render time — the panel renders once per page load.
    $('#stgcmodes_enabled_row').attr('title', localize('ttEnabled'));
    $('#stgcmodes_content').find('label[for="stgcmodes_instructions"]').attr('title', localize('ttInstructions'));
    $('#stgcmodes_instructions').attr('title', localize('ttInstructions'));
    $('#stgcmodes_depth_label').attr('title', localize('ttDepth'));
    $('#stgcmodes_depth').attr('title', localize('ttDepth'));
    $('#stgcmodes_content').find('label[for="stgcmodes_l2"]').attr('title', localize('ttL2'));
    $('#stgcmodes_content').find('label[for="stgcmodes_l3"]').attr('title', localize('ttL3'));
    $('#stgcmodes_content').find('label[for="stgcmodes_note"]').attr('title', localize('ttNote'));
    $('#stgcmodes_content').find('label[for="stgcmodes_ceiling"]').attr('title', localize('ttCeiling'));
    $('#stgcmodes_ceiling').attr('title', localize('ttCeiling'));

    // Master switch: the checkbox reflects isEnabled(); the change handler keeps DOM and settings in sync.
    $('#stgcmodes_enabled').prop('checked', isEnabled()).on('change', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        // Add/Remove DOM synchronously so the change is visible immediately.
        if (settings.enabled) {
            injectStrategyOptions();
            if (typeof toastr !== 'undefined') toastr.info(localize('toggleOnToast'), 'st-gc-modes');
        } else {
            removeInjected();
            if (typeof toastr !== 'undefined') toastr.info(localize('toggleOffToast'), 'st-gc-modes');
        }
        // The editor alias field stays injected; its gen button follows the switch (off → disabled, on → per mode).
        syncEditorAliasesButtonState();
        console.log(LOG_PREFIX, `enabled toggled: ${settings.enabled}`);
    });

    // Director instructions textarea.
    $('#stgcmodes_instructions').val(String(settings.smart_instructions ?? '')).on('input', function () {
        settings.smart_instructions = String($(this).val() ?? '');
        saveSettingsDebounced();
    });

    // Context depth with a live N in the label.
    $('#stgcmodes_depth').val(String(clampDepth()));
    updateDepthLabel();
    $('#stgcmodes_depth').on('change', function () {
        const raw = Math.round(Number($(this).val()));
        const value = Number.isFinite(raw) ? Math.min(50, Math.max(1, raw)) : clampDepth();
        $(this).val(String(value));
        settings.context_depth = value;
        saveSettingsDebounced();
        updateDepthLabel();
        console.log(LOG_PREFIX, `context depth set to ${value}`);
    });

    // Level checkboxes (level2 / level3 / level4).
    for (const [id, key] of [['#stgcmodes_l2', 'level2Enabled'], ['#stgcmodes_l3', 'level3Enabled'], ['#stgcmodes_note', 'nobodyNote']]) {
        $(id).prop('checked', !!settings[key]).on('change', function () {
            settings[key] = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    }

    // Default responders cap select.
    const ceilingSelect = $('#stgcmodes_ceiling');
    for (const value of ['2', '3', '4', '5', '0']) {
        $('<option>').attr('value', value).text((value === '0') ? localize('ceilingNone') : value).appendTo(ceilingSelect);
    }
    ceilingSelect.val(String(Number(settings.ceiling)));
    ceilingSelect.on('change', function () {
        const raw = String($(this).val() ?? '2');
        const value = Number(raw);
        settings.ceiling = Number.isFinite(value) ? value : DEFAULT_SETTINGS.ceiling;
        saveSettingsDebounced();
        console.log(LOG_PREFIX, `default responders cap set to ${raw === '0' ? 'none (unlimited)' : raw}`);
    });
}

/** Updates the context depth label so it reads "Context depth N (last messages)" / RU equivalent. */
function updateDepthLabel() {
    const label = $('#stgcmodes_depth_label');
    if (label.length === 0) return;
    label.text(localize('panelDepth').replace('{n}', String(clampDepth())));
}

// ---- debug/stats hook ----

/** Publishes the window.__GCModes debug and test hook: live state, last cascade stats clone and the cumulative
 * cascadeStats counter object. */
function defineDebugHook() {
    window.__GCModes = {
        state: () => ({
            running: cascadeScheduled || isCascadeActive,
            queue: pendingCascades.length,
            strategyOfActiveGroup: activeGroupStrategy(),
        }),
        last: () => (lastCascade ? structuredClone(lastCascade) : null),
        stats: cascadeStats,
    };
}

// ---- init ----

/** Shared handler for context events (APP_READY, CHAT_CHANGED, GROUP_UPDATED): while the master switch is off it
 * only removes previously injected DOM and skips everything else; otherwise it re-injects idempotently and syncs
 * the widgets. Never throws. */
function onContextEvents() {
    try {
        // The editor alias field stays injected and functional even when the master switch is off
        // (decision: injecting is harmless; only LLM generation and the group cascade are gated).
        ensureEditorAliasesField();
        syncEditorAliasesButtonState();
        if (!isEnabled()) {
            removeInjected();
            return;
        }
        injectStrategyOptions();
    } catch (err) {
        console.error(LOG_PREFIX, 'context event handling failed:', err);
    }
}

/** Registers the event listeners used by this extension: the three cheap context hooks, the USER_MESSAGE_RENDERED
 * cascade entry point and the CHARACTER_EDITOR_OPENED alias-field sync. */
function registerEventListeners() {
    try {
        eventSource.on(event_types.APP_READY, onContextEvents);
        eventSource.on(event_types.CHAT_CHANGED, onContextEvents);
        eventSource.on(event_types.GROUP_UPDATED, onContextEvents);
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessageRendered);
        eventSource.on(event_types.CHARACTER_EDITOR_OPENED, onCharacterEditorOpened);
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to register event listeners:', err);
    }
}

/** Module entry point: load settings, register hooks, inject once, render the panel and publish the debug hook.
 * Kept quiet on purpose: at most two debug lines at load. */
function initModule() {
    try {
        settings = loadSettings();
        registerEventListeners();
        injectStrategyOptions();
        renderSettingsPanel();
        try {
            ensureEditorAliasesField();
        } catch (err) {
            console.error(LOG_PREFIX, 'editor alias field setup failed:', err);
        }
        defineDebugHook();
        console.log(LOG_PREFIX, 'extension loaded');
    } catch (err) {
        console.error(LOG_PREFIX, 'initialization failed:', err);
    }
}

jQuery(function () {
    initModule();
});