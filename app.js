import { parse, norm, catOf } from "./parser.js";

const DEFAULT_MOTTO = "Less noise. More mining.";
const APP_VERSION = "v47";
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
    fields: lsGet("fields", null),
    setFields(f) { s.fields = f; lsSet("fields", f); s.onChange(); },
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
        s.fields = (user && lsGet(key("fields"), null)) || null;
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
    fields: null,
    // lista pól (nazwy, kolejność, szerokości) — zapisywana na koncie, wspólna dla wszystkich urządzeń
    setFields(f) {
      s.fields = f; lsSet(key("fields"), f); s.onChange();
      F.setDoc(F.doc(db, "users", s.uid), { fields: f }, { merge: true }).catch(writeErr);
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
      const fl = d.exists() && Array.isArray(d.data().fields) && d.data().fields.length ? d.data().fields : null;
      if (fl && JSON.stringify(fl) !== JSON.stringify(s.fields)) { s.fields = fl; lsSet(key("fields"), fl); s.onChange(); }
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
  if (data && data.cat && (store.hidden || []).includes(data.cat)) setTimeout(() => note(`Zapisano w zminimalizowanym polu ${fieldName(data.cat)} — przywrócisz je z granatowej belki na dole.`), 50);
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

const hideSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17h12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/></svg>';
// ---------------- pola tablicy (można je dodawać, usuwać, zmieniać nazwę, szerokość i kolejność) ----------------
// Pole = {id, name, size}; size: "full" (cała szerokość) | "half" (pół) | "third" (1/3).
// Zadania wskazują pole przez id, więc zmiana nazwy niczego nie gubi. Domyślne pola mają id = dawne nazwy.
const DEFAULT_FIELDS = [
  { id: "INNE", name: "INNE", size: "full" },
  ...["BIOTTS", "NESTMEDIC", "GENOMTEC", "ORTHOGET", "BIOACCURE", "TRENDCAPITAL"].map((n) => ({ id: n, name: n, size: "half" })),
  ...["STATUS BETI", "STATUS KAROL", "STATUS BIOTTS"].map((n) => ({ id: n, name: n, size: "third" })),
];
const SIZE_SPAN = { full: 6, half: 3, third: 2 };
const fieldList = () => (store && Array.isArray(store.fields) && store.fields.length ? store.fields : DEFAULT_FIELDS);
const fieldIds = () => fieldList().map((f) => f.id);
const fieldName = (id) => (fieldList().find((f) => f.id === id) || {}).name || id;
const fallbackField = () => (fieldIds().includes("INNE") ? "INNE" : fieldIds()[0]);

// Minimalizacja jak w dawnym Windowsie: pole „zjeżdża” do granatowej belki na dole, przycisk na belce je przywraca.
const reduceMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
function minimize(cat) {
  const box = $("box-" + slug(cat));
  if (reduceMotion()) { setBoxHidden(cat, true); return; }
  box.classList.add("minimizing");
  setTimeout(() => { box.classList.remove("minimizing"); setBoxHidden(cat, true); }, 200);
}
function restore(cat) {
  setBoxHidden(cat, false);
  const box = $("box-" + slug(cat));
  if (!box) return;
  if (!reduceMotion()) { box.classList.add("restoring"); setTimeout(() => box.classList.remove("restoring"), 260); }
  setTimeout(() => box.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" }), 30);
}
function setBoxHidden(cat, hide) {
  const cur = (store && store.hidden) || [];
  const next = hide ? [...new Set([...cur, cat])] : cur.filter((c) => c !== cat);
  store.setHidden(fieldIds().filter((c) => next.includes(c)));
}

const editSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
let builtKey = "", foot = null;

function makeBox(f) {
  const cat = f.id;
  const box = document.createElement("section");
  // tło: wybrane w oknie edycji; pola bez wyboru zachowują dawny wygląd (pola 1/3 lekko szare)
  const bg = f.bg || (f.size === "third" ? "gray" : "none");
  box.className = "box" + (bg !== "none" ? " bg-" + bg : "");
  box.id = "box-" + slug(cat);
  const h = document.createElement("h2");
  const name = document.createElement("button");
  name.type = "button"; name.className = "fname"; name.title = "Edytuj pole";
  name.setAttribute("aria-label", "Edytuj pole " + f.name);
  const nm = document.createElement("span"); nm.textContent = f.name;
  name.append(nm); name.insertAdjacentHTML("beforeend", editSvg);
  name.addEventListener("click", () => openFieldDialog(cat));
  const n = document.createElement("span"); n.className = "n";
  const right = document.createElement("span"); right.className = "hright";
  const hide = document.createElement("button");
  hide.type = "button"; hide.className = "boxhide"; hide.innerHTML = hideSvg;
  hide.setAttribute("aria-label", "Minimalizuj pole " + f.name); hide.title = "Minimalizuj";
  hide.addEventListener("click", () => minimize(cat));
  right.append(n, hide, boxMic(cat));
  h.append(name, right);
  const ul = document.createElement("ul");
  const add = document.createElement("input");
  add.className = "add"; add.type = "text"; add.id = "add-" + slug(cat);
  add.placeholder = "+ dodaj zadanie"; add.setAttribute("enterkeyhint", "done");
  add.setAttribute("aria-label", "Dodaj zadanie do " + f.name);
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      const text = add.value.trim(); if (!text) return;
      const id = newId(); flashId = id;
      write(id, { type: "todo", cat, text, done: false, created: Date.now(), updated: Date.now() });
      add.value = "";
    }
  });
  box.append(h, ul, add);
  boxes[cat] = { ul, n, open: 0 };
  return box;
}

