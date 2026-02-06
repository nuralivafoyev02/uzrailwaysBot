/**
 * Ticket Watcher Bot (UzRail e-ticket)
 * - Wizard /watch (inline keyboard)
 * - Grouped polling per (from,to,date)
 * - Anti-spam: notify only on transition or signature change
 * - Quiet hours default: 23:00–07:00
 */

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const pLimit = require("p-limit");

const BOT_TOKEN = process.env.BOT_TOKEN || `7788299704:AAHBDNdSUym8Vp_TViU8VmmkIN25MUFI35o`;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN env yo‘q");

const CHECK_INTERVAL_SEC = Number(process.env.CHECK_INTERVAL_SEC || 30);
const TZ = "Asia/Tashkent";

// UzRail endpoints
const ET_BASE = "https://eticket.railway.uz";
const TRAINS_LIST_URL = `${ET_BASE}/api/v3/handbook/trains/list`;

// ======== STATIONS (MVP) ========
// Key: user-friendly name (lowercase, latin)
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

function stationByKey(key) {
  return STATIONS.find((s) => s.key === key);
}

// ======== DB ========
const DB_PATH = process.env.DB_PATH || "data.sqlite";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
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

  date TEXT NOT NULL,              -- YYYY-MM-DD
  min_seats INTEGER NOT NULL DEFAULT 1,
  max_price INTEGER,               -- optional

  quiet_enabled INTEGER NOT NULL DEFAULT 1,
  quiet_start TEXT NOT NULL DEFAULT '23:00', -- HH:mm
  quiet_end   TEXT NOT NULL DEFAULT '07:00', -- HH:mm

  last_available INTEGER NOT NULL DEFAULT 0,
  last_sig TEXT,
  last_notified_at TEXT,           -- ISO

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watches_query ON watches(from_code,to_code,date);
CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(chat_id);
`);

const stmtInsertWatch = db.prepare(`
  INSERT INTO watches(
    chat_id, from_key, from_code, from_label, to_key, to_code, to_label, date,
    min_seats, max_price
  ) VALUES (?,?,?,?,?,?,?,?,?,?)
`);

const stmtListWatches = db.prepare(`
  SELECT id, from_label, to_label, date, min_seats, max_price, quiet_enabled, quiet_start, quiet_end
  FROM watches
  WHERE chat_id=?
  ORDER BY id DESC
