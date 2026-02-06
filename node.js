/**
 * UzRail Ticket Watcher Bot — UX upgrade pack:
 * 1) /start menu buttons
 * 2) Wizard: popular routes + city search
 * 4) Summary + confirm step
 * 5) Interactive list + manage (pause/resume, delete, filters, quiet)
 * 6) Actionable notifications with buttons
 * 7) FAQ help
 * 8) Language (uz/ru)
 */

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const pLimit = require("p-limit").default;

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN env yo‘q");

const CHECK_INTERVAL_SEC = Number(process.env.CHECK_INTERVAL_SEC || 30);
const TZ = "Asia/Tashkent";

const ET_BASE = "https://eticket.railway.uz";
const TRAINS_LIST_URL = `${ET_BASE}/api/v3/handbook/trains/list`;

const DB_PATH = process.env.DB_PATH || "data.sqlite";

/* =========================
   Stations + Popular routes
========================= */
const STATIONS = [
  { key: "toshkent", code: "2900000", label: "Toshkent" },
  { key: "samarqand", code: "2900700", label: "Samarqand" },
  { key: "buxoro", code: "2900800", label: "Buxoro" },
  { key: "navoiy", code: "2900930", label: "Navoiy" },
  { key: "qarshi", code: "2900750", label: "Qarshi" },
  { key: "termiz", code: "2900255", label: "Termiz" },
  { key: "nukus", code: "2900970", label: "Nukus" },
  { key: "urganch", code: "2900790", label: "Urganch" },
  { key: "xiva", code: "2900172", label: "Xiva" },
  { key: "andijon", code: "2900680", label: "Andijon" },
  { key: "namangan", code: "2900940", label: "Namangan" },
  { key: "jizzax", code: "2900720", label: "Jizzax" },
  { key: "guliston", code: "2900850", label: "Guliston" },
  { key: "qoqon", code: "2900880", label: "Qo‘qon" },
  { key: "margilon", code: "2900920", label: "Marg‘ilon" },
];

const POP_ROUTES = [
  ["toshkent", "samarqand"],
  ["toshkent", "buxoro"],
  ["toshkent", "qarshi"],
  ["toshkent", "navoiy"],
  ["samarqand", "toshkent"],
  ["buxoro", "toshkent"],
  ["andijon", "toshkent"],
  ["toshkent", "andijon"],
];

function stationByKey(key) {
  return STATIONS.find((s) => s.key === key);
}

