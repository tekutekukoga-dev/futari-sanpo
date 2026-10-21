"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const WALK_SPEED = 1.25; // m/s（時速4.5km）
const SIM_SPEED = 8; // 試しモードの倍速
const PHOTON = "https://photon.komoot.io/reverse";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";

const STOP_TYPES = {
  cafe: { label: "カフェ", tag: "amenity:cafe", q: '["amenity"="cafe"]', phrase: "cafe", mission: "stop" },
  bakery: { label: "パン屋", tag: "shop:bakery", q: '["shop"="bakery"]', phrase: "bakery", mission: "stop" },
  park: { label: "公園", tag: "leisure:park", q: '["leisure"="park"]', phrase: "park", mission: "park" },
  shrine: { label: "神社・お寺", tag: "amenity:place_of_worship", q: '["amenity"="place_of_worship"]', phrase: "place of worship", mission: "shrine", name: /神社|寺|宮|稲荷|八幡|天神|観音|不動|地蔵|権現|社$/ },
  historic: { label: "史跡", tag: "historic", q: '["historic"]', phrase: "monument", mission: "historic" },
  viewpoint: { label: "景色のいい所", tag: "tourism:viewpoint", q: '["tourism"="viewpoint"]', phrase: "viewpoint", mission: "viewpoint" },
  books: { label: "本屋", tag: "shop:books", q: '["shop"="books"]', phrase: "bookshop", mission: "books" },
  sweets: { label: "和菓子屋", tag: "shop:confectionery", q: '["shop"="confectionery"]', phrase: "confectionery", mission: "sweets" },
  bath: { label: "銭湯", tag: "amenity:public_bath", q: '["amenity"="public_bath"]', phrase: "public bath", mission: "bath" },
  any: { label: "おまかせ" },
  none: { label: "寄り道なし" },
};

// ---------- 保存 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("fs:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fs:" + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("fs:" + k); } catch {} },
};

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open("futari-sanpo", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("walks", { keyPath: "id" });
      d.createObjectStore("photos", { keyPath: "id", autoIncrement: true }).createIndex("walkId", "walkId");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb(storeName, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error("保存が中断されました"));
  });
}
const putWalk = (w) => idb("walks", "readwrite", (s) => s.put(w));
const allWalks = () => idb("walks", "readonly", (s) => s.getAll());
const getWalk = (id) => idb("walks", "readonly", (s) => s.get(id));
const addPhoto = (p) => idb("photos", "readwrite", (s) => s.add(p));
const photosOf = (walkId) => idb("photos", "readonly", (s) => s.index("walkId").getAll(walkId));
// 古い記録は Blob、新しい記録は ArrayBuffer で持っている
const photoBlob = (p) => p.blob || new Blob([p.data], { type: p.type || "image/jpeg" });

// ---------- 地理計算 ----------
const R = 6371000, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function dist(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function dest(p, brg, d) {
  const φ1 = rad(p[0]), λ1 = rad(p[1]), θ = rad(brg), δ = d / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [deg(φ2), deg(λ2)];
}
// 点pから線分abへの最近点（t: 0〜1, d: 距離m）
function project(p, a, b) {
  const k = Math.cos(rad(p[0]));
  const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, d: dist(p, q) };
}
const DIR8 = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
const dir8 = (b) => DIR8[Math.round(b / 45) % 8];

// 日の出・日の入りの時刻（天文計算の近似式。誤差は数分程度）
function sunTimes(date, lat, lon) {
  const dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad(23.4397);
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
  const d = date.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const lw = rad(-lon), phi = rad(lat);
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = rad(357.5291 + 0.98560028 * ds);
  const C = rad(1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const Lsun = M + C + rad(102.9372) + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(Lsun));
  const noon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * Lsun);
  const w = Math.acos((Math.sin(rad(-0.833)) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  const set = J2000 + 0.0009 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * Lsun);
  return { sunrise: fromJulian(noon - (set - noon)), sunset: fromJulian(set) };
}
// 散歩の真ん中の時刻が、日の入り後か日の出前なら夜さんぽ
function isNightWalk(start, minutes, home) {
  const mid = start + minutes * 30000;
  const { sunrise, sunset } = sunTimes(new Date(mid), home[0], home[1]);
  return mid >= sunset.getTime() || mid < sunrise.getTime();
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, r) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const fmtKm = (m) => (m / 1000).toFixed(1);
const fmtDist = (m) => (m >= 1000 ? `${fmtKm(m)}km` : `${Math.max(10, Math.round(m / 10) * 10)}m`);
const fmtTime = (t) => new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const fmtMinutes = (m) => (m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`);
const fmtDate = (t) => new Date(t).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }

let toastTimer;
function toast(msg, isError) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false; t.classList.toggle("error", !!isError);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2600);
}

// ---------- 状態 ----------
const plan = {
  home: store.get("home", null),
  minutes: store.get("minutes", 60),
  stop: store.get("stop", "cafe"),
  interval: store.get("interval", 8),
  turnAlert: store.get("turnAlert", false),
  candidates: [],
  chosen: null,
  seed: Math.floor(Math.random() * 1e9),
  route: null,
  shared: false,
};
let walk = null;

// ---------- 地図 ----------
const tileUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const tileOpt = { maxZoom: 19, attribution: "&copy; OpenStreetMap" };
// 地図タイルは明るいままなので、線の色はテーマによらず濃い色で固定する
const ROUTE_COLOR = "#1d5c8f", TRACK_COLOR = "#e0791a";
function makeMap(el, opts = {}) {
  const m = L.map(el, { zoomControl: false, attributionControl: true, ...opts }).setView(plan.home || [35.681, 139.767], plan.home ? 15 : 12);
  L.tileLayer(tileUrl, tileOpt).addTo(m);
  return m;
}
const dot = (color, r = 8) => ({ radius: r, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 });
const arrowSvg = (b, color) => `<svg viewBox="0 0 18 18" style="transform:rotate(${b}deg)"><path d="M9 1.5 15.5 15 9 11.5 2.5 15Z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
// ルートの上に、進む向きの矢印を一定間隔で置く
function addDirArrows(layer, route, every = 220) {
  for (let at = 120; at < route.total - 60; at += every) {
    const p = pointAt(route, at), q = pointAt(route, at + 15);
    L.marker(p, { icon: L.divIcon({ className: "dir", html: arrowSvg(bearing(p, q), ROUTE_COLOR), iconSize: [18, 18] }), interactive: false, keyboard: false }).addTo(layer);
  }
}
function pointAt(route, along) {
  const { coords, cum } = route;
  let i = cum.findIndex((c) => c >= along);
  if (i <= 0) return coords[Math.max(0, i)];
  const t = (along - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
}
// 時計回りか反時計回りか（多角形の符号付き面積）と、最初に向かう方角
function loopInfo(route) {
  const k = Math.cos(rad(route.coords[0][0]));
  let area = 0;
  for (let i = 1; i < route.coords.length; i++) {
    const [y1, x1] = route.coords[i - 1], [y2, x2] = route.coords[i];
    area += (x1 * k) * y2 - (x2 * k) * y1;
  }
  return { clockwise: area < 0, first: dir8(bearing(route.coords[0], pointAt(route, 200))) };
}

let planMap, planLayer;
function initPlanMap() {
  planMap = makeMap($("#planMap"));
  planLayer = L.layerGroup().addTo(planMap);
  planMap.on("click", (e) => { if (!plan.shared) setHome([e.latlng.lat, e.latlng.lng]); });
  drawPlan();
}
function drawPlan() {
  planLayer.clearLayers();
  if (plan.route) {
    const line = L.polyline(plan.route.coords, { color: ROUTE_COLOR, weight: 6, opacity: 0.85 }).addTo(planLayer);
    addDirArrows(planLayer, plan.route);
    planMap.fitBounds(line.getBounds(), { padding: [24, 24] });
  }
  plan.candidates.forEach((c) => {
    const on = plan.chosen && plan.chosen.id === c.id;
    L.circleMarker(c.pos, dot(on ? TRACK_COLOR : "#8a968f", on ? 9 : 6)).bindTooltip(c.name).addTo(planLayer)
      .on("click", () => chooseCandidate(c));
  });
  if (plan.home) L.marker(plan.home, { icon: L.divIcon({ className: "", html: `<span class="pin">${plan.route ? "スタート・ゴール" : "自宅"}</span>`, iconSize: null, iconAnchor: [0, 26] }) }).addTo(planLayer);
  if (plan.home) L.circleMarker(plan.home, dot(ROUTE_COLOR, 8)).addTo(planLayer);
}

// ---------- ルート作成 ----------
function setHome(p) {
  plan.home = p; store.set("home", p);
  $("#homeLabel").textContent = "設定済み";
  $("#homeLabel").classList.remove("muted");
  plan.candidates = []; plan.chosen = null; plan.route = null;
  $("#candidates").innerHTML = ""; $("#routeSummary").hidden = true;
  planMap.setView(p, 15);
  drawPlan();
}

function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("この端末では位置情報が使えません"));
    navigator.geolocation.getCurrentPosition((p) => res([p.coords.latitude, p.coords.longitude]),
      () => rej(new Error("現在地を取得できませんでした。位置情報の許可を確認してください")), { enableHighAccuracy: true, timeout: 15000 });
  });
}

