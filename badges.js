// 称号とバッジ。試しモードの散歩は数えない

// 「気づき」（観察と会話のタネをクリアした数）で上がっていく称号
const TITLES = [
  { pts: 0, name: "散歩ビギナー" },
  { pts: 5, name: "よそ見の初心者" },
  { pts: 15, name: "路地の観察者" },
  { pts: 30, name: "町の発見家" },
  { pts: 60, name: "散歩の達人" },
  { pts: 100, name: "町の語り部" },
  { pts: 160, name: "散歩の哲学者" },
  { pts: 250, name: "町の生き字引" },
  { pts: 400, name: "散歩の仙人" },
];

// バッジの分類（アルバムでは分類ごとに並べる）
const BADGE_CATS = {
  dist: "歩いた距離", count: "散歩の回数", look: "観察", photo: "写真とメモ",
  stop: "寄り道と目的地", time: "時間と季節", weather: "天気とテーマ", streak: "続ける", special: "特別な日", secret: "ひみつ",
};

// mark はハンコ風に丸で囲んで表示する1文字。secret は取るまで名前も条件も隠す
const b = (cat, id, mark, name, desc, need, get, secret) => ({ cat, id, mark, name, desc, need, get, secret: !!secret });
const km = (s) => s.km;
const BADGES = [
  // 歩いた距離（合計）
  b("dist", "km1", "歩", "最初の1km", "合計1km歩く", 1, km),
  b("dist", "fuji", "富", "富士山の高さ", "合計3.776km歩く（富士山の高さ）", 3.776, km),
  b("dist", "km10", "十", "10km達成", "合計10km歩く", 10, km),
  b("dist", "yamanote", "環", "山手線一周", "合計34.5km歩く（山手線一周）", 34.5, km),
  b("dist", "marathon", "走", "フルマラソン", "合計42.195km歩く", 42.195, km),
  b("dist", "km100", "百", "100km達成", "合計100km歩く", 100, km),
  b("dist", "km200", "遠", "200km達成", "合計200km歩く", 200, km),
  b("dist", "tokaido", "宿", "東海道五十三次", "合計492km歩く（日本橋〜京都の東海道）", 492, km),
  b("dist", "km1000", "千", "1000km達成", "合計1000km歩く", 1000, km),
  b("dist", "japan", "島", "日本縦断", "合計3000km歩く（北海道〜沖縄くらい）", 3000, km),
  b("dist", "long", "長", "ロングウォーク", "1回で6km以上歩く", 6, (s) => s.maxKm),
  b("dist", "long10", "脚", "健脚", "1回で10km以上歩く", 10, (s) => s.maxKm),
  b("dist", "hours", "刻", "のんびり3時間", "1回で3時間以上歩く", 180, (s) => s.maxMin),
  b("dist", "total24", "日", "まる一日ぶん", "合計24時間歩く", 24 * 60, (s) => s.totalMin),
  // 回数
  b("count", "first", "初", "はじめの一歩", "1回散歩する", 1, (s) => s.walks),
  b("count", "walk5", "五", "散歩なかま", "5回散歩する", 5, (s) => s.walks),
  b("count", "walk10", "拾", "10回目の散歩", "10回散歩する", 10, (s) => s.walks),
  b("count", "walk20", "達", "散歩が日課", "20回散歩する", 20, (s) => s.walks),
  b("count", "walk50", "常", "散歩のある暮らし", "50回散歩する", 50, (s) => s.walks),
  b("count", "walk100", "極", "百回さんぽ", "100回散歩する", 100, (s) => s.walks),
  b("count", "walk200", "神", "散歩の神さま", "200回散歩する", 200, (s) => s.walks),
  b("count", "full", "皆", "皆勤", "1回の散歩で、届いたお題を1つも飛ばさない", 1, (s) => s.fulls),
  b("count", "full10", "完", "完璧主義", "お題を1つも飛ばさない散歩を10回", 10, (s) => s.fulls),
  // 観察
  b("look", "look10", "視", "観察ビギナー", "観察のお題を10回クリア", 10, (s) => s.looks),
  b("look", "look30", "察", "よく見る人", "観察のお題を30回クリア", 30, (s) => s.looks),
  b("look", "look50", "眼", "観察の名人", "観察のお題を50回クリア", 50, (s) => s.looks),
  b("look", "look100", "鏡", "虫めがねの心", "観察のお題を100回クリア", 100, (s) => s.looks),
  b("look", "look200", "鷹", "町を見通す目", "観察のお題を200回クリア", 200, (s) => s.looks),
  b("look", "day5", "豊", "気づきの多い日", "1回の散歩で5つ以上クリア", 5, (s) => s.maxDone),
  b("look", "day10", "宝", "宝さがしの日", "1回の散歩で10以上クリア", 10, (s) => s.maxDone),
  // 会話
  // 写真とメモ
  b("photo", "pm10", "構", "写真のお題10", "写真のお題を10回クリア", 10, (s) => s.photoMissions),
  b("photo", "pm30", "画", "写真の目", "写真のお題を30回クリア", 30, (s) => s.photoMissions),
  b("photo", "pm100", "眺", "散歩写真家", "写真のお題を100回クリア", 100, (s) => s.photoMissions),
  b("photo", "photo1", "撮", "はじめての1枚", "写真を1枚撮る", 1, (s) => s.photos),
  b("photo", "photo10", "写", "撮影係", "写真を合計10枚撮る", 10, (s) => s.photos),
  b("photo", "photo50", "匠", "散歩カメラマン", "写真を合計50枚撮る", 50, (s) => s.photos),
  b("photo", "photo100", "景", "写真集が作れる", "写真を合計100枚撮る", 100, (s) => s.photos),
  b("photo", "photo300", "映", "町の記録係", "写真を合計300枚撮る", 300, (s) => s.photos),
  b("photo", "memo5", "記", "メモ魔", "一言メモを5回残す", 5, (s) => s.memos),
  b("photo", "memo30", "筆", "散歩日記", "一言メモを30回残す", 30, (s) => s.memos),
  // 寄り道と目的地
  b("stop", "stop3", "巡", "寄り道めぐり", "3か所の違う寄り道先に行く", 3, (s) => s.stops),
  b("stop", "stop10", "旅", "町の案内人", "10か所の違う寄り道先に行く", 10, (s) => s.stops),
  b("stop", "stop30", "図", "生きた地図", "30か所の違う寄り道先に行く", 30, (s) => s.stops),
  b("stop", "kinds5", "彩", "いろいろ寄り道", "5種類の寄り道先に行く（カフェ・公園・神社など）", 5, (s) => s.stopKinds),
  b("stop", "kinds9", "全", "寄り道コンプリート", "9種類すべての寄り道先に行く", 9, (s) => s.stopKinds),
  b("stop", "cafe5", "珈", "カフェの常連", "カフェに5回寄る", 5, (s) => s.stopType.cafe || 0),
  b("stop", "bakery3", "麦", "パンのにおい", "パン屋に3回寄る", 3, (s) => s.stopType.bakery || 0),
  b("stop", "shrine5", "祈", "お参りさんぽ", "神社・お寺に5回寄る", 5, (s) => s.stopType.shrine || 0),
  b("stop", "historic3", "碑", "歴史さんぽ", "史跡に3回寄る", 3, (s) => s.stopType.historic || 0),
  b("stop", "bath", "湯", "ひとっ風呂", "銭湯に寄る", 1, (s) => s.stopType.bath || 0),
  b("stop", "sweets3", "甘", "甘いもの係", "和菓子屋に3回寄る", 3, (s) => s.stopType.sweets || 0),
  b("stop", "detour", "脇", "ちょっと寄り道", "地図の見どころに「ここに寄る」で寄る", 1, (s) => s.detours),
  b("stop", "dest1", "的", "目的地へ", "目的地モードで歩く", 1, (s) => s.dests),
  b("stop", "dest10", "標", "目的地ハンター", "目的地モードで10回歩く", 10, (s) => s.dests),
  b("stop", "oneway", "車", "帰りは電車で", "片道で目的地まで歩く", 1, (s) => s.oneways),
  b("stop", "split1", "分", "別行動デビュー", "別行動して、合流する", 1, (s) => s.splits),
  b("stop", "split10", "合", "また会えたね", "別行動を10回する", 10, (s) => s.splits),
  // 時間と季節
  b("time", "morning", "朝", "朝さんぽ", "朝8時より前に出発する", 1, (s) => s.mornings),
  b("time", "morning10", "旭", "朝型ふたり", "朝8時より前に10回出発する", 10, (s) => s.mornings),
  b("time", "dawn", "暁", "夜明けの散歩", "朝6時より前に出発する", 1, (s) => s.dawns),
  b("time", "night", "夜", "夜さんぽ", "日が暮れてから散歩する", 1, (s) => s.nights),
  b("time", "night10", "月", "夜の散歩好き", "日が暮れてから10回散歩する", 10, (s) => s.nights),
  b("time", "late", "星", "夜ふかし散歩", "夜9時より後に出発する", 1, (s) => s.lates),
  b("time", "weekend", "休", "休日さんぽ", "土日に5回散歩する", 5, (s) => s.weekends),
  b("time", "seasons", "季", "四季の散歩", "春・夏・秋・冬それぞれに散歩する", 4, (s) => s.seasons),
  b("time", "months", "暦", "一年じゅう", "1月〜12月のすべての月に散歩する", 12, (s) => s.months),
  // 天気とテーマ
  b("weather", "sunny", "晴", "散歩日和", "晴れの日に散歩する", 1, (s) => s.weather.sunny || 0),
  b("weather", "rain", "雨", "雨の日さんぽ", "雨の日に散歩する", 1, (s) => s.weather.rain || 0),
  b("weather", "rain5", "傘", "雨も好き", "雨の日に5回散歩する", 5, (s) => s.weather.rain || 0),
  b("weather", "snow", "雪", "雪の日さんぽ", "雪の日に散歩する", 1, (s) => s.weather.snow || 0),
  b("weather", "hot", "暑", "真夏の散歩", "30℃以上の日に散歩する", 1, (s) => s.weather.hot || 0),
  b("weather", "cold", "寒", "冬の散歩", "5℃以下の日に散歩する", 1, (s) => s.weather.cold || 0),
  b("weather", "theme3", "題", "テーマのある日", "3種類のテーマで散歩する", 3, (s) => s.themes),
  b("weather", "theme6", "覇", "テーマ制覇", "6種類すべてのテーマで散歩する", 6, (s) => s.themes),
  // 続ける
  b("streak", "days3", "三", "三日坊主じゃない", "3日続けて散歩する", 3, (s) => s.streakDays),
  b("streak", "days7", "七", "1週間毎日", "7日続けて散歩する", 7, (s) => s.streakDays),
  b("streak", "weeks4", "週", "毎週の習慣", "4週続けて、毎週1回以上散歩する", 4, (s) => s.streakWeeks),
  b("streak", "weeks12", "継", "三か月つづいた", "12週続けて、毎週1回以上散歩する", 12, (s) => s.streakWeeks),
  b("streak", "weeks52", "年", "一年つづいた", "52週続けて、毎週1回以上散歩する", 52, (s) => s.streakWeeks),
  b("streak", "month8", "密", "よく歩いた月", "ひと月に8回散歩する", 8, (s) => s.maxInMonth),
  b("streak", "day2", "再", "おかわり散歩", "同じ日に2回散歩する", 2, (s) => s.maxInDay),
  // ビンゴとハント
  b("streak", "bingo1", "揃", "ビンゴ！", "月替わりのビンゴを1列そろえる", 1, (s) => s.bingoLines),
  b("streak", "bingo5", "列", "ビンゴ名人", "ビンゴを合計5列そろえる", 5, (s) => s.bingoLines),
  b("streak", "bingoFull", "九", "写真集の完成", "ビンゴのカードを9マス全部うめる", 1, (s) => s.bingoFulls),
  b("streak", "kotoba1", "言", "ことば職人", "ことば集めで、ことばを1つ完成させる", 1, (s) => s.kotoba),
  b("streak", "kotoba5", "文", "町の文筆家", "ことば集めで、ことばを5つ完成させる", 5, (s) => s.kotoba),
  // まち図鑑とめぐり
  b("stop", "zukan10", "鑑", "まち図鑑10", "まち図鑑に10か所あつめる", 10, (s) => s.zukan),
  b("stop", "zukan30", "冊", "まち図鑑30", "まち図鑑に30か所あつめる", 30, (s) => s.zukan),
  b("stop", "zukan100", "名", "わたしたちの百名所", "まち図鑑に100か所あつめる", 100, (s) => s.zukan),
  b("stop", "fudo1", "剣", "お不動さんに会う", "まち図鑑に不動明王を1つ入れる", 1, (s) => s.zukanCat.fudo || 0),
  b("stop", "fudo5", "炎", "お不動さんめぐり", "まち図鑑に不動明王を5つ入れる", 5, (s) => s.zukanCat.fudo || 0),
  b("stop", "goshiki", "尊", "江戸五色不動", "目黒・目白・目赤・目青・目黄のお不動さんを全部あつめる", 5, (s) => s.goshiki),
  b("stop", "ankyo1", "渠", "暗渠さんぽ", "暗渠を歩いて、まち図鑑に入れる", 1, (s) => s.zukanCat.ankyo || 0),
  b("stop", "ankyo5", "川", "見えない川の地図", "5本のちがう暗渠を歩く", 5, (s) => s.zukanCat.ankyo || 0),
  b("stop", "shotengai3", "市", "商店街のはしご", "3つのちがう商店街を歩く", 3, (s) => s.zukanCat.shotengai || 0),
  b("stop", "kissa3", "喫", "喫茶店の常連", "まち図鑑に喫茶店を3軒入れる", 3, (s) => s.zukanCat.kissa || 0),
  b("stop", "kissa10", "盞", "純喫茶さんぽ", "まち図鑑に喫茶店を10軒入れる", 10, (s) => s.zukanCat.kissa || 0),
  b("stop", "park10", "遊", "公園はしご名人", "まち図鑑に公園を10か所入れる", 10, (s) => s.zukanCat.park || 0),
  b("stop", "tree5", "樹", "木を見る人", "まち図鑑に名木・巨樹を5本入れる", 5, (s) => s.zukanCat.tree || 0),
  // 特別な日
  b("special", "newyear", "賀", "初さんぽ", "1月1日に散歩する", 1, (s) => s.days.has("0101") ? 1 : 0),
  b("special", "setsubun", "福", "節分さんぽ", "2月3日に散歩する", 1, (s) => s.days.has("0203") ? 1 : 0),
  b("special", "tanabata", "笹", "七夕さんぽ", "7月7日に散歩する", 1, (s) => s.days.has("0707") ? 1 : 0),
  b("special", "xmas", "聖", "クリスマスさんぽ", "12月24日か25日に散歩する", 1, (s) => s.days.has("1224") || s.days.has("1225") ? 1 : 0),
  b("special", "omisoka", "除", "年越しさんぽ", "12月31日に散歩する", 1, (s) => s.days.has("1231") ? 1 : 0),
  // ひみつ（取るまで条件は内緒）
  b("secret", "zorome", "双", "ぞろ目の距離", "歩いた距離が1.11km・2.22kmのようなぞろ目になる", 1, (s) => s.zorome, true),
  b("secret", "clock", "時", "ぞろ目の時刻", "11時11分のような、ぞろ目の時刻に出発する", 1, (s) => s.clockZorome, true),
  b("secret", "fri13", "凶", "13日の金曜日", "13日の金曜日に散歩する", 1, (s) => s.fri13, true),
  b("secret", "short", "近", "ちょっとそこまで", "1km未満の散歩を終える", 1, (s) => s.shorts, true),
  b("secret", "noskip", "黙", "もくもく散歩", "お題を1つも開かずに散歩を終える", 1, (s) => s.silents, true),
];

