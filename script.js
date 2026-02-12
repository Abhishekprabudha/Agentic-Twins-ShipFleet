/* =========================================================
   Agentic Twins — ASEAN Air Network
   - Great-circle routes between 5 capitals (all-to-all)
   - Disrupt/Correct: pause SG ↔ Bangkok; reroute via Jakarta
   - Add Country: Philippines (Manila) joins (all-to-all)
   - Airplane sprites animate along arcs (looping)
   ========================================================= */

const STYLE_URL = "style.json";

// ASEAN view
const MAP_INIT = { center:[110,10], zoom:4.5, minZoom:3, maxZoom:8.5 };

// Assets
const PLANE_IMG_SRC = "airplane_topview.png"; // your uploaded PNG
const PLANE_SHADOW = null; // optional secondary sprite

// --- Plane size control ---
const PLANE_SIZE_MULT = 1.1; // 1.0 = current size; try 1.6–2.0 for bigger planes

// --- Aircraft & ops assumptions (tweak as you like) ---
const AIRCRAFT_CAPACITY_TONS = 12;   // 737 payload for this sim
const AIRSPEED_KMPH          = 820;  // typical cruise
const FUEL_BURN_KG_PER_KM    = 2.6;  // simple model: kg per km (per flight)

// Capitals (lon, lat)
const NODES = {
  SG: { name:"Singapore",           lon:103.8198, lat:1.3521 },
  TH: { name:"Bangkok (Thailand)",  lon:100.5018, lat:13.7563 },
  JP: { name:"Tokyo (Japan)",       lon:139.6917, lat:35.6895 },
  ID: { name:"Jakarta (Indonesia)", lon:106.8456, lat:-6.2088 },
  VN: { name:"Hanoi (Vietnam)",     lon:105.8342, lat:21.0278 }
};

// Add-on countries you can toggle in later
const NEW_COUNTRIES = {
  PH: { name:"Manila (Philippines)", lon:120.9842, lat:14.5995 },
  HK: { name:"Hong Kong",            lon:114.1694, lat:22.3193 }
};

// full connection pairs among keys
function allPairs(keys){
  const out=[];
  for(let i=0;i<keys.length;i++){
    for(let j=i+1;j<keys.length;j++){
      out.push([keys[i], keys[j]]);
    }
  }
  return out;
}

// Map init
const map = new maplibregl.Map({
  container: "map", style: STYLE_URL,
  center: MAP_INIT.center, zoom: MAP_INIT.zoom,
  minZoom: MAP_INIT.minZoom, maxZoom: MAP_INIT.maxZoom,
  attributionControl: true
});
map.addControl(new maplibregl.NavigationControl({visualizePitch:false}),"top-left");