function buildSheet() {
  foot = document.createElement("div"); foot.className = "foot";
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
  ensureSheet();
}
// Przebudowa pól tylko wtedy, gdy zmieniła się ich lista (nazwy, kolejność, szerokości).
function ensureSheet() {
  const key = JSON.stringify(fieldList());
  if (key === builtKey) return;
  builtKey = key;
  sheet.querySelectorAll(".box").forEach((b) => b.remove());
  for (const k of Object.keys(boxes)) delete boxes[k];
  for (const f of fieldList()) sheet.insertBefore(makeBox(f), foot);
}

const micSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" fill="currentColor"/><path d="M18 11.5a6 6 0 0 1-12 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
// Mikrofon w rogu pola. Bez rozpoznawania mowy na iOS: etykieta pola „+ dodaj zadanie” (otwiera klawiaturę z dyktowaniem).
function boxMic(cat) {
  const noSR = !(window.SpeechRecognition || window.webkitSpeechRecognition);
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const el = document.createElement(noSR && isIOS ? "label" : "button");
  if (el.tagName === "LABEL") el.htmlFor = "add-" + slug(cat); else el.type = "button";
  el.className = "boxmic"; el.dataset.cat = cat; el.innerHTML = micSvg;
  el.setAttribute("aria-label", "Dyktuj zadanie do " + fieldName(cat));
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

// Układ (siatka 6 kolumn): pola idą po kolei rzędami według szerokości; niepełny rząd jest rozciągany,
// żeby nie było dziur. Zminimalizowane pola znikają z siatki i trafiają na granatową belkę.
function renderHidden() {
  const hidden = store.hidden || [];
  const visible = fieldList().filter((f) => !hidden.includes(f.id));
  const rows = []; let row = [], used = 0;
  for (const f of visible) {
    const w = SIZE_SPAN[f.size] || 3;
    if (used + w > 6) { rows.push(row); row = []; used = 0; }
    row.push({ f, w }); used += w;
  }
  if (row.length) rows.push(row);
  for (const r of rows) {
    const total = r.reduce((a, x) => a + x.w, 0);
    if (total < 6) { if (6 % r.length === 0) r.forEach((x) => { x.w = 6 / r.length; }); else r[r.length - 1].w += 6 - total; }
  }
  const spanOf = {}, lastInRow = new Set();
  rows.forEach((r) => { r.forEach((x) => { spanOf[x.f.id] = x.w; }); lastInRow.add(r[r.length - 1].f.id); });
  for (const f of fieldList()) {
    const box = $("box-" + slug(f.id));
    box.hidden = hidden.includes(f.id);
    box.style.gridColumn = box.hidden ? "" : "span " + spanOf[f.id];
    box.classList.toggle("col2", lastInRow.has(f.id));
  }

  const bar = $("taskbar");
  const hiddenIds = fieldIds().filter((id) => hidden.includes(id));
  bar.hidden = !hiddenIds.length;
  document.body.classList.toggle("has-taskbar", hiddenIds.length > 0);
  const tasks = hiddenIds.map((cat) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "task";
    const open = boxes[cat] ? boxes[cat].open : 0;
    b.setAttribute("aria-label", "Przywróć pole " + fieldName(cat) + (open ? ", otwarte zadania: " + open : ""));
    b.title = "Przywróć";
    const ico = document.createElement("span"); ico.className = "task-ico"; ico.setAttribute("aria-hidden", "true");
    const nm = document.createElement("span"); nm.className = "task-name"; nm.textContent = fieldName(cat);
    b.append(ico, nm);
    if (open) { const c = document.createElement("span"); c.className = "task-n"; c.textContent = open; b.append(c); }
    b.addEventListener("click", () => restore(cat));
    return b;
  });
  bar.replaceChildren(...tasks);
}