// 1周の目標距離から、自宅〜寄り道先の直線距離の目安を出す
const loopMeters = () => plan.minutes * 60 * WALK_SPEED;
const legRadius = () => loopMeters() / 3.9;

// 各検索サービスの結果を { id, name, pos } にそろえる
async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}
// 自宅から目安の距離にある6地点のまわりを、まとめて探す
async function fromPhoton(t, home, r) {
  const rings = [0, 60, 120, 180, 240, 300].map((b) => dest(home, b, r));
  const results = await Promise.allSettled(rings.map((p) =>
    getJson(`${PHOTON}?lat=${p[0].toFixed(5)}&lon=${p[1].toFixed(5)}&radius=${(r * 0.6 / 1000).toFixed(2)}&limit=15&osm_tag=${t.tag}`)));
  const ok = results.filter((x) => x.status === "fulfilled");
  if (!ok.length) throw new Error("photon");
  return ok.flatMap((x) => x.value.features).map((f) => ({
    id: f.properties.osm_type + f.properties.osm_id, name: f.properties.name,
    pos: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
  }));
}
async function fromOverpass(t, home, r) {
  const q = `[out:json][timeout:15];nwr${t.q}["name"](around:${Math.round(r * 1.6)},${home[0]},${home[1]});out tags center 80;`;
  const data = await getJson(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return data.elements.map((e) => ({
    id: e.type[0].toUpperCase() + e.id, name: e.tags && e.tags.name,
    pos: e.lat != null ? [e.lat, e.lon] : [e.center.lat, e.center.lon],
  }));
}
async function fromNominatim(t, home, r) {
  const a = dest(home, 315, r * 1.6 * Math.SQRT2), b = dest(home, 135, r * 1.6 * Math.SQRT2);
  const data = await getJson(`${NOMINATIM}?q=${encodeURIComponent(t.phrase)}&viewbox=${a[1]},${a[0]},${b[1]},${b[0]}&bounded=1&format=jsonv2&limit=40`);
  return data.map((e) => ({ id: e.osm_type[0].toUpperCase() + e.osm_id, name: e.name, pos: [+e.lat, +e.lon] }));
}

async function findCandidates(type) {
  const t = STOP_TYPES[type];
  if (!t.q) return [];
  const r = legRadius(), [lat, lon] = plan.home;
  // お店はそうそう変わらないので、自宅・種類・時間ごとに1週間保存して使い回す
  const cacheKey = `poi:${type}:${Math.round(plan.minutes / 15)}:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = store.get(cacheKey, null);
  let places = cached && Date.now() - cached.at < 7 * 864e5 ? cached.places : null;
  if (!places) {
    // 検索サービスはどれも混むことがあるので、順に試して最初に取れたものを使う
    for (const source of [fromPhoton, fromOverpass, fromNominatim]) {
      try { places = await source(t, plan.home, r); } catch { places = null; }
      if (places && places.length) break;
    }
    if (!places) throw new Error("お店の情報を取得できませんでした。電波の良いところで、少し待ってからもう一度お試しください");
    if (places.length) store.set(cacheKey, { at: Date.now(), places });
  }
  const seen = new Set();
  return places
    .filter((p) => p.name && (!t.name || t.name.test(p.name)) && !seen.has(p.id) && !seen.has(p.name) && seen.add(p.id) && seen.add(p.name))
    .map((p) => ({ ...p, type, d: dist(plan.home, p.pos) }))
    .filter((c) => c.d > r * 0.35 && c.d < r * 1.6)
    .sort((a, b) => Math.abs(a.d - r) - Math.abs(b.d - r))
    .slice(0, 6);
}

function renderCandidates() {
  const box = $("#candidates");
  box.innerHTML = "";
  if (plan.stop === "none") return;
  if (!plan.candidates.length) return;
  plan.candidates.forEach((c) => {
    const b = document.createElement("button");
    b.className = plan.chosen && plan.chosen.id === c.id ? "on" : "";
    b.innerHTML = `<span></span><span class="d">${plan.stop === "any" ? STOP_TYPES[c.type].label + "・" : ""}家から${fmtKm(c.d)}km</span>`;
    b.firstChild.textContent = c.name;
    b.onclick = () => chooseCandidate(c);
    box.appendChild(b);
  });
}
function chooseCandidate(c) { plan.chosen = c; renderCandidates(); buildRoute(); }

async function osrm(points) {
  const coords = points.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const res = await fetch(`${OSRM}${coords}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res) throw new Error("ルートを作れませんでした。電波の良いところでもう一度お試しください");
  if (!res.ok) throw new Error("ルートを作れませんでした。少し待ってからもう一度お試しください");
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes.length) throw new Error("この場所では歩くルートが見つかりませんでした");
  return data.routes[0];
}

