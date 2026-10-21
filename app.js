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
  shrine: { label: "神社・お寺", tag: "amenity:place_of_worship", q: '["amenity"="place_of_worship"]', phrase: "place of worship", mission: "park", name: /神社|寺|宮|稲荷|八幡|天神|観音|不動|地蔵|権現|社$/ },
  none: { label: "寄り道なし" },
};

// ---------- 保存 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("fs:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fs:" + k, JSON.stringify(v)); } catch {} },
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

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, r) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const fmtKm = (m) => (m / 1000).toFixed(1);
const fmtTime = (t) => new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const fmtDate = (t) => new Date(t).toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });

// ---------- 音声・音 ----------
let audioCtx = null, lastSpoken = "";
function unlockAudio() {
  try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {}
  try { speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch {}
}
function chime(kind) {
  if (!audioCtx) return;
  const notes = kind === "mission" ? [784, 988, 1175] : kind === "turn" ? [660, 880] : [523, 659];
  notes.forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + i * 0.14;
    o.frequency.value = f; o.type = "sine";
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.4);
  });
}
function speak(text, opts = {}) {
  lastSpoken = text;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP"; u.rate = 1.02;
    const v = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith("ja"));
    if (v) u.voice = v;
    if (opts.interrupt) speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
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
  topics: store.get("topics", true),
  candidates: [],
  chosen: null,
  seed: Math.floor(Math.random() * 1e9),
  route: null,
  shared: false,
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
  // 30m以内に続く曲がり角は1回の案内にまとめる
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
  return { dir: d[0], arrow: d[1], name: step.name || "", right: m.modifier.includes("right") };
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
    h: plan.home.map((v) => +v.toFixed(5)), m: plan.minutes, i: plan.interval, tp: plan.topics ? 1 : 0, s: plan.seed, st: plan.stop,
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
    Object.assign(plan, { home: p.h, minutes: p.m, interval: p.i, topics: !!p.tp, seed: p.s, stop: p.st, shared: true });
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
// 同じseedなら二人のスマホで同じ順番・同じタイミングになる
function missionPlan(seed, minutes, interval, topics) {
  const r = rng(seed ^ 0x5a5a);
  const season = MISSIONS[seasonKey(new Date().getMonth() + 1)];
  const general = shuffle(MISSIONS.general, r), couple = shuffle(MISSIONS.couple, r), seas = shuffle(season, r), tps = shuffle(TOPICS, r);
  const events = [];
  let gi = 0, ci = 0, si = 0, ti = 0, n = 0;
  for (let t = 3; t < minutes * 0.85; t += interval, n++) {
    const pool = n % 3 === 1 ? [couple, ci++] : n % 4 === 2 && seas.length ? [seas, si++] : [general, gi++];
    events.push({ at: t * 60, kind: "mission", text: pool[0][pool[1] % pool[0].length] });
    if (topics && t + interval / 2 < minutes * 0.85) events.push({ at: (t + interval / 2) * 60, kind: "topic", text: tps[ti++ % tps.length] });
  }
  return events;
}

// ---------- 散歩中 ----------
let walkMap, walkRouteLine, walkTrackLine, walkMe, wakeLock = null;

async function keepAwake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (walk && document.visibilityState === "visible") keepAwake(); });

