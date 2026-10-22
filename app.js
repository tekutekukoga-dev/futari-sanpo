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
  party: store.get("party", "duo"), // duo: ふたりで / solo: ひとりで
  shape: store.get("shape", "loop"),
  meguri: store.get("meguri", "none"), // none / ankyo / fudo / tree
  fresh: store.get("fresh", false), // はじめての道を多めに // loop: ぐるっと一周 / dest: 目的地へ
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
const isSolo = () => plan.party === "solo";

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
// 名前でわかる名所（お地蔵さん・庚申塔・富士塚・不動さん・保存樹など）
const NAMED_SPOTS = [[/不動/, "history", "お不動さん"], [/地蔵/, "history", "お地蔵さん"], [/庚申/, "history", "庚申塔"], [/道祖神/, "history", "道祖神"], [/富士塚|浅間/, "history", "富士塚"], [/一里塚/, "history", "一里塚"], [/古墳/, "history", "古墳"], [/保存樹|保護樹|巨樹|名木|神木/, "nature", "名木・巨樹"], [/湧水|湧き水|清水$/, "nature", "湧き水"]];
function poiKind(t) {
  const nm = t["name:ja"] || t.name || "";
  if (nm && !t.shop && !t.office && !t.highway && !t.railway && !/駐車|バス|駅|銀行|不動産|マンション|ハイツ|荘|公園$|通り$/.test(nm)) {
    const hit = NAMED_SPOTS.find(([re]) => re.test(nm));
    if (hit && (t.historic || t.amenity === "place_of_worship" || t.natural || t.tourism || t.man_made)) return [hit[1], hit[2]];
  }
  if (t.natural === "tree" && (t.denotation === "natural_monument" || t.heritage)) return ["nature", "天然記念物の木"];
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
node["natural"="tree"]["denotation"~"natural_monument|landmark"]${A};
nwr["amenity"="place_of_worship"]["name"~"不動|地蔵|庚申|浅間"]${A};
nwr["name"~"富士塚|一里塚|庚申塔|道祖神|保存樹|巨樹|古墳"]${A};
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
// 地図タイルの「線」（川・道）を取り出す。名前などの情報と、[緯度, 経度] の並びを返す
function decodeTileLines(bytes, layerName, z, tx, ty) {
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
        while (p < ve) { const t3 = varint(), f3 = t3 >> 3; if (f3 === 1) v = str(); else if (f3 === 4 || f3 === 5) v = varint(); else if (f3 === 6) v = zz(varint()); else if (f3 === 7) v = !!varint(); else skip(t3 & 7); }
        values.push(v);
      } else if (f === 5) extent = varint();
      else skip(t & 7);
    }
    if (name !== layerName) continue;
    const n = 2 ** z, toLL = (gx, gy) => {
      const lon = (tx + gx / extent) / n * 360 - 180, yy = Math.PI - 2 * Math.PI * (ty + gy / extent) / n;
      return [Math.atan(Math.sinh(yy)) * 180 / Math.PI, lon];
    };
    feats.forEach(([fs, fe]) => {
      p = fs;
      const props = {}; let type = 0, geom = null;
      while (p < fe) {
        const t = varint(), f = t >> 3;
        if (f === 2) { const te = varint() + p; while (p < te) { const k = varint(), v = varint(); props[keys[k]] = values[v]; } }
        else if (f === 3) type = varint();
        else if (f === 4) { const ge = varint() + p; geom = [p, ge]; p = ge; }
        else skip(t & 7);
      }
      if ((type !== 2 && type !== 3) || !geom) return;
      p = geom[0];
      let x = 0, y = 0, line = null;
      while (p < geom[1]) {
        const cmd = varint(), id = cmd & 7, cnt = cmd >> 3;
        for (let i = 0; i < cnt && id !== 7; i++) {
          x += zz(varint()); y += zz(varint());
          if (id === 1) { if (line && line.length > 1) out.push({ props, coords: line }); line = []; }
          line.push(toLL(x, y));
        }
      }
      if (line && line.length > 1) out.push({ props, coords: line });
    });
  }
  return out;
}
// 地図タイルを、場所のまわり r の範囲だけ読んで、決めたレイヤーの線や点を集める
async function tilesAround(center, r, decode) {
  const z = 14, n = 2 ** z, url = await poiTileUrl();
  const tx = (lon) => Math.floor((lon + 180) / 360 * n);
  const ty = (lat) => Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * n);
  const a = dest(center, 315, r * Math.SQRT2), b = dest(center, 135, r * Math.SQRT2);
  const jobs = [];
  for (let x = tx(a[1]); x <= tx(b[1]); x++) for (let y = ty(a[0]); y <= ty(b[0]); y++) {
    if (jobs.length >= 36) break;
    jobs.push(fetch(url.replace("{z}", z).replace("{x}", x).replace("{y}", y), { signal: AbortSignal.timeout(10000) })
      .then((res) => (res.ok ? res.arrayBuffer() : null)).then((buf) => (buf ? decode(new Uint8Array(buf), z, x, y) : [])).catch(() => []));
  }
  return (await Promise.all(jobs)).flat();
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
const LETTERFUL = new Set(["shop", "grocery", "clothing_store", "restaurant", "fast_food", "cafe", "bar", "beer", "bakery", "ice_cream", "alcohol_shop", "butcher", "pharmacy", "bank", "hairdresser", "laundry", "cinema", "music", "books", "stationery", "florist", "jewelry", "shoes", "gift", "hardware", "furniture", "electronics", "mobile_phone", "optician", "toys", "post", "railway", "library", "art_gallery", "doctors", "dentist", "car", "bicycle", "deli", "seafood", "confectionery", "tea", "coffee", "convenience"]);
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
  // 看板の文字が多そうな場所（お店・飲食店・駅など）だけを数える
  route.letterSpots = pts.filter(({ props: pr }) => LETTERFUL.has(pr.class)).map(({ lat, lon }) => [+lat.toFixed(5), +lon.toFixed(5)]);
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
    nr.pois = r.pois; nr.letterSpots = r.letterSpots;
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
    drawMeguri(planMap, plan.route, planMarkers);
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
// 名前で探す。2つの検索サービスに同時に聞いて、スタート地点に近い順に並べる。
// チェーン店は同じ名前の店がたくさんあるので、名前ではなく場所で重なりを除く
const DEST_RANGE = 15000;
// よく使う呼び方を、お店の正式な名前に直す
const NICKNAMES = { "スタバ": "スターバックス", "マック": "マクドナルド", "マクド": "マクドナルド", "ケンタ": "ケンタッキー", "セブン": "セブン-イレブン", "ファミマ": "ファミリーマート", "サイゼ": "サイゼリヤ", "ミスド": "ミスタードーナツ", "モス": "モスバーガー", "無印": "無印良品", "ドンキ": "ドン・キホーテ", "マツキヨ": "マツモトキヨシ", "コンビニ": "コンビニエンスストア" };
const NOISE = /駐車場|駐輪場|自転車|バイク|パーキング|出口|入口|口$/;
async function searchDest(q) {
  q = q.normalize("NFKC").trim();
  q = NICKNAMES[q] || q;
  const [lat, lon] = plan.home;
  const a = dest(plan.home, 315, DEST_RANGE * Math.SQRT2), b = dest(plan.home, 135, DEST_RANGE * Math.SQRT2);
  // Photon：あいまいな言葉にも強い。スタート地点のまわり15kmの四角の中だけで探す
  const photon = getJson(`${PHOTON_SEARCH}?q=${encodeURIComponent(q)}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&bbox=${a[1].toFixed(4)},${b[0].toFixed(4)},${b[1].toFixed(4)},${a[0].toFixed(4)}&limit=50`)
    .then((d) => d.features.map((f) => {
      const pr = f.properties;
      return { id: pr.osm_type + pr.osm_id, name: pr.name || [pr.street, pr.housenumber].filter(Boolean).join(" "), pos: [f.geometry.coordinates[1], f.geometry.coordinates[0]], area: pr.district || pr.locality || pr.city || "" };
    })).catch(() => []);
  // Overpass：チェーン店の全部の店舗を名前とブランドで探す（近い10km）
  const re = q.replace(/[.*+?^${}()|[\]\\"]/g, ""); // 記号は検索の邪魔になるので外す
  const oq = `[out:json][timeout:8];(nwr["name"~"${re}",i](around:8000,${lat},${lon});nwr["brand"~"${re}",i](around:8000,${lat},${lon}););out tags center 80;`;
  const overpassReq = getJson(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(oq), headers: { "Content-Type": "application/x-www-form-urlencoded" } })
    .then((d) => d.elements.map((e) => ({
      id: e.type[0].toUpperCase() + e.id, name: [e.tags.name || e.tags.brand, e.tags.branch && !String(e.tags.name || "").includes(e.tags.branch) ? e.tags.branch : ""].filter(Boolean).join(" "),
      pos: e.lat != null ? [e.lat, e.lon] : [e.center.lat, e.center.lon], area: e.tags["addr:quarter"] || e.tags["addr:neighbourhood"] || e.tags["addr:suburb"] || "",
    }))).catch(() => []);
  // Overpass は混んでいると遅いので、Photon の答えから4秒までしか待たない
  const photonList = await photon;
  const overpass = await Promise.race([overpassReq, new Promise((r) => setTimeout(() => r([]), photonList.length ? 4000 : 8000))]);
  let list = [...overpass, ...photonList];
  if (!list.length) {
    const data = await getJson(`${NOMINATIM}?q=${encodeURIComponent(q)}&viewbox=${a[1]},${a[0]},${b[1]},${b[0]}&bounded=1&format=jsonv2&limit=40`)
      .catch(() => { throw new Error("場所を探せませんでした。電波の良いところで、もう一度お試しください"); });
    list = data.map((e) => ({ id: e.osm_type[0].toUpperCase() + e.osm_id, name: e.name, pos: [+e.lat, +e.lon], area: "" }));
  }
  // 名前がぴったり合うもの → 名前がその言葉ではじまるもの → そのほか、の順。同じ順位なら近い順。駐車場などは後ろに
  const tier = (c) => (NOISE.test(c.name) && !NOISE.test(q) ? 3 : c.name === q || c.name.split(" ")[0] === q ? 0 : c.name.startsWith(q) ? 1 : 2);
  const out = [];
  list.filter((c) => c.name).map((c) => ({ ...c, d: dist(plan.home, c.pos), t: tier(c) }))
    .filter((c) => c.d > 150 && c.d < DEST_RANGE)
    .sort((x, y) => x.t - y.t || x.d - y.d)
    .forEach((c) => { if (!out.some((o) => dist(o.pos, c.pos) < 40 || (o.name === c.name && dist(o.pos, c.pos) < 300))) out.push(c); });
  return out.slice(0, 8);
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
  const same = (a, b) => a && b && dist(a.pos, b.pos) < 40;
  if (plan.dest && !list.some((c) => same(c, plan.dest))) list.unshift({ ...plan.dest, d: plan.home ? dist(plan.home, plan.dest.pos) : 0 });
  // 同じ名前の店が並ぶときは、地域の名前を添えて見分けられるようにする
  const dup = (c) => list.filter((x) => x.name === c.name).length > 1;
  list.forEach((c) => {
    box.appendChild(candidateRow(c, same(plan.dest, c), dup(c) && plan.home ? `${dir8(bearing(plan.home, c.pos))}へ` : "", () => chooseDest(c)));
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
  $("#itemSplit").hidden = isSolo() || !!MEGURI[plan.meguri];
  // 目的地モードでは、合流場所は目的地
  $("#meetBox").hidden = !plan.split || isDest();
  $("#splitDestNote").hidden = !(plan.split && isDest());
  renderMeguriInfo();
  $("#btnShare").hidden = isSolo();
  $("#mapHint").textContent = isDest() ? "地図をタップすると、そこを目的地にできます（スタート地点は「現在地にする」で変えられます）" : "地図をタップすると、そこをスタート地点にできます";
  renderDestCands();
}
function attachDest(route, idx, d) {
  route.dest = { name: d.name, pos: d.pos, back: d.back, idx, along: route.legEnds[idx - 1] };
  return route;
}
// 経由地の並び：[家, (寄り道先), 目的地] / 往復は [家, (寄り道先), 目的地, 帰りの経由地, 家]。
// 帰りの経由地は、行きの道の横にずらして置き、同じ道を戻らないようにする
// 目的地までの途中で通れる、めぐりの場所（暗渠は線、不動明王・名木は点）を選ぶ。
// 遠回りしすぎないもの（行きの道から外れる長さが少ないもの）だけを使う
async function destMeguriPoints(home, D) {
  const d = dist(home, D), kind = plan.meguri, center = midOf(home, D), r = Math.min(3500, d / 2 + 700);
  const k = Math.cos(rad(home[0])), vx = (D[1] - home[1]) * k, vy = D[0] - home[0], len2 = vx * vx + vy * vy || 1e-12;
  const along = (p) => (((p[1] - home[1]) * k) * vx + (p[0] - home[0]) * vy) / len2;
  const detour = (p) => dist(home, p) + dist(p, D) - d;
  const streams = MEGURI[kind].line ? ankyoStreams(await findLines(kind, center, r).catch(() => [])) : [];
  if (streams.length) {
    let best = null;
    for (const st of streams.slice(0, 8)) {
      const pts = pointsAlong(st.ways, 200).filter((p) => along(p) > 0.03 && along(p) < 0.97 && detour(p) < Math.max(800, d * 0.6));
      if (pts.length && (!best || pts.length > best.pts.length)) best = { st, pts };
    }
    if (best) {
      const pts = best.pts.sort((a, b) => along(a) - along(b));
      const pick = pts.length > 5 ? pts.filter((_, i) => i % Math.ceil(pts.length / 5) === 0) : pts;
      return { pts: pick, along, meguri: { kind, name: best.st.name, lines: best.st.ways.map((w) => w.coords.filter((_, i) => i % 2 === 0 || i === w.coords.length - 1)), spots: [] } };
    }
  }
  if (kind === "ankyo") throw new Error("目的地までの途中に、通れる暗渠が見つかりませんでした。めぐりを「なし」にするか、ほかのめぐりにしてみてください");
  const spots = (await findMeguriSpots(kind, center, r).catch(() => []))
    .filter((x) => along(x.pos) > 0.03 && along(x.pos) < 0.97 && detour(x.pos) < Math.max(700, d * 0.5) && dist(x.pos, D) > 80)
    .sort((a, b) => detour(a.pos) - detour(b.pos)).slice(0, 2)
    .sort((a, b) => along(a.pos) - along(b.pos));
  if (!spots.length) throw new Error(`目的地までの途中に、${MEGURI[kind].label}が見つかりませんでした。めぐりを「なし」にするか、ほかのめぐりにしてみてください`);
  return { pts: spots.map((x) => x.pos), along, meguri: { kind, spots: spots.map(({ id, name, label, pos }) => ({ id, name, label, pos })), lines: [] } };
}
async function makeDestRoute() {
  const home = plan.home, D = plan.dest.pos, d = dist(home, D);
  if (d > 15000) throw new Error("目的地がスタート地点から遠すぎます（15kmまで）");
  const c = plan.chosen && plan.stop !== "none" ? plan.chosen.pos : null;
  // めぐりがあるときは、行きの道の途中に、めぐる場所と寄り道先を「目的地に近づく順」に並べる
  const mgp = MEGURI[plan.meguri] ? await destMeguriPoints(home, D) : null;
  const mids = mgp ? [...mgp.pts, ...(c ? [c] : [])].sort((a, b) => mgp.along(a) - mgp.along(b)) : c ? [c] : [];
  const out = [home, ...mids, D], stopIndex = c ? out.indexOf(c) : null, di = out.length - 1;
  const withMeguri = (route) => {
    if (mgp) route.meguri = { ...mgp.meguri, meters: mgp.meguri.lines.length ? ankyoMeters(route, mgp.meguri.lines) : 0 };
    return route;
  };
  const info = { ...plan.dest, back: plan.back };
  if (plan.back === "oneway") return withMeguri(attachDest(shapeRoute(await osrm(out, true), out, stopIndex), di, info));
  const b = bearing(home, D), mid = midOf(home, D);
  // 寄り道先があるときは、その反対側を帰り道にする
  let side = rng(plan.seed)() < 0.5 ? 1 : -1;
  if (c) side = ((bearing(home, c) - b + 540) % 360) - 180 > 0 ? -1 : 1;
  const ignore = [home, D, ...(c ? [c] : [])];
  const tries = [side, -side].flatMap((sd) => [0.3, 0.45].map((k) => ({ sd, k })));
  const cells = plan.fresh ? await myWalkedCells() : null;
  let best = null, err = null;
  for (const { sd, k } of tries) {
    const pts = [...out, dest(mid, b + sd * 90, Math.max(200, d * k)), home];
    let route;
    try { route = shapeRoute(await osrm(pts, true), pts, stopIndex); } catch (e) { err = e; continue; }
    const over = overlapRatio(route, ignore), fresh = cells ? freshRatio(route, cells, home) : 1;
    const score = over * 2 + route.total / (d * 2) * 0.1 + (1 - fresh) * 1.5;
    if (!best || score < best.score) best = { route, score };
    if (over < 0.04 && fresh > 0.8) break;
  }
  if (!best) throw err || new Error("ルートを作れませんでした");
  return withMeguri(attachDest(best.route, di, info));
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

// ---------- めぐり（暗渠・不動明王・名木） ----------
// 好きなものを積極的に通るルート。暗渠は「線」に沿って歩き、不動明王と名木は「点」をつないで回る
// line: 線に沿って歩くもの（地図には太い線で出す）。それ以外は場所（点）をつないで回る
const MEGURI = {
  ankyo: { label: "暗渠", mark: "渠", line: true, color: "#5ab4e5" },
  shotengai: { label: "商店街", mark: "商", line: true, color: "#ef8a1f" },
  fudo: { label: "不動明王", mark: "不" },
  tree: { label: "名木・巨樹", mark: "木" },
  kissa: { label: "純喫茶", mark: "喫" },
  park: { label: "公園はしご", mark: "園" },
};
async function overpassJson(q, ms = 15000) {
  const res = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error("overpass " + res.status);
  return (await res.json()).elements || [];
}
// 不動明王・名木を探す。場所は点（お寺やお堂の真ん中、木の位置）。
// 地図タイル（お寺・お堂）と Photon（名前のついた木やお堂）を先に使い、Overpass は答えたときだけ足す
const FUDO_NG = /駐車|バス|駅|銀行|不動産|マンション|ハイツ|荘|通り|坂$|橋$|公園|幼稚|保育|クリニック|医院/;
async function findMeguriSpots(kind, center, r) {
  if (["kissa", "park", "shotengai"].includes(kind)) {
    const out = [];
    (await findTileSpots(kind, center, r)).map((x) => ({ ...x, kind, d: dist(center, x.pos) })).filter((x) => x.d < r * 1.2)
      .forEach((x) => { if (!out.some((o) => dist(o.pos, x.pos) < 60 || (o.name === x.name && !/お店の多い|名前のわからない|遊具のある/.test(x.name) && dist(o.pos, x.pos) < 1200))) out.push(x); });
    return out;
  }
  const list = [];
  const push = (id, name, pos, label) => { if (name && pos) list.push({ id, name, label, pos, kind, d: dist(center, pos) }); };
  const photonAround = async (tag) => {
    const rings = [center, ...[0, 60, 120, 180, 240, 300].map((b) => dest(center, b, r * 0.6))];
    const res = await Promise.allSettled(rings.map((p) => getJson(`${PHOTON}?lat=${p[0].toFixed(5)}&lon=${p[1].toFixed(5)}&radius=${(r * 0.7 / 1000).toFixed(2)}&limit=40&osm_tag=${tag}`)));
    return res.filter((x) => x.status === "fulfilled").flatMap((x) => x.value.features);
  };
  const overpass = (q) => overpassJson(q, 9000).catch(() => []);
  const A = `(around:${Math.round(r)},${center[0].toFixed(5)},${center[1].toFixed(5)})`;
  if (kind === "fudo") {
    const [tiles, photon, op] = await Promise.all([
      tilesAround(center, r, (bytes, z, x, y) => decodeTilePoints(bytes, "poi", z, x, y)).catch(() => []),
      photonAround("amenity:place_of_worship").catch(() => []),
      overpass(`[out:json][timeout:15];(nwr["name"~"不動"]["amenity"="place_of_worship"]${A};nwr["deity"~"不動|Acala"]${A};nwr["historic"]["name"~"不動"]${A};);out tags center 80;`),
    ]);
    tiles.forEach(({ props: pr, lat, lon }) => { const nm = pr["name:ja"] || pr.name || ""; if (/不動/.test(nm) && !FUDO_NG.test(nm) && pr.class === "place_of_worship") push("t" + lat.toFixed(5), nm, [lat, lon], "不動明王"); });
    photon.forEach((f) => { const nm = f.properties.name || ""; if (/不動/.test(nm) && !FUDO_NG.test(nm)) push(f.properties.osm_type + f.properties.osm_id, nm, [f.geometry.coordinates[1], f.geometry.coordinates[0]], "不動明王"); });
    op.forEach((e) => { const t = e.tags || {}, nm = t["name:ja"] || t.name || ""; if (!FUDO_NG.test(nm)) push(e.type[0] + e.id, nm, e.lat != null ? [e.lat, e.lon] : e.center && [e.center.lat, e.center.lon], "不動明王"); });
  } else {
    // Wikidata：名前のついた木（「〇〇のイチョウ」など）
    const wikidata = (async () => {
      const q = `SELECT ?item ?itemLabel ?coord WHERE { SERVICE wikibase:around { ?item wdt:P625 ?coord. bd:serviceParam wikibase:center "Point(${center[1].toFixed(5)} ${center[0].toFixed(5)})"^^geo:wktLiteral. bd:serviceParam wikibase:radius "${(r / 1000).toFixed(1)}". } ?item rdfs:label ?l. FILTER(LANG(?l)="ja" && REGEX(?l, "(ケヤキ|欅|イチョウ|銀杏|クスノキ|楠|大樹|巨樹|神木|スダジイ|タブノキ|ムクノキ|エノキ|の松|の桜)$")) SERVICE wikibase:label { bd:serviceParam wikibase:language "ja". } } LIMIT 40`;
      const res = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { signal: AbortSignal.timeout(9000) });
      return (await res.json()).results.bindings.map((x) => { const m = x.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/); return m && { id: x.item.value.split("/").pop(), name: x.itemLabel.value, pos: [+m[2], +m[1]] }; }).filter(Boolean);
    })().catch(() => []);
    // 御神木がありそうな神社（名木が見つからないときに使う）
    const shrines = tilesAround(center, r, (bytes, z, x, y) => decodeTilePoints(bytes, "poi", z, x, y)).catch(() => []);
    const [photon, op, wd] = await Promise.all([
      photonAround("natural:tree").catch(() => []),
      overpass(`[out:json][timeout:15];(node["natural"="tree"]["name"]${A};node["natural"="tree"]["denotation"~"natural_monument|landmark"]${A};node["natural"="tree"]["heritage"]${A};);out tags 120;`),
      wikidata,
    ]);
    photon.forEach((f) => push(f.properties.osm_type + f.properties.osm_id, f.properties.name, [f.geometry.coordinates[1], f.geometry.coordinates[0]], "名木・巨樹"));
    wd.forEach((x) => push(x.id, x.name, x.pos, "名木・巨樹"));
    op.forEach((e) => { const t = e.tags || {}; push(e.type[0] + e.id, t["name:ja"] || t.name || (t.denotation === "natural_monument" ? "天然記念物の木" : "保存樹"), [e.lat, e.lon], t.denotation === "natural_monument" ? "天然記念物の木" : "名木・巨樹"); });
    // 地図に名木がほとんど載っていない町では、御神木がありそうな神社をめぐる
    if (list.filter((x) => x.d < r).length < 2) {
      (await shrines).forEach(({ props: pr, lat, lon }) => {
        const nm = pr["name:ja"] || pr.name || "";
        if (pr.class === "place_of_worship" && /神社|八幡|稲荷|天神|氷川|明神|宮$/.test(nm)) push("t" + lat.toFixed(5), nm, [lat, lon], "御神木のありそうな神社");
      });
    }
  }
  // 同じ場所が別々に見つかったら1つにまとめる
  const out = [];
  list.filter((x) => x.d < r * 1.2).forEach((x) => { if (!out.some((o) => dist(o.pos, x.pos) < 60)) out.push(x); });
  return out;
}
// 暗渠を探す。地図タイルの「ふたをされた水路（トンネル）」と「〇〇緑道・遊歩道」を使い、Overpass が答えたら足す
const ANKYO_NAME = /緑道|遊歩道|せせらぎ|暗渠|川跡|親水/;
async function findAnkyo(center, r) {
  const A = `(around:${Math.round(r)},${center[0].toFixed(5)},${center[1].toFixed(5)})`;
  const [water, names, op] = await Promise.all([
    tilesAround(center, r, (bytes, z, x, y) => decodeTileLines(bytes, "waterway", z, x, y)).catch(() => []),
    tilesAround(center, r, (bytes, z, x, y) => decodeTileLines(bytes, "transportation_name", z, x, y)).catch(() => []),
    overpassJson(`[out:json][timeout:15];(way["waterway"]["tunnel"="culvert"]${A};way["waterway"]["covered"="yes"]${A};way["highway"]["name"~"緑道|遊歩道|せせらぎ|暗渠|川跡|親水"]${A};);out tags geom 300;`, 9000).catch(() => []),
  ]);
  const ways = [];
  const add = (id, name, river, coords, real) => {
    let len = 0;
    for (let i = 1; i < coords.length; i++) len += dist(coords[i - 1], coords[i]);
    if (len > 40 && coords.some((q) => dist(q, center) < r * 1.2)) ways.push({ id, name, river, coords, len, real });
  };
  water.forEach((w, i) => { if (w.props.brunnel === "tunnel") add("tw" + i, w.props["name:ja"] || w.props.name || "", w.props["name:ja"] || w.props.name || "", w.coords, true); });
  names.forEach((w, i) => { const nm = w.props["name:ja"] || w.props.name || ""; if (ANKYO_NAME.test(nm)) add("tn" + i, nm, nm.replace(/緑道|遊歩道|せせらぎ|親水公園|の道$/g, ""), w.coords, false); });
  op.filter((e) => e.geometry && e.geometry.length > 1).forEach((e) => {
    const t = e.tags || {};
    add("w" + e.id, t.name || "", t.waterway ? t.name || "" : (t.name || "").replace(/緑道|遊歩道|せせらぎ|親水公園|の道$/g, ""), e.geometry.map((g) => [g.lat, g.lon]), !!t.waterway);
  });
  return ways;
}
// 商店街：名前のついた商店街の通り（線）。地図タイルの道の名前と、Overpass が答えたらそれも使う
const SHOTENGAI_NAME = /商店街|商店会|銀座|横丁|仲見世|アーケード|名店街|一番街|すずらん通り|モール$|ロード$/;
async function findShotengai(center, r) {
  const A = `(around:${Math.round(r)},${center[0].toFixed(5)},${center[1].toFixed(5)})`;
  const [names, op] = await Promise.all([
    tilesAround(center, r, (bytes, z, x, y) => decodeTileLines(bytes, "transportation_name", z, x, y)).catch(() => []),
    overpassJson(`[out:json][timeout:15];way["highway"]["name"~"商店街|商店会|銀座|横丁|仲見世|名店街"]${A};out tags geom 200;`, 9000).catch(() => []),
  ]);
  const ways = [];
  const add = (id, name, coords) => {
    let len = 0;
    for (let i = 1; i < coords.length; i++) len += dist(coords[i - 1], coords[i]);
    if (len > 40 && coords.some((q) => dist(q, center) < r * 1.2)) ways.push({ id, name, river: name, coords, len, real: true });
  };
  names.forEach((w, i) => { const nm = w.props["name:ja"] || w.props.name || ""; if (SHOTENGAI_NAME.test(nm) && !/^銀座[一二三四五六七八]?丁?目?$|銀座通り$/.test(nm)) add("sn" + i, nm, w.coords); });
  op.filter((e) => e.geometry && e.geometry.length > 1).forEach((e) => add("w" + e.id, (e.tags || {}).name || "", e.geometry.map((g) => [g.lat, g.lon])));
  return ways;
}
// 線でめぐるもの（暗渠・商店街）
const findLines = (kind, center, r) => (kind === "shotengai" ? findShotengai(center, r) : findAnkyo(center, r));
const CHAIN_KISSA = /スターバックス|スタバ|ドトール|タリーズ|コメダ|エクセルシオール|プロント|サンマルク|ベローチェ|上島|星乃|むさしの森|カフェ・ド・クリエ|クリエ|ブルーボトル|マクドナルド|モスバーガー|コンビニ/;
const KISSA_WORD = /喫茶|珈琲|茶房|純喫茶|コーヒー|ティールーム|パーラー|カフェテラス/;
// 純喫茶・公園・お店の多い通り（点）を、地図タイルから探す
async function findTileSpots(kind, center, r) {
  if (kind === "kissa") {
    const pts = await tilesAround(center, r, (bytes, z, x, y) => decodeTilePoints(bytes, "poi", z, x, y)).catch(() => []);
    const cafes = pts.filter(({ props: pr }) => pr.class === "cafe" && (pr["name:ja"] || pr.name) && !CHAIN_KISSA.test(pr["name:ja"] || pr.name));
    // 「喫茶」「珈琲」などの名前の店を先に。少なければ、チェーンでないカフェも使う
    const retro = cafes.filter(({ props: pr }) => KISSA_WORD.test(pr["name:ja"] || pr.name));
    return (retro.length >= 2 ? retro : cafes).map(({ props: pr, lat, lon }) => ({ id: "t" + lat.toFixed(5) + lon.toFixed(5), name: pr["name:ja"] || pr.name, label: KISSA_WORD.test(pr.name || "") ? "喫茶店" : "カフェ", pos: [lat, lon] }));
  }
  if (kind === "park") {
    // 公園の形（緑地）から真ん中を出す。名前は、近くのバス停などの「〇〇公園」から借りる
    const [areas, uses, pts] = await Promise.all([
      tilesAround(center, r, (bytes, z, x, y) => decodeTileLines(bytes, "landcover", z, x, y)).catch(() => []),
      tilesAround(center, r, (bytes, z, x, y) => decodeTileLines(bytes, "landuse", z, x, y)).catch(() => []),
      tilesAround(center, r, (bytes, z, x, y) => decodeTilePoints(bytes, "poi", z, x, y)).catch(() => []),
    ]);
    // 「〇〇公園前」「〇〇公園北」などのバス停名から、公園の名前だけを取り出す。前に別の地名がついたもの（「三鷹警察署井の頭公園」）は外す
    const parkNames = pts.map(({ props: pr, lat, lon }) => { const m = (pr["name:ja"] || pr.name || "").match(/^([^\s・　（(]+?公園)/); return m && !/署|局|駅|学校|病院|団地|センター/.test(m[1]) && { name: m[1], pos: [lat, lon] }; }).filter(Boolean);
    const playgrounds = uses.filter((u) => u.props.class === "playground").map((u) => u.coords[0]);
    const parks = [];
    areas.filter((a) => a.props.subclass === "park" || a.props.class === "park").forEach((a) => {
      const lats = a.coords.map((c) => c[0]), lons = a.coords.map((c) => c[1]);
      const pos = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];
      const size = dist([Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]);
      if (size < 50) return;
      // 大きな公園は地図タイルの境目で分かれているので、近いものは1つにまとめる
      const same = parks.find((q) => dist(q.pos, pos) < Math.max(120, Math.max(q.size, size) / 2 + 80));
      if (same) { if (size > same.size) { same.pos = pos; same.size = size; } return; }
      parks.push({ pos, size });
    });
    return parks.map((q, i) => {
      // いちばん多く出てくる名前を、その公園の名前にする
      const near = parkNames.filter((n) => dist(n.pos, q.pos) < Math.max(150, q.size * 0.7)), cnt = {};
      near.forEach((n) => (cnt[n.name] = (cnt[n.name] || 0) + 1));
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
      const nm = top && { name: top[0] };
      const play = playgrounds.some((g) => dist(g, q.pos) < Math.max(80, q.size / 2));
      return { id: "pk" + q.pos[0].toFixed(4) + q.pos[1].toFixed(4), name: nm ? nm.name : play ? "遊具のある公園" : "名前のわからない公園", label: play ? "遊具のある公園" : "公園", pos: q.pos, size: q.size, i };
    }).sort((a, b) => b.size - a.size).slice(0, 30);
  }
  // 商店街の名前が見つからないとき：お店がぎゅっと集まっている場所を、80m四方のマスで探す。名前は近くの道からつける
  const [pts, roads] = await Promise.all([
    tilesAround(center, r, (bytes, z, x, y) => decodeTilePoints(bytes, "poi", z, x, y)).catch(() => []),
    tilesAround(center, r, (bytes, z, x, y) => decodeTileLines(bytes, "transportation_name", z, x, y)).catch(() => []),
  ]);
  const roadName = (pos) => {
    let best = null, bd = 70;
    roads.forEach((w) => { const nm = w.props["name:ja"] || w.props.name; if (!nm || /^[0-9]/.test(nm)) return; w.coords.forEach((q) => { const d = dist(q, pos); if (d < bd) { bd = d; best = nm; } }); });
    return best;
  };
  const cells = {};
  pts.filter(({ props: pr }) => LETTERFUL.has(pr.class) && pr.class !== "railway").forEach(({ lat, lon }) => {
    const k = `${Math.round(lat * 111320 / 80)},${Math.round(lon * 91000 / 80)}`;
    (cells[k] = cells[k] || { n: 0, lat: 0, lon: 0 }); cells[k].n++; cells[k].lat += lat; cells[k].lon += lon;
  });
  const out = [];
  Object.values(cells).filter((c) => c.n >= 8).sort((a, b) => b.n - a.n).forEach((c) => {
    const pos = [c.lat / c.n, c.lon / c.n];
    if (!out.some((o) => dist(o.pos, pos) < 250)) { const rn = roadName(pos); out.push({ id: "sc" + pos[0].toFixed(4) + pos[1].toFixed(4), name: rn ? `${rn}のお店` : "お店の多い通り", label: `お店${c.n}軒`, pos }); }
  });
  return out;
}

// 暗渠の線を、名前ごとにまとめて1本の流れにする（長い順）
function ankyoStreams(ways) {
  const by = {};
  ways.forEach((w) => { const k = w.river || w.name || w.id; (by[k] = by[k] || []).push(w); });
  return Object.entries(by).map(([k, ws]) => ({ name: k, ways: ws, len: ws.reduce((n, w) => n + w.len, 0) })).sort((a, b) => b.len - a.len);
}
// 線の上に、だいたい等間隔に経由地を置く（線に沿って歩かせるため）
function pointsAlong(ways, every) {
  const pts = [];
  ways.forEach((w) => { let acc = every; for (let i = 1; i < w.coords.length; i++) { acc += dist(w.coords[i - 1], w.coords[i]); if (acc >= every) { pts.push(w.coords[i]); acc = 0; } } });
  return pts;
}
// 経由地を、スタート地点から見た向きの順に並べて、ぐるっと回る順にする
function byBearing(home, pts) {
  const b0 = bearing(home, pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]));
  return pts.map((p) => ({ p, a: ((bearing(home, p) - b0 + 540) % 360) - 180 })).sort((x, y) => x.a - y.a).map((x) => x.p);
}
// ルートのうち、暗渠の線から20m以内を歩く長さ
function ankyoMeters(route, lines) {
  let m = 0;
  for (let a = 0; a < route.total; a += 20) {
    const p = pointAt(route, a);
    if (lines.some((c) => c.some((q) => dist(p, q) < 25))) m += 20;
  }
  return m;
}
// 商店街の一周。名前のついた商店街（線）と、お店の多い通り（点）を、向きの近いものから2〜3か所つないで回る
async function makeShotengaiLoop(home, target, r0, searchR, stop) {
  const [streams, clusters] = await Promise.all([
    findLines("shotengai", home, searchR).then(ankyoStreams).catch(() => []),
    findTileSpots("shotengai", home, searchR).catch(() => []),
  ]);
  const cands = [
    ...streams.map((st) => { const pts = pointsAlong(st.ways, 120); const c = pts.length ? pts[Math.floor(pts.length / 2)] : st.ways[0].coords[0]; return { st, pts: pts.length ? pts : [c], c, name: st.name }; }),
    ...clusters.filter((x) => !streams.some((st) => st.ways.some((w) => w.coords.some((q) => dist(q, x.pos) < 120)))).map((x) => ({ spot: x, pts: [x.pos], c: x.pos, name: x.name })),
  ].map((x) => ({ ...x, d: dist(home, x.c) })).filter((x) => x.d > 120 && x.d < r0 * 1.6);
  if (!cands.length) throw new Error("近くに商店街やお店の多い通りが見つかりませんでした。歩く時間を長くしてみてください");
  // 名前のある商店街を優先して、ちょうどいい距離のものを中心に選ぶ
  const ring = cands.slice().sort((a, b) => (a.st ? 0 : 1) - (b.st ? 0 : 1) || Math.abs(a.d - r0) - Math.abs(b.d - r0));
  let best = null;
  for (const c of ring.slice(0, 4)) {
    const bc = bearing(home, c.c);
    const friends = cands.filter((x) => x !== c && Math.abs(((bearing(home, x.c) - bc + 540) % 360) - 180) < 80).sort((a, b) => (a.st ? 0 : 1) - (b.st ? 0 : 1) || a.d - b.d).slice(0, 2);
    const set = [c, ...friends];
    let pts = set.flatMap((x) => x.pts);
    if (pts.length > 7) pts = pts.filter((_, i) => i % Math.ceil(pts.length / 7) === 0);
    const wps = [home, ...byBearing(home, [...pts, ...(stop ? [stop] : [])]), home];
    const stopIndex = stop ? wps.findIndex((p) => p === stop) : null;
    let route;
    try { route = shapeRoute(await osrm(wps, true), wps, stopIndex >= 0 ? stopIndex : null); } catch { continue; }
    const lines = set.filter((x) => x.st).flatMap((x) => x.st.ways.map((w) => w.coords));
    const shopM = ankyoMeters(route, lines) + set.filter((x) => x.spot).length * 150;
    const score = Math.abs(route.total - target) / target + overlapRatio(route, [home]) + (1 - Math.min(1, shopM / Math.max(600, route.total * 0.3)));
    if (!best || score < best.score) best = { route, score, set, lines };
  }
  if (!best) throw new Error("ルートを作れませんでした。少し待ってからもう一度お試しください");
  const r = best.route, named = best.set.filter((x) => x.st);
  r.meguri = {
    kind: "shotengai", name: named.map((x) => x.name).filter(Boolean).join("・"),
    lines: best.lines.map((c) => c.filter((_, i) => i % 2 === 0 || i === c.length - 1)), meters: ankyoMeters(r, best.lines),
    spots: best.set.filter((x) => x.spot).map((x) => ({ id: x.spot.id, name: x.spot.name, label: x.spot.label, pos: x.spot.pos })),
  };
  return r;
}
async function makeMeguriRoute() {
  const home = plan.home, target = loopMeters(), r0 = legRadius(), kind = plan.meguri;
  const stop = plan.chosen && plan.stop !== "none" ? plan.chosen.pos : null;
  const searchR = Math.max(600, r0 * 1.5);
  const tries = [];
  if (kind === "shotengai") return makeShotengaiLoop(home, target, r0, searchR, stop);
  const streams = MEGURI[kind].line ? ankyoStreams(await findLines(kind, home, searchR).catch(() => [])) : [];
  if (kind === "ankyo" && !streams.length) throw new Error("近くに暗渠が見つかりませんでした。歩く時間を長くするか、ほかのめぐりにしてみてください");
  if (streams.length) {
    // 長い流れから順に、その流れに沿って歩くルートを作ってみる
    for (const st of streams.slice(0, 4)) {
      const along = pointsAlong(st.ways, 250).filter((p) => dist(home, p) < r0 * 1.6);
      if (!along.length) continue;
      const pick = along.length > 5 ? along.filter((_, i) => i % Math.ceil(along.length / 5) === 0) : along;
      tries.push({ pts: byBearing(home, stop ? [...pick, stop] : pick), stream: st });
    }
    if (!tries.length && kind === "ankyo") throw new Error("暗渠が遠すぎました。歩く時間を長くしてみてください");
  }
  if (!tries.length) {
    // 商店街の名前が見つからないときは、お店の多い通りをめぐる
    const spots = (await findMeguriSpots(kind === "shotengai" ? "shotengai" : kind, home, searchR).catch(() => [])).filter((s) => s.d > 120);
    if (!spots.length) throw new Error(`近くに${MEGURI[kind].label}が見つかりませんでした。歩く時間を長くしてみてください`);
    // ちょうどいい距離のものを中心に、近い向きにあるものをあと1〜2か所つなぐ
    const ring = spots.slice().sort((a, b) => Math.abs(a.d - r0) - Math.abs(b.d - r0));
    for (const c of ring.slice(0, 4)) {
      const bc = bearing(home, c.pos);
      const friends = spots.filter((s) => s !== c && Math.abs(((bearing(home, s.pos) - bc + 540) % 360) - 180) < 70 && s.d < r0 * 1.5).slice(0, 2);
      const set = [c, ...friends];
      tries.push({ pts: byBearing(home, [...set.map((s) => s.pos), ...(stop ? [stop] : [])]), spots: set });
    }
  }
  let best = null;
  for (const t of tries.slice(0, 4)) {
    const pts = [home, ...t.pts, home];
    const stopIndex = stop ? pts.findIndex((p) => p === stop) : null;
    let route;
    try { route = shapeRoute(await osrm(pts, true), pts, stopIndex >= 0 ? stopIndex : null); } catch { continue; }
    const lines = t.stream ? t.stream.ways.map((w) => w.coords) : [];
    const good = t.stream ? Math.min(1, (ankyoMeters(route, lines) / route.total) * (kind === "shotengai" ? 3 : 1)) : t.spots.length / 3;
    const score = Math.abs(route.total - target) / target * 0.7 + overlapRatio(route, [home]) + (1 - good);
    if (!best || score < best.score) best = { route, score, t, lines };
  }
  if (!best) throw new Error("ルートを作れませんでした。少し待ってからもう一度お試しください");
  const r = best.route;
  r.meguri = best.t.stream
    ? { kind, name: best.t.stream.name, lines: best.lines.map((c) => c.filter((_, i) => i % 2 === 0 || i === c.length - 1)), meters: ankyoMeters(r, best.lines), spots: [] }
    : { kind, spots: best.t.spots.map(({ id, name, label, pos }) => ({ id, name, label, pos })), lines: [] };
  return r;
}