// ---------------- okno edycji pola ----------------
let editing = null;   // id edytowanego pola albo null przy dodawaniu
// 1 zadanie, 2–4 zadania, 5+ zadań (12–14 zadań)
const zadan = (n) => n + " " + (n === 1 ? "zadanie" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? "zadania" : "zadań");
function openFieldDialog(id) {
  editing = id;
  const f = id ? fieldList().find((x) => x.id === id) : { name: "", size: "half" };
  $("fieldTitle").textContent = id ? "Edytuj pole" : "Nowe pole";
  $("fieldName").value = f.name;
  document.querySelectorAll('input[name="fsize"]').forEach((r) => { r.checked = r.value === f.size; });
  const bg = f.bg || (id && f.size === "third" ? "gray" : "none");
  document.querySelectorAll('input[name="fbg"]').forEach((r) => { r.checked = r.value === bg; });
  $("fieldMove").hidden = !id;
  $("fieldDelete").hidden = !id;
  resetDelete();
  $("fieldErr").textContent = "";
  $("fieldDlg").hidden = false;
  setTimeout(() => $("fieldName").focus(), 30);
}
function closeFieldDialog() { $("fieldDlg").hidden = true; editing = null; }
let deleteArmed = false;
function resetDelete() { deleteArmed = false; $("fieldDelete").textContent = "Usuń pole"; $("fieldDelete").classList.remove("armed"); }

$("fieldCancel").addEventListener("click", closeFieldDialog);
$("fieldDlg").addEventListener("click", (e) => { if (e.target === $("fieldDlg")) closeFieldDialog(); });
$("fieldForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("fieldName").value.trim().replace(/\s+/g, " ");
  if (!name) { $("fieldErr").textContent = "Wpisz nazwę pola."; return; }
  const size = (document.querySelector('input[name="fsize"]:checked') || {}).value || "half";
  const bg = (document.querySelector('input[name="fbg"]:checked') || {}).value || "none";
  const list = fieldList().map((f) => ({ ...f }));
  if (editing) {
    const f = list.find((x) => x.id === editing); if (f) { f.name = name; f.size = size; f.bg = bg; }
    store.setFields(list);
    note(`Zapisano pole ${name}.`);
  } else {
    list.push({ id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, size, bg });
    store.setFields(list);
    note(`Dodano pole ${name} — jest na końcu tablicy.`);
    setTimeout(() => { const last = sheet.querySelectorAll(".box"); const b = last[last.length - 1]; if (b) b.scrollIntoView({ behavior: "smooth", block: "center" }); }, 60);
  }
  closeFieldDialog();
});
function moveField(dir) {
  const list = fieldList().map((f) => ({ ...f }));
  const i = list.findIndex((f) => f.id === editing), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  store.setFields(list);
  $("fieldErr").textContent = `Pozycja ${j + 1} z ${list.length}.`;
}
$("fieldUp").addEventListener("click", () => moveField(-1));
$("fieldDown").addEventListener("click", () => moveField(1));
$("fieldDelete").addEventListener("click", () => {
  const list = fieldList();
  if (list.length <= 1) { $("fieldErr").textContent = "Nie można usunąć ostatniego pola."; return; }
  const inField = todos().filter((t) => t.cat === editing);
  if (!deleteArmed) {
    deleteArmed = true;
    $("fieldDelete").classList.add("armed");
    $("fieldDelete").textContent = inField.length ? `Tak, usuń pole i ${zadan(inField.length)}` : "Tak, usuń pole";
    $("fieldErr").textContent = inField.length ? `Uwaga: w tym polu ${inField.length === 1 ? "jest" : "są"} ${zadan(inField.length)} — zostaną usunięte.` : "Kliknij jeszcze raz, żeby potwierdzić.";
    return;
  }
  const name = fieldName(editing), id = editing;
  for (const t of inField) write(t.id, null);
  store.setFields(list.filter((f) => f.id !== id));
  if ((store.hidden || []).includes(id)) store.setHidden(store.hidden.filter((h) => h !== id));
  closeFieldDialog();
  note(`Usunięto pole ${name}` + (inField.length ? ` i ${zadan(inField.length)}.` : "."));
});
$("addField").addEventListener("click", () => openFieldDialog(null));

