# Singer Queue — Design & Build Log

`#music #iphoneliveserver #karaoke #singer-queue`

## Overview

The singer queue is the public-facing karaoke signup system. Guests scan a QR code at the venue, connect to the local WiFi, and pick songs from the full song library. Each singer gets up to 2 songs per round — one for the current round, one for the next. Songs are locked in once the singer is close to being called up.

---

## Architecture

### Data Model

Every singer queue entry:
```
{
  id: "unique-id",
  singer: "Alice",
  song_slug: "Take It Easy",
  song_title: "Take It Easy",    // resolved from meta.json at add time
  song_artist: "Eagles",
  timestamp: 1783967703657,
  round: 1                       // current round number
}
```

- **Resolved at add time**: title and artist are read from `meta.json` immediately. Even if the song folder is deleted later, the queue entry still displays correctly. No dangling references.
- **Round-based**: each entry is tagged with the current round. When a round is cleared (`clear-round`), only current-round entries are removed. This enables multi-round nights while keeping historical data.
- **ID is server-generated**: `Date.now().toString(36) + random` — collision-safe, URL-safe, no dependency on client input.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/singer/queue` | List all queued singers |
| `POST` | `/api/singer/add` | Add a singer with one song |
| `POST` | `/api/singer/change` | Change a singer's song choice |
| `POST` | `/api/singer/leave` | Remove all of a singer's songs |
| `DELETE` | `/api/singer/queue/:id` | Remove a specific entry |
| `POST` | `/api/singer/clear-round` | Clear current round, increment counter |
| `POST` | `/api/singer/promote` | Promote a singer entry to the main queue |

### Storage

Queue persisted to `data/queue.json` using `readFileSync`/`writeFileSync`. This is intentionally blocking I/O:

- Node.js is single-threaded. Two concurrent singer adds are serialized by the event loop — the second cannot start until the first finishes writing.
- At 10–20 concurrent signups, no race conditions are possible.
- File is tiny (<5 KB even with 50 entries) — writes in microseconds.
- Survives server restart.

---

## Design Decisions

### Decision 1: Two Songs Per Singer (Not One, Not Unlimited)

**Why not 1 song?** A singer who drives 30 minutes to the venue should get more than one chance to perform. Live band karaoke is more intimate than machine karaoke — fewer singers, longer songs, bigger commitment. Two songs gives them a shot at the current round AND a guarantee they'll be called up again.

**Why not 3+?** With 15–20 singers on a busy night, 2 songs each = 30–40 queue entries. At 4 minutes per song, that's 2+ hours of music — a full night. Three songs would push past venue closing time and make late arrivals wait too long.

**Why not unlimited?** Hoarding. One enthusiastic singer could fill the queue with 10 songs, blocking everyone else. The limit is a social contract enforced by software — fair access for everyone.

**Implementation**: Server-side check in `POST /api/singer/add` — `singer_queue.filter(e => e.singer === name && e.round === round).length >= 2` returns a 400 error. Client-side, the "Add Another Song" button disappears after the second slot is filled.

### Decision 2: Song Change with Lock-In

**Why allow changes at all?** People change their minds. A singer picks "Free Bird" then realizes it's 9 minutes long. Or they hear someone else do "Wagon Wheel" and want to switch to something different. Letting them change reduces awkward on-stage moments ("actually, can I do...") and makes the queue more accurate.

**Why lock songs close to performance?** The band needs time to prepare. If a singer changes their song when they're next in line, the band might not have the stems loaded, the key might be wrong, or the chart might not be ready. Locking at 3 positions away gives the band at least 12 minutes (3 songs × 4 min) of notice.

**What "3rd in the queue" means**: Position 0, 1, and 2 are locked. Position 3+ can change. "Position" is the index in the `singer_queue` array — not the main queue. Once promoted to the main queue, the singer entry is no longer in the singer queue.

**Implementation**: `POST /api/singer/change` checks `position = singer_queue.indexOf(entry)`. If `position < 3`, returns `{ locked: true, error: "..." }`. Client shows the lock message in a modal.

### Decision 3: Client-Side Song Library

**Why client-side?** The full song library (~225 songs, ~30 KB JSON) is fetched once on page load and cached in the browser. All searching, filtering, and sorting happens in JavaScript — zero server hits per keystroke. At 20 concurrent singers all typing search queries, this avoids 20 req/s pounding the server.

**Why not server-side search?** The server is already handling queue writes, auth, config, and REAPER triggers. Offloading search to the client keeps the server's hot path clean. The song library changes slowly (new songs added between gigs, not during) so caching is safe.

**Genre filtering** uses a separate `data/genre-map.json` file, kept out of `meta.json` because meta.json is REAPER's source of truth. Genres are a show-management concern, not a REAPER concern.

### Decision 4: Name-Based Queue Ownership

**Why track by singer name, not device/cookie?** In a bar, people share phones. A couple shares one phone — they both need separate queue entries. A cookie would conflate them. Names are explicit, human-readable, and work across devices.

**Tradeoff**: Same-name collisions. Two "Mike"s at the same show. Mitigation: display the position number and song title so each Mike can identify his own entry. Future: add a 4-digit PIN display after submission ("Your PIN is 4821 — use this to change songs").

**Device persistence via localStorage**: After a singer submits their name, it's saved to `localStorage` on their device. If they refresh the page, lose WiFi and reconnect, or close and reopen their browser — the page auto-restores their session from localStorage and jumps straight to the "Your Songs" dashboard. No re-entering names. On leave, localStorage is cleared. This is intentionally client-side only — no server tracking, no cookies, no fingerprinting. It's tied to the device (phone), which is a reasonable proxy for "the same person" in a venue setting where people rarely swap phones mid-show. Tradeoff: if someone borrows a phone, they inherit the previous user's session. A "Not you?" button could be added in V2.

**Profanity filter**: 200+ word blocklist, case-insensitive, substring matching. Applied server-side on every add. Client-side validation would be trivially bypassed. The filter is intentionally aggressive — false positives (rejecting a legitimate name) are acceptable; false negatives (allowing an offensive name on stage) are not.

### Decision 5: "Leave" Button as a Social Grace

**Why a leave button?** Without it, a singer who decides to go home has no way to clean up their queue entries. The band calls their name, waits, realizes they left — awkward silence, wasted time. The leave button lets them remove themselves gracefully.

**Why a confirmation modal?** Accidental tap prevention. The confirmation explains what will happen ("This will remove all your songs") so there's no confusion. The thank-you message ("Thanks for coming! Come back anytime.") turns a functional action into a warm social interaction — important for a venue experience.

**Implementation**: `POST /api/singer/leave` removes all entries for that singer in the current round. Returns count of removed entries. Client shows a wave emoji and thank-you text on success. The "Reset & start over" button is replaced with "Join the queue" — allowing the singer to jump back into the flow without refreshing the page. This is critical for the real-world case where someone leaves, changes their mind, and immediately wants to rejoin.

---

## Client Flow

```
┌─────────────────────────────────────────────────────────┐
│                    SINGER PAGE FLOW                       │
│                                                           │
│  Step 1: Name            Step 2: Pick Song               │
│  ┌─────────────┐        ┌─────────────────────┐          │
│  │ Enter name   │──────▶│ Search/filter songs  │          │
│  │ [Next]       │        │ Select one           │          │
│  └─────────────┘        │ [Join Queue]         │          │
│                          └────────┬────────────┘          │
│                                   │                       │
│                    ┌──────────────▼──────────────┐        │
│                    │    Your Songs Dashboard     │        │
│                    │                             │        │
│                    │  ┌───────────────────────┐  │        │
│                    │  │ This Round            │  │ [Leave]│
│                    │  │ "Take It Easy" ▶     │  │        │
│                    │  └───────────────────────┘  │        │
│                    │  ┌───────────────────────┐  │        │
│                    │  │ Next Round   (yellow)  │  │        │
│                    │  │ "Hotel California" ▶  │  │        │
│                    │  └───────────────────────┘  │        │
│                    │                             │        │
│                    │  [Add Another Song]         │        │
│                    │  [Reset & start over]       │        │
│                    └──────────┬──────────────────┘        │
│                               │                           │
│                    ┌──────────▼──────────┐                │
│                    │   Song Modal         │                │
│                    │                      │                │
│                    │  "Your Song"         │                │
│                    │  "Take It Easy"      │                │
│                    │                      │                │
│                    │  [Change Song]       │                │
│                    │  [Go Back]           │                │
│                    └──────────────────────┘                │
│                                                           │
│  Lock-in Modal (pos < 3):                                │
│  ┌─────────────────────────────────────────┐             │
│  │ "Sorry, your song cannot be changed     │             │
│  │  at this time. Songs are locked-in      │             │
│  │  once you are 3rd in the queue."        │             │
│  │                                         │             │
│  │  [Go Back]                              │             │
│  └─────────────────────────────────────────┘             │
│                                                           │
│  Leave Confirmation:                                      │
│  ┌─────────────────────────────────────────┐             │
│  │ "Leave the queue?                       │             │
│  │  This will remove all your songs.       │             │
│  │  You can always rejoin later."          │             │
│  │                                         │             │
│  │  [Yes, remove my songs]                 │             │
│  │  [Go Back]                              │             │
│  └─────────────────────────────────────────┘             │
│                                                           │
│  Leave Thank-You:                                         │
│  ┌─────────────────────────────────────────┐             │
│  │  👋 Thanks for coming!                  │             │
│  │  Your songs have been removed.          │             │
│  │  Come back anytime.                     │             │
│  └─────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