// めぐりの説明（設定画面）
function renderMeguriInfo() {
  const box = $("#meguriInfo"), info = MEGURI_INFO[plan.meguri];
  box.hidden = !info;
  if (!info) return;
  box.innerHTML = "";
  box.appendChild(mkEl("meguritle", info.title));
  info.about.forEach((t) => box.appendChild(mkEl("small", t)));
  box.appendChild(mkEl("small muted", info.hint));
}
// 地図に、暗渠の線と、めぐる場所の印を描く
function drawMeguri(m, route, bucket) {
  const mg = route && route.meguri;
  // 暗渠の線は、ルートの下に太い水色で敷く（何本あってもつながないように、別々の線のまま）
  if (m.isReady) {
    const data = { type: "FeatureCollection", features: (mg ? mg.lines : []).map((c) => lineData(c)) };
    if (m.getSource("ankyo")) m.getSource("ankyo").setData(data);
    else if (data.features.length) {
      m.addSource("ankyo", { type: "geojson", data });
      m.addLayer({ id: "ankyo-line", type: "line", source: "ankyo", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#5ab4e5", "line-width": 12, "line-opacity": 0.55 } }, m.getLayer("route-casing") ? "route-casing" : undefined);
    }
    if (m.getLayer("ankyo-line") && mg) m.setPaintProperty("ankyo-line", "line-color", MEGURI[mg.kind].color || "#5ab4e5");
  }
  (mg ? mg.spots : []).forEach((s) => {
    const done = walk && (walk.meguriVisited || []).includes(s.id);
    bucket.push(htmlMarker(m, s.pos, mkEl("pin meguri" + (done ? " done" : ""), `${MEGURI[mg.kind].mark} ${s.name}`), { anchor: "bottom", offset: [0, -4] }));
  });
}

// ---------- まち図鑑 ----------
// 歩いて出会った名所を、写真といっしょに集める
const zukanAll = () => store.get("zukan", []);
function zukanCat(spot) {
  if (spot.kind === "fudo" || /不動/.test(spot.name)) return "fudo";
  if (spot.kind === "tree" || /名木|巨樹|保存樹|天然記念物の木/.test(spot.label || "")) return "tree";
  if (["ankyo", "shotengai", "kissa", "park"].includes(spot.kind)) return spot.kind;
  if (/祠|地蔵|庚申|道祖神/.test((spot.label || "") + spot.name)) return "shrine";
  return spot.group === "art" ? "art" : spot.group === "nature" ? "nature" : "history";
}
function addZukan(spot, photoId) {
  if (walk && walk.sim) return toast("家で試しているので、図鑑には入りません");
  const list = zukanAll(), i = list.findIndex((z) => z.id === spot.id);
  const entry = { id: spot.id, name: spot.name, label: spot.label || "", cat: zukanCat(spot), pos: spot.pos, at: Date.now(), photoId: photoId ?? (i >= 0 ? list[i].photoId : null) };
  if (i >= 0) list[i] = { ...list[i], ...entry, at: list[i].at }; else list.push(entry);
  store.set("zukan", list);
  if (i < 0) { buzz([80, 40, 80]); toast(`まち図鑑に「${spot.name}」が入りました（${list.length}件め）`); }
}
let zukanFor = null;
async function renderZukan() {
  const box = $("#zukanBox");
  if (!box) return;
  const list = zukanAll();
  box.innerHTML = "";
  box.appendChild(mkEl("small muted", list.length
    ? `${list.length}か所あつめました。歩いていて名所の近くを通ると知らせが届くので、撮って図鑑に入れます`
    : "歩いていて名所（名木・史跡・お地蔵さん・お不動さんなど）の近くを通ると、知らせが届きます。撮って図鑑に入れて、自分たちだけの「百名所」を集めましょう"));
  // 分類ごとの数
  const counts = mkEl("zukancounts");
  Object.entries(ZUKAN_CATS).forEach(([k, label]) => { const n = list.filter((z) => z.cat === k).length; if (n) counts.appendChild(mkEl("chip", `${label} ${n}`)); });
  box.appendChild(counts);
  // 江戸五色不動
  if (list.some((z) => z.cat === "fudo") || plan.meguri === "fudo") {
    const g = mkEl("goshiki");
    g.appendChild(mkEl("small", "江戸五色不動"));
    GOSHIKI.forEach((c) => { const got = list.some((z) => z.cat === "fudo" && c.re.test(z.name)); g.appendChild(mkEl("chip" + (got ? " on" : ""), (got ? "✓ " : "") + c.color)); });
    box.appendChild(g);
  }
  const grid = mkEl("zukangrid");
  for (const z of list.slice().reverse()) {
    const b = document.createElement("button");
    b.className = "zukanitem";
    b.append(mkEl("zukanpic"), mkEl("zukanname", z.name), mkEl("zukancat", ZUKAN_CATS[z.cat] || ""));
    if (z.photoId != null) {
      idb("photos", "readonly", (s) => s.get(z.photoId)).then((p) => { if (p) { b.querySelector(".zukanpic").style.backgroundImage = `url(${blobUrl(photoBlob(p))})`; b.onclick = () => openViewer(p); } }).catch(() => {});
    } else b.querySelector(".zukanpic").textContent = (MEGURI[z.cat] || {}).mark || ZUKAN_CATS[z.cat]?.[0] || "?";
    grid.appendChild(b);
  }
  box.appendChild(grid);
}

// ---------- 散歩中のめぐり ----------
// 暗渠に入ったら説明を、歩くあいだは暗渠のサインを探すお題を出す。めぐる場所や名所に近づいたら図鑑のカードを出す
function meguriTick(p) {
  const r = walk.route, mg = r.meguri, now = Date.now();
  walk.meguriVisited = walk.meguriVisited || [];
  if (mg && mg.lines.length) {
    const on = mg.lines.some((c) => c.some((q) => dist(p, q) < 25)), info = MEGURI_INFO[mg.kind];
    if (on && !walk.ankyoIn) {
      walk.ankyoIn = true; walk.ankyoNext = walk.progress + 120; walk.ankyoIdx = 0;
      walk.inbox.unshift({ kind: "meguri", id: "line-in", label: MEGURI[mg.kind].label, text: `${info.enter}${mg.name ? `（${mg.name}）` : ""}。${info.about[0]}`, tip: info.hint, arrivedAt: now });
      buzz([100, 60, 100]); renderCard();
    } else if (on && walk.progress >= walk.ankyoNext && walk.ankyoIdx < info.missions.length) {
      const m = info.missions.filter(forSolo(walk.solo))[walk.ankyoIdx++];
      walk.ankyoNext = walk.progress + 200;
      if (m) walk.inbox.push({ ...m, id: "ln" + walk.ankyoIdx, label: info.missionLabel, arrivedAt: now });
      buzz([80, 60, 80]); renderCard();
    }
  }
  // めぐる場所（不動明王・名木）
  (mg ? mg.spots : []).forEach((s) => {
    if (walk.meguriVisited.includes(s.id) || dist(p, s.pos) > 45) return;
    walk.meguriVisited.push(s.id);
    const info = MEGURI_INFO[mg.kind];
    walk.inbox.unshift({ kind: "spot", id: "sp-" + s.id, spot: { ...s, kind: mg.kind }, text: `${info.arrive}：「${s.name}」。撮って、まち図鑑に入れよう`, tip: info.hint, arrivedAt: now });
    info.missions.filter(forSolo(walk.solo)).forEach((m, i) => walk.inbox.push({ ...m, id: `sm-${s.id}-${i}`, label: MEGURI[mg.kind].label, arrivedAt: now }));
    buzz([200, 100, 200]); renderCard(); drawWalkRoute();
  });
  // 名所（史跡・アート・自然）の近くを通ったら、図鑑に入れるか聞く（3分に1回まで）
  if (now - (walk.spotAt || 0) < 3 * 60000 / (walk.sim ? SIM_SPEED : 1)) return;
  const have = new Set(zukanAll().map((z) => z.id));
  const poi = (r.pois || []).find((q) => ["history", "art", "nature"].includes(q.group) && !walk.noticed.includes(q.id) && !have.has(q.id) && dist(p, q.pos) < 40);
  if (!poi) return;
  walk.noticed.push(poi.id); walk.spotAt = now;
  walk.inbox.push({ kind: "spot", id: "sp-" + poi.id, spot: poi, text: `すぐそばに「${poi.name}」（${poi.label}）があります。撮って、まち図鑑に入れよう`, arrivedAt: now });
  buzz([80, 60, 80]); renderCard();
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

// 目的地モードの別行動：途中で二手に分かれて、目的地で合流する。
// 経由地の並び：[家, 分かれ道, 寄せる点, 目的地, (帰りの経由地か寄り道先, 家)]。別行動の道は一周ルートと同じ作り方
async function makeDestSplitRoute() {
  const home = plan.home, D = plan.dest.pos, L = plan.split * 60 * WALK_SPEED;
  const dD = dist(home, D), bD = bearing(home, D);
  if (dD > 15000) throw new Error("目的地がスタート地点から遠すぎます（15kmまで）");
  const stop = plan.chosen && plan.stop !== "none" && plan.back === "round" ? plan.chosen.pos : null;
  const first = rng(plan.seed ^ 0x51)() < 0.5 ? 1 : -1;
  const info = { ...plan.dest, back: plan.back };
  let best = null, sDist = Math.min(L / 1.7, dD * 0.8);
  for (const side of [first, -first]) {
    const S = dest(D, bearing(D, home) + side * 30, sDist);
    const mid = midOf(S, D), bSM = bearing(S, D);
    const tail = plan.back === "oneway" ? [] : stop ? [stop, home] : [dest(midOf(home, D), bD - side * 90, Math.max(200, dD * 0.35)), home];
    const stopIndex = stop ? 4 : null;
    const make = async (off, sgn) => { const pts = [home, S, dest(mid, bSM + sgn * 90, off), D, ...tail]; return { route: shapeRoute(await osrm(pts, true), pts, stopIndex), pts }; };
    let offA = L * 0.17, offB = L * 0.17, A, B;
    try { [A, B] = await Promise.all([make(offA, 1), make(offB, -1)]); } catch { continue; }
    const blen = (x) => x.route.legEnds[2] - x.route.legEnds[0];
    for (let k = 0; k < 3; k++) {
      const a = blen(A), b = blen(B);
      if (Math.abs(a - b) <= Math.max(100, 0.08 * Math.max(a, b))) break;
      try {
        const q = Math.min(a, b) / Math.max(a, b);
        if (a > b) { offA *= Math.max(0.15, q); offB *= 1 / Math.sqrt(q); } else { offB *= Math.max(0.15, q); offA *= 1 / Math.sqrt(q); }
        [A, B] = await Promise.all([make(offA, 1), make(offB, -1)]);
      } catch { break; }
    }
    const route = composeSplit(A.route, B.route, { meetName: plan.dest.name, meetPos: D, minutes: plan.split, wA: A.pts, wB: B.pts, stopIndex });
    attachDest(route, 3, info); attachDest(route.split.B, 3, info);
    const sp = route.split, imbalance = Math.abs(sp.lenA - sp.lenB) / Math.max(sp.lenA, sp.lenB);
    const score = imbalance * 3 + branchOverlap(sp) * 2 + Math.abs((sp.lenA + sp.lenB) / 2 - L) / L * 0.7;
    if (!best || score < best.score) best = { route, score };
    if (score < 0.25) break;
  }
  if (!best) throw new Error("別行動のルートを作れませんでした。別行動の時間を変えてみてください");
  return best.route;
}

async function buildRoute() {
  if (!plan.home) return showPlanError("先にスタート地点を決めてください");
  showPlanError("");
  $("#btnMake").disabled = true; $("#btnMake").textContent = "ルートを作っています…";
  try {
    if (!isDest() && MEGURI[plan.meguri]) {
      plan.route = await makeMeguriRoute();
    } else if (isDest()) {
      if (!plan.dest) throw new Error("目的地を選んでください（名前で探すか、地図をタップ）");
      plan.route = plan.split > 0 && !isSolo() && !MEGURI[plan.meguri] ? await makeDestSplitRoute() : await makeDestRoute();
    } else if (plan.split > 0 && !isSolo() && meetPoint()) {
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
      // はじめての道を多めにするときは、向きを8通り試す
      shapes = (plan.fresh ? [0, 90, 180, 270, 45, 135, 225, 315] : [0, 90, 180, 270, 45]).map((turn) => ({
        stopIndex: null,
        // 三角形より丸に近い周回になるよう、経由地を3つ置く
        wps: (f) => [home, dest(home, θ + turn - 25, rad0 * 0.95 * f), dest(home, θ + turn + 35, rad0 * 1.05 * f), dest(home, θ + turn + 95, rad0 * 0.85 * f), home],
      }));
    }
    // 経由地でUターンさせずにルートを作り、「同じ道の往復の少なさ」と「目標の距離への近さ」で点数をつける。
    // 1本目の結果から距離の倍率を学んで、2本目以降に使う
    const ignore = [home, ...(stopAt ? [stopAt] : [])];
    const cells = plan.fresh ? await myWalkedCells() : null;
    let f = 1, best = null;
    for (let i = 0; i < shapes.length; i++) {
      const sh = shapes[i], pts = sh.wps(f);
      let route;
      try { route = shapeRoute(await osrm(pts, true), pts, sh.stopIndex); } catch (e) { if (i === 0 && !best) throw e; continue; }
      const over = overlapRatio(route, ignore), off = Math.abs(route.total - target) / target;
      const fresh = cells ? freshRatio(route, cells, home) : 1;
      const score = over * 2 + off + (1 - fresh) * 1.5;
      if (!best || score < best.score) best = { route, score, over, off };
      if (i === 0) f = Math.max(0.2, Math.min(2.5, f * (stopAt ? 1 + (target / route.total - 1) * 1.6 : target / route.total)));
      if (over < 0.03 && off < 0.12 && fresh > 0.8) break;
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
  const mg = r.meguri;
  if (mg) $("#sumLoop").textContent += mg.lines.length
    ? `。${MEGURI[mg.kind].label}${mg.name ? `「${mg.name}」` : ""}に沿って、約${fmtKm(mg.meters)}km歩きます（地図の太い${mg.kind === "ankyo" ? "水色" : "オレンジ"}の線）${mg.spots.length ? `。ほかに、お店の多い通りを${mg.spots.length}か所通ります` : ""}`
    : `。${MEGURI[mg.kind].label}${/はしご$/.test(MEGURI[mg.kind].label) ? "" : "めぐり"}：${mg.spots.map((x) => `「${x.name}」`).join("")}を通ります${mg.spots.some((x) => x.label === "御神木のありそうな神社") ? "（近くの地図に名木が少なかったので、御神木がありそうな神社を選びました）" : ""}`;
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
    badgeHint(r);
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
  badgeHint(r);
  freshHint(r);
}
// このルートのうち、はじめて歩く道がどれくらいあるか
async function freshHint(r) {
  const cells = await myWalkedCells();
  if (plan.route !== r) return;
  $("#sumFresh").hidden = !cells.size;
  if (!cells.size) return;
  const p = Math.round(freshRatio(r, cells, plan.home) * 10);
  $("#sumFresh").textContent = p >= 10 ? "ぜんぶ、はじめて歩く道です" : p <= 0 ? "ほとんど、歩いたことのある道です" : `道の約${p}割が、はじめて歩く道です`;
}
// このルートを歩けば取れそうな実績と、あと少しで取れる実績を出す。
// 出発の時刻や歩いた距離しだいで変わるひみつ（ぞろ目）は数えない
async function badgeHint(r) {
  try {
    const own = ownWalks(await allWalks()), s0 = badgeStats(own), had = new Set(earnedBadges(s0));
    const fake = {
      startedAt: Date.now(), distance: r.total, minutes: Math.round(r.total / WALK_SPEED / 60), results: [], photos: 0,
      stopName: plan.chosen && plan.stop !== "none" ? plan.chosen.name : null, stopType: plan.chosen && plan.stop !== "none" ? plan.chosen.type || plan.stop : null,
      dest: r.dest ? { name: r.dest.name, back: r.dest.back } : null, split: r.split ? {} : null, detours: (r.detours || []).length,
      theme: themeKey(plan.seed), weather: plan.weather, night: isNightWalk(Date.now(), r.total / WALK_SPEED / 60, plan.home),
    };
    const s1 = badgeStats([...own, fake]);
    const gain = BADGES.filter((b) => !had.has(b.id) && !["zorome", "clock"].includes(b.id) && b.get(s1) >= b.need);
    const open = gain.filter((b) => !b.secret).slice(0, 3).map((b) => `「${b.name}」`);
    const secret = gain.some((b) => b.secret);
    // あと少し：観察・会話・写真・メモで、残り3回以下のもの
    const near = BADGES.filter((b) => !had.has(b.id) && ["look", "photo"].includes(b.cat) && !b.secret)
      .map((b) => ({ b, left: Math.ceil(b.need - b.get(s0)) })).filter((x) => x.left > 0 && x.left <= 3).sort((a, b) => a.left - b.left)[0];
    const parts = [];
    if (open.length) parts.push(`この散歩で${open.join("")}が取れそうです`);
    if (secret) parts.push("ひみつの実績も取れるかも");
    if (near) parts.push(`あと${near.left}回で「${near.b.name}」（${near.b.desc}）`);
    if (plan.route !== r) return;
    $("#sumBadge").textContent = parts.join("。");
    $("#sumBadge").hidden = !parts.length;
  } catch { $("#sumBadge").hidden = true; }
}
function showPlanError(msg) { $("#planError").textContent = msg; $("#planError").hidden = !msg; }

// 合流場所の候補を探す（「寄り道先」を選んだときは寄り道先をそのまま使う）
async function prepareMeet() {
  plan.meetCands = []; plan.meetChosen = null;
  renderMeetCands();
  if (!plan.split || isSolo() || isDest()) return true;
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
function sharePayload() {
  const payload = {
    h: plan.home.map((v) => +v.toFixed(5)), m: plan.minutes, i: plan.interval, s: plan.seed, st: plan.stop, th: plan.theme,
    w: plan.route && (plan.route.detours || plan.route.dest || plan.route.meguri) ? plan.route.waypoints.map((q) => q.map((v) => +v.toFixed(5))) : undefined,
    si: plan.route && (plan.route.detours || plan.route.dest || plan.route.meguri) ? plan.route.stopIndex : undefined, dt: plan.route && plan.route.detours,
    // めぐり：暗渠の線（間引いたもの）と、めぐる場所。受け取った人にも同じ案内が届くように
    mg: plan.route && plan.route.meguri ? (({ kind, name, lines, spots, meters }) => ({ k: kind, n: name, m: meters,
      l: lines.map((c) => c.filter((_, i) => i % 2 === 0 || i === c.length - 1).map((q) => q.map((v) => +v.toFixed(5)))),
      s: spots.map((x) => ({ i: x.id, n: x.name, b: x.label, p: x.pos.map((v) => +v.toFixed(5)) })) }))(plan.route.meguri) : undefined,
    ds: plan.route && plan.route.dest ? (({ name, pos, back, idx }) => ({ n: name, p: pos.map((v) => +v.toFixed(5)), b: back, i: idx }))(plan.route.dest) : undefined,
    sp: plan.route && plan.route.split ? (({ wA, wB, stopIndex, meetName, meetPos, minutes }) => ({ wA: wA.map((q) => q.map((v) => +v.toFixed(5))), wB: wB.map((q) => q.map((v) => +v.toFixed(5))), si: stopIndex, n: meetName, p: meetPos, min: minutes }))(plan.route.split) : undefined,
    c: plan.chosen && plan.stop !== "none" ? { n: plan.chosen.name, p: plan.chosen.pos.map((v) => +v.toFixed(5)), id: plan.chosen.id, t: plan.chosen.type } : null,
  };
  return JSON.stringify(payload);
}
// #以降はサーバーに送られないので、自宅の位置がホスティング先に残らない。
// openExternalBrowser=1 は、LINEで開いたときにSafariで開かせる合図（LINEの中だと、アプリを切り替えたときに散歩が止まる）
const shareLink = () => location.origin + location.pathname + "?openExternalBrowser=1#r=" + encodeURIComponent(sharePayload());
// 届いたルートを開く（リンクを貼り付けたときや、夫婦用ページでサーバーから届いたとき）
function openSharedPayload(json) {
  history.replaceState(null, "", location.pathname + "#r=" + encodeURIComponent(json));
  showView("plan");
  return loadShared().then((ok) => { if (!ok) toast("ルートを開けませんでした。リンクをもう一度確かめてください", true); return ok; });
}
function onPasteLink() {
  const text = prompt("パートナーから届いたリンクを貼り付けてください", "");
  if (!text) return;
  const m = text.match(/#r=([^\s]+)/);
  if (!m) return toast("ふたり散歩のリンクではないようです", true);
  try { openSharedPayload(decodeURIComponent(m[1])); } catch { toast("リンクが途中で切れているようです", true); }
}
async function onShare() {
  // 夫婦用ページでログインしているときは、相手のアプリにサーバーから直接届ける（LINEを通さない）
  if (window.Cloud && Cloud.ready() && Cloud.sendPlan) {
    try { await Cloud.sendPlan(sharePayload()); toast(`${Cloud.partnerName() || "パートナー"}のアプリに送りました。通知が届きます`); return; }
    catch (e) { toast(e.message + "。かわりにリンクで送ってください", true); }
  }
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
    const meguriOf = (route) => {
      if (p.mg) route.meguri = { kind: p.mg.k, name: p.mg.n, meters: p.mg.m || 0, lines: p.mg.l || [], spots: (p.mg.s || []).map((x) => ({ id: x.i, name: x.n, label: x.b, pos: x.p })) };
      return route;
    };
    Object.assign(plan, { home: p.h, minutes: p.m, interval: p.i, seed: p.s, stop: p.st, theme: p.th || "any", shared: true, shape: p.ds ? "dest" : "loop", party: "duo" });
    plan.chosen = p.c ? { id: p.c.id, name: p.c.n, pos: p.c.p, type: p.c.t || p.st, d: dist(p.h, p.c.p) } : null;
    plan.candidates = plan.chosen ? [plan.chosen] : [];
    $("#sharedBanner").hidden = false;
    $("#planForm").hidden = true; $("#btnMake").hidden = true; $("#btnPaste").hidden = true; $("#planInbox").hidden = true;
    planMap.jumpTo({ center: ll(plan.home), zoom: 15 });
    if (p.sp) {
      // 別行動のルートは、2本の経由地をそのまま使って同じ道にする。リンクを開いた人には黒の道をすすめる
      const A = shapeRoute(await osrm(p.sp.wA, true), p.sp.wA, p.sp.si ?? null), B = shapeRoute(await osrm(p.sp.wB, true), p.sp.wB, p.sp.si ?? null);
      plan.route = composeSplit(A, B, { meetName: p.sp.n, meetPos: p.sp.p, minutes: p.sp.min, wA: p.sp.wA, wB: p.sp.wB, stopIndex: p.sp.si ?? null });
      plan.split = p.sp.min; plan.role = "B";
      if (p.ds) { plan.dest = { name: p.ds.n, pos: p.ds.p }; plan.back = p.ds.b; const di = { ...plan.dest, back: p.ds.b }; attachDest(plan.route, p.ds.i, di); attachDest(plan.route.split.B, p.ds.i, di); }
      showSummary(); await drawPlan(); loadPois(plan.route);
    } else if (p.ds) {
      // 目的地へのルートも、経由地をそのまま使って同じ道にする
      plan.dest = { name: p.ds.n, pos: p.ds.p }; plan.back = p.ds.b;
      plan.route = meguriOf(attachDest(shapeRoute(await osrm(p.w, true), p.w, p.si ?? null), p.ds.i, { ...plan.dest, back: p.ds.b }));
      if (p.dt) plan.route.detours = p.dt;
      showSummary(); await drawPlan(); loadPois(plan.route);
    } else if (p.w) {
      // 寄り道を足したルートは、経由地をそのまま使って同じ道にする
      plan.route = meguriOf(shapeRoute(await osrm(p.w, !!p.mg), p.w, p.si ?? null));
      if (p.dt) plan.route.detours = p.dt;
      showSummary(); await drawPlan(); loadPois(plan.route);
    } else await buildRoute();
    return true;
  } catch { return false; }
}

// ---------- お題の予定 ----------
// お題は「歩いた距離」で届く。同じseedなら二人のスマホで同じ場所・同じお題になる
const fits = (night) => (m) => !m.when || m.when === (night ? "night" : "day");
// ひとりで歩くときは、ふたりでするお題を出さない
const DUO = /ふたり|二人|相手|それぞれ|見せ合/;
const forSolo = (solo) => (m) => !solo || (!m.duo && !DUO.test(m.text));
function missionPlan(seed, total, interval, stopAlong, night, theme, weather, oneway, solo) {
  const avoid = [].concat(stopAlong).filter((v) => v != null);
  const r = rng(seed ^ 0x5a5a);
  let look = shuffle(MISSIONS.look.filter(fits(night)).filter(forSolo(solo)), r).map((m) => ({ kind: "look", ...m }));
  // テーマがある日は、テーマに合うお題を3回に2回の割合で出す
  if (theme && THEMES[theme]) {
    const extra = (THEMES[theme].extra || []).filter(fits(night)).map((m) => ({ kind: "look", ...m }));
    const on = shuffle([...extra, ...look.filter((m) => THEMES[theme].test.test(m.text))], r), off = look.filter((m) => !THEMES[theme].test.test(m.text));
    if (on.length >= 4) { look = []; while (on.length || off.length) { if (on.length) look.push(on.shift()); if (on.length) look.push(on.shift()); if (off.length) look.push(off.shift()); } }
  }
  const photo = shuffle(MISSIONS.photo.filter(fits(night)).filter(forSolo(solo)), r).map((m) => ({ kind: "photo", ...m }));
  // 季節のお題は、最初のほうに混ぜる
  // （テーマがある日は、テーマのお題を先に出してから）
  MISSIONS.season[seasonKey(new Date().getMonth() + 1)].filter(fits(night))
    .forEach((m) => look.splice((theme ? 5 : 1) + Math.floor(r() * 3), 0, { kind: "look", ...m }));
  // 天気のお題は、はじめのほうに混ぜる
  if (weather && weather.kind) shuffle(MISSIONS.weather[weather.kind].filter(fits(night)), r).slice(0, 3)
    .forEach((m, i) => look.splice(i * 2, 0, { kind: "look", ...m }));
  // 観察・写真・観察・観察・写真 の繰り返し（写真を撮るきっかけを多めに）
  const order = ["look", "photo", "look", "look", "photo"];
  const used = { look: 0, photo: 0 };
  const step = interval * 60 * WALK_SPEED;
  const events = [];
  for (let at = 200, n = 0; at < total * 0.85; at += step, n++) {
    // 寄り道先の手前・直後とは重ならないようにする
    if (avoid.some((s) => Math.abs(at - s) < 150)) continue;
    const kind = order[n % order.length], pool = kind === "look" ? look : photo;
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
    stopType: plan.chosen && plan.stop !== "none" ? plan.chosen.type || plan.stop : null,
    progress: 0, track: [plan.home], pos: plan.home, lastFixAt: Date.now(),
    events: missionPlan(plan.seed, route.total, plan.interval, [route.stopAlong, route.dest && route.dest.back === "round" ? route.dest.along : null], night, themeKey(plan.seed), plan.weather, route.dest && route.dest.back === "oneway", isSolo()), eventIdx: 0, solo: isSolo(),
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
  drawMeguri(walkMap, walk.route, walkMarkers);
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

  // めぐる場所・名所（まち図鑑）
  meguriTick(p);
  // 気になるお店の近くを通ったら知らせる
  (walk.route.pois || []).forEach((poi) => {
    if (poi.group === "shop" && !walk.noticed.includes(poi.id) && dist(p, poi.pos) < 45) {
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

  kotobaTick(p);
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
    sp.B.pois = walk.route.pois; sp.B.letterSpots = walk.route.letterSpots;
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
  const pool = (MISSIONS[walk.stopMission] || MISSIONS.stop).filter(forSolo(walk.solo));
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
  MISSIONS.dest.filter(forSolo(walk.solo)).forEach((x, i) => walk.inbox.push({ ...x, id: "d" + i, arrivedAt: Date.now() }));
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
  if (INFO_KINDS.includes(m.kind) || m.kind === "spot") return resolve("done");
  $("#missionActions").hidden = true; $("#memoBox").hidden = false;
  $("#memoInput").value = "";
  $("#memoInput").placeholder = m.kind === "talk" ? "どんな話になった？（なくてもOK）" : m.kind === "photo" ? "どんな1枚になった？（なくてもOK）" : "何を見つけた？（なくてもOK）。キーボードのマイクで声でも入力できます";
}
function resolve(outcome, memo) {
  const m = walk.inbox.shift();
  if (!m) return;
  if (m.kind === "spot" && outcome === "done") addZukan(m.spot, null);
  if (INFO_KINDS.includes(m.kind)) { renderCard(); saveActive(); return; }
  walk.results.push({ id: m.id, kind: m.kind, cat: m.cat || null, text: m.text, outcome, memo: memo || null });
  if (outcome === "done") toast(m.kind === "talk" ? "いい時間でしたね" : m.kind === "photo" ? "いい1枚！" : "ナイス観察！");
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
    nr.pois = r.pois; nr.letterSpots = r.letterSpots;
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
    stopType: w.stopType || null, detours: (w.route.detours || []).length, solo: !!w.solo,
    meguri: w.route.meguri ? { kind: w.route.meguri.kind, name: w.route.meguri.name || null, visited: (w.meguriVisited || []).length, ankyo: !!w.ankyoIn } : null,
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
  if (!w.sim && w.ankyoIn && w.route.meguri) { const mk = w.route.meguri.kind; addZukan({ id: mk + ":" + (w.route.meguri.name || w.id), name: w.route.meguri.name || `名前のない${MEGURI[mk].label}`, label: MEGURI[mk].label, kind: mk, pos: w.route.meguri.lines[0][0] }, null); }
  store.del("active");
  if (!w.sim && record.distance > 300) { const ym = bingoKey(monthKey(new Date(w.startedAt))); if (!bingoState(ym).found[BINGO_FREE]) bingoMark(ym, BINGO_FREE, true); }
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
    const photoId = await addPhoto({ walkId: walk.id, data, type: blob.type || "image/jpeg", mission, pos: walk.pos, at: Date.now() });
    if (bingoPhotoFor) { const b = bingoPhotoFor; bingoPhotoFor = null; bingoPick = null; bingoMark(b.ym, b.idx, true, photoId); }
    if (kotobaFor != null) { const i = kotobaFor; kotobaFor = null; openCrop(photoId, blob, i); }
    if (zukanFor) {
      const sp = zukanFor; zukanFor = null;
      addZukan(sp, photoId);
      // 図鑑のカードは、撮ったら片づける
      const m = walk.inbox[0];
      if (m && m.kind === "spot" && m.spot.id === sp.id) resolve("done");
    }
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
  // 分類ごとに見出しをつけて並べる。ひみつのバッジは、取るまで「？」
  const box = $("#badgeGrid");
  box.innerHTML = "";
  const num = (v) => (Number.isInteger(v) ? v : Math.floor(v * 10) / 10);
  Object.entries(BADGE_CATS).forEach(([cat, label]) => {
    const list = BADGES.filter((b) => b.cat === cat);
    const head = document.createElement("div");
    head.className = "badgecat";
    head.textContent = `${label}  ${list.filter((b) => have.has(b.id)).length}/${list.length}`;
    const grid = document.createElement("div");
    grid.className = "badgegrid";
    list.forEach((b) => {
      const on = have.has(b.id), hide = b.secret && !on;
      const el = stamp(hide ? { mark: "？", name: "ひみつ" } : b, on);
      el.querySelector(".bdesc").textContent = hide ? "条件は取ってのお楽しみ" : on ? b.desc : `${b.desc}（${num(Math.min(b.get(s), b.need))}/${num(b.need)}）`;
      grid.appendChild(el);
    });
    box.append(head, grid);
  });
  // これまでに歩いた距離と、そのたとえ
  $("#totalCard").hidden = !s.walks;
  $("#totalKm").textContent = `${fmtKm(s.km * 1000)}km`;
  $("#totalSub").textContent = `${s.walks}回・${Math.floor(s.totalMin / 60)}時間${s.totalMin % 60}分`;
  $("#totalFacts").innerHTML = "";
  distanceFacts(s.km).forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f.text;
    if (f.progress != null) { const bar = mkEl("bar"); bar.appendChild(document.createElement("span")).style.width = `${Math.max(1, Math.min(100, f.progress * 100))}%`; li.appendChild(bar); }
    $("#totalFacts").appendChild(li);
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

// ---------- 月替わりのビンゴ ----------
// マスは月ごとに決まる（二人のスマホで同じカード）。見つけたマスは、このスマホに保存する。
// ビンゴしたら、月のはじめに二人で決めた「ごほうび」が解禁になる
const BINGO_FREE = 4, BINGO_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
// テーマに沿って探すハント。色・形・数字など、決まった8つを探す（並びは月ごとに変わる）
// 色・かたち・数字は、その月は1つにしぼって、ちがうものを9つ集める（そろった写真がきれいに見える）。
// 昭和と生きものは、いろいろなものを探す
const HUNT_CATS = ["乗りもの", "花や実", "看板", "食べもの", "ドアや窓", "服やもちもの", "道ばたのもの", "自由な1枚"];
const HUNTS = {
  normal: { label: "いつものビンゴ" },
  color: { label: "カラーハント", word: "色", values: [
    { name: "赤", adj: "赤い", hex: "#d8322b" }, { name: "青", adj: "青い", hex: "#1f4fd8" }, { name: "黄色", adj: "黄色い", hex: "#f1c40f" },
    { name: "緑", adj: "緑の", hex: "#3a9d4a" }, { name: "白", adj: "白い", hex: "#cfcfcf" }, { name: "ピンク", adj: "ピンクの", hex: "#ef8db0" },
    { name: "オレンジ", adj: "オレンジの", hex: "#ef8a1f" }, { name: "茶色", adj: "茶色い", hex: "#8b5a2b" }, { name: "紫", adj: "紫の", hex: "#8a4fbf" },
  ], cats: HUNT_CATS },
  shape: { label: "かたちハント", word: "かたち", values: [
    { name: "まる", adj: "まるい" }, { name: "三角", adj: "三角の" }, { name: "四角", adj: "四角い" }, { name: "星", adj: "星の形の" }, { name: "ハート", adj: "ハートの形の" }, { name: "うずまき", adj: "うずまきの" },
  ], cats: ["窓", "看板やマーク", "足もとのもの", "食べもの", "建物の飾り", "植物", "道具やもちもの", "自由な1枚"] },
  number: { label: "数字ハント", word: "数字", values: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ name: String(n), adj: `「${n}」のある` })),
    cats: ["看板", "車のナンバー", "住所の表示", "値段", "時計や時刻", "電柱やポール", "バス停や駅", "自由な1枚"] },
  retro: { label: "昭和ハント", cells: ["ホーロー看板", "黒電話のマーク", "赤い丸ポスト", "タイル張りの壁", "手書きの値札", "木の電柱", "型板ガラス", "レトロな書体の看板"] },
  life: { label: "生きものハント", cells: ["ねこ", "犬", "スズメ", "ハト", "チョウ", "アリ", "カタツムリかダンゴムシ", "池や川の魚"] },
};
// key は「2026-10」（いつものビンゴ）、「2026-10:retro」、色などは「2026-10:color:0」のように選んだ番号つき
const huntOf = (key) => key.split(":")[1] || "normal";
const isColorKey = (key) => huntOf(key) !== "normal";
const huntValue = (key) => { const h = HUNTS[huntOf(key)]; return h && h.values ? h.values[+(key.split(":")[2] || 0)] : null; };
function bingoCells(key) {
  const seed = rng(+key.slice(0, 7).replace("-", "") * 7919), h = HUNTS[huntOf(key)] || HUNTS.normal, v = huntValue(key);
  const pick = v ? shuffle(h.cats, seed).map((c) => `${v.adj}${c}`) : h.cells ? shuffle(h.cells, seed) : shuffle(BINGO_POOL, seed).slice(0, 8);
  pick.splice(BINGO_FREE, 0, "散歩に出かける");
  return pick;
}
// カラーハントのマスの色（カードのどのマスも同じ色）
let bingoHex = null;
const cellColor = (text) => (bingoHex && text !== "散歩に出かける" ? bingoHex : null);
// その月に選んだ色などの番号。決めていなければ、月ごとに決まった番号（二人で同じになる）
function bingoKey(ym = monthKey()) {
  const k = store.get("bingoKind:" + ym, "normal"), h = HUNTS[k];
  if (!h || k === "normal") return ym;
  if (!h.values) return `${ym}:${k}`;
  const def = Math.floor(rng(+ym.replace("-", "") * 131 + k.length)() * h.values.length);
  return `${ym}:${k}:${store.get(`bingoVal:${ym}:${k}`, def)}`;
}
// ごほうびは、カードの種類によらず月に1つ
const bingoState = (key) => ({ found: {}, ...store.get("bingo:" + key, {}), reward: store.get("bingo:" + key.slice(0, 7), {}).reward || "" });
const bingoSave = (key, st) => {
  store.set("bingo:" + key, { ...store.get("bingo:" + key, {}), found: st.found });
  const base = store.get("bingo:" + key.slice(0, 7), { found: {} });
  store.set("bingo:" + key.slice(0, 7), { ...base, reward: st.reward || "" });
};
const bingoLines = (st) => BINGO_LINES.filter((l) => l.every((i) => st.found[i])).length;
// 実績用：これまでのビンゴの数と、全部埋めた月の数
function bingoTotals() {
  let lines = 0, fulls = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("fs:bingo:")) continue;
      const st = JSON.parse(localStorage.getItem(k));
      lines += bingoLines(st);
      if (Object.keys(st.found).length >= 9) fulls++;
    }
  } catch {}
  return { lines, fulls };
}
// マスを埋める（取り消す）。新しくビンゴしたら知らせる
function bingoMark(ym, idx, on, photoId) {
  const st = bingoState(ym), before = bingoLines(st);
  if (on) st.found[idx] = { at: Date.now(), photoId: photoId ?? (st.found[idx] && st.found[idx].photoId) ?? null };
  else delete st.found[idx];
  bingoSave(ym, st);
  const after = bingoLines(st);
  if (after > before) {
    buzz([100, 60, 100, 60, 300]);
    const all = Object.keys(st.found).length >= 9;
    toast(all ? "全部埋まりました！今月のビンゴ完成" : `ビンゴ！${st.reward ? `ごほうび解禁：「${st.reward}」` : ""}`);
  }
  renderBingoAll();
}
// ビンゴのカードを描く。散歩中は、マスを押すと「見つけた」「撮って埋める」を選べる
let bingoPick = null, bingoPhotoFor = null;
async function renderBingo(box, ym) {
  const cells = bingoCells(ym), st = bingoState(ym), lines = bingoLines(st), hv = huntValue(ym);
  bingoHex = hv && hv.hex ? hv.hex : null;
  box.innerHTML = "";
  box.appendChild(mkEl("small muted bingohow", walk
    ? "見つけたら、そのマスを押して「撮って埋める」か「見つけた」。マスは自分で埋めます"
    : "散歩中に見つけたら、そのマスを押して埋めます（写真でも、押すだけでも）。まん中は散歩を終えると自動で埋まります"));
  // 色・かたち・数字は「今月は○○」と、別のものに変えるボタン
  if (hv) {
    const h = HUNTS[huntOf(ym)], head = mkEl("bingovalue");
    head.appendChild(mkEl("", `今月の${h.word}は「${hv.name}」`));
    const ch = document.createElement("button"); ch.className = "link"; ch.textContent = `ほかの${h.word}にする`;
    ch.onclick = () => {
      if (Object.keys(st.found).some((i) => +i !== BINGO_FREE) && !confirm(`ほかの${h.word}にしますか？（いまのカードは残ります）`)) return;
      const ymOnly = ym.slice(0, 7), cur = +(ym.split(":")[2] || 0);
      store.set(`bingoVal:${ymOnly}:${huntOf(ym)}`, (cur + 1) % h.values.length);
      bingoPick = null; renderBingoAll();
    };
    head.appendChild(ch);
    box.appendChild(head);
  }
  const grid = mkEl("bingogrid");
  const done = new Set(BINGO_LINES.filter((l) => l.every((i) => st.found[i])).flat());
  for (let i = 0; i < 9; i++) {
    const b = document.createElement("button");
    const f = st.found[i];
    b.className = "bingocell" + (f ? " on" : "") + (done.has(i) ? " line" : "") + (bingoPick === i ? " pick" : "");
    b.appendChild(mkEl("bingotext", cells[i]));
    if (i === BINGO_FREE && !f) b.appendChild(mkEl("bingoauto", "散歩を終えると自動で埋まります"));
    if (!f && i !== BINGO_FREE) b.classList.add("empty");
    const col = cellColor(cells[i]);
    if (col) b.style.setProperty("--hunt", col), b.classList.add("hunt");
    if (f && f.photoId != null) {
      idb("photos", "readonly", (s) => s.get(f.photoId)).then((p) => { if (p) { b.style.backgroundImage = `url(${blobUrl(photoBlob(p))})`; b.classList.add("photo"); } }).catch(() => {});
    }
    if (i !== BINGO_FREE) b.onclick = () => { bingoPick = bingoPick === i ? null : i; renderBingoAll(); };
    grid.appendChild(b);
  }
  box.appendChild(grid);
  // 選んだマスの操作
  if (bingoPick != null && ym.slice(0, 7) === monthKey()) {
    const bar = mkEl("bingoacts");
    const f = st.found[bingoPick];
    bar.appendChild(mkEl("bingopicked", `「${cells[bingoPick]}」`));
    const add = (label, cls, fn, forPhoto) => {
      const el = document.createElement(forPhoto ? "label" : "button");
      el.className = cls; el.textContent = label;
      if (forPhoto) { el.htmlFor = "photoInput"; el.addEventListener("click", fn); } else el.onclick = fn;
      bar.appendChild(el);
    };
    const idx = bingoPick;
    if (!f) add("見つけた", "secondary", () => { bingoPick = null; bingoMark(ym, idx, true); });
    if (walk) add(f ? "撮り直す" : "撮って埋める", "secondary", () => { photoFor = `ビンゴ：${cells[idx]}`; bingoPhotoFor = { ym, idx }; }, true);
    if (f) add("取り消す", "link", () => { bingoPick = null; bingoMark(ym, idx, false); });
    box.appendChild(bar);
  }
  const left = Math.min(...BINGO_LINES.map((l) => l.filter((i) => !st.found[i]).length));
  const status = mkEl("bingostatus small");
  status.textContent = Object.keys(st.found).length >= 9 ? "全部埋まりました。今月の写真集の完成です"
    : lines ? `ビンゴ！${st.reward ? `ごほうび解禁：「${st.reward}」` : ""}${lines > 1 ? `（${lines}列）` : ""}`
    : `あと${left}マスでビンゴ`;
  box.appendChild(status);
  // 写真が1枚でもあれば、9マスを1枚の画像にまとめられる
  if (Object.values(st.found).some((f) => f.photoId != null)) {
    const btn = document.createElement("button");
    btn.className = "secondary bingosave"; btn.textContent = "写真をまとめて1枚にする";
    btn.onclick = () => saveCollage(ym);
    box.appendChild(btn);
  }
}
// 3×3のコラージュ画像を作って、保存・共有する
async function saveCollage(key) {
  const cells = bingoCells(key), st = bingoState(key);
  const S = 360, top = 120, W = S * 3, H = top + S * 3 + 40;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#f7f7f5"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#111"; g.font = "600 44px 'IBM Plex Sans JP', sans-serif"; g.textBaseline = "middle";
  const [y, m] = key.slice(0, 7).split("-");
  const hv = huntValue(key);
  bingoHex = hv && hv.hex ? hv.hex : null;
  g.fillText(`${y}年${+m}月の${isColorKey(key) ? HUNTS[huntOf(key)].label : "散歩ビンゴ"}${hv ? `：${hv.name}` : ""}`, 36, 62);
  g.font = "400 22px 'IBM Plex Mono', monospace"; g.fillStyle = "#666";
  g.fillText("ふたり散歩", W - 170, 62);
  for (let i = 0; i < 9; i++) {
    const x = (i % 3) * S, yy = top + Math.floor(i / 3) * S, f = st.found[i];
    // 見つけたマスは色（カラーハント）か黒、まだのマスは薄い灰色に、探す色の見本だけ置く
    g.fillStyle = f ? cellColor(cells[i]) || "#111" : "#e6e6e2";
    g.fillRect(x, yy, S, S);
    if (!f && cellColor(cells[i])) { g.fillStyle = cellColor(cells[i]); g.fillRect(x + 14, yy + 14, 36, 36); }
    let drew = false;
    if (f && f.photoId != null) {
      try {
        const p = await idb("photos", "readonly", (s) => s.get(f.photoId));
        const img = await createImageBitmap(photoBlob(p));
        const k = Math.max(S / img.width, S / img.height), w = img.width * k, h = img.height * k;
        g.save(); g.beginPath(); g.rect(x, yy, S, S); g.clip();
        g.drawImage(img, x + (S - w) / 2, yy + (S - h) / 2, w, h); g.restore();
        drew = true;
      } catch {}
    }
    // マスの名前を下に小さく
    g.fillStyle = drew ? "rgba(0,0,0,.55)" : "rgba(0,0,0,0)";
    g.fillRect(x, yy + S - 44, S, 44);
    g.fillStyle = drew || f ? "#fff" : "#888";
    g.font = "500 22px 'IBM Plex Sans JP', sans-serif";
    g.fillText(cells[i], x + 14, yy + S - 22, S - 28);
    g.strokeStyle = "#f7f7f5"; g.lineWidth = 4; g.strokeRect(x, yy, S, S);
  }
  const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.9));
  const file = new File([blob], `futari-sanpo-${key.replace(":", "-")}.jpg`, { type: "image/jpeg" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "ふたり散歩のビンゴ" }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// アルバムと散歩中の両方のカードを描き直す
function renderBingoAll() {
  const rules = $("#bingoRules");
  if (rules && !rules.dataset.init) { rules.dataset.init = 1; rules.open = !store.get("bingoRulesSeen", false); rules.addEventListener("toggle", () => !rules.open && store.set("bingoRulesSeen", true)); }
  const ym = bingoKey();
  if (!$("#bingoAlbum").closest("[hidden]")) renderBingo($("#bingoAlbum"), ym);
  if (!$("#bingoOverlay").hidden) renderBingo($("#bingoWalk"), ym);
  const st = bingoState(ym);
  $("#bingoReward").value = st.reward || "";
  $("#bingoMonth").textContent = `${new Date().getMonth() + 1}月のビンゴ`;
  $$(".bingokind button").forEach((b) => b.classList.toggle("on", b.dataset.v === huntOf(ym)));
}
// 家で試すときは、ビンゴとことば集めは記録しない（実績に数えないように）
const simBlocked = () => { if (walk && walk.sim) { toast("家で試すときは使えません。本番の散歩で使えます"); return true; } return false; };
function openBingo() { if (simBlocked()) return; bingoPick = null; $("#bingoOverlay").hidden = false; renderBingoAll(); }

// ---------- ことば集め ----------
// 町の看板や張り紙から1文字ずつ写真に撮って、ことばを完成させる。
// できあがったら、切り抜いた文字を並べて1枚の画像（脅迫状ふう）にする
// ちょっとへんな言葉のほうが、集めていて楽しい。決まった言葉と、「へんな」＋「いぬ」のような組み合わせから選ぶ
const KOTOBA_IDEAS = ["たこがおこった", "かばのおうさま", "なすにのりたい", "うどんはともだち", "ちくわのあな", "とうふのきもち", "まくらがにげた", "おばけのおやつ", "ねこのかいぎ", "いかのしごと", "だいこんがない", "くつしたのくに", "らくだにきいて", "ひつじがかぞえる"];
const KOTOBA_ADJ = ["へんな", "ねむい", "まるい", "すっぱい", "さみしい", "えらい", "あやしい", "いそがしい", "はずかしい", "まがった", "ゆるい", "しかくい", "うるさい", "ひまな"];
const KOTOBA_NOUN = ["いぬ", "ねこ", "たこ", "いか", "かば", "なす", "いす", "かさ", "とうふ", "うどん", "おばけ", "まくら", "ちくわ", "らくだ", "だいこん", "おじさん", "かいだん", "ポスト"];
// 何ができるかは、完成するまでひみつ。探す文字は1つずつ知らせる（順番もばらばら）
function randomKotoba() {
  const r = Math.random;
  return r() < 0.5 ? KOTOBA_IDEAS[Math.floor(r() * KOTOBA_IDEAS.length)]
    : KOTOBA_ADJ[Math.floor(r() * KOTOBA_ADJ.length)] + KOTOBA_NOUN[Math.floor(r() * KOTOBA_NOUN.length)];
}
const kotobaNow = () => store.get("kotoba", null);
const kotobaSet = (k) => store.set("kotoba", k);
const kotobaChars = (phrase) => [...phrase].filter((c) => c.trim());
let kotobaFor = null;
// まだ集めていない文字の番号
const kotobaOpen = (k) => (k ? kotobaChars(k.phrase).map((_, i) => i).filter((i) => !k.tiles[i]) : []);
const kotobaLeft = (k) => (k ? kotobaOpen(k).map((i) => kotobaChars(k.phrase)[i]) : []);
// 次に探す文字を、まだの中から1つ選ぶ（「別の文字にする」でも使う）
function kotobaNext(k, skip) {
  const open = kotobaOpen(k).filter((i) => i !== skip);
  k.target = open.length ? open[Math.floor(Math.random() * open.length)] : kotobaOpen(k)[0] ?? null;
  return k;
}
function startKotoba() {
  kotobaSet(kotobaNext({ phrase: randomKotoba(), tiles: {}, startedAt: Date.now() }));
  renderKotobaAll();
}
const kotobaTargetChar = (k) => (k && k.target != null ? kotobaChars(k.phrase)[k.target] : null);

async function tileImage(t) {
  const p = await idb("photos", "readonly", (s) => s.get(t.photoId));
  return p ? createImageBitmap(photoBlob(p)) : null;
}
// 切り抜いた1文字を、小さなcanvasに描く
async function drawTile(t, size) {
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const img = await tileImage(t).catch(() => null);
  if (!img) return cv;
  const s = t.size * Math.min(img.width, img.height);
  cv.getContext("2d").drawImage(img, t.cx * img.width - s / 2, t.cy * img.height - s / 2, s, s, 0, 0, size, size);
  return cv;
}
async function renderKotoba(box) {
  const k = kotobaNow();
  box.innerHTML = "";
  if (!k) {
    box.appendChild(mkEl("small muted", "町の看板や張り紙から、1文字ずつ写真に撮って集めます。何ができるかは、完成するまでひみつ。お店の多い場所を歩くと、探す文字が届きます"));
    const b = document.createElement("button"); b.className = "secondary"; b.textContent = "ことば集めをはじめる";
    b.onclick = startKotoba;
    box.appendChild(b);
  } else {
    const chars = kotobaChars(k.phrase), got = Object.keys(k.tiles).length, c = kotobaTargetChar(k);
    box.appendChild(mkEl("kotobanow", `いま探している文字：「${c}」`));
    box.appendChild(mkEl("small muted", `${got}文字あつめました。全部で何文字かも、ひみつです`));
    // 集めた文字は、順番がわからないようにばらばらに並べる
    const row = mkEl("kotobarow");
    shuffle(Object.values(k.tiles), rng(k.startedAt)).forEach((t) => {
      const el = mkEl("kotobatile on");
      drawTile(t, 120).then((cv) => { cv.className = "kotobacv"; el.appendChild(cv); });
      row.appendChild(el);
    });
    if (got) box.appendChild(row);
    const acts = mkEl("bingoacts");
    if (walk) {
      const shoot = document.createElement("label");
      shoot.className = "secondary"; shoot.htmlFor = "photoInput"; shoot.textContent = `「${c}」を撮る`;
      shoot.addEventListener("click", () => { kotobaFor = k.target; photoFor = `ことば集め：「${c}」`; bingoPhotoFor = null; });
      acts.appendChild(shoot);
    }
    if (kotobaOpen(k).length > 1) {
      const other = document.createElement("button"); other.className = "link"; other.textContent = "別の文字にする";
      other.onclick = () => { kotobaSet(kotobaNext(k, k.target)); renderKotobaAll(); if (walk) { walk.kotobaAt = 0; renderCard(); } };
      acts.appendChild(other);
    }
    const quit = document.createElement("button"); quit.className = "link"; quit.textContent = "やめる";
    quit.onclick = () => { if (confirm("ことば集めをやめますか？集めた文字は消えます")) { kotobaSet(null); renderKotobaAll(); } };
    acts.appendChild(quit);
    box.appendChild(acts);
  }
  // できあがったことば
  const done = store.get("kotobaDone", []);
  if (done.length) {
    box.appendChild(mkEl("itemlabel", "できあがったことば"));
    const list = mkEl("kotobadone");
    done.slice().reverse().forEach((d) => {
      const b = document.createElement("button"); b.className = "link"; b.textContent = `「${d.phrase}」`;
      b.onclick = () => revealKotoba(d);
      list.appendChild(b);
    });
    box.appendChild(list);
  }
}
function renderKotobaAll() {
  if ($("#kotobaAlbum")) renderKotoba($("#kotobaAlbum"));
  if (!$("#kotobaOverlay").hidden) renderKotoba($("#kotobaWalk"));
}
function openKotoba() { if (simBlocked()) return; $("#kotobaOverlay").hidden = false; renderKotobaAll(); }

// お店や駅が多い場所か（看板の文字が見つけやすい）。地図データのお店の数で決める
const SHOP_NEAR = 150, SHOP_MIN = 12;
const nearShops = (route, p) => (route.letterSpots || []).filter((q) => dist(p, q) < SHOP_NEAR).length >= SHOP_MIN;
// 散歩中：お店の多い場所に来たら、探す文字を知らせる（10分に1回まで）
function kotobaTick(p) {
  const k = kotobaNow();
  if (!k || k.target == null || !walk || walk.sim || walk.resting) return;
  const now = Date.now(), gap = 10 * 60000 / (walk.sim ? SIM_SPEED : 1);
  if (now - (walk.kotobaAt || 0) < gap || walk.inbox.some((m) => m.kind === "kotoba")) return;
  if (!nearShops(walk.route, p)) return;
  walk.kotobaAt = now;
  walk.inbox.push({ kind: "kotoba", id: "kotoba" + now, text: `このあたりは看板が多い場所です。ことば集めの文字「${kotobaTargetChar(k)}」を探して撮ろう`, arrivedAt: now });
  buzz([80, 60, 80]); renderCard();
}

// 撮った写真の中で、文字のところを押して切り抜く
function openCrop(photoId, blob, idx) {
  const ov = $("#cropOverlay"), img = $("#cropImg"), frame = $("#cropFrame"), size = $("#cropSize");
  const url = URL.createObjectURL(blob);
  let cx = 0.5, cy = 0.5;
  const place = () => {
    const r = img.getBoundingClientRect(), s = (+size.value / 100) * Math.min(r.width, r.height);
    Object.assign(frame.style, { width: `${s}px`, height: `${s}px`, left: `${img.offsetLeft + cx * r.width - s / 2}px`, top: `${img.offsetTop + cy * r.height - s / 2}px` });
  };
  img.onload = place;
  img.src = url;
  img.onclick = (e) => { const r = img.getBoundingClientRect(); cx = (e.clientX - r.left) / r.width; cy = (e.clientY - r.top) / r.height; place(); };
  size.oninput = place;
  $("#cropOk").onclick = () => {
    const k = kotobaNow();
    if (k) { k.tiles[idx] = { photoId, cx, cy, size: +size.value / 100 }; kotobaSet(kotobaNext(k)); }
    ov.hidden = true; URL.revokeObjectURL(url);
    // 届いていた「ことば集め」のカードは片づける
    if (walk) { walk.inbox = walk.inbox.filter((m) => m.kind !== "kotoba"); walk.kotobaAt = Date.now(); renderCard(); saveActive(); }
    if (!kotobaCheckDone()) { const c = kotobaTargetChar(kotobaNow()); toast(`1文字あつめました。次は「${c}」`); }
    renderKotobaAll();
  };
  ov.hidden = false;
}
function kotobaCheckDone() {
  const k = kotobaNow();
  if (!k || kotobaOpen(k).length) return false;
  const d = { phrase: k.phrase, tiles: k.tiles, at: Date.now() };
  store.set("kotobaDone", [...store.get("kotobaDone", []), d]);
  kotobaSet(null);
  buzz([100, 60, 100, 60, 300]);
  revealKotoba(d, true);
  return true;
}
// 完成したことばを見せる。はじめて見るときは「何ができたかな…」と少しためる
async function revealKotoba(d, first) {
  const ov = $("#kotobaReveal");
  $("#revealTitle").textContent = first ? "何ができたかな…" : `「${d.phrase}」`;
  $("#revealImg").hidden = true;
  ov.hidden = false;
  const blob = await kotobaCollage(d);
  const url = blobUrl(blob);
  if (first) await new Promise((r) => setTimeout(r, 1500));
  $("#revealImg").src = url; $("#revealImg").hidden = false;
  $("#revealTitle").textContent = `「${d.phrase}」ができました！`;
  $("#revealSave").onclick = () => shareImage(blob, `futari-sanpo-${d.phrase}.jpg`, d.phrase);
}
async function shareImage(blob, name, title) {
  const file = new File([blob], name, { type: "image/jpeg" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; }
  } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 切り抜いた文字を、少しずつ傾けて並べる（5文字ごとに改行）
async function kotobaCollage(d) {
  const chars = kotobaChars(d.phrase), per = Math.min(5, chars.length), rows = Math.ceil(chars.length / per);
  const T = 220, gap = 26, pad = 60, W = pad * 2 + per * T + (per - 1) * gap, H = pad * 2 + rows * T + (rows - 1) * gap + 70;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#f3efe6"; g.fillRect(0, 0, W, H);
  const r = rng(d.at);
  for (let i = 0; i < chars.length; i++) {
    const row = Math.floor(i / per), col = i % per, inRow = Math.min(per, chars.length - row * per);
    const x = pad + (W - pad * 2 - (inRow * T + (inRow - 1) * gap)) / 2 + col * (T + gap) + T / 2, y = pad + row * (T + gap) + T / 2;
    const sc = 0.88 + r() * 0.16, ang = (r() - 0.5) * 0.2;
    const tile = d.tiles[i] ? await drawTile(d.tiles[i], 400) : null;
    g.save(); g.translate(x, y); g.rotate(ang); g.scale(sc, sc);
    g.shadowColor = "rgba(0,0,0,.25)"; g.shadowBlur = 10; g.shadowOffsetY = 4;
    g.fillStyle = "#fff"; g.fillRect(-T / 2 - 8, -T / 2 - 8, T + 16, T + 16);
    g.shadowColor = "transparent";
    if (tile) g.drawImage(tile, -T / 2, -T / 2, T, T);
    else { g.fillStyle = "#111"; g.font = `600 ${T * 0.6}px 'IBM Plex Sans JP', sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(chars[i], 0, 0); }
    g.restore();
  }
  const dt = new Date(d.at);
  g.fillStyle = "#555"; g.font = "400 26px 'IBM Plex Mono', monospace"; g.textAlign = "right"; g.textBaseline = "alphabetic";
  g.fillText(`${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}  ふたり散歩`, W - pad, H - 30);
  return new Promise((res) => cv.toBlob(res, "image/jpeg", 0.9));
}

// ---------- 一年のふりかえり ----------
// その年の散歩をまとめて1ページにする。二人で記録した同じ散歩は1回に数える
function reviewYears(walks) {
  return [...new Set(walks.filter((w) => !w.sim).map((w) => new Date(w.startedAt).getFullYear()))].sort((a, b) => b - a);
}
function renderReviewButtons(walks) {
  const box = $("#reviewBtns");
  box.innerHTML = "";
  reviewYears(walks).slice(0, 3).forEach((y) => {
    const b = document.createElement("button");
    b.className = "secondary"; b.textContent = `${y}年のふりかえり`;
    b.onclick = () => openReview(y);
    box.appendChild(b);
  });
}
async function openReview(year) {
  releaseUrls();
  const all = await allWalks();
  const groups = groupWalks(all).filter((g) => !g[0].sim && new Date(g[0].startedAt).getFullYear() === year).sort((a, b) => a[0].startedAt - b[0].startedAt);
  const ws = groups.map((g) => g[0]);
  const km = ws.reduce((n, w) => n + w.distance, 0) / 1000, min = ws.reduce((n, w) => n + (w.minutes || 0), 0);
  const roads = uniqueKm(walkedLines(groups.flat()));
  const months = Array(12).fill(0);
  ws.forEach((w) => (months[new Date(w.startedAt).getMonth()] += w.distance / 1000));
  const longest = ws.reduce((a, w) => (!a || w.distance > a.distance ? w : a), null);
  const count = (xs) => Object.entries(xs.reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {})).sort((a, b) => b[1] - a[1]);
  const stops = count(ws.map((w) => w.stopName).filter(Boolean)).slice(0, 3);
  const dests = [...new Set(ws.map((w) => w.dest && w.dest.name).filter(Boolean))].slice(0, 5);
  const themes = count(ws.map((w) => w.theme).filter(Boolean));
  const results = groups.flat().flatMap((w) => w.results || []).filter((r) => r.outcome === "done");
  const memos = shuffle([...new Set(results.filter((r) => r.memo).map((r) => r.memo))], rng(year)).slice(0, 6);
  const badges = [...new Set(all.filter((w) => !w.sim && new Date(w.startedAt).getFullYear() === year).flatMap((w) => w.newBadges || []))].map((id) => BADGES.find((b) => b.id === id)).filter(Boolean);
  let bingo = 0;
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, "0")}`;
    Object.keys(localStorage).filter((k) => k.startsWith("fs:bingo:" + ym)).forEach((k) => { try { const st = JSON.parse(localStorage.getItem(k)); if (st && st.found) bingo += bingoLines(st); } catch {} });
  }
  const words = store.get("kotobaDone", []).filter((k) => new Date(k.at).getFullYear() === year).map((k) => k.phrase);
  // 写真は、1年を通して偏らないように最大9枚えらぶ（お題の写真を優先）
  const photos = (await Promise.all(groups.map((g) => photosOfGroup(g)))).map((ps) => ps.find((p) => p.mission) || ps[0]).filter(Boolean);
  const step = Math.max(1, photos.length / 9), picks = [];
  for (let i = 0; i < photos.length && picks.length < 9; i += step) picks.push(photos[Math.floor(i)]);

  $("#reviewTitle").textContent = `${year}年のふたり散歩`;
  const body = $("#reviewBody");
  body.innerHTML = "";
  const sec = (label) => { const d = mkEl("reviewsec"); d.appendChild(mkEl("itemlabel", label)); body.appendChild(d); return d; };
  const nums = sec("この一年");
  const grid = mkEl("reviewnums");
  [[`${ws.length}`, "回"], [fmtKm(km * 1000), "km"], [`${Math.floor(min / 60)}`, "時間"], [fmtKm(roads * 1000), "kmの道"]].forEach(([v, u]) => { const c = mkEl("reviewnum"); c.append(mkEl("v", v), mkEl("u", u)); grid.appendChild(c); });
  nums.appendChild(grid);
  distanceFacts(km).filter((f) => f.progress == null).slice(0, 3).forEach((f) => nums.appendChild(mkEl("small", f.text)));
  // 月ごとの距離
  const mon = sec("月ごとの距離");
  const bars = mkEl("monthbars"), mx = Math.max(...months, 0.1);
  months.forEach((v, i) => { const c = mkEl("mb"); const bar = mkEl("mbbar"); bar.style.height = `${(v / mx) * 100}%`; c.append(bar, mkEl("mbl", String(i + 1))); c.title = `${i + 1}月 ${v.toFixed(1)}km`; bars.appendChild(c); });
  mon.appendChild(bars);
  const top = months.indexOf(Math.max(...months));
  if (months[top] > 0) mon.appendChild(mkEl("small muted", `いちばん歩いたのは${top + 1}月（${months[top].toFixed(1)}km）`));
  // できごと
  const ev = sec("思い出");
  const ul = document.createElement("ul"); ul.className = "facts";
  const li = (t) => { const x = document.createElement("li"); x.textContent = t; ul.appendChild(x); };
  if (longest) li(`いちばん長い散歩：${fmtDate(longest.startedAt)}の${fmtKm(longest.distance)}km`);
  if (stops.length) li(`よく寄った場所：${stops.map(([n, c]) => `${n}（${c}回）`).join("、")}`);
  if (dests.length) li(`歩いて行った目的地：${dests.join("、")}`);
  if (themes.length) li(`いちばん多かったテーマ：${THEMES[themes[0][0]] ? THEMES[themes[0][0]].label : themes[0][0]}`);
  li(`見つけたこと・話したこと：${results.length}個`);
  if (bingo) li(`ビンゴ：${bingo}列`);
  if (words.length) li(`町で集めたことば：${words.map((w) => `「${w}」`).join("")}`);
  if (badges.length) li(`取った実績：${badges.length}個（${badges.slice(0, 6).map((b) => b.name).join("、")}${badges.length > 6 ? "ほか" : ""}）`);
  ev.appendChild(ul);
  if (picks.length) {
    const ph = sec("この一年の写真");
    const pg = mkEl("reviewphotos");
    picks.forEach((p) => { const b = document.createElement("button"); b.style.backgroundImage = `url(${blobUrl(photoBlob(p))})`; b.onclick = () => openViewer(p); pg.appendChild(b); });
    ph.appendChild(pg);
  }
  if (memos.length) {
    const me = sec("心に残ったメモ");
    memos.forEach((m) => me.appendChild(mkEl("reviewmemo", `「${m}」`)));
  }
  // 夫婦用ページ：AIに一年の日記を書いてもらう
  if (window.Cloud && Cloud.renderYear) {
    const ai = sec("一年のへんな物語");
    const summary = [
      `${year}年の散歩：${ws.length}回、合計${km.toFixed(1)}km、${Math.floor(min / 60)}時間${min % 60}分`,
      `月ごとの距離(km)：${months.map((v, i) => `${i + 1}月${v.toFixed(1)}`).join("、")}`,
      longest ? `いちばん長い散歩：${new Date(longest.startedAt).getMonth() + 1}月の${fmtKm(longest.distance)}km` : "",
      stops.length ? `よく寄った場所：${stops.map(([n, c]) => `${n}${c}回`).join("、")}` : "",
      dests.length ? `目的地：${dests.join("、")}` : "",
      `見つけたこと・話したこと：${results.length}個`,
      bingo ? `ビンゴ${bingo}列` : "",
      words.length ? `町で集めたことば：${words.join("、")}` : "",
      memos.length ? `メモ：${memos.map((m) => `「${m}」`).join(" ")}` : "",
      ...shuffle(results, rng(year + 1)).slice(0, 12).map((r) => `- ${r.kind === "talk" ? "話した" : "見つけた"}「${r.text}」`),
    ].filter(Boolean).join("\n");
    Cloud.renderYear(ai, year, summary);
  }
  $("#review").hidden = false;
  $("#review").scrollTop = 0;
}

// ---------- ふたりの散歩地図 ----------
// これまでの散歩の道を1枚の地図に重ねる。何度も通った道ほど濃くなる。
// 歩いた道の長さは、25m四方のマスで数えて、同じ道を何度通っても1回分にする
let walkedMap = null;
function walkedLines(walks) {
  return walks.filter((w) => !w.sim).map((w) => (w.track && w.track.length > 5 ? w.track : w.route) || []).filter((c) => c.length > 1);
}
// 25m四方のマスの番号。経度の縮み具合は、緯度を1度単位に丸めて決める（同じ町なら同じマスになるように）
const cellOf = (p) => [Math.round(p[0] * 111320 / 25), Math.round(p[1] * 111320 * Math.cos(rad(Math.round(p[0]))) / 25)];
function walkedCells(lines) {
  const cells = new Set();
  lines.forEach((c) => {
    for (let i = 1; i < c.length; i++) {
      const n = Math.max(1, Math.ceil(dist(c[i - 1], c[i]) / 10));
      for (let j = 0; j <= n; j++) cells.add(cellOf([c[i - 1][0] + (c[i][0] - c[i - 1][0]) * (j / n), c[i - 1][1] + (c[i][1] - c[i - 1][1]) * (j / n)]).join());
    }
  });
  return cells;
}
const uniqueKm = (lines) => (walkedCells(lines).size * 25) / 1000;
// ルートのうち、まだ歩いたことのない道の割合（0〜1）。GPSのずれを見込んで、となりのマスまで「歩いた」とみなす。
// スタート地点のまわり100mは、どうしても通るので数えない
function freshRatio(route, cells, home) {
  if (!cells || !cells.size) return 1;
  let n = 0, fresh = 0;
  for (let a = 0; a < route.total; a += 15) {
    const p = pointAt(route, a);
    if (home && dist(p, home) < 100) continue;
    const [y, x] = cellOf(p);
    n++;
    let seen = false;
    for (let dy = -1; dy <= 1 && !seen; dy++) for (let dx = -1; dx <= 1 && !seen; dx++) seen = cells.has(`${y + dy},${x + dx}`);
    if (!seen) fresh++;
  }
  return n ? fresh / n : 1;
}
async function myWalkedCells() {
  try { return walkedCells(walkedLines(await allWalks())); } catch { return new Set(); }
}
async function renderWalkedMap(walks) {
  const lines = walkedLines(walks);
  $("#walkedCard").hidden = !lines.length;
  if (!lines.length) return;
  $("#walkedText").textContent = `${lines.length}回分の道。歩いた道は約${fmtKm(uniqueKm(lines) * 1000)}km（同じ道は1回に数えます）。何度も通った道ほど濃く見えます`;
  if (!walkedMap) walkedMap = makeMap($("#walkedMap"));
  await walkedMap.ready;
  const data = { type: "FeatureCollection", features: lines.map((c) => lineData(c)) };
  if (walkedMap.getSource("walked")) walkedMap.getSource("walked").setData(data);
  else {
    walkedMap.addSource("walked", { type: "geojson", data });
    walkedMap.addLayer({ id: "walked", type: "line", source: "walked", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE_COLOR, "line-width": 4, "line-opacity": 0.35 } });
  }
  walkedMap.resize();
  walkedMap.fitBounds(boundsOf(lines.flat()), { padding: 24, animate: false, maxZoom: 16 });
}

async function renderAlbum() {
  releaseUrls();
  const box = $("#albumList");
  const walks = (await allWalks()).sort((a, b) => b.startedAt - a.startedAt);
  renderBadges(ownWalks(walks));
  renderWalkedMap(walks);
  renderBingoAll();
  renderReviewButtons(walks);
  renderKotobaAll();
  renderZukan();
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
  const fact = w.sim ? "" : walkFact(w.distance, w.seed || w.startedAt);
  $("#detailFact").textContent = fact; $("#detailFact").hidden = !fact;
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
  { step: "4 / 5", title: "お題は2種類", pic: "観察 ＋ 写真", items: [
    "「観察」は、ふだん見過ごしている細かいところに目を向けるお題です",
    "「写真のお題」は、撮り方にひと工夫するお題です。影だけ、真上から、ネコの目の高さで、など",
    "できたら「見つけた」「撮った」。一言メモも残せます。気分じゃなければ「次へ」で飛ばせます",
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
  bindSeg("segSplit", "split", () => { applyShapeUI(); resetRoute(); });
  bindSeg("segMeet", "meet", resetRoute);
  bindSeg("segShape", "shape", () => { applyShapeUI(); resetRoute(); });
  bindSeg("segParty", "party", () => { applyShapeUI(); resetRoute(); });
  bindSeg("segMeguri", "meguri", () => { applyShapeUI(); resetRoute(); });
  bindSeg("segBack", "back", resetRoute);
  $("#chkFresh").checked = plan.fresh;
  $("#chkFresh").onchange = (e) => { plan.fresh = e.target.checked; store.set("fresh", plan.fresh); resetRoute(); };
  $("#destForm").addEventListener("submit", onDestSearch);
  applyShapeUI();
  $("#btnDestEnd").onclick = () => finishWalk();
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
  $("#btnPaste").onclick = onPasteLink;
  $("#btnOwnRoute").onclick = () => { history.replaceState(null, "", location.pathname); location.reload(); };
  $("#btnStart").onclick = () => startWalk(false);
  $("#btnSim").onclick = () => startWalk(true);

  // カメラは<label for>で開く（iPhoneでいちばん確実な開き方）。開く前にどのお題の写真かを覚えておく
  $("#btnShoot").addEventListener("click", () => { photoFor = walk && walk.inbox[0] ? walk.inbox[0].text : null; });
  $("#btnFree").addEventListener("click", () => { photoFor = null; bingoPhotoFor = null; kotobaFor = null; });
  $("#btnShoot").addEventListener("click", () => {
    bingoPhotoFor = null; kotobaFor = null;
    const m = walk && walk.inbox[0], k = kotobaNow();
    if (m && m.kind === "kotoba" && k) { kotobaFor = k.target; photoFor = `ことば集め：「${kotobaTargetChar(k)}」`; }
    zukanFor = m && m.kind === "spot" ? m.spot : null;
  });
  $("#revealClose").onclick = () => { $("#kotobaReveal").hidden = true; };
  $("#btnKotoba").onclick = openKotoba;
  $("#btnKotobaClose").onclick = () => { $("#kotobaOverlay").hidden = true; };
  $("#cropCancel").onclick = () => { $("#cropOverlay").hidden = true; };
  $("#btnBingo").onclick = openBingo;
  $("#btnReviewClose").onclick = () => { $("#review").hidden = true; };
  $("#btnBingoClose").onclick = () => { $("#bingoOverlay").hidden = true; bingoPick = null; };
  $$(".bingokind button").forEach((b) => b.onclick = () => { store.set("bingoKind:" + monthKey(), b.dataset.v); bingoPick = null; renderBingoAll(); });
  $("#bingoReward").addEventListener("change", (e) => { const ym = bingoKey(), st = bingoState(ym); st.reward = e.target.value.trim().slice(0, 40); bingoSave(ym, st); renderBingoAll(); });
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
