// Firebase initialization.
//
// 1. Create a free Firebase project at https://console.firebase.google.com/
// 2. Add a Web app, copy the config, paste it into the FIREBASE_CONFIG object below.
// 3. Enable "Realtime Database" in the Firebase console (Build -> Realtime Database).
//    Start in TEST mode (public read/write) — fine for a party game.
// 4. Push. GitHub Pages will serve the static site and the game will work.
//
// You can read more in README.md.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// ---- PASTE YOUR FIREBASE CONFIG HERE ----
export const FIREBASE_CONFIG = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  databaseURL: 'https://REPLACE_ME-default-rtdb.firebaseio.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};
// -----------------------------------------

export const isConfigured = !Object.values(FIREBASE_CONFIG).some(
  (v) => typeof v === 'string' && v.startsWith('REPLACE_ME')
);

let _app = null;
let _db = null;

export function getDb() {
  if (!isConfigured) {
    throw new Error(
      'Firebase is not configured. Edit js/firebase.js and paste your Firebase project config. See README.md.'
    );
  }
  if (!_db) {
    _app = initializeApp(FIREBASE_CONFIG);
    _db = getDatabase(_app);
  }
  return _db;
}

export {
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  serverTimestamp,
  runTransaction,
};