/* =========================
   i18n
========================= */
const I18N = {
  uz: {
    START: "Salom! Men bilet sotmayman — faqat joy chiqsa darhol ogohlantiraman.",
    MENU_ADD: "🔔 Kuzatuv qo‘shish",
    MENU_LIST: "📋 Kuzatuvlarim",
    MENU_HELP: "❓ Yordam",
    MENU_LANG: "🌐 Til",

    WATCH_MODE: "Kuzatuvni qanday qo‘shamiz?",
    BTN_POPULAR: "⭐ Mashhur yo‘nalishlar",
    BTN_MANUAL: "🗺 Qo‘lda tanlash",
    BTN_CANCEL: "Bekor qilish",

    ASK_FROM: "Qayerdan ketasiz? (shaharni tanlang)",
    ASK_TO: "Qayerga borasiz? (shaharni tanlang)",
    ASK_DATE:
      "Sana kiriting:\n• 2026-02-20 yoki • 20.02.2026\n\nYoki: Bugun/Ertaga/Indinga tugmalarini bosing.",
    BTN_TODAY: "📅 Bugun",
    BTN_TOMORROW: "📅 Ertaga",
    BTN_DAYAFTER: "📅 Indinga",

    ASK_FILTERS:
      "Filtrlar (ixtiyoriy):\n• min=2 (kamida 2 joy)\n• max=500000 (narx limiti)\n\nYozing: masalan `min=1 max=600000`\nYoki `ok` deb yuboring.",
    SUMMARY_TITLE: "✅ Tekshirib oling:",
    BTN_CONFIRM: "✅ Tasdiqlash",
    BTN_EDIT_ROUTE: "🔁 Yo‘nalish",
    BTN_EDIT_DATE: "📅 Sana",
    BTN_EDIT_FILTERS: "⚙️ Filtr",

    ADDED: "✅ Kuzatuv qo‘shildi!",
    LIST_EMPTY: "Hozircha kuzatuv yo‘q. 🔔 Kuzatuv qo‘shishdan boshlang.",
    LIST_TITLE: "📋 Kuzatuvlarim:",
    BTN_MANAGE: "⚙️ Boshqarish",
    BTN_BACK: "⬅️ Orqaga",
    BTN_NEXT: "➡️ Keyingi",
    BTN_PREV: "⬅️ Oldingi",

    MANAGE_TITLE: "⚙️ Kuzatuv boshqaruvi",
    BTN_PAUSE: "⏸ To‘xtatish",
    BTN_RESUME: "▶️ Davom ettirish",
    BTN_DELETE: "🗑 O‘chirish",
    BTN_FILTERS: "⚙️ Filtrni o‘zgartirish",
    BTN_QUIET_TOGGLE_ON: "🌙 Tungi rejim: ON",
    BTN_QUIET_TOGGLE_OFF: "🌙 Tungi rejim: OFF",

    EDIT_FILTERS_PROMPT:
      "Yangi filtr yuboring:\n`min=1 max=500000` yoki faqat `min=2` yoki `ok` (filtrni olib tashlash uchun: `max=` yozmang).",
    UPDATED: "✅ Yangilandi.",

    SEARCH_BTN: "🔎 Qidirish",
    SEARCH_PROMPT: "Shahar nomidan 2–3 harf yozing (masalan: `bux`, `tos`):",
    SEARCH_NOT_FOUND: "Topilmadi. Boshqacha yozib ko‘ring.",

    NOTIF_TITLE: "🔥 Joy chiqdi!",
    BTN_OPEN_SITE: "🌐 Rasmiy sayt",
    BTN_PAUSE_THIS: "⏸ Shu kuzatuvni to‘xtatish",
    BTN_OPEN_LIST: "📋 Kuzatuvlarim",

    HELP_TEXT:
      "❓ Yordam / FAQ\n\n" +
      "1) Men bilet sotmayman — faqat joy chiqsa xabar beraman.\n" +
      "2) Joylar 1–2 dona chiqib tez tugashi mumkin — xabar kelsa darhol rasmiy saytdan oling.\n" +
      "3) Login/parol so‘ramayman.\n" +
      "4) Xabar kelmasa: saytda vaqtincha javob bo‘lmasligi yoki joy chiqmagan bo‘lishi mumkin.\n\n" +
      "Buyruqlar:\n" +
      "• /watch — kuzatuv qo‘shish\n" +
      "• /list — kuzatuvlarim\n" +
      "• /language — tilni o‘zgartirish",
    LANG_PICK: "Tilni tanlang:",
    LANG_SET_UZ: "✅ Til o‘zgartirildi: O‘zbek",
    LANG_SET_RU: "✅ Язык изменён: Русский",
  },

  ru: {
    START: "Привет! Я не продаю билеты — я уведомляю, когда появляются места.",
    MENU_ADD: "🔔 Добавить наблюдение",
    MENU_LIST: "📋 Мои наблюдения",
    MENU_HELP: "❓ Помощь",
    MENU_LANG: "🌐 Язык",

    WATCH_MODE: "Как добавим наблюдение?",
    BTN_POPULAR: "⭐ Популярные направления",
    BTN_MANUAL: "🗺 Выбрать вручную",
    BTN_CANCEL: "Отмена",

    ASK_FROM: "Откуда едем? (выберите город)",
    ASK_TO: "Куда едем? (выберите город)",
    ASK_DATE:
      "Введите дату:\n• 2026-02-20 или • 20.02.2026\n\nИли нажмите кнопки: Сегодня/Завтра/Послезавтра.",
    BTN_TODAY: "📅 Сегодня",
    BTN_TOMORROW: "📅 Завтра",
    BTN_DAYAFTER: "📅 Послезавтра",

    ASK_FILTERS:
      "Фильтры (необязательно):\n• min=2 (минимум 2 места)\n• max=500000 (лимит цены)\n\nОтправьте: например `min=1 max=600000`\nИли `ok` чтобы пропустить.",
    SUMMARY_TITLE: "✅ Проверьте перед сохранением:",
    BTN_CONFIRM: "✅ Подтвердить",
    BTN_EDIT_ROUTE: "🔁 Маршрут",
    BTN_EDIT_DATE: "📅 Дата",
    BTN_EDIT_FILTERS: "⚙️ Фильтр",

    ADDED: "✅ Наблюдение добавлено!",
    LIST_EMPTY: "Пока нет наблюдений. Начните с 🔔 Добавить наблюдение.",
    LIST_TITLE: "📋 Мои наблюдения:",
    BTN_MANAGE: "⚙️ Управлять",
    BTN_BACK: "⬅️ Назад",
    BTN_NEXT: "➡️ Далее",
    BTN_PREV: "⬅️ Назад",

    MANAGE_TITLE: "⚙️ Управление наблюдением",
    BTN_PAUSE: "⏸ Пауза",
    BTN_RESUME: "▶️ Продолжить",
    BTN_DELETE: "🗑 Удалить",
    BTN_FILTERS: "⚙️ Изменить фильтр",
    BTN_QUIET_TOGGLE_ON: "🌙 Ночной режим: ON",
    BTN_QUIET_TOGGLE_OFF: "🌙 Ночной режим: OFF",

    EDIT_FILTERS_PROMPT:
      "Отправьте новый фильтр:\n`min=1 max=500000` или только `min=2` или `ok` (чтобы сбросить max — просто не указывайте `max=`).",
    UPDATED: "✅ Обновлено.",

    SEARCH_BTN: "🔎 Поиск",
    SEARCH_PROMPT: "Введите 2–3 буквы города (например: `bux`, `tos`):",
    SEARCH_NOT_FOUND: "Не найдено. Попробуйте иначе.",

    NOTIF_TITLE: "🔥 Появились места!",
    BTN_OPEN_SITE: "🌐 Открыть сайт",
    BTN_PAUSE_THIS: "⏸ Пауза по этому наблюдению",
    BTN_OPEN_LIST: "📋 Мои наблюдения",

    HELP_TEXT:
      "❓ Помощь / FAQ\n\n" +
      "1) Я не продаю билеты — только уведомляю.\n" +
      "2) Места могут появляться на 1–2 минуты и быстро исчезать — действуйте сразу.\n" +
      "3) Я не прошу логин/пароль.\n" +
      "4) Если нет уведомлений: мест нет или сайт временно не отвечает.\n\n" +
      "Команды:\n" +
      "• /watch — добавить наблюдение\n" +
      "• /list — мои наблюдения\n" +
      "• /language — сменить язык",
    LANG_PICK: "Выберите язык:",
    LANG_SET_UZ: "✅ Til o‘zgartirildi: O‘zbek",
    LANG_SET_RU: "✅ Язык изменён: Русский",
  },
};