---

## Concurrency & Scale

### Worst-Case Analysis: 20 Singers, Simultaneous Signup

At a busy night with 20 people all signing up within the same 60-second window:

**Queue writes**: All pass through `loadQueue()` → modify array → `saveQueue()`. Because `saveQueue` uses `writeFileSync`, the event loop serializes writes naturally. If signer A's write starts at T+0ms and takes 0.5ms, signer B's write starts at T+0.5ms. No `fs.writeFile` race conditions possible.

**Song library loads**: All 20 phones fetch `/api/songs/search?per_page=500` on page load. 20 requests within a few seconds. Express handles this trivially — the response is a cached in-memory array after the first call loads from disk. ~30 KB per response × 20 = 600 KB total.

**Polling load**: Each phone polls `/api/singer/queue` every 5 seconds. 20 phones × 1 req/5s = 4 requests/second. Express can handle hundreds per second without tuning.

**Memory**: 20 queue entries × ~200 bytes = 4 KB. Negligible.

The system would handle 100+ concurrent singers before any optimization was needed. At that point, move to an LRU cache for the song library and add a simple rate limiter.

---

## Files

| File | Purpose |
|------|---------|
| `server/api/queue.js` | Singer queue endpoints (add, change, leave, clear, promote) |
| `server/public/singer.html` | Full singer UI — name entry, song picker, dashboard, modals |
| `data/queue.json` | Persisted queue state |
| `data/genre-map.json` | Genre tags per song |
| `server/api/profanity.js` | 200+ word profanity blocklist |
| `server/api/songs.js` | Song library index from `~/ReaperSongs/` |
| `server/api/auth.js` | Config loader (karaoke_enabled toggle, tip_url) |

