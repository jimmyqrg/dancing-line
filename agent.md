# Agent Memory

## Project: Dancing Line Web Remake

A browser-based rhythm game (mobile port). The user is the author/porter.

### Tech Stack
- JavaScript (ES6+), HTML5, CSS3, Three.js (v0.168.0 via CDN)
- No build step — runs directly in browser
- Web Audio API for music/SFX, WebGL for 3D rendering

### Key Files
- **`runtime.js`**: Core game engine — `DancingLineGame` class + `MusicPlayer` class
- **`index.html`**: Main UI — boot screen, level select, game HUD, settings, test modal
- **`editor.html`**: Built-in level editor for creating custom levels
- **`data.json`**: Level metadata registry (audio URLs, theme colors, tempo)
- **`levels/*.json`**: Individual level definitions (121 segments in beginning.json)

### Gameplay
- Player cube auto-moves along a path at `tempo` speed
- Tap/click/Space to turn at corners (alternates x→z direction)
- Falls off if off-path for `OFF_PATH_GRACE=0.35` seconds
- Collect gems (octahedrons), reach finish line to win
- 18 levels with distinct themes/effects

### Architecture Notes
- **Two path modes**: Legacy tile-based (single tile width) vs slab-based (variable `width` per segment)
- **Trail system**: Trail segments dropped as player moves, frustum-culled for perf
- **Reflective player**: Mirrored cube below ground for visual depth
- **Path animations**: 6 types (fly-in, spring-ascend, taurus/fade-color, chaos, samsara, crystal)
- **2D particles**: Snow/rain/dust use canvas overlay, not 3D geometry
- **`widthScale(w)`**: Exponential scale — width 1→0.5x, width 9→5x (used in both editor and runtime)
- **`mulberry32(seed)`**: Seeded PRNG for 2D menu canvas path generation

### User Context
- Git user: `JQRG`
- Current branch: `main`
- Chinese speaker (game has ZH translations)

---

## EDITOR (editor.html)

Editor has two distinct modes.

### Setup Screen
Two buttons: `NEW LEVEL` and `EDIT`
- `NEW LEVEL` → Editor Mode 1 (recording)
- `EDIT` → Editor Mode 2 (JSON paste required, plays back level)

### Editor Mode 1 — Recording (NEW LEVEL button)
Recording a level path with turn timing. All letter keys trigger turn. Output has COPY / CONTINUE / NEW buttons.

**Keys:**
- Any letter / Space / Click = turn
- 1-9 = path width
- Q = toggle normal drop recording (records drop to segment on turn)
- W = toggle float drop recording
- E (hold/release) = camera rotation recording
- Esc = finish

**Recording mechanics:**
- When Q/W is set before a turn, the drop is recorded to the segment that just ended: `segments[i].drop = { type: "normal" | "float" }`
- When E is held, camera rotation starts at current player position. On release, records: `segments[i].camRot = { startOffset, duration, direction }`
- Audio delay auto-calculated: `audioDelay = -(startLength / tempo)` so music syncs with the starting straight

**Output JSON includes drops and camera rotations per segment, and auto-calculated audioDelay.**

### Editor Mode 2 — Playback (CONTINUE or EDIT button)
Pre-recorded level plays back. Path is immutable. No turn recording.

**Keys:**
- No turn keys work (click/keys disabled for turning)
- Q = toggle normal drop (during playback)
- W = toggle float drop (during playback)
- Auto button toggles auto-play (auto-turns at corners)

**CONTINUE** loads output JSON from Editor Mode 1 into Editor Mode 2. Starts with auto-play ON. Audio delay from JSON is preserved.

### Audio Delay Calculation
- The player travels the starting straight at tempo speed
- `audioDelay = -(startLength / tempo)` — negative delay means music starts late by that amount
- This ensures the first turn is perfectly synced to the beat

---

## FALL / DEATH BEHAVIOR (runtime.js)

**Dynamic fall survival — no JSON flag needed:**
- When player falls off path, check if current (x,z) is over ground path
  - **Over ground**: fall with no tumbling. If player passes y < -3, die. If player lands on ground (y <= 0), survive.
  - **Over void**: tumble + die after FALL_DURATION