function t(lang, key) {
  return (I18N[lang] && I18N[lang][key]) || I18N.uz[key] || key;
}

/* =========================
   DB + auto-migrations
========================= */
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function hasColumn(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,

      from_key TEXT NOT NULL,
      from_code TEXT NOT NULL,
      from_label TEXT NOT NULL,

      to_key TEXT NOT NULL,
      to_code TEXT NOT NULL,
      to_label TEXT NOT NULL,

      date TEXT NOT NULL,
      min_seats INTEGER NOT NULL DEFAULT 1,
      max_price INTEGER,

      quiet_enabled INTEGER NOT NULL DEFAULT 1,
      quiet_start TEXT NOT NULL DEFAULT '23:00',
      quiet_end   TEXT NOT NULL DEFAULT '07:00',

      last_available INTEGER NOT NULL DEFAULT 0,
      last_sig TEXT,
      last_notified_at TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_watches_query ON watches(from_code,to_code,date);
    CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(chat_id);

    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      lang TEXT NOT NULL DEFAULT 'uz',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add missing columns (if DB created earlier)
  if (!hasColumn("watches", "is_active")) {
    db.exec(`ALTER TABLE watches ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
  }
}

ensureSchema();

const stmtUpsertUser = db.prepare(`
  INSERT INTO users(chat_id, lang) VALUES(?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET lang=excluded.lang
`);
const stmtGetUser = db.prepare(`SELECT chat_id, lang FROM users WHERE chat_id=?`);

const stmtInsertWatch = db.prepare(`
  INSERT INTO watches(
    chat_id, from_key, from_code, from_label,
    to_key, to_code, to_label,
    date, min_seats, max_price
  ) VALUES (?,?,?,?,?,?,?,?,?,?)
`);

const stmtCountWatches = db.prepare(`SELECT COUNT(*) as c FROM watches WHERE chat_id=?`);
const stmtListWatchesPage = db.prepare(`
  SELECT id, from_label, to_label, date, min_seats, max_price, quiet_enabled, is_active
  FROM watches
  WHERE chat_id=?
  ORDER BY id DESC
  LIMIT ? OFFSET ?
`);
const stmtGetWatch = db.prepare(`SELECT * FROM watches WHERE id=? AND chat_id=?`);
const stmtDeleteWatch = db.prepare(`DELETE FROM watches WHERE id=? AND chat_id=?`);
const stmtSetActive = db.prepare(`UPDATE watches SET is_active=? WHERE id=? AND chat_id=?`);
const stmtToggleQuiet = db.prepare(`
  UPDATE watches
  SET quiet_enabled = CASE WHEN quiet_enabled=1 THEN 0 ELSE 1 END
  WHERE id=? AND chat_id=?
`);
const stmtUpdateFilters = db.prepare(`
  UPDATE watches SET min_seats=?, max_price=? WHERE id=? AND chat_id=?
`);

// Worker fetch only active watches
const stmtAllActiveWatches = db.prepare(`SELECT * FROM watches WHERE is_active=1`);

/* =========================
   User lang cache
========================= */
const langCache = new Map();
function getLang(chatId) {
  if (langCache.has(chatId)) return langCache.get(chatId);
  const row = stmtGetUser.get(chatId);
  const lang = row?.lang || "uz";
  langCache.set(chatId, lang);
  if (!row) stmtUpsertUser.run(chatId, lang);
  return lang;
}
function setLang(chatId, lang) {
  const safe = lang === "ru" ? "ru" : "uz";
  stmtUpsertUser.run(chatId, safe);
  langCache.set(chatId, safe);
  return safe;
}

/* =========================
   HTTP (cookies + xsrf)
========================= */
const jar = new tough.CookieJar();
const http = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: { "User-Agent": "ticket-watch-bot/3.0" },
  })
);

async function ensureXsrf() {
  try {
    await http.get(`${ET_BASE}/ru/`);
  } catch (_) {}
  const cookies = await jar.getCookies(ET_BASE);
  const xsrf = cookies.find((c) => c.key === "XSRF-TOKEN");
  return xsrf ? decodeURIComponent(xsrf.value) : null;
}

async function fetchTrainsOnce({ from_code, to_code, date }) {
  const xsrf = await ensureXsrf();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: ET_BASE,
    Referer: `${ET_BASE}/ru/`,
  };
  if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;

  const payload = {
    directions: {
      forward: {
        date,
        depStationCode: String(from_code),
        arvStationCode: String(to_code),
      },
    },
  };

  const res = await http.post(TRAINS_LIST_URL, payload, { headers });
  return res.data;
}

/* =========================
   Parse + filters + signature
========================= */
function pickMatches(apiData, { max_price, min_seats }) {
  const trains = apiData?.data?.directions?.forward?.trains || [];
  const matches = [];

  for (const t of trains) {
    const cars = t.cars || [];
    for (const car of cars) {
      const freeSeats = Number(car.freeSeats || 0);
      if (freeSeats < Number(min_seats || 1)) continue;

      const tariffs = (car.tariffs || [])
        .map((x) => Number(x.tariff))
        .filter((n) => Number.isFinite(n));
      const minTariff = tariffs.length ? Math.min(...tariffs) : null;

      if (max_price && minTariff !== null && minTariff > Number(max_price)) continue;

      matches.push({
        trainNumber: t.number || "",
        trainType: t.type || "",
        departureDate: t.departureDate || "",
        carType: car.type || car.name || "",
        freeSeats,
        minTariff,
      });
    }
  }

  matches.sort((a, b) => {
    const seatsDiff = b.freeSeats - a.freeSeats;
    if (seatsDiff !== 0) return seatsDiff;
    const pa = a.minTariff ?? 1e18;
    const pb = b.minTariff ?? 1e18;
    return pa - pb;
  });

  return matches;
}

function makeSig(matches) {
  const s = JSON.stringify(
    matches.map((m) => [m.trainNumber, m.trainType, m.departureDate, m.carType, m.freeSeats, m.minTariff]).sort()
  );
  return crypto.createHash("sha1").update(s).digest("hex");
}

function nowTashkent() {
  return DateTime.now().setZone(TZ);
}

function parseDateFlexible(input) {
  const raw = String(input || "").trim();

  const iso = DateTime.fromISO(raw, { zone: TZ });
  if (iso.isValid) return iso.toFormat("yyyy-LL-dd");

  const dm = DateTime.fromFormat(raw, "dd.MM.yyyy", { zone: TZ });
  if (dm.isValid) return dm.toFormat("yyyy-LL-dd");

  return null;
}

function isQuietNow(watch) {
  if (!watch.quiet_enabled) return false;

  const now = nowTashkent();
  const [sh, sm] = String(watch.quiet_start || "23:00").split(":").map(Number);
  const [eh, em] = String(watch.quiet_end || "07:00").split(":").map(Number);

  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

  if (end <= start) return now >= start || now < end; // crosses midnight
  return now >= start && now < end;
}

function canNotify(watch) {
  const last = watch.last_notified_at ? DateTime.fromISO(watch.last_notified_at, { zone: TZ }) : null;
  if (!last || !last.isValid) return true;
  return nowTashkent().diff(last, "seconds").seconds >= 90;
}

/* =========================
   UI helpers
========================= */
function mainMenu(lang) {
  return Markup.keyboard(
    [[t(lang, "MENU_ADD")], [t(lang, "MENU_LIST"), t(lang, "MENU_HELP")], [t(lang, "MENU_LANG")]]
  )
    .resize()
    .persistent();
}

function watchModeKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, "BTN_POPULAR"), "wiz:popular")],
    [Markup.button.callback(t(lang, "BTN_MANUAL"), "wiz:manual")],
    [Markup.button.callback(t(lang, "BTN_CANCEL"), "wiz:cancel")],
  ]);
}

function popularRoutesKeyboard(lang) {
  const rows = POP_ROUTES.map(([a, b]) => {
    const from = stationByKey(a);
    const to = stationByKey(b);
    if (!from || !to) return null;
    return [Markup.button.callback(`${from.label} → ${to.label}`, `route:pick:${from.key}:${to.key}`)];
  }).filter(Boolean);

  rows.push([Markup.button.callback(t(lang, "BTN_BACK"), "wiz:back_mode")]);
  rows.push([Markup.button.callback(t(lang, "BTN_CANCEL"), "wiz:cancel")]);

  return Markup.inlineKeyboard(rows);
}

function stationsKeyboard(lang, prefix = "from", page = 0) {
  const perPage = 8;
  const start = page * perPage;
  const chunk = STATIONS.slice(start, start + perPage);

  const rows = chunk.map((s) => [Markup.button.callback(s.label, `${prefix}:pick:${s.key}:${page}`)]);

  // Search button
  rows.push([Markup.button.callback(t(lang, "SEARCH_BTN"), `${prefix}:search:${page}`)]);

  // Nav
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️", `${prefix}:page:${page - 1}`));
  if (start + perPage < STATIONS.length) nav.push(Markup.button.callback("➡️", `${prefix}:page:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback(t(lang, "BTN_CANCEL"), "wiz:cancel")]);
  return Markup.inlineKeyboard(rows);
}

function dateQuickKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, "BTN_TODAY"), "date:quick:0")],
    [Markup.button.callback(t(lang, "BTN_TOMORROW"), "date:quick:1")],
    [Markup.button.callback(t(lang, "BTN_DAYAFTER"), "date:quick:2")],
    [Markup.button.callback(t(lang, "BTN_CANCEL"), "wiz:cancel")],
  ]);
}

function confirmKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, "BTN_CONFIRM"), "wiz:confirm")],
    [Markup.button.callback(t(lang, "BTN_EDIT_ROUTE"), "wiz:edit_route")],
    [Markup.button.callback(t(lang, "BTN_EDIT_DATE"), "wiz:edit_date")],
    [Markup.button.callback(t(lang, "BTN_EDIT_FILTERS"), "wiz:edit_filters")],
    [Markup.button.callback(t(lang, "BTN_CANCEL"), "wiz:cancel")],
  ]);
}

/* =========================
   Session (in-memory)
========================= */
const session = new Map();
function setSession(chatId, data) {
  session.set(chatId, { ...(session.get(chatId) || {}), ...data });
}
function getSession(chatId) {
  return session.get(chatId);
}
function clearSession(chatId) {
  session.delete(chatId);
}

/* =========================
   Bot
========================= */
const bot = new Telegraf(BOT_TOKEN);

/* ---- /start + menu ---- */
bot.start(async (ctx) => {
  const lang = getLang(ctx.chat.id);
  await ctx.reply(t(lang, "START"), mainMenu(lang));
});

bot.command("help", async (ctx) => {
  const lang = getLang(ctx.chat.id);
  await ctx.reply(t(lang, "HELP_TEXT"), mainMenu(lang));
});

