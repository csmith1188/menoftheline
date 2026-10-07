import * as THREE from "three";
import { CONFIG } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_VARIANTS, unitStats, unitLandCost, variantBadgeFill } from "../shared/units.js";
import { Path, quarterSegments, quarterThickness } from "../shared/path.js";
import { TERRAIN_EMOJI, TERRAIN_TINT } from "../shared/terrain.js";
import { canvasFont, showTerrainLabels, uiFontsReady } from "./board.js";
import { collectDebugMarks, debugRangesOn } from "./debugRanges.js";
import { buyBgImage } from "./buyArt.js";
import { isArcLane, laneRowColor } from "./mapView.js";

/** Parse rgba(...) tint into a hex-ish color + opacity for 3D materials. */
function terrainColor(kind) {
  const tint = TERRAIN_TINT[kind] || "rgba(80,80,80,0.5)";
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(tint);
  const r = m ? Number(m[1]) : 80;
  const g = m ? Number(m[2]) : 80;
  const b = m ? Number(m[3]) : 80;
  const hex = (r << 16) | (g << 8) | b;
  return { color: hex, opacity: 0.45 };
}

function labelTexture(lines, opts = {}) {
  const width = opts.width || 256;
  const height = opts.height || 128;
  const pad = document.createElement("canvas");
  pad.width = width;
  pad.height = height;
  const ctx = pad.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  if (opts.fill) {
    ctx.fillStyle = opts.fill;
    ctx.fillRect(0, 0, width, height);
  }
  if (opts.bgImage) {
    const iw = width * 0.6;
    const ih = height * 0.6;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(opts.bgImage, (width - iw) / 2, (height - ih) / 2, iw, ih);
    ctx.globalAlpha = 1;
  }
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.lineWidth || 6;
    ctx.strokeRect(3, 3, width - 6, height - 6);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const list = Array.isArray(lines) ? lines : [lines];
  const step = height / (list.length + 1);
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const x = width / 2;
    const y = step * (i + 1);
    ctx.font = row.font || opts.font || canvasFont(36);
    if (opts.textOutline) {
      ctx.lineWidth = opts.textOutlineWidth || 6;
      ctx.strokeStyle = opts.textOutline;
      ctx.strokeText(row.text, x, y);
    }
    ctx.fillStyle = row.color || opts.color || "#e8eef6";
    ctx.fillText(row.text, x, y);
  }
  if (opts.sideArrows) {
    const mid = height / 2;
    const edge = Math.max(18, width * 0.08);
    const s = Math.max(10, height * 0.12);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(edge - s * 0.55, mid);
    ctx.lineTo(edge + s * 0.45, mid - s);
    ctx.lineTo(edge + s * 0.45, mid + s);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(width - edge + s * 0.55, mid);
    ctx.lineTo(width - edge - s * 0.45, mid - s);
    ctx.lineTo(width - edge - s * 0.45, mid + s);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(pad);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function setLabel(mesh, lines, opts) {
  const tex = labelTexture(lines, opts);
  if (mesh.material.map) mesh.material.map.dispose();
  mesh.material.map = tex;
  mesh.material.color.set("#ffffff");
  mesh.material.needsUpdate = true;
  mesh.userData.key = opts.key || JSON.stringify(lines);
}

/** Billboard text sprite for world labels (towns, lane bonuses). */
function makeBillboard(scaleX, scaleY) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }));
  sprite.scale.set(scaleX, scaleY, 1);
  sprite.center.set(0.5, 0.5);
  return sprite;
}

function setBillboard(sprite, text, opts = {}) {
  const key = `${text}:${opts.color || ""}:${opts.font || ""}:${uiFontsReady() ? "1" : "0"}`;
  if (sprite.userData.key === key) return;
  const width = opts.width || 160;
  const height = opts.height || 64;
  const pad = document.createElement("canvas");
  pad.width = width;
  pad.height = height;
  const ctx = pad.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.font = opts.font || canvasFont(36);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = opts.outlineWidth || 6;
  ctx.strokeStyle = opts.outline || "#0d1218";
  ctx.strokeText(text, width / 2, height / 2);
  ctx.fillStyle = opts.color || "#e8eef6";
  ctx.fillText(text, width / 2, height / 2);
  const tex = new THREE.CanvasTexture(pad);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (sprite.material.map) sprite.material.map.dispose();
  sprite.material.map = tex;
  sprite.material.needsUpdate = true;
  sprite.userData.key = key;
}

function makePad(w, h, fill) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, 8, h),
    new THREE.MeshStandardMaterial({ color: fill, roughness: 0.7, metalness: 0.05 }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.92, h * 0.92),
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true }),
  );
  face.rotation.x = -Math.PI / 2;
  face.position.y = 4.2;
  mesh.add(face);
  mesh.userData.face = face;
  return mesh;
}

function std(color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.04 });
  mat.emissive = new THREE.Color("#000000");
  return mat;
}

function barMesh(color) {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.BoxGeometry(22, 1.6, 2),
    new THREE.MeshBasicMaterial({ color: "#1a1510" }),
  );
  const fill = new THREE.Mesh(
    new THREE.BoxGeometry(22, 1.6, 2),
    new THREE.MeshBasicMaterial({ color }),
  );
  fill.position.z = 0.4;
  group.add(bg, fill);
  group.userData.fill = fill;
  return group;
}

function setBar(group, ratio) {
  const amount = Math.max(0, Math.min(1, ratio));
  const fill = group.userData.fill;
  fill.scale.x = Math.max(0.001, amount);
  fill.position.x = -11 * (1 - amount);
}

function orderColor(order, squared) {
  if (order === "halt" && squared) return CONFIG.colors.reform;
  if (order === "halt") return CONFIG.colors.halt;
  if (order === "reform") return CONFIG.colors.reform;
  if (order === "charge") return CONFIG.colors.charge;
  if (order === "fallback") return CONFIG.colors.fallback;
  if (order === "retreat") return CONFIG.colors.retreat;
  return "#0d1218";
}

/** Slightly larger back-face shell so the order color reads as a stroke. */
function orderShell(mesh) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: "#0d1218", side: THREE.BackSide }),
  );
  outline.position.copy(mesh.position);
  outline.rotation.copy(mesh.rotation);
  outline.scale.copy(mesh.scale);
  return outline;
}

