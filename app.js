import { CATS, STATUS_CATS, parse, norm, catOf } from "./parser.js";

const DEFAULT_MOTTO = "Less noise. More mining.";
const APP_VERSION = "v34";
// Pozycja słowa zapisującego, jeśli jest ostatnim słowem tekstu („… zapisz”, „… Zapisz.”, dawne „… koniec”), inaczej -1.
// Tolerancja na błędy dyktowania: „Zapisz.”, „zapisze”, „zapiszę”, „Konieć”, „konie c”.
function trailingEndWord(text) {
  const words = []; const re = /[^\s.,!?;:]+/g; let t;
  while ((t = re.exec(text))) words.push({ i: t.index, n: norm(t[0]) });
  if (!words.length) return -1;
  const last = words[words.length - 1], prev = words[words.length - 2];
  const isEnd = (x) => ["zapisz", "zapisze", "zapiszcie", "koniec", "koniecz", "koniecc"].includes(x) ||
    (x.length >= 6 && x.length <= 7 && x.startsWith("konie") && x !== "koniem");
  if (isEnd(last.n)) return last.i;
  if (prev && isEnd(prev.n + last.n)) return prev.i;
  return -1;
}
// Podgląd zdarzeń mikrofonu: otwórz adres z „?debug”, np. …/todo/?debug
const DEBUG = /[?&]debug/.test(location.search);
const dbgLines = (() => { try { return JSON.parse(sessionStorage.getItem("tablica.dbg") || "[]"); } catch { return []; } })();
function dbg(msg) {
  if (!DEBUG) return;
  const t = new Date().toTimeString().slice(3, 8);
  dbgLines.push(t + " " + msg); if (dbgLines.length > 14) dbgLines.shift();
  let el = document.getElementById("dbg");
  if (!el) { el = document.createElement("pre"); el.id = "dbg"; document.body.append(el); }
  el.textContent = dbgLines.join("\n");
  try { sessionStorage.setItem("tablica.dbg", JSON.stringify(dbgLines)); } catch {}
}
// Każdy błąd pokazuje się na pasku statusu, żeby było go widać na telefonie (zrzut ekranu = diagnoza).
window.addEventListener("error", (e) => { try { note("Błąd: " + (e.message || e.error), true); } catch {} });
window.addEventListener("unhandledrejection", (e) => { try { note("Błąd: " + ((e.reason && (e.reason.code || e.reason.message)) || e.reason), true); } catch {} });
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const $ = (id) => document.getElementById(id);
const slug = (cat) => cat.toLowerCase().replace(/\s+/g, "-");   // „STATUS BETI” → „status-beti” (do id elementów)
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
    hidden: lsGet("hidden", []),
    setHidden(h) { s.hidden = h; lsSet("hidden", h); s.onChange(); },
  };
  return s;
}