function render() {
  try { renderInner(); }
  catch (e) { console.error(e); dbg("render: " + (e && (e.stack || e.message))); note("Błąd wyświetlania: " + (e && e.message), true); }
}
function renderInner() {
  if (!store) return;
  const a = document.activeElement;
  if (a && a.classList && (a.classList.contains("txt") || a.id === "motto")) return; // nie przeszkadzaj w edycji
  ensureSheet();
  const all = todos();
  const ids = fieldIds(), fb = fallbackField();
  for (const cat of ids) {
    const list = all.filter((t) => (ids.includes(t.cat) ? t.cat : fb) === cat)
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
  if (view === "calendar") renderCalendar();
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
  // „Zsynchronizowano” nie zajmuje już miejsca na dole — e-mail konta widać w stopce tablicy
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
    note(`Dodano do ${fieldName(targetCat)}: ${textCap}`, false, true);
  }
  function commit(text) {
    if (targetCat) addToTarget(text);
    else { $("cmd").value = text; run(text); }
  }

  function stopListening(msg) {
    listening = false; clearTimeout(watchdog); clearTimeout(idle); clearTimeout(restartTimer); clearTimeout(endTimer);
    if (rec) { try { rec.stop(); } catch {} }
    if (activeBtn) { activeBtn.classList.remove("on"); activeBtn.setAttribute("aria-label", activeBtn === mic ? "Włącz mikrofon" : "Dyktuj zadanie do " + fieldName(targetCat)); }
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
      activeBtn.setAttribute("aria-label", activeBtn === mic ? "Włącz mikrofon" : "Dyktuj zadanie do " + fieldName(targetCat));
      targetCat = cat; activeBtn = btn;
      btn.classList.add("on"); btn.setAttribute("aria-label", "Wyłącz mikrofon");
      setTarget(""); bumpIdle();
      note(cat ? `Teraz mów zadanie do ${fieldName(cat)}, na końcu „zapisz”.` : "Teraz mów polecenie, np. „dodaj Genomtec … zapisz”.");
      return;
    }
    listening = true; buffer = ""; heard = false; targetCat = cat; activeBtn = btn;
    btn.classList.add("on"); btn.setAttribute("aria-label", "Wyłącz mikrofon");
    setTarget("");
    note(cat
      ? `Słucham… Mów zadanie do ${fieldName(cat)}, na końcu powiedz „zapisz”.`
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
    note(cat ? `Nagrywam do ${fieldName(cat)}…` : "Nagrywam polecenie…"); return;
  }
  if (!navigator.onLine) { note("Brak internetu — rozpoznawanie mowy wymaga połączenia. Wpisz zadanie ręcznie.", true); return; }

  // AudioContext tworzymy od razu w stuknięciu (iPhone pozwala na dźwięk tylko w reakcji na gest).
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = AC ? new AC() : null;
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  const rec = cloud.rec = { btn, cat, ctx, stopped: false, spoke: false };
  btn.classList.add("on"); cloudSetTarget(cat);
  note(cat ? `Mów zadanie do ${fieldName(cat)}. Zapisze się, gdy skończysz mówić.` : "Mów polecenie, np. „dodaj Genomtec wysłać umowę”.");

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
    // przy ciszy/szumie rozpoznawanie potrafi „oddać” tekst podpowiedzi zamiast mowy — takie wyniki pomijamy
    if (/lista zadań\.?\s*(spółki|pola)|spółki:\s*biotts,\s*nestmedic/i.test(text)) text = "";
    dbg("stt: " + text);
    const cut = trailingEndWord(text); if (cut >= 0) text = text.slice(0, cut);
    text = text.replace(/^[\s:,\-–—]+|[\s,.;:!?\-–—]+$/g, "");
    if (!text) { note("Nic nie rozpoznałem. Spróbuj jeszcze raz.", true); return; }
    if (cat) {
      const t = text.charAt(0).toUpperCase() + text.slice(1);
      const id = newId(); flashId = id;
      write(id, { type: "todo", cat, text: t, done: false, created: Date.now(), updated: Date.now() });
      lastUndo = [[id, null]];
      note(`Dodano do ${fieldName(cat)}: ${t}`, false, true);
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


// ======================= KALENDARZ ROCZNY =======================
// Wydarzenia (wyjazdy, przyjazdy, delegacje, wakacje…) są zapisywane tak jak zadania (ten sam zbiór na koncie,
// ta sama kolejka offline), tylko z typem "event": {type, title, kind, start: "RRRR-MM-DD", end: "RRRR-MM-DD"}.
const KINDS = { trip: "Wyjazd", guest: "Przyjazd gości", work: "Delegacja", holiday: "Wakacje", other: "Inne" };
const MONTHS = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
const MONTHS_GEN = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
const WD = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];
const events = () => Object.entries(store.items).filter(([, d]) => d && d.type === "event").map(([id, d]) => ({ id, ...d }));
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayISO = () => iso(new Date());

// Święta ustawowo wolne w Polsce (stałe + ruchome od Wielkanocy).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31),
    da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mo - 1, da);
}
function holidays(y) {
  const out = {}, add = (d, n) => { out[iso(d)] = n; };
  [[1, 1, "Nowy Rok"], [1, 6, "Trzech Króli"], [5, 1, "Święto Pracy"], [5, 3, "Święto Konstytucji 3 Maja"], [8, 15, "Wniebowzięcie NMP"],
   [11, 1, "Wszystkich Świętych"], [11, 11, "Święto Niepodległości"], [12, 25, "Boże Narodzenie"], [12, 26, "Drugi dzień Świąt"]]
    .forEach(([m, d, n]) => add(new Date(y, m - 1, d), n));
  if (y >= 2025) add(new Date(y, 11, 24), "Wigilia");
  const e = easter(y), shift = (n) => new Date(e.getFullYear(), e.getMonth(), e.getDate() + n);
  add(e, "Wielkanoc"); add(shift(1), "Poniedziałek Wielkanocny"); add(shift(49), "Zielone Świątki"); add(shift(60), "Boże Ciało");
  return out;
}

