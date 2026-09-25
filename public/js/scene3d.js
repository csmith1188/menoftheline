import * as THREE from "three";
import { CONFIG } from "../shared/config.js";
import { BUY_UNITS, UNIT_LABELS, UNIT_VARIANTS, unitStats } from "../shared/units.js";
import { Path, quarterSegments } from "../shared/path.js";

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
    ctx.font = row.font || opts.font || "bold 36px Trebuchet MS, sans-serif";
    ctx.fillStyle = row.color || opts.color || "#e8eef6";
    ctx.fillText(row.text, width / 2, step * (i + 1));
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

function orderColor(order) {
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

function lineMesh(x1, y1, x2, y2, color, lift) {
  const dx = x2 - x1;
  const dz = y2 - y1;
  const len = Math.hypot(dx, dz) || 1;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(len, 3, 8),
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.bg);
  scene.fog = new THREE.Fog(CONFIG.colors.bg, 1400, 2800);

  const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
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

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 1800),
    std("#102018"),
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

  const topRows = [];
  for (let s = 0; s < CONFIG.topSublaneCount; s += 1) {
    const pts = Path.worldPoints("top", s);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(span, 2.5, CONFIG.topSublaneWidth * 0.72),
      std(CONFIG.colors.topSublane),
    );
    mesh.position.set((pts[0].x + pts[1].x) / 2, 9, pts[0].y);
    mesh.receiveShadow = true;
    world.add(mesh);
    topRows.push(mesh);
  }

  const center = Path.bottomCenter();
  const bottomRows = [];
  for (let s = 0; s < CONFIG.bottomSublaneCount; s += 1) {
    const radius = Path.bottomRadius(s);
    const half = CONFIG.bottomSublaneWidth * 0.55;
    const geo = new THREE.RingGeometry(
      Math.max(1, radius - half),
      radius + half,
      72,
      1,
      Math.PI,
      Math.PI,
    );
    const mesh = new THREE.Mesh(geo, std(CONFIG.colors.bottomSublane));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(center.x, 6 + s * 0.35, center.y);
    mesh.receiveShadow = true;
    world.add(mesh);
    bottomRows.push(mesh);
  }

  const covers = quarterSegments();
  for (let i = 0; i < covers.length; i += 1) {
    const seg = covers[i];
    const mesh = lineMesh(seg.x1, seg.y1, seg.x2, seg.y2, seg.color, 11);
    mesh.material.transparent = true;
    mesh.material.opacity = 0.45;
    world.add(mesh);
  }

  const topCenter = lineMesh(left.x, left.y - CONFIG.topLaneHeight / 2, left.x, left.y + CONFIG.topLaneHeight / 2, CONFIG.colors.laneCenter, 12);
  world.add(topCenter);
  const bottomCenter = lineMesh(center.x, center.y, center.x + 40, center.y, CONFIG.colors.laneCenter, 12);
  world.add(bottomCenter);

  const keeps = {
    player: makeKeep("player"),
    enemy: makeKeep("enemy"),
  };
  world.add(keeps.player, keeps.enemy);

  const hud = new THREE.Group();
  world.add(hud);
  const buyMeshes = [];
  const unlockMeshes = [];

  const units = new Map();
  const towns = new Map();
  const shots = [];
  const splats = [];

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let lastPickedTroopId = null;

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
      if (lane === "bottom") {
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
      // Toward the camera raises the lane; past it lowers it. Bottom needs a lower frame.
      const pull = lane === "bottom" ? -24 : 28;
      camera.position.set(x + px * dist, height, z + pz * dist);
      camera.up.set(0, 1, 0);
      camera.lookAt(x + px * pull, 12, z + pz * pull);
      return;
    }
    frameOverview();
  }

  function syncCenters(board) {
    const t = board.topCenter;
    const x = left.x + span * t;
    topCenter.position.x = x;
    const theta = Math.PI * (1 - board.bottomCenter);
    const rIn = Path.bottomRadius(CONFIG.bottomSublaneCount - 1) - 10;
    const rOut = Path.bottomRadius(0) + 10;
    const x1 = center.x + rIn * Math.cos(theta);
    const y1 = center.y + rIn * Math.sin(theta);
    const x2 = center.x + rOut * Math.cos(theta);
    const y2 = center.y + rOut * Math.sin(theta);
    const dx = x2 - x1;
    const dz = y2 - y1;
    const len = Math.hypot(dx, dz) || 1;
    bottomCenter.scale.x = len / 40;
    bottomCenter.position.set((x1 + x2) / 2, 12, (y1 + y2) / 2);
    bottomCenter.rotation.y = Math.atan2(-dz, dx);
  }

  function syncHover(board) {
    for (let i = 0; i < topRows.length; i += 1) topRows[i].material.emissive.set("#000000");
    for (let i = 0; i < bottomRows.length; i += 1) bottomRows[i].material.emissive.set("#000000");
    if (!board.drag || !board.drag.troop || board.drag.troop.hp <= 0) return;
    const troop = board.drag.troop;
    const row = Path.closestSublane(
      troop.side.id,
      troop.lane,
      troop.progress,
      { x: board.drag.hx, y: board.drag.hy },
    );
    const mesh = troop.lane === "top" ? topRows[row] : bottomRows[row];
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
    mesh.rotation.set(0, Math.atan2(tan.x, tan.y), 0);
    mesh.userData.hp.rotation.y = -mesh.rotation.y;
    mesh.userData.fat.rotation.y = -mesh.rotation.y;
    const color = troop.flash > 0
      ? "#fff4d2"
      : troop.side.id === "player" ? CONFIG.colors.player : CONFIG.colors.enemy;
    mesh.userData.mat.color.set(troop.broken ? "#8d97a3" : color);
    mesh.userData.plate.visible = Boolean(troop.alternate);
    const shown = troop.givenOrder === undefined ? troop.order : troop.givenOrder;
    const ordered = shown === "halt" || shown === "reform"
      || shown === "charge" || shown === "fallback"
      || shown === "retreat";
    const shellScale = ordered ? 1.28 : 1.12;
    const stroke = orderColor(shown);
    const shells = mesh.userData.outlines;
    for (let i = 0; i < shells.length; i += 1) {
      shells[i].material.color.set(stroke);
      shells[i].scale.set(shellScale, shellScale, shellScale);
    }
    const selected = board.inspectedLineIds && board.inspectedLineIds[troop.id];
    mesh.userData.mark.visible = Boolean(selected);
    mesh.userData.mark.material.color.set(board.inspectedId === troop.id ? "#ff3b30" : "#ff8a84");
    const maxHp = troop.maxHP();
    setBar(mesh.userData.hp, maxHp > 0 ? troop.hp / maxHp : 0);
    const maxFatigue = troop.maxFatigue || 100;
    setBar(mesh.userData.fat, maxFatigue > 0 ? (troop.fatigue || 0) / maxFatigue : 0);
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
        mesh.userData.halo = halo;
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
      const kind = town.upgradeKind();
      const affordable = town.owner === "player" && board.player && board.player.canBuyUpgrade(kind);
      mesh.userData.halo.visible = Boolean(affordable);
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
      const text = shown % 1 === 0 ? String(shown) : shown.toFixed(1);
      const key = `${text}:${splat.kind}`;
      if (sprite.userData.key !== key) {
        const pad = document.createElement("canvas");
        pad.width = 128;
        pad.height = 64;
        const ctx = pad.getContext("2d");
        ctx.clearRect(0, 0, 128, 64);
        ctx.font = "bold 42px Trebuchet MS, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 8;
        ctx.strokeStyle = CONFIG.colors.splatStroke;
        ctx.strokeText(text, 64, 32);
        ctx.fillStyle = splat.kind === "melee" ? CONFIG.colors.splatMelee : CONFIG.colors.splatShoot;
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
    const showUnlock = board.player && board.player.land >= CONFIG.variantUnlockCost;
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
      const can = !over && board.player.gold >= stats.cost;
      const lane = board.buyDrag && board.buyDrag.index === i ? board.buyDrag.lane : null;
      const alt = spawn !== unit.type;
      mesh.material.color.set(alt ? "#ffffff" : unit.fill);
      mesh.material.opacity = can ? 1 : 0.45;
      mesh.material.transparent = true;
      mesh.material.emissive.set(lane ? "#ffffff" : "#000000");
      mesh.material.emissiveIntensity = lane ? 0.22 : 0;
      const label = UNIT_LABELS[spawn] || unit.label;
      const key = `${label}:${stats.cost}:${can}:${lane || ""}:${alt}`;
      if (mesh.userData.face.userData.key !== key) {
        setLabel(mesh.userData.face, [
          { text: label, font: "bold 34px Trebuchet MS, sans-serif", color: alt ? unit.fill : CONFIG.colors.text },
          { text: `${stats.cost} gold`, font: "bold 28px Trebuchet MS, sans-serif", color: CONFIG.colors.gold },
          { text: lane === "top" ? "▲ top" : lane === "bottom" ? "▼ bottom" : "▲ / ▼", font: "24px Trebuchet MS, sans-serif", color: "#9ee8c8" },
        ], {
          width: 256,
          height: 192,
          fill: alt ? "#ffffff" : unit.fill,
          stroke: can ? "#ffffff" : unit.stroke,
          key,
        });
        mesh.userData.face.userData.key = key;
      }
      const variant = UNIT_VARIANTS[unit.type];
      const needUnlock = Boolean(showUnlock && variant && !board.player.unlockedVariants[variant]);
      unlock.visible = needUnlock;
      if (!needUnlock) continue;
      const ubox = board.variantUnlockRect(i);
      if (ubox.h <= 0) {
        unlock.visible = false;
        continue;
      }
      placePad(unlock, ubox, 14);
      unlock.scale.set(ubox.w / 80, 1, Math.max(0.4, ubox.h / 28));
      unlock.userData.face.scale.x = board.southpaw ? -1 : 1;
      const uKey = `${CONFIG.variantUnlockCost}:${over}`;
      if (unlock.userData.face.userData.key !== uKey) {
        setLabel(unlock.userData.face, [
          { text: `${CONFIG.variantUnlockCost} land`, font: "bold 28px Trebuchet MS, sans-serif", color: CONFIG.colors.gold },
        ], { width: 256, height: 96, fill: "#2a3340", stroke: unit.stroke, key: uKey });
        unlock.userData.face.userData.key = uKey;
      }
    }
  }

  function syncScene(board) {
    if (!board.player) return;
    if (board.refreshHoldSelect) board.refreshHoldSelect();
    fitBoardMetrics(board);
    frameCamera(board);
    syncCenters(board);
    syncHover(board);
    syncKeeps(board);
    syncBuysUi(board);
    syncTowns(board);
    syncUnits(board);
    syncShots(board);
    syncSplats(board);
    renderer.render(scene, camera);
  }

  function frameOverview() {
    camera.position.set(overview.pos.x, overview.pos.y, overview.pos.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(overview.target.x, overview.target.y, overview.target.z);
    paintCamDebug();
  }

  // Tuned overview (multiples of 10). Same x on pos/lookAt keeps view square to the top lane.
  const overviewDefaults = () => ({
    pos: {
      x: CONFIG.canvasWidth / 2, // 480
      y: 680,
      z: CONFIG.canvasHeight + 260, // 880
    },
    target: {
      x: CONFIG.canvasWidth / 2, // 480
      y: 0,
      z: CONFIG.canvasHeight - 240, // 380
    },
  });
  const overview = overviewDefaults();
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
    ].join("\n");
  }

  function resetOverviewCam() {
    const next = overviewDefaults();
    overview.pos.x = next.pos.x;
    overview.pos.y = next.pos.y;
    overview.pos.z = next.pos.z;
    overview.target.x = next.target.x;
    overview.target.y = next.target.y;
    overview.target.z = next.target.z;
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