async function firebaseStore(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(FB + "firebase-app.js"), import(FB + "firebase-auth.js"), import(FB + "firebase-firestore.js"),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  // Pamięć offline prowadzimy sami (localStorage), a Firestore służy tylko do wymiany z serwerem.
  // Wbudowana pamięć Firestore (IndexedDB) na iPhonie zawodziła: zapis szedł na serwer, a ekran telefonu pokazywał stary stan.
  //  • server  — ostatni stan z serwera (kopia w localStorage, więc działa też po uruchomieniu bez internetu),
  //  • pending — zmiany z tego urządzenia, jeszcze niepotwierdzone przez serwer (też w localStorage, wysyłane ponownie po starcie).
  // Ekran = server + pending, więc własne zmiany są widoczne zawsze i od razu.
  const db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() });
  let server = {}, pending = {}, unsub = [];
  const key = (k) => k + "." + s.uid;
  const savePending = () => lsSet(key("pend"), pending);

  const s = {
    motto: DEFAULT_MOTTO, meta: { pending: false, offline: false }, onChange: () => {}, uid: null, email: "",
    auth, A,
    get items() {
      const out = { ...server };
      for (const [id, p] of Object.entries(pending)) { if (p.del) delete out[id]; else out[id] = p.data; }
      return out;
    },
    start(cb) {
      s.onChange = cb;
      A.onAuthStateChanged(auth, (user) => {
        unsub.forEach((u) => u()); unsub = [];
        s.uid = user ? user.uid : null; s.email = user ? user.email : "";
        server = user ? lsGet(key("srv"), {}) : {};
        pending = user ? lsGet(key("pend"), {}) : {};
        s.motto = (user && lsGet(key("motto"), null)) || DEFAULT_MOTTO;
        s.hidden = (user && lsGet(key("hidden"), null)) || [];
        showLogin(!user);
        refreshMeta(); cb();
        if (!user) return;
        subscribe();
        flush();
        migrateLocal(s);
      });
      document.addEventListener("visibilitychange", () => {
        // iPhone zrywa połączenie aplikacji w tle — po powrocie łączymy się od nowa i dosyłamy zaległe zmiany.
        if (document.visibilityState === "visible" && s.uid) { subscribe(); flush(); }
      });
      window.addEventListener("online", () => { if (s.uid) { subscribe(); flush(); } });
    },
    put(id, data) { pending[id] = { data, t: Date.now() }; savePending(); refreshMeta(); s.onChange(); flush(); },
    del(id) { pending[id] = { del: true, t: Date.now() }; savePending(); refreshMeta(); s.onChange(); flush(); },
    setMotto(m) {
      s.motto = m; lsSet(key("motto"), m); s.onChange();
      F.setDoc(F.doc(db, "users", s.uid), { motto: m }, { merge: true }).catch(writeErr);
    },
    hidden: [],
    // schowane pola — zapisywane na koncie, więc widok jest taki sam na komputerze i telefonie
    setHidden(h) {
      s.hidden = h; lsSet(key("hidden"), h); s.onChange();
      F.setDoc(F.doc(db, "users", s.uid), { hidden: h }, { merge: true }).catch(writeErr);
    },
  };

  function refreshMeta() { s.meta = { pending: Object.values(pending).some((p) => !p.acked), offline: !navigator.onLine }; }

  function subscribe() {
    unsub.forEach((u) => u()); unsub = [];
    const uid = s.uid;
    unsub.push(F.onSnapshot(F.collection(db, "users", uid, "items"), { includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.fromCache) return;          // tylko pełny stan z serwera nadpisuje kopię
      const next = {};
      snap.forEach((d) => { next[d.id] = d.data(); });
      server = next; lsSet(key("srv"), server);
      // Potwierdzona zmiana schodzi z ekranowej nakładki dopiero, gdy stan z serwera naprawdę ją zawiera.
      // (Na iPhonie połączenie potrafi przysłać stary stan — wtedy nakładka trzyma zadanie na ekranie.)
      const now = Date.now();
      for (const [id, p] of Object.entries(pending)) {
        if (!p.acked) continue;
        const d = next[id];
        const seen = p.del ? !d : !!d && (d.updated || 0) >= (p.data.updated || 0);
        if (seen || now - p.acked > 10 * 60 * 1000) delete pending[id];
      }
      savePending(); refreshMeta(); s.onChange();
    }, (e) => { console.error(e); note("Błąd synchronizacji: " + (e.code || e.message), true); }));
    unsub.push(F.onSnapshot(F.doc(db, "users", uid), (d) => {
      if (d.metadata.fromCache) return;
      const m = (d.exists() && d.data().motto) || DEFAULT_MOTTO;
      if (m !== s.motto) { s.motto = m; lsSet(key("motto"), m); s.onChange(); }
      const h = d.exists() && Array.isArray(d.data().hidden) ? d.data().hidden : null;
      if (h && JSON.stringify(h) !== JSON.stringify(s.hidden)) { s.hidden = h; lsSet(key("hidden"), h); s.onChange(); }
    }, () => {}));
  }

  const inFlight = new Set();
  function flush() {
    if (!s.uid) return;
    for (const [id, p] of Object.entries(pending)) {
      if (p.acked || inFlight.has(id + p.t)) continue;
      inFlight.add(id + p.t);
      const ref = F.doc(db, "users", s.uid, "items", id);
      (p.del ? F.deleteDoc(ref) : F.setDoc(ref, p.data))
        .then(() => {
          // serwer potwierdził: przenosimy zmianę do kopii serwera i zdejmujemy z kolejki (o ile w międzyczasie nie było nowszej)
          if (pending[id] === p) { p.acked = Date.now(); savePending(); refreshMeta(); s.onChange(); }
        })
        .catch((e) => {
          if (e && (e.code === "permission-denied" || e.code === "invalid-argument")) {
            if (pending[id] === p) { delete pending[id]; savePending(); refreshMeta(); s.onChange(); }
            writeErr(e);
          }
        })
        .finally(() => inFlight.delete(id + p.t));
    }
  }

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
  // „Ustaw hasło” — gdy konto loguje się tylko przez Google (na iPhonie Google w Safari nie działa).
  const u = store && store.auth && store.auth.currentUser;
  $("setPass").hidden = show || !u;
  $("setPass").textContent = hasPassword(u) ? "Zmień hasło" : "Ustaw hasło";
}
const hasPassword = (u) => !!u && (u.providerData || []).some((p) => p.providerId === "password");
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

// Ustaw hasło (konto tylko z Google) / Zmień hasło (konto z hasłem) / Zapomniałem hasła
$("setPass").addEventListener("click", () => {
  const change = hasPassword(store.auth.currentUser);
  $("passTitle").textContent = change ? "Zmień hasło" : "Ustaw hasło";
  $("passInfo").textContent = change
    ? "Podaj obecne hasło i nowe. Na innych urządzeniach zaloguj się potem nowym hasłem."
    : "Dzięki hasłu zalogujesz się tym samym kontem na iPhonie (e-mail + hasło), bez Google.";
  $("curPass").hidden = $("curPassLabel").hidden = !change;
  $("curPass").required = change;
  $("passErr").textContent = "";
  $("passDlg").hidden = false;
  (change ? $("curPass") : $("newPass")).focus();
});
const closePass = () => { $("passDlg").hidden = true; $("curPass").value = $("newPass").value = $("newPass2").value = ""; };
$("passCancel").addEventListener("click", closePass);
$("passForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("newPass").value, b = $("newPass2").value;
  if (a.length < 6) { $("passErr").textContent = "Nowe hasło musi mieć co najmniej 6 znaków."; return; }
  if (a !== b) { $("passErr").textContent = "Nowe hasła się różnią."; return; }
  const u = store.auth.currentUser, A = store.A;
  const change = hasPassword(u);
  try {
    if (change) {
      await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, $("curPass").value));
      await A.updatePassword(u, a);
      note("Hasło zmienione. Na innych urządzeniach zaloguj się nowym hasłem.");
    } else {
      await A.linkWithCredential(u, A.EmailAuthProvider.credential(u.email, a));
      note("Hasło ustawione. Na iPhonie zaloguj się: " + u.email + " + to hasło.");
    }
    closePass(); showLogin(false);
  } catch (err) {
    $("passErr").textContent = {
      "auth/invalid-credential": "Obecne hasło jest nieprawidłowe.",
      "auth/wrong-password": "Obecne hasło jest nieprawidłowe.",
      "auth/missing-password": "Wpisz obecne hasło.",
      "auth/too-many-requests": "Za dużo prób. Spróbuj za kilka minut albo użyj „Zapomniałem hasła”.",
      "auth/requires-recent-login": "Ze względów bezpieczeństwa wyloguj się, zaloguj ponownie i od razu ustaw hasło.",
      "auth/weak-password": "Hasło jest za słabe (min. 6 znaków).",
      "auth/provider-already-linked": "To konto ma już hasło — użyj „Zmień hasło”.",
      "auth/credential-already-in-use": "Na ten e-mail istnieje już osobne konto z hasłem.",
      "auth/email-already-in-use": "Na ten e-mail istnieje już osobne konto z hasłem.",
    }[err.code] || "Nie udało się: " + (err.code || err.message);
  }
});
$("passForgot").addEventListener("click", async () => {
  const email = store.auth.currentUser && store.auth.currentUser.email;
  try {
    await store.A.sendPasswordResetEmail(store.auth, email);
    $("passErr").textContent = "Wysłano link do ustawienia nowego hasła na " + email + " (sprawdź też spam).";
  } catch (err) { $("passErr").textContent = "Nie udało się wysłać: " + (err.code || err.message); }
});

