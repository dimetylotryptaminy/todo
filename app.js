import { CATS, parse, norm, catOf } from "./parser.js";

const DEFAULT_MOTTO = "Less noise. More mining.";
const APP_VERSION = "v10";
// Każdy błąd pokazuje się na pasku statusu, żeby było go widać na telefonie (zrzut ekranu = diagnoza).
window.addEventListener("error", (e) => { try { note("Błąd: " + (e.message || e.error), true); } catch {} });
window.addEventListener("unhandledrejection", (e) => { try { note("Błąd: " + ((e.reason && (e.reason.code || e.reason.message)) || e.reason), true); } catch {} });
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const $ = (id) => document.getElementById(id);
const lsGet = (k, d) => { try { const v = localStorage.getItem("tablica." + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem("tablica." + k, JSON.stringify(v)); } catch {} };
const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------------- storage ----------------
// Both stores expose: start(onChange), put(id, data), del(id), setMotto(text)
// and keep `items` (id -> data), `motto`, `meta` ({pending, offline}).

function localStore() {
  const s = {
    items: lsGet("items", {}), motto: lsGet("motto", DEFAULT_MOTTO), meta: { local: true }, onChange: () => {},
    start(cb) { s.onChange = cb; cb(); },
    put(id, data) { s.items[id] = data; lsSet("items", s.items); s.onChange(); },
    del(id) { delete s.items[id]; lsSet("items", s.items); s.onChange(); },
    setMotto(m) { s.motto = m; lsSet("motto", m); s.onChange(); },
  };
  return s;
}

async function firebaseStore(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js"),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  const s = {
    items: {}, motto: DEFAULT_MOTTO, meta: { pending: false, offline: false }, onChange: () => {}, uid: null, email: "",
    auth, A,
    start(cb) {
      s.onChange = cb;
      let unsub = [];
      A.onAuthStateChanged(auth, (user) => {
        unsub.forEach((u) => u()); unsub = [];
        s.items = {}; s.uid = user ? user.uid : null; s.email = user ? user.email : "";
        showLogin(!user);
        if (!user) { cb(); return; }
        const itemsCol = F.collection(db, "users", user.uid, "items");
        unsub.push(F.onSnapshot(itemsCol, { includeMetadataChanges: true }, (snap) => {
          const next = {};
          snap.forEach((d) => { next[d.id] = d.data(); });
          s.items = next;
          s.meta = { pending: snap.metadata.hasPendingWrites, offline: snap.metadata.fromCache };
          cb();
        }, (e) => { console.error(e); note("Błąd synchronizacji: " + (e.code || e.message), true); }));
        unsub.push(F.onSnapshot(F.doc(db, "users", user.uid), (d) => {
          s.motto = (d.exists() && d.data().motto) || DEFAULT_MOTTO; cb();
        }, () => {}));
        migrateLocal(s);
      });
    },
    put(id, data) { F.setDoc(F.doc(db, "users", s.uid, "items", id), data).catch(writeErr); },
    del(id) { F.deleteDoc(F.doc(db, "users", s.uid, "items", id)).catch(writeErr); },
    setMotto(m) { F.setDoc(F.doc(db, "users", s.uid), { motto: m }, { merge: true }).catch(writeErr); },
  };
  return s;
}
function writeErr(e) { console.error(e); note("Nie udało się zapisać: " + (e.code || e.message), true); }

// Zadania dodane w trybie lokalnym trafiają na konto przy pierwszym logowaniu.
function migrateLocal(s) {
  const local = lsGet("items", {});
  const ids = Object.keys(local);
  if (!ids.length) return;
  for (const id of ids) s.put(id, local[id]);
  lsSet("items", {});
  note(`Przeniesiono ${ids.length} zadań z tego urządzenia na konto.`);
}