function startWalk(sim) {
  unlockAudio();
  const route = plan.route;
  const startPos = plan.home;
  walk = {
    id: "w" + Date.now(), startedAt: Date.now(), sim, route,
    stopName: plan.chosen && plan.stop !== "none" ? plan.chosen.name : null,
    stopMission: STOP_TYPES[plan.stop].mission || null,
    progress: 0, announced: new Set(), track: [startPos], walked: 0, clock: 0, lastTick: performance.now(),
    events: missionPlan(plan.seed, plan.minutes, plan.interval, plan.topics), eventIdx: 0,
    current: null, photos: 0, missionsDone: 0, stopArrived: false, resting: false, finalDone: false,
    off: 0, lastOffWarn: 0, pos: startPos, simAlong: 0, done: false,
  };
  showView("walk");
  $("#simBadge").hidden = !sim;
  if (!walkMap) {
    walkMap = makeMap($("#walkMap"));
    walkRouteLine = L.polyline([], { color: ACCENT(), weight: 6, opacity: 0.75 }).addTo(walkMap);
    walkTrackLine = L.polyline([], { color: AMBER(), weight: 5 }).addTo(walkMap);
    walkMe = L.circleMarker(startPos, dot(AMBER(), 9)).addTo(walkMap);
  }
  walkRouteLine.setLatLngs(route.coords); walkTrackLine.setLatLngs([startPos]); walkMe.setLatLng(startPos);
  setTimeout(() => { walkMap.invalidateSize(); walkMap.setView(startPos, 16); }, 50);
  hideCards();
  keepAwake();

  const stopMsg = walk.stopName ? `途中で${walk.stopName}に寄ります。` : "";
  speak(`ふたり散歩を始めます。約${fmtKm(route.total)}キロ、${Math.round(route.total / WALK_SPEED / 60)}分のコースです。${stopMsg}スマホはしまって、曲がり角とお題は音声で案内します。いってらっしゃい。`);

  if (sim) {
    walk.simTimer = setInterval(simStep, 500);
  } else {
    walk.watch = navigator.geolocation.watchPosition((p) => {
      if (p.coords.accuracy > 60) return;
      onPosition([p.coords.latitude, p.coords.longitude]);
    }, () => toast("現在地を取得できません。位置情報の許可を確認してください"), { enableHighAccuracy: true, maximumAge: 2000 });
  }
  walk.tick = setInterval(tick, 1000);
  updateWalkUI();
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

function tick() {
  const now = performance.now(), dt = (now - walk.lastTick) / 1000;
  walk.lastTick = now;
  if (!walk.resting) walk.clock += dt * (walk.sim ? SIM_SPEED : 1);
  walk.walked += dt;
  const ev = walk.events[walk.eventIdx];
  if (ev && walk.clock >= ev.at && !walk.resting) {
    walk.eventIdx++;
    if (ev.kind === "mission") presentMission(ev.text);
    else presentTopic(ev.text);
  }
  updateWalkUI();
}

function onPosition(p) {
  if (!walk || walk.done) return;
  walk.pos = p;
  const last = walk.track[walk.track.length - 1];
  if (dist(last, p) > 5) { walk.track.push(p); walkTrackLine.addLatLng(p); }
  walkMe.setLatLng(p);
  walkMap.panTo(p, { animate: false });

  // 休憩中は、お店から離れたら自動で再開
  if (walk.resting) {
    if (dist(p, walk.route.waypoints[walk.route.stopIndex]) > 80) resumeWalk();
    return;
  }

  // ルート上のどこにいるか（行き帰りで同じ道を通っても飛ばないよう、今の位置の近くだけ探す）
  const { coords, cum } = walk.route;
  let best = { d: Infinity, along: walk.progress };
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] < walk.progress - 60) continue;
    if (cum[i - 1] > walk.progress + 400) break;
    const pr = project(p, coords[i - 1], coords[i]);
    if (pr.d < best.d) best = { d: pr.d, along: cum[i - 1] + (cum[i] - cum[i - 1]) * pr.t };
  }
  if (best.d < 45) {
    walk.off = 0; $("#offRoute").hidden = true;
    if (best.along > walk.progress) walk.progress = best.along;
  } else if (++walk.off >= 3) {
    $("#offRoute").hidden = false;
    if (Date.now() - walk.lastOffWarn > 60000) {
      walk.lastOffWarn = Date.now();
      chime("turn"); speak("ルートから少し外れているようです。地図を確認してください。");
    }
  }

  // 曲がり角の案内
  const prog = walk.progress;
  walk.route.turns.forEach((t, i) => {
    const ahead = t.along - prog;
    if (ahead > 0 && ahead < 40 && !walk.announced.has(i)) {
      walk.announced.add(i);
      chime("turn");
      buzz(t.right ? [250] : [150, 120, 150]);
      speak(`${Math.max(10, Math.round(ahead / 10) * 10)}メートル先、${t.dir}${t.then ? "、すぐに" + t.then : ""}です。${t.name ? t.name + "へ。" : ""}`);
    }
  });

  // 寄り道先に到着
  const r = walk.route;
  if (r.stopAlong != null && !walk.stopArrived && prog >= r.stopAlong - 25) arriveStop();

  // 最後のお題
  if (!walk.finalDone && prog / r.total > 0.85 && walk.clock > 120) {
    walk.finalDone = true;
    presentMission(MISSIONS.final);
  }

  // 帰宅
  if (prog >= r.total - 25 && walk.clock > 60) finishWalk();
  updateWalkUI();
}