$("forgot").addEventListener("click", async () => {
  const email = $("email").value.trim();
  if (!email) { $("loginErr").textContent = "Wpisz swój e-mail w polu powyżej i kliknij „Zapomniałem hasła” jeszcze raz."; return; }
  try {
    await store.A.sendPasswordResetEmail(store.auth, email);
    $("loginErr").textContent = "Wysłano e-mail z linkiem do ustawienia hasła (sprawdź też spam).";
  } catch (err) { $("loginErr").textContent = AUTH_ERR[err.code] || "Nie udało się: " + (err.code || err.message); }
});

// ---------------- rendering ----------------
const todos = () => Object.entries(store.items).filter(([, d]) => d && d.type === "todo").map(([id, d]) => ({ id, ...d }));
const strip = ({ id, ...rest }) => rest;
let flashId = null, lastUndo = null;

function write(id, data) {
  if (data === null) store.del(id); else store.put(id, data);
  if (data && data.cat && (store.hidden || []).includes(data.cat)) setTimeout(() => note(`Zapisano w schowanym polu ${data.cat} — stuknij je na górze tablicy, żeby zobaczyć.`), 50);
}

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

const hideSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function setBoxHidden(cat, hide) {
  const cur = (store && store.hidden) || [];
  const next = hide ? [...new Set([...cur, cat])] : cur.filter((c) => c !== cat);
  store.setHidden(CATS.filter((c) => next.includes(c)));
}