// OSRMの結果を、案内に使いやすい形にする
function shapeRoute(r, waypoints, stopIndex) {
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  const scale = r.distance ? total / r.distance : 1;
  const turns = [], legEnds = [];
  let along = 0;
  r.legs.forEach((leg) => {
    leg.steps.forEach((s) => {
      const t = turnText(s);
      if (t) turns.push({ along: along * scale, ...t });
      along += s.distance;
    });
    legEnds.push(along * scale);
  });
  // 30m以内に続く曲がり角は1つの案内にまとめる
  for (let i = turns.length - 1; i > 0; i--) {
    const a = turns[i - 1], b = turns[i];
    if (b.along - a.along < 30) {
      a.then = (b.then ? b.dir + "、" + b.then : b.dir);
      if (b.name) a.name = b.name;
      turns.splice(i, 1);
    }
  }
  return { coords, cum, total, turns, legEnds, waypoints, stopIndex, stopAlong: stopIndex != null ? legEnds[stopIndex - 1] : null };
}

const DIRS = {
  left: ["左", "↰"], right: ["右", "↱"], "slight left": ["斜め左", "↖"], "slight right": ["斜め右", "↗"],
  "sharp left": ["大きく左", "↰"], "sharp right": ["大きく右", "↱"], uturn: ["Uターン", "↶"],
};
function turnText(step) {
  const m = step.maneuver;
  if (["depart", "arrive"].includes(m.type)) return null;
  const d = DIRS[m.modifier];
  if (!d) return null;
  if (["new name", "continue"].includes(m.type) && m.modifier.startsWith("slight")) return null;
  return { dir: d[0], arrow: d[1], name: step.name || "" };
}

async function buildRoute() {
  if (!plan.home) return showPlanError("先に自宅を設定してください");
  showPlanError("");
  $("#btnMake").disabled = true; $("#btnMake").textContent = "ルートを作っています…";
  try {
    const r = rng(plan.seed), home = plan.home, rad0 = legRadius();
    let wps, stopIndex = null;
    if (plan.stop !== "none" && plan.chosen) {
      const c = plan.chosen.pos, b = bearing(home, c), dc = dist(home, c), side = r() < 0.5 ? 60 : -60;
      wps = (f) => [home, c, dest(home, b + side, dc * 0.95 * f), home];
      stopIndex = 1;
    } else {
      const θ = r() * 360;
      wps = (f) => [home, dest(home, θ, rad0 * f), dest(home, θ + 60, rad0 * f), home];
    }
    // 距離が目標から15%以上ずれたら、経由地の距離を変えて最大3回作り直し、いちばん近いものを使う
    const target = loopMeters();
    let f = 1, pts = wps(f), route = await osrm(pts), best = { route, pts };
    for (let i = 0; i < 3; i++) {
      const ratio = target / route.distance;
      if (Math.abs(ratio - 1) < 0.15) break;
      f = Math.max(0.1, Math.min(2.5, f * (stopIndex ? 1 + (ratio - 1) * 1.6 : ratio)));
      pts = wps(f);
      route = await osrm(pts);
      if (Math.abs(route.distance - target) < Math.abs(best.route.distance - target)) best = { route, pts };
    }
    plan.route = shapeRoute(best.route, best.pts, stopIndex);
    showSummary();
    drawPlan();
  } catch (e) {
    showPlanError(e.message);
  } finally {
    $("#btnMake").disabled = false; $("#btnMake").textContent = "ルートを作る";
  }
}

function showSummary() {
  const r = plan.route, info = loopInfo(r);
  $("#sumDist").textContent = fmtKm(r.total);
  $("#sumTime").textContent = Math.round(r.total / WALK_SPEED / 60);
  $("#sumLoop").textContent = `${info.clockwise ? "時計回り" : "反時計回り"}のルート。家を出たら、まず${info.first}へ向かいます（地図の矢印の向き）`;
  $("#sumStop").textContent = plan.chosen && plan.stop !== "none" ? `途中で「${plan.chosen.name}」に寄ります` : "寄り道なしで、ぐるっと一周します";
  const { sunset } = sunTimes(new Date(), plan.home[0], plan.home[1]);
  const night = isNightWalk(Date.now(), r.total / WALK_SPEED / 60, plan.home);
  $("#sumSun").textContent = night ? `日の入りは${fmtTime(sunset)}。いま出発すると、夜向けのお題も混ざります` : `日の入りは${fmtTime(sunset)}`;
  $("#routeSummary").hidden = false;
}
function showPlanError(msg) { $("#planError").textContent = msg; $("#planError").hidden = !msg; }

async function onMake() {
  if (!plan.home) return showPlanError("先に自宅を設定してください");
  if (plan.stop === "none") { plan.chosen = null; return buildRoute(); }
  $("#btnMake").disabled = true; $("#btnMake").textContent = plan.stop === "any" ? "寄り道先を探しています…" : `${STOP_TYPES[plan.stop].label}を探しています…`;
  try {
    if (plan.stop === "any") {
      // おまかせ：種類をランダムな順に試して、見つかったものを使う
      const types = shuffle(Object.keys(STOP_TYPES).filter((k) => STOP_TYPES[k].q), rng(plan.seed ^ 7));
      plan.candidates = [];
      for (const type of types) {
        plan.candidates = await findCandidates(type).catch(() => []);
        if (plan.candidates.length) break;
      }
    } else plan.candidates = await findCandidates(plan.stop);
    if (!plan.candidates.length) showPlanError("ちょうどいい距離に見つかりませんでした。歩く時間か寄り道先を変えてみてください");
    const r = rng(plan.seed);
    plan.chosen = plan.candidates[Math.floor(r() * Math.min(3, plan.candidates.length))] || null;
    renderCandidates();
    drawPlan();
    if (plan.chosen) await buildRoute();
  } catch (e) {
    showPlanError(e.message);
  } finally {
    $("#btnMake").disabled = false; $("#btnMake").textContent = "ルートを作る";
  }
}