function arriveStop() {
  walk.stopArrived = true; walk.resting = true;
  const pool = MISSIONS[walk.stopMission] || MISSIONS.stop;
  const text = pool[Math.floor(rng(plan.seed ^ 77)() * pool.length)];
  $("#restText").textContent = `${walk.stopName}に着きました。ゆっくり休憩してください。`;
  $("#restCard").hidden = false;
  chime("arrive");
  speak(`${walk.stopName}に着きました。ゆっくり休憩してください。`);
  setTimeout(() => presentMission(text), 1500);
  if (walk.sim) setTimeout(() => walk && walk.resting && resumeWalk(), 6000);
}
function resumeWalk() {
  if (!walk.resting) return;
  walk.resting = false; $("#restCard").hidden = true;
  chime("arrive"); speak("では、帰り道に出発しましょう。");
}

function presentMission(text) {
  walk.current = text;
  $("#missionText").textContent = text;
  $("#missionCard").hidden = false;
  chime("mission"); buzz([80, 60, 80, 60, 200]);
  setTimeout(() => speak("お題です。" + text), 500);
}
function presentTopic(text) {
  $("#topicText").textContent = text;
  $("#topicCard").hidden = false;
  speak("話題をひとつ。" + text);
  clearTimeout(walk.topicTimer);
  walk.topicTimer = setTimeout(() => ($("#topicCard").hidden = true), 120000);
}
function hideCards() { ["#missionCard", "#topicCard", "#restCard", "#offRoute"].forEach((s) => ($(s).hidden = true)); }

function updateWalkUI() {
  if (!walk) return;
  const r = walk.route, prog = walk.progress;
  const next = r.turns.find((t) => t.along > prog + 3);
  if (walk.resting) {
    $("#nextArrow").textContent = "☕"; $("#nextText").textContent = "休憩中"; $("#nextSub").textContent = walk.stopName || "";
  } else if (next) {
    const ahead = next.along - prog;
    $("#nextArrow").textContent = next.arrow;
    $("#nextText").textContent = `${Math.round(ahead / 10) * 10}m先 ${next.dir}`;
    $("#nextSub").textContent = [next.then ? `すぐに${next.then}` : "", next.name ? `${next.name}へ` : ""].filter(Boolean).join("・");
  } else {
    $("#nextArrow").textContent = "⌂"; $("#nextText").textContent = "このまま家へ"; $("#nextSub").textContent = "";
  }
  $("#statRemain").textContent = `${fmtKm(Math.max(0, r.total - prog))}km`;
  $("#statTime").textContent = `${Math.floor(walk.clock / 60)}分`;
  $("#statPhotos").textContent = `${walk.photos}枚`;
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
    walk.route = nr; walk.progress = 0; walk.announced = new Set(); walk.simAlong = 0; walk.off = 0;
    walkRouteLine.setLatLngs(nr.coords);
    $("#offRoute").hidden = true;
    speak("ここからの道を引き直しました。");
  } catch (e) { toast(e.message); }
  finally { $("#btnReroute").disabled = false; }
}