function buildSheet() {
  const strip = document.createElement("div");
  strip.className = "hidden-strip"; strip.id = "hiddenStrip"; strip.hidden = true;
  sheet.append(strip);
  for (const cat of CATS) {
    const box = document.createElement("section");
    box.className = "box" + (cat === "INNE" ? " inne" : "") + (STATUS_CATS.includes(cat) ? " statusbox" : "");
    box.id = "box-" + slug(cat);
    const h = document.createElement("h2");
    const name = document.createElement("span"); name.textContent = cat;
    const n = document.createElement("span"); n.className = "n";
    const right = document.createElement("span"); right.className = "hright";
    const hide = document.createElement("button");
    hide.type = "button"; hide.className = "boxhide"; hide.innerHTML = hideSvg;
    hide.setAttribute("aria-label", "Schowaj pole " + cat); hide.title = "Schowaj pole";
    hide.addEventListener("click", () => setBoxHidden(cat, true));
    right.append(n, hide, boxMic(cat));
    h.append(name, right);
    const ul = document.createElement("ul");
    const add = document.createElement("input");
    add.className = "add"; add.type = "text"; add.id = "add-" + slug(cat);
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

const micSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" fill="currentColor"/><path d="M18 11.5a6 6 0 0 1-12 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
// Mikrofon w rogu pola spółki. Bez rozpoznawania mowy na iOS: etykieta pola „+ dodaj zadanie” (otwiera klawiaturę z dyktowaniem).
function boxMic(cat) {
  const noSR = !(window.SpeechRecognition || window.webkitSpeechRecognition);
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const el = document.createElement(noSR && isIOS ? "label" : "button");
  if (el.tagName === "LABEL") el.htmlFor = "add-" + slug(cat); else el.type = "button";
  el.className = "boxmic"; el.dataset.cat = cat; el.innerHTML = micSvg;
  el.setAttribute("aria-label", "Dyktuj zadanie do " + cat);
  return el;
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

// Schowane pola: znikają z siatki, a na górze tablicy zostaje etykieta (nazwa + liczba otwartych), która je odkrywa.
function renderHidden() {
  const hidden = store.hidden || [];
  // Układ siatki (6 kolumn): INNE na całą szerokość, spółki po 2 w rzędzie, pola STATUS po 3 w rzędzie.
  // Gdy część pól jest schowana, pozostałe dzielą rząd tak, żeby nie było dziur.
  const visible = CATS.filter((c) => !hidden.includes(c));
  const companies = visible.filter((c) => c !== "INNE" && !STATUS_CATS.includes(c));
  const statuses = visible.filter((c) => STATUS_CATS.includes(c));
  const span = {};
  visible.forEach((c) => { span[c] = c === "INNE" ? 6 : STATUS_CATS.includes(c) ? 2 : 3; });
  if (companies.length % 2 === 1) span[companies[companies.length - 1]] = 6;
  if (statuses.length === 1) span[statuses[0]] = 6;
  if (statuses.length === 2) statuses.forEach((c) => { span[c] = 3; });
  let pos = 0;
  for (const cat of CATS) {
    const box = $("box-" + slug(cat));
    box.hidden = hidden.includes(cat);
    box.classList.remove("col2", "wide", "span2", "span3");
    if (box.hidden) continue;
    const w = span[cat];
    if (pos + w > 6) pos = 0;
    box.classList.add(w === 6 ? "wide" : w === 2 ? "span2" : "span3");
    pos += w;
    if (pos === 6) { box.classList.add("col2"); pos = 0; }      // ostatnie w rzędzie: bez prawej linii
  }

  const strip = $("hiddenStrip");
  strip.hidden = !hidden.length;
  const label = document.createElement("span"); label.className = "hs-label"; label.textContent = "Schowane:";
  const chips = hidden.map((cat) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip";
    b.setAttribute("aria-label", "Pokaż pole " + cat);
    const nm = document.createElement("span"); nm.textContent = cat;
    b.append(nm);
    const open = boxes[cat] ? boxes[cat].open : 0;
    if (open) { const c = document.createElement("span"); c.className = "chip-n"; c.textContent = open; b.append(c); }
    b.addEventListener("click", () => setBoxHidden(cat, false));
    return b;
  });
  strip.replaceChildren(label, ...chips);
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
    boxes[cat].open = open;
  }
  renderHidden();
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
  note(msg || "Stuknij 🎤 na klawiaturze i mów, np. „dodaj Genomtec wysłać umowę zapisz”. Po słowie „zapisz” zadanie zapisze się samo.");
}
$("cmd").addEventListener("blur", () => { dictating = false; });

if (IOS && !SR) {
  // iOS otwiera klawiaturę tylko po prawdziwym stuknięciu w pole (programowe focus() bywa ignorowane, np. w Chrome).
  // Dlatego przycisk mikrofonu na iOS to <label for="cmd">: stuknięcie w niego to dla iOS stuknięcie w pole.
  const label = document.createElement("label");
  label.htmlFor = "cmd"; label.className = "mic"; label.id = "mic";
  label.setAttribute("aria-label", "Dyktuj polecenie");
  label.innerHTML = mic.innerHTML;
  mic.replaceWith(label);
  $("cmd").addEventListener("focus", () => {
    note("Stuknij 🎤 na klawiaturze i mów, np. „dodaj Genomtec wysłać umowę zapisz”. Po słowie „zapisz” zadanie zapisze się samo.");
  });
} else if (!SR) {
  mic.addEventListener("click", () => keyboardDictation("Ta przeglądarka nie rozpoznaje mowy. Użyj dyktowania systemowego (na Macu: dwa razy Fn)."));
} else {
  // Tryb dyktowania. Dwa wejścia:
  //  • mikrofon na dole — polecenia: „dodaj Genomtec wysłać umowę zapisz”,
  //  • mikrofon w rogu pola spółki — samo zadanie: „wysłać umowę koniec” trafia prosto do tego pola.
  // Po „koniec” zadanie się zapisuje, a mikrofon słucha dalej, aż klikniesz go ponownie (albo powiesz „stop”).
  let rec = null, listening = false, buffer = "", heard = false, watchdog = null, idle = null;
  let targetCat = null, activeBtn = null;
  const END = /(^|\s)koniec([\s.,!?]|$)/i;
  const STOP = /^\s*(stop|zakończ nagrywanie|wyłącz mikrofon)[\s.,!?]*$/i;
  const CANCEL = /(^|\s)anuluj([\s.,!?]|$)/i;
  const clearTargets = () => document.querySelectorAll(".box.target").forEach((b) => b.classList.remove("target"));

  const setTarget = (text) => {
    clearTargets();
    if (targetCat) { $("box-" + slug(targetCat)).classList.add("target"); return; }
    const m = norm(text).match(/^(dodaj|dopisz|wpisz|zapisz)\s+(?:do\s+)?(.+)/);
    if (!m) return;
    const cat = catOf(m[2]);
    if (cat) $("box-" + slug(cat)).classList.add("target");
  };
  const field = () => targetCat ? $("add-" + slug(targetCat)) : $("cmd");
  const show = (interim = "") => { const t = (buffer + " " + interim).trim(); field().value = t; setTarget(t); };

  function addToTarget(text) {
    const t = text.replace(/^[\s:,\-–—]+|[\s,.;:\-–—]+$/g, "");
    if (!t) return;
    const textCap = t.charAt(0).toUpperCase() + t.slice(1);
    const id = newId(); flashId = id;
    write(id, { type: "todo", cat: targetCat, text: textCap, done: false, created: Date.now(), updated: Date.now() });
    lastUndo = [[id, null]];
    note(`Dodano do ${targetCat}: ${textCap}`, false, true);
  }
  function commit(text) {
    if (targetCat) addToTarget(text);
    else { $("cmd").value = text; run(text); }
  }

  function stopListening(msg) {
    listening = false; clearTimeout(watchdog); clearTimeout(idle); clearTimeout(restartTimer); clearTimeout(endTimer);
    if (rec) { try { rec.stop(); } catch {} }
    if (activeBtn) { activeBtn.classList.remove("on"); activeBtn.setAttribute("aria-label", activeBtn === mic ? "Włącz mikrofon" : "Dyktuj zadanie do " + targetCat); }
    clearTargets();
    let left = buffer.trim();
    const cutL = trailingEndWord(left); if (cutL >= 0) left = left.slice(0, cutL).trim();
    if (left && targetCat) { addToTarget(left); field().value = ""; }       // w polu spółki zapisujemy też to, co bez „koniec”
    else if (left) note("Mikrofon wyłączony. Niezapisany tekst jest w polu — dokończ i wciśnij Enter.", true);
    else if (msg) note(msg);
    if (targetCat) field().value = "";
    buffer = ""; activeBtn = null; targetCat = null;
  }
  const bumpIdle = () => { clearTimeout(idle); idle = setTimeout(() => stopListening("Mikrofon wyłączył się po minucie ciszy."), 60000); };

  function consume() {
    if (CANCEL.test(buffer)) { buffer = ""; show(); note("Anulowano."); return; }
    let m;
    while ((m = buffer.match(END))) {
      const text = buffer.slice(0, m.index).trim();
      buffer = buffer.slice(m.index + m[0].length).trim();
      if (text) commit(text);
    }
    if (STOP.test(buffer)) { buffer = ""; stopListening("Mikrofon wyłączony."); }
  }

  // Tekst liczymy od początku nagrywania (wyniki ostateczne + bieżące) i pamiętamy, ile już zapisaliśmy.
  // Nie polegamy na „isFinal”: Safari na iPhonie potrafi nigdy nie oznaczyć wyniku jako ostatecznego.
  let consumed = 0, lastFull = "", restartTimer = null; // restartTimer: zostawiony dla zgodności

  // Słowo zapisujące: „zapisz” (działa też dawne „koniec”). Liczy się tylko jako OSTATNIE słowo wypowiedzi
  // i dopiero po krótkiej pauzie — dzięki temu „zapisz się na szkolenie” nie urwie zadania w połowie.
  let endTimer = null;
  function onTranscript(full, isFinal) {
    lastFull = full;
    clearTimeout(endTimer);
    const pendingText = full.slice(consumed);
    if (CANCEL.test(pendingText)) { consumed = full.length; buffer = ""; stopListening("Anulowano."); return; }
    buffer = pendingText.trim();
    if (STOP.test(buffer)) { consumed = full.length; buffer = ""; stopListening("Mikrofon wyłączony."); return; }
    const cut = trailingEndWord(buffer);
    if (cut >= 0) {
      const finish = () => {
        if (!listening) return;
        const text = buffer.slice(0, cut).trim();
        consumed = full.length; buffer = "";
        if (text) commit(text); else note("Nic nie zapisano — nie usłyszałem treści zadania.", true);
        stopListening();
      };
      if (isFinal) finish(); else endTimer = setTimeout(finish, 800);
    }
    if (listening) show();
  }

  // Jeden obiekt rozpoznawania mowy na całą wizytę. Safari na iPhonie po pierwszym użyciu po cichu ignoruje
  // NOWE obiekty (działało tylko za pierwszym razem) — dlatego używamy ciągle tego samego i uruchamiamy go ponownie
  // dopiero, gdy poprzednie nagrywanie naprawdę się zakończy (zdarzenie „end”).
  let recog = null, active = false, wantStart = false, sessionReady = false;
  const armWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => {
    if (listening && !heard) note(IOS
      ? "Nic nie słyszę. Sprawdź: Ustawienia → Ogólne → Klawiatura → Włącz dyktowanie, oraz zgodę na mikrofon dla Safari."
      : "Nic nie słyszę. Sprawdź, czy przeglądarka ma dostęp do mikrofonu (ikona w pasku adresu).", true);
  }, 8000); };

  function ensureRecog() {
    if (recog) return recog;
    const r = recog = new SR();
    // iPhone: tryb ciągły w Safari oddaje tekst tylko przy pierwszym nagraniu (kolejne: start, cisza, „aborted”).
    // Tryb jednej wypowiedzi działa za każdym razem — a i tak zapisujemy jedno zadanie na stuknięcie.
    r.lang = "pl-PL"; r.interimResults = true; r.continuous = !IOS; r.maxAlternatives = 1;
    r.onstart = () => { active = true; sessionReady = true; dbg("start (ciągły: " + r.continuous + ")"); };
    r.onspeechstart = () => dbg("speechstart");
    r.onnomatch = () => dbg("nomatch");
    r.onaudiostart = () => { dbg("audiostart"); if (listening) armWatchdog(); };
    r.onresult = (e) => {
      if (!listening || !sessionReady) { dbg("result pominięty (listening=" + listening + ", ready=" + sessionReady + ")"); return; }
      heard = true; bumpIdle();
      const full = Array.from(e.results).map((x) => x[0].transcript.trim()).join(" ").replace(/\s+/g, " ");
      dbg("result " + (e.results[e.results.length - 1].isFinal ? "F" : "i") + " #" + e.results.length + ": " + full.slice(-60));
      onTranscript(full, e.results[e.results.length - 1].isFinal);
    };
    r.onerror = (e) => {
      dbg("error " + e.error);
      if (!listening || wantStart) return;
      const m = {
        "not-allowed": IOS
          ? "Brak zgody na mikrofon. Ustawienia → Safari → Mikrofon → Zezwalaj (albo „aA” w pasku adresu → Ustawienia witryny)."
          : "Brak zgody na mikrofon. Kliknij ikonę kłódki w pasku adresu → Mikrofon → Zezwalaj, i przeładuj stronę.",
        "service-not-allowed": IOS
          ? "iPhone blokuje rozpoznawanie mowy. Włącz: Ustawienia → Ogólne → Klawiatura → Włącz dyktowanie (oraz Siri)."
          : "Przeglądarka blokuje rozpoznawanie mowy. Użyj Chrome albo dyktowania systemowego (na Macu: dwa razy Fn).",
        "network": "Rozpoznawanie mowy potrzebuje internetu. Offline użyj dyktowania systemowego (na Macu: dwa razy Fn).",
        "audio-capture": "Nie wykryto mikrofonu.",
      }[e.error];
      if (m) { note(m, true); stopListening(); }
    };
    r.onend = () => {
      active = false; sessionReady = false; dbg("end" + (wantStart ? " → start" : ""));
      if (wantStart) {
        wantStart = false;
        if (!listening) return;
        try { r.start(); active = true; }
        catch (err) { dbg("restart throw " + err.message); stopListening(); note("Mikrofon się nie uruchomił. Stuknij go jeszcze raz.", true); }
        return;
      }
      if (!listening) { if (IOS) reloadForNextRecording(); return; }
      // nagrywanie skończyło się samo (cisza) — zapisujemy to, co padło, i gasimy mikrofon
      clearTimeout(endTimer);
      let left = buffer.trim(); buffer = "";
      const cut = trailingEndWord(left); if (cut >= 0) left = left.slice(0, cut).trim();
      if (left) commit(left);
      stopListening(left ? "" : "Mikrofon wyłączony.");
      if (IOS) reloadForNextRecording();
    };
    return r;
  }

  function startRec() {
    const r = rec = ensureRecog();
    consumed = 0; lastFull = ""; sessionReady = false;
    if (active) { wantStart = true; dbg("czekam na koniec poprzedniego"); try { r.abort(); } catch {} return; }
    try { r.start(); active = true; dbg("start()"); }
    catch (err) { dbg("start throw " + err.message); wantStart = true; try { r.abort(); } catch {} }
  }

  function toggle(btn, cat) {
    if (listening && btn === activeBtn) { stopListening("Mikrofon wyłączony."); return; }   // ten sam przycisk = wyłącz
    if (listening) {
      // Inny przycisk: nie restartujemy mikrofonu (iPhone tego nie lubi) — tylko zmieniamy pole docelowe.
      const left = buffer.trim();
      if (left && targetCat) addToTarget(left);
      else if (left) { $("cmd").value = left; run(left); }
      if (targetCat) field().value = "";
      buffer = ""; consumed = lastFull.length;
      activeBtn.classList.remove("on");
      activeBtn.setAttribute("aria-label", activeBtn === mic ? "Włącz mikrofon" : "Dyktuj zadanie do " + targetCat);
      targetCat = cat; activeBtn = btn;
      btn.classList.add("on"); btn.setAttribute("aria-label", "Wyłącz mikrofon");
      setTarget(""); bumpIdle();
      note(cat ? `Teraz mów zadanie do ${cat}, na końcu „zapisz”.` : "Teraz mów polecenie, np. „dodaj Genomtec … zapisz”.");
      return;
    }
    listening = true; buffer = ""; heard = false; targetCat = cat; activeBtn = btn;
    btn.classList.add("on"); btn.setAttribute("aria-label", "Wyłącz mikrofon");
    setTarget("");
    note(cat
      ? `Słucham… Mów zadanie do ${cat}, na końcu powiedz „zapisz”.`
      : "Słucham… Powiedz np. „dodaj Genomtec wysłać umowę zapisz”.");
    bumpIdle();
    try { startRec(); } catch { stopListening(); keyboardDictation(); }
  }

  mic.addEventListener("click", () => toggle(mic, null));
  sheet.addEventListener("click", (e) => {
    const b = e.target.closest(".boxmic");
    if (b) toggle(b, b.dataset.cat);
  });
}