bot.command("language", async (ctx) => {
  const lang = getLang(ctx.chat.id);
  await ctx.reply(
    t(lang, "LANG_PICK"),
    Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇿 O‘zbek", "lang:set:uz")],
      [Markup.button.callback("🇷🇺 Русский", "lang:set:ru")],
    ])
  );
});

bot.command("list", async (ctx) => {
  await renderList(ctx, 0);
});

/* ---- menu button hears ---- */
bot.hears([I18N.uz.MENU_ADD, I18N.ru.MENU_ADD], async (ctx) => {
  await startWatchWizard(ctx);
});
bot.hears([I18N.uz.MENU_LIST, I18N.ru.MENU_LIST], async (ctx) => {
  await renderList(ctx, 0);
});
bot.hears([I18N.uz.MENU_HELP, I18N.ru.MENU_HELP], async (ctx) => {
  const lang = getLang(ctx.chat.id);
  await ctx.reply(t(lang, "HELP_TEXT"), mainMenu(lang));
});
bot.hears([I18N.uz.MENU_LANG, I18N.ru.MENU_LANG], async (ctx) => {
  const lang = getLang(ctx.chat.id);
  await ctx.reply(
    t(lang, "LANG_PICK"),
    Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇿 O‘zbek", "lang:set:uz")],
      [Markup.button.callback("🇷🇺 Русский", "lang:set:ru")],
    ])
  );
});

/* ---- /watch (wizard or args) ---- */
bot.command("watch", async (ctx) => {
  const lang = getLang(ctx.chat.id);
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);

  // Wizard mode
  if (parts.length === 1) {
    return startWatchWizard(ctx);
  }

  // Args mode: /watch from to date [min=] [max=]
  if (parts.length < 4) {
    return ctx.reply("Format: /watch <from> <to> <YYYY-MM-DD|DD.MM.YYYY> [max=500000] [min=1]");
  }

  const fromKey = parts[1].toLowerCase();
  const toKey = parts[2].toLowerCase();
  const date = parseDateFlexible(parts[3]);
  if (!date) return ctx.reply(t(lang, "ASK_DATE"), dateQuickKeyboard(lang));

  const from = stationByKey(fromKey);
  const to = stationByKey(toKey);
  if (!from || !to) return ctx.reply("Shahar topilmadi. /stations bilan ro‘yxatni ko‘ring.");

  let max_price = null;
  let min_seats = 1;
  for (const p of parts.slice(4)) {
    if (p.startsWith("max=")) max_price = Number(p.slice(4));
    if (p.startsWith("min=")) min_seats = Number(p.slice(4));
  }

  const info = stmtInsertWatch.run(
    ctx.chat.id,
    from.key,
    from.code,
    from.label,
    to.key,
    to.code,
    to.label,
    date,
    Number.isFinite(min_seats) ? min_seats : 1,
    Number.isFinite(max_price) ? max_price : null
  );

  await ctx.reply(`${t(lang, "ADDED")} ID: ${info.lastInsertRowid}`, mainMenu(lang));
});

async function startWatchWizard(ctx) {
  const lang = getLang(ctx.chat.id);
  clearSession(ctx.chat.id);
  setSession(ctx.chat.id, { step: "mode" });
  await ctx.reply(t(lang, "WATCH_MODE"), watchModeKeyboard(lang));
}

