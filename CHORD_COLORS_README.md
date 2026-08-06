# Chord Color System — README

## Overview

Chords displayed in the Live Show Remote (iPhone controller) and Teleprompter (Stage HUD) are color-coded by chord quality. This provides instant visual recognition of the harmonic structure — you can see whether the next chord is major, minor, a power chord, or something more complex without reading the text.

## Color Mapping

| Chord Type | Color | Hex | CSS Variable | Example Chords |
|------------|-------|-----|-------------|----------------|
| **Major** | Yellow | `#f1c40f` | `--chord-major` | `A`, `C#`, `F7`, `Dmaj7` |
| **Minor** | Light Blue | `#3498db` | `--chord-minor` | `Am`, `Bm7`, `F#m9`, `Emaj7` |
| **Power Chord** | Orange | `#ff8800` | `--chord-power` | `A5`, `D5`, `E5` |
| **Complex** | Light Purple | `#9b59b6` | `--chord-complex` | `Bdim7`, `Caug5`, `F#m7b5`, `D7b9` |

All chord text is rendered **BOLD** (`font-weight: 700`).

## Detection Rules

The parser classifies chords by examining the text inside brackets `[` `]`:

```
[A]       → Major (root: A)
[Am]      → Minor (root: A, quality: m)
[Am7]     → Minor (root: A, minor quality detected via 'm')
[A5]      → Power chord (root: A, "5" suffix, no 3rd)
[Bdim7]   → Complex (root: B, dim/diminished quality)
[Caug]    → Complex (root: C, aug/augmented quality)
[C+]      → Complex (root: C, "+" symbol = augmented)
[Dm7b5]   → Complex (root: D, m7b5 = half-diminished)
[Esus4]   → Major (root: E, sus4 is a major-family suspension)
[F7]      → Major (root: F, dominant 7th defaults to major quality)
[Gmaj7]   → Major (root: G, explicit "maj" indicator)
```

### Classification Logic

```
1. Power chord: contains "5" and no "m" → ORANGE
2. Complex: contains "dim", "aug", "+", "m7b5", "°", "ø" → PURPLE
3. Minor: contains "m" (but NOT "maj" or "m7b5") → BLUE
4. Major: everything else → YELLOW
```

### "Flavor of the Chord" — Always Displayed

The chord's extension/flavor is always shown alongside the root. This text is rendered in a smaller font, non-bold, slightly dimmed:

| Chord | Root Display | Flavor Display |
|-------|-------------|----------------|
| `A7` | **A** | `7` |
| `Am9` | **Am** | `9` |
| `Dmaj7` | **D** | `maj7` |
| `G7b9` | **G** | `7b9` |
| `E5` | **E5** | *(no flavor)* |
| `F#dim7` | **F#** | `dim7` |
| `Cm7b5` | **Cm** | `7b5` |

The flavor is extracted by stripping the root note and any accidental (#/b), then splitting on "m" / "maj" / "dim" / "aug" qualifiers, leaving the numeric extension.

## Font Sizing

On the **Lyrics page** iPhone view:
- **Chords**: 2× the lyrics font size
- **Lyrics**: Controlled by vertical slider (scalable)

On the **Teleprompter** (Stage HUD):
- **Chords**: 1.3× the lyrics font size (configurable later)

## Chord Help Overlay

A `?` button on the Lyrics/Teleprompter page opens a popup explaining the color system:

```
┌──────────────────────────────────────┐
│  Chord Colors                        │
│                                      │
│  • • • • • • • • • • • • • • • •   │
│                                      │
│  Yellow      Major chords      A     │
│              (no suffix)       D7    │
│                                Gmaj7 │
│                                      │
│  Blue        Minor chords      Am    │
│              (m suffix)        Bm7   │
│                                F#m9  │
│                                      │
│  Orange      Power chords      A5    │
│              (5 suffix)        D5    │
│                                E5    │
│                                      │
│  Purple      Complex chords    Bdim7 │
│              (dim, aug, m7b5)  Caug  │
│                                D7b9  │
│                                      │
│  ☐ Show chord color help on          │
│    Teleprompter                      │
│  ☐ Display chord help by default     │
│                                      │
│  [Close]                             │
└──────────────────────────────────────┘
```

### Help Popup Behavior

Two checkboxes at the bottom of the popup:

1. **"Show chord color help on Teleprompter"** — When checked, displays a small vertical legend overlay on the left side of the teleprompter screen (vertically centered, does not block lyrics). Shows:
   ```
   YEL = Major
   BLU = Minor
   ORG = Power
   PUR = Complex
   ```
   This checkbox is **transient** — it toggles the overlay for the current session only.

2. **"Display chord help by default"** — When checked, saves `chord_help_default: true` to config (persisted via `localStorage` on iPhone, or `data/config.json` for teleprompter). On next boot, the chord help overlay is automatically enabled. Unchecking prevents auto-enable on subsequent boots.

### Checkbox Interaction Logic

| Action | State Before | State After |
|--------|-------------|-------------|
| Check "Show chord help" while "Display by default" is unchecked | Overlay: off, Default: off | Overlay: ON, Default: off |
| Uncheck "Show chord help" while "Display by default" is unchecked | Overlay: on, Default: off | Overlay: OFF, Default: off |
| Check "Show chord help" while "Display by default" is checked | Overlay: on, Default: on | Overlay: ON, Default: on |
| Uncheck "Show chord help" while "Display by default" is checked | Overlay: on, Default: on | Overlay: OFF, Default: ON |
| Check "Display by default" independently | Overlay: any, Default: off | Overlay: unchanged, Default: ON |
| Uncheck "Display by default" independently | Overlay: any, Default: on | Overlay: unchanged, Default: OFF |

Key rule: **"Display by default" never changes the current overlay state**. It only controls what happens on next boot. To turn the overlay off AND prevent it from re-appearing, uncheck both boxes.

On boot: if `chord_help_default === true`, set the overlay to ON (and "Show chord help" checkbox to checked).

## CSS Implementation

```css
:root {
  --chord-major: #f1c40f;
  --chord-minor: #3498db;
  --chord-power: #ff8800;
  --chord-complex: #9b59b6;
}

.chord-major { color: var(--chord-major); font-weight: 700; }
.chord-minor { color: var(--chord-minor); font-weight: 700; }
.chord-power { color: var(--chord-power); font-weight: 700; }
.chord-complex { color: var(--chord-complex); font-weight: 700; }

.chord-flavor {
  font-size: 0.7em;
  font-weight: 400;
  opacity: 0.7;
  vertical-align: super;
}
```

## Teleprompter Integration

The teleprompter (Stage HUD) already renders chord-bracketed text. The parser in `server.js` strips brackets for display. The chord color system will be applied:

1. **Server-side**: Chord text is parsed in the lyric line render, classified by quality, and wrapped in `<span class="chord-{type}">` tags.
2. **Client-side (HUD)**: CSS applies the color classes.
3. **Client-side (iPhone Lyrics page)**: Same parser, applied to the mirrored lyrics.

## Song Meta Files

Chord color parsing does NOT require any changes to `meta.json` or `.chopro` files. All classification is done at render time by parsing the chord text inside brackets.

## Future

- **Configurable colors**: Store chord colors in `data/config.json` under a `chord_colors` key for user customization.
- **Dim/bright variants**: Support dim7 vs dim distinction (both are currently "complex" = purple).
- **Suspended chords**: Currently classified as major-family (yellow). Could add a distinct color later.
- **Key-aware coloring**: Highlight diatonic chords vs borrowed chords based on song key.