// Kalendarz zaczyna się od 2027 roku (wcześniejszych lat nie pokazujemy).
const CAL_MIN_YEAR = 2027;
let calYear = Math.max(new Date().getFullYear(), CAL_MIN_YEAR);
let calMonth = new Date().getFullYear() < CAL_MIN_YEAR ? 0 : new Date().getMonth();
const phoneMQ = window.matchMedia("(max-width: 640px)");
const phoneCal = () => phoneMQ.matches;
phoneMQ.addEventListener ? phoneMQ.addEventListener("change", () => { if (view === "calendar") renderCalendar(); }) : null;
function shiftMonth(d) {
  if (d < 0 && calYear <= CAL_MIN_YEAR && calMonth === 0) return;
  calMonth += d;
  if (calMonth < 0) { calMonth = 11; calYear--; } else if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}
const fmtRange = (ev) => {
  const a = parseISO(ev.start), b = parseISO(ev.end);
  if (ev.start === ev.end) return a.getDate() + " " + MONTHS_GEN[a.getMonth()];
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return a.getDate() + "–" + b.getDate() + " " + MONTHS_GEN[a.getMonth()];
  return a.getDate() + " " + MONTHS_GEN[a.getMonth()] + " – " + b.getDate() + " " + MONTHS_GEN[b.getMonth()] + (a.getFullYear() !== b.getFullYear() ? " " + b.getFullYear() : "");
};
const days = (ev) => Math.round((parseISO(ev.end) - parseISO(ev.start)) / 864e5) + 1;

function evChip(ev, withDates) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "evchip k-" + (KINDS[ev.kind] ? ev.kind : "other");
  b.title = KINDS[ev.kind] || "Inne";
  const dot = document.createElement("span"); dot.className = "evdot"; dot.setAttribute("aria-hidden", "true");
  const t = document.createElement("span"); t.className = "evtext";
  t.textContent = (withDates ? fmtRange(ev) + " · " : (ev.start === ev.end ? parseISO(ev.start).getDate() : parseISO(ev.start).getDate() + "–" + parseISO(ev.end).getDate()) + " · ") + ev.title;
  b.append(dot, t);
  b.setAttribute("aria-label", "Edytuj: " + ev.title + ", " + fmtRange(ev));
  b.addEventListener("click", () => openEventDialog(ev.id));
  return b;
}

