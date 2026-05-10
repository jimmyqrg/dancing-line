import * as THREE from "three";
import { EffectComposer } from "https://unpkg.com/three@0.168.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://unpkg.com/three@0.168.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://unpkg.com/three@0.168.0/examples/jsm/postprocessing/UnrealBloomPass.js";

class MusicPlayer {
  constructor(url, preloadedElement) {
    this._url = url;
    this._audio = null;
    this._ready = false;
    if (preloadedElement) {
      this._audio = preloadedElement.cloneNode();
      this._audio.preload = "auto";
      this._ready = preloadedElement.readyState >= 3;
      if (!this._ready) {
        this._audio.addEventListener("canplaythrough", () => { this._ready = true; }, { once: true });
      }
    } else if (url) {
      this._audio = new Audio(url);
      this._audio.preload = "auto";
      this._audio.addEventListener("canplaythrough", () => { this._ready = true; }, { once: true });
    }
  }

  play() {
    if (!this._audio) return;
    this._audio.currentTime = 0;
    this._audio.play().catch(() => {});
  }

  pause() {
    if (!this._audio || this._audio.paused) return;
    this._audio.pause();
  }

  resume() {
    if (!this._audio || !this._audio.paused) return;
    this._audio.play().catch(() => {});
  }

  stop() {
    if (!this._audio) return;
    this._audio.pause();
    this._audio.currentTime = 0;
  }

  get currentTime() {
    return this._audio ? this._audio.currentTime : 0;
  }

  destroy() {
    this.stop();
    if (this._audio) {
      this._audio.src = "";
      this._audio = null;
    }
  }
}

const TURN_TOLERANCE = 0.6;
const FALL_GRAVITY = 22;
const TRAIL_HEIGHT = 0.35;
const PLAYER_SIZE = 0.35;
const GEM_RADIUS = 0.55;
const FINISH_RADIUS = 0.9;
const FALL_DURATION = 1.0;
const OFF_PATH_GRACE = 0.3;
const CAM_OFFSET = { x: -10, y: 11, z: -10 };

function widthScale(w) { return w <= 0 ? 0.5 : Math.pow(5, (w - 1) / 8); }

export class DancingLineGame {
  constructor({ canvas, level, onEvent, audioPlay, musicUrl, preloadedAudioEl, autoPlay, enableGlow }) {
    this.canvas = canvas;
    this.level = level;
    this.onEvent = onEvent || (() => {});
    this.audioPlay = audioPlay || (() => {});
    this.music = new MusicPlayer(musicUrl, preloadedAudioEl);
    this.autoPlay = autoPlay || false;
    this.enableGlow = enableGlow && (level.glow === true);

    this.state = "ready";
    this.gemsCollected = 0;
    this._destroyed = false;

    this._initRenderer();
    this._initScene();
    this._buildPath();
    this._buildWorld();
    this._initCamera();
    this._initInput();
    this._initPostProcessing();

    this._lastTs = 0;
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);