function makeUnit(type) {
  const group = new THREE.Group();
  const mat = std("#ffffff");
  const outlines = [];
  function addBody(mesh) {
    const outline = orderShell(mesh);
    outlines.push(outline);
    group.add(outline, mesh);
  }
  if (type === "cannon") {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(10, 12, 14, 18), mat);
    body.position.y = 9;
    addBody(body);
  } else if (type === "skirmisher") {
    const body = new THREE.Mesh(new THREE.ConeGeometry(11, 22, 3), mat);
    body.position.y = 12;
    addBody(body);
  } else if (type === "dragoon") {
    const body = new THREE.Mesh(new THREE.OctahedronGeometry(11), mat);
    body.position.y = 12;
    addBody(body);
  } else if (type === "officer") {
    const a = new THREE.Mesh(new THREE.BoxGeometry(3.2, 20, 3.2), mat);
    const b = new THREE.Mesh(new THREE.BoxGeometry(3.2, 20, 3.2), mat);
    a.rotation.z = Math.PI / 4;
    b.rotation.z = -Math.PI / 4;
    a.position.y = 12;
    b.position.y = 12;
    addBody(a);
    addBody(b);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(24, 7, 6), mat);
    body.position.y = 8;
    addBody(body);
  }
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(18, 2, 18),
    std("#ffffff"),
  );
  plate.position.y = 1.2;
  plate.visible = false;
  const mark = new THREE.Mesh(
    new THREE.SphereGeometry(3, 10, 8),
    new THREE.MeshBasicMaterial({ color: "#ff3b30" }),
  );
  mark.position.y = 32;
  mark.visible = false;
  const hp = barMesh(CONFIG.colors.gold);
  hp.position.y = 28;
  const fat = barMesh(CONFIG.colors.fatigue);
  fat.position.y = 24;
  group.add(plate, mark, hp, fat);
  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  for (let i = 0; i < outlines.length; i += 1) {
    outlines[i].castShadow = false;
    outlines[i].receiveShadow = false;
  }
  group.userData = { type, mat, plate, outlines, mark, hp, fat };
  return group;
}

function makeKeep(sideId) {
  const capital = sideId === "player" ? CONFIG.playerCapital : CONFIG.enemyCapital;
  const color = sideId === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
  const dark = sideId === "player" ? CONFIG.colors.playerDark : CONFIG.colors.enemyDark;
  const group = new THREE.Group();
  const baseMat = std(dark);
  baseMat.transparent = true;
  baseMat.depthWrite = true;
  const towerMat = std(color);
  towerMat.transparent = true;
  towerMat.depthWrite = true;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(CONFIG.capitalRadius, CONFIG.capitalRadius + 4, 26, 24),
    baseMat,
  );
  base.position.y = 13;
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(12, 14, 28, 16),
    towerMat,
  );
  tower.position.y = 38;
  const hp = barMesh(color);
  hp.position.y = 58;
  group.add(base, tower, hp);
  group.position.set(capital.x, 0, capital.y);
  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  group.userData = { hp, base, tower, capital };
  return group;
}

function lineMesh(x1, y1, x2, y2, color, lift, thickness) {
  const dx = x2 - x1;
  const dz = y2 - y1;
  const len = Math.hypot(dx, dz) || 1;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(len, 3, thickness || 8),
    std(color),
  );
  mesh.position.set((x1 + x2) / 2, lift, (y1 + y2) / 2);
  mesh.rotation.y = Math.atan2(-dz, dx);
  return mesh;
}

/**
 * Tabletop view of the lane map. Game (x, y) sits on the ground as (x, 0, y).
 * The world group mirrors on X for southpaw. The camera stays outside that group.
 */