// Bezpieczne rysowanie: błąd nie zostawia pustego ekranu, tylko pokazuje treść (zrzut ekranu = diagnoza).
function renderCalendar() {
  try { renderCalendarInner(); }
  catch (e) {
    console.error(e); dbg("kalendarz: " + (e && (e.stack || e.message)));
    const p = document.createElement("pre"); p.className = "boot-err";
    p.textContent = "Kalendarz nie narysował się (" + APP_VERSION + "):\n" + (e && (e.message || e)) + "\n" + String(e && e.stack || "").split("\n").slice(0, 4).join("\n");
    $("calendar").replaceChildren(p);
  }
}
function renderCalendarInner() {
  const root = $("calendar");
  const evs = events().filter((e) => e.start && e.end).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const today = todayISO();
  const hol = holidays(calYear);

  // nagłówek: rok + dodawanie
  const head = document.createElement("div"); head.className = "cal-head";
  const prev = document.createElement("button"); prev.type = "button"; prev.className = "yearbtn"; prev.textContent = "‹"; prev.setAttribute("aria-label", "Poprzedni rok");
  prev.disabled = calYear <= CAL_MIN_YEAR;
  prev.addEventListener("click", () => { if (calYear > CAL_MIN_YEAR) { calYear--; renderCalendar(); } });
  const yr = document.createElement("h2"); yr.className = "cal-year"; yr.textContent = calYear;
  const next = document.createElement("button"); next.type = "button"; next.className = "yearbtn"; next.textContent = "›"; next.setAttribute("aria-label", "Następny rok");
  next.addEventListener("click", () => { calYear++; renderCalendar(); });
  const yearBox = document.createElement("div"); yearBox.className = "yearnav"; yearBox.append(prev, yr, next);
  const addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn cal-add"; addBtn.textContent = "+ Dodaj wydarzenie";
  addBtn.addEventListener("click", () => openEventDialog(null, today.startsWith(String(calYear)) ? today : calYear + "-01-01"));
  head.append(yearBox, addBtn);

  // legenda
  const legend = document.createElement("div"); legend.className = "legend";
  for (const [k, n] of Object.entries(KINDS)) { const s = document.createElement("span"); s.className = "lg k-" + k; s.innerHTML = '<i aria-hidden="true"></i>'; s.append(n); legend.append(s); }

  // najbliższe
  const upcoming = evs.filter((e) => e.end >= today).slice(0, phoneCal() ? 3 : 5);
  const up = document.createElement("div"); up.className = "upcoming";
  const upH = document.createElement("h3"); upH.textContent = "Najbliższe"; up.append(upH);
  if (!upcoming.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "Brak zaplanowanych wydarzeń. Stuknij dzień w kalendarzu albo „+ Dodaj wydarzenie”."; up.append(p); }
  else upcoming.forEach((e) => up.append(evChip(e, true)));

  // Planer roczny w kolumnach (jak papierowy kalendarz ścienny): 12 kolumn = miesiące, w wierszach dni 1–31.
  // Przy dniu: numer, skrót dnia tygodnia, numer tygodnia przy poniedziałku, nazwa święta albo wydarzenia drobnym drukiem.
  const wall = document.createElement("div"); wall.className = "wall";
  const wallIn = document.createElement("div"); wallIn.className = "wall-in";
  const WD1 = ["Nd", "Pn", "Wt", "Śr", "Cz", "Pt", "So"];
  const MON_SHORT = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];
  const yy = String(calYear).slice(2);
  const monthCol = (m) => {
    const col = document.createElement("section"); col.className = "wcol";
    col.style.setProperty("--h", String(Math.round(285 + m * (215 / 11)) % 360));   // nagłówki w kolorach tęczy: fiolet → czerwień → żółć → zieleń → granat
    const first = new Date(calYear, m, 1), last = new Date(calYear, m + 1, 0);
    if (today >= iso(first) && today <= iso(last)) col.classList.add("current");
    const h = document.createElement("h3"); h.className = "whead"; h.textContent = MON_SHORT[m] + " " + yy; h.title = MONTHS[m] + " " + calYear;
    col.append(h);
    for (let d = 1; d <= last.getDate(); d++) {
      const date = new Date(calYear, m, d), key = iso(date), dow = date.getDay();
      const on = evs.filter((e) => e.start <= key && e.end >= key);
      const cell = document.createElement("button"); cell.type = "button"; cell.className = "wday";
      if (dow === 6) cell.classList.add("sat");
      if (dow === 0 || hol[key]) cell.classList.add("sun");
      if (key === today) cell.classList.add("today");
      if (on.length) {
        const k = KINDS[on[0].kind] ? on[0].kind : "other";
        cell.classList.add("has", "k-" + k);
        if (on.length > 1) { cell.classList.add("multi"); const k2 = KINDS[on[1].kind] ? on[1].kind : "other"; cell.style.setProperty("--k2", "var(--ev-" + k2 + "-s)"); }
      }
      const num = document.createElement("span"); num.className = "wnum"; num.textContent = pad(d);
      const wd = document.createElement("span"); wd.className = "wwd"; wd.textContent = WD1[dow];
      const txt = document.createElement("span"); txt.className = "wtxt";
      const starting = on.filter((e) => e.start === key || d === 1);
      if (starting.length) txt.textContent = starting.map((e) => e.title).join(" · ");
      else if (hol[key]) { txt.textContent = hol[key]; txt.classList.add("hol"); }
      cell.append(num, wd, txt);
      if (dow === 1) { const wk = document.createElement("span"); wk.className = "wweek"; wk.textContent = isoWeek(date).week; cell.append(wk); }
      const label = d + " " + MONTHS_GEN[m] + (hol[key] ? ", " + hol[key] : "") + (on.length ? ": " + on.map((e) => e.title).join(", ") : "");
      cell.setAttribute("aria-label", label); cell.title = label;
      cell.addEventListener("click", () => { if (on.length === 1) openEventDialog(on[0].id); else openEventDialog(null, key); });
      col.append(cell);
    }
    return col;
  };

  // TELEFON: jeden miesiąc na całą szerokość (ten sam papierowy styl), zmiana miesiąca palcem w bok, strzałkami
  // albo z paska miesięcy. KOMPUTER: wszystkie 12 kolumn obok siebie.
  if (phoneCal()) {
    const box = document.createElement("div"); box.className = "mview";
    const nav = document.createElement("div"); nav.className = "mnav";
    const pv = document.createElement("button"); pv.type = "button"; pv.className = "yearbtn"; pv.textContent = "‹"; pv.setAttribute("aria-label", "Poprzedni miesiąc");
    const nx = document.createElement("button"); nx.type = "button"; nx.className = "yearbtn"; nx.textContent = "›"; nx.setAttribute("aria-label", "Następny miesiąc");
    const title = document.createElement("h2"); title.className = "mtitle"; title.textContent = MONTHS[calMonth] + " " + calYear;
    title.style.setProperty("--h", String(Math.round(285 + calMonth * (215 / 11)) % 360));
    pv.disabled = calYear <= CAL_MIN_YEAR && calMonth === 0;
    pv.addEventListener("click", () => shiftMonth(-1)); nx.addEventListener("click", () => shiftMonth(1));
    nav.append(pv, title, nx);
    const chips = document.createElement("div"); chips.className = "mchips";
    MON_SHORT.forEach((n, i) => {
      const c = document.createElement("button"); c.type = "button"; c.className = "mchip" + (i === calMonth ? " on" : "");
      c.style.setProperty("--h", String(Math.round(285 + i * (215 / 11)) % 360));
      const cnt = evs.filter((e) => e.start <= iso(new Date(calYear, i + 1, 0)) && e.end >= iso(new Date(calYear, i, 1))).length;
      c.textContent = n; if (cnt) { const d = document.createElement("i"); d.setAttribute("aria-hidden", "true"); c.append(d); }
      c.setAttribute("aria-label", MONTHS[i] + (cnt ? ", wydarzeń: " + cnt : ""));
      c.addEventListener("click", () => { calMonth = i; renderCalendar(); });
      chips.append(c);
    });
    const col = monthCol(calMonth); col.classList.add("single");
    col.querySelector(".whead").remove();
    // przesunięcie palcem w bok = poprzedni / następny miesiąc
    let x0 = null, y0 = null;
    col.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    col.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    }, { passive: true });
    box.append(nav, chips, col);
    root.replaceChildren(head, legend, up, box);
    return;
  }
  for (let m = 0; m < 12; m++) wallIn.append(monthCol(m));
  wall.append(wallIn);
  // na telefonie planer przewija się w bok: zachowujemy miejsce przy odświeżeniu, a za pierwszym razem pokazujemy bieżący miesiąc
  const prevWall = root.querySelector(".wall");
  const keep = prevWall && prevWall.dataset.year === String(calYear) ? prevWall.scrollLeft : null;
  wall.dataset.year = String(calYear);
  root.replaceChildren(head, legend, up, wall);
  if (wall.scrollWidth > wall.clientWidth) {
    if (keep !== null) wall.scrollLeft = keep;
    else {
      const cur = wall.querySelector(".wcol.current");
      if (cur) wall.scrollLeft = Math.max(0, cur.offsetLeft - 8);
    }
  }
}