const pad = (n) => String(n).padStart(2, "0");
const dayNo = (d) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
// いちばん長く続いた連続の長さ（日・週の番号の並びから）
function longestRun(nums) {
  const xs = [...new Set(nums)].sort((a, b) => a - b);
  let best = 0, run = 0;
  xs.forEach((x, i) => { run = i && x === xs[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); });
  return best;
}

function badgeStats(walks) {
  const list = walks.filter((w) => !w.sim && w.results).sort((a, b) => a.startedAt - b.startedAt);
  const s = {
    walks: list.length, km: 0, maxKm: 0, totalMin: 0, maxMin: 0, pts: 0, maxDone: 0, looks: 0, talks: 0, photoMissions: 0, cats: {}, fulls: 0, photos: 0, memos: 0,
    stopType: {}, detours: 0, dests: 0, oneways: 0, splits: 0, mornings: 0, dawns: 0, nights: 0, lates: 0, weekends: 0,
    weather: {}, days: new Set(), zorome: 0, clockZorome: 0, fri13: 0, shorts: 0, silents: 0,
  };
  const stops = new Set(), seasons = new Set(), months = new Set(), themes = new Set(), perMonth = {}, perDay = {};
  for (const w of list) {
    const k = w.distance / 1000;
    s.km += k; s.maxKm = Math.max(s.maxKm, k);
    s.totalMin += w.minutes || 0; s.maxMin = Math.max(s.maxMin, w.minutes || 0);
    s.photos += w.photos || 0;
    if (w.stopName) stops.add(w.stopName);
    if (w.stopType) s.stopType[w.stopType] = (s.stopType[w.stopType] || 0) + 1;
    s.detours += w.detours || 0;
    if (w.dest) { s.dests++; if (w.dest.back === "oneway") s.oneways++; }
    if (w.split) s.splits++;
    if (w.theme) themes.add(w.theme);
    if (w.weather) {
      if (w.weather.kind) s.weather[w.weather.kind] = (s.weather[w.weather.kind] || 0) + 1;
      if (w.weather.label === "晴れ") s.weather.sunny = (s.weather.sunny || 0) + 1;
    }
    const d = new Date(w.startedAt), h = d.getHours();
    seasons.add(seasonKey(d.getMonth() + 1));
    months.add(d.getMonth());
    s.days.add(pad(d.getMonth() + 1) + pad(d.getDate()));
    const mk = `${d.getFullYear()}-${d.getMonth()}`, dk = dayNo(d);
    perMonth[mk] = (perMonth[mk] || 0) + 1; perDay[dk] = (perDay[dk] || 0) + 1;
    if (h < 8 && h >= 4) s.mornings++;
    if (h < 6 && h >= 3) s.dawns++;
    if (h >= 21 || h < 3) s.lates++;
    if (d.getDay() === 0 || d.getDay() === 6) s.weekends++;
    if (w.night) s.nights++;
    if (d.getDate() === 13 && d.getDay() === 5) s.fri13++;
    if (h === d.getMinutes() && h >= 1) s.clockZorome++;
    const k2 = Math.round(k * 100);
    if (k2 >= 111 && k2 % 111 === 0 && k2 <= 999) s.zorome++;
    if (w.distance < 1000 && w.distance > 100) s.shorts++;
    const done = w.results.filter((r) => r.outcome === "done");
    done.forEach((r) => {
      if (r.kind === "look") s.looks++;
      if (r.kind === "photo") s.photoMissions++;
      if (r.kind === "talk") { s.talks++; s.cats[r.cat] = (s.cats[r.cat] || 0) + 1; }
      if (r.memo) s.memos++;
    });
    s.pts += done.length;
    s.maxDone = Math.max(s.maxDone, done.length);
    if (w.results.length >= 3 && done.length === w.results.length) s.fulls++;
    if (w.results.length >= 3 && !done.length && w.distance >= 1000) s.silents++;
  }
  s.stops = stops.size;
  s.stopKinds = Object.keys(s.stopType).length;
  s.seasons = seasons.size;
  s.months = months.size;
  s.themes = themes.size;
  s.maxInMonth = Math.max(0, ...Object.values(perMonth));
  s.maxInDay = Math.max(0, ...Object.values(perDay));
  const dayNums = Object.keys(perDay).map(Number);
  s.streakDays = longestRun(dayNums);
  // 週は月曜はじまり（1970/1/1は木曜なので、3日ずらす）
  const bt = typeof bingoTotals === "function" ? bingoTotals() : { lines: 0, fulls: 0 };
  s.bingoLines = bt.lines; s.bingoFulls = bt.fulls;
  try {
    const z = JSON.parse(localStorage.getItem("fs:zukan")) || [];
    s.zukan = z.length; s.zukanCat = {};
    z.forEach((x) => (s.zukanCat[x.cat] = (s.zukanCat[x.cat] || 0) + 1));
    s.goshiki = typeof GOSHIKI !== "undefined" ? GOSHIKI.filter((c) => z.some((x) => x.cat === "fudo" && c.re.test(x.name))).length : 0;
  } catch { s.zukan = 0; s.zukanCat = {}; s.goshiki = 0; }
  try { s.kotoba = (JSON.parse(localStorage.getItem("fs:kotobaDone")) || []).length; } catch { s.kotoba = 0; }
  s.streakWeeks = longestRun(dayNums.map((n) => Math.floor((n + 3) / 7)));
  return s;
}