export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const touchUi = window.matchMedia("(pointer: coarse)").matches
    || (navigator.maxTouchPoints || 0) > 0;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touchUi ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.bg);
  scene.fog = new THREE.Fog(CONFIG.colors.bg, 1400, 2800);

  const camera = new THREE.PerspectiveCamera(36, 1, 1, 6000);
  const world = new THREE.Group();
  scene.add(world);

  scene.add(new THREE.AmbientLight("#d7e4f2", 0.55));
  const sun = new THREE.DirectionalLight("#fff6e4", 1.25);
  sun.position.set(280, 980, 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 2200;
  sun.shadow.camera.left = -900;
  sun.shadow.camera.right = 1400;
  sun.shadow.camera.top = 900;
  sun.shadow.camera.bottom = -400;
  scene.add(sun);

  const groundTex = new THREE.TextureLoader().load("/img/grasstexture.jpg");
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.wrapS = THREE.RepeatWrapping;
  groundTex.wrapT = THREE.RepeatWrapping;
  // ~200 world units per tile across the 2400×1800 ground.
  groundTex.repeat.set(12, 9);
  groundTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 1800),
    new THREE.MeshStandardMaterial({
      map: groundTex,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(CONFIG.canvasWidth / 2, 0, 420);
  ground.receiveShadow = true;
  world.add(ground);

  const left = CONFIG.playerCapital;
  const right = CONFIG.enemyCapital;
  const span = right.x - left.x;
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(span, 8, CONFIG.topLaneHeight),
    std(CONFIG.colors.topLane),
  );
  band.position.set((left.x + right.x) / 2, 4, left.y);
  band.receiveShadow = true;
  band.castShadow = true;
  world.add(band);

  /** @type {Record<string, THREE.Mesh[]>} */
  const rowMeshesByLane = {};
  const laneIds = Path.laneIds();
  for (let li = 0; li < laneIds.length; li += 1) {
    const laneId = laneIds[li];
    const def = Path.laneDef(laneId);
    const rows = [];
    rowMeshesByLane[laneId] = rows;
    if (!def || !def.geometry) continue;
    if (def.geometry.kind === "line") {
      const width = def.geometry.sublaneWidth * 0.72;
      for (let s = 0; s < def.geometry.sublaneCount; s += 1) {
        const pts = Path.worldPoints(laneId, s);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(span, 2.5, width),
          std(laneRowColor(laneId)),
        );
        mesh.position.set((pts[0].x + pts[1].x) / 2, 9, pts[0].y);
        mesh.receiveShadow = true;
        world.add(mesh);
        rows.push(mesh);
      }
      continue;
    }
    if (def.geometry.kind === "arc") {
      const center = Path.arcCenter(laneId);
      const half = def.geometry.sublaneWidth * 0.55;
      for (let s = 0; s < def.geometry.sublaneCount; s += 1) {
        const radius = Path.arcRadius(laneId, s);
        const geo = new THREE.RingGeometry(
          Math.max(1, radius - half),
          radius + half,
          72,
          1,
          Math.PI,
          Math.PI,
        );
        const mesh = new THREE.Mesh(geo, std(laneRowColor(laneId)));
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(center.x, 6 + s * 0.35, center.y);
        mesh.receiveShadow = true;
        world.add(mesh);
        rows.push(mesh);
      }
    }
  }
  const center = Path.bottomCenter();
  const topRows = rowMeshesByLane.top || [];
  const bottomRows = rowMeshesByLane.bottom || [];

  const covers = quarterSegments();
  for (let i = 0; i < covers.length; i += 1) {
    const seg = covers[i];
    const mesh = lineMesh(seg.x1, seg.y1, seg.x2, seg.y2, seg.color, 11, quarterThickness());
    mesh.material.transparent = true;
    mesh.material.opacity = 0.45;
    world.add(mesh);
  }

  const terrainGroup = new THREE.Group();
  world.add(terrainGroup);
  const fogGroup = new THREE.Group();
  world.add(fogGroup);
  let terrainKey = "";

  const topCenter = lineMesh(left.x, left.y - CONFIG.topLaneHeight / 2, left.x, left.y + CONFIG.topLaneHeight / 2, CONFIG.colors.laneCenter, 12);
  world.add(topCenter);
  const bottomCenter = lineMesh(center.x, center.y, center.x + 40, center.y, CONFIG.colors.laneCenter, 12);
  world.add(bottomCenter);
  const topBonus = makeBillboard(56, 22);
  topBonus.position.y = 28;
  world.add(topBonus);
  const bottomBonus = makeBillboard(56, 22);
  bottomBonus.position.y = 28;
  world.add(bottomBonus);

  const keeps = {
    player: makeKeep("player"),
    enemy: makeKeep("enemy"),
  };
  world.add(keeps.player, keeps.enemy);

  const hud = new THREE.Group();
  world.add(hud);
  const buyMeshes = [];
  const unlockMeshes = [];
  const upgradeMeshes = [];

  const units = new Map();
  const towns = new Map();
  const debugGroup = new THREE.Group();
  world.add(debugGroup);
  const shots = [];
  const splats = [];

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hintScratch = new THREE.Vector3();
  let lastPickedTroopId = null;
  const gestureHintsEl = document.getElementById("gesture-hints");
  const hintNodes = [];

  function fitBoardMetrics(board) {
    const rect = canvas.getBoundingClientRect();
    board.cssScale = Math.max(0.01, rect.width / CONFIG.canvasWidth);
  }

  function resize() {
    const parent = canvas.parentElement || canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fitOverviewToField();
  }

  function mirror(on) {
    world.position.x = on ? CONFIG.canvasWidth : 0;
    world.scale.x = on ? -1 : 1;
  }

  function pointerToGame(event) {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    lastPickedTroopId = null;

    const pads = hud.children.filter((mesh) => mesh.visible);
    if (pads.length) {
      hud.updateMatrixWorld(true);
      const hit = raycaster.intersectObjects(pads, true)[0];
      if (hit) {
        const local = world.worldToLocal(hit.point.clone());
        return { x: local.x, y: local.z };
      }
    }

    const unitList = Array.from(units.values());
    if (unitList.length) {
      world.updateMatrixWorld(true);
      const hits = raycaster.intersectObjects(unitList, true);
      for (let i = 0; i < hits.length; i += 1) {
        let obj = hits[i].object;
        while (obj && obj !== world) {
          if (obj.userData && obj.userData.troopId != null) {
            lastPickedTroopId = obj.userData.troopId;
            break;
          }
          obj = obj.parent;
        }
        if (lastPickedTroopId != null) break;
      }
    }

    // Always aim on the ground plane so order drags follow the pointer.
    const origin = world.worldToLocal(raycaster.ray.origin.clone());
    const tip = world.worldToLocal(raycaster.ray.origin.clone().add(raycaster.ray.direction));
    const dir = tip.sub(origin);
    if (Math.abs(dir.y) < 1e-5) {
      return { x: CONFIG.canvasWidth / 2, y: CONFIG.canvasHeight / 2 };
    }
    const t = -origin.y / dir.y;
    return { x: origin.x + dir.x * t, y: origin.z + dir.z * t };
  }

  function logicalToGame(screen) {
    const rect = canvas.getBoundingClientRect();
    return pointerToGame({
      clientX: rect.left + (screen.x / CONFIG.canvasWidth) * rect.width,
      clientY: rect.top + (screen.y / CONFIG.canvasHeight) * rect.height,
    });
  }

  function visualX(x, southpaw) {
    return southpaw ? CONFIG.canvasWidth - x : x;
  }

  function frameCamera(board) {
    mirror(Boolean(board.southpaw));
    if (board.telescope) {
      board.stepTelescope();
      const lane = board.telescope.lane;
      const len = board.laneLength(lane);
      const t = len <= 0 ? 0 : board.telescope.along / len;
      // Aim at the lane itself. The 2D telescopeCamera lift is only for canvas framing.
      let aimX;
      let aimZ;
      let angle;
      if (isArcLane(lane) && typeof board.bottomCamera === "function") {
        const at = board.bottomCamera(t);
        aimX = at.x;
        aimZ = at.y;
        angle = at.angle;
      } else {
        const pts = Path.centerline(lane);
        const at = Path.pointAt(pts, t);
        const tan = Path.tangentAt(pts, t);
        aimX = at.x;
        aimZ = at.y;
        angle = Math.atan2(tan.y, tan.x);
      }
      let tx = Math.cos(angle);
      let tz = Math.sin(angle);
      if (board.southpaw) tx = -tx;
      // Pure side view: offset on the lane normal so the road runs left to right.
      const px = -tz;
      const pz = tx;
      const x = visualX(aimX, board.southpaw);
      const z = aimZ;
      const dist = 170;
      const height = 130;
      // Toward the camera raises the lane; past it lowers it. Arc lanes need a lower frame.
      const pull = isArcLane(lane) ? -24 : 28;
      camera.position.set(x + px * dist, height, z + pz * dist);
      camera.up.set(0, 1, 0);
      camera.lookAt(x + px * pull, 12, z + pz * pull);
      return;
    }
    frameOverview();
  }

  function syncCenters(board) {
    const centers = board.laneCenters || {
      top: board.topCenter,
      bottom: board.bottomCenter,
    };
    const topShare = centers.top != null ? centers.top : 0.5;
    const x = left.x + span * topShare;
    topCenter.position.x = x;
    const topY = left.y - CONFIG.topLaneHeight / 2;
    topBonus.position.set(x, 28, topY - 8);
    topBonus.scale.set(board.southpaw ? -56 : 56, 22, 1);
    const playerGps = Math.round(CONFIG.centerIncome * topShare);
    setBillboard(topBonus, `+${playerGps}💰`, {
      color: CONFIG.colors.player,
      font: canvasFont(34),
      width: 180,
      height: 64,
    });
    const bottomShare = centers.bottom != null ? centers.bottom : 0.5;
    const arcId = Path.firstArcLaneId() || "bottom";
    const arcDef = Path.laneDef(arcId);
    const arcCount = arcDef && arcDef.geometry ? arcDef.geometry.sublaneCount : CONFIG.bottomSublaneCount;
    const theta = Math.PI * (1 - bottomShare);
    const rIn = Path.arcRadius(arcId, arcCount - 1) - 10;
    const rOut = Path.arcRadius(arcId, 0) + 10;
    const arcCenter = Path.arcCenter(arcId);
    const x1 = arcCenter.x + rIn * Math.cos(theta);
    const y1 = arcCenter.y + rIn * Math.sin(theta);
    const x2 = arcCenter.x + rOut * Math.cos(theta);
    const y2 = arcCenter.y + rOut * Math.sin(theta);
    const dx = x2 - x1;
    const dz = y2 - y1;
    const len = Math.hypot(dx, dz) || 1;
    bottomCenter.scale.x = len / 40;
    bottomCenter.position.set((x1 + x2) / 2, 12, (y1 + y2) / 2);
    bottomCenter.rotation.y = Math.atan2(-dz, dx);
    const pad = 16;
    const bx = arcCenter.x + (rOut + pad) * Math.cos(theta);
    const bz = arcCenter.y + (rOut + pad) * Math.sin(theta);
    bottomBonus.position.set(bx, 28, bz);
    bottomBonus.scale.set(board.southpaw ? -56 : 56, 22, 1);
    const landBonus = Math.round(CONFIG.centerLand * bottomShare);
    setBillboard(bottomBonus, `+${landBonus}🌿`, {
      color: CONFIG.colors.player,
      font: canvasFont(34),
      width: 180,
      height: 64,
    });
  }

  function syncHover(board) {
    const ids = Object.keys(rowMeshesByLane);
    for (let i = 0; i < ids.length; i += 1) {
      const rows = rowMeshesByLane[ids[i]];
      for (let r = 0; r < rows.length; r += 1) rows[r].material.emissive.set("#000000");
    }
    const row = typeof board.switchHoverRow === "function" ? board.switchHoverRow() : null;
    if (row == null || !board.drag || !board.drag.troop) return;
    const troop = board.drag.troop;
    const rows = rowMeshesByLane[troop.lane] || (troop.lane === "top" ? topRows : bottomRows);
    const mesh = rows[row];
    if (mesh) mesh.material.emissive.set(CONFIG.colors.laneHover);
  }

  function syncUnit(troop, board) {
    let mesh = units.get(troop.id);
    if (!mesh || mesh.userData.type !== troop.type) {
      if (mesh) world.remove(mesh);
      mesh = makeUnit(troop.type);
      units.set(troop.id, mesh);
      world.add(mesh);
    }
    mesh.position.set(troop.x, 12, troop.y);
    mesh.userData.troopId = troop.id;
    const tan = troop.laneTangent();
    const facing = Math.atan2(tan.x, tan.y) + (troop.type === "officer" ? Math.PI / 2 : 0);
    mesh.rotation.set(0, facing, 0);
    mesh.userData.hp.rotation.y = -mesh.rotation.y;
    mesh.userData.fat.rotation.y = -mesh.rotation.y;
    const color = troop.flash > 0
      ? "#fff4d2"
      : troop.side.id === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
    mesh.userData.mat.color.set(troop.broken ? "#8d97a3" : color);
    mesh.userData.plate.visible = Boolean(variantBadgeFill(troop.variant || troop.type));
    const plateFill = variantBadgeFill(troop.variant || troop.type);
    if (plateFill) mesh.userData.plate.material.color.set(plateFill);
    const shown = troop.givenOrder === undefined ? troop.order : troop.givenOrder;
    const ordered = shown === "halt" || shown === "reform"
      || shown === "charge" || shown === "fallback"
      || shown === "retreat";
    const shellScale = ordered ? 1.28 : 1.12;
    const stroke = orderColor(shown, troop.squared);
    const shells = mesh.userData.outlines;
    for (let i = 0; i < shells.length; i += 1) {
      shells[i].material.color.set(stroke);
      shells[i].scale.set(shellScale, shellScale, shellScale);
    }
    const selected = board.inspectedLineIds && board.inspectedLineIds[troop.id];
    const primary = board.inspectedId === troop.id;
    mesh.userData.mark.visible = Boolean(selected);
    mesh.userData.mark.material.color.set(primary ? "#ff3b30" : "#ff8a84");
    mesh.userData.mark.material.transparent = !primary;
    mesh.userData.mark.material.opacity = primary ? 1 : 0.65;
    mesh.userData.mark.scale.setScalar(primary ? 1 : 0.82);
    const maxHp = troop.maxHP();
    setBar(mesh.userData.hp, maxHp > 0 ? troop.hp / maxHp : 0);
    const maxFatigue = troop.maxFatigue || 100;
    setBar(mesh.userData.fat, maxFatigue > 0 ? (troop.fatigue || 0) / maxFatigue : 0);
  }

  function syncDebugRanges(board) {
    while (debugGroup.children.length) {
      const child = debugGroup.children.pop();
      debugGroup.remove(child);
      child.geometry.dispose();
      child.material.dispose();
    }
    if (!debugRangesOn()) return;
    const marks = collectDebugMarks(board);
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      const pts = mark.points;
      if (!pts || pts.length < 2) continue;
      for (let p = 1; p < pts.length; p += 1) {
        const mesh = lineMesh(pts[p - 1].x, pts[p - 1].y, pts[p].x, pts[p].y, mark.color, 14, Math.max(2, mark.width));
        mesh.material.transparent = true;
        mesh.material.opacity = mark.alpha;
        debugGroup.add(mesh);
      }
    }
  }

  function syncUnits(board) {
    const live = new Set();
    const troops = board.player.troops.concat(board.enemy.troops);
    for (let i = 0; i < troops.length; i += 1) {
      const troop = troops[i];
      if (troop.hp <= 0) continue;
      live.add(troop.id);
      syncUnit(troop, board);
    }
    for (const [id, mesh] of units) {
      if (live.has(id)) continue;
      world.remove(mesh);
      units.delete(id);
    }
  }

  function syncTowns(board) {
    const live = new Set();
    for (let i = 0; i < board.checkpoints.length; i += 1) {
      const town = board.checkpoints[i];
      live.add(town.index);
      let mesh = towns.get(town.index);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(town.radius(), town.radius(), 10, 18),
          std(CONFIG.colors.neutral),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(town.radius() + 4, 1.2, 8, 24),
          new THREE.MeshBasicMaterial({ color: "#ffffff" }),
        );
        halo.rotation.x = Math.PI / 2;
        halo.position.y = 6;
        mesh.add(halo);
        const kindLabel = makeBillboard(18, 18);
        kindLabel.position.y = 14;
        mesh.add(kindLabel);
        const costLabel = makeBillboard(36, 16);
        costLabel.position.y = 22;
        mesh.add(costLabel);
        mesh.userData.halo = halo;
        mesh.userData.kindLabel = kindLabel;
        mesh.userData.costLabel = costLabel;
        towns.set(town.index, mesh);
        world.add(mesh);
      }
      mesh.position.set(town.x, 5, town.y);
      const color = town.owner === "player"
        ? CONFIG.colors.player
        : town.owner === "enemy"
          ? CONFIG.colors.enemy
          : CONFIG.colors.neutral;
      mesh.material.color.set(color);
      mesh.userData.halo.visible = Boolean(town.owner === "player" && town.producing);
      const flip = board.southpaw ? -1 : 1;
      mesh.userData.kindLabel.scale.set(18 * flip, 18, 1);
      mesh.userData.costLabel.scale.set(36 * flip, 16, 1);
      const kind = town.upgradeKind();
      const kindMark = kind === "speed" ? "⚡" : kind === "armor" ? "🛡️" : "⚔️";
      setBillboard(mesh.userData.kindLabel, kindMark, {
        font: canvasFont(42),
        color: "#0d1218",
        outline: "#ffffff",
        outlineWidth: 4,
        width: 96,
        height: 96,
      });
      const showCost = Boolean(board.player && town.owner === "player");
      mesh.userData.costLabel.visible = showCost;
      if (showCost) {
        const maxed = board.player.upgrades[kind] >= CONFIG.upgradeMax;
        const remain = Math.ceil(board.player.upgradeRemaining(kind));
        const cost = maxed ? "MAX" : `${remain}🌿`;
        setBillboard(mesh.userData.costLabel, cost, {
          font: canvasFont(32),
          color: town.producing ? "#ffffff" : CONFIG.colors.gold,
          width: 160,
          height: 64,
        });
      }
    }
    for (const [id, mesh] of towns) {
      if (live.has(id)) continue;
      world.remove(mesh);
      towns.delete(id);
    }
  }

  function syncShots(board) {
    while (shots.length < board.projectiles.length) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(4, 10, 8),
        new THREE.MeshBasicMaterial({ color: "#f3d27a" }),
      );
      world.add(mesh);
      shots.push(mesh);
    }
    for (let i = 0; i < shots.length; i += 1) {
      const mesh = shots[i];
      const shot = board.projectiles[i];
      mesh.visible = Boolean(shot);
      if (!shot) continue;
      mesh.position.set(shot.x, 14, shot.y);
    }
  }

  function syncSplats(board) {
    while (splats.length < board.splats.length) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
      sprite.scale.set(40, 20, 1);
      world.add(sprite);
      splats.push(sprite);
    }
    for (let i = 0; i < splats.length; i += 1) {
      const sprite = splats[i];
      const splat = board.splats[i];
      if (!splat) {
        sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      const shown = Math.round(splat.amount * 10) / 10;
      const num = shown % 1 === 0 ? String(shown) : shown.toFixed(1);
      const restore = splat.kind === "heal" || splat.kind === "fatigue";
      const text = restore ? "+" : num;
      const key = `${text}:${splat.kind}:${uiFontsReady() ? "1" : "0"}`;
      if (sprite.userData.key !== key) {
        const pad = document.createElement("canvas");
        pad.width = 128;
        pad.height = 64;
        const ctx = pad.getContext("2d");
        ctx.clearRect(0, 0, 128, 64);
        ctx.font = canvasFont(42);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 8;
        ctx.strokeStyle = CONFIG.colors.splatStroke;
        ctx.strokeText(text, 64, 32);
        ctx.fillStyle = splat.kind === "melee"
          ? CONFIG.colors.splatMelee
          : splat.kind === "heal"
            ? CONFIG.colors.splatHeal
            : splat.kind === "fatigue"
              ? CONFIG.colors.splatFatigue
              : CONFIG.colors.splatShoot;
        ctx.fillText(text, 64, 32);
        const tex = new THREE.CanvasTexture(pad);
        if (sprite.material.map) sprite.material.map.dispose();
        sprite.material.map = tex;
        sprite.userData.key = key;
      }
      const fade = Math.max(0, 1 - splat.age / CONFIG.splatLife);
      sprite.material.opacity = fade;
      sprite.position.set(splat.x, 36 + splat.age * 20, splat.y);
    }
  }

  function keepOccupied(board, capital) {
    const sides = [board.player, board.enemy];
    for (let s = 0; s < sides.length; s += 1) {
      const troops = sides[s] ? sides[s].troops : [];
      for (let i = 0; i < troops.length; i += 1) {
        const troop = troops[i];
        if (troop.hp <= 0) continue;
        const reach = CONFIG.capitalRadius + troop.bodyRadius();
        const dx = troop.x - capital.x;
        const dy = troop.y - capital.y;
        if (dx * dx + dy * dy <= reach * reach) return true;
      }
    }
    return false;
  }

  function setKeepFade(keep, faded) {
    const opacity = faded ? 0.35 : 1;
    keep.userData.base.material.opacity = opacity;
    keep.userData.tower.material.opacity = opacity;
    keep.userData.base.material.depthWrite = !faded;
    keep.userData.tower.material.depthWrite = !faded;
    keep.userData.hp.visible = !faded;
  }

  function syncKeeps(board) {
    const max = CONFIG.capitalHP || 1;
    setBar(keeps.player.userData.hp, board.player.capitalHP / max);
    setBar(keeps.enemy.userData.hp, board.enemy.capitalHP / max);
    setKeepFade(keeps.player, keepOccupied(board, keeps.player.userData.capital));
    setKeepFade(keeps.enemy, keepOccupied(board, keeps.enemy.userData.capital));
  }

  function placePad(mesh, box, lift) {
    mesh.position.set(box.x + box.w / 2, lift, box.y + box.h / 2);
    mesh.scale.set(1, 1, 1);
  }

  function syncBuysUi(board) {
    const show = Boolean(board.player) && !board.telescope;
    const over = Boolean(board.winner) || board.status !== "playing";
    while (buyMeshes.length < BUY_UNITS.length) {
      const unit = BUY_UNITS[buyMeshes.length];
      const pad = makePad(80, 64, unit.fill);
      buyMeshes.push(pad);
      hud.add(pad);
      const unlock = makePad(80, 28, "#2a3340");
      unlockMeshes.push(unlock);
      hud.add(unlock);
    }
    for (let i = 0; i < BUY_UNITS.length; i += 1) {
      const unit = BUY_UNITS[i];
      const mesh = buyMeshes[i];
      const unlock = unlockMeshes[i];
      mesh.visible = show;
      if (!show) {
        unlock.visible = false;
        continue;
      }
      const box = board.buyButtonRect(i);
      placePad(mesh, box, 16);
      mesh.scale.set(box.w / 80, 1.15, box.h / 64);
      mesh.userData.face.scale.x = board.southpaw ? -1 : 1;
      const spawn = board.selectedBuyUnit(unit.type);
      const stats = unitStats(spawn);
      const land = unitLandCost(spawn);
      const can = !over && board.player.gold >= stats.cost && board.player.land >= land;
      const lane = board.buyDrag && board.buyDrag.index === i ? board.buyDrag.lane : null;
      const typeSwipe = board.buyDrag && board.buyDrag.index === i
        ? board.buyDrag.variantSwipe
        : null;
      const armed = Boolean(lane || typeSwipe);
      const alt = spawn !== unit.type;
      const badge = variantBadgeFill(spawn);
      const unitBg = buyBgImage(unit.type);
      mesh.material.color.set(badge || unit.fill);
      mesh.material.opacity = can ? 1 : 0.45;
      mesh.material.transparent = true;
      mesh.material.emissive.set(armed ? "#ffffff" : "#000000");
      mesh.material.emissiveIntensity = armed ? 0.22 : 0;
      const label = UNIT_LABELS[spawn] || unit.label;
      const hasVariant = Boolean(UNIT_VARIANTS[unit.type] && UNIT_VARIANTS[unit.type].length);
      const key = `${label}:${stats.cost}:${land}:${can}:${lane || ""}:${typeSwipe || ""}:${badge || ""}:${unitBg ? "bg" : ""}:${hasVariant ? "v" : ""}:${uiFontsReady() ? "1" : "0"}`;
      if (mesh.userData.face.userData.key !== key) {
        setLabel(mesh.userData.face, [
          { text: label, font: canvasFont(34, "bold", "header"), color: alt ? unit.fill : CONFIG.colors.text },
          { text: `${stats.cost} gold`, font: canvasFont(28), color: CONFIG.colors.gold },
          { text: lane === "top" ? "▲ top" : lane === "bottom" ? "▼ bottom" : "▲ / ▼", font: canvasFont(24, "normal"), color: "#9ee8c8" },
        ], {
          width: 256,
          height: 192,
          fill: badge || unit.fill,
          bgImage: unitBg || undefined,
          stroke: can ? "#ffffff" : unit.stroke,
          textOutline: "#000000",
          sideArrows: hasVariant,
          key,
        });
        mesh.userData.face.userData.key = key;
      }
      const showLand = Boolean(alt && land > 0);
      unlock.visible = showLand;
      if (!showLand) continue;
      const ubox = board.variantLandRect(i);
      if (ubox.h <= 0) {
        unlock.visible = false;
        continue;
      }
      placePad(unlock, ubox, 14);
      unlock.scale.set(ubox.w / 80, 1, Math.max(0.4, ubox.h / 28));
      unlock.userData.face.scale.x = board.southpaw ? -1 : 1;
      const canLand = !over && board.player.land >= land;
      unlock.material.opacity = canLand ? 1 : 0.45;
      unlock.material.transparent = true;
      const uKey = `${land}:${canLand}:${uiFontsReady() ? "1" : "0"}`;
      if (unlock.userData.face.userData.key !== uKey) {
        setLabel(unlock.userData.face, [
          { text: `+${land} land`, font: canvasFont(28), color: CONFIG.colors.gold },
        ], {
          width: 256,
          height: 96,
          fill: "#2a3340",
          stroke: unit.stroke,
          textOutline: "#000000",
          key: uKey,
        });
        unlock.userData.face.userData.key = uKey;
      }
    }
  }

  function syncUpgradeUi(board) {
    const show = Boolean(board.player) && !board.telescope;
    const sides = [
      { id: "player", fill: "#1a2a3a", stroke: CONFIG.colors.player },
      { id: "enemy", fill: "#2a1a1a", stroke: CONFIG.colors.enemy },
    ];
    while (upgradeMeshes.length < sides.length) {
      const side = sides[upgradeMeshes.length];
      const pad = makePad(80, 40, side.fill);
      upgradeMeshes.push(pad);
      hud.add(pad);
    }
    for (let i = 0; i < sides.length; i += 1) {
      const side = sides[i];
      const mesh = upgradeMeshes[i];
      mesh.visible = show;
      if (!show) continue;
      const owner = board[side.id];
      if (!owner) {
        mesh.visible = false;
        continue;
      }
      const box = board.upgradeReadoutRect(side.id);
      placePad(mesh, box, 15);
      mesh.scale.set(box.w / 80, 1.1, box.h / 40);
      mesh.userData.face.scale.x = board.southpaw ? -1 : 1;
      mesh.material.opacity = 1;
      mesh.material.transparent = true;
      const lines = owner.upgradeLines();
      const key = `${lines.join("|")}:${side.id}:${uiFontsReady() ? "1" : "0"}`;
      if (mesh.userData.face.userData.key !== key) {
        setLabel(mesh.userData.face, lines.map((text) => ({
          text,
          font: canvasFont(28),
          color: side.stroke,
        })), {
          width: 256,
          height: 128,
          fill: side.fill,
          stroke: side.stroke,
          textOutline: "#0d1218",
          key,
        });
        mesh.userData.face.userData.key = key;
      }
    }
  }

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
  }

  function addPaceInterval(group, lane, sublane, minPaces, maxPaces, color, lift, thickness, opacity) {
    const total = Path.lanePaces(lane);
    if (!(total > 0) || !(maxPaces > minPaces)) return;
    const t0 = Math.max(0, minPaces / total);
    const t1 = Math.min(1, maxPaces / total);
    const pts = Path.worldPoints(lane, sublane);
    const steps = isArcLane(lane) ? Math.max(2, Math.ceil((t1 - t0) * 20)) : 1;
    let prev = null;
    for (let k = 0; k <= steps; k += 1) {
      const t = t0 + ((t1 - t0) * k) / steps;
      const p = Path.pointAt(pts, t);
      if (prev) {
        const mesh = lineMesh(prev.x, prev.y, p.x, p.y, color, lift, thickness);
        mesh.material.transparent = true;
        mesh.material.opacity = opacity;
        group.add(mesh);
      }
      prev = p;
    }
  }

  function syncTerrain(board) {
    const features = board.terrainFeatures || [];
    const fogRegions = board.fogRegions || [];
    const labelsOn = showTerrainLabels(board);
    const key = [
      features.map((f) => `${f.id}:${f.centerPaces}`).join("|"),
      fogRegions.map((r) => `${r.lane}:${r.sublane}:${r.minPaces}:${r.maxPaces}:${r.fogged ? 1 : 0}`).join(";"),
      labelsOn ? "1" : "0",
      uiFontsReady() ? "f1" : "f0",
    ].join("::");
    if (key === terrainKey) return;
    terrainKey = key;
    clearGroup(terrainGroup);
    clearGroup(fogGroup);

    // Darken open row segments with no LOS (not terrain footprints).
    for (let i = 0; i < fogRegions.length; i += 1) {
      const r = fogRegions[i];
      if (!r.fogged) continue;
      const color = isArcLane(r.lane) ? 0x2a2218 : 0x1a2e28;
      addPaceInterval(fogGroup, r.lane, r.sublane, r.minPaces, r.maxPaces, color, 10, 12, 0.85);
    }

    for (let i = 0; i < features.length; i += 1) {
      const f = features[i];
      const total = Path.lanePaces(f.lane);
      if (!(total > 0)) continue;
      const half = f.halfWidthPaces || 0;
      const { color, opacity } = terrainColor(f.kind);
      for (let s = 0; s < f.sublanes.length; s += 1) {
        addPaceInterval(
          terrainGroup,
          f.lane,
          f.sublanes[s],
          f.centerPaces - half,
          f.centerPaces + half,
          color,
          9,
          10,
          opacity,
        );
        if (!labelsOn) continue;
        const mid = Path.pointAt(
          Path.worldPoints(f.lane, f.sublanes[s]),
          Math.max(0, Math.min(1, f.centerPaces / total)),
        );
        const emoji = f.emoji || TERRAIN_EMOJI[f.kind] || "";
        if (emoji) {
          const bill = makeBillboard(28, 28);
          bill.position.set(mid.x, 22, mid.y);
          setBillboard(bill, emoji, {
            font: canvasFont(40),
            color: "#111111",
            width: 64,
            height: 64,
          });
          terrainGroup.add(bill);
        }
      }
    }
  }

  function syncScene(board) {
    uiFontsReady();
    if (!board.player) return;
    if (board.presentLaneCenters) board.presentLaneCenters();
    if (board.refreshHoldSelect) board.refreshHoldSelect();
    fitBoardMetrics(board);
    frameCamera(board);
    syncCenters(board);
    syncHover(board);
    syncTerrain(board);
    syncKeeps(board);
    syncBuysUi(board);
    syncUpgradeUi(board);
    syncTowns(board);
    syncDebugRanges(board);
    syncUnits(board);
    syncShots(board);
    syncSplats(board);
    renderer.render(scene, camera);
    syncGestureHints(board);
  }

  function syncGestureHints(board) {
    if (!gestureHintsEl) return;
    const hints = board.gestureHints;
    const labels = hints && hints.labels ? hints.labels : [];
    while (hintNodes.length < labels.length) {
      const el = document.createElement("span");
      el.className = "gesture-hint";
      gestureHintsEl.appendChild(el);
      hintNodes.push(el);
    }
    const rect = canvas.getBoundingClientRect();
    const stage = gestureHintsEl.parentElement;
    const stageRect = stage ? stage.getBoundingClientRect() : rect;
    world.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    for (let i = 0; i < hintNodes.length; i += 1) {
      const el = hintNodes[i];
      const label = labels[i];
      if (!label) {
        el.style.display = "none";
        continue;
      }
      // Buy/upgrade pads sit a bit above the ground plane; units are ~12.
      const lift = board.buyDrag || board.strategyDrag ? 18 : 14;
      hintScratch.set(label.x, lift, label.y);
      world.localToWorld(hintScratch);
      hintScratch.project(camera);
      if (!Number.isFinite(hintScratch.x) || !Number.isFinite(hintScratch.y)
          || hintScratch.z < -1 || hintScratch.z > 1) {
        el.style.display = "none";
        continue;
      }
      const sx = (hintScratch.x * 0.5 + 0.5) * rect.width + (rect.left - stageRect.left);
      const sy = (-hintScratch.y * 0.5 + 0.5) * rect.height + (rect.top - stageRect.top);
      el.textContent = label.text;
      el.classList.toggle("active", hints.active != null && label.id === hints.active);
      el.style.display = "block";
      el.style.left = `${sx}px`;
      el.style.top = `${sy}px`;
    }
  }

  function frameOverview() {
    if (!CAM_DEBUG) fitOverviewToField();
    camera.position.set(overview.pos.x, overview.pos.y, overview.pos.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(overview.target.x, overview.target.y, overview.target.z);
    paintCamDebug();
  }

  /**
   * Place the overview camera so the lane map fills the viewport.
   * Fits the keeps + lanes (not empty canvas margin), then pushes in a
   * bit more so the standard view reads zoomed-in.
   */
  const overview = {
    pos: { x: CONFIG.canvasWidth / 2, y: 560, z: CONFIG.canvasHeight / 2 + 400 },
    target: { x: CONFIG.canvasWidth / 2, y: 0, z: CONFIG.canvasHeight / 2 },
  };
  const fitScratch = new THREE.Vector3();
  // Same tilt as the old hand-tuned shot: atan2(560, 400) ≈ 54.5° from horizontal.
  const overviewElev = Math.atan2(560, 400);
  const overviewDir = {
    x: 0,
    y: Math.sin(overviewElev),
    z: Math.cos(overviewElev),
  };
  // Contented map bounds (keeps + top band + outer bottom ring), not full canvas.
  const fieldBounds = (() => {
    const outer = Path.bottomRadius(0) + CONFIG.bottomSublaneWidth * 0.5;
    const c = Path.bottomCenter();
    const top = CONFIG.playerCapital.y - CONFIG.topLaneHeight / 2;
    return {
      minX: CONFIG.playerCapital.x - CONFIG.capitalRadius,
      maxX: CONFIG.enemyCapital.x + CONFIG.capitalRadius,
      minZ: Math.min(8, top - 6),
      maxZ: c.y + outer,
    };
  })();
  const fieldCenter = {
    x: (fieldBounds.minX + fieldBounds.maxX) / 2,
    // Bias look-at toward the bottom U so the outer ring stays on screen.
    z: (fieldBounds.minZ + fieldBounds.maxZ) / 2 + 55,
  };

  function playFieldCorners() {
    const { minX, maxX, minZ, maxZ } = fieldBounds;
    const midX = (minX + maxX) / 2;
    const midZ = (minZ + maxZ) / 2;
    return [
      [minX, 0, minZ],
      [maxX, 0, minZ],
      [minX, 0, maxZ],
      [maxX, 0, maxZ],
      [midX, 0, minZ],
      [midX, 0, maxZ],
      [minX, 0, midZ],
      [maxX, 0, midZ],
    ];
  }

  function placeOverview(dist) {
    return {
      pos: {
        x: fieldCenter.x + overviewDir.x * dist,
        y: overviewDir.y * dist,
        z: fieldCenter.z + overviewDir.z * dist,
      },
      target: { x: fieldCenter.x, y: 0, z: fieldCenter.z },
    };
  }

  function fieldFitsNdc(dist, margin) {
    const next = placeOverview(dist);
    camera.position.set(next.pos.x, next.pos.y, next.pos.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(next.target.x, next.target.y, next.target.z);
    camera.updateMatrixWorld(true);
    const corners = playFieldCorners();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < corners.length; i += 1) {
      const [x, y, z] = corners[i];
      fitScratch.set(x, y, z).project(camera);
      if (!Number.isFinite(fitScratch.x) || !Number.isFinite(fitScratch.y)) {
        return false;
      }
      if (fitScratch.z < -1 || fitScratch.z > 1) return false;
      minX = Math.min(minX, fitScratch.x);
      maxX = Math.max(maxX, fitScratch.x);
      minY = Math.min(minY, fitScratch.y);
      maxY = Math.max(maxY, fitScratch.y);
    }
    return minX >= -margin && maxX <= margin && minY >= -margin && maxY <= margin;
  }

  function fitOverviewToField() {
    // Fill the screen; a little overscan so the map reads zoomed-in.
    const margin = 1.02;
    const zoomIn = 0.88;
    let lo = 120;
    let hi = 5000;
    if (!fieldFitsNdc(hi, margin)) hi = 8000;
    for (let i = 0; i < 28; i += 1) {
      const mid = (lo + hi) / 2;
      if (fieldFitsNdc(mid, margin)) hi = mid;
      else lo = mid;
    }
    const next = placeOverview(hi * zoomIn);
    overview.pos.x = next.pos.x;
    overview.pos.y = next.pos.y;
    overview.pos.z = next.pos.z;
    overview.target.x = next.target.x;
    overview.target.y = next.target.y;
    overview.target.z = next.target.z;
    // Keep fog beyond the fitted distance so the map stays clear.
    const dist = Math.hypot(
      overview.pos.x - overview.target.x,
      overview.pos.y - overview.target.y,
      overview.pos.z - overview.target.z,
    );
    scene.fog.near = dist * 1.6;
    scene.fog.far = dist * 3.2;
  }

  // Flip to true to re-enable temp orbit/pan/zoom + on-screen readout.
  const CAM_DEBUG = false;
  let camDrag = null;
  const camDebugEl = document.getElementById("cam-debug-values");
  const camDebugRoot = document.getElementById("cam-debug");
  if (camDebugRoot) camDebugRoot.classList.toggle("hidden", !CAM_DEBUG);

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function paintCamDebug() {
    if (!CAM_DEBUG || !camDebugEl) return;
    const p = overview.pos;
    const t = overview.target;
    camDebugEl.textContent = [
      `camera.position.set(${round1(p.x)}, ${round1(p.y)}, ${round1(p.z)});`,
      `camera.lookAt(${round1(t.x)}, ${round1(t.y)}, ${round1(t.z)});`,
      "",
      `pos    x ${round1(p.x)}  y ${round1(p.y)}  z ${round1(p.z)}`,
      `lookAt x ${round1(t.x)}  y ${round1(t.y)}  z ${round1(t.z)}`,
      `dist   ${round1(Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z))}`,
      `aspect ${round1(camera.aspect)}`,
    ].join("\n");
  }

  function resetOverviewCam() {
    fitOverviewToField();
    paintCamDebug();
  }

  function orbitOverview(dx, dy) {
    const p = overview.pos;
    const t = overview.target;
    const ox = p.x - t.x;
    const oy = p.y - t.y;
    const oz = p.z - t.z;
    const radius = Math.hypot(ox, oy, oz) || 1;
    let theta = Math.atan2(ox, oz);
    let phi = Math.acos(Math.min(1, Math.max(-1, oy / radius)));
    theta -= dx * 0.005;
    phi -= dy * 0.005;
    phi = Math.min(Math.PI * 0.92, Math.max(0.08, phi));
    p.x = t.x + radius * Math.sin(phi) * Math.sin(theta);
    p.y = t.y + radius * Math.cos(phi);
    p.z = t.z + radius * Math.sin(phi) * Math.cos(theta);
  }

  function panOverview(dx, dy) {
    const p = overview.pos;
    const t = overview.target;
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(t.x, t.y, t.z);
    camera.updateMatrixWorld(true);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const scale = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) * 0.0015;
    const mx = (-dx * right.x + dy * up.x) * scale;
    const my = (-dx * right.y + dy * up.y) * scale;
    const mz = (-dx * right.z + dy * up.z) * scale;
    p.x += mx;
    p.y += my;
    p.z += mz;
    t.x += mx;
    t.y += my;
    t.z += mz;
  }

  function zoomOverview(deltaY) {
    const p = overview.pos;
    const t = overview.target;
    const ox = p.x - t.x;
    const oy = p.y - t.y;
    const oz = p.z - t.z;
    const dist = Math.hypot(ox, oy, oz) || 1;
    const next = Math.min(3500, Math.max(120, dist * (deltaY > 0 ? 1.08 : 0.92)));
    const k = next / dist;
    p.x = t.x + ox * k;
    p.y = t.y + oy * k;
    p.z = t.z + oz * k;
  }

  function bindCamDebug(board) {
    if (!CAM_DEBUG || !camDebugRoot) return;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (board.telescope) return;
      const orbit = event.button === 2 && !event.shiftKey;
      const pan = event.button === 1 || (event.button === 2 && event.shiftKey);
      if (!orbit && !pan) return;
      camDrag = {
        mode: orbit ? "orbit" : "pan",
        x: event.clientX,
        y: event.clientY,
      };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!camDrag || board.telescope) return;
      const dx = event.clientX - camDrag.x;
      const dy = event.clientY - camDrag.y;
      camDrag.x = event.clientX;
      camDrag.y = event.clientY;
      if (camDrag.mode === "orbit") orbitOverview(dx, dy);
      else panOverview(dx, dy);
      frameOverview();
      renderer.render(scene, camera);
    });
    canvas.addEventListener("pointerup", () => {
      camDrag = null;
    });
    canvas.addEventListener("pointercancel", () => {
      camDrag = null;
    });
    canvas.addEventListener("wheel", (event) => {
      if (board.telescope) return;
      event.preventDefault();
      zoomOverview(event.deltaY);
      frameOverview();
      renderer.render(scene, camera);
    }, { passive: false });
    window.addEventListener("keydown", (event) => {
      if (event.key === "r" || event.key === "R") {
        if (event.target && /input|textarea/i.test(event.target.tagName)) return;
        resetOverviewCam();
        frameOverview();
        renderer.render(scene, camera);
      }
    });
  }

  resize();
  frameOverview();
  syncCenters({ topCenter: 0.5, bottomCenter: 0.5 });
  renderer.render(scene, camera);
  if (window.ResizeObserver && canvas.parentElement) {
    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas.parentElement);
  }

  return {
    sync(board) {
      if (CAM_DEBUG && camDebugRoot) {
        camDebugRoot.classList.toggle("hidden", Boolean(board.telescope));
      }
      if (CAM_DEBUG && !board._camDebugBound) {
        board._camDebugBound = true;
        bindCamDebug(board);
      }
      syncScene(board);
    },
    resize,
    pointerToGame,
    logicalToGame,
    lastPickedTroopId: () => lastPickedTroopId,
  };
}