`);

const stmtDeleteWatch = db.prepare(`DELETE FROM watches WHERE id=? AND chat_id=?`);
const stmtUpdateQuiet = db.prepare(`UPDATE watches SET quiet_enabled=?, quiet_start=?, quiet_end=? WHERE chat_id=?`);
const stmtAllWatches = db.prepare(`SELECT * FROM watches`);

// ======== HTTP (cookies + xsrf) ========
const jar = new tough.CookieJar();
const http = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: { "User-Agent": "ticket-watch-bot/2.0" },
  })
);

async function ensureXsrf() {
  // Token olish uchun 1 marta main page
  try {
    await http.get(`${ET_BASE}/ru/`);
  } catch (_) {}
  // Cookie jar ichida XSRF bo‘lishi mumkin
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

// ======== PARSE + FILTER ========
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

  // Eng foydali 5tasini yuqoriga chiqarish
  matches.sort((a, b) => {
    // ko‘proq joy va arzonroq bo‘lsa yuqori
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
    matches
      .map((m) => [m.trainNumber, m.trainType, m.departureDate, m.carType, m.freeSeats, m.minTariff])
      .sort()
  );
  return crypto.createHash("sha1").update(s).digest("hex");
}

// ======== TIME / QUIET HOURS ========
function parseDateFlexible(input) {
  const raw = input.trim();

  // YYYY-MM-DD
  const iso = DateTime.fromISO(raw, { zone: TZ });
  if (iso.isValid) return iso.toFormat("yyyy-LL-dd");

  // DD.MM.YYYY
  const dm = DateTime.fromFormat(raw, "dd.MM.yyyy", { zone: TZ });
  if (dm.isValid) return dm.toFormat("yyyy-LL-dd");

  return null;
}

function nowTashkent() {
  return DateTime.now().setZone(TZ);
}

function isQuietNow(watch) {
  if (!watch.quiet_enabled) return false;

  const now = nowTashkent();
  const [sh, sm] = String(watch.quiet_start || "23:00").split(":").map(Number);
  const [eh, em] = String(watch.quiet_end || "07:00").split(":").map(Number);

  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

  // Quiet window midnightdan o‘tishi mumkin (23:00→07:00)
  if (end <= start) {
    // quiet if now >= start OR now < end
    return now >= start || now < end;
  }
  // normal window
  return now >= start && now < end;
}

function canNotify(watch) {
  // cooldown: kamida 90 soniya
  const last = watch.last_notified_at ? DateTime.fromISO(watch.last_notified_at, { zone: TZ }) : null;
  if (!last || !last.isValid) return true;
  return nowTashkent().diff(last, "seconds").seconds >= 90;
}

// ======== BOT UI (Wizard) ========
const bot = new Telegraf(BOT_TOKEN);

// Simple in-memory session (MVP). Productionda Redis/session store qilsa zo‘r.
const session = new Map(); // chatId -> { step, fromKey, toKey, date, min, max }

function setSession(chatId, data) {
  session.set(chatId, { ...(session.get(chatId) || {}), ...data });
}
function getSession(chatId) {
  return session.get(chatId);
}
function clearSession(chatId) {
  session.delete(chatId);
}

function stationsKeyboard(page = 0, prefix = "from") {
  const perPage = 8;
  const start = page * perPage;
  const chunk = STATIONS.slice(start, start + perPage);

  const rows = chunk.map((s) => [Markup.button.callback(s.label, `${prefix}:pick:${s.key}:${page}`)]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️", `${prefix}:page:${page - 1}`));
  if (start + perPage < STATIONS.length) nav.push(Markup.button.callback("➡️", `${prefix}:page:${page + 1}`));
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("Bekor qilish", `wiz:cancel`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendHelp(ctx) {
  await ctx.reply(
    "Buyruqlar:\n" +
      "/watch — yo‘nalish+sana tanlab kuzatuv qo‘shish\n" +
      "/watch buxoro toshkent 2026-02-20 max=500000 min=1 — tez qo‘shish\n" +
      "/list — kuzatuvlar\n" +
      "/stop 3 — ID bo‘yicha o‘chirish\n" +
      "/quiet off — tunda ham xabar yuborsin\n" +
      "/quiet 23:00 07:00 — quiet soatlari\n" +
      "/stations — shaharlar ro‘yxati"
  );
}

bot.start(async (ctx) => {
  await ctx.reply("Salom! Men bilet chiqishi bilan darhol ogohlantiraman.");
  await sendHelp(ctx);
});

bot.command("help", sendHelp);

bot.command("stations", async (ctx) => {
  const lines = STATIONS.map((s) => `• ${s.label} (${s.key})`);
  await ctx.reply("Hozircha mavjud shaharlar:\n" + lines.join("\n"));
});

// Quick add: /watch from to date [max=] [min=]
bot.command("watch", async (ctx) => {
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);

  // Wizard mode: if only "/watch"
  if (parts.length === 1) {
    clearSession(ctx.chat.id);
    setSession(ctx.chat.id, { step: "from", page: 0 });
    return ctx.reply("Qayerdan ketasiz? (shaharni tanlang)", stationsKeyboard(0, "from"));
  }

  // Args mode
  if (parts.length < 4) {
    return ctx.reply("Format: /watch <from> <to> <YYYY-MM-DD|DD.MM.YYYY> [max=500000] [min=1]");
  }

  const fromKey = parts[1].toLowerCase();
  const toKey = parts[2].toLowerCase();
  const date = parseDateFlexible(parts[3]);
  if (!date) return ctx.reply("Sana noto‘g‘ri. Masalan: 2026-02-20 yoki 20.02.2026");

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
    from.key, from.code, from.label,
    to.key, to.code, to.label,
    date,
    Number.isFinite(min_seats) ? min_seats : 1,
    Number.isFinite(max_price) ? max_price : null
  );

  await ctx.reply(`✅ Kuzatuv qo‘shildi. ID: ${info.lastInsertRowid}\n${from.label} → ${to.label} | ${date}`);
});

// Wizard callbacks
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Cancel
  if (data === "wiz:cancel") {
    clearSession(ctx.chat.id);
    await ctx.answerCbQuery();
    return ctx.editMessageText("Bekor qilindi. /watch dan qayta boshlang.");
  }

  // FROM station
  if (data.startsWith("from:page:")) {
    const page = Number(data.split(":")[2] || 0);
    setSession(ctx.chat.id, { step: "from", page });
    await ctx.answerCbQuery();
    return ctx.editMessageReplyMarkup(stationsKeyboard(page, "from").reply_markup);
  }

  if (data.startsWith("from:pick:")) {
    const [, , key] = data.split(":");
    const from = stationByKey(key);
    if (!from) return ctx.answerCbQuery("Topilmadi");

    setSession(ctx.chat.id, { step: "to", fromKey: from.key, from, page: 0 });
    await ctx.answerCbQuery();
    return ctx.editMessageText(`✅ Qayerdan: ${from.label}\nEndi qayerga borasiz?`, stationsKeyboard(0, "to"));
  }

  // TO station
  if (data.startsWith("to:page:")) {
    const page = Number(data.split(":")[2] || 0);
    setSession(ctx.chat.id, { step: "to", page });
    await ctx.answerCbQuery();
    return ctx.editMessageReplyMarkup(stationsKeyboard(page, "to").reply_markup);
  }

  if (data.startsWith("to:pick:")) {
    const [, , key] = data.split(":");
    const to = stationByKey(key);
    const s = getSession(ctx.chat.id);
    if (!to || !s?.from) return ctx.answerCbQuery("Xatolik");

    setSession(ctx.chat.id, { step: "date", toKey: to.key, to });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      `✅ Yo‘nalish: ${s.from.label} → ${to.label}\n` +
        `Sana kiriting:\n` +
        `Masalan: 2026-02-20 yoki 20.02.2026\n\n` +
        `Bekor qilish uchun /watch ni qayta bosing`
    );
  }

  // Done
  return ctx.answerCbQuery();
});

// Wizard date input (when step === date)
bot.on("text", async (ctx, next) => {
  const s = getSession(ctx.chat.id);
  if (!s || s.step !== "date") return next();

  const date = parseDateFlexible(ctx.message.text);
  if (!date) {
    return ctx.reply("Sana noto‘g‘ri. Masalan: 2026-02-20 yoki 20.02.2026");
  }

  // default filters
  setSession(ctx.chat.id, { step: "filters", date, min_seats: 1, max_price: null });

  await ctx.reply(
    `✅ Sana: ${date}\nEndi filtrlar (ixtiyoriy):\n` +
      `1) "min=2" (kamida 2 joy)\n` +
      `2) "max=500000" (narx limiti)\n\n` +
      `Yozing: masalan "min=1 max=600000"\n` +
      `Yoki shunchaki "ok" deb yuboring.`
  );
});

// Wizard filters input
bot.on("text", async (ctx, next) => {
  const s = getSession(ctx.chat.id);
  if (!s || s.step !== "filters") return next();

  let min_seats = 1;
  let max_price = null;

  const txt = ctx.message.text.trim().toLowerCase();
  if (txt !== "ok") {
    const parts = txt.split(/\s+/);
    for (const p of parts) {
      if (p.startsWith("min=")) min_seats = Number(p.slice(4));
      if (p.startsWith("max=")) max_price = Number(p.slice(4));
    }
  }

  const from = s.from;
  const to = s.to;

  const info = stmtInsertWatch.run(
    ctx.chat.id,
    from.key, from.code, from.label,
    to.key, to.code, to.label,
    s.date,
    Number.isFinite(min_seats) ? min_seats : 1,
    Number.isFinite(max_price) ? max_price : null
  );

  clearSession(ctx.chat.id);

  await ctx.reply(
    `✅ Kuzatuv qo‘shildi! ID: ${info.lastInsertRowid}\n` +
      `${from.label} → ${to.label} | ${s.date}\n` +
      `min=${Number.isFinite(min_seats) ? min_seats : 1}` +
      `${Number.isFinite(max_price) ? `, max=${max_price}` : ""}\n\n` +
      `Bot joy chiqsa xabar beradi.`
  );
});

bot.command("list", async (ctx) => {
  const rows = stmtListWatches.all(ctx.chat.id);
  if (!rows.length) return ctx.reply("Hozircha kuzatuv yo‘q. /watch bilan qo‘shing.");

  const lines = rows.map((r) => {
    const max = r.max_price ? ` max=${r.max_price}` : "";
    const q = r.quiet_enabled ? ` (quiet ${r.quiet_start}-${r.quiet_end})` : " (quiet off)";
    return `${r.id}) ${r.from_label} → ${r.to_label} | ${r.date} | min=${r.min_seats}${max}${q}`;
  });

  await ctx.reply(lines.join("\n"));
});

bot.command("stop", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const id = Number(parts[1]);
  if (!id) return ctx.reply("Format: /stop <id>");

  const del = stmtDeleteWatch.run(id, ctx.chat.id);
  if (del.changes) return ctx.reply("🗑 O‘chirildi.");
  return ctx.reply("Topilmadi (ID xato yoki seniki emas).");
});

// Quiet settings for ALL watches of this chat
bot.command("quiet", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);

  // /quiet off
  if (parts[1] && parts[1].toLowerCase() === "off") {
    stmtUpdateQuiet.run(0, "23:00", "07:00", ctx.chat.id);
    return ctx.reply("✅ Quiet o‘chirildi. Endi tunda ham xabar yuboradi.");
  }

  // /quiet 23:00 07:00
  const start = parts[1];
  const end = parts[2];
  const ok = (v) => /^\d{2}:\d{2}$/.test(v || "");
  if (!ok(start) || !ok(end)) {
    return ctx.reply("Format: /quiet off  YOKI  /quiet 23:00 07:00");
  }

  stmtUpdateQuiet.run(1, start, end, ctx.chat.id);
  return ctx.reply(`✅ Quiet yoqildi: ${start}–${end}`);
});

// ======== WORKER (Grouped polling) ========
const limit = pLimit(2); // bir vaqtda 2 ta query

function groupByQuery(watches) {
  const map = new Map();
  for (const w of watches) {
    const key = `${w.from_code}|${w.to_code}|${w.date}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }
  return map;
}

