// ふたりのアルバムのサーバー処理（API Gateway → Lambda）
// ログイン済みの人（CognitoのID）だけが呼べる。自分が入っているアルバムの記録と写真にしか触れない。
//
// 表（DynamoDB）の中身
//   USER#{id}   / PROFILE            名前と、入っているアルバム
//   PAIR#{pair} / META               メンバー（最大2人）と招待コード
//   INVITE#{code} / INVITE           招待コード → アルバム（48時間で自動削除）
//   PAIR#{pair} / WALK#{id}#{walk}   散歩の記録
//   PAIR#{pair} / PHOTO#{walk}#{id}#{at}  写真の情報（本体はS3）
//   PAIR#{pair} / DIARY#{key}        AI散歩日記（key は二人の散歩で共通のルート番号）
//   PAIR#{pair} / LETTER#{to}#{at}   相手への手紙（相手の次の散歩で開く）
//   PAIR#{pair} / AIM#{key}          AIのお題（二人で同じものを使う。2日で自動削除）
//   USER#{id}   / PUSH#{hash}        通知の送り先（ブラウザごと）
//   USER#{id}   / LOC                別行動中の現在地（2時間で自動削除）
//   USER#{id}   / PROFILE の fineDay  散歩日和の知らせ（スタート地点を約1kmに丸めた位置と、土日だけか毎日か）
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import crypto from "node:crypto";

const TABLE = process.env.TABLE, BUCKET = process.env.BUCKET, REGION = process.env.AWS_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const INVITE_HOURS = 48;
const bedrock = new BedrockRuntimeClient({}), s3 = new S3Client({}), ses = new SESv2Client({});
const SITE = process.env.SITE_URL;

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

export const handler = async (event) => {
  // ブラウザの事前確認には、中身なしで答える（許可のヘッダーは API Gateway が付ける）
  if (event.requestContext?.http?.method === "OPTIONS") return { statusCode: 204, body: "" };
  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const sub = claims.sub;
  if (!sub) return json(401, { error: "ログインしてください" });
  const method = event.requestContext.http.method, path = event.rawPath;
  let body = {};
  try { body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : {}; }
  catch { return json(400, { error: "送られてきたデータが読めません" }); }
  try {
    if (method === "GET" && path === "/me") { await rememberEmail(sub, claims.email); return json(200, await me(sub)); }
    if (method === "POST" && path === "/profile") return json(200, await setProfile(sub, body));
    if (method === "POST" && path === "/pair") return json(200, await createPair(sub));
    if (method === "POST" && path === "/pair/invite") return json(200, await newInvite(sub));
    if (method === "POST" && path === "/pair/join") return json(200, await joinPair(sub, body.code));
    if (method === "GET" && path === "/walks") return json(200, await listWalks(sub));
    if (method === "PUT" && path.startsWith("/walks/")) return json(200, await saveWalk(sub, decodeURIComponent(path.slice(7)), body));
    if (method === "POST" && path === "/photos") return json(200, await newPhoto(sub, body));
    if (method === "POST" && path === "/fineday") return json(200, await setFineDay(sub, body));
    if (method === "POST" && path === "/push/subscribe") return json(200, await subscribePush(sub, body));
    if (method === "POST" && path === "/events") return json(200, await walkEvent(sub, body));
    if (method === "POST" && path === "/letters") return json(200, await writeLetter(sub, body));
    if (method === "GET" && path === "/letters") return json(200, await openLetters(sub));
    if (method === "POST" && path === "/location") return json(200, await saveLocation(sub, body));
    if (method === "GET" && path === "/location") return json(200, await partnerLocation(sub));
    if (method === "POST" && path === "/diary") return json(200, await writeDiary(sub, body));
    if (method === "POST" && path === "/missions") return json(200, await aiMissions(sub, body));
    return json(404, { error: "not found" });
  } catch (e) {
    if (!e.expose) console.error(e);
    return json(e.status || 500, { error: e.expose ? e.message : "サーバーでエラーが起きました。少し待ってからもう一度お試しください" });
  }
};

