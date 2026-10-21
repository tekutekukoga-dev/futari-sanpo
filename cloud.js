"use strict";
// 夫婦用ページだけで読み込む：ログイン（Amazon Cognito）と、ふたりのアルバムの同期。
// 一般公開版（GitHub Pages）にはこのファイルと cloud-config.js を読み込まないので、ログインの画面は出ない。
window.Cloud = (() => {
  const IDP = `https://cognito-idp.${CLOUD.region}.amazonaws.com/`;
  const ls = {
    get(k, d) { try { const v = localStorage.getItem("fs:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fs:" + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("fs:" + k); } catch {} },
  };
  let auth = ls.get("auth", null); // { id, refresh, exp, email }
  let me = ls.get("cloudMe", null); // { id, name, pair }
  let lastSync = ls.get("lastSync", 0), syncing = null, syncError = "";

  // ---------- Cognito ----------
  const ERRORS = {
    UsernameExistsException: "このメールアドレスはすでに登録されています。ログインしてください",
    NotAuthorizedException: "メールアドレスかパスワードが違います",
    UserNotConfirmedException: "メールの確認がまだです。届いた確認コードを入れてください",
    CodeMismatchException: "確認コードが違います",
    ExpiredCodeException: "確認コードの期限が切れています。コードを送り直してください",
    InvalidPasswordException: "パスワードは8文字以上で、数字を1つ以上入れてください",
    InvalidParameterException: "入力を確かめてください（パスワードは8文字以上、数字を1つ以上）",
    LimitExceededException: "試行回数が多すぎます。しばらく待ってからもう一度お試しください",
    TooManyRequestsException: "試行回数が多すぎます。しばらく待ってからもう一度お試しください",
    UserLambdaValidationException: "このメールアドレスでは登録できません",
  };
  async function idp(target, body) {
    const res = await fetch(IDP, { method: "POST", headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService." + target }, body: JSON.stringify(body) }).catch(() => null);
    if (!res) throw new Error("通信できませんでした。電波の良いところでもう一度お試しください");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const type = String(data.__type || "").split("#").pop();
      throw new Error(ERRORS[type] || data.message || "うまくいきませんでした。もう一度お試しください");
    }
    return data;
  }
  const claims = (jwt) => JSON.parse(decodeURIComponent(escape(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))));
  function keep(result, email) {
    auth = { id: result.IdToken, refresh: result.RefreshToken || auth?.refresh, exp: Date.now() + result.ExpiresIn * 1000, email: email || auth?.email };
    ls.set("auth", auth);
  }
  async function token() {
    if (!auth) throw new Error("ログインしてください");
    if (auth.exp - 60000 > Date.now()) return auth.id;
    try {
      const r = await idp("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: CLOUD.clientId, AuthParameters: { REFRESH_TOKEN: auth.refresh } });
      keep(r.AuthenticationResult);
      return auth.id;
    } catch (e) {
      if (/パスワード|違います/.test(e.message)) { signOut(); throw new Error("ログインの期限が切れました。もう一度ログインしてください"); }
      throw e;
    }
  }
  async function signIn(email, password) {
    const r = await idp("InitiateAuth", { AuthFlow: "USER_PASSWORD_AUTH", ClientId: CLOUD.clientId, AuthParameters: { USERNAME: email, PASSWORD: password } });
    keep(r.AuthenticationResult, email);
    await loadMe();
  }
  function signOut() { auth = null; me = null; ls.del("auth"); ls.del("cloudMe"); }

  // ---------- サーバー ----------
  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(CLOUD.api + path, {
      method, headers: { Authorization: "Bearer " + await token(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    if (!res) throw new Error("通信できませんでした。電波の良いところでもう一度お試しください");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || "うまくいきませんでした");
    return data;
  }
  async function loadMe() { me = await api("/me"); ls.set("cloudMe", me); return me; }
  const ready = () => !!(auth && me && me.pair && me.pair.members.length >= 1);
  const myId = () => (me ? me.id : auth ? claims(auth.id).sub : null);
  const nameOf = (id) => { const m = me?.pair?.members.find((x) => x.id === id); return m ? (m.me ? "わたし" : m.name || "あいて") : "わたし"; };

  // ---------- 同期 ----------
  // 自分の散歩と写真をアップロードし、相手の散歩と写真をダウンロードする。新しく取り込んだものがあれば true
  async function sync(force) {
    if (!ready()) return false;
    if (syncing) return syncing;
    if (!force && Date.now() - lastSync < 30000) return false;
    syncing = (async () => {
      let changed = false;
      try {
        const walks = await allWalks();
        for (const w of walks) {
          if (w.sim || w.synced || (w.fromCloud && w.owner !== myId())) continue;
          const { synced, fromCloud, owner, ...data } = w;
          await api(`/walks/${w.id}`, { method: "PUT", body: data });
          w.synced = true; await putWalk(w);
        }
        const mine = new Set(walks.filter((w) => !w.sim && (!w.fromCloud || w.owner === myId())).map((w) => w.id));
        const photos = await idb("photos", "readonly", (st) => st.getAll());
        for (const p of photos) {
          if (p.remoteId || !mine.has(p.walkId)) continue;
          const r = await api("/photos", { method: "POST", body: { walkId: p.walkId, at: p.at, mission: p.mission, pos: p.pos } });
          const up = await fetch(r.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photoBlob(p) });
          if (!up.ok) throw new Error("写真をアップロードできませんでした");
          p.remoteId = r.id; await idb("photos", "readwrite", (st) => st.put(p));
        }
        const remote = await api("/walks");
        const diaries = ls.get("diaries", {});
        for (const d of remote.diaries || []) { if (diaries[d.key] !== d.text) { diaries[d.key] = d.text; changed = true; } }
        ls.set("diaries", diaries);
        const have = new Set(walks.map((w) => w.id));
        for (const w of remote.walks) {
          if (have.has(w.id)) continue;
          await putWalk({ ...w, fromCloud: true, synced: true });
          changed = true;
        }
        const haveRemote = new Set(photos.filter((p) => p.remoteId).map((p) => p.remoteId));
        for (const p of remote.photos) {
          if (haveRemote.has(p.id)) continue;
          const res = await fetch(p.url);
          if (!res.ok) continue;
          await addPhoto({ walkId: p.walkId, data: await res.arrayBuffer(), type: "image/jpeg", mission: p.mission, pos: p.pos, at: p.at, remoteId: p.id, owner: p.owner });
          changed = true;
        }
        lastSync = Date.now(); ls.set("lastSync", lastSync); syncError = "";
      } catch (e) {
        syncError = e.message;
      } finally {
        syncing = null;
        renderBox();
      }
      return changed;
    })();
    return syncing;
  }

  // ---------- アルバムの上の「ふたりのアルバム」欄 ----------
  function box() {
    let el = document.getElementById("cloudBox");
    if (!el) {
      el = document.createElement("div");
      el.id = "cloudBox"; el.className = "group cloudbox";
      document.querySelector("#view-album .titlecard").before(el);
    }
    return el;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function renderBox() {
    const el = box();
    if (!auth) {
      el.innerHTML = `<span class="itemlabel">ふたりのアルバム</span>
        <p class="small">ログインすると、二人の写真と記録が1つのアルバムにまとまり、自動でバックアップされます。</p>
        <div class="actions"><button class="primary" data-act="login">ログイン</button><button class="secondary" data-act="signup">はじめて登録する</button></div>`;
    } else if (!me) {
      el.innerHTML = `<span class="itemlabel">ふたりのアルバム</span><p class="small muted">読み込んでいます…</p>`;
      loadMe().then(renderBox).catch((e) => { el.innerHTML = `<span class="itemlabel">ふたりのアルバム</span><p class="error">${esc(e.message)}</p><div class="actions"><button class="secondary" data-act="retry">もう一度</button><button class="link" data-act="logout">ログアウト</button></div>`; });
    } else if (!me.name) {
      el.innerHTML = `<span class="itemlabel">あなたの呼び名</span>
        <p class="small">相手のアルバムに表示される名前です（例：くん、みー）。</p>
        <input id="cloudName" class="field" maxlength="20" autocomplete="nickname" placeholder="呼び名">
        <div class="actions"><button class="primary" data-act="name">保存</button></div>`;
    } else if (!me.pair) {
      el.innerHTML = `<span class="itemlabel">ふたりのアルバム</span>
        <p class="small">${esc(me.name)}さんとしてログイン中。どちらか一人がアルバムを作り、相手は招待コードで参加します。</p>
        <div class="actions"><button class="primary" data-act="create">ふたりのアルバムを作る</button></div>
        <div class="joinrow"><input id="cloudCode" class="field" maxlength="12" autocapitalize="characters" placeholder="招待コード（8文字）"><button class="secondary" data-act="join">参加する</button></div>
        <button class="link" data-act="logout">ログアウト</button>`;
    } else if (me.pair.members.length < 2) {
      const code = me.pair.invite;
      el.innerHTML = `<span class="itemlabel">ふたりのアルバム</span>
        <p class="small">相手にこの招待コードを送ってください。相手がこのページでログインして入力すると、二人のアルバムになります。</p>
        ${code ? `<div class="invite">${esc(code)}</div><p class="small muted">有効期限：${new Date(me.pair.inviteExp).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}まで</p>` : ""}
        <div class="actions">${code ? `<button class="primary" data-act="send">コードを送る</button>` : ""}<button class="secondary" data-act="invite">${code ? "新しいコードにする" : "招待コードを出す"}</button></div>
        <button class="link" data-act="refresh">相手が参加したか確かめる</button>`;
    } else {
      const other = me.pair.members.find((m) => !m.me);
      el.innerHTML = `<span class="itemlabel">ふたりのアルバム</span>
        <p><b>${esc(me.name)}</b>と<b>${esc(other?.name || "あいて")}</b>のアルバム</p>
        <p class="small muted">${syncing ? "同期しています…" : syncError ? "" : lastSync ? `最後の同期：${new Date(lastSync).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "まだ同期していません"}</p>
        ${syncError ? `<p class="error small">${esc(syncError)}</p>` : ""}
        ${pushRow()}
        <div class="actions"><button class="secondary" data-act="sync">今すぐ同期</button><button class="link" data-act="logout">ログアウト</button></div>`;
    }
  }
  async function act(name) {
    const el = box();
    const busy = (on) => el.querySelectorAll("button").forEach((b) => (b.disabled = on));
    busy(true);
    try {
      if (name === "login" || name === "signup") return openAuth(name);
      if (name === "logout") { signOut(); return; }
      if (name === "retry" || name === "refresh") await loadMe();
      if (name === "name") me = await api("/profile", { method: "POST", body: { name: el.querySelector("#cloudName").value } });
      if (name === "create") me = await api("/pair", { method: "POST" });
      if (name === "invite") me = await api("/pair/invite", { method: "POST" });
      if (name === "join") me = await api("/pair/join", { method: "POST", body: { code: el.querySelector("#cloudCode").value } });
      if (name === "send") {
        const text = `ふたり散歩の招待コード：${me.pair.invite}\n${CLOUD.site} を開いてログインし、アルバムの「招待コード」に入力してね`;
        try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast("招待コードをコピーしました"); } } catch {}
      }
      if (name === "sync") { const ch = await sync(true); if (ch) renderAlbum(); }
      if (name === "push") await enablePush();
      ls.set("cloudMe", me);
      if (["create", "join", "refresh"].includes(name) && ready()) sync(true).then((ch) => ch && renderAlbum());
    } catch (e) {
      toast(e.message, true);
    } finally {
      renderBox();
    }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#cloudBox [data-act]");
    if (b) act(b.dataset.act);
  });

  // ---------- ログイン・登録の画面 ----------
  let mode = "login", pendingEmail = "";
  const MODES = {
    login: { title: "ログイン", fields: ["email", "password"], submit: "ログイン" },
    signup: { title: "はじめて登録する", fields: ["email", "newPassword"], submit: "登録して確認コードを受け取る" },
    confirm: { title: "メールの確認", fields: ["code"], submit: "確認する", note: () => `${esc(pendingEmail)} に届いた6桁の確認コードを入れてください。届かないときは迷惑メールのフォルダも確かめてください。` },
    forgot: { title: "パスワードを忘れたとき", fields: ["email"], submit: "確認コードを送る" },
    reset: { title: "新しいパスワード", fields: ["code", "newPassword"], submit: "パスワードを変える", note: () => `${esc(pendingEmail)} に届いた確認コードと、新しいパスワードを入れてください。` },
  };
  const FIELDS = {
    email: `<label class="flabel">メールアドレス<input class="field" id="authEmail" type="email" autocomplete="username" inputmode="email"></label>`,
    password: `<label class="flabel">パスワード<input class="field" id="authPassword" type="password" autocomplete="current-password"></label>`,
    newPassword: `<label class="flabel">パスワード（8文字以上、数字を1つ以上）<input class="field" id="authPassword" type="password" autocomplete="new-password"></label>`,
    code: `<label class="flabel">確認コード<input class="field" id="authCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>`,
  };
  function openAuth(m) {
    mode = m;
    let ov = document.getElementById("authOverlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "authOverlay"; ov.className = "overlay";
      ov.innerHTML = `<form class="guidebox" id="authForm" novalidate><h3 id="authTitle"></h3><p class="small" id="authNote"></p><div id="authFields" class="authfields"></div>
        <p class="error small" id="authError" hidden></p><button class="primary" id="authSubmit" type="submit"></button>
        <div class="authlinks" id="authLinks"></div></form>`;
      document.body.appendChild(ov);
      ov.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); submitAuth(); });
      ov.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) { e.preventDefault(); b.dataset.mode === "close" ? (ov.hidden = true) : openAuth(b.dataset.mode); } });
    }
    const M = MODES[mode];
    ov.querySelector("#authTitle").textContent = M.title;
    ov.querySelector("#authNote").innerHTML = M.note ? M.note() : "";
    ov.querySelector("#authFields").innerHTML = M.fields.map((f) => FIELDS[f]).join("");
    ov.querySelector("#authSubmit").textContent = M.submit;
    ov.querySelector("#authError").hidden = true;
    const links = { login: [["signup", "はじめての方は登録"], ["forgot", "パスワードを忘れた"]], signup: [["login", "登録済みの方はログイン"]], confirm: [["resend", "確認コードを送り直す"]], forgot: [["login", "ログインに戻る"]], reset: [["login", "ログインに戻る"]] }[mode];
    ov.querySelector("#authLinks").innerHTML = [...links, ["close", "閉じる"]].map(([m2, t]) => `<button class="link" type="button" data-mode="${m2}">${t}</button>`).join("");
    const emailField = ov.querySelector("#authEmail");
    if (emailField && pendingEmail) emailField.value = pendingEmail;
    ov.hidden = false;
  }
  async function submitAuth() {
    const ov = document.getElementById("authOverlay"), v = (id) => (ov.querySelector(id)?.value || "").trim();
    const btn = ov.querySelector("#authSubmit"), err = ov.querySelector("#authError");
    err.hidden = true; btn.disabled = true;
    try {
      if (mode === "login") { pendingEmail = v("#authEmail"); await signIn(pendingEmail, ov.querySelector("#authPassword").value); ov.hidden = true; toast("ログインしました"); }
      if (mode === "signup") {
        pendingEmail = v("#authEmail");
        await idp("SignUp", { ClientId: CLOUD.clientId, Username: pendingEmail, Password: ov.querySelector("#authPassword").value, UserAttributes: [{ Name: "email", Value: pendingEmail }] });
        ov.dataset.pw = ""; // パスワードは覚えておかない。確認のあとにもう一度ログインしてもらう
        return openAuth("confirm");
      }
      if (mode === "confirm") { await idp("ConfirmSignUp", { ClientId: CLOUD.clientId, Username: pendingEmail, ConfirmationCode: v("#authCode") }); toast("確認できました。ログインしてください"); return openAuth("login"); }
      if (mode === "forgot") { pendingEmail = v("#authEmail"); await idp("ForgotPassword", { ClientId: CLOUD.clientId, Username: pendingEmail }); return openAuth("reset"); }
      if (mode === "reset") { await idp("ConfirmForgotPassword", { ClientId: CLOUD.clientId, Username: pendingEmail, ConfirmationCode: v("#authCode"), Password: ov.querySelector("#authPassword").value }); toast("パスワードを変えました。ログインしてください"); return openAuth("login"); }
      renderBox();
      sync(true).then((ch) => ch && renderAlbum());
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      if (/確認がまだ/.test(e.message)) setTimeout(() => openAuth("confirm"), 1200);
    } finally { btn.disabled = false; }
  }
  // 「確認コードを送り直す」
  document.addEventListener("click", async (e) => {
    if (!e.target.closest('[data-mode="resend"]')) return;
    e.stopPropagation();
    try { await idp("ResendConfirmationCode", { ClientId: CLOUD.clientId, Username: pendingEmail }); toast("確認コードを送り直しました"); } catch (err) { toast(err.message, true); }
  }, true);

  // ---------- 通知（ホーム画面に追加したときだけ使える） ----------
  const standalone = () => navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  function pushRow() {
    if (ls.get("pushOn", false) && pushSupported() && Notification.permission === "granted") return `<p class="small muted">通知：オン（写真の追加・合流・別行動の知らせが届きます）</p>`;
    if (!pushSupported() || !standalone()) return `<p class="small muted">通知を受け取るには、共有ボタンの「ホーム画面に追加」から開いてください。</p>`;
    if (Notification.permission === "denied") return `<p class="small muted">通知がオフになっています。iPhoneの「設定 → 通知 → ふたり散歩」でオンにできます。</p>`;
    return `<div class="actions"><button class="secondary" data-act="push">通知をオンにする</button></div>`;
  }
  const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  async function enablePush() {
    const reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== "granted") throw new Error("通知が許可されませんでした");
    const subn = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CLOUD.vapidPublic) });
    await api("/push/subscribe", { method: "POST", body: subn.toJSON() });
    ls.set("pushOn", true);
    toast("通知をオンにしました");
  }

  // ---------- 手紙・合流の知らせ ----------
  async function openLetters() {
    if (!ready() || me.pair.members.length < 2) return [];
    try { return (await api("/letters")).letters || []; } catch { return []; }
  }
  function event(body) { if (ready()) api("/events", { method: "POST", body }).catch(() => {}); }
  function renderLetter(group) {
    const el = document.getElementById("detailLetter");
    const mine = group.find((w) => !w.fromCloud || w.owner === myId());
    // 散歩から帰って12時間のあいだだけ、相手への手紙を書ける
    if (!el || !ready() || me.pair.members.length < 2 || !mine || mine.sim || Date.now() - mine.endedAt > 12 * 3600e3) { if (el) el.hidden = true; return; }
    const other = me.pair.members.find((m) => !m.me)?.name || "あいて";
    el.hidden = false;
    el.innerHTML = `<span class="itemlabel">${esc(other)}への手紙</span>
      <p class="small muted">次の散歩に出発したときに、${esc(other)}のスマホに届きます。</p>
      <textarea id="letterText" class="field" rows="3" maxlength="400" placeholder="今日の散歩のこと、ひとこと"></textarea>
      <div class="actions"><button class="primary" id="btnLetter">手紙を送る</button></div>`;
    el.querySelector("#btnLetter").onclick = async () => {
      const text = el.querySelector("#letterText").value.trim();
      if (!text) return toast("手紙が空です", true);
      try { await api("/letters", { method: "POST", body: { text } }); el.innerHTML = `<span class="itemlabel">${esc(other)}への手紙</span><p>送りました。次の散歩で届きます。</p>`; }
      catch (e) { toast(e.message, true); }
    };
  }

  // ---------- AI散歩日記 ----------
  const diaryKey = (group) => String(group[0].seed ?? group[0].id);
  async function diary(walkId, quiet) {
    if (!ready()) return null;
    const group = groupWalks(await allWalks()).find((g) => g.some((w) => w.id === walkId));
    if (!group) return null;
    try {
      const r = await api("/diary", { method: "POST", body: { key: diaryKey(group), walkIds: group.map((w) => w.id) } });
      const all = ls.get("diaries", {}); all[r.key] = r.text; ls.set("diaries", all);
      if (!document.getElementById("view-detail").hidden) renderDiary(group);
      return r.text;
    } catch (e) { if (!quiet) toast(e.message, true); return null; }
  }
  function renderDiary(group) {
    const el = document.getElementById("detailDiary");
    if (!el) return;
    const text = ls.get("diaries", {})[diaryKey(group)];
    if (group[0].sim || (!text && !ready())) { el.hidden = true; return; }
    el.hidden = false;
    if (text) {
      el.innerHTML = `<span class="itemlabel">散歩日記</span><p class="diarytext"></p><button class="link small" id="btnDiary">書き直してもらう</button>`;
      el.querySelector(".diarytext").textContent = text;
    } else {
      el.innerHTML = `<span class="itemlabel">散歩日記</span><p class="small muted">ルート・寄り道・メモ・写真から、AIが短い日記を書きます。</p><div class="actions"><button class="secondary" id="btnDiary">AIに日記を書いてもらう</button></div>`;
    }
    el.querySelector("#btnDiary").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "書いています…（10秒ほど）";
      await sync(true);
      await diary(group[0].id);
      renderDiary(group);
    };
  }

  // ---------- AIのお題 ----------
  // ルートができたら先に頼んでおく。二人とも同じルート番号で頼むので、同じお題が返ってくる
  const aiCache = {};
  const SEASON = { spring: "春", summer: "夏", autumn: "秋", winter: "冬" };
  function missionsFor(route) {
    if (!ready() || !route) return Promise.resolve([]);
    const key = String(plan.seed);
    if (!aiCache[key]) {
      const tk = themeKey(plan.seed);
      aiCache[key] = api("/missions", { method: "POST", body: {
        key, season: SEASON[seasonKey(new Date().getMonth() + 1)],
        weather: plan.weather ? `${plan.weather.label}・${plan.weather.temp}℃` : "",
        night: isNightWalk(Date.now(), route.total / WALK_SPEED / 60, plan.home),
        theme: tk ? THEMES[tk].label : "", stop: plan.chosen && plan.stop !== "none" ? plan.chosen.name : "",
        meet: route.split ? route.split.meetName : "",
        places: (route.pois || []).slice(0, 10).map((p) => ({ name: p.name, label: p.label })),
      } }).then((r) => r.missions || []).catch(() => { delete aiCache[key]; return []; });
    }
    return aiCache[key];
  }
  // 散歩のお題の予定のうち、まだ届いていないものをAIのお題に置き換える（間をあけて散らす）
  function applyMissions(w, list) {
    const rest = w.events.slice(w.eventIdx).filter((e) => e.id !== "final" && !e.ai);
    let used = 0;
    ["look", "talk"].forEach((kind) => {
      const slots = rest.filter((e) => e.kind === kind);
      list.filter((m) => m.kind === kind).forEach((m, i) => {
        const e = slots[Math.min(slots.length - 1, 1 + i * 2)];
        if (!e || e.ai) return;
        Object.assign(e, { text: m.text, tip: m.tip || undefined, cat: kind === "talk" ? "us" : undefined, label: "AIのお題", ai: true });
        used++;
      });
    });
    return used;
  }

  // ---------- 別行動中の現在地 ----------
  let partnerMarker = null, lastShare = 0;
  async function shareWhileApart(w) {
    if (!ready() || Date.now() - lastShare < 20000 || document.visibilityState !== "visible") return;
    lastShare = Date.now();
    const sp = w.split, meetAlong = w.meetAlong ?? (w.branch === "B" ? sp.meetAlongB : sp.meetAlongA);
    try {
      await api("/location", { method: "POST", body: { lat: w.pos[0], lon: w.pos[1], eta: w.meetEta, left: Math.max(0, Math.round(meetAlong - w.progress)) } });
      const { location } = await api("/location");
      if (!location || !walkMap) return;
      const el = partnerMarker ? partnerMarker.getElement() : mkEl("partner");
      el.textContent = location.name.slice(0, 2);
      if (!partnerMarker) partnerMarker = htmlMarker(walkMap, [location.lat, location.lon], el);
      else partnerMarker.setLngLat(ll([location.lat, location.lon]));
      const chip = document.getElementById("meetBadge");
      if (chip && location.left != null) chip.textContent = `合流 ${fmtTime(w.meetEta)}・${location.name}はあと${fmtDist(location.left)}`;
    } catch {}
  }
  function stopSharing() { if (partnerMarker) { partnerMarker.remove(); partnerMarker = null; } }

  function init() {
    // ページのタイトルに「ふたり用」と出して、一般公開版と見分けられるようにする
    const logo = document.querySelector(".logo");
    if (logo && !logo.querySelector(".edition")) logo.insertAdjacentHTML("beforeend", '<span class="edition">ふたり用</span>');
    if (ready()) sync().then((ch) => ch && !document.getElementById("view-album").hidden && renderAlbum());
    if (ls.get("pushOn", false) && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  return { init, sync, renderBox, ready, myId, nameOf, openLetters, event, renderLetter, diary, renderDiary, shareWhileApart, stopSharing, missionsFor, applyMissions };
})();