function buildNotificationText(w, matches) {
  const top = matches.slice(0, 5).map((m) => {
    const price = m.minTariff != null ? `, min narx: ${m.minTariff}` : "";
    const car = m.carType ? ` (${m.carType})` : "";
    const tn = `${m.trainType ? m.trainType + " " : ""}${m.trainNumber}`.trim();
    return `• ${tn} — ${m.freeSeats} ta joy${car}${price}`;
  });

  return (
    `🔥 Joy chiqdi!\n` +
    `${w.from_label} → ${w.to_label}\n` +
    `${w.date}\n\n` +
    top.join("\n") +
    `\n\nRasmiy saytda tekshirib tezroq xarid qiling: ${ET_BASE}/ru/`
  );
}

function updateWatchState(id, { available, sig, notifiedAt }) {
  const stmt = db.prepare(`
    UPDATE watches
    SET last_available=?, last_sig=?, last_notified_at=?
    WHERE id=?
  `);
  stmt.run(available ? 1 : 0, sig || null, notifiedAt || null, id);
}

async function processGroup(key, group) {
  const [from_code, to_code, date] = key.split("|");
  let apiData;
  try {
    apiData = await fetchTrainsOnce({ from_code, to_code, date });
  } catch (e) {
    // xohlasangiz log yozing
    return;
  }

  for (const w of group) {
    const matches = pickMatches(apiData, { max_price: w.max_price, min_seats: w.min_seats });
    const available = matches.length > 0;

    // Quiet hours: agar hozir quiet bo‘lsa, state update qilamiz, lekin notify yo‘q
    if (isQuietNow(w)) {
      updateWatchState(w.id, { available, sig: available ? makeSig(matches) : null, notifiedAt: w.last_notified_at });
      continue;
    }

    if (!available) {
      // Joy yo‘q bo‘lsa state update
      updateWatchState(w.id, { available: false, sig: null, notifiedAt: w.last_notified_at });
      continue;
    }

    // available bo‘lsa
    const sig = makeSig(matches);
    const stateChanged = Number(w.last_available) === 0;  // 0->1
    const sigChanged = w.last_sig && w.last_sig !== sig;

    // Notify shartlari:
    // 1) Yo‘qdan borga o‘tdi (eng asosiy)
    // 2) Yoki signature keskin o‘zgardi (masalan avval 1 joy edi, endi 6 joy) — lekin cooldown bilan
    if ((stateChanged || sigChanged) && canNotify(w)) {
      const msg = buildNotificationText(w, matches);
      try {
        await bot.telegram.sendMessage(w.chat_id, msg);
        updateWatchState(w.id, { available: true, sig, notifiedAt: nowTashkent().toISO() });
      } catch (_) {
        // yuborilmasa ham state ni yangilab qo‘yamiz
        updateWatchState(w.id, { available: true, sig, notifiedAt: w.last_notified_at });
      }
    } else {
      // notify shartiga tushmasa, faqat state
      updateWatchState(w.id, { available: true, sig, notifiedAt: w.last_notified_at });
    }
  }
}

async function checkLoop() {
  const watches = stmtAllWatches.all();
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
console.log("Bot ishga tushdi...");
