// 称号とバッジ。試しモードの散歩は数えない

// 獲得ポイントの合計で上がっていく称号
const TITLES = [
  { pts: 0, name: "散歩見習い" },
  { pts: 10, name: "町歩きビギナー" },
  { pts: 30, name: "路地裏探検家" },
  { pts: 60, name: "寄り道の達人" },
  { pts: 100, name: "散歩マスター" },
  { pts: 160, name: "町のぬし" },
  { pts: 250, name: "伝説の散歩人" },
];

// mark はハンコ風に丸で囲んで表示する1文字
const BADGES = [
  { id: "first", mark: "初", name: "はじめの一歩", desc: "1回散歩する", need: 1, get: (s) => s.walks },
  { id: "walk5", mark: "五", name: "散歩なかま", desc: "5回散歩する", need: 5, get: (s) => s.walks },
  { id: "walk20", mark: "達", name: "散歩が日課", desc: "20回散歩する", need: 20, get: (s) => s.walks },
  { id: "km10", mark: "十", name: "10km達成", desc: "合計10km歩く", need: 10, get: (s) => Math.floor(s.km) },
  { id: "km50", mark: "遠", name: "50km達成", desc: "合計50km歩く", need: 50, get: (s) => Math.floor(s.km) },
  { id: "win1", mark: "勝", name: "初勝利", desc: "勝負に1回勝ち越す", need: 1, get: (s) => s.wins },
  { id: "win5", mark: "強", name: "勝負師", desc: "5回勝ち越す", need: 5, get: (s) => s.wins },
  { id: "streak3", mark: "連", name: "3連勝", desc: "3回続けて勝ち越す", need: 3, get: (s) => s.bestStreak },
  { id: "perfect", mark: "完", name: "完封", desc: "相手を0点におさえて3点以上で勝つ", need: 1, get: (s) => s.perfects },
  { id: "comeback", mark: "逆", name: "大逆転", desc: "負けている状態から最後に逆転する", need: 1, get: (s) => s.comebacks },
  { id: "draw", mark: "和", name: "仲良し引き分け", desc: "同点で散歩を終える", need: 1, get: (s) => s.draws },
  { id: "rare1", mark: "稀", name: "レアハンター", desc: "レアお題で勝つ", need: 1, get: (s) => s.rareWins },
  { id: "rare3", mark: "宝", name: "幸運の持ち主", desc: "レアお題で3回勝つ", need: 3, get: (s) => s.rareWins },
  { id: "allmode", mark: "全", name: "オールラウンダー", desc: "早い者勝ち・撮影・予想・相手当て・ミニゲームで1回ずつ勝つ", need: 5, get: (s) => s.modesWon },
  { id: "coop5", mark: "仲", name: "息ぴったり", desc: "「ふたりで」のお題を5回クリア", need: 5, get: (s) => s.coops },
  { id: "photo10", mark: "写", name: "撮影係", desc: "写真を合計10枚撮る", need: 10, get: (s) => s.photos },
  { id: "photo50", mark: "匠", name: "散歩カメラマン", desc: "写真を合計50枚撮る", need: 50, get: (s) => s.photos },
  { id: "stop3", mark: "巡", name: "寄り道めぐり", desc: "3か所の違う寄り道先に行く", need: 3, get: (s) => s.stops },
  { id: "stop10", mark: "旅", name: "町の案内人", desc: "10か所の違う寄り道先に行く", need: 10, get: (s) => s.stops },
  { id: "morning", mark: "朝", name: "朝さんぽ", desc: "朝8時より前に出発する", need: 1, get: (s) => s.mornings },
  { id: "night", mark: "夜", name: "夜さんぽ", desc: "日が暮れてから散歩する", need: 1, get: (s) => s.nights },
];

const BATTLE_MODES = ["race", "photo", "guess", "quiz", "game"];

function badgeStats(walks) {
  const list = walks.filter((w) => !w.sim && w.me != null).sort((a, b) => a.startedAt - b.startedAt);
  const s = { walks: list.length, km: 0, pts: 0, wins: 0, draws: 0, streak: 0, bestStreak: 0, perfects: 0, comebacks: 0, rareWins: 0, coops: 0, photos: 0, mornings: 0, nights: 0 };
  const modes = new Set(), stops = new Set();
  for (const w of list) {
    s.km += w.distance / 1000;
    s.pts += w.me;
    s.photos += w.photos || 0;
    if (w.stopName) stops.add(w.stopName);
    const h = new Date(w.startedAt).getHours();
    if (h < 8 && h >= 4) s.mornings++;
    if (w.night) s.nights++;
    if (w.me > w.you) { s.wins++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak); } else s.streak = 0;
    if (w.me === w.you && w.me > 0) s.draws++;
    if (w.me >= 3 && w.you === 0) s.perfects++;
    // 途中で負けていて、最後に勝ち越したら逆転
    let me = 0, you = 0, behind = false;
    for (const r of w.results || []) {
      if (r.outcome === "me") { me += r.pts; if (r.pts === 3) s.rareWins++; if (BATTLE_MODES.includes(r.mode)) modes.add(r.mode); }
      if (r.outcome === "you") you += r.pts;
      if (r.outcome === "done") s.coops++;
      if (you > me) behind = true;
    }
    if (behind && w.me > w.you) s.comebacks++;
  }
  s.modesWon = modes.size;
  s.stops = stops.size;
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