// ---------- 共有 ----------
function shareLink() {
  const payload = {
    h: plan.home.map((v) => +v.toFixed(5)), m: plan.minutes, i: plan.interval, s: plan.seed, st: plan.stop,
    c: plan.chosen && plan.stop !== "none" ? { n: plan.chosen.name, p: plan.chosen.pos.map((v) => +v.toFixed(5)), id: plan.chosen.id, t: plan.chosen.type } : null,
  };
  // #以降はサーバーに送られないので、自宅の位置がホスティング先に残らない
  return location.origin + location.pathname + "#r=" + encodeURIComponent(JSON.stringify(payload));
}
async function onShare() {
  const url = shareLink();
  try {
    if (navigator.share) { await navigator.share({ title: "ふたり散歩のルート", url }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(url); toast("リンクをコピーしました。パートナーに送ってください"); }
  catch { toast("コピーできませんでした", true); }
}
async function loadShared() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (!m) return false;
  try {
    const p = JSON.parse(decodeURIComponent(m[1]));
    Object.assign(plan, { home: p.h, minutes: p.m, interval: p.i, seed: p.s, stop: p.st, shared: true });
    plan.chosen = p.c ? { id: p.c.id, name: p.c.n, pos: p.c.p, type: p.c.t || p.st, d: dist(p.h, p.c.p) } : null;
    plan.candidates = plan.chosen ? [plan.chosen] : [];
    $("#sharedBanner").hidden = false;
    $("#planForm").hidden = true; $("#btnMake").hidden = true;
    planMap.setView(plan.home, 15);
    await buildRoute();
    return true;
  } catch { return false; }
}

// ---------- お題の予定 ----------
// お題は「歩いた距離」で届く。同じseedなら二人のスマホで同じ場所・同じお題になる
const fits = (night) => (m) => !m.when || m.when === (night ? "night" : "day");
function missionPlan(seed, total, interval, stopAlong, night) {
  const r = rng(seed ^ 0x5a5a);
  const look = shuffle(MISSIONS.look.filter(fits(night)), r).map((m) => ({ kind: "look", ...m }));
  const talk = shuffle(MISSIONS.talk, r).map((m) => ({ kind: "talk", ...m }));
  // 季節のお題は、最初のほうに混ぜる
  MISSIONS.season[seasonKey(new Date().getMonth() + 1)].filter(fits(night))
    .forEach((m) => look.splice(1 + Math.floor(r() * 3), 0, { kind: "look", ...m }));
  // 観察を多めに：観察・観察・会話のタネ の繰り返し
  const order = ["look", "look", "talk"];
  const used = { look: 0, talk: 0 };
  const step = interval * 60 * WALK_SPEED;
  const events = [];
  for (let at = 200, n = 0; at < total * 0.85; at += step, n++) {
    // 寄り道先の手前・直後とは重ならないようにする
    if (stopAlong != null && Math.abs(at - stopAlong) < 150) continue;
    const kind = order[n % order.length], pool = kind === "look" ? look : talk;
    events.push({ at, ...pool[used[kind]++ % pool.length], id: "m" + n });
  }
  events.push({ at: total * 0.9, ...MISSIONS.final, id: "final" });
  return events;
}

// ---------- 地図の向き ----------
// compass: 向いている方向が上 / route: 進む方向が上（コンパスが使えないとき） / north: 北が上
const heading = { mode: store.get("headingMode", "compass"), compass: null, shown: 0, target: 0, raf: 0, listening: false };

// iPhoneはボタンを押したときにしか許可を求められないので、出発ボタンの中で呼ぶ
function requestCompass() {
  if (heading.listening) return;
  const onOrient = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;
    if (h != null && !isNaN(h)) heading.compass = h;
  };
  const listen = () => {
    heading.listening = true;
    window.addEventListener("deviceorientationabsolute", onOrient);
    window.addEventListener("deviceorientation", onOrient);
  };
  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then((s) => { if (s === "granted") listen(); }).catch(() => {});
    } else if (window.DeviceOrientationEvent) listen();
  } catch {}
}

function routeHeading() {
  if (!walk) return 0;
  const p = pointAt(walk.route, walk.progress), q = pointAt(walk.route, walk.progress + 40);
  return dist(p, q) > 1 ? bearing(p, q) : heading.target;
}
function headingTick() {
  heading.raf = requestAnimationFrame(headingTick);
  if (!walk) return;
  const mode = heading.mode === "compass" && heading.compass == null ? "route" : heading.mode;
  heading.target = mode === "north" ? 0 : mode === "compass" ? heading.compass : routeHeading();
  // 少しずつ近づけて、地図がガタガタ回らないようにする
  let diff = ((heading.target - heading.shown + 540) % 360) - 180;
  if (Math.abs(diff) < 0.3) return;
  heading.shown = (heading.shown + diff * 0.15 + 360) % 360;
  $("#walkMap").style.transform = `translate(-50%, -50%) rotate(${-heading.shown}deg)`;
  const me = document.querySelector(".me svg");
  if (me) me.style.transform = `rotate(${heading.shown}deg)`;
  $("#btnHeading").style.transform = `rotate(${-heading.shown}deg)`;
}
function cycleHeading() {
  heading.mode = heading.mode === "north" ? "compass" : "north";
  store.set("headingMode", heading.mode);
  $("#btnHeading").textContent = heading.mode === "north" ? "N" : "↑";
  toast(heading.mode === "north" ? "北が上の地図にしました" : heading.compass == null ? "進む方向が上の地図にしました" : "向いている方向が上の地図にしました");
}

// 回転しても四隅が欠けないよう、表示枠の対角線の長さの正方形にする
function sizeWalkMap() {
  const wrap = $("#mapWrap"), w = wrap.clientWidth, h = wrap.clientHeight;
  const d = Math.ceil(Math.sqrt(w * w + h * h));
  const el = $("#walkMap");
  el.style.width = d + "px"; el.style.height = d + "px";
  if (walkMap) walkMap.invalidateSize();
}
window.addEventListener("resize", () => { if (walk) sizeWalkMap(); });