function titleFor(pts) {
  let i = 0;
  while (i + 1 < TITLES.length && pts >= TITLES[i + 1].pts) i++;
  return { ...TITLES[i], next: TITLES[i + 1] || null };
}

function earnedBadges(stats) {
  return BADGES.filter((x) => x.get(stats) >= x.need).map((x) => x.id);
}

// ---------- 通算距離のたとえ ----------
// 長さのたとえ（km）。合計がどれくらいかを、身近なものや遠い場所で表す
const LANDMARKS = [
  { km: 0.634, name: "東京スカイツリーの高さ", unit: "本分" },
  { km: 3.776, name: "富士山の高さ", unit: "個分" },
  { km: 34.5, name: "山手線一周", unit: "周分" },
  { km: 42.195, name: "フルマラソン", unit: "回分" },
  { km: 492, name: "東海道五十三次（日本橋〜京都）", unit: "回分" },
  { km: 3000, name: "日本列島（北海道〜沖縄）", unit: "回分" },
  { km: 40075, name: "地球一周", unit: "周分" },
  { km: 384400, name: "月まで", unit: "回分" },
];
// 小さなたとえ。1つ分の長さ（m）と、数え方
const SMALL_THINGS = [
  { m: 0.1, name: "ハンバーガー（直径10cm）を並べると", unit: "個分" },
  { m: 0.2, name: "スマホを縦に並べると", unit: "台分" },
  { m: 25, name: "25mプール", unit: "往復分", per: 50 },
  { m: 333, name: "東京タワーの高さ", unit: "本分" },
  { m: 400, name: "16両の新幹線", unit: "編成分" },
];
// 動物が動く距離（よく言われる目安）。「○○の△日分」のように表す
const ANIMALS = [
  { km: 0.04, name: "ナマケモノが1日に動く距離", span: "日分" },
  { km: 0.09, name: "カタツムリが1日に進む距離", span: "日分" },
  { km: 5, name: "ハムスターが一晩で走る距離", span: "晩分" },
  { km: 15, name: "ゾウが1日に歩く距離", span: "日分" },
  { km: 40, name: "ラクダが1日に歩く距離", span: "日分" },
  { km: 100, name: "マグロが1日に泳ぐ距離", span: "日分" },
  { km: 70000, name: "キョクアジサシが1年で渡る距離", span: "年分" },
];
// 合計の距離に合う動物を2つ選ぶ：ちょうど超えたくらいの動物と、うんと小さい動物
function animalFacts(totalKm) {
  const fit = ANIMALS.filter((a) => totalKm >= a.km).pop() || ANIMALS[2];
  const small = ANIMALS.find((a) => a !== fit && totalKm / a.km >= 10) || ANIMALS[0];
  return [fit, small].filter((a, i, xs) => xs.indexOf(a) === i).map((a) => `${a.name}の${fmtCount(totalKm / a.km)}${a.span}`);
}
// 1kmあたりの目安（体重60kgで歩いたとき約50kcal、歩幅70cmで約1400歩）
const KCAL_PER_KM = 50, STEPS_PER_KM = 1400;
const FOODS = [
  { kcal: 256, name: "ハンバーガー" },
  { kcal: 180, name: "おにぎり" },
  { kcal: 220, name: "たい焼き" },
  { kcal: 140, name: "缶ビール（350ml）" },
];

