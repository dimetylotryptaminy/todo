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