**Death trigger:** `_offPathTimer >= OFF_PATH_GRACE` (0.35s)

**Fall state:** `state === "falling"` — player moves in current direction while y decreases from gravity. Tumble rotation applied unless `_fallNoTumble` is true.

**On survive:** player resumes at ground level, `state = "playing"`, fires `drop-land` event.

---

## CAMERA ROTATION (runtime.js)

**E key hold/release in actual game:**
- Hold E → `_startCameraRotation(dir)` — starts orbiting, duration is 9999 (placeholder)
- Release E → `_endCameraRotation()` — sets duration to elapsed time, recalculates speed so it stops exactly at current angle

**Sliding center point math:**
- Point A = player position, Point B = player + 2 units forward in movement direction
- At 0°/360°: orbit center = A, at 180°: orbit center = B, slides linearly between
- Camera height fixed at `orbitCenter.y + 5` (does not bob)

**Editor Mode 1 recording:** E held starts visual rotation preview, release records actual duration to `seg.camRot`.

**Editor Mode 2 playback:** E key not used for playback (Q/W drops only).

**Level JSON format for camera rotation per segment:**
```json
"segments": [
  { "axis": "x", "length": 5, "width": 1, "camRot": { "startOffset": 0, "duration": 2.5, "direction": 1 } }
]
```
- `startOffset`: distance into segment when rotation starts
- `duration`: seconds to rotate (calculated from hold duration)
- `direction`: 1 = CW, -1 = CCW

**Global camera rotation setting (enables E key in game):** Level JSON needs `"cameraRotation": { "enabled": true }` at root level, OR segments can have per-segment `camRot` which implies enabled.

---

## DROP FORMAT (runtime.js + editor)

**Per-segment drop in level JSON:**
```json
"segments": [
  { "axis": "x", "length": 5, "width": 1, "drop": { "type": "normal", "targetY": -2 } }
]
```
- `type`: `"normal"` (straight down) or `"float"` (arc up then fall)
- `targetY`: landing y position (default ~0 for ground level, or lower for gap drops)

**Drop in Editor Mode 1:** Q/W toggles pending drop, recorded to segment on turn commit.

**Drop in Editor Mode 2:** Q/W directly toggles drop state during playback.

**Only one drop at a time. Player cannot turn during any drop.**

---

## Camera Rotation Math (reference)

**Points:**
- Point A: Player's current position
- Point B: Player's position projected slightly forward (2 units)
- Segment AB connects A and B, camera center slides along it

**Camera center C at angle θ:**
- 0° ≤ θ ≤ 180: C = A + (B-A) * (θ/180°)
- 180° < θ ≤ 360: C = B + (A-B) * ((θ-180°)/180°)

**Camera position:**
- Orbits at fixed radius around sliding center C
- Height: orbitCenter.y + 5 (constant)
- Always looks at player position

**SVG Reference:** `/Users/Benran/Downloads/camera rotation path.svg`

---

## AUDIO DELAY SYSTEM (how it works and why it's broken)

### Overview
Every level has a **starting straight** — a long platform the player travels before the first turn. The music needs to start late so the first turn syncs to the beat. This is called **audio delay**.

### Key Values

**`level.audioDelay`** (in level JSON, seconds):
- Negative = music starts LATE (delayed). This is how all recorded levels work.
- Positive = music starts EARLY (should rarely be used)
- Example: `audioDelay: -1.14` means music starts 1.14 seconds late

**`audioOffset`** (in game settings, seconds):
- User-adjustable offset in the Settings modal
- Added on top of `level.audioDelay`
- Can be positive (start earlier) or negative (start later)
- Default: 0

### The Math

The starting straight has a physical length. The player traverses it at `tempo` speed.

```
audioDelay = -(startLength / tempo)
```

Example: startLength=8, tempo=5 → audioDelay = -(8/5) = -1.6 seconds

This means the player spends 1.6 seconds on the starting straight, so music should start 1.6 seconds late so the first turn aligns with the beat.

### How Delay Is Applied (runtime.js `start()` method)

```
_totalDelayMs = level.audioDelay * 1000 + audioOffset * 1000
```