// ---------------- login ----------------
let store;
function showLogin(show) {
  $("login").hidden = !show;
  $("logout").hidden = show || !store || store.meta.local;
}
const AUTH_ERR = {
  "auth/invalid-credential": "Nieprawidłowy e-mail lub hasło.",
  "auth/wrong-password": "Nieprawidłowe hasło.",
  "auth/user-not-found": "Nie ma takiego konta. Kliknij „Załóż konto”.",
  "auth/email-already-in-use": "To konto już istnieje. Kliknij „Zaloguj”.",
  "auth/weak-password": "Hasło musi mieć co najmniej 6 znaków.",
  "auth/invalid-email": "Nieprawidłowy adres e-mail.",
  "auth/network-request-failed": "Brak internetu. Pierwsze logowanie wymaga połączenia.",
  "auth/too-many-requests": "Za dużo prób. Spróbuj za kilka minut.",
  "auth/operation-not-allowed": "Ten sposób logowania nie jest włączony w Firebase (Authentication → Sign-in method).",
  "auth/popup-blocked": "Przeglądarka zablokowała okienko logowania. Zezwól na wyskakujące okna albo zaloguj się e-mailem.",
  "auth/popup-closed-by-user": "Okienko logowania zostało zamknięte.",
  "auth/cancelled-popup-request": "Okienko logowania zostało zamknięte.",
  "auth/unauthorized-domain": "Ta domena nie jest dodana w Firebase (Authentication → Settings → Authorized domains).",
  "auth/account-exists-with-different-credential": "Na ten adres jest już konto z hasłem. Zaloguj się e-mailem i hasłem.",
};
$("google").addEventListener("click", async () => {
  $("loginErr").textContent = "";
  try {
    const provider = new store.A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await store.A.signInWithPopup(store.auth, provider);
  } catch (e) {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    $("loginErr").textContent = (AUTH_ERR[e.code] || "Nie udało się: " + (e.code || e.message)) +
      (standalone && !AUTH_ERR[e.code] ? " Na iPhonie w aplikacji z ikony zaloguj się e-mailem." : "");
  }
});
async function doAuth(create) {
  const email = $("email").value.trim(), pass = $("password").value;
  if (!email || pass.length < 6) { $("loginErr").textContent = "Podaj e-mail i hasło (min. 6 znaków)."; return; }
  $("loginErr").textContent = "";
  try {
    const fn = create ? store.A.createUserWithEmailAndPassword : store.A.signInWithEmailAndPassword;
    await fn(store.auth, email, pass);
  } catch (e) { $("loginErr").textContent = AUTH_ERR[e.code] || "Nie udało się: " + (e.code || e.message); }
}
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); doAuth(false); });
$("signUp").addEventListener("click", () => doAuth(true));
$("logout").addEventListener("click", () => store.A.signOut(store.auth));

// ---------------- rendering ----------------
const todos = () => Object.entries(store.items).filter(([, d]) => d && d.type === "todo").map(([id, d]) => ({ id, ...d }));
const strip = ({ id, ...rest }) => rest;
let flashId = null, lastUndo = null;

function write(id, data) { if (data === null) store.del(id); else store.put(id, data); }

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  return { week: Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7), year: y };
}
function weekInfo() {
  const now = new Date();
  const { week, year } = isoWeek(now);
  const total = isoWeek(new Date(year, 11, 28)).week;
  const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const f = (d) => d.toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
  return { week, total, range: f(mon) + " – " + f(sun) + " " + sun.getFullYear() };
}

const sheet = $("sheet");
const checkSvg = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6.5l2.6 2.5L10 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const boxes = {};

function buildSheet() {
  for (const cat of CATS) {
    const box = document.createElement("section");
    box.className = "box" + (cat === "INNE" ? " inne" : "");
    box.id = "box-" + cat.toLowerCase();
    const h = document.createElement("h2");
    const name = document.createElement("span"); name.textContent = cat;
    const n = document.createElement("span"); n.className = "n";
    h.append(name, n);
    const ul = document.createElement("ul");
    const add = document.createElement("input");
    add.className = "add"; add.type = "text"; add.id = "add-" + cat.toLowerCase();
    add.placeholder = "+ dodaj zadanie"; add.setAttribute("enterkeyhint", "done");
    add.setAttribute("aria-label", "Dodaj zadanie do " + cat);
    add.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        const text = add.value.trim(); if (!text) return;
        const id = newId(); flashId = id;
        write(id, { type: "todo", cat, text, done: false, created: Date.now(), updated: Date.now() });
        add.value = "";
      }
    });
    box.append(h, ul, add);
    sheet.append(box);
    boxes[cat] = { ul, n };
  }
  const foot = document.createElement("div"); foot.className = "foot";
  const wk = document.createElement("div"); wk.className = "week"; wk.id = "week";
  const m = document.createElement("div"); m.className = "motto"; m.id = "motto";
  m.contentEditable = "true"; m.spellcheck = false; m.setAttribute("role", "textbox"); m.setAttribute("aria-label", "Motto");
  m.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); m.blur(); } });
  m.addEventListener("blur", () => {
    const v = m.textContent.trim() || DEFAULT_MOTTO;
    if (v !== store.motto) store.setMotto(v); else m.textContent = v;
  });
  foot.append(wk, m);
  sheet.append(foot);
}