/* =========================
   LIST UI + Manage
========================= */
async function renderList(ctx, page) {
  const chatId = ctx.chat.id;
  const lang = getLang(chatId);

  const pageSize = 5;
  const total = stmtCountWatches.get(chatId).c || 0;

  if (!total) {
    return ctx.reply(t(lang, "LIST_EMPTY"), mainMenu(lang));
  }

  const rows = stmtListWatchesPage.all(chatId, pageSize, page * pageSize);

  const lines = rows.map((r) => {
    const status = r.is_active ? "✅" : "⏸";
    const max = r.max_price ? ` max=${r.max_price}` : "";
    return `${status} #${r.id}  ${r.from_label} → ${r.to_label} | ${r.date} | min=${r.min_seats}${max}`;
  });

  const buttons = rows.map((r) => [Markup.button.callback(`${t(lang, "BTN_MANAGE")} #${r.id}`, `watch:menu:${r.id}:${page}`)]);

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback(t(lang, "BTN_PREV"), `list:page:${page - 1}`));
  if ((page + 1) * pageSize < total) nav.push(Markup.button.callback(t(lang, "BTN_NEXT"), `list:page:${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback(t(lang, "BTN_BACK"), "menu:home")]);

  await ctx.reply(`${t(lang, "LIST_TITLE")}\n\n${lines.join("\n")}`, Markup.inlineKeyboard(buttons));
}

async function renderWatchMenu(ctx, watchId, backPage) {
  const lang = getLang(ctx.chat.id);
  const w = stmtGetWatch.get(watchId, ctx.chat.id);
  if (!w) return ctx.reply("Not found.");

  const max = w.max_price ? ` max=${w.max_price}` : "";
  const quiet = w.quiet_enabled ? t(lang, "BTN_QUIET_TOGGLE_ON") : t(lang, "BTN_QUIET_TOGGLE_OFF");
  const statusBtn = w.is_active ? t(lang, "BTN_PAUSE") : t(lang, "BTN_RESUME");

  const text =
    `${t(lang, "MANAGE_TITLE")}\n\n` +
    `#${w.id}\n` +
    `${w.from_label} → ${w.to_label}\n` +
    `${w.date}\n` +
    `min=${w.min_seats}${max}\n` +
    `quiet: ${w.quiet_enabled ? "ON" : "OFF"}\n` +
    `status: ${w.is_active ? "ACTIVE" : "PAUSED"}`;

  await ctx.reply(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback(statusBtn, `watch:toggle:${w.id}:${backPage}`)],
      [Markup.button.callback(t(lang, "BTN_FILTERS"), `watch:editfilters:${w.id}:${backPage}`)],
      [Markup.button.callback(quiet, `watch:quiet:${w.id}:${backPage}`)],
      [Markup.button.callback(t(lang, "BTN_DELETE"), `watch:delete:${w.id}:${backPage}`)],
      [Markup.button.callback(t(lang, "BTN_BACK"), `list:page:${backPage}`)],
    ])
  );
}

/* =========================
   Callback queries
========================= */
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.chat.id;
  const lang = getLang(chatId);
  const data = ctx.callbackQuery.data || "";

  try {
    // Language
    if (data.startsWith("lang:set:")) {
      const to = data.split(":")[2];
      const newLang = setLang(chatId, to);
      await ctx.answerCbQuery();
      await ctx.reply(newLang === "ru" ? t("ru", "LANG_SET_RU") : t("uz", "LANG_SET_UZ"), mainMenu(newLang));
      return;
    }

    // Back to menu
    if (data === "menu:home") {
      await ctx.answerCbQuery();
      return ctx.reply("OK", mainMenu(lang));
    }

    // Wizard mode
    if (data === "wiz:cancel") {
      clearSession(chatId);
      await ctx.answerCbQuery();
      return ctx.reply("OK", mainMenu(lang));
    }

    if (data === "wiz:back_mode") {
      clearSession(chatId);
      setSession(chatId, { step: "mode" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "WATCH_MODE"), watchModeKeyboard(lang));
    }

    if (data === "wiz:popular") {
      setSession(chatId, { step: "popular" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "BTN_POPULAR"), popularRoutesKeyboard(lang));
    }

    if (data === "wiz:manual") {
      setSession(chatId, { step: "from", page: 0 });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_FROM"), stationsKeyboard(lang, "from", 0));
    }

    // Popular route pick
    if (data.startsWith("route:pick:")) {
      const [, , fromKey, toKey] = data.split(":");
      const from = stationByKey(fromKey);
      const to = stationByKey(toKey);
      if (!from || !to) {
        await ctx.answerCbQuery("err");
        return;
      }
      setSession(chatId, { step: "date", from, to });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_DATE"), dateQuickKeyboard(lang));
    }

    // Stations paging
    if (data.startsWith("from:page:")) {
      const page = Number(data.split(":")[2] || 0);
      setSession(chatId, { step: "from", page });
      await ctx.answerCbQuery();
      return ctx.editMessageReplyMarkup(stationsKeyboard(lang, "from", page).reply_markup);
    }
    if (data.startsWith("to:page:")) {
      const page = Number(data.split(":")[2] || 0);
      setSession(chatId, { step: "to", page });
      await ctx.answerCbQuery();
      return ctx.editMessageReplyMarkup(stationsKeyboard(lang, "to", page).reply_markup);
    }

    // Station pick
    if (data.startsWith("from:pick:")) {
      const [, , key] = data.split(":");
      const from = stationByKey(key);
      if (!from) return ctx.answerCbQuery("err");
      setSession(chatId, { step: "to", from, page: 0 });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_TO"), stationsKeyboard(lang, "to", 0));
    }
    if (data.startsWith("to:pick:")) {
      const [, , key] = data.split(":");
      const to = stationByKey(key);
      const s = getSession(chatId);
      if (!to || !s?.from) return ctx.answerCbQuery("err");
      setSession(chatId, { step: "date", from: s.from, to });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_DATE"), dateQuickKeyboard(lang));
    }

    // City search
    if (data.startsWith("from:search:")) {
      setSession(chatId, { step: "search_from" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "SEARCH_PROMPT"));
    }
    if (data.startsWith("to:search:")) {
      setSession(chatId, { step: "search_to" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "SEARCH_PROMPT"));
    }

    // Quick date buttons
    if (data.startsWith("date:quick:")) {
      const offset = Number(data.split(":")[2] || 0);
      const date = nowTashkent().plus({ days: offset }).toFormat("yyyy-LL-dd");
      const s = getSession(chatId);
      if (!s?.from || !s?.to) return ctx.answerCbQuery("err");
      setSession(chatId, { step: "filters", date, min_seats: 1, max_price: null });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_FILTERS"));
    }

    // Confirm step
    if (data === "wiz:confirm") {
      const s = getSession(chatId);
      if (!s?.from || !s?.to || !s?.date) {
        await ctx.answerCbQuery("err");
        return;
      }

      const info = stmtInsertWatch.run(
        chatId,
        s.from.key,
        s.from.code,
        s.from.label,
        s.to.key,
        s.to.code,
        s.to.label,
        s.date,
        Number.isFinite(s.min_seats) ? s.min_seats : 1,
        Number.isFinite(s.max_price) ? s.max_price : null
      );

      clearSession(chatId);
      await ctx.answerCbQuery();
      return ctx.reply(`${t(lang, "ADDED")} ID: ${info.lastInsertRowid}`, mainMenu(lang));
    }

    if (data === "wiz:edit_route") {
      setSession(chatId, { step: "mode" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "WATCH_MODE"), watchModeKeyboard(lang));
    }
    if (data === "wiz:edit_date") {
      const s = getSession(chatId);
      if (!s?.from || !s?.to) return ctx.answerCbQuery("err");
      setSession(chatId, { step: "date" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_DATE"), dateQuickKeyboard(lang));
    }
    if (data === "wiz:edit_filters") {
      const s = getSession(chatId);
      if (!s?.date) return ctx.answerCbQuery("err");
      setSession(chatId, { step: "filters" });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "ASK_FILTERS"));
    }

    // List paging
    if (data.startsWith("list:page:")) {
      const page = Number(data.split(":")[2] || 0);
      await ctx.answerCbQuery();
      return renderList(ctx, page);
    }

    // Watch manage menu
    if (data.startsWith("watch:menu:")) {
      const [, , id, page] = data.split(":");
      await ctx.answerCbQuery();
      return renderWatchMenu(ctx, Number(id), Number(page || 0));
    }

    // Pause/Resume from menu or notification
    if (data.startsWith("watch:toggle:")) {
      const [, , id, backPage] = data.split(":");
      const w = stmtGetWatch.get(Number(id), chatId);
      if (!w) {
        await ctx.answerCbQuery("not found");
        return;
      }
      const newActive = w.is_active ? 0 : 1;
      stmtSetActive.run(newActive, Number(id), chatId);
      await ctx.answerCbQuery();
      return renderWatchMenu(ctx, Number(id), Number(backPage || 0));
    }

    if (data.startsWith("watch:delete:")) {
      const [, , id, backPage] = data.split(":");
      stmtDeleteWatch.run(Number(id), chatId);
      await ctx.answerCbQuery();
      return renderList(ctx, Number(backPage || 0));
    }

    if (data.startsWith("watch:quiet:")) {
      const [, , id, backPage] = data.split(":");
      stmtToggleQuiet.run(Number(id), chatId);
      await ctx.answerCbQuery();
      return renderWatchMenu(ctx, Number(id), Number(backPage || 0));
    }

    if (data.startsWith("watch:editfilters:")) {
      const [, , id, backPage] = data.split(":");
      setSession(chatId, { step: "edit_filters", editWatchId: Number(id), backPage: Number(backPage || 0) });
      await ctx.answerCbQuery();
      return ctx.reply(t(lang, "EDIT_FILTERS_PROMPT"));
    }

    // Open list from notification
    if (data === "open:list") {
      await ctx.answerCbQuery();
      return renderList(ctx, 0);
    }

    await ctx.answerCbQuery();
  } catch (e) {
    try {
      await ctx.answerCbQuery("err");
    } catch {}
  }
});