// ---------- 自分とアルバム ----------
async function getItem(pk, sk) { return (await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item || null; }
const profile = (sub) => getItem(`USER#${sub}`, "PROFILE");
async function pairOf(sub) {
  const p = await profile(sub);
  if (!p?.pairId) throw fail(409, "まだふたりのアルバムに参加していません");
  return p.pairId;
}
async function me(sub) {
  const p = await profile(sub);
  let pair = null;
  if (p?.pairId) {
    const meta = await getItem(`PAIR#${p.pairId}`, "META");
    const members = await Promise.all((meta?.members || []).map(async (id) => ({ id, me: id === sub, name: (await profile(id))?.name || "" })));
    const inviteOk = meta?.invite && meta.inviteExp > Date.now() && members.length < 2;
    pair = { id: p.pairId, members, invite: inviteOk ? meta.invite : null, inviteExp: inviteOk ? meta.inviteExp : null };
  }
  return { id: sub, name: p?.name || "", pair };
}
async function setProfile(sub, { name }) {
  name = String(name || "").trim().slice(0, 20);
  if (!name) throw fail(400, "名前を入れてください");
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "SET #n = :n", ExpressionAttributeNames: { "#n": "name" }, ExpressionAttributeValues: { ":n": name } }));
  return me(sub);
}

// 読み間違えやすい文字（0とO、1とIなど）を使わない8文字の招待コード
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

async function createPair(sub) {
  const p = await profile(sub);
  if (p?.pairId) throw fail(409, "すでにふたりのアルバムに参加しています");
  const pairId = crypto.randomUUID(), invite = makeCode(), exp = Date.now() + INVITE_HOURS * 3600e3;
  await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: TABLE, Item: { pk: `PAIR#${pairId}`, sk: "META", members: [sub], invite, inviteExp: exp, createdAt: Date.now() } } },
    { Put: { TableName: TABLE, Item: { pk: `INVITE#${invite}`, sk: "INVITE", pairId, exp, ttl: Math.floor(exp / 1000) } } },
    { Update: { TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "SET pairId = :p", ConditionExpression: "attribute_not_exists(pairId)", ExpressionAttributeValues: { ":p": pairId } } },
  ] }));
  return me(sub);
}
async function newInvite(sub) {
  const pairId = await pairOf(sub);
  const meta = await getItem(`PAIR#${pairId}`, "META");
  if (meta.members.length >= 2) throw fail(409, "もう二人そろっています");
  const invite = makeCode(), exp = Date.now() + INVITE_HOURS * 3600e3;
  await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: TABLE, Key: { pk: `PAIR#${pairId}`, sk: "META" }, UpdateExpression: "SET invite = :i, inviteExp = :e", ExpressionAttributeValues: { ":i": invite, ":e": exp } } },
    { Put: { TableName: TABLE, Item: { pk: `INVITE#${invite}`, sk: "INVITE", pairId, exp, ttl: Math.floor(exp / 1000) } } },
  ] }));
  return me(sub);
}
async function joinPair(sub, raw) {
  const code = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const inv = code && await getItem(`INVITE#${code}`, "INVITE");
  if (!inv || inv.exp < Date.now()) throw fail(404, "招待コードが見つからないか、期限が切れています");
  const p = await profile(sub);
  if (p?.pairId === inv.pairId) return me(sub);
  if (p?.pairId) throw fail(409, "すでに別のアルバムに参加しています");
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: TABLE, Key: { pk: `PAIR#${inv.pairId}`, sk: "META" }, UpdateExpression: "SET members = list_append(members, :m) REMOVE invite, inviteExp", ConditionExpression: "size(members) < :two", ExpressionAttributeValues: { ":m": [sub], ":two": 2 } } },
      { Update: { TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "SET pairId = :p", ConditionExpression: "attribute_not_exists(pairId)", ExpressionAttributeValues: { ":p": inv.pairId } } },
      { Delete: { TableName: TABLE, Key: { pk: `INVITE#${code}`, sk: "INVITE" } } },
    ] }));
  } catch (e) {
    if (e.name === "TransactionCanceledException") throw fail(409, "このアルバムはもう二人そろっています");
    throw e;
  }
  return me(sub);
}