// „zapisz” wpisane lub podyktowane z klawiatury (np. dyktowanie na iPhonie) jako ostatnie słowo, po krótkiej pauzie,
// wykonuje polecenie bez wciskania „Idź”.
let kbEnd = null;
$("cmd").addEventListener("input", () => {
  clearTimeout(kbEnd);
  const el = $("cmd");
  const cut = trailingEndWord(el.value);
  if (cut < 0) return;
  kbEnd = setTimeout(() => {
    const c = trailingEndWord(el.value); if (c < 0) return;
    const cmdText = el.value.slice(0, c).trim();
    el.value = "";
    if (cmdText) run(cmdText);
  }, 900);
});

// iPhone: gdy otwiera się klawiatura, pasek poleceń ma stać tuż nad nią (mierzymy, o ile ją zasłania, i tylko tyle przesuwamy).
if (window.visualViewport) {
  const bar = document.querySelector(".top");
  const fit = () => {
    const vv = window.visualViewport;
    bar.style.transform = "";
    const overlap = bar.getBoundingClientRect().bottom - (vv.offsetTop + vv.height);
    if (overlap > 1) bar.style.transform = `translateY(-${Math.round(overlap)}px)`;
  };
  visualViewport.addEventListener("resize", fit);
  visualViewport.addEventListener("scroll", fit);
}