// ---------- 曲がり角の知らせ ----------
let audioCtx = null, wakeLock = null;
function unlockAudio() {
  try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
}
function chime() {
  if (!audioCtx) return;
  [880, 1175].forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + i * 0.16;
    o.frequency.value = f; o.type = "sine";
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.45);
  });
}
// iOS 18以降のSafariは、スイッチ型のチェックボックスを切り替えると軽く振動する。それを利用する（効かない機種もある）
function iosHaptic() {
  try {
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.setAttribute("switch", "");
    label.appendChild(input); label.style.display = "none";
    document.body.appendChild(label); label.click(); label.remove();
  } catch {}
}
function alertTurn(t) {
  chime();
  buzz(t.dir.includes("右") ? [300] : [120, 100, 120]);
  iosHaptic(); setTimeout(iosHaptic, 180);
  const head = $(".walkhead");
  head.classList.remove("alert"); void head.offsetWidth; head.classList.add("alert");
}
async function keepAwake() {
  try { if ("wakeLock" in navigator && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}

// ---------- 散歩中 ----------
let walkMap, walkLayer, walkTrackLine, walkMe;

function startWalk(sim) {
  requestCompass();
  if (plan.turnAlert) unlockAudio();
  const route = plan.route;
  const night = isNightWalk(Date.now(), route.total / WALK_SPEED / 60, plan.home);
  walk = {
    id: "w" + Date.now(), startedAt: Date.now(), sim, route, seed: plan.seed, night,
    stopName: plan.chosen && plan.stop !== "none" ? plan.chosen.name : null,
    stopMission: plan.chosen && plan.stop !== "none" ? STOP_TYPES[plan.chosen.type || plan.stop].mission : null,
    progress: 0, track: [plan.home], pos: plan.home, lastFixAt: Date.now(),
    events: missionPlan(plan.seed, route.total, plan.interval, route.stopAlong, night), eventIdx: 0,
    turnAlert: plan.turnAlert, alerted: [],
    inbox: [], results: [], photos: 0,
    stopArrived: false, resting: false, restMs: 0, restStart: 0, off: 0, simAlong: 0, done: false,
  };
  buzz(100);
  resumeWalkSession();
}

// 散歩画面を開き、位置の取得を始める（再読み込みからの復帰でも使う）
function resumeWalkSession() {
  showView("walk");
  $("#simBadge").hidden = !walk.sim;
  $("#nightBadge").hidden = !walk.night;
  $("#btnHeading").textContent = heading.mode === "north" ? "N" : "↑";
  if (!walkMap) {
    walkMap = makeMap($("#walkMap"), { dragging: false, touchZoom: "center", scrollWheelZoom: "center", doubleClickZoom: "center", tap: false });
    walkLayer = L.layerGroup().addTo(walkMap);
    walkTrackLine = L.polyline([], { color: TRACK_COLOR, weight: 5 }).addTo(walkMap);
    walkMe = L.marker(walk.pos, { icon: L.divIcon({ className: "me", iconSize: [34, 34], html: `<svg viewBox="0 0 34 34"><path d="M17 2 24 13H10Z" fill="${TRACK_COLOR}"/><circle cx="17" cy="18" r="8" fill="${TRACK_COLOR}" stroke="#fff" stroke-width="3"/></svg>` }), interactive: false, zIndexOffset: 1000 }).addTo(walkMap);
  }
  drawWalkRoute();
  walkTrackLine.setLatLngs(walk.track); walkMe.setLatLng(walk.pos);
  requestAnimationFrame(() => { sizeWalkMap(); walkMap.setView(walk.pos, 17, { animate: false }); });
  $("#restCard").hidden = !walk.resting;
  if (walk.resting) $("#restText").textContent = `${walk.stopName}で休憩中です。`;
  renderCard(); renderThumbs();

  if (walk.sim) { walk.simAlong = Math.max(walk.simAlong, walk.progress); walk.simTimer = setInterval(simStep, 500); }
  else startWatch();
  walk.tick = setInterval(updateWalkUI, 5000);
  cancelAnimationFrame(heading.raf); headingTick();
  if (walk.turnAlert) {
    keepAwake();
    // 読み込み直したあとは、画面に触れるまで音が鳴らせない
    if (!audioCtx || audioCtx.state !== "running") document.addEventListener("pointerdown", unlockAudio, { once: true });
  }
  updateWalkUI();
}
function drawWalkRoute() {
  walkLayer.clearLayers();
  L.polyline(walk.route.coords, { color: ROUTE_COLOR, weight: 7, opacity: 0.7 }).addTo(walkLayer);
  addDirArrows(walkLayer, walk.route, 150);
}

function startWatch() {
  if (walk.watch != null) navigator.geolocation.clearWatch(walk.watch);
  walk.watch = navigator.geolocation.watchPosition((p) => {
    if (p.coords.accuracy > 60) return;
    onPosition([p.coords.latitude, p.coords.longitude]);
  }, () => toast("現在地を取得できません。位置情報の許可を確認してください", true), { enableHighAccuracy: true, maximumAge: 2000 });
}

// 画面を閉じて開き直したら、すぐに現在地を取り直す
document.addEventListener("visibilitychange", () => {
  if (!walk || walk.done || document.visibilityState !== "visible") return;
  if (!walk.sim) { startWatch(); getPosition().then(onPosition).catch(() => {}); }
  if (walk.turnAlert) { keepAwake(); unlockAudio(); }
  sizeWalkMap();
  updateWalkUI();
});

function saveActive() {
  if (!walk) return;
  const { tick, simTimer, watch, ...data } = walk;
  store.set("active", data);
}

function simStep() {
  if (!walk.resting) walk.simAlong = Math.min(walk.route.total, walk.simAlong + WALK_SPEED * SIM_SPEED * 0.5);
  onPosition(pointAt(walk.route, walk.simAlong));
}

// ルート上のどこにいるか。しばらく位置が取れていなかったときは先の方まで探す
function locate(p, wide) {
  const { coords, cum } = walk.route;
  const from = walk.progress - 60, to = wide ? Infinity : walk.progress + 400;
  let best = { d: Infinity, along: walk.progress }, firstNear = null;
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] < from) continue;
    if (cum[i - 1] > to) break;
    const pr = project(p, coords[i - 1], coords[i]);
    const along = cum[i - 1] + (cum[i] - cum[i - 1]) * pr.t;
    if (pr.d < best.d) best = { d: pr.d, along };
    // 行きと帰りで同じ道を通るときは、手前の方を採用する
    if (wide && !firstNear && pr.d < 45) firstNear = { d: pr.d, along };
  }
  return firstNear || best;
}

function onPosition(p) {
  if (!walk || walk.done) return;
  const gap = Date.now() - walk.lastFixAt > 20000;
  walk.lastFixAt = Date.now();
  walk.pos = p;
  const last = walk.track[walk.track.length - 1];
  if (dist(last, p) > 5) { walk.track.push(p); walkTrackLine.addLatLng(p); }
  walkMe.setLatLng(p);
  walkMap.setView(p, walkMap.getZoom(), { animate: false });

  // 休憩中は、お店から離れたら自動で再開
  if (walk.resting) {
    if (dist(p, walk.route.waypoints[walk.route.stopIndex]) > 80) resumeFromRest();
    saveActive();
    return;
  }

  const best = locate(p, gap);
  if (best.d < 45) {
    walk.off = 0; $("#offRoute").hidden = true;
    if (best.along > walk.progress) walk.progress = best.along;
  } else if (++walk.off >= 3) {
    $("#offRoute").hidden = false;
  }

  const r = walk.route, prog = walk.progress;

  // 曲がり角の35m手前で知らせる
  if (walk.turnAlert) {
    r.turns.forEach((t, i) => {
      const ahead = t.along - prog;
      if (ahead > 0 && ahead < 35 && !walk.alerted.includes(i)) { walk.alerted.push(i); alertTurn(t); }
    });
  }

  // 寄り道先に到着
  if (r.stopAlong != null && !walk.stopArrived && prog >= r.stopAlong - 25) arriveStop();

  // 通り過ぎたお題を届ける（画面を閉じていた間の分もまとめて）
  let arrived = 0;
  while (walk.eventIdx < walk.events.length && walk.events[walk.eventIdx].at <= prog) {
    walk.inbox.push({ ...walk.events[walk.eventIdx++], arrivedAt: Date.now() });
    arrived++;
  }
  if (arrived) { buzz([80, 60, 160]); renderCard(); }

  // 帰宅
  if (prog >= r.total - 25 && prog > r.total * 0.5) return finishWalk();
  saveActive();
  updateWalkUI();
}

function arriveStop() {
  walk.stopArrived = true; walk.resting = true; walk.restStart = Date.now();
  const pool = MISSIONS[walk.stopMission] || MISSIONS.stop;
  pool.forEach((x, i) => walk.inbox.push({ ...x, id: "s" + i, arrivedAt: Date.now() }));
  $("#restText").textContent = `${walk.stopName}に着きました。ゆっくり休憩してください。お店から離れると、案内に戻ります。`;
  $("#restCard").hidden = false;
  buzz([200, 100, 200]);
  renderCard();
  if (walk.sim) setTimeout(() => walk && walk.resting && resumeFromRest(), 6000);
}
function resumeFromRest() {
  if (!walk.resting) return;
  walk.resting = false; walk.restMs += Date.now() - walk.restStart;
  $("#restCard").hidden = true;
  saveActive();
}