// ---------- 散歩の記録と写真 ----------
const WALK_ID = /^w\d{10,16}$/;
async function listWalks(sub) {
  const pairId = await pairOf(sub);
  const items = [];
  let key;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": `PAIR#${pairId}` }, ExclusiveStartKey: key }));
    items.push(...r.Items);
    key = r.LastEvaluatedKey;
  } while (key);
  const walks = items.filter((i) => i.sk.startsWith("WALK#")).map((i) => ({ ...i.data, owner: i.owner }));
  const diaries = items.filter((i) => i.sk.startsWith("DIARY#")).map((i) => ({ key: i.sk.slice(6), text: i.text, at: i.createdAt }));
  // 写真は1時間だけ見られるURLを付けて返す
  const photos = items.filter((i) => i.sk.startsWith("PHOTO#")).map((i) => ({
    id: i.sk.slice(6), walkId: i.walkId, owner: i.owner, mission: i.mission, pos: i.pos, at: i.at, url: presign("GET", i.key, 3600),
  }));
  return { walks, photos, diaries };
}
async function saveWalk(sub, id, data) {
  const pairId = await pairOf(sub);
  if (!WALK_ID.test(id)) throw fail(400, "散歩の記録の番号が正しくありません");
  if (JSON.stringify(data).length > 350000) throw fail(413, "散歩の記録が大きすぎます");
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `PAIR#${pairId}`, sk: `WALK#${sub}#${id}`, owner: sub, data: { ...data, id }, updatedAt: Date.now() } }));
  return { ok: true };
}
// 写真の情報を記録し、アップロード用のURL（15分有効）を返す
async function newPhoto(sub, b) {
  const pairId = await pairOf(sub);
  const walkId = String(b.walkId || ""), at = Math.floor(Number(b.at));
  if (!WALK_ID.test(walkId) || !at) throw fail(400, "写真の情報が正しくありません");
  const id = `${walkId}#${sub}#${at}`, key = `pairs/${pairId}/${walkId}/${sub}-${at}.jpg`;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: {
    pk: `PAIR#${pairId}`, sk: `PHOTO#${id}`, walkId, owner: sub, key, at,
    mission: b.mission ? String(b.mission).slice(0, 300) : null,
    pos: Array.isArray(b.pos) ? b.pos.slice(0, 2).map(Number) : null,
  } }));
  notifyPartner(sub, pairId, "photo", (name) => ({ title: "ふたり散歩", body: `${name}が写真を追加しました${b.mission ? `：「${String(b.mission).slice(0, 40)}」` : ""}` })).catch(() => {});
  return { id, uploadUrl: presign("PUT", key, 900) };
}

// ---------- S3の期限付きURL（署名バージョン4） ----------
function presign(method, key, expires) {
  const host = `${BUCKET}.s3.${REGION}.amazonaws.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), date = amzDate.slice(0, 8);
  const scope = `${date}/${REGION}/s3/aws4_request`;
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const q = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${process.env.AWS_ACCESS_KEY_ID}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  if (process.env.AWS_SESSION_TOKEN) q["X-Amz-Security-Token"] = process.env.AWS_SESSION_TOKEN;
  const path = "/" + key.split("/").map(enc).join("/");
  const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonical = [method, path, qs, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const kSign = hmac(hmac(hmac(hmac("AWS4" + process.env.AWS_SECRET_ACCESS_KEY, date), REGION), "s3"), "aws4_request");
  return `https://${host}${path}?${qs}&X-Amz-Signature=${crypto.createHmac("sha256", kSign).update(toSign).digest("hex")}`;
}


// ---------- 名前・相手 ----------
async function rememberEmail(sub, email) {
  if (!email) return;
  const p = await profile(sub);
  if (p?.email === email) return;
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "SET email = :e", ExpressionAttributeValues: { ":e": email } }));
}
async function partnerOf(sub, pairId) {
  const meta = await getItem(`PAIR#${pairId}`, "META");
  return (meta?.members || []).find((m) => m !== sub) || null;
}

// ---------- プッシュ通知（Web Push：VAPID ＋ aes128gcm） ----------
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));
let vapidKey;