// Dyktowanie z klawiatury iOS nie zawsze zgłasza zmiany tekstu na bieżąco — dopóki pole jest aktywne, sprawdzamy je co pół sekundy.
let kTimer = null;
$("cmd").addEventListener("focus", () => {
  clearInterval(kTimer);
  let lastSeen = "";
  // Gdy dyktowanie z klawiatury nie zgłasza zmian, sprawdzamy pole sami: „zapisz” na końcu i tekst stoi w miejscu → wykonaj.
  kTimer = setInterval(() => {
    const v = $("cmd").value;
    if (v && v === lastSeen && trailingEndWord(v) >= 0) {
      clearTimeout(kbEnd);
      const cmdText = v.slice(0, trailingEndWord(v)).trim();
      $("cmd").value = ""; lastSeen = "";
      if (cmdText) run(cmdText);
      return;
    }
    lastSeen = v;
  }, 700);
});
$("cmd").addEventListener("blur", () => { clearInterval(kTimer); });

// Skróty klawiszowe (komputer): „/” — pole poleceń, „M” — mikrofon. Działają, gdy nie piszesz w polu.
document.addEventListener("keydown", (e) => {
  const a = document.activeElement;
  const typing = a && (a.tagName === "INPUT" || a.isContentEditable);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$("login").hidden) return;
  if (e.key === "/") { e.preventDefault(); $("cmd").focus(); }
  if ((e.key === "m" || e.key === "M") && !$("mic").hidden) { e.preventDefault(); $("mic").click(); }
});

