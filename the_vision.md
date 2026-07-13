# The Vision — Live Music Performance Rig

## Overview

A unified, local-network-based live performance system. The centerpiece is an **iPhone 7 webserver** that acts as the show's main controller, talking back to **REAPER** via its existing API. The system serves multiple audiences simultaneously: the performer (me), the band, the audience (karaoke singers), and the teleprompter operator.

Everything runs on the local network — no internet dependency for core functionality. The system uses GitHub Pages for auxiliary information (tips/follow-us page) and the Airport Extreme WiFi as the venue network.

---

## Core Architecture

### Hardware

| Device | Role | Notes |
|--------|------|-------|
| **MacBook M1 Pro 2020** | Main machine — runs REAPER, all audio/MIDI, the iPhone webserver | Everything originates here |
| **MacBook M1 Air 2020** | Backup / secondary | Can run teleprompter display or serve as backup show machine |
| **Raspberry Pi 3 B+** | Dedicated teleprompter output | HDMI out to teleprompter monitor, runs a browser in fullscreen |
| **Dell Inspiron 7520** | Spare — could run Linux | Additional teleprompter or fallback if needed |
| **iPhone 7** | Primary control surface | Web browser navigating the show control server |
| **AirPort Extreme** | Venue WiFi | Local-only network — no internet required for core show operations |

### Network Topology

```
AirPort Extreme (local WiFi, no internet required)
  ├── MacBook M1 Pro (server:3300, REAPER)
  ├── iPhone 7 (browser → server)
  ├── Band members' phones (browser → /band)
  ├── Guest singers' phones (browser → /singer via QR code)
  ├── Raspberry Pi 3 B+ (browser → /teleprompter, fullscreen, HDMI → monitor)
  └── Internet (optional — only for GitHub Pages tips page)
```

Authentication: password lock + configurable device whitelist (iPhone 7 itself never needs to log in). Singer queue is fully public (no auth).

---

## Pages / Views

All served from a **single Express server on port 3300** (one process, minimal resource usage):

### 1. Main Show Control (`/`)
*The performer's primary interface on iPhone 7.*

**Setlist management:**
- Song browser with search (by title, artist, key)
- Sortable by genre, artist, key, BPM
- Songs can belong to multiple genres
- Tap a song to add it to the queue, or select it for immediate play

**Queue system:**
- "Next up" queue built within the app — add songs at any time (before show, during a song, mid-queue)
- Navigate forward AND backward through the queue
- Queue only "clears" when you reach the end (no auto-deletion after playing)
- Visual indicator of current song vs upcoming vs played
- Drag/reorder support

**Song load lifecycle:**
1. **Start Setlist** button → loads the first song in the queue
2. **Load Next** / **Load Prev** → loads the target song fully
3. "Loaded" means: stems and MIDI cues loaded in REAPER, lyrics/chordcharts on teleprompter, iPhone app updates
4. Song does NOT start playing — it waits for a **Play** command
5. **Play** button starts the loaded song (future: MIDI footswitch or external button)

**Future tabs (not yet implemented):**
- Lighting control page
- Mixer master page with sub-pages for IEM mixes
- Per-song FX control

### 2. Band View (`/band`)
*For band members on their own phones.*

- Read-only view of the current queue
- Current song display (title, artist, key, BPM, status)
- "Placeholder Duo" slot — highlighted band song slot per round
- Teleprompter launcher button (opens teleprompter in new window/tab)
- No authentication required once on the network

### 3. Singer Queue (`/singer`)
*Public karaoke-style signup, accessible via QR code.*

**Flow:**
1. Guest scans QR code (on table tent or stage) → connects to Airport Extreme WiFi → opens `/singer`
2. Enters their name (profanity-filtered — 200+ word blocklist, case-insensitive)
3. Browses the full song library — search by song name or artist, filter by genre, sort by title/artist/key
4. Picks a song → added to bottom of the singer queue (FIFO per round)
5. Sees their position in the queue and the song they picked

**Queue management:**
- Managed queue like PCDJ karaoke software
- Round-based: each "round" clears, increments counter, starts fresh
- Singers are queued with their name + chosen song
- Band can promote a singer to the main queue

