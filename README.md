# Word Spy

A real-time party game for 3–12 players. Everyone gets a word — except one
player (the spy) who gets a similar but different word. Players take turns
giving vague clues about their word. At the end, everyone votes on who they
think the spy is.

Static site. No build step. Plays on phones, laptops, anything with a
browser.

## Play

1. One player clicks **Create room**, picks a room size + timer, and shares
   the 4-character code.
2. Friends hit **Join room**, enter the code and their name.
3. Host clicks **Start**. Each player taps their card to secretly see their
   word.
4. **Discussion**: players take turns giving vague clues about their word.
   Clues should be broad enough that the spy can try to blend in, but narrow
   enough that the other civilians recognise you.
5. **Vote** for who you think the spy is.
6. Spy is revealed. Civilians win if the spy is caught; otherwise the spy
   wins. Scores update. Play again.

**Scoring:** civilians each get +1 if the spy is caught. The spy gets +2 if
they escape.

## Setup (one-time, ~2 minutes)

The game needs a realtime backend so players on different devices can see
each other's state. This uses Firebase Realtime Database, which is free for
anything at party-game scale.

1. Go to <https://console.firebase.google.com/> and create a new project
   (name it anything, e.g. `word-spy`). You can skip Google Analytics.
2. In the project console, click the web icon (`</>`) to **Add a Web app**.
   Name it anything, skip Firebase Hosting, and click **Register**. You'll
   be shown a `firebaseConfig` object.
3. Open [js/firebase.js](js/firebase.js) and replace the placeholder
   `FIREBASE_CONFIG` at the top with the values you were just shown.
4. In the Firebase console sidebar go to **Build -> Realtime Database ->
   Create database**. Pick any location. Start in **test mode** (public
   read/write — fine for a casual party game; the data is just room state).
5. Commit and push. Your GitHub Pages site will serve the updated
   `firebase.js` and the game will work.

## Hosting on GitHub Pages

In your repo settings: **Pages -> Build and deployment -> Source: Deploy
from a branch -> main / (root)**. GitHub will give you a URL like
`https://<user>.github.io/<repo>/`. Open it on your phone, create a room,
and share the code.

## Local dev

Since this uses ES modules, you need to serve the folder over HTTP (opening
`index.html` directly won't work). Any static server will do:

```sh
# from the repo root:
python -m http.server 8080
# then visit http://localhost:8080/
```

## Files

- [index.html](index.html) — landing page (create / join room).
- [room.html](room.html) — game room (lobby, reveal, discussion, vote, results).
- [css/style.css](css/style.css) — everything visual.
- [js/firebase.js](js/firebase.js) — Firebase config + initialization.
- [js/index.js](js/index.js) — landing page logic.
- [js/room.js](js/room.js) — game state machine.
- [js/words.js](js/words.js) — word pair database (~100 pairs). Add your own.

## Notes

- Room codes are 4 characters, case-insensitive, avoiding ambiguous chars
  (0/O, 1/I).
- Game state transitions (reveal → discussion → voting → results) are
  driven by Firebase transactions, so any client can safely advance the
  room — no single-point-of-failure on the host.
- When a player closes the tab, they're removed from the room. If the host
  leaves, the earliest-joined remaining player becomes the new host. If
  everyone leaves, the room is deleted.
- In test-mode Firebase rules, a determined player could technically open
  devtools and read the spy's word. For a casual party game played in the
  same room this doesn't matter. If you want to lock it down, write proper
  [security rules](https://firebase.google.com/docs/database/security).