---

## Future Enhancements (V2)

- **PIN system**: 4-digit PIN displayed after submission. Singer uses PIN to identify themselves for song changes instead of name matching. Solves same-name collisions.
- **Queue position notifications**: Singer's browser shows a countdown ("You're 4 songs away!") with an optional vibration/notification when they're next.
- **Pre-loaded song status**: Show which songs the band has stems loaded for vs. needs prep time for. Stems-loaded songs get a green badge.
- **Drag-to-reorder**: Band can reorder the singer queue by dragging entries.
- **Singer history**: Track which singers have performed before across multiple nights. Return visitors get a "Welcome back!" badge.
- **Song request voting**: Audience can upvote songs in the singer queue. Higher-voted songs float to the top.
- **QR code generation**: Auto-generate venue-specific QR codes from the server config.

---

## Edits / Updates

### [2026-07-13] "Join the queue" button after leave

After a singer leaves, the page showed "Thanks for coming!" with no way to rejoin without refreshing. This is a real-world problem — someone leaves, changes their mind 30 seconds later, and can't get back in.

**Fix**: The "Reset & start over" button is replaced with "Join the queue" on leave. It calls `resetAll()` which clears the form and returns to step 1 (name entry). The singer can immediately rejoin with the same flow. The leave button is also hidden since the singer no longer has songs in the queue.

### [2026-07-13] PCDJ Two-Queue Rotation System

**Before**: Flat `singer_queue` array — everyone in one list, cleared per round. New singers went to the end, and there was no way to control when they entered the active rotation. The band had no concept of "this round's singers" vs "people waiting their turn."

**After**: PCDJ-style two-queue system modeled after professional karaoke hosting software:

```
waiting_list  →  active_rotation  →  performance
 (new signups)    (current round)     (singer finishes)
```

#### Why Two Queues?

A flat queue fails for live band karaoke for three reasons:

1. **New singers don't know when they'll be called.** In a flat FIFO queue with 15 people, singer #15 has no idea if they'll sing in 10 minutes or 2 hours. With a waiting list, they know: "I'll be promoted when the next round starts."

2. **The band needs a manageable round size.** Playing 15 singers in a row with no break is exhausting. With `start-round` promoting exactly 2 singers per round, each round is predictable — the band plays a few, takes a break, plays more. The round size is a lever the band controls, not dictated by however many people signed up.