/* =========================
   Text handler for wizard/search/edit filters
========================= */
bot.on("text", async (ctx, next) => {
  const chatId = ctx.chat.id;
  const lang = getLang(chatId);
  const s = getSession(chatId);
  if (!s) return next();

  const text = (ctx.message.text || "").trim();

  // City search
  if (s.step === "search_from" || s.step === "search_to") {
    const q = text.toLowerCase();
    const hits = STATIONS.filter((x) => x.label.toLowerCase().includes(q) || x.key.includes(q)).slice(0, 10);

    if (!hits.length) {
      return ctx.reply(t(lang, "SEARCH_NOT_FOUND"));
    }

    const prefix = s.step === "search_from" ? "from" : "to";
    const kb = Markup.inlineKeyboard([
      ...hits.map((h) => [Markup.button.callback(h.label, `${prefix}:pick:${h.key}:0`)]),
      [Markup.button.callback(t(lang, "BTN_BACK"), `${prefix}:page:0`)],
      [Markup.button.callback(t(lang, "BTN_CANCEL"), "wiz:cancel")],
    ]);

    return ctx.reply("OK", kb);
  }

  // Date input (manual)
  if (s.step === "date") {
    const date = parseDateFlexible(text);
    if (!date) return ctx.reply(t(lang, "ASK_DATE"), dateQuickKeyboard(lang));
    setSession(chatId, { step: "filters", date, min_seats: 1, max_price: null });
    return ctx.reply(t(lang, "ASK_FILTERS"));
  }

  // Filters for wizard
  if (s.step === "filters") {
    let min_seats = 1;
    let max_price = null;

    const lower = text.toLowerCase();
    if (lower !== "ok") {
      for (const p of lower.split(/\s+/)) {
        if (p.startsWith("min=")) min_seats = Number(p.slice(4));
        if (p.startsWith("max=")) max_price = Number(p.slice(4));
      }
    }

    min_seats = Number.isFinite(min_seats) && min_seats > 0 ? min_seats : 1;
    max_price = Number.isFinite(max_price) && max_price > 0 ? max_price : null;

    setSession(chatId, { step: "confirm", min_seats, max_price });

    const maxLine = max_price ? `max=${max_price}` : "max=—";
    const summary =
      `${t(lang, "SUMMARY_TITLE")}\n\n` +
      `${s.from.label} → ${s.to.label}\n` +
      `${s.date}\n` +
      `min=${min_seats}, ${maxLine}`;

    return ctx.reply(summary, confirmKeyboard(lang));
  }

  // Edit filters for existing watch
  if (s.step === "edit_filters") {
    const w = stmtGetWatch.get(s.editWatchId, chatId);
    if (!w) {
      clearSession(chatId);
      return ctx.reply("Not found.", mainMenu(lang));
    }

    let min_seats = w.min_seats || 1;
    let max_price = w.max_price ?? null;

    const lower = text.toLowerCase();
    if (lower === "ok") {
      // keep as is
    } else {
      for (const p of lower.split(/\s+/)) {
        if (p.startsWith("min=")) min_seats = Number(p.slice(4));
        if (p.startsWith("max=")) {
          const v = Number(p.slice(4));
          max_price = Number.isFinite(v) && v > 0 ? v : null;
        }
      }
    }

    min_seats = Number.isFinite(min_seats) && min_seats > 0 ? min_seats : 1;

    stmtUpdateFilters.run(min_seats, max_price, s.editWatchId, chatId);
    const backPage = s.backPage || 0;
    clearSession(chatId);
    await ctx.reply(t(lang, "UPDATED"));
    return renderWatchMenu(ctx, w.id, backPage);
  }

  return next();
});

