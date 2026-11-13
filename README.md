# Tablica spółek

Tygodniowa lista zadań dla spółek BIOTTS, NESTMEDIC, GENOMTEC, ORTHOGET, BIOACCURE i TRENDCAPITAL oraz pola INNE.
Działa offline, synchronizuje się między komputerem a telefonem (Firebase) i przyjmuje polecenia głosowe.

## Uruchomienie
1. **GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
2. **Firebase:** wklej swój `firebaseConfig` do `config.js` (zamiast `null`).
   - Authentication → Sign-in method → włącz **Email/Password**.
   - Authentication → Settings → Authorized domains → dodaj `dimetylotryptaminy.github.io`.
   - Firestore → Rules → wklej zawartość `firestore.rules` → Publish.
3. iPhone: otwórz adres w Safari → Udostępnij → *Do ekranu początkowego*.

## Polecenia
- `dodaj do Genomtec wysłać umowę` (bez nazwy spółki trafia do INNE)
- `usuń zakupy`, `usuń z Inne zakupy`
- `odhacz umowę`, `odznacz umowę`
- `zmień umowę na aneks do umowy`
- `przenieś umowę do Orthoget`
- `cofnij`
- Kilka poleceń naraz: oddziel kropką albo słowem „potem”.

Po zmianie plików podnieś `VERSION` w `sw.js`, żeby urządzenia pobrały nową wersję.

## Rozpoznawanie mowy przez serwer (OpenAI + Cloudflare Worker)
Safari na iPhonie rozpoznaje mowę tylko raz na załadowanie strony, dlatego aplikacja może nagrywać dźwięk
i wysyłać go do własnego serwera, który zwraca tekst. Klucz OpenAI jest tylko na serwerze, nie w aplikacji.

1. OpenAI: platform.openai.com → Billing (doładuj np. 5 USD) → API keys → Create new secret key.
2. Cloudflare: dash.cloudflare.com → Workers & Pages → Create → Worker → nazwa `tablica-stt` → Deploy →
   Edit code → wklej `worker/stt-worker.js` → Deploy.
3. Worker → Settings → Variables and Secrets:
   - `OPENAI_API_KEY` (Secret) — klucz z punktu 1,
   - `FIREBASE_PROJECT_ID` = `todo-5e064`,
   - `ALLOWED_EMAILS` = e-mail(e) z dostępem, po przecinku,
   - `ALLOWED_ORIGIN` = `https://dimetylotryptaminy.github.io`.
4. Adres workera (np. `https://tablica-stt.<konto>.workers.dev`) wpisz w `config.js` jako `window.STT_URL`.

Nagrania trafiają do OpenAI tylko na czas rozpoznania. Bez internetu mikrofon nie działa — wtedy wpisuj ręcznie.
