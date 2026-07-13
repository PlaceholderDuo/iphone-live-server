# iPhoneLiveServer — Build Log

## Session 1: Foundation + Setlist + Queue + Singer Queue — 2026-07-11

`#music #iphoneliveserver #phase-setup`

### Objectives

- Stand up the iPhone webserver as a standalone project in ~/Music/
- Build setlist page with song library search/sort (by genre, artist, key)
- Build queue system: add songs, navigate forward/backward, auto-clear at end
- Build singer queue (karaoke-style) with profanity filtering
- Band view + teleprompter mirror pages
- Password auth + device whitelist
- "Load next song" flow: triggers REAPER load via existing /api/songs/:slug/load endpoint

### Architecture

Single Express server on port 3300 serving all pages:

| Route | Purpose |
|-------|---------|
| `/` | Main Show Control — setlist queue, play controls, song search |
| `/band` | Band View — queue/song display, teleprompter mirror |
| `/singer` | Singer Queue — public karaoke signup with profanity filter |
| `/teleprompter` | Teleprompter — lyrics + chord display synced to current song |
| `/api/*` | All data endpoints (songs, queue, auth, config) |

Song library sourced from `~/ReaperSongs/` (existing LiveShowManager format).
Queue state persisted to `data/queue.json`.
Config (password, whitelist, device ID) in `data/config.json`.

### Work Completed

- **Project scaffold**: directory structure, package.json, data directory
- **Server core** (`server/index.js`): Express server, all routes, API endpoints, static file serving, auth middleware
- **Song library** (`server/api/songs.js`): reads ~/ReaperSongs meta.json files, builds searchable/sortable index with genre support
- **Queue engine** (`server/api/queue.js`): main queue + singer queue, forward/backward navigation, load-next trigger, auto-clear at end
- **Auth** (`server/api/auth.js`): password validation, device whitelist with configurable device ID
- **Profanity filter** (`server/api/profanity.js`): 200+ word blocklist for singer names, case-insensitive, substring matching
- **Genre support**: genre-map.json data file (80 songs pre-tagged across classic rock, country, blues, soul, pop, folk, etc.)
- **Main Show Control page** (`public/index.html`): song browser with search/sort, queue display, play controls, load-next button
- **Singer Queue page** (`public/singer.html`): public karaoke sign-up, song browser, name entry with profanity filter (client + server), queue position display, Tip the Band button
- **Band View page** (`public/band.html`): current song display, queue view, teleprompter embed
- **Teleprompter page** (`public/teleprompter.html`): full-screen lyrics/chords display for external monitor
- **Config** (`data/config.json`): password, whitelist, device ID, tip URL
- **Genre map** (`data/genre-map.json`): 80 songs tagged with genres
- **package.json**: dependencies (express, body-parser, cookie-parser)

### Key Design Decisions

