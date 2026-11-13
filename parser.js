// Rozpoznawanie poleceń (pisanych lub dyktowanych) — działa w całości na urządzeniu, także offline.

export const CATS = ["BIOTTS", "NESTMEDIC", "GENOMTEC", "ORTHOGET", "BIOACCURE", "TRENDCAPITAL", "INNE"];

// Jak dyktowanie zwykle zapisuje nazwy spółek (bez spacji, bez polskich znaków).
const ALIASES = {
  BIOTTS: ["biotts", "biots", "biotes", "bijots", "biotsy", "biottsu"],
  NESTMEDIC: ["nestmedic", "nestmedyk", "nestmedik", "nesmedic", "nestmedica"],
  GENOMTEC: ["genomtec", "genomtek", "genomtech", "genomteku", "genomteck"],
  ORTHOGET: ["orthoget", "ortoget", "ortogiet", "ortoged", "orthogetu", "ortogetu"],
  BIOACCURE: ["bioaccure", "bioacure", "bioakur", "bioakiur", "bioakjur", "bioakure", "bioacur"],
  TRENDCAPITAL: ["trendcapital", "trendkapital", "trendcapitalu", "trendkapitalu", "trendkapitał"],
  INNE: ["inne", "inny", "innych", "innego", "inna", "pozostale", "inneo"],
};

const VERBS = {
  add: ["dodaj", "dopisz", "wpisz", "zapisz", "dodac", "dopisac", "nowe", "dodajmy"],
  delete: ["usun", "skasuj", "wykresl", "wyrzuc", "usunac", "skreslic", "skresl"],
  done: ["odhacz", "zrobione", "zrobilem", "zrobilam", "zalatwione", "zalatwilem", "zalatwilam", "wykonane", "gotowe", "zaznacz", "odhaczyc", "zamknij"],
  undone: ["odznacz", "przywroc", "otworz"],
  edit: ["zmien", "popraw", "edytuj", "zamien", "zmienic"],
  move: ["przenies", "przesun", "przeniesc"],
  undo: ["cofnij"],
};
const VERB_OF = {};
for (const [op, list] of Object.entries(VERBS)) for (const v of list) VERB_OF[v] = op;

const STOP = new Set(["do", "z", "ze", "w", "we", "na", "i", "a", "o", "to", "ten", "ta", "te", "zadanie", "zadania", "sprawe", "punkt", "pozycje", "jako", "sie", "mi", "prosze", "dla", "od"]);

