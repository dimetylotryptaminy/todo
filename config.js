// Konfiguracja Firebase (synchronizacja między urządzeniami).
// To nie jest tajne hasło — dane chronią reguły Firestore (firestore.rules).
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBkrOGuCUsB_FTl1ykqEWlvLKt_ADQZfpQ",
  authDomain: "todo-5e064.firebaseapp.com",
  projectId: "todo-5e064",
  storageBucket: "todo-5e064.firebasestorage.app",
  messagingSenderId: "565869103462",
  appId: "1:565869103462:web:c3900152321b1bc7b3a0a7",
};

// Adres serwera rozpoznawania mowy (Cloudflare Worker z worker/stt-worker.js). Pusty = rozpoznawanie w przeglądarce.
window.STT_URL = "";
