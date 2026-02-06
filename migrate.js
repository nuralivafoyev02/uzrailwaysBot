const Database = require("better-sqlite3");

const db = new Database("data.sqlite");
db.pragma("journal_mode = WAL");

// 1) jadval bormi?
const table = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='watches'`)
  .get();

if (!table) {
  console.log("watches table yo‘q — yangi schema yaratiladi");
} else {
  // 2) ustunlarni tekshiramiz
  const cols = db.prepare(`PRAGMA table_info(watches)`).all();
  const hasFromKey = cols.some((c) => c.name === "from_key");

  if (!hasFromKey) {
    console.log("Eski schema topildi. Migratsiya qilinyapti...");

    db.exec(`
      ALTER TABLE watches RENAME TO watches_old;

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
    `);

    // Eski jadvaldagi ustunlar: chat_id, from_code, to_code, date, max_price, min_seats, last_sig, created_at ...
    // from_key/to_key/from_label/to_label yo‘q bo‘lgani uchun vaqtincha code ni label qilib olamiz.
    // Keyin xohlasangiz mapping bilan label’larni to‘g‘rilab chiqasiz.

    const oldCols = cols.map((c) => c.name);
    const hasMin = oldCols.includes("min_seats");
    const hasMax = oldCols.includes("max_price");
    const hasLastSig = oldCols.includes("last_sig");
    const hasCreated = oldCols.includes("created_at");

    const selectParts = [
      "id",
      "chat_id",
      "from_code",
      "to_code",
      "date",
      hasMin ? "min_seats" : "1 AS min_seats",
      hasMax ? "max_price" : "NULL AS max_price",
      hasLastSig ? "last_sig" : "NULL AS last_sig",
      hasCreated ? "created_at" : "datetime('now') AS created_at",
    ];

    const rows = db.prepare(`SELECT ${selectParts.join(", ")} FROM watches_old`).all();

    const insert = db.prepare(`
      INSERT INTO watches(
        id, chat_id,
        from_key, from_code, from_label,
        to_key, to_code, to_label,
        date, min_seats, max_price,
        last_sig, created_at
      ) VALUES (
        @id, @chat_id,
        @from_key, @from_code, @from_label,
        @to_key, @to_code, @to_label,
        @date, @min_seats, @max_price,
        @last_sig, @created_at
      )
    `);

    const tx = db.transaction((items) => {
      for (const r of items) {
        insert.run({
          id: r.id,
          chat_id: r.chat_id,
          from_key: String(r.from_code),
          from_code: String(r.from_code),
          from_label: String(r.from_code),
          to_key: String(r.to_code),
          to_code: String(r.to_code),
          to_label: String(r.to_code),
          date: String(r.date),
          min_seats: Number(r.min_seats || 1),
          max_price: r.max_price === null ? null : Number(r.max_price),
          last_sig: r.last_sig || null,
          created_at: r.created_at || new Date().toISOString(),
        });
      }
    });

    tx(rows);

    // Eski jadvalni xohlasangiz o‘chirib yuboring:
    // db.exec(`DROP TABLE watches_old;`);
    console.log(`✅ Migratsiya tugadi. Ko‘chirildi: ${rows.length} ta watch.`);
  } else {
    console.log("Schema yangi. Migratsiya kerak emas.");
  }
}

db.close();