// Chat & narration (minimal reuse)
const msgs = document.getElementById('msgs');
const input = document.getElementById('chatInput');
const send  = document.getElementById('chatSend');
const muteBtn = document.getElementById('muteBtn');
const clearBtn = document.getElementById('clearBtn');
const synth = window.speechSynthesis;
let MUTED=false, VOICE=null;
function pushMsg(t, kind='system'){
  const d = document.createElement('div');
  d.className=`msg ${kind}`;
  const stamp = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  d.innerHTML = `${escapeHTML(t)}<small>${stamp}</small>`;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight + 200;
}
function escapeHTML(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function speak(line){
  if (!synth) return;

  // If muted, stop anything currently speaking and bail
  if (MUTED) { try { synth.cancel(); } catch(_){}; return; }

  // Interrupt any previous utterance before starting a new one
  try { synth.cancel(); } catch(_) {}

  const u = new SpeechSynthesisUtterance(String(line));

  // pick a voice (once) when available
  const voices = synth.getVoices();
  if (!VOICE && voices && voices.length){
    VOICE = voices.find(v => /en-|English/i.test(v.lang)) || voices[0];
  }
  if (!VOICE){
    // some browsers populate voices async
    synth.onvoiceschanged = () => {
      if (!VOICE){
        const vs = synth.getVoices();
        VOICE = vs.find(v => /en-|English/i.test(v.lang)) || vs[0];
      }
    };
  }
  if (VOICE) u.voice = VOICE;

  u.rate = 0.96;
  u.pitch = 1.0;

  // If user mutes right as speech starts, cancel instantly
  u.onstart = () => { if (MUTED) try { synth.cancel(); } catch(_){}; };

  try { synth.speak(u); } catch(_) {}
}
send.addEventListener('click', ()=>handleCommand((input.value||'').trim()));
input.addEventListener('keydown',(e)=>{ if(e.key==='Enter') handleCommand((input.value||'').trim()); });
clearBtn.addEventListener('click',()=>{ msgs.innerHTML=''; });
muteBtn.addEventListener('click', ()=>{
  MUTED = !MUTED;
  muteBtn.textContent = MUTED ? '🔇 Unmute' : '🔊 Mute';
  // hard stop anything already speaking/queued
  if (MUTED && synth) { try { synth.cancel(); } catch(_){} }
});

// UI buttons
// UI buttons (null-safe)
document.getElementById('btnDisrupt')?.addEventListener('click', ()=>handleCommand('disrupt'));
document.getElementById('btnCorrect')?.addEventListener('click', ()=>handleCommand('correct'));
document.getElementById('btnNormal') ?.addEventListener('click', ()=>handleCommand('normal'));

// New: dedicated add buttons
document.getElementById('btnAddPH') ?.addEventListener('click', ()=>handleCommand('add ph'));
document.getElementById('btnAddHK') ?.addEventListener('click', ()=>handleCommand('add hk'));
document.getElementById('btnHubHK')?.addEventListener('click', ()=>handleCommand('hub hk'));


// -------- Routes (GeoJSON) & Highlights
function greatCircle(a,b,n=200){
  const line = turf.greatCircle([a.lon,a.lat],[b.lon,b.lat],{npoints:n});
  return line.geometry.coordinates; // [ [lon,lat], ... ]
}
let ROUTES = [];            // base routes feature list
let ROUTE_MAP = new Map();  // key "A-B" -> coordinates
let PLANES = [];            // animated planes

// build all-pairs arcs
function rebuildRoutes(nodeSet){
  ROUTES = [];
  ROUTE_MAP.clear();

  const keys = Object.keys(nodeSet);
  for (const [A,B] of allPairs(keys)){
    const a = nodeSet[A], b = nodeSet[B];
    const coords = greatCircle(a, b, 160);

    // one feature per unordered pair (for drawing)
    ROUTES.push({
      type: "Feature",
      properties: { id: `${A}-${B}`, A, B },
      geometry: { type:"LineString", coordinates: coords }
    });

    // cache both directions for lookups
    ROUTE_MAP.set(`${A}-${B}`, coords);
    ROUTE_MAP.set(`${B}-${A}`, [...coords].reverse());
  }
}
// Order-agnostic arc lookup. Computes & caches if missing.
function getArcCoords(A, B){
  const c = ROUTE_MAP.get(`${A}-${B}`);
  if (c) return c;

  const a = currentNodes[A], b = currentNodes[B];
  if (!a || !b) return [];

  const coords = greatCircle(a, b, 160);
  ROUTE_MAP.set(`${A}-${B}`, coords);
  ROUTE_MAP.set(`${B}-${A}`, [...coords].reverse());
  return coords;
}
// Build ONLY the routes you specify (unordered pairs like ["SG","HK"])
function rebuildRoutesFromPairs(pairs){
  ROUTES = [];
  ROUTE_MAP.clear();
  for (const [A,B] of pairs){
    const coords = getArcCoords(A,B);               // caches both A-B and B-A
    if (!coords || coords.length < 2) continue;
    ROUTES.push({
      type:"Feature",
      properties:{ id:`${A}-${B}`, A, B },
      geometry:{ type:"LineString", coordinates: coords }
    });
  }
}

// Spawn planes ONLY on the specified pairs (one each way)
function buildPlanesForPairs(pairs){
  PLANES.length = 0;
  let idx = 1;
  for (const [A,B] of pairs){
    spawnPlane(`F${idx++}`, A, B);  // A -> B
    spawnPlane(`F${idx++}`, B, A);  // B -> A
  }
}

// sources & layers
function ensureRouteLayers(){
  const baseFC = { type:"FeatureCollection", features: ROUTES };

  if(!map.getSource("routes")) map.addSource("routes",{type:"geojson", data: baseFC});
  else map.getSource("routes").setData(baseFC);

  if(!map.getLayer("routes-halo")){
  map.addLayer({
    id: "routes-halo",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#7aa6ff",
      "line-opacity": 0.18,
      "line-width": 4.0,
      "line-blur": 1.6
    }
  });
}

if(!map.getLayer("routes-glow")){
  map.addLayer({
    id: "routes-glow",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#44e9ff",
      "line-width": 2.0,
      "line-opacity": 0.35,
      "line-blur": 0.9
    }
  }, "routes-halo");
}