// ---------------- rozpoznawanie mowy przez serwer (OpenAI) ----------------
// Gdy w config.js jest STT_URL, mikrofony nagrywają dźwięk i wysyłają go do naszego serwera (Cloudflare Worker),
// który zwraca tekst. Działa jednakowo na iPhonie i komputerze, bez przeładowań. Bez STT_URL — dawny sposób (Safari/Chrome).
const STT_URL = (window.STT_URL || "").trim();
const cloudReady = () => !!(STT_URL && store && store.auth && store.uid && navigator.mediaDevices && window.MediaRecorder);

const cloud = { rec: null };   // trwające nagranie: {btn, cat, mr, stream, ctx, timer, stopped}

function cloudSetTarget(cat) {
  document.querySelectorAll(".box.target").forEach((b) => b.classList.remove("target"));
  if (cat) $("box-" + slug(cat)).classList.add("target");
}
function cloudBtnOff(btn) { btn.classList.remove("on"); }

async function cloudToggle(btn, cat) {
  const r = cloud.rec;
  if (r && r.btn === btn) { r.spoke = true; cloudStop("send"); return; }   // ten sam mikrofon = koniec nagrania (wysyłamy zawsze)
  if (r) {                                                         // inny mikrofon w trakcie = zmiana pola
    cloudBtnOff(r.btn); r.btn = btn; r.cat = cat; btn.classList.add("on"); cloudSetTarget(cat);
    note(cat ? `Nagrywam do ${cat}…` : "Nagrywam polecenie…"); return;
  }
  if (!navigator.onLine) { note("Brak internetu — rozpoznawanie mowy wymaga połączenia. Wpisz zadanie ręcznie.", true); return; }

  // AudioContext tworzymy od razu w stuknięciu (iPhone pozwala na dźwięk tylko w reakcji na gest).
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = AC ? new AC() : null;
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  const rec = cloud.rec = { btn, cat, ctx, stopped: false, spoke: false };
  btn.classList.add("on"); cloudSetTarget(cat);
  note(cat ? `Mów zadanie do ${cat}. Zapisze się, gdy skończysz mówić.` : "Mów polecenie, np. „dodaj Genomtec wysłać umowę”.");

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    cloud.rec = null; cloudBtnOff(btn); cloudSetTarget(null); if (ctx) ctx.close().catch(() => {});
    note(e && e.name === "NotAllowedError"
      ? (IOS ? "Brak zgody na mikrofon. Ustawienia → Aplikacje → Safari → Mikrofon → Pozwól." : "Brak zgody na mikrofon. Kliknij ikonę w pasku adresu → Mikrofon → Zezwalaj.")
      : "Nie udało się włączyć mikrofonu.", true);
    return;
  }
  if (rec.stopped) { rec.stream.getTracks().forEach((t) => t.stop()); return; }   // wyłączony, zanim ruszył

  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/aac"].find((m) => window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
  const mr = rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    rec.stream.getTracks().forEach((t) => t.stop());
    if (rec.ctx) rec.ctx.close().catch(() => {});
    if (rec.mode !== "send") return;
    if (!rec.spoke) { note("Nic nie usłyszałem. Stuknij mikrofon i mów trochę głośniej.", true); return; }
    const blob = new Blob(chunks, { type: (mr.mimeType || mime || "audio/mp4").split(";")[0] });
    transcribe(blob, rec.cat, rec.btn);
  };
  mr.start(250);
  dbg("nagrywanie " + (mr.mimeType || mime || "?"));

  // Wykrywanie ciszy: po wypowiedzi 1,5 s ciszy kończy nagranie. Bez mowy przez 8 s — rezygnuje.
  let floor = 1, frames = 0, loud = 0, quietSince = 0;
  const started = Date.now();
  if (ctx) {
    const src = ctx.createMediaStreamSource(rec.stream);
    const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
    const buf = new Float32Array(an.fftSize);
    rec.timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      frames++;
      // poziom tła = najcichszy moment (powoli dopuszczamy wzrost), więc mowa od pierwszej sekundy nie zawyży tła
      floor = rms < floor ? rms : floor * 1.002;
      if (frames <= 3) return;
      const thr = Math.max(0.012, floor * 3);
      if (rms > thr) { loud++; quietSince = 0; if (loud >= 2) rec.spoke = true; }
      else { loud = 0; if (rec.spoke && !quietSince) quietSince = Date.now(); }
      if (rec.spoke && quietSince && Date.now() - quietSince > 1500) cloudStop("send");
      else if (!rec.spoke && Date.now() - started > 8000) cloudStop("send");
      else if (Date.now() - started > 45000) cloudStop("send");
    }, 100);
  } else {
    rec.spoke = true;                                                          // bez analizy dźwięku: kończysz stuknięciem
    rec.timer = setTimeout(() => cloudStop("send"), 30000);
  }
}

function cloudStop(mode) {
  const rec = cloud.rec; if (!rec) return;
  cloud.rec = null; rec.stopped = true; rec.mode = mode;
  clearInterval(rec.timer); clearTimeout(rec.timer);
  cloudBtnOff(rec.btn); cloudSetTarget(null);
  if (rec.mr && rec.mr.state !== "inactive") rec.mr.stop();
  else if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
}