// ---------- お題カード（1枚ずつ） ----------
function renderCard() {
  const m = walk.inbox[0];
  $("#missionCard").hidden = !m;
  if (!m) return updateWalkUI();
  const k = KINDS[m.kind];
  $("#missionKind").textContent = m.kind === "talk" ? `${k.label}・${TALK_CATS[m.cat]}` : k.label;
  $("#missionKind").className = "kind " + m.kind;
  $("#missionText").textContent = m.text;
  $("#missionMore").textContent = walk.inbox.length > 1 ? `ほかに${walk.inbox.length - 1}つ届いています` : "";
  $("#btnShoot").hidden = !k.shoot;
  $("#btnDone").textContent = k.done;
  updateWalkUI();
}
function resolve(outcome) {
  const m = walk.inbox.shift();
  if (!m) return;
  walk.results.push({ id: m.id, kind: m.kind, cat: m.cat || null, text: m.text, outcome });
  if (outcome === "done") toast(m.kind === "talk" ? "いい時間でしたね" : "ナイス観察！");
  renderCard(); saveActive();
}

function updateWalkUI() {
  if (!walk) return;
  const r = walk.route, prog = walk.progress;
  const next = r.turns.find((t) => t.along > prog + 3);
  if (walk.resting) {
    $("#nextArrow").textContent = "…"; $("#nextText").textContent = "休憩中"; $("#nextSub").textContent = walk.stopName || "";
  } else if (next) {
    $("#nextArrow").textContent = next.arrow;
    $("#nextText").textContent = `${fmtDist(next.along - prog)}先 ${next.dir}`;
    $("#nextSub").textContent = [next.then ? `すぐに${next.then}` : "", next.name ? `${next.name}へ` : ""].filter(Boolean).join("・");
  } else {
    $("#nextArrow").textContent = "⌂"; $("#nextText").textContent = "このまま家へ"; $("#nextSub").textContent = "";
  }
  $("#statRemain").textContent = `${fmtKm(Math.max(0, r.total - prog))}km`;
  const elapsed = (Date.now() - walk.startedAt) * (walk.sim ? SIM_SPEED : 1);
  $("#statTime").textContent = `${Math.floor(elapsed / 60000)}分経過`;
  const ev = walk.events[walk.eventIdx];
  $("#idleCard").hidden = walk.inbox.length > 0 || walk.resting;
  $("#idleText").textContent = ev ? `次のお題は ${fmtDist(ev.at - prog)} 先で届きます` : "今日のお題はここまで。家までの道を楽しんで";
}

async function reroute() {
  const r = walk.route;
  const legIdx = r.legEnds.findIndex((e) => e > walk.progress);
  const rest = r.waypoints.slice(legIdx + 1);
  const pts = [walk.pos, ...rest];
  let stopIndex = null;
  if (r.stopIndex != null && !walk.stopArrived && r.stopIndex >= legIdx + 1) stopIndex = r.stopIndex - legIdx;
  $("#btnReroute").disabled = true;
  try {
    const nr = shapeRoute(await osrm(pts), pts, stopIndex);
    // まだ届いていないお題は、新しい道の上で同じ順番に並べ直す
    const remaining = walk.events.slice(walk.eventIdx);
    const shift = remaining.length ? remaining[0].at - walk.progress : 0;
    const step = remaining.length > 1 ? remaining[1].at - remaining[0].at : 0;
    remaining.forEach((e, i) => (e.at = Math.min(nr.total * 0.9, Math.max(50, shift) + step * i)));
    walk.events = remaining; walk.eventIdx = 0;
    walk.route = nr; walk.progress = 0; walk.simAlong = 0; walk.off = 0; walk.alerted = [];
    drawWalkRoute();
    $("#offRoute").hidden = true;
    toast("ここからの道を引き直しました");
    saveActive(); updateWalkUI();
  } catch (e) { toast(e.message, true); }
  finally { $("#btnReroute").disabled = false; }
}

async function finishWalk(early) {
  if (!walk || walk.done) return;
  walk.done = true;
  clearInterval(walk.tick); clearInterval(walk.simTimer); cancelAnimationFrame(heading.raf);
  try { wakeLock && wakeLock.release(); } catch {}
  if (walk.watch != null) navigator.geolocation.clearWatch(walk.watch);
  const w = walk;
  const elapsed = (Date.now() - w.startedAt - w.restMs) * (w.sim ? SIM_SPEED : 1);
  // 届いたまま手をつけなかったお題も「飛ばした」として残す
  w.inbox.forEach((m) => w.results.push({ id: m.id, kind: m.kind, cat: m.cat || null, text: m.text, outcome: "skip" }));
  const record = {
    id: w.id, startedAt: w.startedAt, endedAt: Date.now(), minutes: Math.round(elapsed / 60000),
    distance: Math.round(early ? w.progress : w.route.total), stopName: w.stopName,
    route: w.route.coords.filter((_, i) => i % 3 === 0), track: w.track, photos: w.photos,
    results: w.results, sim: w.sim, night: !!w.night,
  };
  // この散歩で新しく取ったバッジと、上がった称号を記録しておく
  try {
    const before = await allWalks();
    const s0 = badgeStats(before), s1 = badgeStats([...before, record]);
    const had = new Set(earnedBadges(s0));
    record.newBadges = earnedBadges(s1).filter((id) => !had.has(id));
    const t0 = titleFor(s0.pts), t1 = titleFor(s1.pts);
    record.newTitle = t1.name !== t0.name ? t1.name : null;
    await putWalk(record);
  } catch (e) {
    toast("散歩の記録を保存できませんでした：" + (e && e.message), true);
  }
  store.del("active");
  buzz([200, 100, 400]);
  walk = null;
  openDetail(record.id);
}

// ---------- 写真 ----------
// iPhoneのSafariでは、写真をBlobのままブラウザに保存すると失敗することがあるため、
// 縮小したJPEGをArrayBufferにして保存する
let photoFor = null;
async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {}
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("写真を読み込めませんでした")); };
    img.src = url;
  });
}
async function shrink(file, max = 1600) {
  try {
    const img = await decodeImage(file);
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
    if (blob) return blob;
  } catch {}
  return file; // 縮小できなければ元の写真をそのまま使う
}
const toBuffer = (blob) => (blob.arrayBuffer ? blob.arrayBuffer() : new Promise((res, rej) => {
  const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(blob);
}));

async function onPhoto(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!walk) return toast("写真は散歩中に撮れます", true);
  const mission = photoFor;
  photoFor = null;
  toast("写真を保存しています…");
  try {
    const blob = await shrink(file);
    const data = await toBuffer(blob);
    await addPhoto({ walkId: walk.id, data, type: blob.type || "image/jpeg", mission, pos: walk.pos, at: Date.now() });
    walk.photos++;
    saveActive();
    toast("写真を保存しました");
    renderThumbs();
  } catch (err) {
    toast("写真を保存できませんでした：" + (err && (err.message || err.name)), true);
  }
}
async function renderThumbs() {
  if (!walk) return;
  const box = $("#thumbs");
  const ps = await photosOf(walk.id).catch(() => []);
  box.innerHTML = "";
  ps.slice(-8).reverse().forEach((p) => {
    const b = document.createElement("button");
    b.style.backgroundImage = `url(${blobUrl(photoBlob(p))})`;
    b.setAttribute("aria-label", "写真を見る");
    b.onclick = () => openViewer(p);
    box.appendChild(b);
  });
}

