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

  setRate(rate) {
    if (this._audio) {
      this._audio.playbackRate = rate;
      this._audio.preservesPitch = false;
    }
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
const OFF_PATH_GRACE = 0.35;
const CAM_OFFSET = { x: -10, y: 11, z: -10 };

function widthScale(w) { return w <= 0 ? 0.5 : Math.pow(5, (w - 1) / 8); }

export class DancingLineGame {
  constructor({ canvas, level, onEvent, audioPlay, musicUrl, preloadedAudioEl, autoPlay, enableGlow, enableClickMarks, invincibility, speedMult }) {
    this.canvas = canvas;
    this.level = level;
    this.onEvent = onEvent || (() => {});
    this.audioPlay = audioPlay || (() => {});
    this.music = new MusicPlayer(musicUrl, preloadedAudioEl);
    this.autoPlay = autoPlay || false;
    this.enableGlow = !!enableGlow && (level.glow === true);
    this.enableClickMarks = enableClickMarks !== false;
    this.invincibility = invincibility || false;
    this.speedMult = 1 + (speedMult || 0);

    this.state = "ready";
    this.gemsCollected = 0;
    this._destroyed = false;

    this._initRenderer();
    this._initScene();
    this._buildPath();
    this._buildWorld();
    this._initLevelAnimation();
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
    const gl = this.canvas.getContext("webgl2") || this.canvas.getContext("webgl");
    if (gl) {
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
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
    this.renderer.toneMapping = THREE.NoToneMapping;

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

    const hemi = new THREE.HemisphereLight("#ffffff", "#ffffff", 0.4);
    this.scene.add(hemi);

    const ambient = new THREE.AmbientLight("#ffffff", 0.5);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight("#ffffff", 0.6);
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

    const tileTopMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(t.tileTop),
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const tileSideMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(t.tileSide),
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    const tileMats = [tileSideMat, tileSideMat, tileTopMat, tileTopMat, tileSideMat, tileSideMat];

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
        const mesh = new THREE.Mesh(geom, tileMats);
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
      const tileGroup = new THREE.Group();
      for (const cell of this.pathTiles.values()) {
        const mesh = new THREE.Mesh(tileGeom, tileMats);
        mesh.position.set(cell.x * tile, -0.25, cell.z * tile);
        tileGroup.add(mesh);
      }
      this.scene.add(tileGroup);
      this.tileMesh = tileGroup;
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

    const darkMarkerIds = ["beginning", "piano", "winter", "desert", "earth", "dream-of-sky", "west", "samsara", "chaos"];
    const markerColor = darkMarkerIds.includes(this.level.id) ? 0x000000 : 0xffffff;
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
    if (this.enableClickMarks) {
      for (let ci = 2; ci < this.corners.length - 1; ci++) {
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

    this._trailSegStart = this.position.clone();
    this._liveTrailSeg = null;
    this._lastOnPathPos = this.position.clone();
    this._offPathTimer = 0;
    this._frustum = new THREE.Frustum();
    this._projScreenMatrix = new THREE.Matrix4();
    this._trailCullTimer = 0;
  }

  _initLevelAnimation() {
    const id = this.level.id;
    const tile = this.level.tile || 1;
    const speed = this.level.tempo * this.speedMult;
    this._anim = { type: "none" };

    const noAnimIds = ["beginning", "piano", "earth"];
    if (noAnimIds.includes(id)) return;

    const startX = this.level.start.x * tile;
    const startZ = this.level.start.z * tile;

    function meshExtent(m) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      return Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    }
    function sizeScaledRevealDist(meshes, baseRevealDist) {
      const extents = meshes.map(m => meshExtent(m));
      const maxExt = Math.max(...extents, 1);
      return extents.map(ext => baseRevealDist * (0.6 + 0.8 * (ext / maxExt)));
    }

    if (id === "ocean" || id === "dream-of-sky") {
      if (id === "ocean") {
        this.scene.fog = new THREE.Fog("#0a1a3a", 5, 35);
      }
      const sameHeight = id === "dream-of-sky";
      const meshes = this.tileMesh.children;
      const baseRevealDist = id === "ocean" ? speed * 3.5 : speed * 3;
      const flySpeed = id === "ocean" ? 1.0 : 2.0;
      const perItemDists = sizeScaledRevealDist([...meshes], baseRevealDist);
      this._anim = {
        type: "fly-in",
        meshes: meshes.map((m, i) => {
          const target = m.position.clone();
          const randY = sameHeight ? 8 : (4 + Math.random() * 8);
          const randX = target.x + (Math.random() - 0.5) * 20;
          const randZ = target.z + (Math.random() - 0.5) * 20;
          m.position.set(randX, randY, randZ);
          m.visible = false;
          return { mesh: m, target, origin: m.position.clone(), revealed: false, t: 0, revealDist: perItemDists[i] };
        }),
        revealDist: baseRevealDist,
        speed: flySpeed,
      };
    } else if (id === "winter") {
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 12, 50);
      const overlay = document.createElement("canvas");
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
      overlay.width = window.innerWidth;
      overlay.height = window.innerHeight;
      document.body.appendChild(overlay);
      const ctx = overlay.getContext("2d");
      const count = 250;
      const flakes = [];
      for (let i = 0; i < count; i++) {
        flakes.push({ x: Math.random() * overlay.width, y: Math.random() * overlay.height, r: 3 + Math.random() * 4, vx: (Math.random() - 0.5) * 40, vy: 80 + Math.random() * 100, opacity: 0.8 + Math.random() * 0.2 });
      }
      this._anim = { type: "snow-2d", overlay, ctx, flakes, count };
    } else if (id === "storm" || id === "storm-remix" || id === "abs-storm") {
      const fogFar = id === "storm" ? 35 : 28;
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 4, fogFar);
      const overlay = document.createElement("canvas");
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
      overlay.width = window.innerWidth;
      overlay.height = window.innerHeight;
      document.body.appendChild(overlay);
      const ctx = overlay.getContext("2d");
      const isHeavy = id === "storm" || id === "abs-storm";
      const count = isHeavy ? 300 : 150;
      const drops = [];
      for (let i = 0; i < count; i++) {
        drops.push({ x: Math.random() * overlay.width, y: Math.random() * overlay.height, len: 15 + Math.random() * 25, vx: (Math.random() - 0.3) * 30, vy: 700 + Math.random() * 500, opacity: 0.25 + Math.random() * 0.35 });
      }
      this._anim = { type: "rain-2d", overlay, ctx, drops, count };
      if (id === "abs-storm") {
        const reflectiveMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(this.level.theme.tileTop),
          emissive: new THREE.Color(this.level.theme.tileTop),
          emissiveIntensity: 0.4,
          roughness: 0.3,
          metalness: 0.4,
        });
        const reflectiveSideMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(this.level.theme.tileSide),
          emissive: new THREE.Color(this.level.theme.tileSide),
          emissiveIntensity: 0.2,
          roughness: 0.4,
          metalness: 0.3,
        });
        const reflectiveMats = [reflectiveSideMat, reflectiveSideMat, reflectiveMat, reflectiveMat, reflectiveSideMat, reflectiveSideMat];
        for (const m of this.tileMesh.children) {
          m.material = reflectiveMats;
        }
      }
    } else if (id === "desert" || id === "west") {
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 4, 30);
    } else if (id === "crystal") {
      const pLight = new THREE.PointLight(this.level.theme.line, 18, 40, 0.8);
      pLight.position.copy(this.player.position);
      pLight.position.y = 3;
      this.scene.add(pLight);
      const spotLight = new THREE.SpotLight(this.level.theme.line, 14, 45, Math.PI / 3, 0.3, 0.6);
      spotLight.position.copy(this.player.position);
      spotLight.position.y = 4;
      spotLight.target.position.set(this.player.position.x + 5, 0, this.player.position.z + 5);
      this.scene.add(spotLight);
      this.scene.add(spotLight.target);
      const ambient2 = new THREE.AmbientLight(this.level.theme.line, 0.15);
      this.scene.add(ambient2);
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 5, 24);
      this.player.material.emissiveIntensity = 1.5;
      this.trailMaterial.emissiveIntensity = 1.5;
      const meshes = this.tileMesh.children;
      const litTopMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.level.theme.tileTop), roughness: 0.3, metalness: 0.4 });
      const litSideMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(this.level.theme.tileSide), roughness: 0.3, metalness: 0.4 });
      const litMats = [litSideMat, litSideMat, litTopMat, litTopMat, litSideMat, litSideMat];
      const perCrystalDists = sizeScaledRevealDist([...meshes], 22);
      for (let ci = 0; ci < meshes.length; ci++) {
        meshes[ci].visible = false;
        meshes[ci].material = litMats;
        meshes[ci].userData._revealDist = perCrystalDists[ci];
      }
      this._anim = { type: "crystal", pLight, spotLight, meshes, revealDist: 22 };
    } else if (id === "war") {
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 6, 35);
      const overlay = document.createElement("canvas");
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
      overlay.width = window.innerWidth;
      overlay.height = window.innerHeight;
      document.body.appendChild(overlay);
      const ctx = overlay.getContext("2d");
      const count = 60;
      const slopes = [1/3, 1/2, 2/3];
      const dustParts = [];
      for (let i = 0; i < count; i++) {
        dustParts.push({ x: Math.random() * overlay.width, y: Math.random() * overlay.height, size: 3 + Math.random() * 5, slope: slopes[Math.floor(Math.random() * 3)], slopeTimer: Math.random() * 3, vx: -(180 + Math.random() * 120), opacity: 0.3 + Math.random() * 0.3 });
      }
      this._anim = { type: "dust-2d", overlay, ctx, dustParts, count, color: "190,190,190" };
    } else if (id === "legend-of-assassin") {
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 4, 30);
      const overlay = document.createElement("canvas");
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;";
      overlay.width = window.innerWidth;
      overlay.height = window.innerHeight;
      document.body.appendChild(overlay);
      const ctx = overlay.getContext("2d");
      const count = 100;
      const slopes = [1/3, 1/2, 2/3];
      const dustParts = [];
      for (let i = 0; i < count; i++) {
        dustParts.push({ x: Math.random() * overlay.width, y: Math.random() * overlay.height, size: 4 + Math.random() * 6, slope: slopes[Math.floor(Math.random() * 3)], slopeTimer: Math.random() * 3, vx: -(200 + Math.random() * 150), opacity: 0.4 + Math.random() * 0.35 });
      }
      this._anim = { type: "dust-2d", overlay, ctx, dustParts, count, color: "190,190,190" };
    } else if (id === "taurus") {
      this.player.material.color.lerp(new THREE.Color(0xffffff), 0.35);
      const meshes = this.tileMesh.children;
      const baseRevealDist = speed * 1.2;
      const cyanColor = new THREE.Color(0x00ffff);
      const perItemDists = sizeScaledRevealDist([...meshes], baseRevealDist);
      this._anim = {
        type: "taurus",
        meshes: meshes.map((m, i) => {
          m.visible = false;
          return { mesh: m, revealed: false, t: 0, revealDist: perItemDists[i] };
        }),
        revealDist: baseRevealDist,
        cyanColor,
        fadeDuration: 0.6,
      };
    } else if (id === "spring-festival") {
      const meshes = this.tileMesh.children;
      const baseRevealDist = speed * 2;
      const perItemDists = sizeScaledRevealDist([...meshes], baseRevealDist);
      this._anim = {
        type: "spring-ascend",
        meshes: meshes.map((m, i) => {
          const target = m.position.clone();
          const origin = target.clone();
          origin.y -= 6 + Math.random() * 4;
          m.visible = false;
          return { mesh: m, target, origin, revealed: false, t: 0, revealDist: perItemDists[i] };
        }),
        revealDist: baseRevealDist,
        speed: 2.5,
      };
    } else if (id === "chaos") {
      this.scene.fog = new THREE.Fog(this.level.theme.sky, 6, 40);
      const meshes = this.tileMesh.children;
      const baseRevealDist = speed * 1.3;
      const animTypes = ["flip", "ascend", "fly-random", "fly-set"];
      const lastIdx = meshes.length - 1;
      const perItemDists = sizeScaledRevealDist([...meshes], baseRevealDist);
      this._anim = {
        type: "chaos",
        meshes: meshes.map((m, i) => {
          const target = m.position.clone();
          const targetRot = m.rotation.clone();
          const aType = animTypes[Math.floor(Math.random() * animTypes.length)];
          m.visible = false;
          let origin;
          if (aType === "flip") {
            origin = target.clone();
            m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
          } else if (aType === "ascend") {
            origin = target.clone();
            origin.y -= 6 + Math.random() * 4;
          } else if (aType === "fly-random") {
            origin = new THREE.Vector3(target.x + (Math.random() - 0.5) * 15, 3 + Math.random() * 8, target.z + (Math.random() - 0.5) * 15);
          } else {
            origin = new THREE.Vector3(target.x + (Math.random() - 0.5) * 15, target.y, target.z + (Math.random() - 0.5) * 15);
          }
          const itemRevealDist = (i === lastIdx) ? speed * 5 : perItemDists[i];
          return { mesh: m, target, targetRot, origin, originRot: m.rotation.clone(), aType, revealed: false, t: 0, revealDist: itemRevealDist };
        }),
        revealDist: baseRevealDist,
        speed: 2.0,
      };
    } else if (id === "samsara") {
      const meshes = this.tileMesh.children;
      const baseRevealDist = speed * 1.2;
      const perItemDists = sizeScaledRevealDist([...meshes], baseRevealDist);
      this._anim = {
        type: "samsara",
        meshes: meshes.map((m, i) => {
          m.visible = false;
          return { mesh: m, revealed: false, revealDist: perItemDists[i] };
        }),
        revealDist: baseRevealDist,
      };
    }
  }

  _updateLevelAnimation(dt) {
    if (!this._anim || this._anim.type === "none") return;
    const px = this.position.x;
    const pz = this.position.z;

    if (this._anim.type === "fly-in") {
      const a = this._anim;
      for (const item of a.meshes) {
        if (!item.revealed) {
          const dx = item.target.x - px;
          const dz = item.target.z - pz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < (item.revealDist || a.revealDist)) {
            item.revealed = true;
            item.mesh.visible = true;
            item.mesh.position.copy(item.origin);
          }
        }
        if (item.revealed && item.t < 1) {
          item.t = Math.min(1, item.t + dt * a.speed);
          const e = 1 - Math.pow(1 - item.t, 3);
          item.mesh.position.lerpVectors(item.origin, item.target, e);
        }
      }
    } else if (this._anim.type === "snow-2d") {
      const a = this._anim;
      const w = a.overlay.width, h = a.overlay.height;
      a.ctx.clearRect(0, 0, w, h);
      for (const f of a.flakes) {
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.y > h) { f.y = -5; f.x = Math.random() * w; }
        if (f.x < 0) f.x = w;
        if (f.x > w) f.x = 0;
        a.ctx.beginPath();
        a.ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        a.ctx.fillStyle = `rgba(255,255,255,${f.opacity})`;
        a.ctx.fill();
      }
    } else if (this._anim.type === "rain-2d") {
      const a = this._anim;
      const w = a.overlay.width, h = a.overlay.height;
      a.ctx.clearRect(0, 0, w, h);
      for (const d of a.drops) {
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        if (d.y > h + d.len) { d.y = -d.len; d.x = Math.random() * w; }
        if (d.x < -20) d.x = w + 10;
        if (d.x > w + 20) d.x = -10;
        const angle = d.vx / d.vy;
        a.ctx.beginPath();
        a.ctx.moveTo(d.x, d.y);
        a.ctx.lineTo(d.x + angle * d.len, d.y + d.len);
        a.ctx.strokeStyle = `rgba(180,200,220,${d.opacity})`;
        a.ctx.lineWidth = 1.5;
        a.ctx.lineCap = "round";
        a.ctx.stroke();
      }
    } else if (this._anim.type === "crystal") {
      const a = this._anim;
      a.pLight.position.set(px, 3, pz);
      a.spotLight.position.set(px, 4, pz);
      a.spotLight.target.position.set(
        px + this.direction.x * 10,
        0,
        pz + this.direction.z * 10
      );
      a.spotLight.target.updateMatrixWorld();
      for (const m of a.meshes) {
        const dx = m.position.x - px;
        const dz = m.position.z - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        m.visible = dist < (m.userData._revealDist || a.revealDist);
      }
    } else if (this._anim.type === "dust-2d") {
      const a = this._anim;
      const w = a.overlay.width, h = a.overlay.height;
      const slopes = [1/3, 1/2, 2/3];
      a.ctx.clearRect(0, 0, w, h);
      for (const p of a.dustParts) {
        p.x += p.vx * dt;
        p.slopeTimer -= dt;
        if (p.slopeTimer <= 0) {
          p.slope = slopes[Math.floor(Math.random() * 3)];
          p.slopeTimer = 1.5 + Math.random() * 2;
        }
        p.y += Math.abs(p.vx) * p.slope * dt;
        if (p.x < -20) { p.x = w + 10; p.y = Math.random() * h; }
        if (p.y < -20) p.y = h + 10;
        if (p.y > h + 20) p.y = -10;
        const s = p.size;
        a.ctx.beginPath();
        a.ctx.moveTo(p.x, p.y - s);
        a.ctx.lineTo(p.x + s * 0.6, p.y);
        a.ctx.lineTo(p.x, p.y + s);
        a.ctx.lineTo(p.x - s * 0.6, p.y);
        a.ctx.closePath();
        a.ctx.fillStyle = `rgba(${a.color},${p.opacity})`;
        a.ctx.fill();
      }
    } else if (this._anim.type === "taurus") {
      const a = this._anim;
      const sideColor = new THREE.Color(this.level.theme.tileSide);
      const topColor = new THREE.Color(this.level.theme.tileTop);
      for (const item of a.meshes) {
        if (!item.revealed) {
          const dx = item.mesh.position.x - px;
          const dz = item.mesh.position.z - pz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < (item.revealDist || a.revealDist)) {
            item.revealed = true;
            item.mesh.visible = true;
            const origMats = Array.isArray(item.mesh.material) ? item.mesh.material : [item.mesh.material];
            item.mesh.material = origMats.map(m => {
              const c = m.clone();
              c.transparent = true;
              c.opacity = 0.5;
              c.color.copy(a.cyanColor);
              return c;
            });
            item.origMats = origMats;
          }
        }
        if (item.revealed && item.t < 1) {
          item.t = Math.min(1, item.t + dt / a.fadeDuration);
          const mats = Array.isArray(item.mesh.material) ? item.mesh.material : [item.mesh.material];
          for (let mi = 0; mi < mats.length; mi++) {
            const mat = mats[mi];
            mat.opacity = 0.5 + 0.5 * item.t;
            const targetColor = (mi >= 2 && mi < 4) ? topColor : sideColor;
            mat.color.lerpColors(a.cyanColor, targetColor, item.t);
          }
          if (item.t >= 1) {
            item.mesh.material = item.origMats;
          }
        }
      }
    } else if (this._anim.type === "spring-ascend") {
      const a = this._anim;
      for (const item of a.meshes) {
        if (!item.revealed) {
          const dx = item.target.x - px;
          const dz = item.target.z - pz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < (item.revealDist || a.revealDist)) {
            item.revealed = true;
            item.mesh.visible = true;
            item.mesh.position.copy(item.origin);
          }
        }
        if (item.revealed && item.t < 1) {
          item.t = Math.min(1, item.t + dt * a.speed);
          const e = 1 - Math.pow(1 - item.t, 3);
          item.mesh.position.lerpVectors(item.origin, item.target, e);
        }
      }
    } else if (this._anim.type === "chaos") {
      const a = this._anim;
      for (const item of a.meshes) {
        if (!item.revealed) {
          const dx = item.target.x - px;
          const dz = item.target.z - pz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < (item.revealDist || a.revealDist)) {
            item.revealed = true;
            item.mesh.visible = true;
            item.mesh.position.copy(item.origin);
            item.mesh.rotation.copy(item.originRot);
          }
        }
        if (item.revealed && item.t < 1) {
          item.t = Math.min(1, item.t + dt * a.speed);
          const e = 1 - Math.pow(1 - item.t, 3);
          item.mesh.position.lerpVectors(item.origin, item.target, e);
          if (item.aType === "flip") {
            item.mesh.rotation.x = item.originRot.x * (1 - e);
            item.mesh.rotation.y = item.originRot.y * (1 - e);
            item.mesh.rotation.z = item.originRot.z * (1 - e);
          }
        }
      }
    } else if (this._anim.type === "samsara") {
      const a = this._anim;
      for (const item of a.meshes) {
        if (!item.revealed) {
          const dx = item.mesh.position.x - px;
          const dz = item.mesh.position.z - pz;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < (item.revealDist || a.revealDist)) {
            item.revealed = true;
            item.mesh.visible = true;
          }
        }
      }
    }
  }


  _initCamera() {
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(31, aspect, 0.1, 300);

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
    this._playingTime = 0;
    const tempo = (this.level.tempo || 6) * this.speedMult;
    const firstLen = this.level.segments[0] ? this.level.segments[0].length * (this.level.tile || 1) : 0;
    const baseDelay = 0.476 / tempo;
    this._musicDelay = firstLen / tempo + baseDelay + (this.level.audioDelay || 0);
    setTimeout(() => {
      this.music.setRate(this.speedMult);
      this.music.play();
    }, this._musicDelay * 1000);
    this.onEvent({ type: "start" });
  }

  pause() {
    if (this.state === "playing") {
      this.state = "paused";
      this._pausedPlayingTime = this._playingTime;
      this.music.pause();
      this.onEvent({ type: "pause" });
    }
  }

  resume() {
    if (this.state === "paused") {
      this.state = "playing";
      this._lastTs = 0;
      const musicTime = this.music._audio ? this.music._audio.currentTime : 0;
      if (musicTime > 0) {
        this._playingTime = (this._musicDelay || 0) + musicTime / (this.speedMult || 1);
      } else {
        this._playingTime = this._pausedPlayingTime || this._playingTime;
      }
      this.music.resume();
      this.onEvent({ type: "resume" });
    }
  }

  togglePause() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  }


  handleTap() {
    if (this.state === "ready") {
      this.start();
      return;
    }
    if (this.autoPlay && this.state === "playing") return;
    if (this.state !== "playing") return;
    if (!this._isOnPath(this.position) && !this.invincibility) return;
    if (this.direction.x !== 0) {
      this.direction.set(0, 0, 1);
    } else {
      this.direction.set(1, 0, 0);
    }

    this._dropTrailUpTo(this.position.clone());
    this._commitTrailSegment();
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
    if (!this._burstTexture) {
      const size = 128;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, "#ff8800");
      grad.addColorStop(0.5, "#ffbb00");
      grad.addColorStop(1, "#ffee00");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      this._burstTexture = new THREE.CanvasTexture(canvas);
    }
    const geom = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: this._burstTexture,
      transparent: true,
      opacity: 0.95,
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
    const start = this._trailSegStart;
    const dx = pos.x - start.x;
    const dz = pos.z - start.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const w = this.level.trailWidth || 0.32;
    const ext = w / 2;
    const totalLen = len + ext;
    const isX = Math.abs(dx) > Math.abs(dz);
    const dir = isX ? Math.sign(dx) : Math.sign(dz);

    if (this._liveTrailSeg) {
      this._liveTrailSeg.geometry.dispose();
      this._liveTrailSeg.geometry = new THREE.BoxGeometry(
        isX ? totalLen : w,
        TRAIL_HEIGHT,
        isX ? w : totalLen,
      );
      this._liveTrailSeg.position.set(
        isX ? (start.x + pos.x) / 2 - (dir * ext) / 2 : start.x,
        TRAIL_HEIGHT / 2 + 0.01,
        isX ? start.z : (start.z + pos.z) / 2 - (dir * ext) / 2,
      );
    } else {
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
      this._liveTrailSeg = seg;
    }
  }

  _commitTrailSegment() {
    this._liveTrailSeg = null;
    this._trailSegStart = this.position.clone();
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
    if (this.invincibility) return;
    this._dropTrailUpTo(this._lastOnPathPos || this.position.clone());
    this._commitTrailSegment();
    this.state = "falling";
    this.fallTimer = 0;
    this.fallVelocity = 0;
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
    this._playingTime = 0;
    this.position.set(
      this.level.start.x * this.level.tile,
      PLAYER_SIZE / 2 + 0.01,
      this.level.start.z * this.level.tile,
    );
    this.lastCornerPos = this.position.clone();
    this._trailSegStart = this.position.clone();
    this._liveTrailSeg = null;
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
    this._resetLevelAnimation();
    this.onEvent({ type: "reset" });
  }

  _resetLevelAnimation() {
    if (!this._anim || this._anim.type === "none") return;
    const a = this._anim;
    if (a.type === "fly-in") {
      for (const item of a.meshes) {
        item.mesh.position.copy(item.origin);
        item.mesh.visible = false;
        item.revealed = false;
        item.t = 0;
      }
    } else if (a.type === "taurus") {
      for (const item of a.meshes) {
        if (item.origMats) item.mesh.material = item.origMats;
        item.mesh.visible = false;
        item.revealed = false;
        item.t = 0;
      }
    } else if (a.type === "spring-ascend") {
      for (const item of a.meshes) {
        item.mesh.position.copy(item.target);
        item.mesh.visible = false;
        item.revealed = false;
        item.t = 0;
      }
    } else if (a.type === "chaos") {
      for (const item of a.meshes) {
        item.mesh.visible = false;
        item.revealed = false;
        item.t = 0;
      }
    } else if (a.type === "samsara") {
      for (const item of a.meshes) {
        item.mesh.visible = false;
        item.revealed = false;
      }
    } else if (a.type === "crystal") {
      for (const m of a.meshes) m.visible = false;
    }
  }

  destroy() {
    this._destroyed = true;
    this.music.destroy();
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKeyDown);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    if (this._anim && this._anim.overlay) {
      this._anim.overlay.remove();
    }
    this.renderer.state.reset();
    this.renderer.clear();
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
      this._playingTime += dt;
      const speed = this.level.tempo * this.speedMult;
      const expectedDist = speed * this._playingTime;

      if (this.autoPlay) {
        const autoDt = Math.min(dt, 1 / 60);
        const moveDist = speed * autoDt;
        if (this.cornerIndex < this.corners.length - 1) {
          const next = this.corners[this.cornerIndex + 1];
          const tile = this.level.tile || 1;
          const tx = next.x * tile;
          const tz = next.z * tile;
          const distToCorner = Math.abs(tx - this.position.x) + Math.abs(tz - this.position.z);
          if (distToCorner <= moveDist) {
            this.position.set(tx, this.position.y, tz);
            this.distanceTravelled += distToCorner;
            this._dropTrailUpTo(this.position.clone());
            this._commitTrailSegment();
            this.lastCornerPos = this.position.clone();
            this.cornerIndex += 1;
            if (this.cornerIndex < this.corners.length - 1) {
              const after = this.corners[this.cornerIndex + 1];
              const atx = after.x * tile;
              const atz = after.z * tile;
              const ddx = atx - tx;
              const ddz = atz - tz;
              if (Math.abs(ddx) > Math.abs(ddz)) this.direction.set(ddx > 0 ? 1 : -1, 0, 0);
              else this.direction.set(0, 0, ddz > 0 ? 1 : -1);
            }
            this._triggerOverlappingMarkers();
            const leftover = moveDist - distToCorner;
            if (leftover > 0.001) {
              this.position.x += this.direction.x * leftover;
              this.position.z += this.direction.z * leftover;
              this.distanceTravelled += leftover;
            }
          } else {
            this.position.x += this.direction.x * moveDist;
            this.position.z += this.direction.z * moveDist;
            this.distanceTravelled += moveDist;
          }
        } else {
          this.position.x += this.direction.x * moveDist;
          this.position.z += this.direction.z * moveDist;
          this.distanceTravelled += moveDist;
        }
        this._dropTrailUpTo(this.position.clone());
        this._lastOnPathPos = this.position.clone();
        this._offPathTimer = 0;
      } else {
        const moveDist = expectedDist - this.distanceTravelled;
        if (moveDist > 0) {
          this.position.x += this.direction.x * moveDist;
          this.position.z += this.direction.z * moveDist;
          this.distanceTravelled = expectedDist;
        }

        const onPath = this._isOnPath(this.position);
        if (onPath) {
          this._lastOnPathPos = this.position.clone();
          this._offPathTimer = 0;
          this._dropTrailUpTo(this.position.clone());
        } else if (this.invincibility) {
          this._dropTrailUpTo(this.position.clone());
        } else {
          this._offPathTimer += dt;
          if (this._offPathTimer >= OFF_PATH_GRACE) this._die();
        }
      }

      this.player.position.copy(this.position);

      this._checkGems();
      this._checkFinish();

      const pct = Math.min(1, this.distanceTravelled / this.totalDistance);
      this.onEvent({ type: "progress", value: pct });

    } else if (this.state === "falling" && dt > 0) {
      this.fallTimer += dt;
      const speed = this.level.tempo * this.speedMult;
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
        b.material.opacity = 0.95 * Math.pow(1 - p, 2);
      }
    }
    this._updateCamera(dt);
    this._updateLevelAnimation(dt);
    this._cullTrail(dt);
  }

  _cullTrail(dt) {
    this._trailCullTimer += dt;
    if (this._trailCullTimer < 0.5) return;
    this._trailCullTimer = 0;

    this._projScreenMatrix.multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse
    );
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    const _sphere = new THREE.Sphere();
    const children = this.trailGroup.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const seg = children[i];
      if (seg === this._liveTrailSeg) continue;
      if (!seg.geometry.boundingSphere) seg.geometry.computeBoundingSphere();
      _sphere.copy(seg.geometry.boundingSphere).applyMatrix4(seg.matrixWorld);
      const inView = this._frustum.intersectsSphere(_sphere);
      if (inView) {
        seg.userData._offScreenTime = 0;
      } else {
        seg.userData._offScreenTime = (seg.userData._offScreenTime || 0) + 0.5;
        if (seg.userData._offScreenTime >= 1) {
          this.trailGroup.remove(seg);
          seg.geometry.dispose();
        }
      }
    }
  }

  _updateCamera(dt) {
    const targetPos = new THREE.Vector3(
      this.position.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      this.position.z + CAM_OFFSET.z
    );
    const targetLook = new THREE.Vector3(this.position.x, 0, this.position.z);

    const s = 1 - Math.pow(0.008, dt);
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
