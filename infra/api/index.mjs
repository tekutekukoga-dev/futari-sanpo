// ふたりのアルバムのサーバー処理（API Gateway → Lambda）
// ログイン済みの人（CognitoのID）だけが呼べる。自分が入っているアルバムの記録と写真にしか触れない。
//
// 表（DynamoDB）の中身
//   USER#{id}   / PROFILE            名前と、入っているアルバム
//   PAIR#{pair} / META               メンバー（最大2人）と招待コード
//   INVITE#{code} / INVITE           招待コード → アルバム（48時間で自動削除）
//   PAIR#{pair} / WALK#{id}#{walk}   散歩の記録
//   PAIR#{pair} / PHOTO#{walk}#{id}#{at}  写真の情報（本体はS3）
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "node:crypto";

const TABLE = process.env.TABLE, BUCKET = process.env.BUCKET, REGION = process.env.AWS_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const INVITE_HOURS = 48;

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

export const handler = async (event) => {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!sub) return json(401, { error: "ログインしてください" });
  const method = event.requestContext.http.method, path = event.rawPath;
  let body = {};
  try { body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : {}; }
  catch { return json(400, { error: "送られてきたデータが読めません" }); }
  try {
    if (method === "GET" && path === "/me") return json(200, await me(sub));
    if (method === "POST" && path === "/profile") return json(200, await setProfile(sub, body));
    if (method === "POST" && path === "/pair") return json(200, await createPair(sub));
    if (method === "POST" && path === "/pair/invite") return json(200, await newInvite(sub));
    if (method === "POST" && path === "/pair/join") return json(200, await joinPair(sub, body.code));
    if (method === "GET" && path === "/walks") return json(200, await listWalks(sub));
    if (method === "PUT" && path.startsWith("/walks/")) return json(200, await saveWalk(sub, decodeURIComponent(path.slice(7)), body));
    if (method === "POST" && path === "/photos") return json(200, await newPhoto(sub, body));
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
  // 写真は1時間だけ見られるURLを付けて返す
  const photos = items.filter((i) => i.sk.startsWith("PHOTO#")).map((i) => ({
    id: i.sk.slice(6), walkId: i.walkId, owner: i.owner, mission: i.mission, pos: i.pos, at: i.at, url: presign("GET", i.key, 3600),
  }));
  return { walks, photos };
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