function itemEl(t) {
  const li = document.createElement("li");
  if (t.done) li.classList.add("done");
  if (t.id === flashId) { li.classList.add("flash"); flashId = null; }
  const chk = document.createElement("button");
  chk.className = "chk"; chk.type = "button"; chk.innerHTML = checkSvg;
  chk.setAttribute("aria-label", t.done ? "Oznacz jako niezrobione" : "Oznacz jako zrobione");
  chk.addEventListener("click", () => write(t.id, strip({ ...t, done: !t.done, updated: Date.now() })));
  const txt = document.createElement("span");
  txt.className = "txt"; txt.textContent = t.text; txt.contentEditable = "true"; txt.spellcheck = false;
  txt.setAttribute("role", "textbox"); txt.setAttribute("aria-label", "Treść zadania");
  txt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); txt.blur(); }
    if (e.key === "Escape") { txt.textContent = t.text; txt.blur(); }
  });
  txt.addEventListener("blur", () => {
    const v = txt.textContent.trim();
    if (!v) { lastUndo = [[t.id, strip(t)]]; write(t.id, null); note("Usunięto „" + t.text + "”.", false, true); }
    else if (v !== t.text) write(t.id, strip({ ...t, text: v, updated: Date.now() }));
  });
  const x = document.createElement("button");
  x.className = "x"; x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Usuń zadanie");
  x.addEventListener("click", () => { lastUndo = [[t.id, strip(t)]]; write(t.id, null); note("Usunięto „" + t.text + "”.", false, true); });
  li.append(chk, txt, x);
  return li;
}

function render() {
  if (!store) return;
  const a = document.activeElement;
  if (a && a.classList && (a.classList.contains("txt") || a.id === "motto")) return; // nie przeszkadzaj w edycji
  const all = todos();
  for (const cat of CATS) {
    const list = all.filter((t) => (CATS.includes(t.cat) ? t.cat : "INNE") === cat)
      .sort((x, y) => (x.done - y.done) || (x.created - y.created));
    boxes[cat].ul.replaceChildren(...list.map(itemEl));
    const open = list.filter((t) => !t.done).length;
    boxes[cat].n.textContent = list.length ? open + " otwarte" : "";
  }
  const w = weekInfo();
  const wk = $("week");
  wk.textContent = w.week + "/" + w.total;
  const s = document.createElement("small"); s.textContent = w.range + " · " + APP_VERSION + (store.meta.local ? " · lokalnie" : store.email ? " · " + store.email : ""); wk.append(s);
  $("motto").textContent = store.motto;
  renderStatus();
}
document.addEventListener("focusout", () => setTimeout(render, 0));
setInterval(() => { if (document.activeElement === document.body) render(); }, 60000);

let noteMsg = "", noteWarn = false, noteUndo = false, noteTimer;
function note(msg, warn = false, undo = false) {
  noteMsg = msg; noteWarn = warn; noteUndo = undo; renderStatus();
  clearTimeout(noteTimer); noteTimer = setTimeout(() => { noteMsg = ""; renderStatus(); }, 12000);
}
function renderStatus() {
  const el = $("status");
  el.replaceChildren();
  const span = (text, cls) => { const s = document.createElement("span"); s.textContent = text; if (cls) s.className = cls; el.append(s); };
  if (!store) return;
  if (store.meta.local) span("Tryb lokalny: zadania są tylko na tym urządzeniu.", "warn");
  else if (!navigator.onLine) span("Offline: zmiany wyślą się po połączeniu.", "warn");
  else if (store.meta.pending) span("Zapisuję…");
  else if (store.email) span("Zsynchronizowano · " + store.email, "ok");
  if (noteMsg) {
    span(noteMsg, noteWarn ? "warn" : "");
    if (noteUndo && lastUndo) {
      const b = document.createElement("button"); b.className = "ghost"; b.type = "button"; b.textContent = "Cofnij";
      b.addEventListener("click", undo);
      el.append(b);
    }
  }
}
function undo() {
  if (!lastUndo) { note("Nie ma czego cofnąć."); return; }
  for (const [id, data] of lastUndo) write(id, data);
  lastUndo = null; note("Cofnięto.");
}
window.addEventListener("online", renderStatus);
window.addEventListener("offline", renderStatus);

$("clearDone").addEventListener("click", () => {
  const done = todos().filter((t) => t.done);
  if (!done.length) { note("Nie ma zrobionych zadań."); return; }
  lastUndo = done.map((t) => [t.id, strip(t)]);
  for (const t of done) write(t.id, null);
  note("Usunięto zrobione: " + done.length + ".", false, true);
});

