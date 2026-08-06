# Lyrics Scroll / Page Turner — Vision Document

## Overview

Add a **Settings Bar** at the bottom of the TUI (`scripts/tui.js`) and wire it into a new **Settings Menu** system with labeled category pages. The first page is a **Teleprompter** page containing lyrics scroll and page-turner configuration.

---

## Phase 1: Settings Bar (TUI Bottom Row)

### Placement
A dedicated bar at the very bottom of the TUI (below the LOG panel). It occupies the last 1–2 lines of the terminal.

### Keyboard Interaction

| Key | Context | Action |
|-----|---------|--------|
| `F2` (or `Ctrl+S` / a designated key) | Main TUI | **Focus** the Settings Bar — highlights it, releases queue/REAPER focus |
| `←` `→` | Settings Bar focused | Move selection cursor between "items" (settings chips/tiles) in the bar |
| `Enter` | Settings Bar focused | Open the full settings menu page for the selected item |
| `↑` `↓` | Settings Bar focused (on items without a sub-menu) | Cycle through available options for that item inline |
| `Esc` (or re-press focus key) | Settings Bar focused | Release focus back to the main TUI |

### Items in the Bar

For now, only one item:

| Item | Type | Action on Enter |
|------|------|-----------------|
| **Settings** | Menu | Opens the Settings Menu overlay (multi-page) |

Future items can be added later (e.g., "Bumper Vol", "Show Mode", "Karaoke") — the bar is designed to hold multiple chips.

---

## Phase 2: Settings Menu (Overlay)

When the user presses `Enter` on "Settings", a full-screen overlay appears showing **labeled pages** for settings categories.

### Navigation

| Key | Action |
|-----|--------|
| `←` `→` | Switch between category pages (tabs at top of overlay) |
| `↑` `↓` | Navigate settings fields within the current page |
| `Enter` | Edit selected field (text input, dropdown, or toggle) |
| `Esc` | Close settings menu, return to TUI |

### Pages

#### Page 1: General
*No settings yet. Placeholder for future settings (e.g., show defaults, QR options, server config).*

#### Page 2: Teleprompter
*Lyrics scroll and page-turner configuration.*

#### Page 3: Karaoke
*No settings yet. Will later absorb all karaoke-related settings currently in the `?` overlay (max songs between band, karaoke toggle, kick/ban options, etc.).*

---

## Page 2: Teleprompter — Detailed Specification

### Section: Sync / Scroll

#### Setting: Scroll / Page Turner Device

| Property | Value |
|----------|-------|
| **Type** | Dropdown / cycle |
| **Options** | `None`, `Bluetooth`, `OSC`, `Web Control` |
| **Default** | `None` |

Description of each option:
- **None**: No external scroll control. Lyrics scroll automatically via time-sync only.
- **Bluetooth**: For Bluetooth page-turner pedals/rings (e.g. Airturn, Donner, iRig BlueTurn). Pairs via HID keyboard events (arrow keys sent over BT).
- **OSC**: Open Sound Control messages from a dedicated device/app (e.g. TouchOSC on a tablet, a MIDI→OSC bridge).
- **Web Control**: Buttons rendered on the Mobile Phone Server page (port 3000 iPhone controller). WebSocket-driven scroll commands.

**Behavior**: Changing this setting gates the three button-mode settings below. When set to `None`, the button settings are **greyed out / disabled** in the UI.

---

#### Setting: Left Button Mode *(greyed out when Device = None)*

| Property | Value |
|----------|-------|
| **Type** | Dropdown / cycle |
| **Options** | `Rewind 2 seconds`, `Rewind 5 seconds`, `Rewind 10 seconds`, `Restart Section` |
| **Default** | `Rewind 5 seconds` |

Description of each option:
- **Rewind N seconds**: Jumps the teleprompter scroll position backward by N seconds (relative to current time-sync position).
- **Restart Section**: Jumps back to the beginning of the current verse/chorus/bridge/etc. Uses the song's section markers (`meta.json` sections array). If multiple verses of the same name exist, restarts the current occurrence. Used for adding an extra chorus, solo, or verse on the fly when the band extends a section.

---

#### Setting: Right Button Mode *(greyed out when Device = None)*

| Property | Value |
|----------|-------|
| **Type** | Dropdown / cycle |
| **Options** | `Skip 2 seconds`, `Skip 5 seconds`, `Skip 10 seconds`, `Next Section` |
| **Default** | `Skip 5 seconds` |