if(!map.getLayer("routes-base")){
  map.addLayer({
    id: "routes-base",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        3, 0.4,
        5, 0.9,
        8, 1.4
      ],
      "line-opacity": 0.95
    }
  }, "routes-glow");
}
  // alert (red) and fix (green)
  if(!map.getSource("alert")) map.addSource("alert",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  if(!map.getLayer("alert-red")){
    map.addLayer({ id:"alert-red", type:"line", source:"alert",
      layout:{ "line-cap":"round","line-join":"round" },
      paint:{ "line-color":"#ff6b6b","line-opacity":0.98,"line-width":4.8 }
    });
  }
  if(!map.getSource("fix")) map.addSource("fix",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  if(!map.getLayer("fix-green")){
    map.addLayer({ id:"fix-green", type:"line", source:"fix",
      layout:{ "line-cap":"round","line-join":"round" },
      paint:{ "line-color":"#00d08a","line-opacity":0.98,"line-width":5.8 }
    });
  }
  try { map.moveLayer("fix-green"); } catch(e){}
}

// helpers
function setAlert(ids){
  const feats = ids.map(id=>{
    const coords = ROUTE_MAP.get(id) || ROUTE_MAP.get(id.split('-').reverse().join('-'));
    return { type:"Feature", properties:{ id }, geometry:{ type:"LineString", coordinates: coords||[] } };
  });
  map.getSource("alert")?.setData({type:"FeatureCollection",features:feats});
}
function clearAlert(){ map.getSource("alert")?.setData({type:"FeatureCollection",features:[]}); }
function setFix(ids){
  const feats = ids.map(id=>{
    const coords = ROUTE_MAP.get(id) || ROUTE_MAP.get(id.split('-').reverse().join('-'));
    return { type:"Feature", properties:{ id }, geometry:{ type:"LineString", coordinates: coords||[] } };
  });
  map.getSource("fix")?.setData({type:"FeatureCollection",features:feats});
}
function clearFix(){ map.getSource("fix")?.setData({type:"FeatureCollection",features:[]}); }

// ------------- Airplanes (canvas overlay)
let overlay=null, ctx=null, PLANE_IMG=null, PLANE_READY=false;
function ensureCanvas(){
  overlay=document.getElementById("planesCanvas");
  if(!overlay){
    overlay=document.createElement("canvas");
    overlay.id="planesCanvas";
    overlay.style.cssText="position:absolute;inset:0;pointer-events:none;z-index:2;";
    map.getContainer().appendChild(overlay);
  }
  ctx=overlay.getContext("2d");
  resizeCanvas();
}
function resizeCanvas(){
  if(!overlay) return;
  const base=map.getCanvas(), dpr=window.devicePixelRatio||1;
  overlay.width=base.clientWidth*dpr; overlay.height=base.clientHeight*dpr;
  overlay.style.width=base.clientWidth+"px"; overlay.style.height=base.clientHeight+"px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener("resize",resizeCanvas);

// plane struct: {id, path:[lon,lat][], seg, t, dir, speed, paused, affected}
function spawnPlane(id, A, B){
  const coords = getArcCoords(A, B);     // direction-specific path
  if (!coords || coords.length < 2) return;

  PLANES.push({
    id, A, B,
    path: coords,          // forward path A -> B
    seg: 0,
    t: Math.random() * 0.6, // slight phase so not all start at node
    dir: 1,                 // kept for compatibility; we won’t flip it
    speed: 0.85 + Math.random()*0.3,
    paused: false,
    affected: false
  });
}

function buildPlanesForNodes(nodeSet){
  PLANES.length = 0; // clear any existing planes

  const keys = Object.keys(nodeSet);
  let idx = 1;
  for (const [A,B] of allPairs(keys)){
    // exactly one plane each way (no extra planes)
    spawnPlane(`F${idx++}`, A, B); // A -> B
    spawnPlane(`F${idx++}`, B, A); // B -> A
  }
}

function prj(lon,lat){ return map.project({lng:lon,lat:lat}); }

function drawPlaneAt(p, theta){
  const z = map.getZoom();
  // Smooth zoom-based sizing + global multiplier
const baseAtZoom = (z <= 4) ? 44 : (z >= 7 ? 72 : 44 + (72 - 44) * ((z - 4) / (7 - 4)));
const W = baseAtZoom * PLANE_SIZE_MULT;
const H = W;

  // soft shadow
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(theta);
  ctx.fillStyle = "rgba(0,0,0,0.23)";
  ctx.beginPath(); ctx.ellipse(0, H*0.18, W*0.42, H*0.18, 0, 0, Math.PI*2); ctx.fill();
  ctx.restore();

   // --- plane sprite with glow and brightness ---
  if (PLANE_READY) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(theta);

    // soft radiant glow
    ctx.shadowColor = "rgba(255, 255, 200, 0.65)"; // warm golden halo
    ctx.shadowBlur = 25;

    // additive blending for brightness
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 1.25;
    ctx.globalAlpha = 1.1 + 0.2 * Math.sin(performance.now() / 300);
    ctx.drawImage(PLANE_IMG, -W / 2, -H / 2, W, H);

    // reset context
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  } else {
    // fallback vector triangle
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(theta);
    ctx.fillStyle="#d7c099";
    ctx.beginPath(); ctx.moveTo(0,-14); ctx.lineTo(10,14); ctx.lineTo(-10,14); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function advancePlane(PL, dt){
  if (PL.paused) return;

  // pixels/sec scaled by zoom
  const pxPerSec = 90 * PL.speed * (0.95 + (map.getZoom() - 4) * 0.18);

  // always move forward along path indices
  const a = PL.path[PL.seg];
  const b = PL.path[PL.seg + 1] || PL.path[PL.seg];
  const aP = prj(a[0], a[1]);
  const bP = prj(b[0], b[1]);

  const segLen = Math.max(1, Math.hypot(bP.x - aP.x, bP.y - aP.y));
  let step = (pxPerSec * dt) / segLen;
  step = Math.max(step, 0.005);

  PL.t += step;

  // advance forward; loop at end (no reverse / no “ping-pong”)
  while (PL.t >= 1) {
    PL.seg += 1;
    PL.t -= 1;
    if (PL.seg >= PL.path.length - 1) {
      // restart loop on the same (forward) direction
      PL.seg = 0;
      PL.t = Math.random() * 0.2; // tiny phase so it doesn’t stick on the node
      break;
    }
  }
}
function drawPlanes(){
  ctx.clearRect(0,0,overlay.width,overlay.height);
  const now = performance.now()/1000;
  for(const PL of PLANES){
    // in drawPlanes()
const a = PL.path[PL.seg];
const b = PL.path[PL.seg + 1] || a;   // <-- replace seg+PL.dir with seg+1

    const aP = prj(a[0],a[1]); const bP = prj(b[0],b[1]);
    // bobbing
    const bob = Math.sin(now*1.5 + (PL.id.charCodeAt(0)%7))*2.0;
    const x = aP.x + (bP.x-aP.x)*PL.t;
    const y = aP.y + (bP.y-aP.y)*PL.t + bob;

// --- Compute geodesic heading (true direction of flight) ---
let bearing = turf.bearing([a[0], a[1]], [b[0], b[1]]);
// convert to radians for canvas rotation
let theta = (bearing * Math.PI) / 180;

// Flip vertical axis if MapLibre projection distorts orientation
if (map.getPitch() !== 0) theta = -theta;

// draw plane oriented to direction of motion
drawPlaneAt({x, y}, theta);
  }
}

// animation loop
let __lastTS = performance.now();
function tick(){
  if(ctx){
    const now = performance.now();
    const dt = Math.min(0.05,(now-__lastTS)/1000); __lastTS = now;
    for(const PL of PLANES) advancePlane(PL, dt);
    drawPlanes();
  }
  requestAnimationFrame(tick);
}
// Geodesic path length (km) for a route polyline
function pathLengthKm(coords){
  if (!coords || coords.length < 2) return 0;
  const feature = { type:"Feature", geometry:{ type:"LineString", coordinates: coords } };
  return turf.length(feature, { units: "kilometers" }) || 0;
}

// ---------- Stats table
function renderStats(){
  const table = document.querySelector("#statsTable"); 
  if(!table) return;

  // Rebuild header so we can add new columns
  table.innerHTML = `
    <thead>
      <tr>
        <th>Capital</th>
        <th>Flights</th>
        <th class="pos">Active</th>
        <th class="neg">Paused</th>
        <th>Tonnage (t)</th>
        <th>Time (hrs)</th>
        <th>Fuel (t)</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");

  // Seed per-capital buckets
  const caps = Object.keys(currentNodes);
  const rows = {};
  for(const k of caps){
    rows[k] = {
      label: currentNodes[k].name,
      flights: 0,
      active: 0,
      paused: 0,
      tonnage_t: 0,   // tons
      time_h: 0,      // hours
      fuel_t: 0       // tons
    };
  }

  // Aggregate per airplane (count each leg once; add to both endpoints)
  for(const PL of PLANES){
    const A = PL.A, B = PL.B;
    if(!rows[A] || !rows[B]) continue;

    // Count presence
    rows[A].flights++; rows[B].flights++;

    if(PL.paused){
      rows[A].paused++; rows[B].paused++;
      continue; // paused flights don't contribute to ops metrics
    } else {
      rows[A].active++; rows[B].active++;
    }

    // Leg metrics (based on full A->B path currently assigned to this plane)
    const distKm = pathLengthKm(PL.path);
    const timeHr = distKm / AIRSPEED_KMPH;
    const fuelKg = FUEL_BURN_KG_PER_KM * distKm;

    // Add to both endpoints
    rows[A].tonnage_t += AIRCRAFT_CAPACITY_TONS;
    rows[B].tonnage_t += AIRCRAFT_CAPACITY_TONS;

    rows[A].time_h   += timeHr;
    rows[B].time_h   += timeHr;

    rows[A].fuel_t   += fuelKg / 1000;
    rows[B].fuel_t   += fuelKg / 1000;
  }

  // Render rows
  for(const k of caps){
    const r = rows[k];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.label}</td>
      <td>${r.flights}</td>
      <td class="pos">+${r.active}</td>
      <td class="neg">-${r.paused}</td>
      <td>${r.tonnage_t.toFixed(0)}</td>
      <td>${r.time_h.toFixed(1)}</td>
      <td>${r.fuel_t.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- Scenarios
let currentNodes = {...NODES};
let DISRUPTED = false;
// Disrupt Japan ↔ Thailand (Tokyo ↔ Bangkok)
const DISRUPT_PAIR = ["JP","TH"];
// Reroute via Vietnam (Tokyo → Hanoi → Bangkok)
const REROUTE_PATH = [["JP","VN"], ["VN","TH"]];


function startDisrupt(){
  if (DISRUPTED) { pushMsg("Disruption is already active."); return; }
  DISRUPTED = true;

  const [A,B] = DISRUPT_PAIR;
  // mark alert (red) on the direct corridor
  setAlert([`${A}-${B}`]);
  clearFix();

  // pause planes whose base pair matches the disrupted pair
  for (const PL of PLANES){
    const ab = [PL.A, PL.B].sort().join('-');
    const t  = DISRUPT_PAIR.slice().sort().join('-');
    if (ab === t){ PL.paused = true; PL.affected = true; }
  }

  renderStats();
  const an = currentNodes[A]?.name || A;
  const bn = currentNodes[B]?.name || B;
  pushMsg(`⚠️ Disruption: ${an} ↔ ${bn} air corridor closed. Affected flights paused.`);
  speak("Disruption. Tokyo to Bangkok corridor closed. Affected flights paused.");
}
function applyCorrect(){
  if (!DISRUPTED){ pushMsg("No active disruption. Click Disrupt first."); return; }

  // show fix path in green
  setFix(REROUTE_PATH.map(p => p.join('-')));
  clearAlert();

  const [A,B] = DISRUPT_PAIR;

  // Build a combined polyline for forward A → ... → B
  const forward = [];
  for (let i = 0; i < REROUTE_PATH.length; i++){
    const [from, to] = REROUTE_PATH[i];
    const seg = getArcCoords(from, to);
    if (!seg || seg.length < 2) continue;
    if (i === 0) forward.push(...seg);
    else forward.push(...seg.slice(1)); // avoid duplicate vertex at joins
  }
  const backward = [...forward].reverse();

  // Reassign affected planes
  for (const PL of PLANES){
    if (!PL.affected) continue;
    if (PL.A === A && PL.B === B){
      PL.path = forward;  PL.seg = 0; PL.t = 0;
    } else if (PL.A === B && PL.B === A){
      PL.path = backward; PL.seg = 0; PL.t = 0;
    }
    PL.paused = false;
  }

  renderStats();

  // Build a nice message like "Tokyo → Hanoi → Bangkok"
  const hopNames = REROUTE_PATH.map(([from,to],i) => (i===0 ? currentNodes[from]?.name || from : null))
                               .concat(currentNodes[REROUTE_PATH.at(-1)[1]]?.name || REROUTE_PATH.at(-1)[1])
                               .filter(Boolean);
  const pretty = hopNames.join(" → ");

  pushMsg(`✅ Correction applied: rerouting flights ${pretty} (green).`);
  speak("Correction applied. Rerouting flights via Hanoi.");
}
function backToNormal(){
  DISRUPTED=false;
  clearAlert(); clearFix();

  // rebuild planes on direct arcs
  rebuildRoutes(currentNodes);
  ensureRouteLayers();
  buildPlanesForNodes(currentNodes);

  renderStats();
  pushMsg("Normal operations resumed. All arcs open.");
  speak("Normal operations resumed. All arcs open.");
}
function applyHubHK(){
  // Ensure HK exists
  if (!currentNodes.HK) {
    const hk = NEW_COUNTRIES.HK;
    if (!hk) { pushMsg("HK definition missing in NEW_COUNTRIES."); return; }
    currentNodes = { ...currentNodes, HK: hk };
    if (typeof upsertCapitals === 'function') upsertCapitals();
  }

  // Clear any disruption overlays/state
  DISRUPTED = false;
  clearAlert(); clearFix();

  // Build star topology: everyone <-> HK (includes JP <-> HK)
  const keys = Object.keys(currentNodes);
  const pairs = [];
  for (const K of keys){
    if (K === "HK") continue;
    pairs.push([K, "HK"]);
  }

  // Apply star network
  rebuildRoutesFromPairs(pairs);
  ensureRouteLayers();
  buildPlanesForPairs(pairs);

  // Fit camera
  const b = new maplibregl.LngLatBounds();
  Object.values(currentNodes).forEach(c=>b.extend([c.lon,c.lat]));
  map.fitBounds(b, { padding:{ top:60, left:60, right:320, bottom:60 }, duration:900, maxZoom:5.6 });

  renderStats();
  pushMsg("🟡 Hub HK: All cities fly to Hong Kong; Hong Kong shuttles to Tokyo.");
  speak("Hub Hong Kong mode active.");
}

function addCountryByCode(code){
  const CODE = (code || '').toUpperCase();
  const node = NEW_COUNTRIES[CODE];
  if (!node) { pushMsg(`Unknown country code: ${code}`); return; }

  if (currentNodes[CODE]) {
    pushMsg(`${node.name} is already added.`);
    return;
  }

  // Merge the new node
  currentNodes = { ...currentNodes, [CODE]: node };

  // Rebuild routes + planes
  rebuildRoutes(currentNodes);
  ensureRouteLayers();
  buildPlanesForNodes(currentNodes);

  // Upsert capital markers/labels (so the new city shows)
  if (typeof upsertCapitals === 'function') upsertCapitals();

  // Fit camera to include the new node
  const b = new maplibregl.LngLatBounds();
  Object.values(currentNodes).forEach(c => b.extend([c.lon, c.lat]));
  map.fitBounds(b, { padding:{ top:60, left:60, right:320, bottom:60 }, duration:1000, maxZoom:5.8 });

  // UI
  renderStats();
  pushMsg(`🆕 Added ${node.name}. New routes to all capitals are now active.`);
  speak(`${node.name} added. New routes active.`);
}
// ---------- Command handler
function handleCommand(raw){
  const cmd = (raw||'').trim();
  if(!cmd) return;
  pushMsg(cmd,'user'); input.value='';

  const k = cmd.toLowerCase();

  if (k === 'disrupt') startDisrupt();
  else if (k === 'correct') applyCorrect();
  else if (k === 'normal') backToNormal();
  else if (k === 'add ph' || k === 'addph') addCountryByCode('PH');
  else if (k === 'add hk' || k === 'addhk') addCountryByCode('HK');
  else if (k === 'hub hk' || k === 'hubhk') applyHubHK();             // <— NEW
  else pushMsg('Valid commands: Disrupt, Correct, Normal, Add PH, Add HK, Hub HK.');
}
function upsertCapitals() {
  const features = Object.entries(currentNodes).map(([id, v]) => ({
    type: "Feature",
    properties: { id, name: v.name },
    geometry: { type: "Point", coordinates: [v.lon, v.lat] }
  }));
  const fc = { type: "FeatureCollection", features };

  if (map.getSource("capitals")) {
    map.getSource("capitals").setData(fc);
    return;
  }

  map.addSource("capitals", { type: "geojson", data: fc });

  // point icon (on top of routes)
  map.addLayer({
    id: "capital-points",
    type: "circle",
    source: "capitals",
    paint: {
      "circle-radius": 7,
      "circle-color": "#ffd166",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.95
    }
  });

  // text label (use fonts that exist on the glyph server)
  map.addLayer({
    id: "capital-labels",
    type: "symbol",
    source: "capitals",
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Bold", "Open Sans Bold"], // <- valid fonts
      "text-size": [
        "interpolate", ["linear"], ["zoom"],
        3, 10,
        6, 13,
        8, 15
      ],
      "text-offset": [0, 1.2],
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
}
// ---------- Boot
map.on("load", async ()=>{
  // --- console visibility for any layer/source errors
  map.on("error", (e)=>{ try{ console.error("Map error:", e && e.error || e); }catch(_){} });

  // --- helper: (re)build capitals source + layers and keep them on top
  function upsertCapitals(){
    const features = Object.entries(currentNodes).map(([id, v]) => ({
      type: "Feature",
      properties: { id, name: v.name },
      geometry: { type: "Point", coordinates: [v.lon, v.lat] }
    }));
    const fc = { type: "FeatureCollection", features };

    if (map.getSource("capitals")) {
      map.getSource("capitals").setData(fc);
    } else {
      map.addSource("capitals", { type: "geojson", data: fc });

      // Points (visible even if glyphs fail)
      map.addLayer({
        id: "capital-points",
        type: "circle",
        source: "capitals",
        paint: {
          "circle-radius": 7.5,
          "circle-color": "#ffd166",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.95
        }
      });

      // Text labels — use fonts that exist on the glyph server
      // (OpenMapTiles supports these stacks)
      map.addLayer({
        id: "capital-labels",
        type: "symbol",
        source: "capitals",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Open Sans Regular", "Noto Sans Regular", "Arial Unicode MS Regular"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            3, 10,
            5, 12,
            7, 14,
            9, 16
          ],
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
    }

    // keep labels on very top (above routes, alerts, fixes)
    const topMost = ["capital-points", "capital-labels"];
    for (const id of topMost) {
      if (map.getLayer(id)) {
        try { map.moveLayer(id); } catch(_) {}
      }
    }
  }

  // --- canvas overlay
  ensureCanvas();

  // --- preload plane image (cache-bust)
  PLANE_IMG = new Image();
  PLANE_IMG.onload = ()=>{ PLANE_READY = true; };
  PLANE_IMG.onerror = ()=>{ PLANE_READY = false; };
  PLANE_IMG.src = PLANE_IMG_SRC + "?v=" + Date.now();

  // --- routes + planes
  rebuildRoutes(currentNodes);
  ensureRouteLayers();
  buildPlanesForNodes(currentNodes);

  // --- capitals (points + labels)
  upsertCapitals();

  // --- fit camera to all current nodes
  const b = new maplibregl.LngLatBounds();
  Object.values(currentNodes).forEach(c=>b.extend([c.lon,c.lat]));
  map.fitBounds(b, { padding:{ top:60, left:60, right:320, bottom:60 }, duration:900, maxZoom:5.6 });

  // --- start
  renderStats();
  pushMsg("Type Disrupt, Correct, Normal, or Add Country to drive the simulation.");
  speak("Type Disrupt, Correct, Normal, or Add Country to drive the simulation.");
  requestAnimationFrame(tick);

  // expose helper so we can refresh icons/labels after adding Manila
  window.__upsertCapitals = upsertCapitals;
});












