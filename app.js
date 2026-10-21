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
  });
}
const putWalk = (w) => idb("walks", "readwrite", (s) => s.put(w));
const allWalks = () => idb("walks", "readonly", (s) => s.getAll());
const getWalk = (id) => idb("walks", "readonly", (s) => s.get(id));
const addPhoto = (p) => idb("photos", "readwrite", (s) => s.add(p));
const photosOf = (walkId) => idb("photos", "readonly", (s) => s.index("walkId").getAll(walkId));

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
const fmtDate = (t) => new Date(t).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }

let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- 状態 ----------
const plan = {
  home: store.get("home", null),
  minutes: store.get("minutes", 60),
  stop: store.get("stop", "cafe"),
  interval: store.get("interval", 8),
  candidates: [],
  chosen: null,
  seed: Math.floor(Math.random() * 1e9),
  route: null,
  shared: false,
  role: "A",
};
let walk = null;

// ---------- 地図 ----------
const tileUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const tileOpt = { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" };
function makeMap(el) {
  const m = L.map(el, { zoomControl: false, attributionControl: true }).setView(plan.home || [35.681, 139.767], plan.home ? 15 : 12);
  L.tileLayer(tileUrl, tileOpt).addTo(m);
  return m;
}
const dot = (color, r = 8) => ({ radius: r, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 });
// 地図タイルは明るいままなので、線の色はテーマによらず濃い色で固定する
const ACCENT = () => "#1d5c8f";
const AMBER = () => "#e0791a";

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
    const line = L.polyline(plan.route.coords, { color: ACCENT(), weight: 6, opacity: 0.85 }).addTo(planLayer);
    planMap.fitBounds(line.getBounds(), { padding: [24, 24] });
  }
  plan.candidates.forEach((c) => {
    const on = plan.chosen && plan.chosen.id === c.id;
    L.circleMarker(c.pos, dot(on ? AMBER() : "#8a968f", on ? 9 : 6)).bindTooltip(c.name).addTo(planLayer)
      .on("click", () => chooseCandidate(c));
  });
  if (plan.home) L.circleMarker(plan.home, dot(ACCENT(), 9)).bindTooltip("自宅").addTo(planLayer);
}