async function subscribePush(sub, b) {
  let url;
  try { url = new URL(String(b.endpoint || "")); } catch { throw fail(400, "通知の登録情報が正しくありません"); }
  if (url.protocol !== "https:" || !PUSH_HOSTS.test(url.hostname) || !b.keys?.p256dh || !b.keys?.auth) throw fail(400, "通知の登録情報が正しくありません");
  const id = crypto.createHash("sha256").update(url.href).digest("hex").slice(0, 32);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${sub}`, sk: `PUSH#${id}`, sub: { endpoint: url.href, keys: { p256dh: String(b.keys.p256dh), auth: String(b.keys.auth) } }, createdAt: Date.now() } }));
  await pushTo(sub, { title: "ふたり散歩", body: "通知をオンにしました" });
  return { ok: true };
}
async function pushTo(userId, payload) {
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": `USER#${userId}`, ":s": "PUSH#" } }));
  await Promise.all((r.Items || []).map(async (item) => {
    try {
      const status = await sendPush(item.sub, JSON.stringify(payload));
      // 端末側で通知をやめた・アプリを消した場合は、送り先から外す
      if (status === 404 || status === 410) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: item.pk, sk: item.sk } }));
    } catch (e) { console.error("push", e.message); }
  }));
}
async function sendPush(target, text) {
  vapidKey ??= crypto.createPrivateKey({ key: Buffer.from(process.env.VAPID_PRIVATE, "base64"), format: "der", type: "sec1" });
  const uaPublic = fromB64u(target.keys.p256dh), auth = fromB64u(target.keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0); head.writeUInt32BE(4096, 16); head.writeUInt8(65, 20);
  const jwt = `${b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64u(JSON.stringify({ aud: new URL(target.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE }))}`;
  const sig = crypto.sign("sha256", Buffer.from(jwt), { key: vapidKey, dsaEncoding: "ieee-p1363" });
  const res = await fetch(target.endpoint, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal", Authorization: `vapid t=${jwt}.${b64u(sig)}, k=${process.env.VAPID_PUBLIC}` },
    body: Buffer.concat([head, asPublic, sealed]),
  });
  return res.status;
}
// ---------- 散歩日和の知らせ（前日20時と当日8時） ----------
// 位置は小数2けた（約1km）に丸めたものだけを預かる
async function setFineDay(sub, b) {
  if (!b.on) {
    await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "REMOVE fineDay" }));
    return { on: false };
  }
  const lat = Math.round(Number(b.lat) * 100) / 100, lon = Math.round(Number(b.lon) * 100) / 100;
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw fail(400, "位置が正しくありません");
  const fineDay = { lat, lon, days: b.days === "daily" ? "daily" : "weekend" };
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "SET fineDay = :f", ExpressionAttributeValues: { ":f": fineDay } }));
  return { on: true, ...fineDay };
}
// 日本時間の日付（YYYY-MM-DD）と曜日
function jstDay(offsetDays) {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5);
  return { ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
}
async function holidaysJp() {
  try { const r = await fetch("https://holidays-jp.github.io/api/v1/date.json", { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : {}; } catch { return {}; }
}
const WEATHER_WORD = (c) => (c <= 1 ? "晴れ" : c === 2 ? "晴れ時々くもり" : "くもり");
// 歩きやすい日か：雨や雪の予報がなく、雨の確率30%以下、最高気温12〜28℃、強い風なし
async function fineForecast(lat, lon, ymd) {
  const q = `latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&timezone=Asia%2FTokyo&start_date=${ymd}&end_date=${ymd}`;
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const d = (await r.json()).daily;
  const code = d.weather_code[0], tmax = Math.round(d.temperature_2m_max[0]), tmin = Math.round(d.temperature_2m_min[0]);
  const rain = d.precipitation_probability_max[0] ?? 0, wind = d.wind_speed_10m_max[0] ?? 0;
  const ok = code <= 3 && rain <= 30 && tmax >= 12 && tmax <= 28 && wind < 30;
  return ok ? { word: WEATHER_WORD(code), tmax, tmin, rain } : null;
}
// when: "evening"（前日の夜に、明日の予報で）／"morning"（当日の朝に、今日の予報で）
async function fineDay(when) {
  const day = jstDay(when === "evening" ? 1 : 0);
  const restDay = { 0: true, 6: true }[day.dow] || !!(await holidaysJp())[day.ymd];
  const people = [];
  let start;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: "sk = :p AND attribute_exists(fineDay)", ExpressionAttributeValues: { ":p": "PROFILE" }, ExclusiveStartKey: start }));
    people.push(...(r.Items || []));
    start = r.LastEvaluatedKey;
  } while (start);
  const cache = {};
  let sent = 0;
  for (const p of people) {
    try {
      const f = p.fineDay;
      if (f.days !== "daily" && !restDay) continue;
      const key = `${f.lat},${f.lon}`;
      cache[key] ??= await fineForecast(f.lat, f.lon, day.ymd);
      const fc = cache[key];
      if (!fc) continue;
      const detail = `${fc.word}・最高${fc.tmax}℃・雨の確率${fc.rain}%`;
      await pushTo(p.pk.slice(5), when === "evening"
        ? { title: "明日は散歩日和になりそう", body: `${detail}。ふたりで歩く予定を立ててみませんか？`, tag: "fineday" }
        : { title: "今日は散歩日和です", body: `${detail}。少しだけでも歩きませんか？`, tag: "fineday" });
      sent++;
    } catch (e) { console.error("fineday", p.pk, e.message); }
  }
  return { people: people.length, sent };
}

