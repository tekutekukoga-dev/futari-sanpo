"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const WALK_SPEED = 1.25; // m/s（時速4.5km）
const SIM_SPEED = 8; // 試しモードの倍速
const PHOTON = "https://photon.komoot.io/reverse";
const PHOTON_SEARCH = "https://photon.komoot.io/api/";
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
  theme: store.get("theme", "any"),
  split: store.get("split", 0),
  shape: store.get("shape", "loop"), // loop: ぐるっと一周 / dest: 目的地へ
  back: store.get("back", "round"), // round: 往復（帰りは別の道） / oneway: 片道（帰りは乗り物）
  dest: store.get("dest", null),
  destCands: [],
  meet: store.get("meet", "stop"),
  meetCands: [],
  meetChosen: null,
  role: "A",
  weather: null,
  candidates: [],
  chosen: null,
  seed: Math.floor(Math.random() * 1e9),
  route: null,
  shared: false,
};
let walk = null;
const isDest = () => plan.shape === "dest";

// ---------- 地図 ----------
// ベクター地図（OpenFreeMap）。文字がくっきりして、回転しても地名がまっすぐ読める
// 色数の少ない淡いグレーの地図（スイス風の見た目に合わせる）
const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const ROUTE_COLOR = "#1f4fd8", TRACK_COLOR = "#111111";
const ll = (p) => [p[1], p[0]]; // [緯度, 経度] → MapLibreの[経度, 緯度]
const lineData = (coords) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords.map(ll) } });
function boundsOf(coords) {
  const b = new maplibregl.LngLatBounds();
  coords.forEach((p) => b.extend(ll(p)));
  return b;
}
function mkEl(cls, text) { const e = document.createElement("div"); e.className = cls; if (text) e.textContent = text; return e; }
function htmlMarker(m, pos, el, opts = {}) { return new maplibregl.Marker({ element: el, ...opts }).setLngLat(ll(pos)).addTo(m); }