async function finishWalk(early) {
  if (!walk || walk.done) return;
  walk.done = true;
  clearInterval(walk.tick); clearInterval(walk.simTimer);
  if (walk.watch != null) navigator.geolocation.clearWatch(walk.watch);
  try { wakeLock && wakeLock.release(); } catch {}
  const w = walk;
  const record = {
    id: w.id, startedAt: w.startedAt, endedAt: Date.now(), minutes: Math.round(w.clock / 60),
    distance: Math.round(early ? w.progress : w.route.total), stopName: w.stopName,
    route: w.route.coords.filter((_, i) => i % 3 === 0), track: w.track, photos: w.photos, missionsDone: w.missionsDone, sim: w.sim,
  };
  await putWalk(record);
  chime("arrive");
  speak(early ? "おつかれさまでした。散歩を記録しました。" : `おかえりなさい。今日は${fmtKm(record.distance)}キロ歩いて、写真を${w.photos}枚撮りました。アルバムで振り返ってみましょう。`, { interrupt: early });
  walk = null;
  openDetail(record.id);
}

// ---------- 写真 ----------
let photoFor = null;
function shoot(missionText) { photoFor = missionText; $("#photoInput").value = ""; $("#photoInput").click(); }
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
  await addPhoto({ walkId: walk.id, blob, mission: photoFor, pos: walk.pos, at: Date.now() });
  walk.photos++;
  if (photoFor && photoFor === walk.current) {
    walk.missionsDone++; walk.current = null; $("#missionCard").hidden = true;
    speak("いい写真ですね。お題クリアです。");
  }
  toast("写真を保存しました");
  updateWalkUI();
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
  if (!walks.length) { box.innerHTML = '<p class="empty">まだ散歩の記録はありません。<br>最初の散歩に出かけると、ここに写真と道のりが残ります。</p>'; return; }
  for (const w of walks) {
    const ps = await photosOf(w.id);
    const b = document.createElement("button");
    b.className = "walkitem";
    b.innerHTML = '<div class="thumb"></div><div><div class="t"></div><div class="m"></div></div>';
    if (ps[0]) b.querySelector(".thumb").style.backgroundImage = `url(${blobUrl(ps[0].blob)})`;
    b.querySelector(".t").textContent = `${fmtDate(w.startedAt)}${w.stopName ? "・" + w.stopName : ""}`;
    b.querySelector(".m").textContent = `${fmtKm(w.distance)}km ・ ${w.minutes}分 ・ 写真${ps.length}枚${w.sim ? " ・ 試し" : ""}`;
    b.onclick = () => openDetail(w.id);
    box.appendChild(b);
  }
}

let detailMap, detailLayer;
async function openDetail(id) {
  showView("detail");
  releaseUrls();
  const w = await getWalk(id), ps = await photosOf(id);
  $("#detailTitle").textContent = `${fmtDate(w.startedAt)}の散歩`;
  $("#detailMeta").textContent = `${fmtTime(w.startedAt)}〜${fmtTime(w.endedAt)} ・ ${fmtKm(w.distance)}km${w.stopName ? " ・ " + w.stopName + "に寄り道" : ""} ・ お題クリア${w.missionsDone}個`;
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
  $("#chkTopics").checked = plan.topics;
  $("#chkTopics").onchange = (e) => { plan.topics = e.target.checked; store.set("topics", plan.topics); };

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

  $("#btnShoot").onclick = () => shoot(walk.current);
  $("#btnSkip").onclick = () => { walk.current = null; $("#missionCard").hidden = true; };
  $("#btnFree").onclick = () => shoot(null);
  $("#btnRepeat").onclick = () => lastSpoken && speak(lastSpoken, { interrupt: true });
  $("#btnResume").onclick = resumeWalk;
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

  loadShared();
}
init();