// 相手に知らせる。kind ごとに間隔をあける（写真は10分に1回まで）
async function notifyPartner(sub, pairId, kind, make) {
  const partner = await partnerOf(sub, pairId);
  if (!partner) return;
  if (kind === "photo") {
    try {
      await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${sub}`, sk: "PROFILE" }, UpdateExpression: "SET lastPhotoPush = :n", ConditionExpression: "attribute_not_exists(lastPhotoPush) OR lastPhotoPush < :t", ExpressionAttributeValues: { ":n": Date.now(), ":t": Date.now() - 10 * 60000 } }));
    } catch { return; }
  }
  const name = (await profile(sub))?.name || "あいて";
  await pushTo(partner, make(name));
}
async function walkEvent(sub, b) {
  const pairId = await pairOf(sub);
  if (b.type === "met") await notifyPartner(sub, pairId, "met", (name) => ({ title: "合流", body: `${name}が合流場所${b.place ? `「${String(b.place).slice(0, 40)}」` : ""}に着きました` }));
  if (b.type === "branch") await notifyPartner(sub, pairId, "branch", (name) => ({ title: "別行動", body: `${name}が${b.color === "黒" ? "黒" : "青"}の道を選びました` }));
  return { ok: true };
}

// ---------- 相手への手紙 ----------
async function writeLetter(sub, b) {
  const pairId = await pairOf(sub);
  const text = String(b.text || "").trim().slice(0, 400);
  if (!text) throw fail(400, "手紙が空です");
  const to = await partnerOf(sub, pairId);
  if (!to) throw fail(409, "相手がまだアルバムに参加していません");
  const at = Date.now();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `PAIR#${pairId}`, sk: `LETTER#${to}#${at}`, from: sub, text, createdAt: at, opened: false } }));
  return { ok: true };
}
// まだ開いていない自分宛ての手紙を返し、開いたことにする
async function openLetters(sub) {
  const pairId = await pairOf(sub);
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": `PAIR#${pairId}`, ":s": `LETTER#${sub}#` } }));
  const fresh = (r.Items || []).filter((i) => !i.opened);
  await Promise.all(fresh.map((i) => ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk }, UpdateExpression: "SET opened = :t, openedAt = :n", ExpressionAttributeValues: { ":t": true, ":n": Date.now() } }))));
  const name = (await profile(fresh[0]?.from))?.name || "あいて";
  return { letters: fresh.map((i) => ({ from: name, text: i.text, at: i.createdAt })) };
}

// ---------- 別行動中の現在地 ----------
async function saveLocation(sub, b) {
  await pairOf(sub);
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw fail(400, "位置が正しくありません");
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${sub}`, sk: "LOC", lat, lon, eta: Number(b.eta) || null, left: Number(b.left) || null, at: Date.now(), ttl: Math.floor(Date.now() / 1000) + 2 * 3600 } }));
  return { ok: true };
}
async function partnerLocation(sub) {
  const pairId = await pairOf(sub);
  const partner = await partnerOf(sub, pairId);
  const loc = partner && await getItem(`USER#${partner}`, "LOC");
  if (!loc || Date.now() - loc.at > 15 * 60000) return { location: null };
  return { location: { lat: loc.lat, lon: loc.lon, eta: loc.eta, left: loc.left, at: loc.at, name: (await profile(partner))?.name || "あいて" } };
}