export function norm(s) {
  return String(s).toLowerCase().replace(/ł/g, "l")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Szuka nazwy spółki zaczynającej się od słowa `at` (1–3 słowa sklejone). Zwraca {cat, len} albo null.
function catAt(words, at) {
  let best = null;
  for (let len = 1; len <= 3 && at + len <= words.length; len++) {
    const joined = words.slice(at, at + len).join("");
    if (joined.length < 3) continue;
    for (const [cat, list] of Object.entries(ALIASES)) {
      for (const alias of list) {
        const tol = alias.length >= 8 ? 2 : alias.length >= 6 ? 1 : 0;
        const d = lev(joined, alias);
        if (d <= tol && (!best || d < best.d || (d === best.d && len > best.len))) best = { cat, len, d };
      }
    }
  }
  return best;
}

const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const cleanText = (s) => cap(s.replace(/^[\s:,\-–—]+|[\s,.;:\-–—]+$/g, ""));

function tokens(s) { return norm(s).split(" ").filter(Boolean); }

// Dopasowuje opis z polecenia do istniejącego zadania. Zwraca {item} | {ambiguous:[...]} | {none:true}.
export function findItem(query, items) {
  let q = tokens(query).filter((t) => !STOP.has(t));
  if (!q.length) q = tokens(query);
  if (!q.length || !items.length) return { none: true };
  const nq = norm(query);
  const scored = items.map((it) => {
    const it_t = tokens(it.text);
    let hits = 0;
    for (const t of q) {
      const p = t.slice(0, Math.min(5, t.length));
      if (it_t.some((w) => w.startsWith(p) || (w.length >= 4 && t.startsWith(w.slice(0, 5))))) hits++;
    }
    let score = hits / q.length;
    if (nq && norm(it.text).includes(nq)) score += 0.5;
    return { it, score };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (top.score < 0.5) return { none: true };
  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length > 1) return { ambiguous: tied.map((s) => s.it) };
  return { item: top.it };
}

// Rozbija polecenie na części i zamienia je na operacje.
// items: [{id, cat, text, done}]. Zwraca {ops:[...], msgs:[...]}.
export function parse(input, items) {
  const ops = [], msgs = [];
  const segs = String(input).split(/\s*(?:[.;!?](?:\s+|$)|\s+(?:a\s+)?potem\s+|\s+oraz\s+|\s+następnie\s+|\s+nastepnie\s+)\s*/i)
    .map((s) => s.trim()).filter(Boolean);

  for (const seg of segs) {
    const orig = seg.split(/\s+/);
    const pairs = orig.map((o) => ({ o, n: norm(o) })).filter((p) => p.n);
    while (pairs.length && ["potem", "a", "i", "nastepnie", "jeszcze", "teraz", "prosze"].includes(pairs[0].n)) pairs.shift();
    const W = pairs.map((p) => p.n.replace(/ /g, ""));
    const textFrom = (i, j = pairs.length) => cleanText(pairs.slice(i, j).map((p) => p.o).join(" "));
    if (!W.length) continue;

    let op = VERB_OF[W[0]] || null;
    let i = op ? 1 : 0;
    // „oznacz jako zrobione …”, „dodaj zadanie …”
    if (W[0] === "oznacz" && W[1] === "jako") { op = W[2] && W[2].startsWith("niezrob") ? "undone" : "done"; i = 3; }
    while (i < W.length && (W[i] === "zadanie" || W[i] === "jako" || W[i] === "mi")) i++;

    if (op === "undo") { ops.push({ op: "undo" }); continue; }

    if (!op) {
      const c = catAt(W, 0);
      if (c) { op = "add"; } else { msgs.push(`Nie rozumiem: „${seg}”. Zacznij od „dodaj”, „usuń”, „odhacz”, „zmień” albo „przenieś”.`); continue; }
    }

    // zakres spółki na początku: „do X”, „z X”, „w X” albo samo „X”
    let cat = null;
    if (["do", "z", "ze", "w", "we", "dla"].includes(W[i])) {
      const c = catAt(W, i + 1);
      if (c) { cat = c.cat; i += 1 + c.len; }
    } else {
      const c = catAt(W, i);
      if (c) { cat = c.cat; i += c.len; }
    }

    if (op === "add") {
      let end = W.length;
      if (!cat) {
        // „dodaj wysłać umowę do Genomtec”
        for (let k = W.length - 2; k > i; k--) {
          if (["do", "w", "dla"].includes(W[k])) {
            const c = catAt(W, k + 1);
            if (c && k + 1 + c.len === W.length) { cat = c.cat; end = k; break; }
          }
        }
      }
      const text = textFrom(i, end);
      if (!text) { msgs.push("Nie usłyszałem treści zadania."); continue; }
      ops.push({ op: "add", cat: cat || "INNE", text });
      msgs.push(`Dodano do ${cat || "INNE"}: ${text}`);
      continue;
    }

    if (op === "move") {
      let target = null, end = W.length;
      for (let k = W.length - 2; k >= i; k--) {
        if (["do", "w", "na"].includes(W[k])) {
          const c = catAt(W, k + 1);
          if (c && k + 1 + c.len === W.length) { target = c.cat; end = k; break; }
        }
      }
      if (!target) { msgs.push("Nie wiem, do której spółki przenieść. Powiedz np. „przenieś umowa do Orthoget”."); continue; }
      const pool = items.filter((t) => !cat || t.cat === cat);
      const r = findItem(textFrom(i, end), pool);
      if (report(r, textFrom(i, end), msgs)) continue;
      ops.push({ op: "move", id: r.item.id, cat: target });
      msgs.push(`Przeniesiono do ${target}: ${r.item.text}`);
      continue;
    }

    if (op === "edit") {
      const pool = items.filter((t) => !cat || t.cat === cat);
      let best = null;
      for (let k = i + 1; k < W.length - 1; k++) {
        if (W[k] !== "na") continue;
        const r = findItem(textFrom(i, k), pool);
        if (r.item && !best) best = { r, k };
      }
      if (!best) {
        const k = W.indexOf("na", i + 1);
        if (k < 0) { msgs.push("Powiedz: „zmień [stare] na [nowe]”."); continue; }
        report(findItem(textFrom(i, k), pool), textFrom(i, k), msgs);
        continue;
      }
      const text = textFrom(best.k + 1);
      ops.push({ op: "edit", id: best.r.item.id, text });
      msgs.push(`Zmieniono: ${best.r.item.text} → ${text}`);
      continue;
    }

    // delete / done / undone, opcjonalnie „… z X” na końcu
    let end = W.length;
    if (!cat) {
      for (let k = W.length - 2; k > i; k--) {
        if (["z", "ze", "w", "we"].includes(W[k])) {
          const c = catAt(W, k + 1);
          if (c && k + 1 + c.len === W.length) { cat = c.cat; end = k; break; }
        }
      }
    }
    let pool = items.filter((t) => !cat || t.cat === cat);
    if (op === "done") pool = pool.filter((t) => !t.done).length ? pool.filter((t) => !t.done) : pool;
    if (op === "undone") pool = pool.filter((t) => t.done);
    const q = textFrom(i, end);
    if (!q && cat && op === "delete") { msgs.push(`Powiedz, które zadanie usunąć z ${cat}.`); continue; }
    const r = findItem(q, pool);
    if (report(r, q, msgs)) continue;
    if (op === "delete") { ops.push({ op: "delete", id: r.item.id }); msgs.push(`Usunięto: ${r.item.text}`); }
    if (op === "done") { ops.push({ op: "done", id: r.item.id, done: true }); msgs.push(`Zrobione: ${r.item.text}`); }
    if (op === "undone") { ops.push({ op: "done", id: r.item.id, done: false }); msgs.push(`Przywrócono: ${r.item.text}`); }
  }
  return { ops, msgs };
}

function report(r, q, msgs) {
  if (r.none) { msgs.push(`Nie znalazłem zadania „${q}”.`); return true; }
  if (r.ambiguous) { msgs.push(`Pasuje kilka zadań (${r.ambiguous.map((t) => t.text).join("; ")}). Powiedz dokładniej.`); return true; }
  return false;
}