// ---------- ルート作成 ----------
function setHome(p) {
  plan.home = p; store.set("home", p);
  $("#homeLabel").textContent = `設定済み（${p[0].toFixed(4)}, ${p[1].toFixed(4)}）`;
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

async function findCandidates() {
  const t = STOP_TYPES[plan.stop];
  if (!t.q) return [];
  const r = legRadius(), [lat, lon] = plan.home;
  // お店はそうそう変わらないので、自宅・種類・時間ごとに1週間保存して使い回す
  const cacheKey = `poi:${plan.stop}:${plan.minutes}:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = store.get(cacheKey, null);
  let places = cached && Date.now() - cached.at < 7 * 864e5 ? cached.places : null;
  if (!places) {
    // 検索サービスはどれも混むことがあるので、順に試して最初に取れたものを使う
    for (const source of [fromPhoton, fromOverpass, fromNominatim]) {
      try { places = await source(t, plan.home, r); } catch { places = null; }
      if (places && places.length) break;
    }
    if (!places) throw new Error("お店の情報を取得できませんでした。電波の良いところで、少し待ってからもう一度お試しください");
    store.set(cacheKey, { at: Date.now(), places });
  }
  const seen = new Set();
  return places
    .filter((p) => p.name && (!t.name || t.name.test(p.name)) && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ ...p, d: dist(plan.home, p.pos) }))
    .filter((c) => c.d > r * 0.35 && c.d < r * 1.6)
    .sort((a, b) => Math.abs(a.d - r) - Math.abs(b.d - r))
    .slice(0, 6);
}

function renderCandidates() {
  const box = $("#candidates");
  box.innerHTML = "";
  if (plan.stop === "none") return;
  if (!plan.candidates.length) { box.innerHTML = '<p class="hint">ちょうどいい距離に見つかりませんでした。歩く時間か寄り道先を変えてみてください。</p>'; return; }
  plan.candidates.forEach((c) => {
    const b = document.createElement("button");
    b.className = plan.chosen && plan.chosen.id === c.id ? "on" : "";
    b.innerHTML = `<span></span><span class="d">家から${fmtKm(c.d)}km</span>`;
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
    let f = 1, pts = wps(f), route = await osrm(pts);
    // 距離が目標から大きくずれたら、経由地の距離を1回だけ調整する
    const ratio = loopMeters() / route.distance;
    if (Math.abs(ratio - 1) > 0.2) {
      f = Math.max(0.3, Math.min(2.2, 1 + (ratio - 1) * (stopIndex ? 1.6 : 1)));
      pts = wps(f);
      route = await osrm(pts);
    }
    plan.route = shapeRoute(route, pts, stopIndex);
    showSummary();
    drawPlan();
  } catch (e) {
    showPlanError(e.message);
  } finally {
    $("#btnMake").disabled = false; $("#btnMake").textContent = "ルートを作る";
  }
}

function showSummary() {
  const r = plan.route;
  $("#sumDist").textContent = fmtKm(r.total);
  $("#sumTime").textContent = Math.round(r.total / WALK_SPEED / 60);
  $("#sumStop").textContent = plan.chosen && plan.stop !== "none" ? `寄り道：${plan.chosen.name}` : "寄り道なしの周回ルート";
  const { sunset } = sunTimes(new Date(), plan.home[0], plan.home[1]);
  const night = isNightWalk(Date.now(), r.total / WALK_SPEED / 60, plan.home);
  $("#sumSun").textContent = night ? `今日の日の入りは${fmtTime(sunset)}。いま出発すると「夜さんぽ」のお題になります` : `今日の日の入りは${fmtTime(sunset)}。日が暮れてから出発すると、夜用のお題になります`;
  $("#routeSummary").hidden = false;
}
function showPlanError(msg) { $("#planError").textContent = msg; $("#planError").hidden = !msg; }

async function onMake() {
  if (!plan.home) return showPlanError("先に自宅を設定してください");
  if (plan.stop === "none") { plan.chosen = null; return buildRoute(); }
  $("#btnMake").disabled = true; $("#btnMake").textContent = `${STOP_TYPES[plan.stop].label}を探しています…`;
  try {
    plan.candidates = await findCandidates();
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
    c: plan.chosen && plan.stop !== "none" ? { n: plan.chosen.name, p: plan.chosen.pos.map((v) => +v.toFixed(5)), id: plan.chosen.id } : null,
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
  catch { toast("コピーできませんでした"); }
}
async function loadShared() {
  const m = location.hash.match(/^#r=(.+)$/);
  if (!m) return false;
  try {
    const p = JSON.parse(decodeURIComponent(m[1]));
    Object.assign(plan, { home: p.h, minutes: p.m, interval: p.i, seed: p.s, stop: p.st, shared: true, role: "B" });
    plan.chosen = p.c ? { id: p.c.id, name: p.c.n, pos: p.c.p, d: dist(p.h, p.c.p) } : null;
    plan.candidates = plan.chosen ? [plan.chosen] : [];
    $("#sharedBanner").hidden = false;
    $("#planForm").hidden = true;
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
  const pools = {};
  Object.keys(MODES).forEach((k) => (pools[k] = shuffle(MISSIONS[k].filter(fits(night)).map((m) => ({ mode: k, ...m })), r)));
  // 季節のお題を、同じ種類の山に混ぜる
  MISSIONS.season[seasonKey(new Date().getMonth() + 1)].filter(fits(night)).forEach((m) => pools[m.mode].splice(Math.floor(r() * 3), 0, m));
  const rare = shuffle(MISSIONS.rare.filter(fits(night)), r);
  // 秘密指令は「相手の様子をうかがう」時間が要るので、続けて出さない
  const order = ["secret", "photo", "talk", "hunt", "coop", "quiz", "secret", "game", "photo", "guess", "talk", "coop"];
  const used = {};
  const step = interval * 60 * WALK_SPEED;
  const events = [];
  for (let at = 250, n = 0; at < total * 0.82; at += step, n++) {
    // 寄り道先の手前・直後とは重ならないようにする
    if (stopAlong != null && Math.abs(at - stopAlong) < 150) continue;
    let m;
    if (n > 0 && r() < 0.12 && rare.length) {
      m = { ...rare.pop(), pts: 3, rare: true };
    } else {
      const mode = order[n % order.length];
      used[mode] = (used[mode] || 0) + 1;
      m = { ...pools[mode][(used[mode] - 1) % pools[mode].length], pts: 1 };
    }
    events.push({ at, ...m, id: "m" + n });
  }
  events.push({ at: total * 0.88, ...MISSIONS.final, id: "final" });
  return events;
}
// 秘密指令は、ルートを作った人(A)と共有リンクを開いた人(B)で中身が変わる
const missionText = (m) => (m.mode === "secret" ? (walk && walk.role === "B" ? m.b : m.a) : m.text);

// ---------- 散歩中 ----------
let walkMap, walkRouteLine, walkTrackLine, walkMe;

function startWalk(sim) {
  const route = plan.route;
  const night = isNightWalk(Date.now(), route.total / WALK_SPEED / 60, plan.home);
  walk = {
    id: "w" + Date.now(), startedAt: Date.now(), sim, route, seed: plan.seed, night, role: plan.role,
    stopName: plan.chosen && plan.stop !== "none" ? plan.chosen.name : null,
    stopMission: STOP_TYPES[plan.stop].mission || null,
    progress: 0, track: [plan.home], pos: plan.home, lastFixAt: Date.now(),
    events: missionPlan(plan.seed, route.total, plan.interval, route.stopAlong, night), eventIdx: 0,
    inbox: [], results: [], me: 0, you: 0, photos: 0,
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
  if (!walkMap) {
    walkMap = makeMap($("#walkMap"));
    walkRouteLine = L.polyline([], { color: ACCENT(), weight: 6, opacity: 0.75 }).addTo(walkMap);
    walkTrackLine = L.polyline([], { color: AMBER(), weight: 5 }).addTo(walkMap);
    walkMe = L.circleMarker(walk.pos, dot(AMBER(), 9)).addTo(walkMap);
  }
  walkRouteLine.setLatLngs(walk.route.coords); walkTrackLine.setLatLngs(walk.track); walkMe.setLatLng(walk.pos);
  setTimeout(() => { walkMap.invalidateSize(); walkMap.setView(walk.pos, 16); }, 50);
  $("#restCard").hidden = !walk.resting;
  if (walk.resting) $("#restText").textContent = `${walk.stopName}で休憩中です。`;
  renderInbox(); renderScore();

  if (walk.sim) { walk.simAlong = Math.max(walk.simAlong, walk.progress); walk.simTimer = setInterval(simStep, 500); }
  else startWatch();
  walk.tick = setInterval(updateWalkUI, 5000);
  updateWalkUI();
}

function startWatch() {
  if (walk.watch != null) navigator.geolocation.clearWatch(walk.watch);
  walk.watch = navigator.geolocation.watchPosition((p) => {
    if (p.coords.accuracy > 60) return;
    onPosition([p.coords.latitude, p.coords.longitude]);
  }, () => toast("現在地を取得できません。位置情報の許可を確認してください"), { enableHighAccuracy: true, maximumAge: 2000 });
}

// 画面を閉じて開き直したら、すぐに現在地を取り直す
document.addEventListener("visibilitychange", () => {
  if (!walk || walk.done || document.visibilityState !== "visible") return;
  if (!walk.sim) { startWatch(); getPosition().then(onPosition).catch(() => {}); }
  if (walkMap) walkMap.invalidateSize();
  updateWalkUI();
});

function saveActive() {
  if (!walk) return;
  const { tick, simTimer, watch, ...data } = walk;
  store.set("active", data);
}

function pointAt(route, along) {
  const { coords, cum } = route;
  let i = cum.findIndex((c) => c >= along);
  if (i <= 0) return coords[Math.max(0, i)];
  const t = (along - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
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
  walkMap.panTo(p, { animate: false });

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

  // 寄り道先に到着
  if (r.stopAlong != null && !walk.stopArrived && prog >= r.stopAlong - 25) arriveStop();

  // 通り過ぎたお題をまとめて届ける（画面を閉じていた間の分も）
  let arrived = 0;
  while (walk.eventIdx < walk.events.length && walk.events[walk.eventIdx].at <= prog) {
    walk.inbox.unshift({ ...walk.events[walk.eventIdx++], arrivedAt: Date.now() });
    arrived++;
  }
  if (arrived) { buzz([80, 60, 80, 60, 200]); renderInbox(); }

  // 帰宅
  if (prog >= r.total - 25 && prog > r.total * 0.5) return finishWalk();
  saveActive();
  updateWalkUI();
}

function arriveStop() {
  walk.stopArrived = true; walk.resting = true; walk.restStart = Date.now();
  const pool = MISSIONS[walk.stopMission] || MISSIONS.stop;
  pool.forEach((x, i) => walk.inbox.unshift({ ...x, pts: x.pts || 1, id: "s" + i, arrivedAt: Date.now() }));
  $("#restText").textContent = `${walk.stopName}に着きました。ゆっくり休憩してください。お店のお題も届いています。`;
  $("#restCard").hidden = false;
  buzz([200, 100, 200]);
  renderInbox();
  if (walk.sim) setTimeout(() => walk && walk.resting && resumeFromRest(), 6000);
}
function resumeFromRest() {
  if (!walk.resting) return;
  walk.resting = false; walk.restMs += Date.now() - walk.restStart;
  $("#restCard").hidden = true;
  saveActive();
}

// ---------- お題カード ----------
function renderInbox() {
  const box = $("#inbox");
  box.innerHTML = "";
  walk.inbox.forEach((m) => {
    const mode = MODES[m.mode];
    const c = document.createElement("div");
    c.className = `card mission${m.rare ? " rare" : ""}${mode.battle ? "" : " coop"}`;
    c.innerHTML = `<div class="head"><span class="tag"></span><span class="ptsbadge"></span></div><p></p><div class="arrived"></div><div class="judge"></div>`;
    c.querySelector(".tag").textContent = (m.rare ? "★ " : "") + mode.label;
    c.querySelector(".ptsbadge").textContent = mode.battle ? `勝つと${m.pts}ポイント` : "勝ち負けなし";
    c.querySelector("p").textContent = missionText(m);
    c.querySelector(".arrived").textContent = `${fmtTime(m.arrivedAt)}に届きました${mode.note ? "・" + mode.note : ""}`;
    if (m.mode === "secret") c.classList.add("secret");
    const j = c.querySelector(".judge");
    const btn = (label, cls, fn) => { const b = document.createElement("button"); b.textContent = label; b.className = cls; b.onclick = fn; j.appendChild(b); };
    if (mode.shoot) btn("撮る", "ghost", () => shoot(m));
    if (mode.battle) {
      btn("わたしの勝ち", "winme", () => resolve(m, "me"));
      btn("あいての勝ち", "winyou", () => resolve(m, "you"));
      btn("引き分け", "ghost draw", () => resolve(m, "draw"));
      btn("やめておく", "ghost skip", () => resolve(m, "skip"));
    } else {
      btn("できた", "winme", () => resolve(m, "done"));
      btn("やめておく", "ghost skip", () => resolve(m, "skip"));
    }
    box.appendChild(c);
  });
  updateWalkUI();
}

function resolve(m, outcome) {
  walk.inbox = walk.inbox.filter((x) => x.id !== m.id);
  walk.results.push({ id: m.id, mode: m.mode, text: missionText(m), pts: m.pts, outcome });
  if (outcome === "me") walk.me += m.pts;
  if (outcome === "you") walk.you += m.pts;
  if (outcome === "me" || outcome === "you") bump(outcome);
  if (outcome === "me") toast(`わたしに${m.pts}ポイント！`);
  else if (outcome === "you") toast(`あいてに${m.pts}ポイント`);
  else if (outcome === "done") toast("ナイス！");
  renderInbox(); renderScore(); saveActive();
}
function renderScore() { $("#scoreMe").textContent = walk.me; $("#scoreYou").textContent = walk.you; }
function bump(who) {
  const el = $(who === "me" ? "#scoreMe" : "#scoreYou");
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}

function updateWalkUI() {
  if (!walk) return;
  const r = walk.route, prog = walk.progress;
  const next = r.turns.find((t) => t.along > prog + 3);
  if (walk.resting) {
    $("#nextArrow").textContent = "☕"; $("#nextText").textContent = "休憩中"; $("#nextSub").textContent = walk.stopName || "";
  } else if (next) {
    $("#nextArrow").textContent = next.arrow;
    $("#nextText").textContent = `${fmtDist(next.along - prog)}先 ${next.dir}`;
    $("#nextSub").textContent = [next.then ? `すぐに${next.then}` : "", next.name ? `${next.name}へ` : ""].filter(Boolean).join("・");
  } else {
    $("#nextArrow").textContent = "⌂"; $("#nextText").textContent = "このまま家へ"; $("#nextSub").textContent = "";
  }
  $("#statRemain").textContent = `${fmtKm(Math.max(0, r.total - prog))}km`;
  const elapsed = (Date.now() - walk.startedAt) * (walk.sim ? SIM_SPEED : 1);
  $("#statTime").textContent = `${Math.floor(elapsed / 60000)}分`;
  $("#statPhotos").textContent = `${walk.photos}枚`;
  const ev = walk.events[walk.eventIdx];
  $("#inboxEmpty").hidden = walk.inbox.length > 0 || !ev;
  if (ev) $("#nextMissionIn").textContent = fmtDist(ev.at - prog);
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
    walk.route = nr; walk.progress = 0; walk.simAlong = 0; walk.off = 0;
    walkRouteLine.setLatLngs(nr.coords);
    $("#offRoute").hidden = true;
    toast("ここからの道を引き直しました");
    saveActive(); updateWalkUI();
  } catch (e) { toast(e.message); }
  finally { $("#btnReroute").disabled = false; }
}

async function finishWalk(early) {
  if (!walk || walk.done) return;
  walk.done = true;
  clearInterval(walk.tick); clearInterval(walk.simTimer);
  if (walk.watch != null) navigator.geolocation.clearWatch(walk.watch);
  const w = walk;
  const elapsed = (Date.now() - w.startedAt - w.restMs) * (w.sim ? SIM_SPEED : 1);
  const record = {
    id: w.id, startedAt: w.startedAt, endedAt: Date.now(), minutes: Math.round(elapsed / 60000),
    distance: Math.round(early ? w.progress : w.route.total), stopName: w.stopName,
    route: w.route.coords.filter((_, i) => i % 3 === 0), track: w.track, photos: w.photos,
    me: w.me, you: w.you, results: w.results,
    penalty: PENALTIES[Math.floor(rng(w.seed ^ 99)() * PENALTIES.length)], sim: w.sim, night: !!w.night,
  };
  // この散歩で新しく取ったバッジと、上がった称号を記録しておく
  const before = await allWalks();
  const s0 = badgeStats(before), s1 = badgeStats([...before, record]);
  const had = new Set(earnedBadges(s0));
  record.newBadges = earnedBadges(s1).filter((id) => !had.has(id));
  const t0 = titleFor(s0.pts), t1 = titleFor(s1.pts);
  record.newTitle = t1.name !== t0.name ? t1.name : null;
  await putWalk(record);
  store.del("active");
  buzz([200, 100, 200, 100, 400]);
  walk = null;
  openDetail(record.id);
}

// ---------- 写真 ----------
let photoFor = null;
function shoot(m) { photoFor = m; $("#photoInput").value = ""; $("#photoInput").click(); }
async function resize(file, max = 1600) {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", 0.85));
}
async function onPhoto(e) {
  const file = e.target.files && e.target.files[0];
  if (!file || !walk) return;
  const blob = await resize(file);
  await addPhoto({ walkId: walk.id, blob, mission: photoFor ? missionText(photoFor) : null, pos: walk.pos, at: Date.now() });
  walk.photos++;
  toast(photoFor && MODES[photoFor.mode].battle ? "保存しました。見せ合って勝敗を決めよう" : "写真を保存しました");
  saveActive(); updateWalkUI();
}

// ---------- アルバム ----------
const objectUrls = [];
const blobUrl = (b) => { const u = URL.createObjectURL(b); objectUrls.push(u); return u; };
function releaseUrls() { while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop()); }

async function renderAlbum() {
  releaseUrls();
  const box = $("#albumList");
  const walks = (await allWalks()).sort((a, b) => b.startedAt - a.startedAt);
  box.innerHTML = "";
  const real = walks.filter((w) => !w.sim && w.me != null);
  $("#albumTotal").hidden = !real.length;
  if (real.length) {
    const wins = real.filter((w) => w.me > w.you).length, loses = real.filter((w) => w.me < w.you).length;
    $("#albumTotal").innerHTML = `<span class="muted">通算成績（${real.length}回）</span><b></b>`;
    $("#albumTotal b").textContent = `${wins}勝 ${loses}敗 ${real.length - wins - loses}分`;
  }
  renderBadges(walks);
  if (!walks.length) { box.innerHTML = '<p class="empty">まだ散歩の記録はありません。<br>最初の散歩に出かけると、ここに写真と勝負の結果が残ります。</p>'; return; }
  for (const w of walks) {
    const ps = await photosOf(w.id);
    const b = document.createElement("button");
    b.className = "walkitem";
    b.innerHTML = '<div class="thumb"></div><div><div class="t"></div><div class="m"></div></div>';
    if (ps[0]) b.querySelector(".thumb").style.backgroundImage = `url(${blobUrl(ps[0].blob)})`;
    b.querySelector(".t").textContent = `${fmtDate(w.startedAt)}${w.stopName ? "・" + w.stopName : ""}`;
    const score = w.me != null ? ` ・ ${w.me}対${w.you}` : "";
    b.querySelector(".m").textContent = `${fmtKm(w.distance)}km ・ ${w.minutes}分${score} ・ 写真${ps.length}枚${w.sim ? " ・ 試し" : ""}`;
    b.onclick = () => openDetail(w.id);
    box.appendChild(b);
  }
}

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
  $("#titlePts").textContent = `${s.pts}ポイント`;
  const pct = t.next ? ((s.pts - t.pts) / (t.next.pts - t.pts)) * 100 : 100;
  $("#titleBar").style.width = `${Math.min(100, pct)}%`;
  $("#titleNext").textContent = t.next ? `あと${t.next.pts - s.pts}ポイントで「${t.next.name}」` : "最高の称号です";
  $("#badgeCount").textContent = `${have.size} / ${BADGES.length}`;
  const grid = $("#badgeGrid");
  grid.innerHTML = "";
  BADGES.forEach((b) => {
    const on = have.has(b.id), el = stamp(b, on);
    el.querySelector(".bdesc").textContent = on ? b.desc : `${b.desc}（${Math.min(b.get(s), b.need)}/${b.need}）`;
    grid.appendChild(el);
  });
}

let detailMap, detailLayer;
async function openDetail(id) {
  showView("detail");
  releaseUrls();
  const w = await getWalk(id), ps = await photosOf(id);
  $("#detailTitle").textContent = `${fmtDate(w.startedAt)}の散歩`;
  $("#detailMeta").textContent = `${fmtTime(w.startedAt)}〜${fmtTime(w.endedAt)} ・ ${fmtKm(w.distance)}km${w.stopName ? " ・ " + w.stopName + "に寄り道" : ""}`;
  $("#detailResult").hidden = w.me == null;
  if (w.me != null) {
    const head = w.me > w.you ? "わたしの勝ち！" : w.me < w.you ? "あいての勝ち！" : "引き分け！";
    $("#resultHead").textContent = head;
    $("#resultScore").textContent = `${w.me} - ${w.you}`;
    $("#resultPenalty").textContent = w.me === w.you ? "今日は引き分け。仲良く何かおいしいものを食べよう" : w.penalty;
  }
  const fresh = (w.newBadges || []).map((id) => BADGES.find((b) => b.id === id)).filter(Boolean);
  $("#detailNew").hidden = !fresh.length && !w.newTitle;
  $("#newTitle").hidden = !w.newTitle;
  if (w.newTitle) $("#newTitle").textContent = `称号が「${w.newTitle}」になりました`;
  $("#newBadges").innerHTML = "";
  fresh.forEach((b) => { const el = stamp(b, true); el.querySelector(".bdesc").textContent = b.desc; $("#newBadges").appendChild(el); });
  $("#detailNight").hidden = !w.night;
  if (!detailMap) { detailMap = makeMap($("#detailMap")); detailLayer = L.layerGroup().addTo(detailMap); }
  detailLayer.clearLayers();
  setTimeout(() => {
    detailMap.invalidateSize();
    const routeLine = L.polyline(w.route, { color: ACCENT(), weight: 4, opacity: 0.4 }).addTo(detailLayer);
    if (w.track.length > 1) L.polyline(w.track, { color: AMBER(), weight: 4 }).addTo(detailLayer);
    ps.forEach((p) => {
      if (!p.pos) return;
      const u = blobUrl(p.blob);
      L.circleMarker(p.pos, dot(AMBER(), 7)).addTo(detailLayer)
        .bindPopup(`<img src="${u}" style="width:160px;border-radius:8px;display:block">`);
    });
    detailMap.fitBounds(routeLine.getBounds(), { padding: [16, 16] });
  }, 50);
  const grid = $("#detailPhotos");
  grid.innerHTML = "";
  if (!ps.length) grid.innerHTML = '<p class="empty">この散歩の写真はありません</p>';
  ps.forEach((p) => {
    const f = document.createElement("figure");
    f.className = "photo";
    f.innerHTML = '<img alt=""><figcaption><span></span><time></time></figcaption>';
    f.querySelector("img").src = blobUrl(p.blob);
    f.querySelector("span").textContent = p.mission || "自由に撮った写真";
    f.querySelector("time").textContent = fmtTime(p.at);
    grid.appendChild(f);
  });
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
  $("#todayLabel").textContent = fmtDate(Date.now());
  initPlanMap();
  if (plan.home) setHome(plan.home);
  const resetRoute = () => { plan.candidates = []; plan.chosen = null; plan.route = null; renderCandidates(); $("#routeSummary").hidden = true; drawPlan(); };
  bindSeg("segTime", "minutes", resetRoute);
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

  $("#btnFree").onclick = () => shoot(null);
  $("#btnResume").onclick = resumeFromRest;
  $("#btnReroute").onclick = reroute;
  let endArmed = 0;
  $("#btnEnd").onclick = () => {
    if (Date.now() - endArmed < 4000) return finishWalk(true);
    endArmed = Date.now();
    $("#btnEnd").textContent = "もう一度押すと終了";
    setTimeout(() => ($("#btnEnd").textContent = "散歩を終える"), 4000);
  };
  $("#photoInput").onchange = onPhoto;
  $("#btnBack").onclick = () => showView("album");
  $$("#tabs button").forEach((b) => b.onclick = () => showView(b.dataset.tab));

  // 散歩の途中でページが読み込み直されたら、続きから再開する
  const active = store.get("active", null);
  if (active && Date.now() - active.startedAt < 6 * 3600e3) {
    walk = { ...active, lastFixAt: 0 };
    resumeWalkSession();
    toast("散歩の続きから再開しました");
    return;
  }
  store.del("active");
  loadShared();
}
init();