// 写真を大きく表示して、カメラロールに保存・共有できるようにする
let viewing = null;
function openViewer(p) {
  viewing = p;
  $("#viewerImg").src = blobUrl(photoBlob(p));
  $("#viewerCap").textContent = p.mission || "自由に撮った写真";
  $("#viewer").hidden = false;
}
async function savePhoto() {
  if (!viewing) return;
  const file = new File([photoBlob(viewing)], `futari-sanpo-${viewing.at}.jpg`, { type: "image/jpeg" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  toast("この端末では保存ボタンが使えません。写真を長押しして保存してください", true);
}

// ---------- アルバム ----------
const objectUrls = [];
const blobUrl = (b) => { const u = URL.createObjectURL(b); objectUrls.push(u); return u; };
function releaseUrls() { while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop()); }

function stamp(b, on) {
  const el = document.createElement("div");
  el.className = "badge" + (on ? " on" : "");
  el.innerHTML = '<span class="seal"></span><span class="bname"></span><span class="bdesc"></span>';
  el.querySelector(".seal").textContent = b.mark;
  el.querySelector(".bname").textContent = b.name;
  return el;
}
function renderBadges(walks) {
  const s = badgeStats(walks), t = titleFor(s.pts), have = new Set(earnedBadges(s));
  $("#titleName").textContent = t.name;
  $("#titlePts").textContent = `気づき ${s.pts}`;
  const pct = t.next ? ((s.pts - t.pts) / (t.next.pts - t.pts)) * 100 : 100;
  $("#titleBar").style.width = `${Math.min(100, pct)}%`;
  $("#titleNext").textContent = t.next ? `あと${t.next.pts - s.pts}個の気づきで「${t.next.name}」` : "いちばん上の称号です";
  $("#badgeCount").textContent = `${have.size} / ${BADGES.length}`;
  const grid = $("#badgeGrid");
  grid.innerHTML = "";
  BADGES.forEach((b) => {
    const on = have.has(b.id), el = stamp(b, on);
    el.querySelector(".bdesc").textContent = on ? b.desc : `${b.desc}（${Math.min(b.get(s), b.need)}/${b.need}）`;
    grid.appendChild(el);
  });
}

async function renderAlbum() {
  releaseUrls();
  const box = $("#albumList");
  const walks = (await allWalks()).sort((a, b) => b.startedAt - a.startedAt);
  renderBadges(walks);
  box.innerHTML = "";
  if (!walks.length) { box.innerHTML = '<p class="empty">まだ散歩の記録はありません。<br>散歩から帰ると、ここに道のりと写真、今日の気づきが残ります。</p>'; return; }
  for (const w of walks) {
    const ps = await photosOf(w.id);
    const b = document.createElement("button");
    b.className = "walkitem";
    b.innerHTML = '<div class="thumb"></div><div><div class="t"></div><div class="m"></div></div>';
    if (ps[0]) b.querySelector(".thumb").style.backgroundImage = `url(${blobUrl(photoBlob(ps[0]))})`;
    b.querySelector(".t").textContent = `${fmtDate(w.startedAt)}${w.stopName ? "・" + w.stopName : ""}`;
    const done = (w.results || []).filter((r) => r.outcome === "done").length;
    b.querySelector(".m").textContent = `${fmtKm(w.distance)}km ・ ${w.minutes}分 ・ 気づき${done} ・ 写真${ps.length}枚${w.sim ? " ・ 試し" : ""}`;
    b.onclick = () => openDetail(w.id);
    box.appendChild(b);
  }
}

let detailMap, detailLayer;
async function openDetail(id) {
  showView("detail");
  releaseUrls();
  const w = await getWalk(id);
  if (!w) return showView("album");
  const ps = await photosOf(id);
  $("#detailTitle").textContent = `${fmtDate(w.startedAt)}の散歩`;
  $("#detailMeta").textContent = `${fmtTime(w.startedAt)}〜${fmtTime(w.endedAt)} ・ ${fmtKm(w.distance)}km${w.stopName ? " ・ " + w.stopName + "に寄り道" : ""}${w.night ? " ・ 夜さんぽ" : ""}`;
  const fresh = (w.newBadges || []).map((bid) => BADGES.find((b) => b.id === bid)).filter(Boolean);
  $("#detailNew").hidden = !fresh.length && !w.newTitle;
  $("#newTitle").hidden = !w.newTitle;
  if (w.newTitle) $("#newTitle").textContent = `称号が「${w.newTitle}」になりました`;
  $("#newBadges").innerHTML = "";
  fresh.forEach((b) => { const el = stamp(b, true); el.querySelector(".bdesc").textContent = b.desc; $("#newBadges").appendChild(el); });

  if (!detailMap) { detailMap = makeMap($("#detailMap")); detailLayer = L.layerGroup().addTo(detailMap); }
  detailLayer.clearLayers();
  setTimeout(() => {
    detailMap.invalidateSize();
    const routeLine = L.polyline(w.route, { color: ROUTE_COLOR, weight: 4, opacity: 0.4 }).addTo(detailLayer);
    if (w.track.length > 1) L.polyline(w.track, { color: TRACK_COLOR, weight: 4 }).addTo(detailLayer);
    ps.forEach((p) => { if (p.pos) L.circleMarker(p.pos, dot(TRACK_COLOR, 7)).addTo(detailLayer).on("click", () => openViewer(p)); });
    detailMap.fitBounds(routeLine.getBounds(), { padding: [16, 16] });
  }, 50);

  const grid = $("#detailPhotos");
  grid.innerHTML = "";
  ps.forEach((p) => {
    const b = document.createElement("button");
    b.style.backgroundImage = `url(${blobUrl(photoBlob(p))})`;
    b.setAttribute("aria-label", p.mission || "写真");
    b.onclick = () => openViewer(p);
    grid.appendChild(b);
  });

  const done = (w.results || []).filter((r) => r.outcome === "done");
  $("#detailLog").hidden = !done.length;
  $("#logList").innerHTML = "";
  done.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = '<span class="k"></span><span></span>';
    li.firstChild.textContent = r.kind === "talk" ? "話した" : "見つけた";
    li.lastChild.textContent = r.text;
    $("#logList").appendChild(li);
  });
}