// ---------- okno wydarzenia ----------
let evEditing = null, evDeleteArmed = false;
function openEventDialog(id, dateISO) {
  evEditing = id;
  const ev = id ? events().find((e) => e.id === id) : { title: "", kind: "trip", start: dateISO, end: dateISO };
  $("evTitle").textContent = id ? "Edytuj wydarzenie" : "Nowe wydarzenie";
  $("evName").value = ev.title || "";
  document.querySelectorAll('input[name="evKind"]').forEach((r) => { r.checked = r.value === (ev.kind || "trip"); });
  $("evStart").value = ev.start; $("evEnd").value = ev.end;
  $("evDelete").hidden = !id;
  evDeleteArmed = false; $("evDelete").textContent = "Usuń wydarzenie"; $("evDelete").classList.remove("armed");
  $("evErr").textContent = "";
  $("evDlg").hidden = false;
  setTimeout(() => $("evName").focus(), 30);
}
const closeEventDialog = () => { $("evDlg").hidden = true; evEditing = null; };
$("evCancel").addEventListener("click", closeEventDialog);
$("evDlg").addEventListener("click", (e) => { if (e.target === $("evDlg")) closeEventDialog(); });
$("evStart").addEventListener("change", () => { if (!$("evEnd").value || $("evEnd").value < $("evStart").value) $("evEnd").value = $("evStart").value; });
$("evForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("evName").value.trim();
  const start = $("evStart").value, end = $("evEnd").value || start;
  const kind = (document.querySelector('input[name="evKind"]:checked') || {}).value || "other";
  if (!title) { $("evErr").textContent = "Wpisz, co to za wydarzenie."; return; }
  if (!start) { $("evErr").textContent = "Wybierz datę początku."; return; }
  if (end < start) { $("evErr").textContent = "Data „Do” jest wcześniejsza niż „Od”."; return; }
  const prevEv = evEditing ? events().find((x) => x.id === evEditing) : null;
  const id = evEditing || newId();
  write(id, { type: "event", title, kind, start, end, created: prevEv ? prevEv.created : Date.now(), updated: Date.now() });
  lastUndo = [[id, prevEv ? strip(prevEv) : null]];
  note((prevEv ? "Zapisano: " : "Dodano: ") + title + " (" + fmtRange({ start, end }) + ")", false, true);
  if (start.slice(0, 4) !== String(calYear)) calYear = Math.max(CAL_MIN_YEAR, Number(start.slice(0, 4)));
  closeEventDialog();
});
$("evDelete").addEventListener("click", () => {
  if (!evDeleteArmed) { evDeleteArmed = true; $("evDelete").classList.add("armed"); $("evDelete").textContent = "Tak, usuń wydarzenie"; return; }
  const ev = events().find((x) => x.id === evEditing);
  if (ev) { lastUndo = [[ev.id, strip(ev)]]; write(ev.id, null); note("Usunięto: " + ev.title, false, true); }
  closeEventDialog();
});

// ---------- zakładki ZADANIA / KALENDARZ ----------
let view = location.hash === "#kalendarz" ? "calendar" : lsGet("view", "tasks");
function setView(v) {
  view = v; lsSet("view", v);
  history.replaceState(null, "", location.pathname + location.search + (v === "calendar" ? "#kalendarz" : ""));
  applyView();
}
function applyView() {
  const cal = view === "calendar";
  $("sheet").hidden = cal; $("calendar").hidden = !cal;
  document.body.classList.toggle("view-calendar", cal);
  $("tabTasks").setAttribute("aria-selected", String(!cal)); $("tabCal").setAttribute("aria-selected", String(cal));
  $("tabTasks").classList.toggle("active", !cal); $("tabCal").classList.toggle("active", cal);
  if (cal && store) renderCalendar();
}
$("tabTasks").addEventListener("click", () => setView("tasks"));
$("tabCal").addEventListener("click", () => setView("calendar"));
applyView();

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