function makeMap(container, opts = {}) {
  const m = new maplibregl.Map({
    container, style: MAP_STYLE, center: ll(plan.home || [35.681, 139.767]), zoom: plan.home ? 15 : 12,
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false, ...opts,
  });
  m.touchZoomRotate.disableRotation();
  // 描画を待たず、スタイルを読み終えた時点で線や印を置けるようにする
  m.ready = new Promise((res) => m.once("style.load", () => { localizeLabels(m); addArrowImage(m); m.isReady = true; res(); }));
  return m;
}
// 地名は日本語の名前を優先して出す（番地や道路番号のラベルはそのまま）。
// 地図にもともと入っているお店などのアイコンは消して、こちらで選んだ場所のマークを目立たせる（駅は残す）
function localizeLabels(m) {
  m.getStyle().layers.forEach((l) => {
    if (/^poi_r/.test(l.id)) { try { m.setLayoutProperty(l.id, "visibility", "none"); } catch {} return; }
    const tf = l.type === "symbol" && l.layout && l.layout["text-field"];
    if (tf && JSON.stringify(tf).includes("name")) {
      try { m.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:ja"], ["get", "name"]]); } catch {}
    }
  });
}
// ルートの上に並べる、進む向きの白い矢印
function addArrowImage(m) {
  const s = 32, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d");
  g.beginPath(); g.moveTo(25, 16); g.lineTo(9, 7); g.lineTo(13, 16); g.lineTo(9, 25); g.closePath();
  g.fillStyle = "#fff"; g.fill();
  m.addImage("route-arrow", g.getImageData(0, 0, s, s), { pixelRatio: 2 });
}
function setRoute(m, coords, id = "route", color = ROUTE_COLOR, dashed = false) {
  if (!m.isReady) return;
  const data = lineData(coords);
  if (m.getSource(id)) return m.getSource(id).setData(data);
  m.addSource(id, { type: "geojson", data });
  const layout = { "line-join": "round", "line-cap": "round" };
  m.addLayer({ id: id + "-casing", type: "line", source: id, layout, paint: { "line-color": "#ffffff", "line-width": 10, "line-opacity": 0.9 } });
  m.addLayer({ id: id + "-line", type: "line", source: id, layout, paint: { "line-color": color, "line-width": dashed ? 4 : 6, ...(dashed ? { "line-dasharray": [1.5, 1.5] } : {}) } });
  if (!dashed) m.addLayer({ id: id + "-arrows", type: "symbol", source: id, layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "route-arrow", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-rotation-alignment": "map" } });
}
function clearRoute(m, id = "route") {
  if (!m.isReady) return;
  [id + "-arrows", id + "-line", id + "-casing"].forEach((l) => m.getLayer(l) && m.removeLayer(l));
  if (m.getSource(id)) m.removeSource(id);
}
function setTrack(m, coords) {
  if (!m.isReady || !coords.length) return;
  const data = lineData(coords.length > 1 ? coords : [coords[0], coords[0]]);
  if (m.getSource("track")) return m.getSource("track").setData(data);
  m.addSource("track", { type: "geojson", data });
  m.addLayer({ id: "track-line", type: "line", source: "track", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": TRACK_COLOR, "line-width": 5 } });
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

// ---------- ちらっと見たい場所 ----------
// ルート沿い120m以内の、歴史・アート・自然・個性的なお店を地図に出す
const POI_GROUPS = { history: { mark: "史", label: "歴史" }, art: { mark: "芸", label: "アート" }, nature: { mark: "緑", label: "自然" }, shop: { mark: "店", label: "お店" } };
const HISTORIC = { memorial: "記念碑", monument: "記念碑", wayside_shrine: "祠", wayside_cross: "道しるべ", boundary_stone: "境界石", milestone: "道しるべ", castle: "城跡", ruins: "遺構", archaeological_site: "遺跡", building: "歴史的な建物", tomb: "墓所", board: "説明板" };
const ARTWORK = { statue: "像", sculpture: "彫刻", mural: "壁画", installation: "オブジェ", relief: "レリーフ" };
const TOURISM = { attraction: ["art", "名所"], museum: ["art", "博物館"], gallery: ["art", "ギャラリー"], viewpoint: ["nature", "眺めのいい場所"] };
const SHOPS = { books: "本屋", second_hand: "古道具", antiques: "骨董", confectionery: "菓子", pastry: "洋菓子", tea: "お茶", coffee: "コーヒー豆", craft: "工芸", deli: "惣菜", art: "画廊", frame: "額縁", musical_instrument: "楽器", bakery: "パン屋", ice_cream: "アイス" };
function poiKind(t) {
  if (t.historic) return ["history", HISTORIC[t.historic] || "史跡"];
  if (t.tourism === "artwork") return ["art", ARTWORK[t.artwork_type] || "アート"];
  if (TOURISM[t.tourism]) return TOURISM[t.tourism];
  if (t.natural === "tree") return ["nature", "名木"];
  if (t.natural === "spring") return ["nature", "湧き水"];
  if (t.man_made === "water_well") return ["nature", "井戸"];
  if (t.amenity === "public_bath") return ["shop", "銭湯"];
  if (t.amenity === "marketplace") return ["shop", "市場"];
  if (t.amenity === "cafe") return ["shop", "喫茶店"];
  if (SHOPS[t.shop]) return ["shop", SHOPS[t.shop]];
  // Wikipediaに載っている寺社・庭園・建物は「名所」として出す（駅や学校などは出さない）
  if (t.wikidata && !t.railway && !t.highway && !t.public_transport && !t.office && !["school", "university", "college", "hospital", "townhall", "police"].includes(t.amenity)) {
    if (t.amenity === "place_of_worship") return ["history", "寺社"];
    if (["park", "garden"].includes(t.leisure)) return ["nature", "庭園・公園"];
    if (t.building) return ["art", "名所"];
  }
  return null;
}
function routeDistance(route, p) {
  let d = Infinity;
  for (let i = 1; i < route.coords.length; i++) d = Math.min(d, project(p, route.coords[i - 1], route.coords[i]).d);
  return d;
}
// 種類ごとに上限を決めて、お寺ばかり・お店ばかりにならないようにする。ルートに近いものから選ぶ
const GROUP_CAP = { history: 12, art: 10, nature: 8, shop: 12 };
const LABEL_CAP = { 寺社: 5, 説明板: 4, 喫茶店: 5, 菓子: 4, パン屋: 3 };
function tidyPois(route, list) {
  const seen = new Set(), byGroup = {}, byLabel = {};
  return list
    .filter((p) => p.group && p.name !== p.label && !seen.has(p.name) && seen.add(p.name))
    .map((p) => ({ ...p, d: routeDistance(route, p.pos) }))
    .filter((p) => p.d < 120)
    .sort((a, b) => (b.wiki ? 1 : 0) - (a.wiki ? 1 : 0) || a.d - b.d)
    .filter((p) => {
      if ((byGroup[p.group] || 0) >= GROUP_CAP[p.group] || (byLabel[p.label] || 0) >= (LABEL_CAP[p.label] || 99)) return false;
      byGroup[p.group] = (byGroup[p.group] || 0) + 1; byLabel[p.label] = (byLabel[p.label] || 0) + 1;
      return true;
    });
}
async function findPois(route) {
  const step = Math.max(1, Math.ceil(route.coords.length / 80));
  const line = route.coords.filter((_, i) => i % step === 0).concat([route.coords[route.coords.length - 1]])
    .map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(",");
  const A = `(around:120,${line})`;
  const q = `[out:json][timeout:20];(
nwr["historic"]${A};
nwr["tourism"~"^(artwork|attraction|museum|gallery|viewpoint)$"]${A};
nwr["natural"~"^(tree|spring)$"]["name"]${A};
nwr["man_made"="water_well"]${A};
nwr["amenity"~"^(public_bath|marketplace)$"]${A};
nwr["amenity"="cafe"]["name"][!"brand"]${A};
nwr["shop"~"^(${Object.keys(SHOPS).join("|")})$"]["name"][!"brand"]${A};
nwr["wikidata"]["name"]${A};
);out tags center 250;`;
  for (const url of [OVERPASS]) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const data = await res.json();
      return tidyPois(route, data.elements.map((e) => {
        const t = e.tags || {}, k = poiKind(t);
        if (!k) return {};
        const wiki = t.wikipedia && /^ja:/.test(t.wikipedia) ? "https://ja.wikipedia.org/wiki/" + encodeURIComponent(t.wikipedia.slice(3)) : null;
        return { id: e.type[0] + e.id, group: k[0], label: k[1], name: t["name:ja"] || t.name || k[1], wiki, pos: e.lat != null ? [e.lat, e.lon] : [e.center.lat, e.center.lon] };
      }));
    } catch {}
  }
  throw new Error("overpass");
}
// 地図タイル（ベクター形式）から、ルート周辺の場所を直接読み取る。
// 地図と同じサーバーなので速く、検索サービスが混んでいても使える
const CHAIN_CAFE = /スターバックス|Starbucks|ドトール|タリーズ|コメダ|エクセルシオール|サンマルク|ベローチェ|ルノアール|星乃珈琲|プロント|PRONTO|上島珈琲|クリエ|マクドナルド|ミスタードーナツ|ブルーボトル|Blue Bottle|モスバーガー/;
let tileUrlTemplate = null;
async function poiTileUrl() {
  if (!tileUrlTemplate) tileUrlTemplate = (await getJson("https://tiles.openfreemap.org/planet")).tiles[0];
  return tileUrlTemplate;
}
// Mapbox Vector Tile（protobuf）のうち、指定したレイヤーの「点」だけを取り出す最小限の読み取り
function decodeTilePoints(bytes, layerName, z, tx, ty) {
  const out = [], td = new TextDecoder();
  let p = 0;
  const varint = () => { let r = 0, sh = 0, b; do { b = bytes[p++]; r += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80); return r; };
  const skip = (wt) => { if (wt === 0) varint(); else if (wt === 1) p += 8; else if (wt === 2) p += varint(); else if (wt === 5) p += 4; };
  const str = () => { const l = varint(), v = td.decode(bytes.subarray(p, p + l)); p += l; return v; };
  const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  while (p < bytes.length) {
    const tag = varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
    const end = varint() + p;
    let name = "", extent = 4096;
    const keys = [], values = [], feats = [];
    while (p < end) {
      const t = varint(), f = t >> 3;
      if (f === 1) name = str();
      else if (f === 2) { const l = varint(); feats.push([p, p + l]); p += l; }
      else if (f === 3) keys.push(str());
      else if (f === 4) {
        const ve = varint() + p; let v = null;
        while (p < ve) {
          const t3 = varint(), f3 = t3 >> 3;
          if (f3 === 1) v = str();
          else if (f3 === 4 || f3 === 5) v = varint();
          else if (f3 === 6) v = zz(varint());
          else if (f3 === 7) v = !!varint();
          else skip(t3 & 7);
        }
        values.push(v);
      } else if (f === 5) extent = varint();
      else skip(t & 7);
    }
    if (name === layerName) {
      const n = 2 ** z;
      feats.forEach(([fs, fe]) => {
        p = fs;
        const props = {}; let type = 0, gx = null, gy = null;
        while (p < fe) {
          const t = varint(), f = t >> 3;
          if (f === 2) { const te = varint() + p; while (p < te) { const k = varint(), v = varint(); props[keys[k]] = values[v]; } }
          else if (f === 3) type = varint();
          else if (f === 4) { const ge = varint() + p; if ((varint() & 7) === 1) { gx = zz(varint()); gy = zz(varint()); } p = ge; }
          else skip(t & 7);
        }
        if (type === 1 && gx != null) {
          const lon = (tx + gx / extent) / n * 360 - 180;
          const lat = deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + gy / extent) / n))));
          out.push({ props, lat, lon });
        }
      });
    }
    p = end;
  }
  return out;
}
function tileTags(pr) {
  const sub = pr.subclass, cls = pr.class;
  if (HISTORIC[sub]) return { historic: sub };
  if (sub === "artwork" || TOURISM[sub]) return { tourism: sub };
  if (SHOPS[sub]) return { shop: sub };
  if (["public_bath", "marketplace"].includes(sub)) return { amenity: sub };
  if (sub === "cafe" && pr.name && !CHAIN_CAFE.test(pr.name)) return { amenity: "cafe" };
  if (cls === "place_of_worship" && pr.name) return { wikidata: "tile", amenity: "place_of_worship" };
  if (sub === "garden" && pr.name) return { wikidata: "tile", leisure: "garden" };
  if (cls === "information" && sub === "board" && pr.name) return { historic: "board" };
  return {};
}
async function poisFromTiles(route) {
  const z = 14, n = 2 ** z;
  const lats = route.coords.map((c) => c[0]), lons = route.coords.map((c) => c[1]);
  const pad = 0.0015;
  const tx = (lon) => Math.floor((lon + 180) / 360 * n);
  const ty = (lat) => Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * n);
  const x0 = tx(Math.min(...lons) - pad), x1 = tx(Math.max(...lons) + pad);
  const y0 = ty(Math.max(...lats) + pad), y1 = ty(Math.min(...lats) - pad);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 30) return [];
  const url = await poiTileUrl();
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(fetch(url.replace("{z}", z).replace("{x}", x).replace("{y}", y), { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => (buf ? decodeTilePoints(new Uint8Array(buf), "poi", z, x, y) : []))
      .catch(() => []));
  }
  const pts = (await Promise.all(jobs)).flat();
  return tidyPois(route, pts.map(({ props: pr, lat, lon }) => {
    const k = poiKind(tileTags(pr));
    if (!k) return {};
    return { id: "t" + lat.toFixed(5) + lon.toFixed(5), group: k[0], label: k[1], name: pr["name:ja"] || pr.name || k[1], wiki: null, pos: [lat, lon] };
  }));
}
// まず地図タイルからすぐに出し、検索サービスが答えたら詳しい情報（Wikipedia・名木・井戸など）を足す
async function loadPois(route) {
  const show = (pois) => {
    route.pois = pois;
    if (plan.route === route) {
      $("#sumPois").textContent = pois.length ? `ルート沿いに、ちょっと見たい場所が${pois.length}か所あります（地図の丸いマーク）` : "";
      drawPlan(false);
    }
    if (walk && walk.route === route) drawWalkRoute();
  };
  // 別行動があるときは、もう一方の道のまわりも探す
  const geo = route.split ? { coords: route.coords.concat(route.split.branchB) } : route;
  const detailed = findPois(geo).catch(() => null);
  const quick = await poisFromTiles(geo).catch(() => []);
  show(quick);
  const more = await detailed;
  if (more && more.length) show(tidyPois(geo, [...more, ...quick]));
  // 夫婦用ページ：見どころがそろったら、AIのお題を先に頼んでおく
  if (window.Cloud && plan.route === route) Cloud.missionsFor(route);
}
function drawPois(m, pois, bucket) {
  (pois || []).forEach((p) => {
    const e = mkEl("poi " + p.group, POI_GROUPS[p.group].mark);
    e.setAttribute("aria-label", p.name);
    e.addEventListener("click", (ev) => { ev.stopPropagation(); showPoi(m, p); });
    bucket.push(htmlMarker(m, p.pos, e));
  });
}
function showPoi(m, p) {
  const box = mkEl("poipop");
  box.append(mkEl("poiname", p.name), mkEl("poilabel", `${POI_GROUPS[p.group].label}・${p.label}`));
  const g = document.createElement("a"); g.href = gmapUrl(p.name, p.pos); g.target = "_blank"; g.rel = "noopener"; g.textContent = "Googleマップで見る"; box.append(g);
  if (p.wiki) { const a = document.createElement("a"); a.href = p.wiki; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Wikipediaで読む"; box.append(a); }
  const popup = new maplibregl.Popup({ offset: 16, closeButton: false, maxWidth: "240px" });
  // ルートから少し離れた場所なら、そこを通るように道を引き直せる
  const onPlan = m === planMap && plan.route && !plan.route.split, onWalk = m === walkMap && walk && !walk.resting && !(walk.split && !walk.met);
  if ((onPlan || onWalk) && routeDistance(onPlan ? plan.route : walk.route, p.pos) > 15) {
    const b = document.createElement("button"); b.textContent = "ここに寄る";
    b.onclick = () => { popup.remove(); onPlan ? addDetour(p) : reroute(p); };
    box.append(b);
  }
  popup.setLngLat(ll(p.pos)).setDOMContent(box).addTo(m);
}

// ルート作成中に見どころを経由地に加える。いちばん遠回りが少ない位置に差し込む
async function addDetour(poi) {
  const r = plan.route, w = r.waypoints;
  let at = 1, cost = Infinity;
  for (let i = 1; i < w.length; i++) {
    const c = dist(w[i - 1], poi.pos) + dist(poi.pos, w[i]) - dist(w[i - 1], w[i]);
    if (c < cost) { cost = c; at = i; }
  }
  const pts = [...w.slice(0, at), poi.pos, ...w.slice(at)];
  const stopIndex = r.stopIndex != null ? (r.stopIndex >= at ? r.stopIndex + 1 : r.stopIndex) : null;
  try {
    const nr = shapeRoute(await osrm(pts), pts, stopIndex);
    nr.pois = r.pois;
    if (r.dest) attachDest(nr, r.dest.idx >= at ? r.dest.idx + 1 : r.dest.idx, r.dest);
    if (walk && walk.split && walk.branch && !walk.met) {
      let bi = 0, bd = Infinity;
      nr.coords.forEach((c, i) => { const d = dist(c, walk.split.meetPos); if (d < bd) { bd = d; bi = i; } });
      walk.meetAlong = nr.cum[bi];
    } nr.detours = [...(r.detours || []), poi.name];
    plan.route = nr;
    showSummary(); await drawPlan(false);
    toast(`「${poi.name}」に寄るルートにしました（${fmtDist(Math.max(0, nr.total - r.total))}増えます）`);
  } catch (e) { toast(e.message, true); }
}

let planMap, planMarkers = [];
function initPlanMap() {
  planMap = makeMap($("#planMap"));
  planMap.on("click", (e) => {
    if (plan.shared) return;
    const p = [e.lngLat.lat, e.lngLat.lng];
    if (isDest() && plan.home) pickDestOnMap(p); else setHome(p);
  });
  drawPlan();
}
async function drawPlan(fit = true) {
  await planMap.ready;
  planMarkers.forEach((mk) => mk.remove()); planMarkers = [];
  if (plan.route && plan.route.split) {
    const sp = plan.route.split;
    setRoute(planMap, sp.branchB, "routeB", BRANCH_B_COLOR);
    planMarkers.push(htmlMarker(planMap, pointAt(plan.route, sp.startAlong), mkEl("pin fork", "分かれ道"), { anchor: "bottom", offset: [0, -6] }));
    planMarkers.push(htmlMarker(planMap, sp.meetPos, mkEl("pin meet", `合流：${sp.meetName}`), { anchor: "bottom", offset: [0, -6] }));
  } else clearRoute(planMap, "routeB");
  if (plan.route) {
    setRoute(planMap, plan.route.coords);
    if (fit) planMap.fitBounds(boundsOf(plan.route.coords), { padding: 36, animate: false });
    drawPois(planMap, plan.route.pois, planMarkers);
  } else clearRoute(planMap);
  plan.candidates.forEach((c) => {
    const on = plan.chosen && plan.chosen.id === c.id;
    const e = mkEl("cand" + (on ? " on" : "")); e.title = c.name;
    e.addEventListener("click", (ev) => { ev.stopPropagation(); chooseCandidate(c); });
    planMarkers.push(htmlMarker(planMap, c.pos, e));
  });
  const d = plan.route ? plan.route.dest : isDest() && plan.dest;
  if (d) {
    planMarkers.push(htmlMarker(planMap, d.pos, mkEl("homedot")));
    planMarkers.push(htmlMarker(planMap, d.pos, mkEl("pin dest", `目的地：${d.name}`), { anchor: "bottom", offset: [0, -10] }));
  }
  if (plan.home) {
    planMarkers.push(htmlMarker(planMap, plan.home, mkEl("homedot")));
    const label = !plan.route ? "スタート地点" : plan.route.dest && plan.route.dest.back === "oneway" ? "スタート" : "スタート・ゴール";
    planMarkers.push(htmlMarker(planMap, plan.home, mkEl("pin", label), { anchor: "bottom", offset: [0, -10] }));
  }
}

// ---------- 天気 ----------
// Open-Meteo（無料・登録不要）でいまの天気を調べる
const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99], SNOW_CODES = [71, 73, 75, 77, 85, 86];
async function fetchWeather(home) {
  try {
    const d = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${home[0].toFixed(3)}&longitude=${home[1].toFixed(3)}&current=weather_code,temperature_2m`);
    const code = d.current.weather_code, temp = Math.round(d.current.temperature_2m);
    const kind = SNOW_CODES.includes(code) ? "snow" : RAIN_CODES.includes(code) ? "rain" : temp >= 30 ? "hot" : temp <= 5 ? "cold" : null;
    const label = SNOW_CODES.includes(code) ? "雪" : RAIN_CODES.includes(code) ? "雨" : code <= 1 ? "晴れ" : code <= 3 ? "くもり" : code <= 48 ? "霧" : "くもり";
    return { kind, label, temp };
  } catch { return null; }
}
const themeKey = (seed) => (plan.theme === "any" ? Object.keys(THEMES)[Math.floor(rng(seed ^ 0x7e)() * Object.keys(THEMES).length)] : plan.theme === "none" ? null : plan.theme);

// ---------- ルート作成 ----------
function setHome(p) {
  plan.home = p; store.set("home", p);
  $("#homeLabel").textContent = "設定済み";
  $("#homeLabel").classList.remove("muted");
  plan.candidates = []; plan.chosen = null; plan.route = null;
  $("#candidates").innerHTML = ""; $("#routeSummary").hidden = true;
  planMap.jumpTo({ center: ll(p), zoom: 15 });
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
  // 目的地へ行くときは、家と目的地の中ほどで探す（遠回りになりすぎないように）
  const toDest = isDest() && plan.dest;
  const center = toDest ? midOf(plan.home, plan.dest.pos) : plan.home;
  const r = toDest ? Math.max(250, dist(plan.home, plan.dest.pos) / 2) : legRadius(), [lat, lon] = center;
  const searchR = toDest ? r / 2 : r;
  // お店はそうそう変わらないので、場所・種類・時間ごとに1週間保存して使い回す
  const cacheKey = toDest ? `poi:${type}:d${Math.round(r / 100)}:${lat.toFixed(4)},${lon.toFixed(4)}` : `poi:${type}:${Math.round(plan.minutes / 15)}:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = store.get(cacheKey, null);
  let places = cached && Date.now() - cached.at < 7 * 864e5 ? cached.places : null;
  if (!places) {
    // 検索サービスはどれも混むことがあるので、順に試して最初に取れたものを使う
    for (const source of [fromPhoton, fromOverpass, fromNominatim]) {
      try { places = await source(t, center, searchR); } catch { places = null; }
      if (places && places.length) break;
    }
    if (!places) throw new Error("お店の情報を取得できませんでした。電波の良いところで、少し待ってからもう一度お試しください");
    if (places.length) store.set(cacheKey, { at: Date.now(), places });
  }
  const seen = new Set();
  return places
    .filter((p) => p.name && (!t.name || t.name.test(p.name)) && !seen.has(p.id) && !seen.has(p.name) && seen.add(p.id) && seen.add(p.name))
    .map((p) => ({ ...p, type, d: dist(plan.home, p.pos), m: dist(center, p.pos) }))
    .filter((c) => toDest ? c.m < r * 0.85 && c.d > 150 && dist(c.pos, plan.dest.pos) > 150 : c.d > r * 0.35 && c.d < r * 1.6)
    .sort((a, b) => toDest ? a.m - b.m : Math.abs(a.d - r) - Math.abs(b.d - r))
    .slice(0, 6);
}

// Googleマップで、その場所の周りを店名で探すリンク（写真や口コミを確かめられる）
const gmapUrl = (name, pos) => `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${pos[0].toFixed(6)},${pos[1].toFixed(6)},18z`;
// 候補の1行：選ぶボタンと、Googleマップのリンクを横に並べる
function candidateRow(c, on, typeLabel, onPick) {
  const row = document.createElement("div");
  row.className = "candrow" + (on ? " on" : "");
  const b = document.createElement("button");
  b.className = on ? "on" : "";
  b.innerHTML = `<span></span><span class="d">${typeLabel ? typeLabel + "・" : ""}スタートから${fmtKm(c.d)}km</span>`;
  b.firstChild.textContent = c.name;
  b.onclick = onPick;
  const a = document.createElement("a");
  a.className = "gmap"; a.href = gmapUrl(c.name, c.pos); a.target = "_blank"; a.rel = "noopener";
  a.textContent = "地図"; a.setAttribute("aria-label", `${c.name}をGoogleマップで見る`);
  row.append(b, a);
  return row;
}

function renderCandidates() {
  const box = $("#candidates");
  box.innerHTML = "";
  if (plan.stop === "none") return;
  if (!plan.candidates.length) return;
  plan.candidates.forEach((c) => {
    box.appendChild(candidateRow(c, plan.chosen && plan.chosen.id === c.id, plan.stop === "any" ? STOP_TYPES[c.type].label : "", () => chooseCandidate(c)));
  });
}
function chooseCandidate(c) { plan.chosen = c; renderCandidates(); buildRoute(); }

// ---------- 目的地 ----------
const midOf = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
// 名前で探す。家の近くを優先し、15km以内に絞る
async function searchDest(q) {
  const [lat, lon] = plan.home;
  let list = [];
  try {
    const d = await getJson(`${PHOTON_SEARCH}?q=${encodeURIComponent(q)}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&limit=20`);
    list = d.features.map((f) => ({
      id: f.properties.osm_type + f.properties.osm_id, name: f.properties.name || [f.properties.street, f.properties.housenumber].filter(Boolean).join(" "),
      pos: [f.geometry.coordinates[1], f.geometry.coordinates[0]], area: f.properties.district || f.properties.city || "",
    }));
  } catch {}
  if (!list.length) {
    const a = dest(plan.home, 315, 15000 * Math.SQRT2), b = dest(plan.home, 135, 15000 * Math.SQRT2);
    const data = await getJson(`${NOMINATIM}?q=${encodeURIComponent(q)}&viewbox=${a[1]},${a[0]},${b[1]},${b[0]}&bounded=1&format=jsonv2&limit=20`)
      .catch(() => { throw new Error("場所を探せませんでした。電波の良いところで、もう一度お試しください"); });
    list = data.map((e) => ({ id: e.osm_type[0].toUpperCase() + e.osm_id, name: e.name, pos: [+e.lat, +e.lon], area: "" }));
  }
  const seen = new Set();
  return list.filter((c) => c.name && !seen.has(c.name) && seen.add(c.name))
    .map((c) => ({ ...c, d: dist(plan.home, c.pos) }))
    .filter((c) => c.d > 150 && c.d < 15000)
    .slice(0, 6);
}
async function onDestSearch(e) {
  e.preventDefault();
  const q = $("#destInput").value.trim();
  if (!q) return;
  if (!plan.home) return showPlanError("先にスタート地点を決めてください");
  $("#destInput").blur();
  showPlanError("");
  try {
    plan.destCands = await searchDest(q);
    if (!plan.destCands.length) showPlanError("スタート地点から15km以内に見つかりませんでした。別の名前で探すか、地図をタップしてください");
  } catch (err) { showPlanError(err.message); }
  renderDestCands();
}
function renderDestCands() {
  const box = $("#destCands");
  box.innerHTML = "";
  const list = [...plan.destCands];
  if (plan.dest && !list.some((c) => c.name === plan.dest.name)) list.unshift({ ...plan.dest, d: plan.home ? dist(plan.home, plan.dest.pos) : 0 });
  list.forEach((c) => {
    box.appendChild(candidateRow(c, plan.dest && plan.dest.name === c.name, "", () => chooseDest(c)));
  });
}
function chooseDest(c) {
  plan.dest = { name: c.name, pos: c.pos };
  store.set("dest", plan.dest);
  renderDestCands();
  onMake();
}
// 地図をタップした場所を目的地にする。名前は近くの建物や通りから付ける
async function pickDestOnMap(p) {
  let name = "地図で選んだ場所";
  try {
    const d = await getJson(`${PHOTON}?lat=${p[0].toFixed(5)}&lon=${p[1].toFixed(5)}&limit=1`);
    const f = d.features[0];
    if (f && f.properties.name && dist(p, [f.geometry.coordinates[1], f.geometry.coordinates[0]]) < 60) name = f.properties.name;
  } catch {}
  chooseDest({ name, pos: p });
}
// 目的地モードでは、歩く時間と別行動は使わない
function applyShapeUI() {
  $("#destBox").hidden = !isDest();
  $("#itemTime").hidden = isDest();
  $("#itemSplit").hidden = isDest();
  $("#mapHint").textContent = isDest() ? "地図をタップすると、そこを目的地にできます（スタート地点は「現在地にする」で変えられます）" : "地図をタップすると、そこをスタート地点にできます";
  renderDestCands();
}
function attachDest(route, idx, d) {
  route.dest = { name: d.name, pos: d.pos, back: d.back, idx, along: route.legEnds[idx - 1] };
  return route;
}
// 経由地の並び：[家, (寄り道先), 目的地] / 往復は [家, (寄り道先), 目的地, 帰りの経由地, 家]。
// 帰りの経由地は、行きの道の横にずらして置き、同じ道を戻らないようにする
async function makeDestRoute() {
  const home = plan.home, D = plan.dest.pos, d = dist(home, D);
  if (d > 15000) throw new Error("目的地がスタート地点から遠すぎます（15kmまで）");
  const c = plan.chosen && plan.stop !== "none" ? plan.chosen.pos : null;
  const out = c ? [home, c, D] : [home, D], stopIndex = c ? 1 : null, di = out.length - 1;
  const info = { ...plan.dest, back: plan.back };
  if (plan.back === "oneway") return attachDest(shapeRoute(await osrm(out, true), out, stopIndex), di, info);
  const b = bearing(home, D), mid = midOf(home, D);
  // 寄り道先があるときは、その反対側を帰り道にする
  let side = rng(plan.seed)() < 0.5 ? 1 : -1;
  if (c) side = ((bearing(home, c) - b + 540) % 360) - 180 > 0 ? -1 : 1;
  const ignore = [home, D, ...(c ? [c] : [])];
  const tries = [side, -side].flatMap((sd) => [0.3, 0.45].map((k) => ({ sd, k })));
  let best = null, err = null;
  for (const { sd, k } of tries) {
    const pts = [...out, dest(mid, b + sd * 90, Math.max(200, d * k)), home];
    let route;
    try { route = shapeRoute(await osrm(pts, true), pts, stopIndex); } catch (e) { err = e; continue; }
    const over = overlapRatio(route, ignore), score = over * 2 + route.total / (d * 2) * 0.1;
    if (!best || score < best.score) best = { route, score };
    if (over < 0.04) break;
  }
  if (!best) throw err || new Error("ルートを作れませんでした");
  return attachDest(best.route, di, info);
}

// 経路サーバーは2つ。ふだんはOSRMを使い、つながらないときはValhallaに切り替えて、しばらくそちらを使う
let osrmDownUntil = 0;
// straight: 経由地でUターンさせず、通り抜けさせる（行き止まりの往復を減らす）
async function osrm(points, straight) {
  if (Date.now() > osrmDownUntil) {
    try { return await osrmMain(points, straight); }
    catch (e) { if (e.noRoute) throw e; osrmDownUntil = Date.now() + 5 * 60000; }
  }
  return valhalla(points, straight);
}
async function osrmMain(points, straight) {
  const coords = points.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const res = await fetch(`${OSRM}${coords}?overview=full&geometries=geojson&steps=true&continue_straight=${straight ? "true" : "false"}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("osrm " + res.status);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes.length) throw Object.assign(new Error("この場所では歩くルートが見つかりませんでした"), { noRoute: true });
  return data.routes[0];
}
// Valhallaの結果を、OSRMと同じ形に直して返す
const VALHALLA = "https://valhalla1.openstreetmap.de/route";
const VH_TURN = { 9: "slight right", 10: "right", 11: "sharp right", 12: "uturn", 13: "uturn", 14: "sharp left", 15: "left", 16: "slight left" };
function decodePolyline6(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}
async function valhalla(points, straight) {
  const locations = points.map((p, i) => ({ lat: +p[0].toFixed(6), lon: +p[1].toFixed(6), type: i === 0 || i === points.length - 1 || !straight ? "break" : "break_through" }));
  const q = encodeURIComponent(JSON.stringify({ locations, costing: "pedestrian", directions_options: { units: "kilometers" } }));
  const res = await fetch(`${VALHALLA}?json=${q}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res) throw new Error("ルートを作れませんでした。電波の良いところでもう一度お試しください");
  if (!res.ok) throw new Error(res.status === 400 ? "この場所では歩くルートが見つかりませんでした" : "ルートを作れませんでした。少し待ってからもう一度お試しください");
  const trip = (await res.json()).trip;
  const coordinates = [];
  const legs = trip.legs.map((leg) => {
    const shape = decodePolyline6(leg.shape);
    coordinates.push(...(coordinates.length ? shape.slice(1) : shape));
    return {
      steps: leg.maneuvers.map((m) => ({
        distance: m.length * 1000, name: (m.street_names || [])[0] || "",
        maneuver: [1, 2, 3].includes(m.type) ? { type: "depart" } : [4, 5, 6].includes(m.type) ? { type: "arrive" }
          : VH_TURN[m.type] ? { type: "turn", modifier: VH_TURN[m.type] } : { type: "continue", modifier: "straight" },
      })),
    };
  });
  return { distance: trip.summary.length * 1000, geometry: { coordinates }, legs };
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

// 同じ道を往復している割合（0〜1）。15mおきに点を取り、80m以上前に通った場所の12m以内に戻っていたら往復とみなす。
// 自宅と寄り道先のまわりは、行き帰りで同じ道になっても仕方ないので数えない
function overlapRatio(route, ignore = []) {
  const step = 15, samples = [];
  for (let a = 0; a < route.total; a += step) samples.push([a, pointAt(route, a)]);
  let over = 0;
  for (let i = 0; i < samples.length; i++) {
    const [a, p] = samples[i];
    if (ignore.some((q) => dist(p, q) < 120)) continue;
    for (let j = 0; j < i && samples[j][0] < a - 80; j++) {
      if (dist(p, samples[j][1]) < 12) { over++; break; }
    }
  }
  return (over * step) / route.total;
}

// ---------- 別行動（二手に分かれて合流） ----------
const BRANCH_B_COLOR = "#111111";
// ルートのうち、along a〜b の区間だけを取り出す
function sliceCoords(route, a, b) {
  const out = [pointAt(route, a)];
  route.coords.forEach((c, i) => { if (route.cum[i] > a && route.cum[i] < b) out.push(c); });
  out.push(pointAt(route, b));
  return out;
}
// 合流場所：寄り道先と同じにするか、別に選んだ場所
function meetPoint() {
  if (plan.meet === "stop") return plan.stop !== "none" && plan.chosen ? { name: plan.chosen.name, pos: plan.chosen.pos } : null;
  return plan.meetChosen ? { name: plan.meetChosen.name, pos: plan.meetChosen.pos } : null;
}
// 経由地の並び：[家, 分かれ道, 寄せる点, 合流場所, (寄り道先), 帰りの経由地, 家]。
// 2本の道は「寄せる点」だけが違うので、分かれ道までと合流後は同じ道になる
function composeSplit(A, B, meta) {
  A.split = {
    ...meta, B,
    startAlong: A.legEnds[0], meetAlongA: A.legEnds[2], meetAlongB: B.legEnds[2],
    lenA: A.legEnds[2] - A.legEnds[0], lenB: B.legEnds[2] - B.legEnds[0],
  };
  A.split.branchA = sliceCoords(A, A.legEnds[0], A.legEnds[2]);
  A.split.branchB = sliceCoords(B, B.legEnds[0], B.legEnds[2]);
  return A;
}
// 2本の別行動の道が、どれくらい同じ道を通っているか
function branchOverlap(sp) {
  const a = sp.branchA, b = sp.branchB;
  let n = 0, over = 0;
  for (let i = 0; i < a.length; i += 2) {
    if (dist(a[i], a[0]) < 60 || dist(a[i], a[a.length - 1]) < 60) continue;
    n++;
    if (b.some((q) => dist(a[i], q) < 15)) over++;
  }
  return n ? over / n : 0;
}
async function makeSplitRoute() {
  const home = plan.home, M = meetPoint(), T = loopMeters(), L = plan.split * 60 * WALK_SPEED;
  const meetIsStop = plan.meet === "stop";
  const stopPos = !meetIsStop && plan.chosen && plan.stop !== "none" ? plan.chosen.pos : null;
  const stopIndex = meetIsStop ? 3 : stopPos ? 4 : null;
  const bM = bearing(home, M.pos), dM = Math.max(dist(home, M.pos), 300);
  const r = rng(plan.seed ^ 0x51);
  const first = r() < 0.5 ? 1 : -1;
  const tries = [first, -first].flatMap((side) => [50, 75].map((ang) => ({ side, ang })));
  const ignore = [home, M.pos, ...(stopPos ? [stopPos] : [])];
  let best = null, f = 1, sDist = L / 1.7;
  for (let i = 0; i < tries.length; i++) {
    const { side, ang } = tries[i];
    // 分かれ道は、合流場所から家の方へ少し戻った横に置く。2本の道は、その間を左右にふくらませて作る
    const S = dest(M.pos, bearing(M.pos, home) + side * ang, sDist);
    const mid = [(S[0] + M.pos[0]) / 2, (S[1] + M.pos[1]) / 2], bSM = bearing(S, M.pos);
    const R = dest(home, bM - side * 70, dM * 0.8 * f);
    // 合流のあとに寄り道先があるときは、寄り道先を帰り道の経由地にする
    const tail = stopPos ? [stopPos, home] : [R, home];
    const make = async (off, sgn) => {
      const pts = [home, S, dest(mid, bSM + sgn * 90, off), M.pos, ...tail];
      return { route: shapeRoute(await osrm(pts, true), pts, stopIndex), pts };
    };
    let offA = L * 0.17, offB = L * 0.17, A, B;
    try { [A, B] = await Promise.all([make(offA, 1), make(offB, -1)]); } catch { continue; }
    const blen = (x) => x.route.legEnds[2] - x.route.legEnds[0];
    // 2本の長さをそろえる：長い方のふくらみを小さく、短い方を大きくして作り直す（最大3回）
    for (let k = 0; k < 3; k++) {
      const a = blen(A), b = blen(B);
      if (Math.abs(a - b) <= Math.max(100, 0.08 * Math.max(a, b))) break;
      try {
        const q = Math.min(a, b) / Math.max(a, b);
        if (a > b) { offA *= Math.max(0.15, q); offB *= 1 / Math.sqrt(q); }
        else { offB *= Math.max(0.15, q); offA *= 1 / Math.sqrt(q); }
        [A, B] = await Promise.all([make(offA, 1), make(offB, -1)]);
      } catch { break; }
    }
    const route = composeSplit(A.route, B.route, { meetName: M.name, meetPos: M.pos, minutes: plan.split, wA: A.pts, wB: B.pts, stopIndex });
    const sp = route.split;
    const imbalance = Math.abs(sp.lenA - sp.lenB) / Math.max(sp.lenA, sp.lenB);
    const score = (overlapRatio(A.route, ignore) + overlapRatio(B.route, ignore)) * 2 + Math.abs(route.total - T) / T
      + imbalance * 3 + branchOverlap(sp) * 2 + Math.abs((sp.lenA + sp.lenB) / 2 - L) / L * 0.7;
    if (!best || score < best.score) best = { route, score };
    // 結果から学んで、次の候補では「別行動の長さ」と「帰り道の長さ」を目標に近づける
    sDist *= Math.max(0.5, Math.min(1.5, L / ((sp.lenA + sp.lenB) / 2)));
    f = Math.max(0.3, Math.min(2.5, f * (1 + (T / route.total - 1) * 1.5)));
    if (score < 0.25) break;
  }
  if (!best) throw new Error("別行動のルートを作れませんでした。合流場所を変えてみてください");
  return best.route;
}

async function buildRoute() {
  if (!plan.home) return showPlanError("先にスタート地点を決めてください");
  showPlanError("");
  $("#btnMake").disabled = true; $("#btnMake").textContent = "ルートを作っています…";
  try {
    if (isDest()) {
      if (!plan.dest) throw new Error("目的地を選んでください（名前で探すか、地図をタップ）");
      plan.route = await makeDestRoute();
    } else if (plan.split > 0 && meetPoint()) {
      plan.route = await makeSplitRoute();
    } else {
    const r = rng(plan.seed), home = plan.home, rad0 = legRadius(), target = loopMeters();
    // 経由地の置き方を何通りか試す。寄り道先があるときは、左回り・右回りと、寄る順番を入れ替える
    let shapes, stopAt = null;
    if (plan.stop !== "none" && plan.chosen) {
      const c = plan.chosen.pos, b = bearing(home, c), dc = dist(home, c), first = r() < 0.5 ? 60 : -60;
      stopAt = c;
      shapes = [first, -first, first * 0.6, -first * 0.6].flatMap((side) => [
        { stopIndex: 1, wps: (f) => [home, c, dest(home, b + side, dc * 0.95 * f), home] },
        { stopIndex: 2, wps: (f) => [home, dest(home, b + side, dc * 0.95 * f), c, home] },
      ]).slice(0, 5);
    } else {
      const θ = r() * 360;
      shapes = [0, 90, 180, 270, 45].map((turn) => ({
        stopIndex: null,
        // 三角形より丸に近い周回になるよう、経由地を3つ置く
        wps: (f) => [home, dest(home, θ + turn - 25, rad0 * 0.95 * f), dest(home, θ + turn + 35, rad0 * 1.05 * f), dest(home, θ + turn + 95, rad0 * 0.85 * f), home],
      }));
    }
    // 経由地でUターンさせずにルートを作り、「同じ道の往復の少なさ」と「目標の距離への近さ」で点数をつける。
    // 1本目の結果から距離の倍率を学んで、2本目以降に使う
    const ignore = [home, ...(stopAt ? [stopAt] : [])];
    let f = 1, best = null;
    for (let i = 0; i < shapes.length; i++) {
      const sh = shapes[i], pts = sh.wps(f);
      let route;
      try { route = shapeRoute(await osrm(pts, true), pts, sh.stopIndex); } catch (e) { if (i === 0 && !best) throw e; continue; }
      const over = overlapRatio(route, ignore), off = Math.abs(route.total - target) / target;
      const score = over * 2 + off;
      if (!best || score < best.score) best = { route, score, over, off };
      if (i === 0) f = Math.max(0.2, Math.min(2.5, f * (stopAt ? 1 + (target / route.total - 1) * 1.6 : target / route.total)));
      if (over < 0.03 && off < 0.12) break;
    }
    plan.route = best.route;
    }
    showSummary();
    await drawPlan();
    loadPois(plan.route);
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
  $("#sumLoop").textContent = `${info.clockwise ? "時計回り" : "反時計回り"}のルート。歩きはじめたら、まず${info.first}へ向かいます（地図の矢印の向き）`;
  if (r.dest) {
    const toMin = Math.round(r.dest.along / WALK_SPEED / 60);
    $("#sumLoop").textContent = r.dest.back === "oneway"
      ? `「${r.dest.name}」までの片道です。歩きはじめたら、まず${info.first}へ向かいます。帰りは電車やバスで（着いたら乗りかえを調べるボタンが出ます）`
      : `「${r.dest.name}」まで約${toMin}分。帰りは別の道でスタート地点へ戻ります。歩きはじめたら、まず${info.first}へ向かいます（地図の矢印の向き）`;
  }
  $("#sumStop").textContent = plan.chosen && plan.stop !== "none" ? `途中で「${plan.chosen.name}」に寄ります` : r.dest ? "寄り道なしで、目的地へ向かいます" : "寄り道なしで、ぐるっと一周します";
  const { sunset } = sunTimes(new Date(), plan.home[0], plan.home[1]);
  const night = isNightWalk(Date.now(), r.total / WALK_SPEED / 60, plan.home);
  $("#sumPois").textContent = r.pois ? (r.pois.length ? `ルート沿いに、ちょっと見たい場所が${r.pois.length}か所あります（地図の丸いマーク）` : "") : "ルート沿いの見どころを探しています…";
  if (r.split) {
    const sp = r.split, mA = Math.round(sp.lenA / WALK_SPEED / 60), mB = Math.round(sp.lenB / WALK_SPEED / 60);
    $("#sumSplit").textContent = `途中の「分かれ道」から二手に分かれ、${mA === mB ? `どちらも約${mA}分` : `約${Math.min(mA, mB)}〜${Math.max(mA, mB)}分`}歩いて「${sp.meetName}」で合流します（青と黒の道）` +
      (isNightWalk(Date.now(), r.total / WALK_SPEED / 60, plan.home) ? "。日が暮れているので、明るい道を選んで気をつけて歩いてください" : "");
  } else $("#sumSplit").textContent = "";
  const tk = themeKey(plan.seed);
  $("#sumTheme").textContent = tk ? `今日のテーマは「${THEMES[tk].label}」` : "";
  $("#sumWeather").textContent = "";
  fetchWeather(plan.home).then((w) => {
    plan.weather = w;
    if (!w) return;
    const note = { rain: "。雨の日のお題も混ざります", snow: "。雪の日のお題も混ざります", hot: "。暑いので、日陰を選んで歩きましょう", cold: "。冷えるので、あたたかくして出かけましょう" }[w.kind] || "";
    $("#sumWeather").textContent = `いまの天気は${w.label}・${w.temp}℃${note}`;
  });
  if (r.detours && r.detours.length) {
    const names = `「${r.detours.join("」「")}」`;
    $("#sumStop").textContent = plan.chosen && plan.stop !== "none" ? `途中で「${plan.chosen.name}」と${names}に寄ります` : `途中で${names}に寄ります`;
  }
  $("#sumSun").textContent = night ? `日の入りは${fmtTime(sunset)}。いま出発すると、夜向けのお題も混ざります` : `日の入りは${fmtTime(sunset)}`;
  $("#routeSummary").hidden = false;
}
function showPlanError(msg) { $("#planError").textContent = msg; $("#planError").hidden = !msg; }

// 合流場所の候補を探す（「寄り道先」を選んだときは寄り道先をそのまま使う）
async function prepareMeet() {
  plan.meetCands = []; plan.meetChosen = null;
  renderMeetCands();
  if (!plan.split || isDest()) return true;
  if (plan.meet === "stop") {
    if (plan.stop === "none" || !plan.chosen) { showPlanError("合流場所を「寄り道先」にするには、寄り道先を選んでください"); return false; }
    return true;
  }
  // おまかせ：神社・公園・史跡・景色のいい所をランダムな順に試して、見つかった種類を使う
  const types = plan.meet === "any" ? shuffle(["shrine", "park", "historic", "viewpoint"], rng(plan.seed ^ 0x3c)) : [plan.meet];
  for (const type of types) {
    plan.meetCands = (await findCandidates(type).catch(() => [])).filter((c) => !plan.chosen || c.id !== plan.chosen.id);
    if (plan.meetCands.length) break;
  }
  plan.meetChosen = plan.meetCands[0] || null;
  renderMeetCands();
  if (!plan.meetChosen) { showPlanError("合流場所にちょうどいい場所が見つかりませんでした。合流場所の種類を変えてみてください"); return false; }
  return true;
}
function renderMeetCands() {
  const box = $("#meetCands");
  box.innerHTML = "";
  plan.meetCands.forEach((c) => {
    box.appendChild(candidateRow(c, plan.meetChosen && plan.meetChosen.id === c.id, plan.meet === "any" ? STOP_TYPES[c.type].label : "", () => { plan.meetChosen = c; renderMeetCands(); buildRoute(); }));
  });
}

async function onMake() {
  if (!plan.home) return showPlanError("先にスタート地点を決めてください");
  if (isDest() && !plan.dest) return showPlanError("目的地を選んでください（名前で探すか、地図をタップ）");
  showPlanError("");
  plan.route = null; $("#routeSummary").hidden = true;
  if (plan.stop === "none") { plan.chosen = null; if (await prepareMeet()) await buildRoute(); else drawPlan(); return; }
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
    if (!plan.candidates.length) showPlanError(isDest() ? "目的地までの途中に見つかりませんでした。寄り道先を変えてみてください" : "ちょうどいい距離に見つかりませんでした。歩く時間か寄り道先を変えてみてください");
    const r = rng(plan.seed);
    plan.chosen = plan.candidates[Math.floor(r() * Math.min(3, plan.candidates.length))] || null;
    renderCandidates();
    drawPlan();
    if (plan.chosen && await prepareMeet()) await buildRoute();
  } catch (e) {
    showPlanError(e.message);
  } finally {
    $("#btnMake").disabled = false; $("#btnMake").textContent = "ルートを作る";
  }
}

// ---------- 共有 ----------
function shareLink() {
  const payload = {
    h: plan.home.map((v) => +v.toFixed(5)), m: plan.minutes, i: plan.interval, s: plan.seed, st: plan.stop, th: plan.theme,
    w: plan.route && (plan.route.detours || plan.route.dest) ? plan.route.waypoints.map((q) => q.map((v) => +v.toFixed(5))) : undefined,
    si: plan.route && (plan.route.detours || plan.route.dest) ? plan.route.stopIndex : undefined, dt: plan.route && plan.route.detours,
    ds: plan.route && plan.route.dest ? (({ name, pos, back, idx }) => ({ n: name, p: pos.map((v) => +v.toFixed(5)), b: back, i: idx }))(plan.route.dest) : undefined,
    sp: plan.route && plan.route.split ? (({ wA, wB, stopIndex, meetName, meetPos, minutes }) => ({ wA: wA.map((q) => q.map((v) => +v.toFixed(5))), wB: wB.map((q) => q.map((v) => +v.toFixed(5))), si: stopIndex, n: meetName, p: meetPos, min: minutes }))(plan.route.split) : undefined,
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
    Object.assign(plan, { home: p.h, minutes: p.m, interval: p.i, seed: p.s, stop: p.st, theme: p.th || "any", shared: true, shape: p.ds ? "dest" : "loop" });
    plan.chosen = p.c ? { id: p.c.id, name: p.c.n, pos: p.c.p, type: p.c.t || p.st, d: dist(p.h, p.c.p) } : null;
    plan.candidates = plan.chosen ? [plan.chosen] : [];
    $("#sharedBanner").hidden = false;
    $("#planForm").hidden = true; $("#btnMake").hidden = true;
    planMap.jumpTo({ center: ll(plan.home), zoom: 15 });
    if (p.sp) {
      // 別行動のルートは、2本の経由地をそのまま使って同じ道にする。リンクを開いた人には黒の道をすすめる
      const A = shapeRoute(await osrm(p.sp.wA, true), p.sp.wA, p.sp.si ?? null), B = shapeRoute(await osrm(p.sp.wB, true), p.sp.wB, p.sp.si ?? null);
      plan.route = composeSplit(A, B, { meetName: p.sp.n, meetPos: p.sp.p, minutes: p.sp.min, wA: p.sp.wA, wB: p.sp.wB, stopIndex: p.sp.si ?? null });
      plan.split = p.sp.min; plan.role = "B";
      showSummary(); await drawPlan(); loadPois(plan.route);
    } else if (p.ds) {
      // 目的地へのルートも、経由地をそのまま使って同じ道にする
      plan.dest = { name: p.ds.n, pos: p.ds.p }; plan.back = p.ds.b;
      plan.route = attachDest(shapeRoute(await osrm(p.w, true), p.w, p.si ?? null), p.ds.i, { ...plan.dest, back: p.ds.b });
      if (p.dt) plan.route.detours = p.dt;
      showSummary(); await drawPlan(); loadPois(plan.route);
    } else if (p.w) {
      // 寄り道を足したルートは、経由地をそのまま使って同じ道にする
      plan.route = shapeRoute(await osrm(p.w), p.w, p.si ?? null);
      plan.route.detours = p.dt || [];
      showSummary(); await drawPlan(); loadPois(plan.route);
    } else await buildRoute();
    return true;
  } catch { return false; }
}

// ---------- お題の予定 ----------
// お題は「歩いた距離」で届く。同じseedなら二人のスマホで同じ場所・同じお題になる
const fits = (night) => (m) => !m.when || m.when === (night ? "night" : "day");
function missionPlan(seed, total, interval, stopAlong, night, theme, weather, oneway) {
  const avoid = [].concat(stopAlong).filter((v) => v != null);
  const r = rng(seed ^ 0x5a5a);
  let look = shuffle(MISSIONS.look.filter(fits(night)), r).map((m) => ({ kind: "look", ...m }));
  // テーマがある日は、テーマに合うお題を3回に2回の割合で出す
  if (theme && THEMES[theme]) {
    const extra = (THEMES[theme].extra || []).filter(fits(night)).map((m) => ({ kind: "look", ...m }));
    const on = shuffle([...extra, ...look.filter((m) => THEMES[theme].test.test(m.text))], r), off = look.filter((m) => !THEMES[theme].test.test(m.text));
    if (on.length >= 4) { look = []; while (on.length || off.length) { if (on.length) look.push(on.shift()); if (on.length) look.push(on.shift()); if (off.length) look.push(off.shift()); } }
  }
  const talk = shuffle(MISSIONS.talk, r).map((m) => ({ kind: "talk", ...m }));
  // 季節のお題は、最初のほうに混ぜる
  // （テーマがある日は、テーマのお題を先に出してから）
  MISSIONS.season[seasonKey(new Date().getMonth() + 1)].filter(fits(night))
    .forEach((m) => look.splice((theme ? 5 : 1) + Math.floor(r() * 3), 0, { kind: "look", ...m }));
  // 天気のお題は、はじめのほうに混ぜる
  if (weather && weather.kind) shuffle(MISSIONS.weather[weather.kind].filter(fits(night)), r).slice(0, 3)
    .forEach((m, i) => look.splice(i * 2, 0, { kind: "look", ...m }));
  // 観察を多めに：観察・観察・会話のタネ の繰り返し
  const order = ["look", "look", "talk"];
  const used = { look: 0, talk: 0 };
  const step = interval * 60 * WALK_SPEED;
  const events = [];
  for (let at = 200, n = 0; at < total * 0.85; at += step, n++) {
    // 寄り道先の手前・直後とは重ならないようにする
    if (avoid.some((s) => Math.abs(at - s) < 150)) continue;
    const kind = order[n % order.length], pool = kind === "look" ? look : talk;
    events.push({ at, ...pool[used[kind]++ % pool.length], id: "m" + n });
  }
  events.push({ at: total * 0.9, ...(oneway ? MISSIONS.finalOneway : MISSIONS.final), id: "final" });
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
  // 現在地の矢印は、地図の向きに関係なく実際に向いている方向を指す
  if (walkMe) walkMe.setRotation(heading.compass != null ? heading.compass : routeHeading());
  // 少しずつ近づけて、地図がガタガタ回らないようにする
  let diff = ((heading.target - heading.shown + 540) % 360) - 180;
  if (Math.abs(diff) < 0.3) return;
  heading.shown = (heading.shown + diff * 0.15 + 360) % 360;
  if (walkMap) walkMap.setBearing(heading.shown);
  $("#btnHeading").style.transform = `rotate(${-heading.shown}deg)`;
}
function cycleHeading() {
  heading.mode = heading.mode === "north" ? "compass" : "north";
  store.set("headingMode", heading.mode);
  $("#btnHeading").textContent = heading.mode === "north" ? "N" : "↑";
  toast(heading.mode === "north" ? "北が上の地図にしました" : heading.compass == null ? "進む方向が上の地図にしました" : "向いている方向が上の地図にしました");
}

// 現在地を画面の下寄りに置いて、進む先が広く見えるようにする
function sizeWalkMap() {
  if (!walkMap) return;
  walkMap.resize();
  walkMap.setPadding({ top: Math.round($("#mapWrap").clientHeight * 0.3), bottom: 0, left: 0, right: 0 });
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
let walkMap, walkMe, walkMarkers = [];

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
    events: missionPlan(plan.seed, route.total, plan.interval, [route.stopAlong, route.dest && route.dest.back === "round" ? route.dest.along : null], night, themeKey(plan.seed), plan.weather, route.dest && route.dest.back === "oneway"), eventIdx: 0,
    theme: themeKey(plan.seed), weather: plan.weather,
    split: route.split || null, branch: null, askedBranch: false, met: false, role: plan.role,
    turnAlert: plan.turnAlert, alerted: [], noticed: [],
    inbox: [], results: [], photos: 0,
    stopArrived: false, destArrived: false, resting: false, restMs: 0, restStart: 0, off: 0, simAlong: 0, done: false,
  };
  // 夫婦用ページ：AIのお題が届いたら、まだ届いていないお題と入れ替える
  if (window.Cloud) Cloud.missionsFor(route).then((list) => { if (walk && list.length && Cloud.applyMissions(walk, list)) saveActive(); });
  // 夫婦用ページ：相手からの手紙が届いていたら、出発のときに渡す
  if (window.Cloud && !sim) Cloud.openLetters().then((letters) => {
    if (!walk || !letters.length) return;
    letters.forEach((l, i) => walk.inbox.unshift({ kind: "letter", id: "letter" + i, label: `${l.from}からの手紙`, text: l.text, arrivedAt: Date.now() }));
    buzz([100, 80, 100]); renderCard(); saveActive();
  });
  if (walk.theme) walk.inbox.push({ kind: "theme", id: "theme", text: `今日のテーマは「${THEMES[walk.theme].label}」。${THEMES[walk.theme].desc}`, arrivedAt: Date.now() });
  buzz(100);
  resumeWalkSession();
}

// 散歩画面を開き、位置の取得を始める（再読み込みからの復帰でも使う）
function resumeWalkSession() {
  showView("walk");
  $("#simBadge").hidden = !walk.sim;
  $("#nightBadge").hidden = !walk.night;
  $("#themeBadge").hidden = !walk.theme;
  $("#destCard").hidden = true; showDestCard();
  if (walk.theme) $("#themeBadge").textContent = THEMES[walk.theme].label;
  $("#btnHeading").textContent = heading.mode === "north" ? "N" : "↑";
  if (!walkMap) {
    walkMap = makeMap($("#walkMap"), { dragPan: false, zoom: 17, center: ll(walk.pos) });
    walkMap.scrollZoom.enable({ around: "center" });
    walkMap.touchZoomRotate.enable({ around: "center" }); walkMap.touchZoomRotate.disableRotation();
    const me = mkEl("me");
    me.innerHTML = `<svg viewBox="0 0 34 34"><path d="M17 2 24 13H10Z" fill="${TRACK_COLOR}"/><circle cx="17" cy="18" r="8" fill="${TRACK_COLOR}" stroke="#fff" stroke-width="3"/></svg>`;
    walkMe = new maplibregl.Marker({ element: me, rotationAlignment: "map" }).setLngLat(ll(walk.pos)).addTo(walkMap);
  }
  walkMe.setLngLat(ll(walk.pos));
  walkMap.ready.then(() => {
    drawWalkRoute(); setTrack(walkMap, walk.track);
    sizeWalkMap(); walkMap.jumpTo({ center: ll(walk.pos), zoom: 17 });
  });
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
  if (!walkMap || !walkMap.isReady) return;
  // 別行動：選ぶ前は黒の道を、選んだあとは相手の道を灰色の点線で出す。合流したら消す
  clearRoute(walkMap, "routeB");
  if (walk.split && !walk.met) {
    const sp = walk.split;
    if (!walk.branch) setRoute(walkMap, sp.branchB, "routeB", BRANCH_B_COLOR);
    else setRoute(walkMap, walk.branch === "B" ? sp.branchA : sp.branchB, "routeB", "#9aa1a6", true);
  }
  setRoute(walkMap, walk.route.coords);
  walkMarkers.forEach((mk) => mk.remove()); walkMarkers = [];
  drawPois(walkMap, walk.route.pois, walkMarkers);
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
  if (dist(last, p) > 5) { walk.track.push(p); setTrack(walkMap, walk.track); }
  walkMe.setLngLat(ll(p));
  walkMap.jumpTo({ center: ll(p) });

  // ちらっと見たい場所の近くを通ったら知らせる
  (walk.route.pois || []).forEach((poi) => {
    if (!walk.noticed.includes(poi.id) && dist(p, poi.pos) < 45) {
      walk.noticed.push(poi.id);
      toast(`近くに「${poi.name}」（${poi.label}）があります`);
    }
  });

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

  // 別行動：分かれ道で道を選ぶ → 合流場所に着く
  if (walk.split) {
    const sp = walk.split;
    if (!walk.branch && !walk.askedBranch && prog >= sp.startAlong - 30) { walk.askedBranch = true; offerBranches(); }
    // 選ばずに青の道を進んでいたら、青の道を選んだことにする
    if (!walk.branch && prog > sp.startAlong + 100) chooseBranch("A");
    const meetAlong = walk.meetAlong != null ? walk.meetAlong : walk.branch === "B" ? sp.meetAlongB : sp.meetAlongA;
    if (walk.branch && !walk.met && prog >= meetAlong - 25) arriveMeet();
  }

  // 寄り道先に到着
  if (r.stopAlong != null && !walk.stopArrived && prog >= r.stopAlong - 25) arriveStop();
  // 目的地に到着
  if (r.dest && !walk.destArrived && r.dest.along != null && prog >= r.dest.along - 25) arriveDest();

  // 通り過ぎたお題を届ける（画面を閉じていた間の分もまとめて）
  let arrived = 0;
  while (walk.eventIdx < walk.events.length && walk.events[walk.eventIdx].at <= prog) {
    walk.inbox.push({ ...walk.events[walk.eventIdx++], arrivedAt: Date.now() });
    arrived++;
  }
  if (arrived) { buzz([80, 60, 160]); renderCard(); }

  // 帰宅（片道のときは、目的地のカードから終える）
  if (!(r.dest && r.dest.back === "oneway") && prog >= r.total - 25 && prog > r.total * 0.5) return finishWalk();
  saveActive();
  updateWalkUI();
}

// ---------- 別行動の流れ ----------
function branchInfo(which) {
  const sp = walk.split, w = which === "B" ? sp.wB : sp.wA, len = which === "B" ? sp.lenB : sp.lenA;
  return { dir: dir8(bearing(w[1], w[2])), min: Math.max(1, Math.round(len / WALK_SPEED / 60)), color: which === "B" ? "黒" : "青", len };
}
function offerBranches() {
  walk.inbox = walk.inbox.filter((m) => m.kind !== "choose");
  walk.inbox.unshift({ kind: "choose", id: "choose", text: `分かれ道に着きました。ここから二手に分かれて、「${walk.split.meetName}」で合流します。どちらの道を行く？`, arrivedAt: Date.now() });
  buzz([200, 100, 200]);
  renderCard();
}
function chooseBranch(which) {
  const sp = walk.split;
  walk.inbox = walk.inbox.filter((m) => m.kind !== "choose");
  walk.branch = which;
  if (which === "B") {
    // 黒の道に乗り換える。まだ届いていないお題の位置も、黒の道に合わせて付け替える
    walk.events.slice(walk.eventIdx).forEach((e) => {
      if (e.at <= sp.startAlong) return;
      e.at = e.at <= sp.meetAlongA ? sp.startAlong + (e.at - sp.startAlong) * (sp.lenB / sp.lenA) : e.at + (sp.meetAlongB - sp.meetAlongA);
    });
    sp.B.pois = walk.route.pois;
    walk.route = sp.B;
    walk.alerted = walk.route.turns.map((t, i) => (t.along < walk.progress ? i : -1)).filter((i) => i >= 0);
  }
  const b = branchInfo(which), left = Math.max(0, b.len - Math.max(0, walk.progress - sp.startAlong));
  walk.meetEta = Date.now() + (left / WALK_SPEED) * 1000 / (walk.sim ? SIM_SPEED : 1);
  const pick = MISSIONS.split[Math.floor(rng(walk.seed ^ 0x99)() * MISSIONS.split.length)];
  walk.inbox.unshift(
    { kind: "split", id: "split", text: `${b.color}の道を行きます。「${sp.meetName}」に${fmtTime(walk.meetEta)}ごろ着く予定です。相手もほぼ同じころに着きます。`, arrivedAt: Date.now() },
    { ...pick, id: "sp", label: "別行動のお題", arrivedAt: Date.now() },
  );
  drawWalkRoute(); renderCard(); saveActive();
  if (window.Cloud && !walk.sim) Cloud.event({ type: "branch", color: b.color });
}
function arriveMeet() {
  walk.met = true;
  const sp = walk.split, meetIsStop = sp.stopIndex === 3;
  MISSIONS.meet.slice(0, meetIsStop ? 2 : 3).forEach((x, i) => walk.inbox.push({ ...x, id: "mt" + i, label: i < 2 ? "合流" : null, arrivedAt: Date.now() }));
  buzz([200, 100, 200, 100, 200]);
  drawWalkRoute(); renderCard(); saveActive();
  if (window.Cloud && !walk.sim) { Cloud.event({ type: "met", place: sp.meetName }); Cloud.stopSharing(); }
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
function arriveDest() {
  walk.destArrived = true;
  const d = walk.route.dest;
  if (d.back === "round") walk.inbox.push({ kind: "dest", id: "dest", text: `「${d.name}」に着きました。ひと休みしたら、帰りは別の道でスタート地点へ戻ります`, arrivedAt: Date.now() });
  MISSIONS.dest.forEach((x, i) => walk.inbox.push({ ...x, id: "d" + i, arrivedAt: Date.now() }));
  buzz([200, 100, 200]);
  showDestCard(); renderCard(); saveActive();
}
// 片道：着いたら、帰りの電車・バスを調べるボタンを出す
function showDestCard() {
  const d = walk.route.dest;
  if (!d || d.back !== "oneway" || !walk.destArrived) return;
  const home = walk.route.waypoints[0], at = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  $("#destText").textContent = `「${d.name}」に着きました。おつかれさまでした。帰りは電車やバスでどうぞ。`;
  $("#btnTransit").href = `https://www.google.com/maps/dir/?api=1&origin=${at(walk.pos)}&destination=${at(home)}&travelmode=transit`;
  $("#destCard").hidden = false;
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
  $("#missionKind").textContent = m.label || (m.kind === "talk" ? `${k.label}・${TALK_CATS[m.cat]}` : k.label);
  $("#missionKind").className = "kind " + m.kind;
  $("#missionText").textContent = m.text;
  $("#missionTip").textContent = m.tip ? `観察のコツ：${m.tip}` : "";
  $("#missionTip").hidden = !m.tip;
  $("#missionMore").textContent = walk.inbox.length > 1 ? `ほかに${walk.inbox.length - 1}つ届いています` : "";
  $("#btnShoot").hidden = !k.shoot;
  $("#btnDone").textContent = k.done;
  $("#btnNext").hidden = INFO_KINDS.includes(m.kind);
  $("#memoBox").hidden = true;
  // 分かれ道では、2本の道のボタンを出す
  $("#splitBox").hidden = m.kind !== "choose";
  $("#missionActions").hidden = m.kind === "choose";
  if (m.kind === "choose") {
    ["A", "B"].forEach((w) => {
      const b = branchInfo(w), btn = $("#btnBranch" + w);
      btn.textContent = `${b.color}の道（${b.dir}へ・約${b.min}分）`;
      btn.classList.toggle("reco", (walk.role || "A") === w);
    });
  }
  updateWalkUI();
}
// 「見つけた」「話した」を押したら、一言メモ欄を開く
function askMemo() {
  const m = walk.inbox[0];
  if (!m) return;
  if (INFO_KINDS.includes(m.kind)) return resolve("done");
  $("#missionActions").hidden = true; $("#memoBox").hidden = false;
  $("#memoInput").value = "";
  $("#memoInput").placeholder = m.kind === "talk" ? "どんな話になった？（なくてもOK）" : "何を見つけた？（なくてもOK）。キーボードのマイクで声でも入力できます";
}
function resolve(outcome, memo) {
  const m = walk.inbox.shift();
  if (!m) return;
  if (INFO_KINDS.includes(m.kind)) { renderCard(); saveActive(); return; }
  walk.results.push({ id: m.id, kind: m.kind, cat: m.cat || null, text: m.text, outcome, memo: memo || null });
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
  } else if (r.dest && !walk.destArrived) {
    $("#nextArrow").textContent = "↑"; $("#nextText").textContent = "このまま目的地へ"; $("#nextSub").textContent = r.dest.name;
  } else if (r.dest && r.dest.back === "oneway") {
    $("#nextArrow").textContent = "✓"; $("#nextText").textContent = "目的地に着きました"; $("#nextSub").textContent = r.dest.name;
  } else {
    $("#nextArrow").textContent = "⌂"; $("#nextText").textContent = "このままゴールへ"; $("#nextSub").textContent = "";
  }
  $("#statRemain").textContent = `${fmtKm(Math.max(0, r.total - prog))}km`;
  const showMeet = walk.split && walk.branch && !walk.met;
  // 夫婦用ページ：別行動のあいだは、お互いの現在地をやりとりする
  if (window.Cloud && showMeet && !walk.sim) Cloud.shareWhileApart(walk);
  $("#meetBadge").hidden = !showMeet;
  if (showMeet) $("#meetBadge").textContent = `合流 ${fmtTime(walk.meetEta)}・${walk.split.meetName}`;
  const elapsed = (Date.now() - walk.startedAt) * (walk.sim ? SIM_SPEED : 1);
  $("#statTime").textContent = `${Math.floor(elapsed / 60000)}分経過`;
  const ev = walk.events[walk.eventIdx];
  const arrivedOneway = r.dest && r.dest.back === "oneway" && walk.destArrived;
  $("#idleCard").hidden = walk.inbox.length > 0 || walk.resting || arrivedOneway;
  $("#idleText").textContent = ev ? `次のお題は ${fmtDist(ev.at - prog)} 先で届きます` : `今日のお題はここまで。${r.dest && !walk.destArrived ? "目的地" : "ゴール"}までの道を楽しんで`;
}

// 道を外れたときや、散歩中に見どころへ寄るときに、いまいる場所から引き直す
async function reroute(via) {
  const r = walk.route;
  const legIdx = r.legEnds.findIndex((e) => e > walk.progress);
  const rest = r.waypoints.slice(legIdx + 1);
  const viaPts = via && via.pos ? [via.pos] : [];
  const pts = [walk.pos, ...viaPts, ...rest];
  let stopIndex = null;
  if (r.stopIndex != null && !walk.stopArrived && r.stopIndex >= legIdx + 1) stopIndex = r.stopIndex - legIdx + viaPts.length;
  $("#btnReroute").disabled = true;
  try {
    const nr = shapeRoute(await osrm(pts), pts, stopIndex);
    // まだ届いていないお題は、新しい道の上で同じ順番に並べ直す
    const remaining = walk.events.slice(walk.eventIdx);
    const shift = remaining.length ? remaining[0].at - walk.progress : 0;
    const step = remaining.length > 1 ? remaining[1].at - remaining[0].at : 0;
    remaining.forEach((e, i) => (e.at = Math.min(nr.total * 0.9, Math.max(50, shift) + step * i)));
    walk.events = remaining; walk.eventIdx = 0;
    nr.pois = r.pois;
    if (r.dest) {
      const di = !walk.destArrived && r.dest.idx >= legIdx + 1 ? r.dest.idx - legIdx + viaPts.length : null;
      nr.dest = { ...r.dest, idx: di, along: di != null ? nr.legEnds[di - 1] : null };
      // 片道で目的地に着いたあとも、家の位置は乗りかえ案内に使うので残しておく
      nr.waypoints = [r.waypoints[0], ...nr.waypoints.slice(1)];
    }
    walk.route = nr; walk.progress = 0; walk.simAlong = 0; walk.off = 0; walk.alerted = [];
    drawWalkRoute();
    $("#offRoute").hidden = true;
    toast(viaPts.length ? `「${via.name}」に寄ってから、もとの道に戻ります` : "ここからの道を引き直しました");
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
  w.inbox.filter((m) => !INFO_KINDS.includes(m.kind)).forEach((m) => w.results.push({ id: m.id, kind: m.kind, cat: m.cat || null, text: m.text, outcome: "skip" }));
  const record = {
    id: w.id, startedAt: w.startedAt, endedAt: Date.now(), minutes: Math.round(elapsed / 60000),
    distance: Math.round(early ? w.progress : w.route.total), stopName: w.stopName,
    route: w.route.coords.filter((_, i) => i % 3 === 0), track: w.track, photos: w.photos,
    results: w.results, sim: w.sim, night: !!w.night, theme: w.theme || null, weather: w.weather || null, seed: w.seed,
    split: w.split ? { meetName: w.split.meetName, branch: w.branch } : null,
    dest: w.route.dest ? { name: w.route.dest.name, back: w.route.dest.back } : null,
  };
  // この散歩で新しく取ったバッジと、上がった称号を記録しておく
  try {
    const before = ownWalks(await allWalks());
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
  if (window.Cloud) { Cloud.stopSharing(); Cloud.sync(true).then(() => !record.sim && record.distance > 300 && Cloud.diary(record.id, true)); }
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

// 自分の散歩だけ（相手の端末から同期された散歩は、バッジや称号に数えない）
const ownWalks = (walks) => walks.filter((w) => !w.fromCloud || (window.Cloud && w.owner === Cloud.myId()));
// 二人がそれぞれ記録した同じ散歩（同じルートで、出発が45分以内）を1つにまとめる。自分の記録を先頭にする
function groupWalks(walks) {
  const groups = [];
  walks.slice().sort((a, b) => b.startedAt - a.startedAt).forEach((w) => {
    const g = groups.find((g) => w.seed != null && g.some((x) => x.seed === w.seed && x.owner !== w.owner && Math.abs(x.startedAt - w.startedAt) < 45 * 60000));
    if (g) g.push(w); else groups.push([w]);
  });
  const mine = (w) => !w.fromCloud || (window.Cloud && w.owner === Cloud.myId());
  return groups.map((g) => g.sort((a, b) => mine(b) - mine(a)));
}
async function photosOfGroup(group) {
  const all = (await Promise.all(group.map((w) => photosOf(w.id)))).flat();
  return all.sort((a, b) => a.at - b.at);
}

async function renderAlbum() {
  releaseUrls();
  const box = $("#albumList");
  const walks = (await allWalks()).sort((a, b) => b.startedAt - a.startedAt);
  renderBadges(ownWalks(walks));
  if (window.Cloud) {
    Cloud.renderBox();
    if (!renderAlbum.syncing) {
      renderAlbum.syncing = true;
      Cloud.sync().then((changed) => { renderAlbum.syncing = false; if (changed && !$("#view-album").hidden) renderAlbum(); });
    }
  }
  // ホーム画面に追加していないSafariでは、しばらく使わないと保存したデータが消されることがある
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("#backupHint").textContent = "写真と記録はこのスマホの中だけに保存されています。ときどき書き出しておくと安心です。" +
    (standalone ? "" : "Safariのままだと、しばらく使わないと消えることがあります。共有ボタンの「ホーム画面に追加」から使うのがおすすめです。");
  box.innerHTML = "";
  if (!walks.length) { box.innerHTML = '<p class="empty">まだ散歩の記録はありません。<br>散歩から帰ると、ここに道のりと写真、今日の気づきが残ります。</p>'; return; }
  for (const group of groupWalks(walks)) {
    const w = group[0], ps = await photosOfGroup(group);
    const b = document.createElement("button");
    b.className = "walkitem";
    b.innerHTML = '<div class="thumb"></div><div><div class="t"></div><div class="m"></div></div>';
    if (ps[0]) b.querySelector(".thumb").style.backgroundImage = `url(${blobUrl(photoBlob(ps[0]))})`;
    const who = group.length > 1 ? "・ふたりで" : w.fromCloud && window.Cloud && w.owner !== Cloud.myId() ? `・${Cloud.nameOf(w.owner)}の記録` : "";
    b.querySelector(".t").textContent = `${fmtDate(w.startedAt)}${w.dest ? "・" + w.dest.name + "へ" : ""}${w.stopName ? "・" + w.stopName : ""}${who}`;
    const done = group.reduce((n, x) => n + (x.results || []).filter((r) => r.outcome === "done").length, 0);
    b.querySelector(".m").textContent = `${fmtKm(w.distance)}km ・ ${w.minutes}分 ・ 気づき${done} ・ 写真${ps.length}枚${w.sim ? " ・ 試し" : ""}`;
    b.onclick = () => openDetail(w.id);
    box.appendChild(b);
  }
}

let detailMap, detailMarkers = [];
async function openDetail(id) {
  showView("detail");
  releaseUrls();
  const w = await getWalk(id);
  if (!w) return showView("album");
  const group = groupWalks(await allWalks()).find((g) => g.some((x) => x.id === id)) || [w];
  const ps = await photosOfGroup(group);
  const label = (owner) => (group.length > 1 && window.Cloud ? Cloud.nameOf(owner) : "");
  $("#detailTitle").textContent = `${fmtDate(w.startedAt)}の散歩`;
  $("#detailMeta").textContent = `${fmtTime(w.startedAt)}〜${fmtTime(w.endedAt)} ・ ${fmtKm(w.distance)}km${w.dest ? ` ・ ${w.dest.name}まで${w.dest.back === "oneway" ? "片道" : "往復"}` : ""}${w.stopName ? " ・ " + w.stopName + "に寄り道" : ""}${w.night ? " ・ 夜さんぽ" : ""}`;
  const fresh = (w.newBadges || []).map((bid) => BADGES.find((b) => b.id === bid)).filter(Boolean);
  $("#detailNew").hidden = !fresh.length && !w.newTitle;
  $("#newTitle").hidden = !w.newTitle;
  if (w.newTitle) $("#newTitle").textContent = `称号が「${w.newTitle}」になりました`;
  $("#newBadges").innerHTML = "";
  fresh.forEach((b) => { const el = stamp(b, true); el.querySelector(".bdesc").textContent = b.desc; $("#newBadges").appendChild(el); });

  if (!detailMap) detailMap = makeMap($("#detailMap"));
  detailMarkers.forEach((mk) => mk.remove()); detailMarkers = [];
  detailMap.ready.then(() => {
    detailMap.resize();
    setRoute(detailMap, w.route);
    setTrack(detailMap, w.track);
    ps.forEach((p) => {
      if (!p.pos) return;
      const e = mkEl("photodot"); e.addEventListener("click", () => openViewer(p));
      detailMarkers.push(htmlMarker(detailMap, p.pos, e));
    });
    detailMap.fitBounds(boundsOf(w.route), { padding: 28, animate: false });
  });

  const grid = $("#detailPhotos");
  grid.innerHTML = "";
  ps.forEach((p) => {
    const b = document.createElement("button");
    b.style.backgroundImage = `url(${blobUrl(photoBlob(p))})`;
    b.setAttribute("aria-label", p.mission || "写真");
    b.onclick = () => openViewer(p);
    if (label(p.owner)) b.dataset.who = label(p.owner);
    grid.appendChild(b);
  });

  if (window.Cloud) { Cloud.renderDiary(group); Cloud.renderLetter(group); }
  // ふたりで歩いたときは、二人の気づきをまとめて、誰の気づきかを添える
  const done = group.flatMap((x) => (x.results || []).filter((r) => r.outcome === "done").map((r) => ({ ...r, owner: x.owner })));
  $("#detailLog").hidden = !done.length;
  $("#logList").innerHTML = "";
  done.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = '<span class="k"></span><span class="t"></span>';
    li.querySelector(".k").textContent = (label(r.owner) ? label(r.owner) + "・" : "") + (r.kind === "talk" ? "話した" : "見つけた");
    li.querySelector(".t").textContent = r.text;
    if (r.memo) { const mm = document.createElement("span"); mm.className = "memo"; mm.textContent = r.memo; li.appendChild(mm); }
    $("#logList").appendChild(li);
  });
}

// ---------- バックアップ ----------
// 写真と記録を1つのファイル（JSON）にまとめて書き出す。iPhoneでは共有メニューから「ファイル」に保存できる
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToBuf(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function exportAll() {
  $("#btnExport").disabled = true;
  try {
    const walks = await allWalks();
    const photos = await idb("photos", "readonly", (st) => st.getAll());
    const out = [];
    for (const p of photos) out.push({ walkId: p.walkId, type: p.type || "image/jpeg", mission: p.mission, pos: p.pos, at: p.at, data: bufToBase64(await toBuffer(photoBlob(p))) });
    const json = JSON.stringify({ app: "futari-sanpo", version: 1, exportedAt: Date.now(), walks, photos: out });
    const d = new Date(), name = `futari-sanpo-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
    const file = new File([json], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "ふたり散歩のバックアップ" }); return toast("書き出しました"); }
    } catch (e) { if (e.name === "AbortError") return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`「${name}」を書き出しました`);
  } catch (e) {
    toast("書き出せませんでした：" + (e && e.message), true);
  } finally { $("#btnExport").disabled = false; }
}
async function importAll(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "futari-sanpo") throw new Error("ふたり散歩のバックアップファイルではありません");
    const haveWalks = new Set((await allWalks()).map((w) => w.id));
    const havePhotos = new Set((await idb("photos", "readonly", (st) => st.getAll())).map((p) => p.walkId + ":" + p.at));
    let nw = 0, np = 0;
    for (const w of data.walks || []) if (!haveWalks.has(w.id)) { await putWalk(w); nw++; }
    for (const p of data.photos || []) {
      if (havePhotos.has(p.walkId + ":" + p.at)) continue;
      await addPhoto({ walkId: p.walkId, type: p.type, mission: p.mission, pos: p.pos, at: p.at, data: base64ToBuf(p.data) });
      np++;
    }
    toast(nw || np ? `散歩${nw}回分と写真${np}枚を読み込みました` : "新しく読み込む記録はありませんでした");
    renderAlbum();
  } catch (err) {
    toast("読み込めませんでした：" + (err && err.message), true);
  }
}

// ---------- 使い方 ----------
const GUIDE = [
  { step: "1 / 5", title: "ルートを作る", pic: "スタート → 寄り道 → ゴール", items: [
    "地図をタップするか「現在地にする」で、スタート地点を決めます",
    "歩く時間と寄り道先を選んで「ルートを作る」",
    "「目的地へ」にすると、駅やお店まで歩くルートになります。帰りは別の道で歩くか、電車・バスで帰るかを選べます",
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
    "できたら「見つけた」「話した」。一言メモも残せます。気分じゃなければ「次へ」で飛ばせます",
    "その日のテーマを選ぶと、テーマに合うお題が多めに出ます。雨の日は雨のお題も混ざります",
  ] },
  { step: "5 / 5", title: "写真とアルバム", pic: "撮る → アルバム", items: [
    "右下のカメラボタンか、お題の「撮る」で撮影します",
    "写真はこのアプリの中に保存されます。カメラロールに残したい写真は、アルバムで写真を開いて保存してください",
    "帰ると、道のり・写真・今日の気づき・バッジがアルバムに残ります",
    "アルバムの「ファイルに書き出す」で、ときどきバックアップしておくと安心です",
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
  if (name === "plan" && planMap) setTimeout(() => planMap.resize(), 50);
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

// ---------- 新しい版のお知らせ ----------
// ホーム画面から開いたアプリには再読み込みのボタンがないので、新しい版が出ていたら知らせる。
// index.html に書かれた app.js?v=番号 を、今動いている番号と比べる
const RUNNING_VERSION = (document.querySelector('script[src*="app.js?v="]')?.getAttribute("src").match(/v=(\d+)/) || [])[1];
let lastVersionCheck = 0;
async function checkUpdate() {
  if (!RUNNING_VERSION || walk || Date.now() - lastVersionCheck < 60000) return;
  lastVersionCheck = Date.now();
  try {
    const html = await (await fetch(location.pathname + "?v=" + Date.now(), { cache: "no-store" })).text();
    const latest = (html.match(/app\.js\?v=(\d+)/) || [])[1];
    if (latest && latest !== RUNNING_VERSION) $("#updateBar").hidden = false;
  } catch {}
}

// ---------- 起動 ----------
function init() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  initPlanMap();
  if (plan.home) setHome(plan.home);
  const resetRoute = () => { plan.candidates = []; plan.chosen = null; plan.route = null; plan.meetCands = []; plan.meetChosen = null; renderCandidates(); renderMeetCands(); $("#routeSummary").hidden = true; showPlanError(""); drawPlan(); };
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
  bindSeg("segTheme", "theme", () => plan.route && showSummary());
  bindSeg("segSplit", "split", () => { $("#meetBox").hidden = !plan.split; resetRoute(); });
  bindSeg("segMeet", "meet", resetRoute);
  bindSeg("segShape", "shape", () => { applyShapeUI(); resetRoute(); });
  bindSeg("segBack", "back", resetRoute);
  $("#destForm").addEventListener("submit", onDestSearch);
  applyShapeUI();
  $("#btnDestEnd").onclick = () => finishWalk();
  $("#meetBox").hidden = !plan.split;
  $("#btnBranchA").onclick = () => chooseBranch("A");
  $("#btnBranchB").onclick = () => chooseBranch("B");

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
  $("#btnDone").onclick = askMemo;
  $("#btnMemoSave").onclick = () => resolve("done", $("#memoInput").value.trim());
  $("#btnMemoSkip").onclick = () => resolve("done");
  $("#btnNext").onclick = () => resolve("skip");
  $("#btnResume").onclick = resumeFromRest;
  $("#btnReroute").onclick = () => reroute();
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
  $("#btnExport").onclick = exportAll;
  $("#importInput").addEventListener("change", importAll);
  $("#btnCloseViewer").onclick = () => ($("#viewer").hidden = true);
  $("#viewer").onclick = (e) => { if (e.target.id === "viewer") $("#viewer").hidden = true; };
  $("#btnHelp1").onclick = openGuide;
  $("#btnHelp2").onclick = openGuide;
  $("#btnGuideNext").onclick = () => { if (guidePage < GUIDE.length - 1) { guidePage++; renderGuide(); } else closeGuide(); };
  $("#btnGuideSkip").onclick = closeGuide;

  $("#btnUpdate").onclick = () => location.reload();
  checkUpdate();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && checkUpdate());

  // 散歩の途中でページが読み込み直されたら、続きから再開する
  const active = store.get("active", null);
  if (active && active.results && Date.now() - active.startedAt < 6 * 3600e3) {
    walk = { alerted: [], noticed: [], ...active, lastFixAt: 0 };
    resumeWalkSession();
    toast("散歩の続きから再開しました");
    return;
  }
  store.del("active");
  if (!store.get("guideSeen", 0)) openGuide();
  if (window.Cloud) Cloud.init();
  loadShared();
}
init();
