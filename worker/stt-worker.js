// Tablica spółek — serwer rozpoznawania mowy i „słówka na dziś” (Cloudflare Worker).
//
// POST /word  (JSON {avoid: {es: [...], en: [...]}}) → nowe słówko dnia wymyślone przez AI:
//   {"es": [słowo, znaczenie po polsku, zdanie, tłumaczenie], "en": [...]}
// POST /tts   (JSON {text, lang: "es"|"en"}) → nagranie mp3 przeczytanego tekstu (lektor OpenAI)
// POST /      (treść = nagranie audio) → rozpoznany tekst {"text": "..."}
//
// Aplikacja wysyła tu nagranie (POST, treść = plik audio) z tokenem logowania Firebase w nagłówku
// Authorization. Worker sprawdza token (podpis Google, projekt, ważność, dozwolony e-mail),
// przekazuje nagranie do OpenAI i zwraca rozpoznany tekst: {"text": "..."}.
//
// Ustawienia (Cloudflare → Worker → Settings → Variables and Secrets):
//   OPENAI_API_KEY       (Secret)  klucz API OpenAI
//   FIREBASE_PROJECT_ID  (Text)    np. todo-5e064
//   ALLOWED_EMAILS       (Text)    e-maile, które mogą korzystać (po przecinku)
//   ALLOWED_ORIGIN       (Text)    adres aplikacji, np. https://dimetylotryptaminy.github.io
//   MODEL                (Text, opcjonalnie) domyślnie gpt-4o-mini-transcribe
//   WORD_MODEL           (Text, opcjonalnie) model do słówek, domyślnie gpt-4o-mini
//   TTS_MODEL, TTS_VOICE (Text, opcjonalnie) lektor, domyślnie gpt-4o-mini-tts / coral

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_BYTES = 10 * 1024 * 1024;
let jwksCache = { keys: null, until: 0 };

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!env.OPENAI_API_KEY || !env.FIREBASE_PROJECT_ID) return json({ error: "server_not_configured" }, 500);

    // 1) kto pyta
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    let claims;
    try { claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID); }
    catch (e) { return json({ error: "unauthorized", detail: String(e.message || e) }, 401); }
    const allowed = (env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length || !allowed.includes(String(claims.email || "").toLowerCase())) return json({ error: "forbidden" }, 403);

    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path === "/word") return json(await dailyWord(req, env), 200);
    if (path === "/tts") {
      const r = await speech(req, env);
      if (r.error) return json(r, r.status && r.status < 500 ? 400 : 502);
      return new Response(r.audio, { headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=31536000" } });
    }

    // 2) nagranie
    const type = (req.headers.get("content-type") || "audio/webm").split(";")[0].trim();
    const audio = await req.arrayBuffer();
    if (!audio.byteLength) return json({ error: "empty_audio" }, 400);
    if (audio.byteLength > MAX_BYTES) return json({ error: "too_large" }, 413);
    const ext = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "mp4"
      : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "webm";

    // 3) rozpoznanie mowy
    const fd = new FormData();
    fd.append("file", new Blob([audio], { type }), "nagranie." + ext);
    fd.append("model", env.MODEL || "gpt-4o-mini-transcribe");
    fd.append("language", "pl");
    fd.append("prompt", "Lista zadań. Spółki: BIOTTS, NESTMEDIC, GENOMTEC, ORTHOGET, BIOACCURE, TRENDCAPITAL. Pola: STATUS BETI, STATUS KAROL, STATUS BIOTTS.");
    fd.append("response_format", "json");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: fd,
    });
    if (!r.ok) return json({ error: "stt_failed", status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
    const data = await r.json();
    return json({ text: String(data.text || "").trim() });
  },
};