// ---------- 使い方 ----------
const GUIDE = [
  { step: "1 / 5", title: "ルートを作る", pic: "家 → 寄り道 → 家", items: [
    "地図をタップするか「現在地にする」で、自宅を設定します",
    "歩く時間と寄り道先を選んで「ルートを作る」",
    "地図の青い矢印が進む向きです。時計回りか反時計回りかも表示されます",
  ] },
  { step: "2 / 5", title: "ふたりで同じ散歩に", pic: "リンクを送る → 開いて出発", items: [
    "「パートナーに送る」で、LINEなどからリンクを送ります",
    "相手はそのリンクを開いて「出発する」を押します",
    "二人とも、同じ場所で同じお題が届きます",
  ] },
  { step: "3 / 5", title: "歩いているとき", pic: "↑", items: [
    "地図は、向いている方向が上になるように回ります。出発時の「方向へのアクセス」は「許可」を",
    "画面は閉じてOK。開いたときに、通り過ぎた分のお題もまとめて出ます",
    "曲がり角は画面の上に出ます。「曲がり角で知らせる」をオンにすると、手前で音と画面の点滅で知らせます（画面はつけたままになります）",
    "暗い道や車の多い道では、立ち止まって画面を見てください",
  ] },
  { step: "4 / 5", title: "お題は2種類", pic: "観察 ＋ 会話のタネ", items: [
    "「観察」は、ふだん見過ごしている細かいところに目を向けるお題です",
    "「会話のタネ」は、歩きながらゆっくり話したい質問です",
    "できたら「見つけた」「話した」。気分じゃなければ「次へ」で飛ばせます",
  ] },
  { step: "5 / 5", title: "写真とアルバム", pic: "撮る → アルバム", items: [
    "右下のカメラボタンか、お題の「撮る」で撮影します",
    "写真はこのアプリの中に保存されます。カメラロールに残したい写真は、アルバムで写真を開いて保存してください",
    "帰ると、道のり・写真・今日の気づき・バッジがアルバムに残ります",
  ] },
];
let guidePage = 0;
function openGuide() { guidePage = 0; renderGuide(); $("#guide").hidden = false; }
function closeGuide() { $("#guide").hidden = true; store.set("guideSeen", 1); }
function renderGuide() {
  const g = GUIDE[guidePage];
  const box = $("#guidePages");
  box.innerHTML = '<div class="guidepage"><span class="step"></span><h3></h3><div class="pic"></div><ul></ul></div>';
  box.querySelector(".step").textContent = g.step;
  box.querySelector("h3").textContent = g.title;
  box.querySelector(".pic").textContent = g.pic;
  g.items.forEach((t) => { const li = document.createElement("li"); li.textContent = t; box.querySelector("ul").appendChild(li); });
  $("#guideDots").innerHTML = GUIDE.map((_, i) => `<span class="${i === guidePage ? "on" : ""}"></span>`).join("");
  $("#btnGuideNext").textContent = guidePage === GUIDE.length - 1 ? "はじめる" : "次へ";
}

// ---------- 画面切り替え ----------
function showView(name) {
  ["plan", "walk", "album", "detail"].forEach((v) => ($("#view-" + v).hidden = v !== name));
  $("#tabs").hidden = name === "walk";
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === (name === "detail" ? "album" : name)));
  if (name === "plan" && planMap) setTimeout(() => planMap.invalidateSize(), 50);
  if (name === "album") renderAlbum();
  window.scrollTo(0, 0);
}

function bindSeg(id, key, onChange) {
  const btns = $$(`#${id} button`);
  const paint = () => btns.forEach((b) => b.classList.toggle("on", String(plan[key]) === b.dataset.v));
  btns.forEach((b) => b.onclick = () => {
    plan[key] = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v;
    store.set(key, plan[key]); paint(); onChange && onChange();
  });
  paint();
}

// ---------- 起動 ----------
function init() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  initPlanMap();
  if (plan.home) setHome(plan.home);
  const resetRoute = () => { plan.candidates = []; plan.chosen = null; plan.route = null; renderCandidates(); $("#routeSummary").hidden = true; showPlanError(""); drawPlan(); };
  // 歩く時間は10分〜3時間のスライダー。動かしている間は表示だけ変え、離したらルートを作り直す
  const range = $("#rangeTime");
  range.value = plan.minutes;
  $("#timeLabel").textContent = fmtMinutes(plan.minutes);
  range.addEventListener("input", () => { plan.minutes = +range.value; $("#timeLabel").textContent = fmtMinutes(plan.minutes); });
  range.addEventListener("change", () => { store.set("minutes", plan.minutes); resetRoute(); });
  $("#chkTurn").checked = plan.turnAlert;
  $("#chkTurn").onchange = (e) => { plan.turnAlert = e.target.checked; store.set("turnAlert", plan.turnAlert); if (plan.turnAlert) unlockAudio(); };
  bindSeg("segStop", "stop", resetRoute);
  bindSeg("segInterval", "interval");

  $("#btnHere").onclick = async () => {
    $("#btnHere").disabled = true;
    try { setHome(await getPosition()); } catch (e) { showPlanError(e.message); }
    $("#btnHere").disabled = false;
  };
  $("#btnMake").onclick = onMake;
  $("#btnReroll").onclick = () => { plan.seed = Math.floor(Math.random() * 1e9); buildRoute(); };
  $("#btnShare").onclick = onShare;
  $("#btnStart").onclick = () => startWalk(false);
  $("#btnSim").onclick = () => startWalk(true);

  // カメラは<label for>で開く（iPhoneでいちばん確実な開き方）。開く前にどのお題の写真かを覚えておく
  $("#btnShoot").addEventListener("click", () => { photoFor = walk && walk.inbox[0] ? walk.inbox[0].text : null; });
  $("#btnFree").addEventListener("click", () => { photoFor = null; });
  $("#photoInput").addEventListener("change", onPhoto);
  $("#btnDone").onclick = () => resolve("done");
  $("#btnNext").onclick = () => resolve("skip");
  $("#btnResume").onclick = resumeFromRest;
  $("#btnReroute").onclick = reroute;
  $("#btnHeading").onclick = cycleHeading;
  let endArmed = 0;
  $("#btnEnd").onclick = () => {
    if (Date.now() - endArmed < 4000) return finishWalk(true);
    endArmed = Date.now();
    $("#btnEnd").textContent = "もう一度押すと終了";
    setTimeout(() => ($("#btnEnd").textContent = "終える"), 4000);
  };
  $("#btnBack").onclick = () => showView("album");
  $$("#tabs button").forEach((b) => b.onclick = () => showView(b.dataset.tab));
  $("#btnSavePhoto").onclick = savePhoto;
  $("#btnCloseViewer").onclick = () => ($("#viewer").hidden = true);
  $("#viewer").onclick = (e) => { if (e.target.id === "viewer") $("#viewer").hidden = true; };
  $("#btnHelp1").onclick = openGuide;
  $("#btnHelp2").onclick = openGuide;
  $("#btnGuideNext").onclick = () => { if (guidePage < GUIDE.length - 1) { guidePage++; renderGuide(); } else closeGuide(); };
  $("#btnGuideSkip").onclick = closeGuide;

  // 散歩の途中でページが読み込み直されたら、続きから再開する
  const active = store.get("active", null);
  if (active && active.results && Date.now() - active.startedAt < 6 * 3600e3) {
    walk = { alerted: [], ...active, lastFixAt: 0 };
    resumeWalkSession();
    toast("散歩の続きから再開しました");
    return;
  }
  store.del("active");
  if (!store.get("guideSeen", 0)) openGuide();
  loadShared();
}
init();