// ---------------- commands ----------------
function run(text) {
  const items = todos();
  const { ops, msgs } = parse(text, items);
  const byId = Object.fromEntries(items.map((t) => [t.id, t]));
  const undoList = [];
  let changed = 0;
  for (const o of ops) {
    if (o.op === "undo") { undo(); return; }
    if (o.op === "add") {
      const id = newId(); flashId = id; undoList.push([id, null]);
      write(id, { type: "todo", cat: o.cat, text: o.text, done: false, created: Date.now(), updated: Date.now() });
      changed++; continue;
    }
    const t = byId[o.id]; if (!t) continue;
    undoList.push([t.id, strip(t)]);
    if (o.op === "delete") write(t.id, null);
    if (o.op === "done") write(t.id, strip({ ...t, done: o.done, updated: Date.now() }));
    if (o.op === "edit") { flashId = t.id; write(t.id, strip({ ...t, text: o.text, updated: Date.now() })); }
    if (o.op === "move") { flashId = t.id; write(t.id, strip({ ...t, cat: o.cat, updated: Date.now() })); }
    changed++;
  }
  if (changed) { lastUndo = undoList; $("cmd").value = ""; }
  note(msgs.join(" · ") || "Nic nie zmieniono.", !changed, !!changed);
}
$("cmdForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("cmd").value.trim(); if (t) run(t);
});

// Mikrofon.
// iPhone/iPad: rozpoznawanie mowy w aplikacji z ekranu początkowego działa zawodnie (ikona pulsuje, nic się nie dzieje),
// więc przycisk otwiera klawiaturę, a dyktuje się mikrofonem na klawiaturze — to działa zawsze, także offline.
// Inne urządzenia: Web Speech API; gdy w ciągu kilku sekund nic nie przyjdzie, przełącza na klawiaturę.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const mic = $("mic");
mic.hidden = false;
let dictating = false;

function keyboardDictation(msg) {
  const cmd = $("cmd");
  cmd.focus();
  dictating = true;
  note(msg || "Stuknij 🎤 na klawiaturze i mów, np. „dodaj Genomtec wysłać umowę koniec”. Po słowie „koniec” zadanie zapisze się samo.");
}
$("cmd").addEventListener("blur", () => { dictating = false; });