/* =========================
   Notifications + worker
========================= */
function buildNotificationText(lang, w, matches) {
  const top = matches.slice(0, 5).map((m) => {
    const price = m.minTariff != null ? `, min: ${m.minTariff}` : "";
    const car = m.carType ? ` (${m.carType})` : "";
    const tn = `${m.trainType ? m.trainType + " " : ""}${m.trainNumber}`.trim();
    return `• ${tn} — ${m.freeSeats} seats${car}${price}`;
  });

  return `${t(lang, "NOTIF_TITLE")}\n${w.from_label} → ${w.to_label}\n${w.date}\n\n${top.join("\n")}`;
}

function updateWatchState(id, { available, sig, notifiedAt }) {
  db.prepare(
    `UPDATE watches SET last_available=?, last_sig=?, last_notified_at=? WHERE id=?`
  ).run(available ? 1 : 0, sig || null, notifiedAt || null, id);
}

function groupByQuery(watches) {
  const map = new Map();
  for (const w of watches) {
    const key = `${w.from_code}|${w.to_code}|${w.date}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }
  return map;
}

const limit = pLimit(2);

async function processGroup(key, group) {
  const [from_code, to_code, date] = key.split("|");
  let apiData;
  try {
    apiData = await fetchTrainsOnce({ from_code, to_code, date });
  } catch {
    return;
  }

  for (const w of group) {
    const matches = pickMatches(apiData, { max_price: w.max_price, min_seats: w.min_seats });
    const available = matches.length > 0;

    if (isQuietNow(w)) {
      updateWatchState(w.id, { available, sig: available ? makeSig(matches) : null, notifiedAt: w.last_notified_at });
      continue;
    }

    if (!available) {
      updateWatchState(w.id, { available: false, sig: null, notifiedAt: w.last_notified_at });
      continue;
    }

    const sig = makeSig(matches);
    const stateChanged = Number(w.last_available) === 0; // 0 -> 1
    const sigChanged = w.last_sig && w.last_sig !== sig;

    if ((stateChanged || sigChanged) && canNotify(w)) {
      const userLang = getLang(w.chat_id);
      const msg = buildNotificationText(userLang, w, matches);

      const kb = Markup.inlineKeyboard([
        [Markup.button.url(t(userLang, "BTN_OPEN_SITE"), `${ET_BASE}/ru/`)],
        [
          Markup.button.callback(t(userLang, "BTN_PAUSE_THIS"), `watch:toggle:${w.id}:0`),
          Markup.button.callback(t(userLang, "BTN_OPEN_LIST"), "open:list"),
        ],
      ]);

      try {
        await bot.telegram.sendMessage(w.chat_id, msg, kb);
        updateWatchState(w.id, { available: true, sig, notifiedAt: nowTashkent().toISO() });
      } catch {
        updateWatchState(w.id, { available: true, sig, notifiedAt: w.last_notified_at });
      }
    } else {
      updateWatchState(w.id, { available: true, sig, notifiedAt: w.last_notified_at });
    }
  }
}

async function checkLoop() {
  const watches = stmtAllActiveWatches.all();
  if (!watches.length) return;

  const groups = groupByQuery(watches);
  const tasks = [];

  for (const [key, group] of groups.entries()) {
    tasks.push(limit(() => processGroup(key, group)));
  }

  await Promise.allSettled(tasks);
}

setInterval(() => checkLoop().catch(() => {}), CHECK_INTERVAL_SEC * 1000);

bot.launch();
console.log("✅ Bot ishga tushdi");