// Lektor: naturalny głos OpenAI. Hiszpański z wymową z Hiszpanii (castellano), angielski brytyjski.
async function speech(req, env) {
  let body = {};
  try { body = await req.json(); } catch {}
  const text = String(body.text || "").trim().slice(0, 400);
  const lang = body.lang === "en" ? "en" : "es";
  if (!text) return { error: "empty_text", status: 400 };
  const instructions = lang === "es"
    ? "Habla en español de España (castellano peninsular), con pronunciación clara y natural, como un profesor nativo, a un ritmo ligeramente pausado."
    : "Speak natural British English, clearly, like a friendly native teacher, at a slightly slow pace.";
  const call = (payload) => fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, response_format: "mp3", ...payload }),
  });
  let r = await call({ model: env.TTS_MODEL || "gpt-4o-mini-tts", voice: env.TTS_VOICE || "coral", instructions });
  if (!r.ok && r.status !== 401 && r.status !== 429) r = await call({ model: "tts-1-hd", voice: "nova" });   // zapasowy model bez instrukcji
  if (!r.ok) return { error: "tts_failed", status: r.status, detail: (await r.text()).slice(0, 300) };
  return { audio: await r.arrayBuffer() };
}

// Słówko na dziś: jedno hiszpańskie i jedno angielskie, z przykładem i tłumaczeniem, bez powtórek z listy „avoid”.
async function dailyWord(req, env) {
  let body = {};
  try { body = await req.json(); } catch {}
  const clean = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).slice(0, 60)).slice(-400);
  const avoidEs = clean(body.avoid && body.avoid.es), avoidEn = clean(body.avoid && body.avoid.en);
  const prompt =
`Przygotuj „słówko na dziś” dla Polaka, który część roku mieszka w Hiszpanii (Sotogrande).
1) Jedno hiszpańskie słowo lub krótkie wyrażenie przydatne w codziennym życiu w Hiszpanii (zakupy, restauracja, dom, sąsiedzi, pogoda, transport, urzędy, rozmowy ze znajomymi). Bez słownictwa biznesowego. Rzeczowniki podaj z rodzajnikiem (el/la).
2) Jedno angielskie słowo, phrasal verb lub idiom na poziomie C1, używane na co dzień (rozmowy, emocje, sytuacje życiowe), nie typowo biznesowe.
Do każdego: znaczenie po polsku (krótko) i jedno KRÓTKIE, naturalne zdanie przykładowe (najwyżej 8 słów) oraz jego tłumaczenie na polski.
Nie używaj żadnego z tych słów hiszpańskich: ${avoidEs.join(", ") || "(brak)"}.
Nie używaj żadnego z tych słów angielskich: ${avoidEn.join(", ") || "(brak)"}.
Zwróć wyłącznie JSON: {"es":{"word":"","meaning":"","example":"","example_pl":""},"en":{"word":"","meaning":"","example":"","example_pl":""}}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.WORD_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.9,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) return { error: "word_failed", status: r.status, detail: (await r.text()).slice(0, 300) };
  const data = await r.json();
  let out;
  try { out = JSON.parse(data.choices[0].message.content); } catch { return { error: "bad_json" }; }
  const pick = (o) => o && ["word", "meaning", "example", "example_pl"].every((k) => typeof o[k] === "string" && o[k].trim())
    ? [o.word.trim(), o.meaning.trim(), o.example.trim(), o.example_pl.trim()] : null;
  const es = pick(out.es), en = pick(out.en);
  if (!es || !en) return { error: "bad_word" };
  return { es, en };
}

// Weryfikacja tokenu logowania Firebase (JWT RS256 podpisany przez Google).
async function verifyFirebaseToken(token, projectId, now = Math.floor(Date.now() / 1000)) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("bad token");
  const [h, p, sig] = parts;
  const header = JSON.parse(b64urlText(h));
  const payload = JSON.parse(b64urlText(p));
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad header");
  const jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(h + "." + p));
  if (!ok) throw new Error("bad signature");
  if (payload.aud !== projectId) throw new Error("bad audience");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("bad issuer");
  if (!payload.sub) throw new Error("no subject");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("expired");
  if (typeof payload.iat === "number" && payload.iat > now + 300) throw new Error("issued in future");
  return payload;
}

async function getJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error("jwks fetch failed");
  const maxAge = Number((r.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = { keys: (await r.json()).keys || [], until: Date.now() + maxAge * 1000 };
  return jwksCache.keys;
}

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