    if (this.autoPlay) {
      setTimeout(() => { if (this.state === "ready") this.start(); }, 600);
    }
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !this.enableGlow,
      alpha: true,
    });
    const maxDpr = this.enableGlow ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(maxDpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = !this.enableGlow;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this._onResize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.camera) {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
      }
      if (this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", this._onResize);
  }

  _initScene() {
    const t = this.level.theme;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.Fog(t.sky, t.fogNear, t.fogFar);

    const hemi = new THREE.HemisphereLight(t.sky, t.ground, 0.55);
    this.scene.add(hemi);

    const ambient = new THREE.AmbientLight(new THREE.Color(t.ambient), 0.45);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight(new THREE.Color(t.key), 1.05);
    dir.position.set(20, 30, 12);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 200;
    dir.shadow.camera.left = -60;
    dir.shadow.camera.right = 60;
    dir.shadow.camera.top = 60;
    dir.shadow.camera.bottom = -60;
    dir.shadow.bias = -0.0005;
    this.scene.add(dir);
    this.scene.add(dir.target);
    this.dirLight = dir;

  }

  _buildPath() {
    const lvl = this.level;
    if (!lvl.tile) lvl.tile = 1.0;
    if (!lvl.tempo) lvl.tempo = 6.0;
    if (!lvl.gems) lvl.gems = [];
    if (!lvl.decor) lvl.decor = [];
    if (!lvl.start) lvl.start = { x: 0, z: 0, dir: "x" };
    const tile = lvl.tile;
    const start = { x: lvl.start.x, z: lvl.start.z };

    this.hasSegmentWidths = lvl.segments.some(s => s.width != null);

    const corners = [{ x: start.x, z: start.z }];
    let cur = { ...start };
    for (const seg of lvl.segments) {
      if (seg.axis === "x") cur.x += seg.length;
      else cur.z += seg.length;
      corners.push({ ...cur });
    }

    this.corners = corners;

    let total = 0;
    const cumulative = [0];
    for (let i = 1; i < corners.length; i++) {
      const a = corners[i - 1];
      const b = corners[i];
      const len = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
      total += len * tile;
      cumulative.push(total);
    }
    this.totalDistance = total;
    this.cumulative = cumulative;

    this.finishCorner = corners[corners.length - 1];
    this.finishPoint = new THREE.Vector3(
      this.finishCorner.x * tile,
      0,
      this.finishCorner.z * tile,
    );

    if (this.hasSegmentWidths) {
      // Build axis-aligned bounding rects for each segment for on-path checks
      // Extend each segment backward by halfW at corners to cover the junction area
      this.pathRects = [];
      let sx = start.x * tile, sz = start.z * tile;
      for (let si = 0; si < lvl.segments.length; si++) {
        const seg = lvl.segments[si];
        const w = widthScale(seg.width || 1) * tile;
        const halfW = w / 2;
        const len = seg.length * tile;
        const ext = si === 0 ? 0 : halfW;
        let minX, maxX, minZ, maxZ;
        if (seg.axis === "x") {
          minX = sx - ext; maxX = sx + len;
          minZ = sz - halfW; maxZ = sz + halfW;
          sx += len;
        } else {
          minX = sx - halfW; maxX = sx + halfW;
          minZ = sz - ext; maxZ = sz + len;
          sz += len;
        }
        this.pathRects.push({ minX, maxX, minZ, maxZ });
      }
    } else {
      const pathTiles = new Map();
      for (let i = 1; i < corners.length; i++) {
        const a = corners[i - 1];
        const b = corners[i];
        const signX = Math.sign(b.x - a.x);
        const signZ = Math.sign(b.z - a.z);
        const len = Math.abs(b.x - a.x) + Math.abs(b.z - a.z);
        for (let k = 0; k <= len; k++) {
          const tx = a.x + signX * k;
          const tz = a.z + signZ * k;
          pathTiles.set(`${tx},${tz}`, { x: tx, z: tz });
        }
      }
      this.pathTiles = pathTiles;
    }
  }

  _buildWorld() {
    const t = this.level.theme;
    const tile = this.level.tile;

    const tileTopMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(t.tileTop),
      roughness: 0.85,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    if (this.hasSegmentWidths) {
      // Render wide path slabs per segment (editor-style levels)
      let sx = this.level.start.x * tile;
      let sz = this.level.start.z * tile;
      const pathGroup = new THREE.Group();
      for (let si = 0; si < this.level.segments.length; si++) {
        const seg = this.level.segments[si];
        const w = widthScale(seg.width || 1) * tile;
        const len = seg.length * tile;
        // Extend behind the start to cover corner gaps (except first segment)
        const ext = si === 0 ? 0 : w / 2;
        const totalLen = len + ext;
        const geom = new THREE.BoxGeometry(
          seg.axis === "x" ? totalLen : w,
          0.5,
          seg.axis === "z" ? totalLen : w
        );
        const mesh = new THREE.Mesh(geom, tileTopMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const cx = sx + (seg.axis === "x" ? (len / 2 - ext / 2) : 0);
        const cz = sz + (seg.axis === "z" ? (len / 2 - ext / 2) : 0);
        mesh.position.set(cx, -0.25, cz);
        pathGroup.add(mesh);
        sx += seg.axis === "x" ? len : 0;
        sz += seg.axis === "z" ? len : 0;
      }
      this.scene.add(pathGroup);
      this.tileMesh = pathGroup;
    } else {
      // Legacy tile-based rendering
      const tileGeom = new THREE.BoxGeometry(tile, 0.5, tile);
      const tileMesh = new THREE.InstancedMesh(tileGeom, tileTopMat, this.pathTiles.size);
      tileMesh.castShadow = true;
      tileMesh.receiveShadow = true;
      const m = new THREE.Matrix4();
      let i = 0;
      for (const cell of this.pathTiles.values()) {
        m.makeTranslation(cell.x * tile, -0.25, cell.z * tile);
        tileMesh.setMatrixAt(i++, m);
      }
      tileMesh.instanceMatrix.needsUpdate = true;
      this.scene.add(tileMesh);
      this.tileMesh = tileMesh;
    }

    const finishGeom = new THREE.CylinderGeometry(0.7, 0.7, 0.05, 24);
    const finishMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: new THREE.Color(t.line),
      emissiveIntensity: 0.7,
      roughness: 0.4,
    });
    const finish = new THREE.Mesh(finishGeom, finishMat);
    finish.position.set(this.finishPoint.x, 0.03, this.finishPoint.z);
    this.scene.add(finish);
    this.finishMesh = finish;

    const ringGeom = new THREE.RingGeometry(0.85, 1.05, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(t.line),
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(this.finishPoint.x, 0.06, this.finishPoint.z);
    this.scene.add(ring);
    this.finishRing = ring;

    const darkMarkerLevels = ["The Beginning", "The Piano", "The Winter", "The Desert", "The Earth"];
    const markerColor = darkMarkerLevels.includes(this.level.name) ? 0x000000 : 0xffffff;
    const hs = PLAYER_SIZE * 0.75;
    const hi = hs - 0.03;
    const squareShape = new THREE.Shape();
    squareShape.moveTo(-hs, -hs);
    squareShape.lineTo(hs, -hs);
    squareShape.lineTo(hs, hs);
    squareShape.lineTo(-hs, hs);
    squareShape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-hi, -hi);
    hole.lineTo(hi, -hi);
    hole.lineTo(hi, hi);
    hole.lineTo(-hi, hi);
    hole.closePath();
    squareShape.holes.push(hole);
    const markerGeom = new THREE.ShapeGeometry(squareShape);

    this.markers = [];
    this.bursts = [];
    for (let ci = 1; ci < this.corners.length - 1; ci++) {
      const c = this.corners[ci];
      const mat = new THREE.MeshBasicMaterial({
        color: markerColor,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const marker = new THREE.Mesh(markerGeom, mat);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(c.x * tile, 0.02, c.z * tile);
      marker.userData.triggered = false;
      this.scene.add(marker);
      this.markers.push(marker);
    }

    const gemGeom = new THREE.OctahedronGeometry(0.32, 0);
    const gemMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: new THREE.Color(t.line),
      emissiveIntensity: 0.85,
      roughness: 0.25,
      metalness: 0.5,
    });
    this.gems = (this.level.gems || []).map((g) => {
      const mesh = new THREE.Mesh(gemGeom, gemMat.clone());
      mesh.position.set(g.x * tile, 0.45, g.z * tile);
      mesh.castShadow = true;
      mesh.userData.collected = false;
      mesh.userData.basePos = mesh.position.clone();
      this.scene.add(mesh);
      return mesh;
    });

    if (Array.isArray(this.level.decor)) {
      const decorMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(t.decor || t.tileSide),
        roughness: 0.9,
      });
      for (const d of this.level.decor) {
        const s = d.size || 1;
        const geo = new THREE.BoxGeometry(s, s * 1.4, s);
        const mesh = new THREE.Mesh(geo, decorMat);
        mesh.position.set(d.x * tile, s * 0.7 - 0.5, d.z * tile);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
    }

    const playerGeom = new THREE.BoxGeometry(PLAYER_SIZE, PLAYER_SIZE, PLAYER_SIZE);
    const glowIntensity = this.enableGlow ? 1.2 : 0.55;
    const playerMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(t.line),
      emissive: new THREE.Color(t.line),
      emissiveIntensity: glowIntensity,
      roughness: 0.45,
      metalness: 0.1,
    });
    const player = new THREE.Mesh(playerGeom, playerMat);
    player.castShadow = !this.enableGlow;
    player.position.set(this.level.start.x * tile, PLAYER_SIZE / 2 + 0.01, this.level.start.z * tile);
    this.scene.add(player);
    this.player = player;

    this.trailGroup = new THREE.Group();
    this.scene.add(this.trailGroup);
    this.trailMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(t.line),
      emissive: new THREE.Color(t.line),
      emissiveIntensity: glowIntensity,
      roughness: 0.45,
      metalness: 0.1,
    });

    this.position = new THREE.Vector3(
      this.level.start.x * tile,
      PLAYER_SIZE / 2 + 0.01,
      this.level.start.z * tile,
    );
    this.lastCornerPos = this.position.clone();
    this.direction = this.level.start.dir === "x" ? new THREE.Vector3(1, 0, 0)
                                                  : new THREE.Vector3(0, 0, 1);
    this.cornerIndex = 0;
    this.distanceTravelled = 0;

    this._segmentLastWorld = this.position.clone();
    this._lastOnPathPos = this.position.clone();
    this._offPathTimer = 0;
  }

  _initCamera() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 300);

    this._camPos = new THREE.Vector3(
      this.position.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      this.position.z + CAM_OFFSET.z
    );
    this._camLook = new THREE.Vector3(this.position.x, 0, this.position.z);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
  }


  _initPostProcessing() {
    if (!this.enableGlow) { this.composer = null; return; }
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloomSize = new THREE.Vector2(Math.floor(w / 2), Math.floor(h / 2));
    const bloom = new UnrealBloomPass(bloomSize, 0.6, 0.4, 0.25);
    bloom.renderToScreen = true;
    this.composer.addPass(bloom);
    this._bloomPass = bloom;
  }

  _initInput() {
    this._onPointerDown = (e) => {
      if (e.target && e.target.closest("button")) return;
      this.handleTap();
    };
    this._onKeyDown = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        this.handleTap();
      }
    };
    this.canvas.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("keydown", this._onKeyDown);
  }

  start() {
    this.state = "playing";
    this.startedAt = performance.now();
    const tempo = this.level.tempo || 6;
    const firstLen = this.level.segments[0] ? this.level.segments[0].length * (this.level.tile || 1) : 0;
    const baseDelay = 0.476 / tempo;
    const delay = firstLen / tempo + (this.level.audioDelay || 0) + baseDelay;
    setTimeout(() => this.music.play(), delay * 1000);
    this.onEvent({ type: "start" });
  }

  pause() {
    if (this.state === "playing") {
      this.state = "paused";
      this.music.pause();
      this.onEvent({ type: "pause" });
    }
  }

  resume() {
    if (this.state === "paused") {
      this.state = "playing";
      this.music.resume();
      this.onEvent({ type: "resume" });
    }
  }

  togglePause() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  }

  _autoTurn() {
    if (this.cornerIndex >= this.corners.length - 1) return;
    const next = this.corners[this.cornerIndex + 1];
    const tile = this.level.tile || 1;
    const tx = next.x * tile;
    const tz = next.z * tile;
    const dx = tx - this.position.x;
    const dz = tz - this.position.z;
    const dist = Math.abs(this.direction.x !== 0 ? dx : dz);
    if (dist <= TURN_TOLERANCE * 0.5) {
      this.position.set(tx, this.position.y, tz);
      if (this.direction.x !== 0) this.direction.set(0, 0, 1);
      else this.direction.set(1, 0, 0);
      this._dropTrailUpTo(this.position.clone());
      this.lastCornerPos = this.position.clone();
      this.cornerIndex += 1;
      this._triggerOverlappingMarkers();
      this.onEvent({ type: "turn", position: this.position.clone() });
    }
  }

  handleTap() {
    if (this.state === "ready") {
      this.start();
      return;
    }
    if (this.autoPlay && this.state === "playing") return;
    if (this.state !== "playing") return;
    if (!this._isOnPath(this.position)) return;
    if (this.direction.x !== 0) {
      this.direction.set(0, 0, 1);
    } else {
      this.direction.set(1, 0, 0);
    }

    this._dropTrailUpTo(this.position.clone());
    this.lastCornerPos = this.position.clone();
    this._evaluateTurnCorrectness();
    this._triggerOverlappingMarkers();

    this.onEvent({ type: "turn", position: this.position.clone() });
  }

  _triggerOverlappingMarkers() {
    const radius = 0.6;
    for (const m of this.markers) {
      if (m.userData.triggered) continue;
      const dx = Math.abs(this.position.x - m.position.x);
      const dz = Math.abs(this.position.z - m.position.z);
      if (dx < radius && dz < radius) {
        m.userData.triggered = true;
        m.visible = false;
        this._spawnBurst(m.position);
      }
    }
  }

  _evaluateTurnCorrectness() {
    if (this.cornerIndex >= this.corners.length - 1) return;
    const target = this.corners[this.cornerIndex + 1];
    const expected = new THREE.Vector3(
      target.x * this.level.tile,
      this.position.y,
      target.z * this.level.tile,
    );
    const dx = Math.abs(this.lastCornerPos.x - expected.x);
    const dz = Math.abs(this.lastCornerPos.z - expected.z);
    if (dx <= TURN_TOLERANCE && dz <= TURN_TOLERANCE) {
      this.cornerIndex += 1;
    }
  }

  _spawnBurst(position) {
    const geom = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffdd00,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    const burst = new THREE.Mesh(geom, mat);
    burst.rotation.x = -Math.PI / 2;
    burst.position.set(position.x, 0.03, position.z);
    burst.userData.elapsed = 0;
    this.scene.add(burst);
    this.bursts.push(burst);
  }


  _dropTrailUpTo(pos) {
    const start = this._segmentLastWorld;
    const dx = pos.x - start.x;
    const dz = pos.z - start.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const w = this.level.trailWidth || 0.32;
    const ext = w / 2;
    const totalLen = len + ext;
    const isX = Math.abs(dx) > Math.abs(dz);
    const dir = isX ? Math.sign(dx) : Math.sign(dz);
    const geom = new THREE.BoxGeometry(
      isX ? totalLen : w,
      TRAIL_HEIGHT,
      isX ? w : totalLen,
    );
    const seg = new THREE.Mesh(geom, this.trailMaterial);
    seg.castShadow = !this.enableGlow;
    seg.receiveShadow = !this.enableGlow;
    seg.position.set(
      isX ? (start.x + pos.x) / 2 - (dir * ext) / 2 : start.x,
      TRAIL_HEIGHT / 2 + 0.01,
      isX ? start.z : (start.z + pos.z) / 2 - (dir * ext) / 2,
    );
    this.trailGroup.add(seg);
    this._segmentLastWorld = pos.clone();
  }

  _isOnPath(pos) {
    if (this.hasSegmentWidths) {
      for (const r of this.pathRects) {
        if (pos.x >= r.minX && pos.x <= r.maxX &&
            pos.z >= r.minZ && pos.z <= r.maxZ) return true;
      }
      return false;
    }
    const tile = this.level.tile;
    const tx = Math.round(pos.x / tile);
    const tz = Math.round(pos.z / tile);
    return this.pathTiles.has(`${tx},${tz}`);
  }

  _checkGems() {
    for (const gem of this.gems) {
      if (gem.userData.collected) continue;
      const dx = gem.position.x - this.position.x;
      const dz = gem.position.z - this.position.z;
      if (Math.hypot(dx, dz) < GEM_RADIUS) {
        gem.userData.collected = true;
        gem.visible = false;
        this.gemsCollected += 1;
        this.onEvent({ type: "gem", count: this.gemsCollected });
      }
    }
  }

  _checkFinish() {
    const dx = this.finishPoint.x - this.position.x;
    const dz = this.finishPoint.z - this.position.z;
    if (Math.hypot(dx, dz) < FINISH_RADIUS) this._win();
  }

  _die() {
    if (this.state === "dead" || this.state === "falling" || this.state === "won") return;
    // Drop the last trail segment up to where the player left the path
    this._dropTrailUpTo(this._lastOnPathPos || this.position.clone());
    this.state = "falling";
    this.fallTimer = 0;
    this.fallVelocity = 0;
    this.music.stop();
  }

  _win() {
    if (this.state === "won" || this.state === "dead") return;
    this.state = "won";
    this.music.stop();
    this.audioPlay("victory");
    this.onEvent({ type: "victory", gems: this.gemsCollected });
  }

  reset() {
    while (this.trailGroup.children.length) {
      const c = this.trailGroup.children[0];
      this.trailGroup.remove(c);
      c.geometry?.dispose();
    }
    for (const gem of this.gems) {
      gem.userData.collected = false;
      gem.visible = true;
      gem.position.copy(gem.userData.basePos);
    }
    for (const m of this.markers) {
      m.userData.triggered = false;
      m.visible = true;
      m.scale.set(1, 1, 1);
      m.material.opacity = 0.4;
    }
    for (const b of this.bursts) {
      this.scene.remove(b);
      b.geometry.dispose();
      b.material.dispose();
    }
    this.bursts = [];
    this.gemsCollected = 0;
    this.state = "ready";
    this.fallTimer = 0;
    this.fallVelocity = 0;
    this._offPathTimer = 0;
    this._deathSignaled = false;
    this.cornerIndex = 0;
    this.distanceTravelled = 0;
    this.position.set(
      this.level.start.x * this.level.tile,
      PLAYER_SIZE / 2 + 0.01,
      this.level.start.z * this.level.tile,
    );
    this.lastCornerPos = this.position.clone();
    this._segmentLastWorld = this.position.clone();
    this._lastOnPathPos = this.position.clone();
    this.direction = this.level.start.dir === "x" ? new THREE.Vector3(1, 0, 0)
                                                  : new THREE.Vector3(0, 0, 1);
    this.player.position.copy(this.position);
    this.player.rotation.set(0, 0, 0);
    this.player.material.opacity = 1;
    this.player.material.transparent = false;
    this._camPos.set(this.position.x + CAM_OFFSET.x, CAM_OFFSET.y, this.position.z + CAM_OFFSET.z);
    this._camLook.set(this.position.x, 0, this.position.z);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
    this.music.stop();
    this.onEvent({ type: "reset" });
  }

  destroy() {
    this._destroyed = true;
    this.music.destroy();
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKeyDown);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    this.renderer.dispose();
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }

  _frame(ts) {
    if (this._destroyed) return;
    const dt = this._lastTs ? (ts - this._lastTs) / 1000 : 0;
    this._lastTs = ts;
    this._update(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._frame);
  }

  _update(dt) {
    const t = ts(this);

    if (this.state === "playing" && dt > 0) {
      if (this.autoPlay) this._autoTurn();

      const speed = this.level.tempo;
      this.position.x += this.direction.x * speed * dt;
      this.position.z += this.direction.z * speed * dt;
      this.distanceTravelled += speed * dt;

      const onPath = this._isOnPath(this.position);
      if (onPath) {
        this._lastOnPathPos = this.position.clone();
        this._offPathTimer = 0;
        this._dropTrailUpTo(this.position.clone());
      } else {
        this._offPathTimer += dt;
        if (this._offPathTimer >= OFF_PATH_GRACE) this._die();
      }

      this.player.position.copy(this.position);

      this._checkGems();
      this._checkFinish();

      const pct = Math.min(1, this.distanceTravelled / this.totalDistance);
      this.onEvent({ type: "progress", value: pct });

    } else if (this.state === "falling" && dt > 0) {
      this.fallTimer += dt;
      // Keep moving forward while falling
      const speed = this.level.tempo;
      this.position.x += this.direction.x * speed * dt;
      this.position.z += this.direction.z * speed * dt;
      // Gravity drop
      this.fallVelocity += FALL_GRAVITY * dt;
      this.position.y -= this.fallVelocity * dt;
      this.player.position.copy(this.position);
      // Tumble rotation
      this.player.rotation.x += dt * 3;
      this.player.rotation.z += dt * 4;

      if (this.fallTimer >= FALL_DURATION) {
        this.state = "dead";
        this.audioPlay("death");
        this.onEvent({ type: "death", gems: this.gemsCollected });
      }

    } else if (this.state === "dead") {
      // Frozen — do nothing, player stays where it fell

    } else if (this.state === "won") {
      this.player.rotation.y += dt * 1.2;
    }

    if (this.finishRing) {
      this.finishRing.rotation.z += dt * 0.6;
      const s = 1 + Math.sin(t * 2.4) * 0.06;
      this.finishRing.scale.set(s, s, 1);
    }
    for (const gem of this.gems) {
      if (!gem.visible) continue;
      gem.rotation.y += dt * 1.6;
      gem.position.y = gem.userData.basePos.y + Math.sin(t * 2 + gem.position.x) * 0.08;
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.userData.elapsed += dt;
      const p = b.userData.elapsed / 0.5;
      if (p >= 1) {
        this.scene.remove(b);
        b.geometry.dispose();
        b.material.dispose();
        this.bursts.splice(i, 1);
      } else {
        const scale = 1 + p * 3.3;
        b.scale.set(scale, scale, 1);
        b.material.opacity = 0.9 * (1 - p);
      }
    }
    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const targetPos = new THREE.Vector3(
      this.position.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      this.position.z + CAM_OFFSET.z
    );
    const targetLook = new THREE.Vector3(this.position.x, 0, this.position.z);

    const s = 1 - Math.pow(0.01, dt);
    this._camPos.lerp(targetPos, s);
    this._camLook.lerp(targetLook, s);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);

    if (this.dirLight) {
      this.dirLight.position.set(this.position.x + 20, 30, this.position.z + 12);
      this.dirLight.target.position.copy(this.position);
      this.dirLight.target.updateMatrixWorld();
    }
  }
}

function ts(self) {
  return (performance.now() - (self.startedAt || performance.now())) / 1000;
}