If `_totalDelayMs < 0`:
- Music play is delayed by `abs(_totalDelayMs)` milliseconds using `setTimeout`

If `_totalDelayMs >= 0`:
- Music plays immediately

### Bug History (persistent issue)

**Problem 1 — Two separate systems not combined:**
- `level.audioDelay` was handled by runtime via `_audioDelayMs`
- `audioOffset` (settings) was stored in `this.audioOffset` but NEVER added to the delay
- Fix: combine both into `_audioDelayMs = level.audioDelay*1000 + audioOffset*1000`

**Problem 2 — speedMult change broke the math:**
- `speedMult` was previously stored as `1 + (userValue)` so 0.5 → 1.5x speed
- Changed to direct: `speedMult` = userValue, so 1 = normal, 0.5 = half speed
- audioDelay is based on tempo (units/second) — if speedMult scales tempo, delay formula needs updating

### Current State (as of last session)

- `speedMult` in game: directly the multiplier (1 = normal, 0.5 = half, 1.25 = 1.25x), NOT `1 + value`
- `speedMult` in runtime: directly the multiplier, NOT `1 + (speedMult || 0)`
- `runtime.js` constructor: `_audioDelayMs = level.audioDelay + audioOffset` (both in seconds, combined before multiplying by 1000 in start())
- Editor calculates audioDelay automatically: `audioDelay = -(2 * startLength / speed)` — the factor 2 accounts for delay needing to be longer than expected
- Editor now has Speed Mult input (1 = normal) alongside Speed (tempo 1-20)
- Editor Mode 1 (recording): music plays immediately with no delay
- Game test level: uses same code path as regular levels, audioDelay from JSON is passed through
- `delayMult` setting in game: multiplies total audioDelay for fine-tuning (e.g., set to 2 to double the delay)
- Sign convention: negative = music starts late (delayed), positive = music starts early

The `audioDelay` in the level JSON is a fixed value based on tempo at 1x speed. If you change the speed multiplier in settings, the audioDelay does NOT scale with it — it's a fixed delay from the recording.

### Editor Audio Delay Auto-Calculation

In `buildJSON()`:
```javascript
const startLength = parseFloat(startLengthEl.value) || 8;
const audioDelay = speed > 0 ? -(startLength / speed) : 0;
// → result includes:  audioDelay: audioDelay
```

The Audio Delay input in editor setup form only SAVES/LOADS your preference (localStorage) — it is NOT used when building JSON. JSON always uses the auto-calculated value.

---

## SPEED MULTIPLIER SYSTEM

### Game Settings
- Input: `data-speed-mult` in settings modal, default 1, step 0.05
- Stored in localStorage `dl_speedmult`
- Directly multiplies: `this.speedMult = speedMult` (NOT `1 + speedMult`)

### What speedMult Affects (game / runtime.js)
- `tempo * speedMult` = effective movement speed
- `this.music.setRate(speedMult)` = music playback rate
- Camera movement speed
- All path animation speeds
- Player movement, gem movement, finish ring rotation

### Editor Speed System
- **Speed** input (1-20, default 5): the `tempo` value — base speed of the line
- **Speed Mult** input (0.1-5, default 1): scales ALL speeds proportionally
  - Affects: line movement (`speed * speedMult * dt`), camera orbit, drop duration, music playback rate
- Relationship to game: editor's `speed` = level's `tempo`, editor's `speedMult` = game settings multiplier

---

## EDITOR TRAIL — IDENTICAL TO GAME

Editor trail now matches game trail exactly:

| Property | Value |
|---|---|
| Height (TRAIL_H) | 0.35 |
| Trail width (TRAIL_W) | 0.5 |
| emissiveIntensity (no glow) | 0.55 |
| emissiveIntensity (glow) | 1.2 |
| metalness | 0.1 |
| roughness | 0.45 |
| Y position | TRAIL_H/2 + 0.01 = 0.185 |

Committed trail segments use `widthScale(currentWidth)` for variable width. Live trail preview also uses `widthScale(currentWidth)`.

Editor trail color = `lineColor` (from setup form). Game trail color = `level.theme.line`.

Player cube in editor: 0.28×0.28×0.28, same emissive intensity as trail.