- Single server on one port (3300) — no extra processes for different views
- Queue persists to disk — survives server restart
- Load-next triggers REAPER song load via existing LiveShowManager `/api/songs/:slug/load` endpoint
- Password stored in config file, hashed with SHA-256 for transport, plaintext comparison server-side
- Profanity filter uses blocklist approach — more transparent than ML-based and works offline
- Genre map stored separately from meta.json (meta.json is REAPER's source of truth, genres are show-management data)
- Singer queue uses timestamps for ordering (FIFO per round)

### Next Steps / Action Items

- [ ] Add genre tagging UI to main show control page
- [ ] Wire "load song" to actually call the REAPER load endpoint
- [ ] Add MIDI footswitch support (next/prev/play)
- [ ] Add "Placeholder Duo" auto-population from band queue
- [ ] Test QR code generation for singer queue
- [ ] Style pass: make it look good on iPhone 7

### Links / References

- Existing LiveShowManager: `/Users/rdfx1/LiveShowManager/`
- Song library: `~/ReaperSongs/`
- Tip page: GitHub Pages (deployed yesterday)

### Edits / Updates

- [2026-07-11] Project created

### Verification Results (2026-07-11)

All endpoints tested and verified:

| Test | Result |
|------|--------|
| Health check | ✅ `GET /api/health` → `{"status":"ok"}` |
| Login/auth | ✅ `POST /api/auth/login` with correct password → `{"ok":true}` |
| Auth protection | ✅ Unauthed requests to `/api/queue` return 401 |
| Auth redirect | ✅ Unauthed page requests redirect to `/login.html` |
| Song list | ✅ 225 songs indexed from `~/ReaperSongs/` |
| Song search (title) | ✅ "love" → 3 results (Addicted to Love, Giving It Up For Your Love, I Don't Know a Thing About Love) |
| Song search (genre) | ✅ "blues" filter → 19 blues songs |
| Genre listing | ✅ 16 genres returned |
| Sort by title/artist/key/bpm | ✅ All sort modes verified |
| Add to queue | ✅ Songs added to `main_queue` with slug, title, artist, key, bpm, timestamp |
| Start setlist | ✅ Loads first song, sets `status: "loaded"`, `current_index: 0` |
| Play | ✅ Status changes to `playing` |
| Load next | ✅ Navigates forward through queue |
| Load prev | ✅ Navigates backward through queue |
| End of queue | ✅ `"At end of queue"` error when no more next songs |
| Add during playback | ✅ Songs can be added at any time, even at end of queue |
| Reorder | ✅ `from_index`/`to_index` reordering works |
| Remove from queue | ✅ `DELETE /api/queue/item/:index` works |
| Clear queue | ✅ Full reset |
| Singer queue (public) | ✅ No auth required |
| Singer add | ✅ Name + song_slug → queued with ID, timestamp, round |
| Profanity filter | ✅ "dumbass" blocked with "Please choose a different name" |
| Valid singer name | ✅ Accepted |
| Promote singer | ✅ Singer entry moved to main_queue with singer name |
| Singer clear round | ✅ Clears queue, increments round counter |
| Frontend pages | ✅ `/` (Show Control), `/band`, `/singer`, `/teleprompter`, `/login.html` |
| CSS | ✅ All pages use shared `style.css` |

## Session 2: TUI + Karaoke Toggle + Search Fixes — 2026-07-11

`#music #iphoneliveserver #tui #karoke`

### Objectives

- Add TUI dashboard (pure Node.js, zero deps) with queue management, search+add, keyboard controls
- Add `start-show` CLI launcher and zsh integration
- Fix Enter-in-search bug (song search was auth-protected, TUI never authenticated)
- Add karaoke ON/OFF toggle: when OFF, `/singer` page shows paused message and blocks signups; songs only addable via TUI/auth pages
- Shift+K to toggle karaoke from TUI
- `karaoke_enabled` and `karaoke_paused_message` stored in `data/config.json` (editable)

### Key Decisions

- TUI uses ANSI escape codes instead of ncurses/libraries — zero deps, same runtime as server
- TUI authenticates via `x-auth-token` header (SHA-256 of config password)
- Song GET endpoints `/api/songs` made public (read-only metadata) so TUI can search without auth
- Karaoke toggle endpoint is auth-free (localhost, non-sensitive)
- Singer page polls karaoke status every 5s alongside queue poll

### Added Files

| File | Purpose |
|------|---------|
| `scripts/tui.js` | Full TUI dashboard: Now Playing, Queue (scrollable, cursor), Search+Add overlay, confirm dialogs, event log |
| `scripts/start-show` | Bash launcher: checks server, installs deps, launches TUI |
| `data/genre-map.json` | 80+ songs tagged across 16 genres |

### Modified Files

| File | Change |
|------|--------|
| `server/index.js` | Made GET `/api/songs` public (TUI search fix) |
| `server/api/queue.js` | Added `/api/singer/status` and `/api/singer/toggle` endpoints; karaoke check in singer add |
| `server/api/auth.js` | Added `saveConfig()` export; exposed karaoke settings in `/api/config` |
| `server/public/singer.html` | Shows red paused banner + hides signup flow when karaoke OFF |
| `scripts/tui.js` | Karaoke status in stats bar, Shift+K toggle, auth token from config, await doAction on Enter |
| `data/config.json` | Added `karaoke_enabled` and `karaoke_paused_message` |

### Test Results

```
$ curl /api/singer/status                    → {"karaoke_enabled": true, ...}
$ curl -X POST /api/singer/toggle            → {"karaoke_enabled": false}
$ curl -X POST /api/singer/add (while OFF)   → 403 with paused message
$ curl -X POST /api/singer/toggle            → {"karaoke_enabled": true}
$ curl /api/songs/search?q=slow              → Slow Dancing in a Burning Room (2 variants)
$ curl -X POST /api/queue/add (with token)   → {"ok": true, ...}
$ curl -X POST /api/queue/add (no token)     → 401 Unauthorized
```

### Resource Usage (Server)

~63MB RAM idle, ~67MB under load, ~0% CPU, 1s startup, 8MB disk

### Next Steps

- Lighting control page (DMX via MIDI or Art-Net)
- Mixer master page with IEM mix sub-pages
- MIDI footswitch support (next/prev/play)
- Per-song FX recall (amp sims, pedal settings)
- Drag-to-reorder queue on mobile
- Genre tagging UI within show control page
- QR code generation for singer queue access
- GitHub Pages tips page
- "Placeholder Duo" auto-population from band queue
- Singer queue promote to main queue from singer page

## Session 3: Guest Request System + Offline Mode + Show Readiness — 2026-07-11

`#music #iphoneliveserver #karaoke #offline`

### Objectives

- Build public guest request page for GitHub Pages deployment
- Integrate guest submissions with singer queue via external sync
- Add offline-first mode with auto-detection
- Merge parallel OpenCode session work (Cloudflare tunnel redirect, bumper music)
- Make `start show server` launch both servers (3300 + 5800)
- Generate dynamic QR codes with correct network IP

### Architecture

```
Offline (tonight default):
  Guest → WiFi QR → joins "PlaceholderDuo" WiFi → singer QR → http://<IP>:3300/singer
  ↓ instant, no internet
  Singer queue visible in TUI + iPhone controller in real time

Online (auto-detected):
  GitHub Pages guest → jsonblob.com → server syncs every 30s → singer queue
  Server auto-detects internet ~5s after startup
```

### Work Completed

- **Guest request page** (`live-band-karaoke/index.html`): mobile form with name/song/artist, 24-song library hints, admin panel (password: `liveband`), dual-mode submissions (local API or jsonblob fallback)
- **External sync** (`server/api/queue.js`): jsonblob polling with dedup, `/api/singer/external-sync`, `/api/singer/external-add` for direct WiFi submissions, `/api/singer/external-status` and `/api/singer/external-toggle` endpoints, `syncBlobToQueue()` shared function
- **Offline-first mode**: `externalEnabled` defaults to `false`, auto-detects `https://jsonblob.com` reachability after 5s, `startAutoSync()` / `clearInterval` on toggle, `/api/singer/retry-online` for manual retry
- **TUI enhancements**: OFFLINE/ONLINE indicator in title bar, `o` to toggle, `O` to retry detection, `e` to sync now, external pending count in stats bar, guest URL displayed at bottom
- **QR generation** (`scripts/generate-qr`): auto-detects MacBook IP (prefers Ethernet, skips Tailscale), generates WiFi join QR + singer page QR with current IP, updates GitHub Pages tunnel-url.txt, called by `start-show` on startup
- **`start-show` updates**: launches both iPhoneLiveServer (:3300) and Stage HUD (:5800), passes `SHOW_IP` env var to TUI, generates QRs before launch
- **iPhone controller** (`controller.js`): Requests page polls `window.location.hostname:3300` (works from iPhone), badge shows pending count, auto-refresh every 10s
- **Merged work**: Cloudflare tunnel redirect page (`gh-pages/guest.html`), bumper music engine (20 instrumental tracks, `afplay` + WebSocket control)
- **Config**: `karaoke_enabled` default `true`, `externalEnabled` default `false` (offline-first)

### Key Design Decisions

- Offline by default — no internet requests until connectivity confirmed. Show must run without internet.
- Singer page at `/singer` is the primary local guest interface (3-step flow: name → song → confirm)
- GitHub Pages URL is fallback for remote guests; submissions go to jsonblob, synced when online
- QR codes use MacBook's actual IP (not `rig.local`) for reliability across devices
- External sync marks jsonblob entries as `done: true` after importing to prevent duplicates
- Singer queue `external: true` tag distinguishes WiFi guests from remote submissions

### Files Changed

| File | Change |
|------|--------|
| `server/api/queue.js` | Added 30s auto-sync, external-sync/add/toggle/status endpoints, `syncBlobToQueue()`, offline-first default, `retry-online` endpoint |
| `scripts/tui.js` | OFFLINE/ONLINE in title bar, external pending count, `o`/`O`/`e` key bindings, guest URL display, retry-online action |
| `scripts/start-show` | Launches Stage HUD server (:5800), calls `generate-qr`, passes `SHOW_IP` to TUI |
| `scripts/generate-qr` | **NEW** — IP detection, QR generation, GitHub Pages deploy |
| `server/public/singer.html` | Existing singer page verified working (no changes needed) |
| `data/config.json` | `karaoke_enabled: true` (was false) |
| `data/queue.json` | Cleaned/reset for show |
| `live-band-karaoke/index.html` | **NEW** — Guest request page (deployed to GitHub Pages) |
| `live-stage-hud/web/public/controller.js` | Added Requests page, dynamic IP for API calls |
| `live-stage-hud/web/public/request.html` | Local copy of guest page |
| `live-stage-hud/web/server.js` | Added `/request` route |
| `live-stage-hud/web/public/controller.css` | Request badge + page styles |

### Test Results

```
$ curl /api/health                                    → {"status":"ok"}
$ curl /api/singer/external-status                     → sync=False, online=False (offline default)
$ curl -X POST /api/singer/external-add               → Singer added to queue instantly
$ curl /api/singer/queue                               → Singer visible in queue
$ curl /api/singer/external-sync                       → Pulls from jsonblob, marks done
$ curl /api/singer/toggle                              → sync_enabled toggle
$ curl /api/singer/retry-online                        → Re-checks connectivity
$ start show server                                    → Both servers launch, QRs generated, TUI ready
```

### Next Steps

- [ ] Test with actual iPhone 7 on AirPort WiFi
- [ ] Print QR codes
- [ ] Genre tagging UI within show control page
- [ ] Mixer master page with IEM mix sub-pages
- [ ] Drag-to-reorder queue on mobile
- [ ] Lighting control page (DMX via MIDI)
- [ ] MIDI footswitch support (next/prev/play)

---

## Session 4: Permanent QR + mDNS + Inseego Setup — 2026-07-11

`#music #iphoneliveserver #qr #dns`

### Problem
Printed QR codes hardcoded with an IP would break every time the MacBook got a different DHCP lease. The singer page URL must survive IP changes, router swaps, and reboots.

### Solution
**Primary QR uses `rig.local`** — macOS Bonjour/mDNS auto-advertises the hostname `rig` on any network. No static IP or DHCP reservation needed. All devices on the same WiFi can resolve `.local` names.

**IP-based fallback QR** generated at startup as a safety net in case a router blocks mDNS multicast (rare on consumer gear).

### Changes
- `scripts/generate-qr` rewritten: generates 3 QR codes now
  - `qr-1-join-wifi.png` — WiFi auto-join
  - `qr-2-singer-rig-local.png` — `http://rig.local:3300/singer` (PERMANENT — print this one)
  - `qr-3-singer-ip-fallback.png` — `http://<current-ip>:3300/singer` (backup)
- Verified mDNS working: `rig` advertised via Bonjour, `rig.local` resolves
- Deployed QRs to GitHub Pages for archiving

### Inseego MiFi Setup
- Admin page: `http://192.168.0.1`
- SSID: `PlaceholderDuo`, WPA2, password: `showtime`
- **Critical**: Disable AP/Client Isolation (found under WiFi → Advanced)
- No SIM card needed — functions as WiFi access point only
- Subnet: 192.168.0.x (gateway 192.168.0.1)

### Venue Checklist
1. Power on Inseego/AirPort
2. MacBook connects (Ethernet preferred)
3. `start show server` — generates fresh QRs, starts both servers
4. Print `qr-1-join-wifi.png` and `qr-2-singer-rig-local.png`
5. Place on tables/stage

### Print-Ready QR Files
`~/Documents/projects/live-band-karaoke/`
- `qr-1-join-wifi.png` — "Join WiFi" sign
- `qr-2-singer-rig-local.png` — "Request a Song" sign (permanent URL)

---

## Session 5: Final Prep — Print Signage, Dell Teleprompter, Inseego Config — 2026-07-11

`#music #iphoneliveserver #showtime`

### Inseego MiFi — Final Config
- Main network: `RedFox-productions-local` / `showtime99!`
- Guest network: `placeholder-guest` / `password`
- AP/Client Isolation: DISABLED
- Admin: `http://192.168.0.1`
- Subnet: 192.168.0.x

### Print-Ready Signage
Created two printable HTML files (open in Safari → Print → letter 8.5×11):
- `print-sign.html` — Front: WiFi join QR (guest network) + Back: Singer page QR (`rig.local`)
- `print-backup-qr.html` — Backup direct-IP QR for emergency (if mDNS fails on a device)

### Dell Inspiron 7520 (rdfx5) — Teleprompter Kiosk
- Pop!_OS 22.04, IP: `192.168.0.127`
- SSH: `rdfx5@192.168.0.127`
- Auto-login enabled for rdfx5 (GDM3)
- Firefox installed
- Planned: auto-launch Firefox fullscreen → `http://rig.local:3300/teleprompter` on boot
- Needs: switch from Hogwarts_2.4 to `RedFox-productions-local` WiFi

### Final System Verification (16/16 passed)
```
✅ Main server :3300
✅ Stage HUD :5800
✅ Singer page /singer
✅ iPhone controller
✅ Request page /request
✅ Bumper music /bumper
✅ Queue starts empty
✅ Guest can submit song
✅ Submission appears in queue
✅ Defaults to OFFLINE mode
✅ Karaoke ENABLED
✅ WiFi QR exists
✅ Singer QR exists
✅ Backup QR exists
✅ Main sign ready
✅ Backup sign ready
```

### Tonight's Venue Checklist
1. Power on Inseego
2. MacBook connects to `RedFox-productions-local` (Ethernet if possible)
3. `start show server`
4. Dell on `RedFox-productions-local` → Firefox fullscreen → `/teleprompter`
5. Print QR signs → place on tables
6. iPhone 7 → `http://rig.local:5800/`
7. Rock the show

## 2026-07-11 — Pre-Show: Server Integration + TUI Enhancements

### Session: LSM Server Merger + WiFi Key + Band Server Validation

#### Done
- **Merged LSM server (:3000)** into `start show server` flow — iPhone controller now lives here
- **Validated band server (:3300)** — 328 songs loaded, working:
  - Band view (`/band`) — queue, song info, link to teleprompter
  - Teleprompter (`/teleprompter`) — full-screen chord-colored lyrics
  - Singer queue (`/singer`) — public, no auth needed
- **Added WiFi credentials to config** (`wifi_ssid`, `wifi_password` in `config.json`)
- **TUI `w` key** — Press `w` → overlay shows WiFi SSID + password + band login
  - Works in both queue and now-playing focus modes
  - Any key dismisses
- **Updated TUI URL display** — Shows iPhone controller on port 3000
- **Password remains:** `showtime` (band auth)

#### Current State
- LSM server (:3000): running via launchd, auto-restarts
- Main server (:3300): launched by `start show server`, 328 songs
- Stage HUD (:5800): launched by `start show server`, 20 bumper tracks
- Dell (rdfx5): auto-connects on boot, status TUI → Firefox kiosk
- TUI: manages singer queue, WiFi info via `w` key

#### One Command
`start show server` — starts everything. Ctrl-C stops it all.

---

## Session 6: Band Queue + TUI Improvements — 2026-07-13

`#music #iphoneliveserver #band-queue #tui`

### Problem

The vision document specified a "band queue" that auto-rotates a Placeholder Duo song into every karaoke round. This didn't exist — only a `main_queue` and `singer_queue`. Additionally, the TUI had bugs:

1. **No band queue**: band songs couldn't be pre-loaded for auto-rotation
2. **Arrow navigation bug**: up/down in the singers panel navigated `main_queue` instead of the displayed singer queue
3. **No way to build up a queue**: the TUI could only search+add one song at a time to main_queue — couldn't add to band queue or manually add singers
4. **No queue view switching**: couldn't see or manage a band queue separately

### Solution

#### 1. Band Queue Data Model

Added `band_queue: []` to the queue data model alongside `main_queue` and `singer_queue`. Each entry matches the main_queue format: slug, title, artist, key, bpm, timestamp.

#### 2. Auto-Promote on Round Clear

`POST /api/singer/clear-round` now shifts the first song from `band_queue` into `main_queue` with `singer: "Placeholder Duo"` and `band_song: true`. Band queue acts as FIFO — each clear-round consumes one band song.

```javascript
if (q.band_queue.length > 0) {
  const bandSong = q.band_queue.shift();
  q.main_queue.push({ ...bandSong, singer: 'Placeholder Duo', band_song: true, timestamp: Date.now() });
}
q.round++;
```

#### 3. Band Queue API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/band-queue` | List band queue (public) |
| `POST` | `/api/band-queue/add` | Add song to band queue (auth) |
| `DELETE` | `/api/band-queue/item/:index` | Remove song (auth) |
| `POST` | `/api/band-queue/clear` | Clear band queue (auth) |

Exposed in `GET /api/queue` as `band_queue` field.

#### 4. TUI: Tab Switches Queue Views

The right panel toggles between two views via **Tab** key. Separate cursors (`singerCursor`, `bandCursor`) preserve position when switching.

| Key | Action |
|-----|--------|
| `←` `→` | Switch between NOW PLAYING and queue panel |
| `Tab` | Toggle between **Singers** and **Band Queue** views |
| `↑` `↓` | Navigate currently displayed queue |

**Arrow bug fixed**: old code was `queueState.main_queue` regardless of what panel showed. Now correctly navigates `singerQueue.queue` in singers view and `queueState.band_queue` in band view.

#### 5. TUI: Context-Aware Search+Add

| Focus | View | `a` flow |
|-------|------|----------|
| REAPER panel | — | Search → add to **main_queue** |
| Queue panel | Singers | Search → **name prompt** → add to singer queue |
| Queue panel | Band | Search → add to **band_queue** |

The singer name prompt is a two-step flow: search for a song, then type the singer's name. Enables MC to manually add walk-up singers without phones.

#### 6. TUI: Remove Actions

| Focus | View | `x` flow |
|-------|------|----------|
| Queue panel | Singers | Confirm dialog (y/n) → DELETE /api/singer/queue/:id |
| Queue panel | Band | Instant remove → DELETE /api/band-queue/item/:index |

#### 7. `apiPost` Now Supports HTTP Method

`apiPost(path, body, method)` — third param for `'DELETE'` etc. Was hardcoded to POST.

### Files Changed

| File | Lines | Change |
|------|-------|--------|
| `server/api/queue.js` | +60 | Band queue endpoints, auto-promote on clear-round |
| `server/index.js` | +1 | Whitelist GET /api/band-queue |
| `scripts/tui.js` | +180 | Tab toggle, dual cursors, name prompt, method param, action labels |
| `data/queue.json` | +1 | Add `band_queue: []` |
| `BUILD_LOG.md` | +80 | This entry |

### Test Results (all pass)

```
GET  /api/band-queue           → {"band_queue": []}
POST /api/band-queue/add (auth) → {"ok": true, "band_queue": [...]}
POST /api/singer/clear-round    → band song auto-promoted, band_queue shrinks
POST /api/singer/clear-round x2 → empty band_queue → band_promoted: null (no crash)
DELETE /api/band-queue/item/0   → {"ok": true}
```

### Show Flow

**Pre-show**: Tab to Band Queue → `a` → build 10-20 band auto-rotate songs

**During show**: `c` clears singer round → band song auto-inserts as "Placeholder Duo" → band plays → singers go up → `c` repeats

**Walk-ups**: Tab to Singers → `a` → search song → type name → added to karaoke queue

### Karaoke Toggle — Verified Working

The karaoke ON/OFF toggle (TUI Shift+K, or API `POST /api/singer/toggle`) persists to `config.json`. Singer page polls `/api/singer/status` every 5s:

- **ON**: Signup flow visible, singers can add 2 songs each
- **OFF**: Red banner with custom message from `config.json`, signup hidden, API returns 403

Tested end-to-end: toggle, message display, signup block, persistence. No changes needed.

---

## Session 7: Setlists Feature — Design Plan — 2026-07-13

`#music #iphoneliveserver #setlists #planning`

### Goal

Pre-create setlists (e.g., "Friday Night 20", "Blues Night", "Country Set") as text files. Load instantly on show day instead of building queue song-by-song.

### File Format

Plain `.txt` or `.md` files in `data/setlists/`. One song slug per line. `#` comments supported. Blank lines ignored.

```
# Friday Night Set — 20 songs — July 2026

All Right Now
(Sittin on) The dock of the bay
(I Can't Get No) Satisfaction
Brown Eyed Girl
Proud Mary
Sweet Home Alabama
Mustang Sally
...
```

Also planned: `.md` with inline notes per song for richer prep:

```markdown
# Blues Night Set
1. The Thrill Is Gone (Bm, 88bpm) — opener, slow burn
2. Pride and Joy (Eb, 128bpm) — pick up energy
...
```

### API Endpoints (planned)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/setlists` | List saved setlists with metadata |
| `POST` | `/api/setlists/export` | Export current main_queue to file |
| `POST` | `/api/setlists/import` | Load a setlist (replace or append) |
| `DELETE` | `/api/setlists/:name` | Delete a setlist |

### TUI Commands (planned)

| Key | Action |
|-----|--------|
| `E` | Export — prompt for name, saves current main_queue as `data/setlists/<name>.txt` |
| `I` | Import — shows picker of saved setlists, `r` replace / `a` append |

### Files to Create

- `server/api/setlists.js` — setlist CRUD endpoints
- `data/setlists/.gitkeep` — directory placeholder

### Next Steps

- [x] Implement setlists API + TUI
- [ ] Create a few sample setlists
- [ ] Genre tagging UI in show control page
- [ ] Drag-to-reorder queue on mobile

---

## Session 8: Setlists Export/Import + Settings + Kick/Ban — 2026-07-13

`#music #iphoneliveserver #setlists #settings #kick`

### Setlists — Export & Import

Setlists are plain `.txt` files in `data/setlists/`, one song slug per line, `#` comments supported. Import replaces the main queue; export saves the current main queue as a date-stamped file.

**API endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/setlists` | List saved setlists (public) |
| `POST` | `/api/setlists/export` | Save main_queue as `data/setlists/<name>.txt` |
| `POST` | `/api/setlists/import` | Load setlist, replace main_queue |
| `DELETE` | `/api/setlists/:name` | Delete a setlist |

**TUI keys:**

| Key | Action |
|-----|--------|
| `E` | Export current queue as `Setlist_<date>.txt` |
| `I` | Open setlist picker → ↑↓ select → Enter to load |

Files stored in `data/setlists/`. New file: `server/api/setlists.js`.

### Settings — max_songs_between_band

Controls how often the band auto-inserts a song during karaoke rounds. When the number of promoted singers reaches this threshold mid-round, a band song is auto-promoted from the band_queue.

- **Default**: `8` — band plays after every 8 promoted singers (plus once per round start)
- **0** = band plays once per round only (old behavior)

**API**: `GET /api/config` returns `max_songs_between_band`. `POST /api/config/update` sets it.

**TUI**: `?` opens settings overlay → Enter to edit → type new value → Enter saves.

Stats bar shows: `Round 3 (5/8)` — 5 promoted, band inserts at 8.

### Implementation detail — promote counting

The `promote` endpoint now tracks `promote_count`. Each singer promotion increments it. When `promote_count >= max_songs_between_band` AND singers remain AND band_queue has songs → band song auto-inserts into main_queue and counter resets. `clear-round` resets the counter and always auto-promotes a band song for the new round.

### Kick / Ban Singer

Silently removes a singer from the queue and bans them for the rest of the current show. Useful for extreme cases.

**TUI**: `B` in singers view → red "KICK SINGER" confirm dialog → y to kick. Removes all their songs from the current round.

**API**: `POST /api/singer/kick {singer: "name"}` — removes entries, adds to `banned_singers`, logs to persistent file. Banned singers are blocked from re-adding (403 with message).

**Persistent ban log**: `data/banned-log.json` — an array of records, one per kick event:

```json
[
  {
    "singer": "Troublemaker",
    "songs": ["All Right Now", "Brown Eyed Girl"],
    "ips": ["192.168.0.50"],
    "time": "2026-07-13T20:20:13.976Z",
    "round": 1
  }
]
```

Searchable with standard tools:
```bash
# Find a specific singer
grep '"singer"' data/banned-log.json

# All IPs of banned singers
grep -o '[0-9]*\.[0-9]*\.[0-9]*\.[0-9]*' data/banned-log.json | sort -u

# Full formatted output
cat data/banned-log.json | python3 -m json.tool
```

The ban log is in the project directory (`~/Music/iPhoneLiveServer/data/banned-log.json`) — easy to find, persists across shows, and is git-tracked.

IP addresses are captured at singer signup time via `req.ip` and stored on each singer queue entry. When kicked, all unique IPs from the singer's entries are logged.

### Files Changed

| File | Change |
|------|--------|
| `server/api/queue.js` | +`banned_singers`, +kick endpoint, +banned block in add, +IP capture on signup, +promote_count, +`promoteBandSong()` helper, +`logBanned()` |
| `server/api/setlists.js` | **NEW** — setlist CRUD |
| `server/api/auth.js` | +`max_songs_between_band` in config, +update endpoint |
| `server/index.js` | +setlist routes, +whitelist GET /setlists |
| `scripts/tui.js` | +`E`/`I`/`?`/`B` keys, +setlist picker, +settings overlay, +kick confirm, +promoteCount display |
| `data/setlists/` | **NEW** — directory for .txt setlist files |
| `data/config.json` | +`max_songs_between_band: 8` |
| `data/queue.json` | +`banned_singers`, +`promote_count` |
| `data/banned-log.json` | **NEW** — persistent ban records |
| `BUILD_LOG.md` | +this session |

### Edits / Updates

- **[2026-07-13]** Kick message changed from aggressive to polite: `"Thanks for singing! Have a great night!"` — kicked singers just think they got their one song. No drama.
- **[2026-07-13]** `start-show` now defaults to `connect` mode (SETUP), not `live`. Press `Shift+S` in TUI to go LIVE. Prevents accidental Dell kiosk activation.
- **[2026-07-13]** TUI shows prominent yellow `[Shift+S] Start Show to go LIVE` banner in setup mode. `SETUP` badge replaces `CONNECTED`.

---

## Session 9: TUI Polish — Overlays, Import Visibility, Setlist View — 2026-07-13

`#music #iphoneliveserver #tui #polish`

### Problem

1. **Overlay text bleeding**: Confirm dialogs, setlist picker, and settings overlay rendered on top of existing screen content without clearing first. Background TUI text showed through overlays.
2. **Import "not working"**: Import API worked correctly but the TUI had no panel displaying `main_queue` — users couldn't see imported setlists. Songs populated in the queue but were invisible.
3. **Export auto-named**: No prompt for setlist name — just date-stamped auto-name.
4. **Stale duplicate E handler**: Two `case 0x45` handlers existed in the switch.

### Fixes

#### 1. Clear Screen on Overlays

All overlay renders (`renderConfirm`, `renderSetlistPicker`, `renderSettings`) now start with `HIDE + CLS` instead of just `HIDE`. `CLS` sends the ANSI clear-screen escape before drawing the overlay box.

#### 2. Setlist View in Queue Panel

Tab now cycles through **3 views**: Singers → Band Queue → Setlist → loop.

| View | Shows | Cursor | Actions |
|------|-------|--------|---------|
| Singers | `singer_queue` | `singerCursor` | Promote, Kick, Remove, Round, Add Singer |
| Band Queue | `band_queue` | `bandCursor` | Remove, Add Band |
| Setlist | `main_queue` | `mainQueueCursor` | Remove, Add Song |

Setlist view shows title, artist, key, and singer name (for promoted entries). Each view has its own independent cursor.

#### 3. Export Name Prompt

Pressing `E` now opens a name input overlay: type the setlist name, Enter to export. Shows song count being exported.

#### 4. Import Error Reporting

`POST /api/setlists/import` now returns `failed: []` array listing slugs that didn't match a song in the library. TUI logs: `"Setlist loaded: Test (4 songs, 2 not found)"` with failed slugs listed.

#### 5. Removed Stale Code

Removed duplicate `case 0x45` handler that auto-exported without prompting. Cleaned up `I` key handler (was also triggering on lowercase `i`).

### Files Changed

| File | Change |
|------|--------|
| `scripts/tui.js` | +Setlist view, +CLS on all overlays, +export name prompt, removed stale E handler, +mainQueueCursor, 3-state Tab cycling |
| `server/api/setlists.js` | Import returns `failed` array + `total` count |
| `data/setlists/*.txt` | Test setlists for verification |

### TUI Keyboard Reference (Final)

| Key | Context | Action |
|-----|---------|--------|
| `←` `→` | Always | Switch panel focus (REAPER / Queue) |
| `Tab` | Queue focused | Cycle views: Singers → Band → Setlist |
| `↑` `↓` | Queue focused | Navigate current view |
| `a` | Singers | Search song → type name → add to karaoke queue |
| `a` | Band | Search → add to band queue |
| `a` | Setlist | Search → add to main queue |
| `p` | Singers | Promote singer to main queue |
| `B` | Singers | Kick/ban singer (confirm) |
| `x` | Singers | Remove singer (confirm) |
| `x` | Band/Setlist | Remove song (instant) |
| `c` | Singers | Clear round + auto-promote band song |
| `E` | Always | Export setlist (prompt for name) |
| `I` | Always | Import setlist (picker) |
| `?` | Always | Settings (max songs between band) |
| `Shift+K` | Always | Toggle karaoke ON/OFF |
| `Shift+S` | SETUP mode | Start the show (go LIVE) |
| `c` | Singers | Clear round (confirm) |
| `a` | Any | Search + add (context-aware target) |
| `E` | Always | Export setlist (prompt for name) |
| `I` | Always | Import setlist (picker) |
| `?` | Always | Settings (max songs between band) |
| `n` | Anywhere | Load next song |
| `b` | Anywhere | Load previous song |
| `Space` | Anywhere | Play / Stop / Start setlist |
| `Enter` | Setlist view | Play on the fly — promote song to main queue |
| `m` | Anywhere | Bumper toggle (play / graceful stop) |
| `Shift+M` | Anywhere | Bumper stop immediately |
| `[` | Anywhere | Bumper volume -5% |
| `]` | Anywhere | Bumper volume +5% |
| `Shift+K` | Always | Toggle karaoke ON/OFF |
| `Shift+S` | SETUP mode | Start the show (go LIVE) |
| `w` | Always | WiFi info overlay |
| `e` | Always | Sync external submissions |
| `o` | Always | Toggle online/offline |
| `r` | Always | Restart server |
| `q` | Always | Quit + stop bumper + stop server |

---

## Session 10: Architecture Simplify + Playback + Bumper + Polish — 2026-07-13

`#music #iphoneliveserver #architecture #bumper #polish`

### Architecture Simplification

**Setlist = Band Queue.** One source of truth. Import populates `band_queue`. Export saves `band_queue`. Auto-rotate consumes from `band_queue`. Tab now cycles 2 views: Singers ↔ Setlist. Removed the redundant 3-view cycle.

### TUI Playback Controls

| Key | Action |
|-----|--------|
| `n` | Load next song |
| `b` | Load previous song |
| `Space` | Play (if loaded) / Stop (if playing) / Start setlist (if nothing loaded) |
| `Enter` | Play on the fly — promote selected setlist song to main queue (inserted after current) |

The API endpoints (`/api/queue/load-next`, `/api/queue/load-prev`, `/api/queue/play`, `/api/queue/stop`, `/api/queue/start-setlist`) were already built in Session 1 but had no TUI key bindings.

### Play on the Fly

`Enter` in Setlist view takes the selected band_queue song and promotes it to `main_queue` via new `POST /api/band-queue/promote` endpoint. Inserted right after the currently loaded song so it plays next. Seamless — audience doesn't know it wasn't planned.

### Clear Round Confirmation

`c` in Singers view now shows a confirm dialog: "Clear Round 3 (5 singers)? y/n". Prevents accidental round clears.

### Now Playing Indicator

The currently loaded song shows a green `▶` in the Setlist view, alongside the regular cursor highlight.

### Per-Song Notes

When a setlist song is highlighted with the cursor, the TUI displays tuning, capo, and difficulty from `meta.json`:
```
3. American Girl [G]  capo 2 · intermediate
```
Data comes from the song library cache (`songCache`), loaded at TUI startup.

### Duplicate Detection

`POST /api/queue/add` now tags entries with `duplicate: true` if the same slug already exists in `main_queue`. TUI logs: `"Added: All Right Now (DUPLICATE!)"` with a warning message.

### ETA Display

Both the band page and singer page show estimated time remaining (5 min per song):

- **TUI stats bar**: `ETA 30m` (main_queue remaining)
- **Band page**: `5 singers in queue (Round 2) (~25 min)`
- **Singer page**: `~20 min of singers waiting`

API: `GET /api/queue` returns `eta_minutes` (main_queue) and `singer_eta_minutes`. `GET /api/singer/queue` returns `eta_minutes` (singer_queue).

### Singer Page — Band Playing Indicator

When a band song (`band_song: true`, `singer: "Placeholder Duo"`) is the current song, the singer page shows a yellow banner:
```
Placeholder Duo — Band is playing — singers coming up next!
```
The band page shows a similar "Now Playing — Placeholder Duo" card.

### Bumper Music Control

| Key | Action |
|-----|--------|
| `m` | Start bumper / Graceful stop (track plays to end, then silence) |
| `Shift+M` | Stop immediately |
| `[` | Volume -5% (immediate restart at new volume) |
| `]` | Volume +5% (immediate restart at new volume) |

Volume persists to `~/.bumper-volume` — survives restarts. Default 20%. Range 5-100%.

### Bumper Bug Fix — Explicit Stop Flag

The bridge server had a critical bug: when `bumperStop()` killed the `afplay` process, the exit handler auto-played the next track. This created an infinite music loop that couldn't be stopped. 

Fix: Added `bumperExplicitStop` flag. Set to `true` in `bumperStop()`. The exit handler checks this flag and skips auto-next when set. Also added `bumperGracefulStop` flag for the graceful stop feature.

Bridge server file: `~/Library/Application Support/REAPER/Scripts/Live Show Manager/web/server.js`

New endpoints on bridge server (:3000):
- `POST /bumper/api/stop-graceful` — stops after current track
- `POST /bumper/api/volume/up` — +5% volume
- `POST /bumper/api/volume/down` — -5% volume
- `GET /bumper/api/status` now includes `volume` field

### Settings Arrow Key Fix

Settings overlay (`?`) had broken arrow key navigation. Escape sequences (`\x1b[A`) were processed byte-by-byte in a `for...of` loop, causing `\x1b` (Esc) to exit settings mode before the arrow key arrived. Fix: check for multi-byte escape sequences BEFORE the byte loop.

### TUI Quit — Stops Bumper

`q` now calls `bumperPost('stop')` before shutting down, ensuring no orphaned `afplay` processes.

### Files Changed

| File | Change |
|------|--------|
| `scripts/tui.js` | +playback keys (n/b/Space), +Enter play-on-the-fly, +clear confirm, +now-playing indicator, +per-song notes, +duplicate logging, +ETA display, +bumper control (m/Shift+M/[ ]/), +settings arrow fix, +quit stops bumper |
| `server/api/queue.js` | +duplicate detection, +ETA fields, +band-queue/promote endpoint |
| `server/api/setlists.js` | Import populates band_queue instead of main_queue, +failed slugs reporting |
| `server/public/singer.html` | +ETA display, +band playing indicator |
| `server/public/band.html` | +ETA display, +Placeholder Duo card |
| `BUILD_LOG.md` | +this session |
| `web/server.js` (LSM bridge) | +explicitStop flag, +graceful stop, +volume endpoints, +volume persistence |

### Bumper Volume Behavior

Volume changes restart the current track immediately at the new volume for instant feedback. Volume persists to `~/.bumper-volume`. On next bridge server restart, it loads the saved volume.

---

## Session 11: System Stats + Bumper Auto-Next Fix — 2026-07-13

`#music #iphoneliveserver #stats #bumper`

### MacBook System Stats Row

Compact stats in top-right corner of TUI, polled efficiently:

| Metric | Source | Frequency | Display |
|--------|--------|-----------|---------|
| CPU | `os.cpus()` delta | Every 2s | `CPU 14%` |
| RAM | `os.freemem()` / `os.totalmem()` | Every 2s | `RAM 12GB` (used) |
| Temp | `pmset -g therm` | Every 30s | `Temp OK` / `WARM` / `HOT!` |
| Net | `ping 8.8.8.8` | Every 30s | `Net 19ms` (green/yellow/red) |

Temperature uses thermal pressure level (not raw °C) because M1 Macs don't expose sensor temperature without sudo. Thermal pressure is more useful — it tells you when the system is actually throttling.

### Bumper Auto-Next Fix

**Root cause**: `bumperPlay()` calls `bumperStop()` internally to clean up any old process. `bumperStop()` sets `bumperExplicitStop = true`. When the track ended naturally, the exit handler saw `bumperExplicitStop = true` and skipped auto-next, thinking it was an intentional stop.

**Fix**: `bumperPlay()` now resets `bumperExplicitStop = false` after calling `bumperStop()`. This way, natural track endings correctly trigger auto-next, while intentional stops (via API) still set the flag through `bumperStop()` directly.

Also fixed: `bumperStop()` now calls `removeAllListeners("exit")` before killing the process, preventing the old process's exit handler from firing after a new track has started.

### Skip Tracks

`POST /bumper/api/skip` now works correctly. Skips to next random track immediately.

### Files Changed

| File | Change |
|------|--------|
| `scripts/tui.js` | +system stats functions (refreshSysStats, refreshNetLatency, refreshThermal), +stats row in render |
| `web/server.js` (LSM bridge) | +`bumperExplicitStop = false` in bumperPlay, +`removeAllListeners` in bumperStop, +thermal pressure check |
