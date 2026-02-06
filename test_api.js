const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");

const BASE = "https://eticket.railway.uz";
const URL = `${BASE}/api/v3/handbook/trains/list`;

// MUHIM: cookie ko‘proq shu sahifalarda beriladi
const BOOT_URLS = [
  `${BASE}/`, 
  `${BASE}/en/pages/trains-page`,
  `${BASE}/ru/pages/trains-page`,
  `${BASE}/ru/`,
  `${BASE}/en/home`,
];

const from = process.argv[2] || "2900800";
const to = process.argv[3] || "2900000";
const date = process.argv[4] || "2026-02-20";

const jar = new tough.CookieJar();

// Browserga o‘xshash headerlar
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,uz;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

const http = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    timeout: 25000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: BROWSER_HEADERS,
  })
);

(async () => {
  // 1) Cookie/XSRF olish uchun bir nechta sahifani ketma-ket ochib ko‘ramiz
  for (const u of BOOT_URLS) {
    const r = await http.get(u);
    const setCookie = r.headers["set-cookie"];
    console.log("BOOT", u, "status:", r.status, "set-cookie:", setCookie ? "YES" : "NO");
    if (setCookie) break;
  }

  // 2) Cookie’larni ko‘ramiz
  const cookies = await jar.getCookies(BASE);
  console.log("cookies:", cookies.map(c => c.key).join(", ") || "(none)");

  // 3) XSRF cookie
  const xsrfCookie = cookies.find(c => c.key === "XSRF-TOKEN");
  const xsrf = xsrfCookie ? decodeURIComponent(xsrfCookie.value) : null;
  console.log("XSRF exists:", !!xsrf);

  // 4) POST
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Origin": BASE,
    "Referer": `${BASE}/ru/pages/trains-page`,
    "X-Requested-With": "XMLHttpRequest",
    ...BROWSER_HEADERS,
  };

  if (xsrf) {
    // ba'zi backendlar shuni kutadi, ba'zilari buni — ikkalasini ham beramiz
    headers["X-XSRF-TOKEN"] = xsrf;
    headers["X-CSRF-TOKEN"] = xsrf;
  }

  const payload = {
    directions: {
      forward: {
        date,
        depStationCode: String(from),
        arvStationCode: String(to),
      },
    },
  };

  const r2 = await http.post(URL, payload, { headers });

  console.log("POST status:", r2.status);
  if (r2.status !== 200) {
    console.log("POST data:", typeof r2.data === "string" ? r2.data.slice(0, 300) : r2.data);
    process.exit(0);
  }

  const trains = r2.data?.data?.directions?.forward?.trains || [];
  console.log("Trains:", trains.length);
  if (trains[0]) console.log("First train:", trains[0].number, trains[0].type, trains[0].departureDate);
})().catch(e => console.error("FATAL:", e.message));