Description of each option:
- **Skip N seconds**: Jumps the teleprompter scroll position forward by N seconds.
- **Next Section**: Skips forward to the start of the next section in the song (e.g. skip the rest of verse 2, jump to chorus 2).

---

#### Setting: 3rd Button Mode *(greyed out when Device = None)*

| Property | Value |
|----------|-------|
| **Type** | Dropdown / cycle |
| **Options** | `Pause`, `Rewind 2 seconds`, `Rewind 5 seconds`, `Previous Section`, `Next Section`, `Hold + Right = Next Song`, `Hold + Left = Previous Song` |
| **Default** | `Pause` |

Description of each option:
- **Pause**: Freezes the teleprompter scroll. Press again to resume.
- **Rewind N seconds**: Same as Left Button behavior.
- **Previous Section**: Jumps back to the start of the previous section.
- **Next Section**: Jumps forward to the start of the next section.
- **Hold + Right = Next Song**: Holding the 3rd button + pressing Right loads the next song in the setlist queue.
- **Hold + Left = Previous Song**: Holding the 3rd button + pressing Left loads the previous song. If the current song is more than 10 seconds in, first press restarts from the beginning of the current song; second press goes to the previous song.

---

### Section: Display
*No settings yet. Placeholder for future settings (e.g., font size, chord display toggle, color theme, scroll speed factor, scroll smoothing, alignment).*

---

## Data Model

Settings are stored in `data/config.json` under a `teleprompter` key:

```json
{
  "teleprompter": {
    "scroll_device": "none",
    "left_button_mode": "rewind_5s",
    "right_button_mode": "skip_5s",
    "third_button_mode": "pause"
  }
}
```

Valid values:
- `scroll_device`: `"none"` | `"bluetooth"` | `"osc"` | `"web_control"`
- `left_button_mode`: `"rewind_2s"` | `"rewind_5s"` | `"rewind_10s"` | `"restart_section"`
- `right_button_mode`: `"skip_2s"` | `"skip_5s"` | `"skip_10s"` | `"next_section"`
- `third_button_mode`: `"pause"` | `"rewind_2s"` | `"rewind_5s"` | `"prev_section"` | `"next_section"` | `"hold_right_next_song"` | `"hold_left_prev_song"`

API endpoints (TBD in implementation):
- `GET /api/config/teleprompter` — return current teleprompter settings
- `POST /api/config/teleprompter` — update teleprompter settings (auth required)

---

## Implementation Plan

### Step 1: Settings Bar (Bottom Row)
- Add a new `settingsBarFocus` state variable to `tui.js`
- Add a keybinding (e.g. `Ctrl+S` or `F2`) to toggle focus
- Render a bottom bar with `[Settings]` chip
- Highlight the active chip when focused
- Handle `←` `→` for chip navigation, `Enter` to open menu, `Esc` to release focus

### Step 2: Settings Menu Overlay
- New render function `renderSettingsMenu()` — full-screen overlay
- Tab/page navigation at top (`General | Teleprompter | Karaoke`)
- `←` `→` to switch pages, `↑` `↓` to navigate fields, `Enter` to edit
- `Esc` to close

### Step 3: Teleprompter Page
- Build the Sync/Scroll section with Scroll Device dropdown + 3 button-mode dropdowns
- Grey out button settings when Device = None
- Wire settings to `data/config.json` read/write
- API endpoints for persistence

### Step 4: General + Karaoke Pages
- General: placeholder with "No settings yet" message
- Karaoke: placeholder — later migration of existing karaoke settings from `?` overlay

### Files Affected

| File | Change |
|------|--------|
| `scripts/tui.js` | +Settings Bar render, +Settings Menu overlay, +Teleprompter page, +key bindings |
| `data/config.json` | +`teleprompter` settings block |
| `server/api/auth.js` | +Teleprompter config GET/POST endpoints |
| `server/index.js` | +Route registration for teleprompter config |

---

## Design Decisions

1. **Settings Bar is always visible** — not a modal. It's part of the TUI layout (like the macOS menu bar). This keeps settings one keypress away.
2. **F2 / Ctrl+S for focus** — avoids conflicting with the many existing single-key bindings in the TUI. The key should be easy to reach but not accidentally triggered.
3. **Multi-page menu with tabs** — scales cleanly. Adding a new category just adds a tab.
4. **Button modes are dependent on Device** — greyed out states communicate that these options require a device to be meaningful. Prevents confusion.
5. **Config stored in `config.json`** — follows existing project convention. No new config file.
6. **Sections with labeled headers** — consistent with other UIs in the system (settings overlay, preflight checklist). Makes the page scannable.