const fmtCount = (n) => n >= 100 ? Math.round(n).toLocaleString("ja-JP") : n >= 10 ? n.toFixed(1).replace(/\.0$/, "") : n.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
// 通算の距離を、たとえで表す。届いた中でいちばん大きいもの・次の目標・月まで、と食べもの
function distanceFacts(totalKm) {
  const reached = LANDMARKS.filter((l) => totalKm >= l.km).pop();
  const next = LANDMARKS.find((l) => totalKm < l.km);
  const moon = LANDMARKS[LANDMARKS.length - 1];
  const facts = [];
  if (reached) facts.push({ text: `${reached.name}の${fmtCount(totalKm / reached.km)}${reached.unit}` });
  if (next && next !== moon) facts.push({ text: `次は「${next.name}」（${next.km.toLocaleString("ja-JP")}km）。あと${fmtCount(next.km - totalKm)}km`, progress: totalKm / next.km });
  const pct = (totalKm / moon.km) * 100;
  facts.push({ text: `月まで（38万4400km）の${pct < 0.01 ? pct.toFixed(4) : pct.toFixed(2)}%`, progress: totalKm / moon.km });
  animalFacts(totalKm).forEach((text) => facts.push({ text }));
  facts.push({ text: `ハンバーガー（直径10cm）を並べると${Math.round(totalKm * 10000).toLocaleString("ja-JP")}個分` });
  const kcal = totalKm * KCAL_PER_KM;
  facts.push({ text: `ひとりあたり約${Math.round(kcal).toLocaleString("ja-JP")}kcal。ハンバーガー約${fmtCount(kcal / FOODS[0].kcal)}個分を燃やしました` });
  facts.push({ text: `歩数にすると、ひとり約${Math.round(totalKm * STEPS_PER_KM).toLocaleString("ja-JP")}歩` });
  return facts;
}
// 1回の散歩の距離を、ひとことで（seedで毎回ちがうたとえにする）
function walkFact(meters, seed) {
  if (meters < 100) return "";
  const r = Math.abs(seed || 0);
  const pool = [...SMALL_THINGS, { kcal: true }, ...ANIMALS.filter((a) => a.km * 1000 <= meters).map((a) => ({ animal: a }))];
  const t = pool[r % pool.length];
  if (t.animal) return `今日の道のりは、${t.animal.name}の${fmtCount(meters / 1000 / t.animal.km)}${t.animal.span}`;
  if (t.kcal) {
    const f = FOODS[Math.floor(r / pool.length) % FOODS.length], kcal = (meters / 1000) * KCAL_PER_KM;
    return `今日はひとり約${Math.round(kcal)}kcal。${f.name}${fmtCount(kcal / f.kcal)}個分です`;
  }
  return `今日の道のりは、${t.name}${t.name.endsWith("と") ? "" : "の"}${fmtCount(meters / (t.per || t.m))}${t.unit}`;
}