if (IOS) {
  // iOS otwiera klawiaturę tylko po prawdziwym stuknięciu w pole (programowe focus() bywa ignorowane, np. w Chrome).
  // Dlatego przycisk mikrofonu na iOS to <label for="cmd">: stuknięcie w niego to dla iOS stuknięcie w pole.
  const label = document.createElement("label");
  label.htmlFor = "cmd"; label.className = "mic"; label.id = "mic";
  label.setAttribute("aria-label", "Dyktuj polecenie");
  label.innerHTML = mic.innerHTML;
  mic.replaceWith(label);
  $("cmd").addEventListener("focus", () => {
    note("Stuknij 🎤 na klawiaturze i mów, np. „dodaj Genomtec wysłać umowę koniec”. Po słowie „koniec” zadanie zapisze się samo.");
  });
} else if (!SR) {
  mic.addEventListener("click", () => keyboardDictation("Ta przeglądarka nie rozpoznaje mowy. Użyj dyktowania systemowego (na Macu: dwa razy Fn)."));
} else {
  // Tryb dyktowania (komputer): mikrofon słucha ciągle. Mówisz „dodaj Genomtec … koniec” — zadanie zapisuje się
  // po słowie „koniec”, a mikrofon słucha dalej, aż klikniesz go ponownie (albo powiesz „stop”).
  let rec = null, listening = false, buffer = "", heard = false, watchdog = null, idle = null;
  const END = /(^|\s)koniec([\s.,!?]|$)/i;
  const STOP = /^\s*(stop|zakończ nagrywanie|wyłącz mikrofon)[\s.,!?]*$/i;
  const CANCEL = /(^|\s)anuluj([\s.,!?]|$)/i;

  const setTarget = (text) => {
    document.querySelectorAll(".box.target").forEach((b) => b.classList.remove("target"));
    const m = norm(text).match(/^(dodaj|dopisz|wpisz|zapisz)\s+(?:do\s+)?(.+)/);
    if (!m) return;
    const cat = catOf(m[2]);
    if (cat) $("box-" + cat.toLowerCase()).classList.add("target");
  };
  const show = (interim = "") => { const t = (buffer + " " + interim).trim(); $("cmd").value = t; setTarget(t); };

  function stopListening(msg) {
    listening = false; clearTimeout(watchdog); clearTimeout(idle);
    if (rec) { try { rec.stop(); } catch {} }
    mic.classList.remove("on"); mic.setAttribute("aria-label", "Włącz mikrofon");
    document.querySelectorAll(".box.target").forEach((b) => b.classList.remove("target"));
    if (buffer.trim()) note("Mikrofon wyłączony. Niezapisany tekst jest w polu — powiedz „koniec” następnym razem albo wciśnij Enter.", true);
    else if (msg) note(msg);
  }
  const bumpIdle = () => { clearTimeout(idle); idle = setTimeout(() => stopListening("Mikrofon wyłączył się po minucie ciszy."), 60000); };

  function consume() {
    if (CANCEL.test(buffer)) { buffer = ""; show(); note("Anulowano."); return; }
    let m;
    while ((m = buffer.match(END))) {
      const cmdText = buffer.slice(0, m.index).trim();
      buffer = buffer.slice(m.index + m[0].length).trim();
      if (cmdText) { $("cmd").value = cmdText; run(cmdText); }
    }
    if (STOP.test(buffer)) { buffer = buffer.replace(STOP, " ").trim(); stopListening("Mikrofon wyłączony."); }
  }

  function startRec() {
    rec = new SR();
    rec.lang = "pl-PL"; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      heard = true; bumpIdle();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) buffer = (buffer + " " + r[0].transcript).trim(); else interim += r[0].transcript;
      }
      consume();
      if (listening) show(interim);
    };
    rec.onerror = (e) => {
      const m = {
        "not-allowed": "Brak zgody na mikrofon. Kliknij ikonę kłódki w pasku adresu → Mikrofon → Zezwalaj, i przeładuj stronę.",
        "service-not-allowed": "Przeglądarka blokuje rozpoznawanie mowy. Użyj Chrome albo dyktowania systemowego (na Macu: dwa razy Fn).",
        "network": "Rozpoznawanie mowy potrzebuje internetu. Offline użyj dyktowania systemowego (na Macu: dwa razy Fn).",
        "audio-capture": "Nie wykryto mikrofonu.",
      }[e.error];
      if (m) { note(m, true); stopListening(); }
    };
    rec.onend = () => { if (listening) { try { rec.start(); } catch { stopListening(); } } };
    rec.start();
  }

  mic.addEventListener("click", () => {
    if (listening) { stopListening("Mikrofon wyłączony."); return; }
    listening = true; buffer = ""; heard = false;
    mic.classList.add("on"); mic.setAttribute("aria-label", "Wyłącz mikrofon");
    note("Słucham… Powiedz np. „dodaj Genomtec wysłać umowę koniec”. Kliknij mikrofon, żeby skończyć.");
    bumpIdle();
    watchdog = setTimeout(() => {
      if (listening && !heard) note("Nic nie słyszę. Sprawdź, czy przeglądarka ma dostęp do mikrofonu (ikona w pasku adresu).", true);
    }, 8000);
    try { startRec(); } catch { stopListening(); keyboardDictation(); }
  });
}

// „koniec” wpisane lub podyktowane z klawiatury (np. dyktowanie na iPhonie) wykonuje polecenie bez wciskania „Idź”.
$("cmd").addEventListener("input", () => {
  const el = $("cmd");
  const m = el.value.match(/^(.*?)(?:^|\s)koniec[\s.,!?]*/i);
  if (!m) return;
  const cmdText = m[1].trim();
  const rest = el.value.slice(m[0].length);
  el.value = rest;
  if (cmdText) run(cmdText);
});

// iPhone: gdy otwiera się klawiatura, pasek poleceń przesuwa się nad nią.
if (window.visualViewport) {
  const bar = document.querySelector(".top");
  const fit = () => {
    const vv = window.visualViewport;
    const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    bar.style.transform = hidden > 0 ? `translateY(-${hidden}px)` : "";
  };
  visualViewport.addEventListener("resize", fit);
  visualViewport.addEventListener("scroll", fit);
}

// Skróty klawiszowe (komputer): „/” — pole poleceń, „M” — mikrofon. Działają, gdy nie piszesz w polu.
document.addEventListener("keydown", (e) => {
  const a = document.activeElement;
  const typing = a && (a.tagName === "INPUT" || a.isContentEditable);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$("login").hidden) return;
  if (e.key === "/") { e.preventDefault(); $("cmd").focus(); }
  if ((e.key === "m" || e.key === "M") && !$("mic").hidden) { e.preventDefault(); $("mic").click(); }
});

// ---------------- boot ----------------
buildSheet();
(async () => {
  const cfg = window.FIREBASE_CONFIG;
  if (cfg && cfg.apiKey) {
    try { store = await firebaseStore(cfg); }
    catch (e) { console.error(e); store = localStore(); note("Nie udało się wczytać synchronizacji (brak internetu przy pierwszym uruchomieniu?). Działam lokalnie.", true); }
  } else store = localStore();
  store.start(render);
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