// ---------- AI散歩日記（Amazon Bedrock） ----------
const THEME_LABEL = { color: "色の日", sound: "音の日", retro: "昭和さがし", small: "小さいもの", shape: "形の日", life: "生きものの日" };
async function writeDiary(sub, b) {
  const pairId = await pairOf(sub);
  const key = String(b.key || "").slice(0, 40), ids = (Array.isArray(b.walkIds) ? b.walkIds : []).map(String).slice(0, 4);
  if (!key || !ids.length) throw fail(400, "どの散歩の日記か指定してください");
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": `PAIR#${pairId}` } }));
  const items = r.Items || [];
  const walks = items.filter((i) => i.sk.startsWith("WALK#") && ids.includes(i.data?.id));
  if (!walks.length) throw fail(404, "散歩の記録がまだサーバーにありません。少し待ってからもう一度お試しください");
  const names = {};
  for (const w of walks) names[w.owner] = (await profile(w.owner))?.name || "あいて";
  const first = walks[0].data;
  const lines = [
    `日付：${new Date(first.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })}に出発`,
    `歩いた距離：${(first.distance / 1000).toFixed(1)}km、${first.minutes}分`,
    walks.length > 1 ? `歩いた人：${Object.values(names).join("と")}（ふたりで）` : `記録した人：${names[walks[0].owner]}`,
    first.stopName ? `寄り道先：${first.stopName}` : "",
    first.split ? `途中で二手に分かれて「${first.split.meetName}」で合流した` : "",
    first.theme ? `今日のテーマ：${THEME_LABEL[first.theme] || first.theme}` : "",
    first.weather ? `天気：${first.weather.label}・${first.weather.temp}℃` : "",
    first.night ? "日が暮れてからの散歩" : "",
    "見つけたこと・話したこと（お題とメモ）：",
    ...walks.flatMap((w) => (w.data.results || []).filter((x) => x.outcome === "done").map((x) => `- ${names[w.owner]}：${x.kind === "talk" ? "話した" : "見つけた"}「${x.text}」${x.memo ? ` メモ「${x.memo}」` : ""}`)),
  ].filter(Boolean);
  // 写真は最大5枚まで、日記の手がかりとして見てもらう
  const photos = items.filter((i) => i.sk.startsWith("PHOTO#") && ids.includes(i.walkId)).sort((a, b) => a.at - b.at).slice(0, 5);
  const images = [];
  for (const p of photos) {
    try {
      const o = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: p.key }));
      const bytes = await o.Body.transformToByteArray();
      if (bytes.length > 100 && bytes.length < 3_500_000) images.push({ image: { format: "jpeg", source: { bytes } } });
    } catch {}
  }
  const res = await converse({
    system: [{ text: [
      "あなたは、夫婦の散歩の記録から、短い散歩日記を書く書き手です。",
      "書き方：やわらかい常体（〜した。〜だった。）。本文は150〜220字。見出しや箇条書きは使わず、ひとつながりの文章にする。",
      "守ること：",
      "- 記録と写真にあることだけを書く。記録にない出来事・会話・気持ち・歴史や由来の説明を足さない。",
      "- 「ふたりで歩いた」記録のときは「ふたりで」と書き、名前は記録にある呼び名を使う。一人の記録のときは、その人の目線で書く。",
      "- 距離や時間は「4.6km」「58分」のように数字で書く。",
      "- 朝・昼・夕方・夜などの時間帯は、記録の出発時刻と合うときだけ書く。迷ったら書かない。",
      "- 「〜することができた」「改めて感じられた」のような硬い言い回しや、大げさな表現は使わない。",
      "- お題の文章をそのまま書き写さず、メモの言葉を生かして書く。",
      "最後に改行して「今日のひとこと：」で始まる20字以内の一文を添える。",
    ].join("\n") }],
    messages: [{ role: "user", content: [...images, { text: `今日の散歩の記録です。写真は${images.length}枚あります。\n${lines.join("\n")}` }] }],
    inferenceConfig: { maxTokens: 700, temperature: 0.7 },
  });
  const text = res.output?.message?.content?.map((c) => c.text || "").join("").trim();
  if (!text) throw fail(502, "日記を書けませんでした。少し待ってからもう一度お試しください");
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `PAIR#${pairId}`, sk: `DIARY#${key}`, text, createdAt: Date.now(), by: sub } }));
  return { key, text };
}

