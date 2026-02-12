/* =========================================================
   Agentic Twins — ASEAN Sea Ports Network (Ship Sprite)
   - Same UX as your Air demo: Disrupt / Correct / Normal / Add PH / Add HK / Hub HK
   - Great-circle sea lanes between ports (all-to-all)
   - Disrupt/Correct: pause SG ↔ TH; reroute via VN
   - Add Ports: PH (Manila), HK (Hong Kong)
   - Hub HK: star network (everyone <-> HK)
   - Uses container_ship_topview.png as moving sprite
   ========================================================= */

const STYLE_URL = "style.json";

// ASEAN view
const MAP_INIT = { center: [110, 10], zoom: 4.5, minZoom: 3, maxZoom: 8.5 };

// Asset (put this PNG in repo root with this exact name)
const SHIP_IMG_SRC = "container_ship_topview.png";

// --- Sprite size control ---
const SHIP_SIZE_MULT = 1.25; // increase if you want bigger ships (e.g., 1.6)

// --- Simple maritime assumptions (for the dashboard) ---
const SHIP_CAPACITY_TEU = 2200;      // per voyage (demo assumption)
const SHIP_SPEED_KMPH = 33;          // ~18 knots
const FUEL_BURN_TON_PER_KM = 0.010;  // demo: tons per km

// Ports (lon, lat) — you can edit these names/coords freely
const NODES = {
  SG: { name: "Port of Singapore",         lon: 103.8198, lat:  1.3521 },
  TH: { name: "Laem Chabang (Thailand)",   lon: 100.8810, lat: 13.0890 },
  VN: { name: "Hai Phong (Vietnam)",       lon: 106.6830, lat: 20.8440 },
  ID: { name: "Tanjung Priok (Indonesia)", lon: 106.8850, lat: -6.1040 },
  JP: { name: "Port of Tokyo (Japan)",     lon: 139.7800, lat: 35.6300 }
};

// Add-on ports
const NEW_PORTS = {
  PH: { name: "Manila (Philippines)", lon: 120.9842, lat: 14.5995 },
  HK: { name: "Hong Kong",            lon: 114.1694, lat: 22.3193 }
};

// ---------- Utilities
function allPairs(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) out.push([keys[i], keys[j]]);
  }
  return out;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- Map init