async function transcribe(blob, cat, btn) {
  btn.classList.add("busy");
  note("Rozpoznaję…");
  try {
    const token = await store.auth.currentUser.getIdToken();
    const res = await fetch(STT_URL, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": blob.type || "audio/mp4" }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      dbg("stt " + res.status + " " + (data.error || "") + " " + (data.detail || ""));
      note({ 401: "Serwer mowy nie rozpoznał logowania. Wyloguj się i zaloguj ponownie.",
             403: "Ten e-mail nie ma dostępu do rozpoznawania mowy (ALLOWED_EMAILS w Cloudflare).",
             502: "Usługa rozpoznawania mowy odmówiła (sprawdź klucz i środki na koncie OpenAI)." }[res.status]
           || "Nie udało się rozpoznać mowy (błąd " + res.status + ").", true);
      return;
    }
    let text = String(data.text || "").trim();
    dbg("stt: " + text);
    const cut = trailingEndWord(text); if (cut >= 0) text = text.slice(0, cut);
    text = text.replace(/^[\s:,\-–—]+|[\s,.;:!?\-–—]+$/g, "");
    if (!text) { note("Nic nie rozpoznałem. Spróbuj jeszcze raz.", true); return; }
    if (cat) {
      const t = text.charAt(0).toUpperCase() + text.slice(1);
      const id = newId(); flashId = id;
      write(id, { type: "todo", cat, text: t, done: false, created: Date.now(), updated: Date.now() });
      lastUndo = [[id, null]];
      note(`Dodano do ${cat}: ${t}`, false, true);
    } else {
      $("cmd").value = text; run(text);
    }
  } catch (e) {
    dbg("stt wyjątek " + (e && e.message));
    note(navigator.onLine ? "Nie udało się połączyć z serwerem mowy." : "Brak internetu — rozpoznawanie mowy wymaga połączenia.", true);
  } finally { btn.classList.remove("busy"); }
}

// Przejmujemy kliknięcia mikrofonów, gdy serwer mowy jest skonfigurowany (przed dawną obsługą Safari/Chrome).
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("#mic, .boxmic");
  if (!b || !cloudReady()) return;
  e.preventDefault(); e.stopImmediatePropagation();
  cloudToggle(b, b.id === "mic" ? null : b.dataset.cat);
}, true);

// iPhone: Safari rozpoznaje mowę tylko RAZ na jedno załadowanie strony (kolejne nagrania: mikrofon włączony, zero tekstu).
// Dlatego po każdym nagraniu po cichu przeładowujemy stronę (z pamięci telefonu, ułamek sekundy).
// Zadanie jest już wtedy zapisane w kolejce na urządzeniu, a komunikat i miejsce przewinięcia wracają po przeładowaniu.
let reloading = false;
function reloadForNextRecording() {
  if (reloading) return; reloading = true;
  dbg("przeładowanie po nagraniu");
  try {
    sessionStorage.setItem("tablica.flash", JSON.stringify({ msg: noteMsg, warn: noteWarn }));
    sessionStorage.setItem("tablica.scroll", String(window.scrollY));
  } catch {}
  setTimeout(() => location.reload(), 350);
}
function restoreAfterReload() {
  try {
    const f = JSON.parse(sessionStorage.getItem("tablica.flash") || "null");
    const y = Number(sessionStorage.getItem("tablica.scroll") || 0);
    sessionStorage.removeItem("tablica.flash"); sessionStorage.removeItem("tablica.scroll");
    if (f && f.msg) note(f.msg, f.warn);
    if (y) { const go = () => window.scrollTo(0, y); go(); setTimeout(go, 300); setTimeout(go, 1200); }
  } catch {}
}

// Przycisk „Odśwież aplikację”: czyści zapamiętane pliki aplikacji i ładuje najnowszą wersję z serwera.
// Zadania zostają (są na koncie i w pamięci urządzenia), czyścimy tylko kopię plików aplikacji.
$("ver").textContent = "Wersja " + APP_VERSION;
$("refreshApp").addEventListener("click", async () => {
  const b = $("refreshApp");
  // Bez internetu nie ruszamy kopii aplikacji — działa zapisana wersja.
  let online = navigator.onLine;
  // jakakolwiek odpowiedź serwera (nawet 404) = jest sieć; bez sieci service worker zwraca błąd i fetch rzuca wyjątek
  if (online) { try { await fetch("__ping__?" + Date.now(), { cache: "no-store" }); } catch { online = false; } }
  if (!online) { note("Brak internetu — odśwież aplikację, gdy wróci połączenie. Do tego czasu działa zapisana wersja.", true); return; }
  b.classList.add("busy"); b.disabled = true;
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update().catch(() => {});
      const sw = navigator.serviceWorker.controller || reg.active;
      if (sw) {
        // pobierz komplet nowych plików; stara kopia jest podmieniana dopiero, gdy wszystkie się pobrały
        const res = await new Promise((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (ev) => resolve(ev.data);
          sw.postMessage({ type: "refresh" }, [ch.port2]);
          setTimeout(() => resolve({ ok: false, error: "timeout" }), 20000);
        });
        if (!res.ok) { dbg("refresh: " + res.error); note("Nie udało się pobrać nowej wersji (" + res.error + "). Spróbuj za chwilę.", true); b.classList.remove("busy"); b.disabled = false; return; }
      }
    }
  } catch (err) { dbg("refresh wyjątek " + (err && err.message)); }
  const url = new URL(location.href);
  url.searchParams.set("v", Date.now().toString(36));
  location.replace(url.toString());
});
// po odświeżeniu usuwamy znacznik z adresu (zostaje np. ?debug)
if (new URL(location.href).searchParams.has("v")) {
  const u = new URL(location.href); u.searchParams.delete("v");
  history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
}

// ---------------- boot ----------------
buildSheet();
window.__booted = true;   // strażnik w index.html: aplikacja wystartowała
(async () => {
  const cfg = window.FIREBASE_CONFIG;
  if (cfg && cfg.apiKey) {
    try { store = await firebaseStore(cfg); }
    catch (e) { console.error(e); store = localStore(); note("Nie udało się wczytać synchronizacji (brak internetu przy pierwszym uruchomieniu?). Działam lokalnie.", true); }
  } else store = localStore();
  store.start(render);
  restoreAfterReload();
  dbg("załadowano " + APP_VERSION);
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