**Placeholder Duo:**
- At the top of each round, a highlighted slot for "Placeholder Duo"
- The band plays a song of our choosing here
- If the band has a queue, this slot pulls from the band's queue automatically
- Displayed on the server, teleprompter, and show manager — same as any other loaded song
- Ensures the band gets a song every round

**Tip the Band:**
- Prominent button on the singer page
- Links to the GitHub Pages tips/follow-us page (configurable URL in `data/config.json`)
- Works even without internet if linked to the local page; full functionality with internet

### 4. Teleprompter (`/teleprompter`)
*Full-screen lyrics + chord display for external monitor.*

- Auto-detects the currently loaded/playing song
- Displays lyrics from `meta.json` with chord highlighting
- Section headers show bar numbers
- Fullscreen mode for dedicated teleprompter output
- Intended for Raspberry Pi 3 B+ or old laptop driving HDMI to a monitor/TV
- Auto-refreshes when a new song is loaded

### 5. Login (`/login.html`)
*Simple password gate.*

- Single password (configurable in `data/config.json`)
- Device whitelist — registered devices (like the iPhone 7) bypass login entirely
- 7-day cookie persistence after login
- Singer queue is public — no login required

---

## Song Library

Sourced from `~/ReaperSongs/` — the existing 225-song library built during LiveShowManager sessions. Each song has:
- `meta.json` — title, artist, BPM, key, duration, sections, lyrics, cue events
- Audio stems — reference, drums, keys, samples (MP3 format, ~26MB per song)
- MIDI cues — `cue_sections.mid` (PC events) and `cue_automation.mid` (CC automation)