const map = new maplibregl.Map({
  container: "map",
  style: STYLE_URL,
  center: MAP_INIT.center,
  zoom: MAP_INIT.zoom,
  minZoom: MAP_INIT.minZoom,
  maxZoom: MAP_INIT.maxZoom,
  attributionControl: true
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");

// ---------- Chat & narration
const msgs = document.getElementById("msgs");
const input = document.getElementById("chatInput");
const send = document.getElementById("chatSend");
const muteBtn = document.getElementById("muteBtn");
const clearBtn = document.getElementById("clearBtn");
const synth = window.speechSynthesis;

let MUTED = false, VOICE = null;

function pushMsg(t, kind = "system") {
  const d = document.createElement("div");
  d.className = `msg ${kind}`;
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  d.innerHTML = `${escapeHTML(t)}<small>${stamp}</small>`;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight + 200;
}
function speak(line) {
  if (!synth) return;
  if (MUTED) { try { synth.cancel(); } catch (_) {} return; }
  try { synth.cancel(); } catch (_) {}

  const u = new SpeechSynthesisUtterance(String(line));
  const voices = synth.getVoices();

  if (!VOICE && voices && voices.length) {
    VOICE = voices.find(v => /en-|English/i.test(v.lang)) || voices[0];
  }
  if (!VOICE) {
    synth.onvoiceschanged = () => {
      if (!VOICE) {
        const vs = synth.getVoices();
        VOICE = vs.find(v => /en-|English/i.test(v.lang)) || vs[0];
      }
    };
  }
  if (VOICE) u.voice = VOICE;
  u.rate = 0.96;
  u.pitch = 1.0;
  u.onstart = () => { if (MUTED) try { synth.cancel(); } catch (_) {} };
  try { synth.speak(u); } catch (_) {}
}

send?.addEventListener("click", () => handleCommand((input.value || "").trim()));
input?.addEventListener("keydown", (e) => { if (e.key === "Enter") handleCommand((input.value || "").trim()); });
clearBtn?.addEventListener("click", () => { msgs.innerHTML = ""; });
muteBtn?.addEventListener("click", () => {
  MUTED = !MUTED;
  muteBtn.textContent = MUTED ? "🔇 Unmute" : "🔊 Mute";
  if (MUTED && synth) { try { synth.cancel(); } catch (_) {} }
});

// UI buttons
document.getElementById("btnDisrupt")?.addEventListener("click", () => handleCommand("disrupt"));
document.getElementById("btnCorrect")?.addEventListener("click", () => handleCommand("correct"));
document.getElementById("btnNormal") ?.addEventListener("click", () => handleCommand("normal"));
document.getElementById("btnAddPH")  ?.addEventListener("click", () => handleCommand("add ph"));
document.getElementById("btnAddHK")  ?.addEventListener("click", () => handleCommand("add hk"));
document.getElementById("btnHubHK")  ?.addEventListener("click", () => handleCommand("hub hk"));

// ---------- Routes (GeoJSON) + cache
function greatCircle(a, b, n = 160) {
  const line = turf.greatCircle([a.lon, a.lat], [b.lon, b.lat], { npoints: n });
  return line.geometry.coordinates;
}

let currentNodes = { ...NODES };

let ROUTES = [];
let ROUTE_MAP = new Map();

function rebuildRoutes(nodeSet) {
  ROUTES = [];
  ROUTE_MAP.clear();

  const keys = Object.keys(nodeSet);
  for (const [A, B] of allPairs(keys)) {
    const a = nodeSet[A], b = nodeSet[B];
    const coords = greatCircle(a, b, 160);

    ROUTES.push({
      type: "Feature",
      properties: { id: `${A}-${B}`, A, B },
      geometry: { type: "LineString", coordinates: coords }
    });

    ROUTE_MAP.set(`${A}-${B}`, coords);
    ROUTE_MAP.set(`${B}-${A}`, [...coords].reverse());
  }
}

// direction-specific polyline lookup; computes if missing
function getArcCoords(A, B) {
  const cached = ROUTE_MAP.get(`${A}-${B}`);
  if (cached) return cached;

  const a = currentNodes[A], b = currentNodes[B];
  if (!a || !b) return [];

  const coords = greatCircle(a, b, 160);
  ROUTE_MAP.set(`${A}-${B}`, coords);
  ROUTE_MAP.set(`${B}-${A}`, [...coords].reverse());
  return coords;
}

// Build ONLY the routes you specify
function rebuildRoutesFromPairs(pairs) {
  ROUTES = [];
  ROUTE_MAP.clear();
  for (const [A, B] of pairs) {
    const coords = getArcCoords(A, B);
    if (!coords || coords.length < 2) continue;
    ROUTES.push({
      type: "Feature",
      properties: { id: `${A}-${B}`, A, B },
      geometry: { type: "LineString", coordinates: coords }
    });
  }
}

// Layers
function ensureRouteLayers() {
  const baseFC = { type: "FeatureCollection", features: ROUTES };

  if (!map.getSource("routes")) map.addSource("routes", { type: "geojson", data: baseFC });
  else map.getSource("routes").setData(baseFC);

  if (!map.getLayer("routes-halo")) {
    map.addLayer({
      id: "routes-halo",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#7aa6ff", "line-opacity": 0.18, "line-width": 4.0, "line-blur": 1.6 }
    });
  }

  if (!map.getLayer("routes-glow")) {
    map.addLayer({
      id: "routes-glow",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#44e9ff", "line-width": 2.0, "line-opacity": 0.35, "line-blur": 0.9 }
    }, "routes-halo");
  }

  if (!map.getLayer("routes-base")) {
    map.addLayer({
      id: "routes-base",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 5, 0.9, 8, 1.4],
        "line-opacity": 0.95
      }
    }, "routes-glow");
  }

  // alert (red)
  if (!map.getSource("alert")) map.addSource("alert", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  if (!map.getLayer("alert-red")) {
    map.addLayer({
      id: "alert-red",
      type: "line",
      source: "alert",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff6b6b", "line-opacity": 0.98, "line-width": 4.8 }
    });
  }

  // fix (green)
  if (!map.getSource("fix")) map.addSource("fix", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  if (!map.getLayer("fix-green")) {
    map.addLayer({
      id: "fix-green",
      type: "line",
      source: "fix",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#00d08a", "line-opacity": 0.98, "line-width": 5.8 }
    });
  }

  try { map.moveLayer("fix-green"); } catch (_) {}
}

function setAlert(ids) {
  const feats = ids.map(id => {
    const coords = ROUTE_MAP.get(id) || ROUTE_MAP.get(id.split("-").reverse().join("-"));
    return { type: "Feature", properties: { id }, geometry: { type: "LineString", coordinates: coords || [] } };
  });
  map.getSource("alert")?.setData({ type: "FeatureCollection", features: feats });
}
function clearAlert() { map.getSource("alert")?.setData({ type: "FeatureCollection", features: [] }); }

function setFix(ids) {
  const feats = ids.map(id => {
    const coords = ROUTE_MAP.get(id) || ROUTE_MAP.get(id.split("-").reverse().join("-"));
    return { type: "Feature", properties: { id }, geometry: { type: "LineString", coordinates: coords || [] } };
  });
  map.getSource("fix")?.setData({ type: "FeatureCollection", features: feats });
}
function clearFix() { map.getSource("fix")?.setData({ type: "FeatureCollection", features: [] }); }

// ---------- Ships (canvas overlay)
let overlay = null, ctx = null, SHIP_IMG = null, SHIP_READY = false;

function ensureCanvas() {
  overlay = document.getElementById("shipsCanvas");
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.id = "shipsCanvas";
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2;";
    map.getContainer().appendChild(overlay);
  }
  ctx = overlay.getContext("2d");
  resizeCanvas();
}
function resizeCanvas() {
  if (!overlay) return;
  const base = map.getCanvas();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = base.clientWidth * dpr;
  overlay.height = base.clientHeight * dpr;
  overlay.style.width = base.clientWidth + "px";
  overlay.style.height = base.clientHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);

function prj(lon, lat) { return map.project({ lng: lon, lat: lat }); }

// ship struct: {id, A, B, path, seg, t, speed, paused, affected}
let SHIPS = [];

function spawnShip(id, A, B) {
  const coords = getArcCoords(A, B);
  if (!coords || coords.length < 2) return;

  SHIPS.push({
    id, A, B,
    path: coords,
    seg: 0,
    t: Math.random() * 0.6,
    speed: 0.62 + Math.random() * 0.35,
    paused: false,
    affected: false
  });
}

function buildShipsForNodes(nodeSet) {
  SHIPS.length = 0;
  const keys = Object.keys(nodeSet);
  let idx = 1;
  for (const [A, B] of allPairs(keys)) {
    spawnShip(`V${idx++}`, A, B);
    spawnShip(`V${idx++}`, B, A);
  }
}

function buildShipsForPairs(pairs) {
  SHIPS.length = 0;
  let idx = 1;
  for (const [A, B] of pairs) {
    spawnShip(`V${idx++}`, A, B);
    spawnShip(`V${idx++}`, B, A);
  }
}

function drawShipAt(p, theta) {
  const z = map.getZoom();
  const baseAtZoom = (z <= 4) ? 42 : (z >= 7 ? 70 : 42 + (70 - 42) * ((z - 4) / (7 - 4)));
  const W = baseAtZoom * SHIP_SIZE_MULT;
  const H = W;

  // soft shadow
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(theta);
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(0, H * 0.18, W * 0.42, H * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (SHIP_READY) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(theta);

    // glow
    ctx.shadowColor = "rgba(255,255,255,0.55)";
    ctx.shadowBlur = 18;

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 1.05;
    ctx.drawImage(SHIP_IMG, -W / 2, -H / 2, W, H);

    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  } else {
    // fallback triangle
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(theta);
    ctx.fillStyle = "#d7c099";
    ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(10, 14); ctx.lineTo(-10, 14); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function advanceShip(V, dt) {
  if (V.paused) return;

  const pxPerSec = 70 * V.speed * (0.95 + (map.getZoom() - 4) * 0.18);

  const a = V.path[V.seg];
  const b = V.path[V.seg + 1] || V.path[V.seg];
  const aP = prj(a[0], a[1]);
  const bP = prj(b[0], b[1]);

  const segLen = Math.max(1, Math.hypot(bP.x - aP.x, bP.y - aP.y));
  let step = (pxPerSec * dt) / segLen;
  step = Math.max(step, 0.005);

  V.t += step;

  while (V.t >= 1) {
    V.seg += 1;
    V.t -= 1;
    if (V.seg >= V.path.length - 1) {
      V.seg = 0;
      V.t = Math.random() * 0.2;
      break;
    }
  }
}

function drawShips() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const now = performance.now() / 1000;

  for (const V of SHIPS) {
    const a = V.path[V.seg];
    const b = V.path[V.seg + 1] || a;

    const aP = prj(a[0], a[1]);
    const bP = prj(b[0], b[1]);

    const bob = Math.sin(now * 1.2 + (V.id.charCodeAt(0) % 7)) * 1.4;
    const x = aP.x + (bP.x - aP.x) * V.t;
    const y = aP.y + (bP.y - aP.y) * V.t + bob;

    let bearing = turf.bearing([a[0], a[1]], [b[0], b[1]]);
    let theta = (bearing * Math.PI) / 180;

    // Sprite facing correction (90°). If it looks wrong, change sign or remove.
    theta += Math.PI / 2;

    drawShipAt({ x, y }, theta);
  }
}

// animation loop
let __lastTS = performance.now();
function tick() {
  if (ctx) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - __lastTS) / 1000);
    __lastTS = now;
    for (const V of SHIPS) advanceShip(V, dt);
    drawShips();
  }
  requestAnimationFrame(tick);
}