// ---------- 週末のふりかえりメール（毎週日曜20時） ----------
export const weekly = async (event) => {
  // 同じ関数を、散歩日和の知らせ（前日20時・当日8時）にも使う
  if (event?.kind === "fineday") return fineDay(event.when);
  const pairs = [];
  let start;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: "sk = :m AND begins_with(pk, :p)", ExpressionAttributeValues: { ":m": "META", ":p": "PAIR#" }, ExclusiveStartKey: start }));
    pairs.push(...(r.Items || []));
    start = r.LastEvaluatedKey;
  } while (start);
  for (const pair of pairs) {
    try { await weeklyMail(pair); } catch (e) { console.error("weekly", pair.pk, e.message); }
  }
  return { pairs: pairs.length };
};
async function weeklyMail(pair) {
  const since = Date.now() - 7 * 864e5;
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pair.pk } }));
  const items = r.Items || [];
  const walks = items.filter((i) => i.sk.startsWith("WALK#") && i.data?.startedAt >= since && !i.data.sim).map((i) => ({ ...i.data, owner: i.owner }));
  if (!walks.length) return;
  const people = await Promise.all(pair.members.map(profile));
  const to = people.map((p) => p?.email).filter(Boolean);
  if (!to.length) return;
  const nameOf = (id) => people.find((p) => p?.pk === `USER#${id}`)?.name || "";
  // 二人が同じ散歩をそれぞれ記録していたら1回と数える
  const outings = [...new Map(walks.map((w) => [w.seed ?? w.id, w])).values()].sort((a, b) => a.startedAt - b.startedAt);
  const km = outings.reduce((n, w) => n + w.distance, 0) / 1000;
  const notes = walks.flatMap((w) => (w.results || []).filter((x) => x.outcome === "done").map((x) => ({ who: nameOf(w.owner), ...x })));
  const photoCount = items.filter((i) => i.sk.startsWith("PHOTO#") && i.at >= since).length;
  const diaries = Object.fromEntries(items.filter((i) => i.sk.startsWith("DIARY#")).map((i) => [i.sk.slice(6), i.text]));
  const fmt = (t) => new Date(t).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const subject = `今週のふたり散歩（${fmt(since)}〜${fmt(Date.now())}）`;
  const walkLines = outings.map((w) => `${fmt(w.startedAt)}　${(w.distance / 1000).toFixed(1)}km${w.stopName ? `　${w.stopName}に寄り道` : ""}`);
  const memoLines = notes.filter((n) => n.memo).slice(0, 6).map((n) => `${n.who}：${n.text} → ${n.memo}`);
  const diaryLines = outings.map((w) => diaries[String(w.seed ?? w.id)]).filter(Boolean).slice(0, 2);
  const text = [subject, "", `散歩 ${outings.length}回 ・ ${km.toFixed(1)}km ・ 気づき ${notes.length} ・ 写真 ${photoCount}枚`, "", ...walkLines,
    ...(memoLines.length ? ["", "今週のメモ", ...memoLines] : []), ...(diaryLines.length ? ["", "散歩日記", ...diaryLines] : []), "", `アルバムを見る：${SITE}`].join("\n");
  const html = `<div style="font-family:-apple-system,'Hiragino Sans',sans-serif;color:#111;max-width:520px;line-height:1.7">
    <p style="font-size:12px;color:#777;letter-spacing:.08em;margin:0">ふたり散歩</p>
    <h1 style="font-size:22px;margin:4px 0 12px;font-weight:600">${esc(subject)}</h1>
    <p style="border-top:1px solid #111;border-bottom:1px solid #111;padding:10px 0;font-family:Menlo,monospace;margin:0 0 14px">散歩 ${outings.length}回 ・ ${km.toFixed(1)}km ・ 気づき ${notes.length} ・ 写真 ${photoCount}枚</p>
    ${walkLines.map((l) => `<p style="margin:0;padding:6px 0;border-bottom:1px solid #ddd">${esc(l)}</p>`).join("")}
    ${memoLines.length ? `<h2 style="font-size:13px;color:#777;letter-spacing:.08em;margin:18px 0 6px">今週のメモ</h2>${memoLines.map((l) => `<p style="margin:0 0 6px">${esc(l)}</p>`).join("")}` : ""}
    ${diaryLines.length ? `<h2 style="font-size:13px;color:#777;letter-spacing:.08em;margin:18px 0 6px">散歩日記</h2>${diaryLines.map((l) => `<p style="margin:0 0 10px;white-space:pre-wrap">${esc(l)}</p>`).join("")}` : ""}
    <p style="margin-top:20px"><a href="${SITE}" style="color:#1f4fd8">アルバムを見る →</a></p></div>`;
  await ses.send(new SendEmailCommand({
    FromEmailAddress: `ふたり散歩 <${process.env.MAIL_FROM}>`,
    Destination: { ToAddresses: to },
    Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } },
  }));
}