**Genre support:**
- Stored separately in `data/genre-map.json` (not in meta.json, which is REAPER's source of truth)
- Songs can belong to multiple genres
- 16 current genres: blues, blues_rock, classic_rock, country, country_rock, folk, funk, pop, punk, reggae, rock, rock_and_roll, rockabilly, soul, southern_rock, swamp_rock
- 80+ songs tagged so far; new songs get tagged as they're imported

---

## Authentication & Security

| Access Level | Requirement |
|---|---|
| Show control, Band view, Teleprompter | Password or whitelisted device |
| Singer queue | None (public) |
| API (singer endpoints) | None (public) |
| API (all other) | Password or whitelisted device |

**Device whitelisting:**
- Configurable in `data/config.json` → `devices` object
- Each device has an ID, name, and `requires_auth` flag
- iPhone 7 (`iphone7-danny-01`) is pre-configured to skip auth
- Device ID sent via `X-Device-Id` header or `device_id` cookie

---

## WiFi & Internet Strategy

1. **Primary:** Airport Extreme WiFi — local only, no internet needed
2. **QR code** on table tents connects phones to the Airport Extreme WiFi (with password)
3. **GitHub Pages** hosts the tips/follow-us page (only needs internet for that one link)
4. **No WiFi at the venue?** VPN hosting as a secondary option (but not preferred — latency and reliability concerns)

The system is designed to work with ZERO internet — the server, song library, and all pages are local.

---

## Operations & Deployment

### Launching

One command:

```bash
start show server
```

This is a zsh function in `.zshrc` that:
1. Checks if the Express server is already running on port 3300
2. Installs npm dependencies if missing
3. Launches the **TUI** (Terminal User Interface) — a live dashboard

### TUI (Terminal User Interface)

The TUI is a full-screen terminal dashboard (`scripts/tui.js`) that replaces the need to juggle multiple terminal windows. It shows:

| Section | Content |
|---------|---------|
| Header | Server status (● running / ● stopped), port |
| Now Playing | Current song title, artist, key/BPM, play status |
| Queue | Numbered queue with current song highlighted (★) |
| Singer Stats | Number of waiting singers, current round |
| Links | Quick-access URLs for /band, /singer, /teleprompter |
| Action Bar | All keyboard shortcuts visible at all times |
| Log Panel | Timestamped event log (song loads, queue changes, errors) |

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `p` | Play the loaded song |
| `n` | Load next song in queue |
| `v` | Load previous song in queue |
| `s` | Stop current song |
| `Space` | Start setlist (load first song) |
| `a` | Add song to queue (prompts for slug) |
| `c` | Clear entire queue |
| `l` | Toggle log view |
| `r` | Restart server |
| `q` | Quit (also stops the server) |

No memorization needed — the action bar is always visible.

### Server Resource Usage

| Metric | Measured |
|--------|----------|
| RAM (idle) | ~63 MB |
| RAM (under load) | ~67 MB |
| CPU | ~0% idle, negligible under load |
| Startup time | ~1 second |
| Disk (project) | ~8 MB (including node_modules) |

This runs easily on any machine — including the MacBook M1 Air or even a Raspberry Pi 4.

### Handling 10–20 Singers

No issues. Here's why:

1. **Lightweight polling** — The singer page polls `/api/singer/queue` once every 5 seconds. 20 singers × 1 request/5s = **4 requests/second**. Express handles hundreds per second without breaking a sweat.

2. **Client-side song library** — The entire song list (~225 songs) is fetched **once on page load** and cached in the browser. Browsing, searching, and filtering happen entirely client-side — zero server hits while scrolling through songs.

3. **No race conditions on signup** — Node.js is single-threaded. Queue writes use `readFileSync`/`writeFileSync` (blocking I/O). Two concurrent signups are serialized by the event loop — the second literally cannot start until the first finishes writing.

4. **Small payloads** — The queue endpoint returns a tiny JSON array (singer name + song title). Even with 50 entries, it's <5 KB per response.

5. **No WebSockets needed** — Polling is simpler, more reliable on flaky WiFi, and consumes negligible bandwidth at this scale. WebSockets would add complexity with no benefit at 20 users.

The system would handle 100+ concurrent singers before any tuning was needed. At that point you'd add a rate limiter and move to in-memory queue storage — but that's not necessary for any venue this rig will play.

## REAPER Integration

The iPhone webserver triggers song loads via the existing LiveShowManager API:
- `POST /api/songs/:slug/load` — tells REAPER to load stems, MIDI cues, and reference track
- REAPER's Lua script polls for load triggers and executes the load
- Future: bidirectional sync — REAPER sends status back to the iPhone server

---

## Future Features (Not Yet Built)

- **Lighting control** — DMX via MIDI or Art-Net, controlled from the iPhone
- **Mixer master** — volume/mute/solo for all tracks, with IEM mix sub-pages
- **MIDI footswitch support** — next/prev/play via foot controller
- **Per-song FX recall** — guitar amp sims, pedal settings per song
- **Setlist planning mode** — build and rearrange setlists before the show
- **Statistics** — songs played, audience requests fulfilled, set duration tracking
- **Per-song notes/reminders** — capo position, tuning, special cues
- **Drag-to-reorder queue** on mobile
- **Genre tagging UI** within the app

---

## Implementation Status

| Component | Status |
|-----------|--------|
| Project scaffold, package.json | ✅ |
| Express server (port 3300) | ✅ |
| Auth (password + device whitelist) | ✅ |
| Song library index (225 songs) | ✅ |
| Genre map (80+ songs, 16 genres) | ✅ |
| Song search/sort/filter API | ✅ |
| Queue engine (add, next, prev, play, reorder, remove, clear) | ✅ |
| Queue persistence to disk | ✅ |
| Singer queue (FIFO, rounds, promote, clear) | ✅ |
| Profanity filter (200+ word blocklist) | ✅ |
| Main Show Control page (search, queue, play controls) | ✅ |
| Singer Queue page (browse, signup, tip button) | ✅ |
| Band View page (queue, Placeholder Duo, teleprompter launcher) | ✅ |
| Teleprompter page (lyrics/chords display) | ✅ |
| Login page | ✅ |
| Config (password, whitelist, tip URL) | ✅ |
| REAPER load trigger integration | ✅ |
| Lighting control page | ⬜ |
| Mixer master / IEM mix page | ⬜ |
| MIDI footswitch support | ⬜ |
| Genre tagging UI | ⬜ |
| Drag-to-reorder on mobile | ⬜ |
| Statistics | ⬜ |
| CLI script + shell alias | ✅ `start show server` |
| TUI dashboard | ✅ `scripts/tui.js` |
| 10-20 singer concurrency | ✅ Handles 100+ singers without tuning |
| GitHub Pages tips page | ⬜ (needs deployment) |
| QR code generation | ⬜ |
