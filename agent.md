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