// Bedrock（Claude）を呼ぶ。AWSで「Anthropicの利用目的」をまだ申請していないときは、わかるエラーにする
async function converse(input) {
  try {
    return await bedrock.send(new ConverseCommand({ modelId: process.env.MODEL_ID, ...input }));
  } catch (e) {
    if (/use case|not available|AccessDenied|ResourceNotFound/i.test(`${e.name} ${e.message}`)) throw fail(503, "AIの準備がまだです（AWSでClaudeの利用申請が必要です）");
    throw e;
  }
}

// ---------- AIのお題 ----------
// ルート沿いの場所・季節・天気・テーマから、その日だけのお題を4つ作る。
// 先に作った人の分を保存し、相手も同じお題を受け取る
async function aiMissions(sub, b) {
  const pairId = await pairOf(sub);
  const key = String(b.key || "").slice(0, 40);
  if (!key) throw fail(400, "どの散歩のお題か指定してください");
  const saved = await getItem(`PAIR#${pairId}`, `AIM#${key}`);
  if (saved) return { missions: saved.missions };
  const clean = (v, n) => String(v || "").replace(/[\r\n]/g, " ").slice(0, n);
  const places = (Array.isArray(b.places) ? b.places : []).slice(0, 10).map((p) => `${clean(p.name, 40)}（${clean(p.label, 12)}）`);
  const facts = [
    `季節：${clean(b.season, 6)}`, b.weather ? `天気：${clean(b.weather, 20)}` : "", b.night ? "日が暮れてからの散歩" : "",
    b.theme ? `今日のテーマ：${clean(b.theme, 12)}` : "", b.stop ? `寄り道先：${clean(b.stop, 40)}` : "", b.meet ? `二手に分かれて合流する場所：${clean(b.meet, 40)}` : "",
    places.length ? `ルート沿いにある場所：${places.join("、")}` : "",
  ].filter(Boolean);
  const res = await converse({
    system: [{ text: [
      "あなたは、夫婦の散歩アプリのお題を作る係です。お題は、ふだん見過ごしている細部に目を向けさせる「観察」が中心です。",
      "与えられた場所や季節・天気・テーマにちなんだ、その日だけのお題を4つ作る。3つは観察（look）、1つは二人で話す会話のタネ（talk）。",
      "書き方：お題は35字以内の短い呼びかけ（〜を探してみよう／〜を見比べよう／〜に耳をすまそう）。35字を超えたら短く書き直す。1つのお題で頼むことは1つだけ。観察のコツは40字以内で、見方のヒントをひとつ。年代・数値・建築様式などの断定は書かない。",
      "手本（今のアプリのお題）：",
      "- 足元のマンホールのふたを見てみよう。どんな絵や模様が描かれている？ ／ コツ：町ごとに絵柄が違うので、集める人もいます",
      "- 建物の2階より上だけを見て歩いてみよう ／ コツ：上を見るだけで、別の町のように感じます",
      "- 子どものころの通学路で、覚えている景色は？（会話のタネ）",
      "守ること：店や私有地に入らないとできないもの、買い物が必要なもの、危ないもの、人をじろじろ見るものは作らない。その場所の歴史・由来・年代など、確かでない事実は書かない。場所の名前は与えられた表記のまま使う。",
      "形式：JSONだけを返す。[{\"kind\":\"look\"または\"talk\",\"text\":\"お題\",\"tip\":\"観察のコツ（talkは空文字）\"}]",
    ].join("\n") }],
    messages: [{ role: "user", content: [{ text: facts.join("\n") }] }],
    inferenceConfig: { maxTokens: 800, temperature: 0.8 },
  });
  const raw = res.output?.message?.content?.map((c) => c.text || "").join("") || "";
  let list;
  try { list = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)); } catch { throw fail(502, "AIのお題を作れませんでした"); }
  const missions = (Array.isArray(list) ? list : []).filter((m) => m && m.text).slice(0, 4).map((m) => ({
    kind: m.kind === "talk" ? "talk" : "look", text: String(m.text).slice(0, 80), tip: m.kind === "talk" ? "" : String(m.tip || "").slice(0, 80),
  }));
  if (!missions.length) throw fail(502, "AIのお題を作れませんでした");
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: `PAIR#${pairId}`, sk: `AIM#${key}`, missions, createdAt: Date.now(), ttl: Math.floor(Date.now() / 1000) + 2 * 86400 }, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (e) {
    // 相手が先に作っていたら、そちらを使う
    if (e.name === "ConditionalCheckFailedException") return { missions: (await getItem(`PAIR#${pairId}`, `AIM#${key}`)).missions };
    throw e;
  }
  return { missions };
}
