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
];

// mark はハンコ風に丸で囲んで表示する1文字
const BADGES = [
  { id: "first", mark: "初", name: "はじめの一歩", desc: "1回散歩する", need: 1, get: (s) => s.walks },
  { id: "walk5", mark: "五", name: "散歩なかま", desc: "5回散歩する", need: 5, get: (s) => s.walks },
  { id: "walk20", mark: "達", name: "散歩が日課", desc: "20回散歩する", need: 20, get: (s) => s.walks },
  { id: "km10", mark: "十", name: "10km達成", desc: "合計10km歩く", need: 10, get: (s) => Math.floor(s.km) },
  { id: "km50", mark: "遠", name: "50km達成", desc: "合計50km歩く", need: 50, get: (s) => Math.floor(s.km) },
  { id: "long", mark: "長", name: "ロングウォーク", desc: "1回で6km以上歩く", need: 1, get: (s) => s.longs },
  { id: "look10", mark: "視", name: "観察ビギナー", desc: "観察のお題を10回クリア", need: 10, get: (s) => s.looks },
  { id: "look50", mark: "眼", name: "観察の名人", desc: "観察のお題を50回クリア", need: 50, get: (s) => s.looks },
  { id: "talk10", mark: "話", name: "語り合い", desc: "会話のタネで10回話す", need: 10, get: (s) => s.talks },
  { id: "talk30", mark: "語", name: "夜通し語れる", desc: "会話のタネで30回話す", need: 30, get: (s) => s.talks },
  { id: "philo", mark: "哲", name: "散歩の哲学", desc: "「ちょっと哲学」で5回話す", need: 5, get: (s) => s.cats.philo || 0 },
  { id: "past", mark: "昔", name: "思い出係", desc: "「むかし話」で5回話す", need: 5, get: (s) => s.cats.past || 0 },
  { id: "us", mark: "心", name: "ふたりの理解者", desc: "「ふたりのこと」で5回話す", need: 5, get: (s) => s.cats.us || 0 },
  { id: "full", mark: "皆", name: "皆勤", desc: "1回の散歩で、届いたお題を1つも飛ばさない", need: 1, get: (s) => s.fulls },
  { id: "photo10", mark: "写", name: "撮影係", desc: "写真を合計10枚撮る", need: 10, get: (s) => s.photos },
  { id: "photo50", mark: "匠", name: "散歩カメラマン", desc: "写真を合計50枚撮る", need: 50, get: (s) => s.photos },
  { id: "stop3", mark: "巡", name: "寄り道めぐり", desc: "3か所の違う寄り道先に行く", need: 3, get: (s) => s.stops },
  { id: "stop10", mark: "旅", name: "町の案内人", desc: "10か所の違う寄り道先に行く", need: 10, get: (s) => s.stops },
  { id: "morning", mark: "朝", name: "朝さんぽ", desc: "朝8時より前に出発する", need: 1, get: (s) => s.mornings },
  { id: "night", mark: "夜", name: "夜さんぽ", desc: "日が暮れてから散歩する", need: 1, get: (s) => s.nights },
  { id: "seasons", mark: "季", name: "四季の散歩", desc: "春・夏・秋・冬それぞれに散歩する", need: 4, get: (s) => s.seasons },
];

function badgeStats(walks) {
  const list = walks.filter((w) => !w.sim && w.results).sort((a, b) => a.startedAt - b.startedAt);
  const s = { walks: list.length, km: 0, pts: 0, looks: 0, talks: 0, cats: {}, fulls: 0, longs: 0, photos: 0, mornings: 0, nights: 0 };
  const stops = new Set(), seasons = new Set();
  for (const w of list) {
    s.km += w.distance / 1000;
    s.photos += w.photos || 0;
    if (w.distance >= 6000) s.longs++;
    if (w.stopName) stops.add(w.stopName);
    const d = new Date(w.startedAt), h = d.getHours();
    seasons.add(seasonKey(d.getMonth() + 1));
    if (h < 8 && h >= 4) s.mornings++;
    if (w.night) s.nights++;
    const done = w.results.filter((r) => r.outcome === "done");
    done.forEach((r) => {
      if (r.kind === "look") s.looks++;
      if (r.kind === "talk") { s.talks++; s.cats[r.cat] = (s.cats[r.cat] || 0) + 1; }
    });
    s.pts += done.length;
    if (w.results.length >= 3 && done.length === w.results.length) s.fulls++;
  }
  s.stops = stops.size;
  s.seasons = seasons.size;
  return s;
}

function titleFor(pts) {
  let i = 0;
  while (i + 1 < TITLES.length && pts >= TITLES[i + 1].pts) i++;
  return { ...TITLES[i], next: TITLES[i + 1] || null };
}

function earnedBadges(stats) {
  return BADGES.filter((b) => b.get(stats) >= b.need).map((b) => b.id);
}