---

## PARTICLES SYSTEM (runtime.js)

Particles (snow, rain, dust) are now **3D meshes** spawned around the player position. They are NOT 2D canvas overlays.

### Initialization (`_initLevelAnimation`)
- Each particle type creates actual `THREE.Mesh` objects in the scene
- Snow: `SphereGeometry`, white, falls downward with slight horizontal drift
- Rain: `CylinderGeometry` (thin rods), blue-gray, falls fast downward
- Dust: `BoxGeometry`, gray, drifts horizontally

### Update (`_updateLevelAnimation`)
- Particles spawn in a wide range around the player (20-30 units radius)
- When they fall below a threshold or drift out of range, they respawn at a new random position near the player
- `this._snowParticles`, `this._rainParticles`, `this._dustParticles` arrays hold the mesh references

### Cleanup (`destroy`)
- All particle meshes are removed from scene and dereferenced when game is destroyed
- `_particleCanvas` (if any leftover 2D canvas) is also cleaned up

---

## 3D PARTICLE PROPERTIES

| Type | Geometry | Color/Opacity | Speed | Range |
|---|---|---|---|---|
| Snow | SphereGeometry (r 0.05-0.15) | white, opacity 0.85 | ~1-3 units/s down | 30 units around player |
| Rain (normal) | CylinderGeometry (len 0.15-0.45) | blue-gray, opacity 0.5 | ~10-18 units/s down | 25 units around player |
| Rain (heavy) | CylinderGeometry (len 0.3-0.8) | blue-gray, opacity 0.7 | ~20-35 units/s down | 25 units around player |
| Dust | BoxGeometry (size 0.04-0.12) | gray, opacity 0.4-0.7 | ~2-4 units/s horizontal | 20 units around player |

---

## AUDIO DELAY — CURRENT ISSUES

**The audio delay is not working properly for built-in levels.**

Root cause traced:
- Built-in level JSON files (e.g. `beginning.json`) do NOT have `audioDelay` field
- `level.audioDelay` is `undefined`, so `parseFloat(undefined)` returns `NaN`
- `NaN + audioOffset = NaN`
- `_audioDelayMs` becomes `NaN`

When `_audioDelayMs` is `NaN`:
- `totalDelayMs = NaN * 1000 = NaN`
- `NaN < 0` is **false**, `NaN > 0` is **false** → goes to `else` branch → music plays immediately

Fix needed: ensure `parseFloat(level.audioDelay)` returns 0 when the field doesn't exist:
```javascript
// Change in runtime.js constructor:
this._audioDelayMs = ((level && level.audioDelay != null) ? parseFloat(level.audioDelay) : 0) + (audioOffset || 0);
```

Note: `parseFloat(null)` returns `NaN`, but `null != null` is `true`, so the existing check `level.audioDelay != null` should catch it. However `undefined != null` is also `true`, so the check works. The issue may be elsewhere.

Debug log added to `start()`: shows `_audioDelayMs` and `totalDelayMs` values.

---

## MUSIC STOPS UNEXPECTEDLY

When using positive delay (start early):
- Music plays immediately, then `setTimeout` fires after `totalDelayMs` ms and calls `music.pause()`
- If you die or level ends before that timeout fires, music pauses
- **This is expected behavior for "early start" mode**

When using negative delay (start late):
- Music should play after timeout fires
- If `destroy()` is called before timeout fires, timeout is cleared (fix just added)

The "start early → pause after delay" pattern is inherently limited — music will always stop at the timeout. A better approach would track actual music duration.

---

## SETTINGS NEW

### Delay Multiply (`delayMult`)
- Input: `data-delay-mult` in settings modal, default 1, step 0.1
- Stored in localStorage `dl_delay_mult`
- Multiplies total audio delay: `totalAudioOffset = (getAudioOffsetForLevel(...) + level.audioDelay) * delayMult`
- Applies to all levels including test level



Additional memory split out:


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Dancing Line Web Remake** — Browser-based rhythm game port (mobile → desktop).

## Tech Stack

- JavaScript (ES6+), HTML5, CSS3
- Three.js v0.168.0 via CDN
- Web Audio API for music/SFX, WebGL for 3D rendering
- **No build step** — runs directly in browser