3. **Late arrivals get fair treatment.** Someone who arrives at 10 PM doesn't jump ahead of someone waiting since 9 PM. But they also don't wait 2 hours. The waiting list is FIFO, and each round pulls the next 2. A person arriving late waits through at most 1-2 rounds before being promoted — predictable and fair.

#### How It Works

```
Round 1 starts:
  waiting_list: [Alice, Bob, Carol, Dave, Eve]
  → start-round promotes 2
  active_rotation: [Alice, Bob]
  waiting_list: [Carol, Dave, Eve]

Band plays: Alice performs → complete → Alice removed
              Bob performs → complete → Bob removed

Round 2 starts:
  waiting_list: [Carol, Dave, Eve]
  → start-round promotes 2
  active_rotation: [Carol, Dave]
  waiting_list: [Eve]

...new signups keep joining waiting_list...
  waiting_list: [Eve, Frank, Grace]
  → start-round promotes 2
  active_rotation: [Eve, Frank]
  waiting_list: [Grace]
```

Key invariants:
- A singer can only be in ONE list at a time
- `start-round` promotes exactly `Math.min(2, waiting_list.length)` singers
- 2 is the default; configurable for different venue sizes
- Round counter increments only on `start-round`
- `complete` removes a singer from active_rotation after performance
- `leave` removes from whichever list the singer is in

#### Lock-in behavior
- Lock-in (can't change song) only applies to active_rotation positions < 3
- Waiting list singers can always change their song (they haven't been called up yet)
- This is more permissive than the flat queue — a singer at waiting_list position 1 can change their song, whereas before they'd be position 0 and locked

#### Client display
The singer page shows two sections in the queue display:
- **Active Rotation** (green badge, full opacity) — these singers are up this round
- **Waiting List** (gray badge, dimmed) — these singers go next round
- Each singer sees their own position and whether they're active or waiting
- "You're in the rotation!" vs "You're in the waiting list!" — clear status messaging

**Device persistence**: `localStorage.setItem('singerName', name)` on every submit. On page load, if a saved name exists, skip directly to the "Your Songs" dashboard. This handles refreshes, WiFi drops, and accidental tab closes. `localStorage.removeItem('singerName')` on leave. Zero server cost — pure client-side persistence tied to the device.

**Advanced profanity filter rewrite**: The original filter was a flat list of ~70 words with basic `\b` word boundary regex matching. Easily bypassed with leetspeak (`sh1t`, `@ss`), repeated characters (`fuuuuck`), or separator characters (`f.u.c.k`).

The new filter uses a normalization pipeline:
1. **Leetspeak substitution** — 20+ character mappings (1→i, @→a, $→s, 0→o, etc.)
2. **Separator stripping** — removes `.` `-` `_` `*` and spaces, collapsing `f.u.c.k` → `fuck`
3. **Repeated character cap** — runs of 3+ capped at 2 (`fuuuuuck` → `fuuck`)
4. **Full collapse** — secondary form collapses ALL repeats for dictionary lookup (`heeeeeell` → `hel`, matches `hell`)
5. **Categorized blocklist** — 120+ words across slurs (zero tolerance), sexual explicit, insults, moderate, drugs, and obfuscation variants
6. **False positive exception list** — 40+ common English words that contain profanity substrings (class, hello, assumption, scunthorpe, etc.) are explicitly excluded

Result: 60/60 test cases passing — catches leetspeak, repeated chars, separator obfuscation, and compound words while correctly passing all common English words. All server-side (client-side validation is trivially bypassed).

**"Reset & start over" removed**: All destructive actions (leaving queue, removing songs) are behind confirmation modals with explicit "Yes, remove" / "Go Back" choices. No one-tap-destroy buttons. The only way to exit the queue is via the "Leave" button with its confirmation.

**Confetti**: 20 subtle CSS-animated particles in the background. Slow fall (8–20s), pastel show colors, `pointer-events: none`. Purely atmospheric — adds energy without being distracting. No JS animation loops, no performance impact.

**Title branding**: "Live Band Karaoke with Placeholder Duo!" — consistent with the full project's labeling.

**Subtitle simplification**: "You can add up to 2 songs at a time" — clear, static, works whether they have 0, 1, or 2 songs.

### Verified Show-Ready

- [x] 2-song limit enforced server-side (third add returns 400)
- [x] Song change works for positions ≥ 3
- [x] Lock-in message for positions 0–2
- [x] Leave removes all songs + shows thank-you + "Join the queue" button
- [x] localStorage persists session across refreshes
- [x] All destructive actions behind confirmation modals
- [x] Profanity filter active on all name inputs
- [x] Karaoke pause/disable toggle functional
- [x] Queue displays correctly with round tracking
- [x] Tip the Band link loads from server config
