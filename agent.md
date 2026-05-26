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

## NEW FEATURES (SPEC)

### 1. Fall Without Death (runtime.js future)
- When player falls off edge, it falls in current direction WITHOUT rolling/dying
- Camera keeps following the falling player
- Player only dies when fall animation completes or off-path for too long
- This enables "drop" mechanics where player falls to another platform below

### 2. Editor.html Modes: Setup Screen

**Setup screen** (replaces immediate editor entry) has two buttons:
- `NEW LEVEL` — opens level editor in NEW LEVEL mode
- `EDIT` — opens level editor in EDIT mode (requires JSON paste unless from CONTINUE)

### 3. NEW LEVEL Mode (editor.html)
- All letter keys trigger player turn
- `COPY` + `NEW` buttons on output screen
- **`CONTINUE` button** between COPY and NEW: opens same level in EDIT mode

### 4. EDIT Mode (editor.html)
- Only `J` and `K` trigger player turn
- Line curves/paths are already decided and cannot be changed
- **Auto-play mode**: line automatically plays the level

#### Edit Mode Keys
- `J` / `K` / `Space` / Click: Turn at corners
- `Q`: Start/stop **normal drop**
  - When started: player starts a normal drop (falls from edge, lands on platform below), temporarily stops generating paths/trail
  - When stopped: continues generating paths/trail
  - Cannot turn during normal drop
- `W`: Start/stop **float drop**
  - When started: player leaps up then falls to ending platform (same height level)
  - When stopped: if float drop already started, stop it
  - Cannot turn during float drop
- `E` (hold): Camera rotate — only visually displays in actual playing mode, not in editor
  - Camera rotates around player 360 degrees
  - Rotation speed calculated so it perfectly finishes at stop point
  - See camera math below

#### Drop Rules
- Only one drop at a time (cannot start drop if one is already active)
- Player cannot turn during any drop

### 5. Camera Rotation Math

**Points:**
- Point A: Player's current position
- Point B: Player's position projected slightly forward along camera direction
- Point P (black circle in SVG): Camera rotation start/end position = midpoint of segment AB
- Point Q (cyan circle in SVG): Camera rotation 180-degree position
- Segment AB: Magenta line connecting A and B
- Green oval in SVG: Camera's orbital path

**Camera center definition (sliding):**
- At 0° (point P): camera center = Point A
- At 180° (point Q): camera center = Point B
- From 0°→180°: center slides from A to B on segment AB
- From 180°→360°: center slides from B back to A on segment AB
- The more camera is near P (0°/360°), the more it orbits around A
- The more camera is near Q (180°), the more it orbits around B
- This ensures the path ahead of the player is always visible

**Implementation:**
- Camera orbits in a circle around the midpoint of segment AB
- Rotation angle θ maps to center point C on segment AB:
  - C = A + (B-A) * (θ/180°) for 0 ≤ θ ≤ 180
  - C = B + (A-B) * ((θ-180)/180) for 180 < θ ≤ 360
- At θ=0°/360°: C=A (orbit around A)
- At θ=180°: C=B (orbit around B)
- Camera orbit radius = distance from P to camera at 0°

**SVG Reference:** `/Users/Benran/Downloads/camera rotation path.svg`
- Gray vector: the path
- Yellow vector: the line (player)
- Black circle (P): camera rotation start/end position
- Cyan circle (Q): camera rotation 180-degree position
- Green oval: camera orbit path
- Red dot (A): player current position
- Blue dot (B): player's forward position
- Magenta line: segment AB