// ---------- Metrics helpers
function pathLengthKm(coords) {
  if (!coords || coords.length < 2) return 0;
  const feature = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
  return turf.length(feature, { units: "kilometers" }) || 0;
}

// ---------- Stats table
function renderStats() {
  const table = document.querySelector("#statsTable");
  if (!table) return;

  table.innerHTML = `
    <thead>
      <tr>
        <th>Port</th>
        <th>Voyages</th>
        <th class="pos">Active</th>
        <th class="neg">Paused</th>
        <th>TEU</th>
        <th>Time (hrs)</th>
        <th>Fuel (t)</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  const keys = Object.keys(currentNodes);

  const rows = {};
  for (const k of keys) {
    rows[k] = {
      label: currentNodes[k].name,
      voyages: 0, active: 0, paused: 0,
      teu: 0, time_h: 0, fuel_t: 0
    };
  }

  for (const V of SHIPS) {
    const A = V.A, B = V.B;
    if (!rows[A] || !rows[B]) continue;

    rows[A].voyages++; rows[B].voyages++;

    if (V.paused) {
      rows[A].paused++; rows[B].paused++;
      continue;
    } else {
      rows[A].active++; rows[B].active++;
    }

    const distKm = pathLengthKm(V.path);
    const timeHr = distKm / SHIP_SPEED_KMPH;
    const fuelTon = FUEL_BURN_TON_PER_KM * distKm;

    rows[A].teu += SHIP_CAPACITY_TEU;
    rows[B].teu += SHIP_CAPACITY_TEU;

    rows[A].time_h += timeHr;
    rows[B].time_h += timeHr;

    rows[A].fuel_t += fuelTon;
    rows[B].fuel_t += fuelTon;
  }

  for (const k of keys) {
    const r = rows[k];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHTML(r.label)}</td>
      <td>${r.voyages}</td>
      <td class="pos">+${r.active}</td>
      <td class="neg">-${r.paused}</td>
      <td>${r.teu.toFixed(0)}</td>
      <td>${r.time_h.toFixed(1)}</td>
      <td>${r.fuel_t.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- Scenarios
let DISRUPTED = false;

// Disrupt SG ↔ TH
const DISRUPT_PAIR = ["SG", "TH"];
// Reroute via VN: SG → VN → TH
const REROUTE_PATH = [["SG", "VN"], ["VN", "TH"]];

function startDisrupt() {
  if (DISRUPTED) { pushMsg("Disruption is already active."); return; }
  DISRUPTED = true;

  const [A, B] = DISRUPT_PAIR;

  setAlert([`${A}-${B}`]);
  clearFix();

  for (const V of SHIPS) {
    const ab = [V.A, V.B].sort().join("-");
    const t = DISRUPT_PAIR.slice().sort().join("-");
    if (ab === t) { V.paused = true; V.affected = true; }
  }

  renderStats();
  pushMsg(`⚠️ Disruption: ${currentNodes[A].name} ↔ ${currentNodes[B].name} corridor restricted. Affected vessels paused.`);
  speak("Disruption. A critical sea corridor is restricted. Affected vessels paused.");
}

function applyCorrect() {
  if (!DISRUPTED) { pushMsg("No active disruption. Click Disrupt first."); return; }

  setFix(REROUTE_PATH.map(p => p.join("-")));
  clearAlert();

  const [A, B] = DISRUPT_PAIR;

  // Build combined polyline for forward A -> ... -> B
  const forward = [];
  for (let i = 0; i < REROUTE_PATH.length; i++) {
    const [from, to] = REROUTE_PATH[i];
    const seg = getArcCoords(from, to);
    if (!seg || seg.length < 2) continue;
    if (i === 0) forward.push(...seg);
    else forward.push(...seg.slice(1));
  }
  const backward = [...forward].reverse();

  for (const V of SHIPS) {
    if (!V.affected) continue;

    if (V.A === A && V.B === B) {
      V.path = forward; V.seg = 0; V.t = 0;
    } else if (V.A === B && V.B === A) {
      V.path = backward; V.seg = 0; V.t = 0;
    }
    V.paused = false;
  }

  renderStats();
  pushMsg(`✅ Correction applied: rerouting via ${currentNodes["VN"].name} (green) and resuming voyages.`);
  speak("Correction applied. Rerouting via an alternate hub and resuming voyages.");
}

function backToNormal() {
  DISRUPTED = false;
  clearAlert(); clearFix();

  rebuildRoutes(currentNodes);
  ensureRouteLayers();
  buildShipsForNodes(currentNodes);

  renderStats();
  pushMsg("Normal operations resumed. All sea lanes open.");
  speak("Normal operations resumed. All sea lanes open.");
}

function applyHubHK() {
  // Ensure HK exists
  if (!currentNodes.HK) currentNodes = { ...currentNodes, HK: NEW_PORTS.HK };

  DISRUPTED = false;
  clearAlert(); clearFix();

  // Star topology: everyone <-> HK
  const keys = Object.keys(currentNodes);
  const pairs = [];
  for (const K of keys) {
    if (K === "HK") continue;
    pairs.push([K, "HK"]);
  }

  rebuildRoutesFromPairs(pairs);
  ensureRouteLayers();
  buildShipsForPairs(pairs);

  if (typeof window.__upsertPorts === "function") window.__upsertPorts();

  const b = new maplibregl.LngLatBounds();
  Object.values(currentNodes).forEach(c => b.extend([c.lon, c.lat]));
  map.fitBounds(b, { padding: { top: 60, left: 60, right: 320, bottom: 60 }, duration: 900, maxZoom: 5.6 });

  renderStats();
  pushMsg("🟡 Hub HK mode: all ports route via Hong Kong.");
  speak("Hub Hong Kong mode active.");
}

function addPortByCode(code) {
  const CODE = (code || "").toUpperCase();
  const node = NEW_PORTS[CODE];
  if (!node) { pushMsg(`Unknown code: ${code}`); return; }
  if (currentNodes[CODE]) { pushMsg(`${node.name} is already added.`); return; }

  currentNodes = { ...currentNodes, [CODE]: node };

  rebuildRoutes(currentNodes);
  ensureRouteLayers();
  buildShipsForNodes(currentNodes);

  if (typeof window.__upsertPorts === "function") window.__upsertPorts();

  const b = new maplibregl.LngLatBounds();
  Object.values(currentNodes).forEach(c => b.extend([c.lon, c.lat]));
  map.fitBounds(b, { padding: { top: 60, left: 60, right: 320, bottom: 60 }, duration: 1000, maxZoom: 5.8 });

  renderStats();
  pushMsg(`🆕 Added ${node.name}. New sea lanes to all ports are now active.`);
  speak(`${node.name} added. New sea lanes active.`);
}

function handleCommand(raw) {
  const cmd = (raw || "").trim();
  if (!cmd) return;
  pushMsg(cmd, "user");
  if (input) input.value = "";

  const k = cmd.toLowerCase();

  if (k === "disrupt") startDisrupt();
  else if (k === "correct") applyCorrect();
  else if (k === "normal") backToNormal();
  else if (k === "add ph" || k === "addph") addPortByCode("PH");
  else if (k === "add hk" || k === "addhk") addPortByCode("HK");
  else if (k === "hub hk" || k === "hubhk") applyHubHK();
  else pushMsg("Valid commands: Disrupt, Correct, Normal, Add PH, Add HK, Hub HK.");
}

// ---------- Port markers + labels
function upsertPorts() {
  const features = Object.entries(currentNodes).map(([id, v]) => ({
    type: "Feature",
    properties: { id, name: v.name },
    geometry: { type: "Point", coordinates: [v.lon, v.lat] }
  }));
  const fc = { type: "FeatureCollection", features };

  if (map.getSource("ports")) {
    map.getSource("ports").setData(fc);
    return;
  }

  map.addSource("ports", { type: "geojson", data: fc });

  map.addLayer({
    id: "port-points",
    type: "circle",
    source: "ports",
    paint: {
      "circle-radius": 7.5,
      "circle-color": "#ffd166",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.95
    }
  });

  map.addLayer({
    id: "port-labels",
    type: "symbol",
    source: "ports",
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Regular", "Noto Sans Regular", "Arial Unicode MS Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 5, 12, 7, 14, 9, 16],
      "text-offset": [0, 1.25],
      "text-anchor": "top",
      "text-allow-overlap": true
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#000000",
      "text-halo-width": 1.4,
      "text-halo-blur": 0.2
    }
  });

  // keep labels on top
  for (const id of ["port-points", "port-labels"]) {
    if (map.getLayer(id)) {
      try { map.moveLayer(id); } catch (_) {}
    }
  }
}

// ---------- Boot
map.on("load", async () => {
  map.on("error", (e) => { try { console.error("Map error:", (e && e.error) || e); } catch (_) {} });

  ensureCanvas();

  SHIP_IMG = new Image();
  SHIP_IMG.onload = () => { SHIP_READY = true; };
  SHIP_IMG.onerror = () => { SHIP_READY = false; };
  SHIP_IMG.src = SHIP_IMG_SRC + "?v=" + Date.now();

  rebuildRoutes(currentNodes);
  ensureRouteLayers();
  buildShipsForNodes(currentNodes);

  upsertPorts();
  window.__upsertPorts = upsertPorts;

  // Fit camera
  const b = new maplibregl.LngLatBounds();
  Object.values(currentNodes).forEach(c => b.extend([c.lon, c.lat]));
  map.fitBounds(b, { padding: { top: 60, left: 60, right: 320, bottom: 60 }, duration: 900, maxZoom: 5.6 });

  renderStats();
  pushMsg("Type Disrupt, Correct, Normal, Add PH, Add HK, or Hub HK to drive the sea ports simulation.");
  speak("Type disrupt, correct, normal, add ports, or hub Hong Kong to drive the sea ports simulation.");
  requestAnimationFrame(tick);
});