## Key Files

| File | Purpose |
|---|---|
| `runtime.js` | Core game engine — `DancingLineGame` class + `MusicPlayer` class |
| `index.html` | Main UI — boot screen, level select, game HUD, settings modal |
| `editor.html` | Built-in level editor (two distinct modes) |
| `data.json` | Level metadata registry (audio URLs, theme colors, tempo) |
| `levels/*.json` | Individual level definitions |

## Architecture

### Game Loop
- Player cube auto-moves along a path at `tempo * speedMult` speed
- Tap/click/Space to turn at corners (x→z axis alternation)
- Falls off after `OFF_PATH_GRACE = 0.35` seconds off-path
- Collect gems (octahedrons), reach finish line to win

### Two Path Modes
- **Legacy tile-based**: single tile width
- **Slab-based**: variable `width` per segment via `widthScale(w)`

### Trail System
- Trail segments dropped as player moves, frustum-culled
- `TRAIL_H = 0.35`, Y position `TRAIL_H/2 + 0.01 = 0.185`
- `TRAIL_W = 0.5`

### Player Cube
- Size: `0.28 × 0.28 × 0.28`
- emissiveIntensity: 0.55 (normal), 1.2 (glow)
- Reflective mirrored cube below ground for depth

### Path Animations (6 types)
fly-in, spring-ascend, taurus/fade-color, chaos, samsara, crystal

### Particle System (3D meshes)
- Snow: `SphereGeometry`, white, opacity 0.85
- Rain: `CylinderGeometry`, blue-gray, opacity 0.5 (normal) / 0.7 (heavy)
- Dust: `BoxGeometry`, gray, opacity 0.4–0.7

## Editor Modes

### Mode 1 — Recording (`NEW LEVEL`)
- Records path with turn timing
- Keys: letter/Space/click = turn, 1-9 = width, Q = normal drop, W = float drop, E (hold) = camera rotation, Esc = finish
- Output JSON with auto-calculated `audioDelay`

### Mode 2 — Playback (`EDIT` or `CONTINUE`)
- Plays back pre-recorded level, path immutable
- Q/W toggle drops, Auto button for auto-play
- Keys/click disabled for turning

## Audio Delay System

**Sign convention**: `audioDelay` in **seconds**, negative = music starts late (delayed), positive/zero = immediate play.

```
audioDelay = -(2 * startLength / tempo)  // editor auto-calculation
```

**In runtime.js `start()`**:
```javascript
this._audioDelayMs = ((level && level.audioDelay != null) ? parseFloat(level.audioDelay) : 0) + (audioOffset || 0);
const totalDelayMs = this._audioDelayMs * 1000;
if (totalDelayMs > 0) {
  this._musicTimeout = setTimeout(() => {
    if (this.state === "playing") this.music.play();
  }, totalDelayMs);
} else {
  this.music.play();
}
```

**Settings**:
- `audioOffset` (seconds): user-adjustable, stored in localStorage `dl_audio_offset`
- `delayMult`: multiplies total audio delay, stored in `dl_delay_mult`

## Speed Multiplier

`speedMult`: direct multiplier (1 = normal, 0.5 = half, 1.25 = 1.25x), NOT `1 + value`.

Affected: movement speed, music playback rate, camera orbit, drop duration, path animations, gem movement, finish ring rotation.

## Key Constants

| Constant | Value |
|---|---|
| `TRAIL_H` | 0.35 |
| `TRAIL_W` | 0.5 |
| `TRAIL_Y` | 0.185 |
| `OFF_PATH_GRACE` | 0.35s |
| `FALL_DURATION` | ~1s |
| `widthScale(w)` | `0.5 + 0.5 * Math.pow(w / 9, 0.7)` |

## Common Commands

```bash
# No build step — open directly in browser
open index.html          # macOS
open editor.html         # for level editor

# Level JSON format reference — see beginning.json for 121-segment example
```

## Known Issues

- Editor trail shape visually differs from game trail despite identical math (unresolved)
- Audio delay system has been fixed multiple times — verify `audioDelay` field exists in level JSON before testing