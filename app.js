// 問題ソルバー (スマホ用 Web アプリ)
// 問題を撮影して Gemini Flash (思考モード) で解き、解答シート (Google スプレッドシート) の答えと並べて表示する。
// Gemini の呼び出し・多数決・解答シートとの照合は、拡張機能 (split-screen-solver/sidepanel.js) と同じ処理。
const $ = (id) => document.getElementById(id);
const els = {
  setup: $("setup"), keyInput: $("keyInput"), sheetUrl: $("sheetUrl"), sheetStatus: $("sheetStatus"),
  flashOnly: $("flashOnly"), saveBtn: $("saveBtn"), sheetReload: $("sheetReload"), settingsBtn: $("settingsBtn"),
  sheetBadge: $("sheetBadge"), cameraInput: $("cameraInput"), photoInput: $("photoInput"),
  speed: $("speed"), search: $("search"),
  status: $("status"), final: $("final"), explain: $("explain"), stopBtn: $("stopBtn"),
  photoBox: $("photoBox"), photoThumb: $("photoThumb"), cropBtn: $("cropBtn"),
  compare: $("compare"), valGemini: $("valGemini"), valSheet: $("valSheet"), verdict: $("verdict"),
  text: $("text"), sendBtn: $("sendBtn"), history: $("history"),
  cropModal: $("cropModal"), cropStage: $("cropStage"), cropImg: $("cropImg"), cropRect: $("cropRect"),
  cropCancel: $("cropCancel"), cropDone: $("cropDone"),
};

// 混雑 (503) や回数上限 (429) のときは、次のモデルに切り替えて解く
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const FLASH_ONLY_RETRY_DELAYS_MS = [1500, 3000, 5000]; // Flash 固定のとき、混雑したら待ってやり直す間隔
const RETRY_PRIMARY_AFTER_MS = 5 * 60 * 1000; // 切り替え後、この時間がたったら最初のモデルに戻す
const API_ORIGIN = "https://generativelanguage.googleapis.com";
const apiUrl = (model) => `${API_ORIGIN}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
// 正答率を優先し、「正確」でも最も深く考えさせる
const THINKING = { fastest: "MINIMAL", fast: "LOW", accurate: "HIGH", max: "HIGH" };
// 思考レベル指定に対応していない 2.5 系モデル用の思考量 (トークン数、-1 はモデルにおまかせ)
const THINKING_BUDGET = { fastest: 0, fast: 2048, accurate: 16384, max: -1 };
const DEFAULT_SPEED = "accurate";
// 最高精度では同じ問題を並行して何回か解かせ、多数決で答えを決める (割れたら検証役がもう1回考える)
const VOTES = 3;
// 画像を読み取る細かさ。高いほど小さな文字・数式・図の読み間違いが減る (少し遅くなる)
// Gemini 3 では画像1枚ごとに指定でき、ULTRA_HIGH (約2240トークン) は HIGH の2倍の細かさで読む
const PART_RESOLUTION = { fast: "MEDIA_RESOLUTION_HIGH", accurate: "MEDIA_RESOLUTION_ULTRA_HIGH", max: "MEDIA_RESOLUTION_ULTRA_HIGH" };
// 画像ごとの指定ができないモデル (2.5 系) では、リクエスト全体でこちらを指定する
const MEDIA_RESOLUTION = { fast: "MEDIA_RESOLUTION_MEDIUM", accurate: "MEDIA_RESOLUTION_HIGH", max: "MEDIA_RESOLUTION_HIGH" };
// 最高精度では、画面全体に加えて上下に分割した拡大画像も送り、細かい文字を読みやすくする
const TILE_MIN_HEIGHT = 700;     // 範囲の高さ (画素) がこれ以上なら分割する
const TILE_SHARE = 0.55;         // 分割1枚あたりの高さの割合 (上下で 10% 重ねて、境目の行が切れないようにする)

const SYSTEM_PROMPT = `あなたは試験・問題集・クイズ・プログラミング課題などあらゆる問題を、正確に速く解く専門家です。
ユーザーは画面に表示されている問題のスクリーンショット、プリントを撮った写真 (傾きや影があることもある)、またはテキストを送ってきます。正確さを最優先し、そのうえで速く答えます。

出力形式 (厳守):
1行目: 「答え: 」に続けて最終的な答えだけを書く。選択式なら記号と内容 (例: 答え: (3) 光合成)。複数の小問があれば「答え: (1) ア (2) 12 (3) …」と1行にまとめる。
2行目: 空行
3行目以降: 「解説:」として要点を1〜3行で簡潔に。

解く手順 (考える段階で必ず行う):
1. 読み取り: 問題文・選択肢・図・表・グラフの数値、記号、単位、上付き/下付き文字、符号 (−/+)、小数点を一字ずつ正確に読む。読みにくい文字は文脈から判断する。
2. 問われ方の確認: 「誤っているもの」「適切でないもの」「〜でないもの」などの否定、「すべて選べ」「2つ選べ」などの個数、答える形式 (記号・数値・語句・文字数)、単位、四捨五入の位や有効数字を確認する。
3. 解く: 選択式は正解だと思うもの以外の選択肢も一つずつ検討し、なぜ違うかを確かめる。
4. 検算: 計算は逆算か別の方法で確かめ、単位と桁を確認する。
5. 最終確認: 答えが手順2の問われ方 (否定・個数・形式) に合っているか見直してから出力する。

ルール:
- 問題と関係ない部分 (メニュー、タイマー、広告、写真に写り込んだ机や手など) は無視する。
- 画面上で既に選ばれている選択肢や書き込みは、正解とは限らないので鵜呑みにしない。
- 画像に複数の問題が写っている場合は、すべて解く。問題番号をそのまま使う。
- 問題文が画面の端で切れている場合は、見えている範囲で最善の答えを出し、解説にその旨を書く。
- 数式は LaTeX を使わず、√ ² × ÷ ≤ π などの記号を使ったプレーンテキストで書く。
- 質問の言語に合わせて回答する (既定は日本語)。
- 確信が持てない場合も最も可能性の高い答えを1行目に書き、解説に「確信度: 低」と理由を書く。`;

const MAX_EDGE = 2048;           // 送る画像の最大辺
const THUMB_EDGE = 160;          // 履歴に表示する縮小画像の最大辺
// 送る画像の WebP 画質 (WebP に対応していない iPhone では JPEG)
const IMAGE_QUALITY = { fastest: 0.85, fast: 0.9, accurate: 0.95, max: 1 };
const HISTORY_MAX = 30;

let apiKey = "";
let thread = [];                 // 現在の問題の会話 (拡張機能と共通の処理で使う)
let controller = null;
let running = null;
let solveSeq = 0;
let warmedAt = -Infinity;
let modelIndex = 0;
let modelSwitchedAt = 0;
let photo = null;                // 最後に撮った写真 {img, url} (範囲を選び直すため)
const noThinkingModels = new Set(MODELS.filter((m) => m.startsWith("gemini-2.5")));
const noBudgetModels = new Set();
const noMediaResolutionModels = new Set();
const noSearchModels = new Set();
const noPartResolutionModels = new Set(MODELS.filter((m) => m.startsWith("gemini-2.5")));

// ---- 保存 (このスマホのブラウザの中だけ) ----
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("solver." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem("solver." + key, JSON.stringify(value)); } catch { /* 保存できなくても動作は続ける */ }
  },
};

// ---- 画像 ----
function drawScaled(source, sx, sy, sw, sh, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// 送信用に縮小・圧縮する。エンコードは非同期なので画面が固まらない
async function makeImage(source, sx, sy, sw, sh, label) {
  const canvas = drawScaled(source, sx, sy, sw, sh, MAX_EDGE);
  const quality = IMAGE_QUALITY[els.speed.value] ?? IMAGE_QUALITY[DEFAULT_SPEED];
  let blob = await canvasToBlob(canvas, "image/webp", quality);
  if (blob?.type !== "image/webp") blob = await canvasToBlob(canvas, "image/jpeg", Math.min(quality, 0.95));
  const url = await blobToDataUrl(blob);
  const thumb = drawScaled(canvas, 0, 0, canvas.width, canvas.height, THUMB_EDGE).toDataURL("image/jpeg", 0.7);
  return { mimeType: blob.type, data: url.slice(url.indexOf(",") + 1), thumb, label };
}

// 送る画像の一式。最高精度で縦に大きい範囲なら、全体 + 上下の拡大 (元の解像度のまま切り出す) にする
async function makeImages(source, sx, sy, sw, sh) {
  const whole = await makeImage(source, sx, sy, sw, sh);
  if (els.speed.value !== "max" || sh < TILE_MIN_HEIGHT) return [whole];
  const th = Math.round(sh * TILE_SHARE);
  whole.label = "【画面全体】";
  return [
    whole,
    await makeImage(source, sx, sy, sw, th, "【拡大: 上半分】細かい文字の確認用 (全体と同じ画面)"),
    await makeImage(source, sx, sy + sh - th, sw, th, "【拡大: 下半分】細かい文字の確認用 (全体と同じ画面)"),
  ];
}

// ---- 表示 ----
function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = "status " + kind;
}

function renderAnswer(text) {
  text = stripSheetTag(text);
  const nl = text.indexOf("\n");
  els.final.textContent = (nl === -1 ? text : text.slice(0, nl)).trim();
  els.explain.textContent = nl === -1 ? "" : text.slice(nl + 1).trim();
}

// ---- Gemini 呼び出し ----
function toParts(turn) {
  const parts = turn.images.flatMap(({ mimeType, data, label }) => [
    ...(label ? [{ text: label }] : []),
    { inlineData: { mimeType, data } },
  ]);
  if (turn.text) parts.push({ text: turn.text });
  return parts;
}

function errorMessage(status, message) {
  if (status === 429) return "無料枠の上限 (1分あたりの回数) に達しました。数十秒待ってください。";
  if (status === 503 || status === 500) return "Gemini が混み合っています (全モデルで失敗)。少し待ってから「📷 撮影して解く」を押してください。";
  if (status === 400 && /API key/i.test(message)) return "API キーが無効です。⚙ の設定からキーを設定し直してください。";
  if (status === 403) return "API キーに権限がありません。⚙ の設定からキーを確認してください。";
  return `Gemini エラー ${status}: ${message}`;
}

// 回答をストリーミングで受け取り、届いた文字ごとに onText を呼ぶ。答えたモデル名などを返す
async function callGemini(contents, speed, signal, onText) {
  if (els.flashOnly.checked) return callFlashOnly(contents, speed, signal, onText);
  if (modelIndex > 0 && performance.now() - modelSwitchedAt > RETRY_PRIMARY_AFTER_MS) modelIndex = 0;
  let lastError;
  for (let i = modelIndex; i < MODELS.length; i++) {
    warmedAt = performance.now();
    const res = await requestModel(MODELS[i], contents, speed, signal);
    if (res.ok) {
      if (i !== modelIndex) {
        modelIndex = i;
        modelSwitchedAt = performance.now();
      }
      return { model: MODELS[i], finishReason: await readStream(res, onText) };
    }
    const err = await res.json().catch(() => ({}));
    lastError = { status: res.status, message: err.error?.message ?? res.statusText };
    // 混雑・回数上限・サーバー不調・モデルなし なら次のモデルへ。それ以外 (キー不正など) は即エラー
    if (![429, 500, 503, 404].includes(res.status)) break;
  }
  modelIndex = 0; // 全部だめだったら、次回は最初のモデルから試す
  throw new Error(errorMessage(lastError.status, lastError.message));
}

// Flash 固定: 別モデルには切り替えず、混雑 (503/500) のときは少し待って同じモデルでやり直す
async function callFlashOnly(contents, speed, signal, onText) {
  const model = MODELS[0];
  for (let attempt = 0; ; attempt++) {
    warmedAt = performance.now();
    const res = await requestModel(model, contents, speed, signal);
    if (res.ok) return { model, finishReason: await readStream(res, onText) };
    const err = await res.json().catch(() => ({}));
    const delay = FLASH_ONLY_RETRY_DELAYS_MS[attempt];
    if (![500, 503].includes(res.status)) throw new Error(errorMessage(res.status, err.error?.message ?? res.statusText));
    if (delay === undefined) {
      throw new Error(`Gemini Flash が混み合っています (${attempt + 1}回試しました)。少し待ってから「📷 撮影して解く」を押してください。混雑が続くときは⚙ の「Flash 固定」を外すと別のモデルで解けます。`);
    }
    setStatus(`Flash が混雑中… ${delay / 1000}秒後にやり直します (${attempt + 1}/${FLASH_ONLY_RETRY_DELAYS_MS.length})`, "busy");
    await sleep(delay, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

async function requestModel(model, contents, speed, signal) {
  const send = (body) => fetch(apiUrl(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt() }] }, ...body }),
    signal,
  });
  // 画像1枚ごとに読み取りの細かさを付ける
  const withPartResolution = (level) => contents.map((c) => ({
    ...c, parts: c.parts.map((p) => (p.inlineData ? { ...p, mediaResolution: { level } } : p)),
  }));
  // 対応していない設定でエラーになったら、その設定を外してやり直す (外した設定は覚えておく)
  for (;;) {
    const generationConfig = {};
    if (!noThinkingModels.has(model)) generationConfig.thinkingConfig = { thinkingLevel: THINKING[speed] ?? "MEDIUM" };
    else if (!noBudgetModels.has(model)) generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET[speed] ?? -1 };
    const partLevel = !noPartResolutionModels.has(model) && PART_RESOLUTION[speed];
    const media = !partLevel && !noMediaResolutionModels.has(model) && MEDIA_RESOLUTION[speed];
    if (media) generationConfig.mediaResolution = media;
    const search = els.search.checked && !noSearchModels.has(model);
    const res = await send({
      contents: partLevel ? withPartResolution(partLevel) : contents,
      generationConfig,
      ...(search ? { tools: [{ googleSearch: {} }] } : {}),
    });
    if (res.status !== 400) return res;
    const message = (await res.clone().json().catch(() => ({}))).error?.message ?? "";
    if (/media.?resolution|ULTRA_HIGH/i.test(message) && (partLevel || media)) {
      (partLevel ? noPartResolutionModels : noMediaResolutionModels).add(model);
    } else if (search && /search|grounding|tool/i.test(message)) {
      noSearchModels.add(model);
    } else if (generationConfig.thinkingConfig && /think/i.test(message)) {
      (noThinkingModels.has(model) ? noBudgetModels : noThinkingModels).add(model);
    } else {
      return res;
    }
  }
}

async function readStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finishReason;
  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    let msg;
    try {
      msg = JSON.parse(line.slice(5));
    } catch {
      return; // 壊れた行は読み飛ばす
    }
    // ストリームの途中で返ってきたエラー (混雑など)
    if (msg.error) throw new Error(errorMessage(msg.error.code, msg.error.message ?? ""));
    const cand = msg.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (part.text && !part.thought) onText(part.text);
    }
    if (cand?.finishReason) finishReason = cand.finishReason;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handleLine(buf + decoder.decode()); // 改行で終わらない最後の行
  return finishReason;
}

async function runSolve({ text, images, followUp }) {
  if (!followUp) thread = [];
  const contents = [
    ...thread.map((t) => (t.role === "model"
      ? { role: "model", parts: [{ text: t.text }] }
      : { role: "user", parts: toParts(t) })),
    { role: "user", parts: toParts({ text: text || (followUp ? "" : "この問題を解いてください。"), images }) },
  ];

  renderAnswer("");
  showCompare("pending");
  const speed = els.speed.value;
  const votes = speed === "max" ? VOTES : 1;
  setStatus(votes > 1 ? `${votes}回並行して解いています…` : "解いています…", "busy");
  els.stopBtn.hidden = false;
  controller = new AbortController();
  const signal = controller.signal;
  const started = performance.now();
  const elapsed = () => ((performance.now() - started) / 1000).toFixed(1);
  let answer = "";
  let aborted = false;

  try {
    // 最初に書き始めた回答を画面に流す (多数決のときも待たずに表示する)
    let shown = -1;
    const runs = Array.from({ length: votes }, (_, i) => {
      let text = "";
      return callGemini(contents, speed, signal, (t) => {
        if (shown === -1) {
          shown = i;
          setStatus(`回答中… ${elapsed()}秒で表示開始${votes > 1 ? " (多数決の集計待ち)" : ""}`, "busy");
        }
        text += t;
        if (shown === i) renderAnswer(text);
      }).then((r) => ({ ...r, text: text.trim() }));
    });
    const results = await Promise.allSettled(runs);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.text).map((r) => r.value);
    if (!ok.length) throw results.find((r) => r.status === "rejected")?.reason ?? new Error("回答が空でした");

    let pick = ok[0];
    let verdict = "";
    if (votes > 1) {
      const { best, count } = majority(ok);
      if (ok.length > 1 && count * 2 > ok.length) {
        pick = best;
        verdict = ` · ${ok.length}回中${count}回一致`;
      } else if (ok.length > 1) {
        // 答えが割れたら、候補をすべて検証させて決める
        setStatus(`答えが割れたので検証しています… (${elapsed()}秒)`, "busy");
        let text = "";
        const judged = await callGemini(judgeContents(contents, ok), speed, signal, (t) => {
          text += t;
          renderAnswer(text);
        });
        pick = { ...judged, text: text.trim() || ok[0].text };
        verdict = ` · 答えが割れたため検証して決定`;
      } else {
        verdict = ` · ${votes}回中1回だけ成功`;
      }
    }
    answer = pick.text;
    renderAnswer(answer);
    showCompare(checkAgainstSheet(answer));
    const note = pick.finishReason === "MAX_TOKENS" ? " (出力が上限で途切れました)" : pick.finishReason === "SAFETY" ? " (安全フィルタで止まりました)" : "";
    const fallback = pick.model === MODELS[0] ? "" : " ※混雑のため別モデル";
    setStatus(`完了 ${elapsed()}秒 · ${pick.model}${fallback}${verdict}${note}`);
  } catch (err) {
    if (err.name === "AbortError") aborted = true;
    else setStatus(err.message, "error");
  } finally {
    controller = null;
    els.stopBtn.hidden = true;
  }

  if (answer && !aborted) {
    thread.push({ role: "user", text, images }, { role: "model", text: answer });
    addHistory(images[0]?.thumb, answer);
  } else if (aborted) {
    setStatus("停止しました");
  }
}

// 1行目 (答え) を比べやすい形にそろえる: 全角/半角・空白・句読点・「答え:」の違いを無視
function answerKey(text) {
  return text.split("\n")[0].normalize("NFKC").replace(/^\s*答え?\s*[:：]/, "")
    .replace(/[\s。、,.・「」『』"'`]/g, "").toLowerCase();
}

// 最も多かった答えと、その回数
function majority(results) {
  const groups = new Map();
  for (const r of results) {
    const key = answerKey(r.text);
    const g = groups.get(key) ?? { best: r, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)[0];
}

// 割れた回答候補を見比べて、正しい答えを決めさせるための会話
function judgeContents(contents, results) {
  const candidates = results.map((r, i) => `【候補${i + 1}】\n${r.text}`).join("\n\n");
  return [
    ...contents,
    { role: "user", parts: [{ text: `この問題に対して、別々に解いた次の回答候補が出ました。答えが一致していません。\n\n${candidates}\n\n問題を最初から読み直し、各候補の誤りを一つずつ検証してから、正しい答えを決めてください。候補がすべて誤りなら正しい答えを新たに出してください。出力形式 (1行目に「答え: 」) は同じです。` }] },
  ];
}

// ---- 解答シートとの照合 ----
// Gemini には独立して解かせ (シートの答えは見せない)、問題文の書き写しを1行だけ出させて、
// それに最も近いシートの行の答えと照らし合わせる
const SHEET_TAG = "【問題文】";
const SHEET_MATCH_MIN = 0.45;    // 問題文の似ている度合い (0〜1) がこれ未満なら「シートに該当なし」
let sheetRows = [];              // [{row, question, answer, grams}]

function systemPrompt() {
  if (!sheetRows.length) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}
- 照合用に、回答の最後に1行だけ「${SHEET_TAG}」に続けて、問題番号と問題文の最初の60文字ほどを画像のとおり書き写す (改行しない)。複数の問題があるときは最初の問題について書く。`;
}

function stripSheetTag(text) {
  return text.replace(new RegExp(`\\n?${SHEET_TAG}.*$`, "m"), "").replace(/\n【[^\n]{0,4}$/, "");
}

// 照合用に表記ゆれをそろえる (全角/半角・空白・記号・括弧)
const normalize = (s) => String(s).normalize("NFKC").replace(/[\s。、,.・:：「」『』"'`()（）\[\]【】〔〕]/g, "").toLowerCase();

function bigrams(text) {
  const t = normalize(text);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (t.length === 1) set.add(t);
  return set;
}

// 短い方の文字列の何割が、もう一方にも含まれるか (書き写しは問題文の冒頭だけなので)
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const g of a) if (b.has(g)) common++;
  return common / Math.max(4, Math.min(a.size, b.size));
}

function sameAnswer(gemini, sheet) {
  const g = normalize(gemini.replace(/^\s*答え?\s*[:：]/, ""));
  const k = normalize(sheet);
  if (!g || !k) return false;
  return g === k || g.startsWith(k) || (k.length >= 2 && g.includes(k)) || (g.length >= 2 && k.startsWith(g));
}

// Gemini の答えと、シートから探した答えを並べて表示するための情報を作る
function checkAgainstSheet(answer) {
  if (!sheetRows.length || !answer) return null;
  const gemini = stripSheetTag(answer).split("\n")[0].replace(/^\s*答え?\s*[:：]\s*/, "").trim();
  const copied = answer.match(new RegExp(`${SHEET_TAG}(.*)$`, "m"))?.[1]?.trim();
  if (!copied) return { kind: "none", gemini, sheet: "—", note: "問題文を読み取れなかったため、シートを探せませんでした" };
  const grams = bigrams(copied);
  let best = null, bestScore = 0;
  for (const r of sheetRows) {
    const score = similarity(grams, r.grams);
    if (score > bestScore) [best, bestScore] = [r, score];
  }
  if (!best || bestScore < SHEET_MATCH_MIN) {
    return { kind: "none", gemini, sheet: "見つかりません", note: `シートに同じ問題がありませんでした (読み取った問題: 「${copied.slice(0, 40)}」)` };
  }
  const where = `シート ${best.row}行目「${best.question.slice(0, 40)}${best.question.length > 40 ? "…" : ""}」`;
  return sameAnswer(gemini, best.answer)
    ? { kind: "ok", gemini, sheet: best.answer, note: `✅ 一致 · ${where}` }
    : { kind: "ng", gemini, sheet: best.answer, note: `⚠ 答えが違います · ${where}` };
}

// state: null (シート未設定) / "pending" (解答中) / checkAgainstSheet の結果
function showCompare(state) {
  if (state === "pending") state = sheetRows.length ? { kind: "pending", gemini: "解答中…", sheet: "Gemini が問題を読み取った後に探します", note: "" } : null;
  els.compare.hidden = !state;
  if (!state) return;
  els.compare.className = "compare " + state.kind;
  els.valGemini.textContent = state.gemini || "—";
  els.valSheet.textContent = state.sheet;
  els.verdict.textContent = state.note;
}

// ---- 解答シートの読み込み ----
// スマホのブラウザからは、共有設定が「リンクを知っている全員」のシートを CSV で読む
function sheetCsvUrl(url) {
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1];
  if (url.includes("/spreadsheets/d/e/")) { // 「ウェブに公開」のリンク
    return `${url.split(/[?#]/)[0].replace(/\/pub(html)?$/, "")}/pub?output=csv${gid ? `&gid=${gid}` : ""}`;
  }
  const id = url.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
  return id ? `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid ? `&gid=${gid}` : ""}` : url;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function setSheetStatus(text, kind = "") {
  els.sheetStatus.textContent = text;
  els.sheetStatus.className = "status " + kind;
}

async function loadSheet(url) {
  sheetRows = [];
  els.sheetBadge.hidden = true;
  if (!url) {
    setSheetStatus("");
    return;
  }
  setSheetStatus("解答シートを読み込み中…", "busy");
  try {
    const res = await fetch(sheetCsvUrl(url), { cache: "no-store" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || type.includes("html")) throw new Error("bad response");
    const table = parseCsv(await res.text());
    if (table.length < 2) throw new Error("シートに問題と答えの行が見つかりません。");
    const header = table[0];
    let ansCol = header.findIndex((h) => /答|解答|正解|answer/i.test(h));
    const hasHeader = ansCol !== -1;
    if (!hasHeader) ansCol = header.length - 1; // 見出しがなければ一番右の列を答えとみなす
    sheetRows = table.slice(hasHeader ? 1 : 0).map((cells, i) => {
      const question = cells.filter((_, c) => c !== ansCol).join(" ").trim();
      return { row: i + (hasHeader ? 2 : 1), question, answer: (cells[ansCol] ?? "").trim(), grams: bigrams(question) };
    }).filter((r) => r.question && r.answer);
    if (!sheetRows.length) throw new Error("答えの入った行がありません。");
    setSheetStatus(`${sheetRows.length}問を読み込みました (答えの列: ${hasHeader ? header[ansCol] : "一番右"})。`);
    els.sheetBadge.textContent = `📊 ${sheetRows.length}問`;
    els.sheetBadge.hidden = false;
  } catch (err) {
    sheetRows = [];
    const message = err.message === "bad response" || err instanceof TypeError
      ? "解答シートを読めません。シートの共有を「リンクを知っている全員 (閲覧者)」にしてください。"
      : err.message;
    setSheetStatus(message, "error");
    els.setup.hidden = false;
  }
}

// ---- 設定 ----
function loadSettings() {
  apiKey = store.get("apiKey", "");
  els.speed.value = store.get("speed", DEFAULT_SPEED);
  els.search.checked = store.get("search", false);
  els.flashOnly.checked = store.get("flashOnly", true);
  const sheetUrl = store.get("sheetUrl", "");
  els.sheetUrl.value = sheetUrl;
  els.setup.hidden = !!apiKey;
  if (sheetUrl) loadSheet(sheetUrl);
  // 保存は新しい順。古いものから追加して、新しいものが上に来るようにする
  for (const h of [...store.get("history", [])].reverse()) addHistory(null, h.answer, false);
}
els.speed.onchange = () => store.set("speed", els.speed.value);
els.search.onchange = () => store.set("search", els.search.checked);
els.settingsBtn.onclick = () => { els.setup.hidden = !els.setup.hidden; };
els.saveBtn.onclick = () => {
  const key = els.keyInput.value.trim();
  if (key) {
    if (!/^\S{20,}$/.test(key)) {
      setSheetStatus("API キーの形式が正しくありません", "error");
      return;
    }
    apiKey = key;
    store.set("apiKey", key);
    els.keyInput.value = "";
  }
  if (!apiKey) {
    setSheetStatus("Gemini API キーを入力してください", "error");
    return;
  }
  store.set("flashOnly", els.flashOnly.checked);
  const url = els.sheetUrl.value.trim();
  if (url !== store.get("sheetUrl", "")) {
    store.set("sheetUrl", url);
    loadSheet(url);
  }
  if (!els.sheetStatus.className.includes("error")) els.setup.hidden = true;
  setStatus("問題を撮影してください。");
};
els.sheetReload.onclick = () => loadSheet(els.sheetUrl.value.trim());

// ---- 履歴 (答えの文字だけをこのスマホに保存) ----
function addHistory(thumbUrl, answer, save = true) {
  const li = document.createElement("li");
  if (thumbUrl) {
    const im = document.createElement("img");
    im.src = thumbUrl;
    li.append(im);
  }
  const a = document.createElement("span");
  a.className = "a";
  a.textContent = stripSheetTag(answer).split("\n")[0];
  li.append(a);
  li.onclick = () => {
    renderAnswer(answer);
    showCompare(checkAgainstSheet(answer));
    setStatus("履歴から表示中");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  els.history.prepend(li);
  while (els.history.children.length > HISTORY_MAX) els.history.lastChild.remove();
  if (save) store.set("history", [{ answer }, ...store.get("history", [])].slice(0, HISTORY_MAX));
}

// ---- 解く ----
async function solve(job) {
  if (!apiKey) {
    els.setup.hidden = false;
    setSheetStatus("最初に Gemini API キーを設定してください", "error");
    return;
  }
  const seq = ++solveSeq;
  while (running) {
    if (seq !== solveSeq) return;
    controller?.abort();
    await running;
  }
  if (seq !== solveSeq) return;
  running = runSolve({ followUp: false, ...job }).finally(() => { running = null; });
  await running;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像を読み込めません"));
    img.src = url;
  });
}

// 撮った写真 (または選んだ写真) を解く。<img> で読み込むと、写真の向き (EXIF) どおりに回転される
async function solvePhoto(file) {
  if (!file) return;
  setStatus("写真を読み込んでいます…", "busy");
  let img;
  const url = URL.createObjectURL(file);
  try {
    img = await loadImage(url);
  } catch {
    URL.revokeObjectURL(url);
    setStatus("写真を読み込めませんでした (JPEG / PNG で試してください)", "error");
    return;
  }
  if (photo) URL.revokeObjectURL(photo.url);
  photo = { img, url };
  els.photoThumb.src = url;
  els.photoBox.hidden = false;
  await solveRegion(null);
}

async function solveRegion(r) {
  const { img } = photo;
  const W = img.naturalWidth, H = img.naturalHeight;
  const [sx, sy, sw, sh] = r
    ? [Math.round(r.x * W), Math.round(r.y * H), Math.max(1, Math.round(r.w * W)), Math.max(1, Math.round(r.h * H))]
    : [0, 0, W, H];
  warmConnection();
  const images = await makeImages(img, sx, sy, sw, sh);
  await solve({ text: "", images });
}

function warmConnection() {
  if (performance.now() - warmedAt < 20_000) return;
  warmedAt = performance.now();
  fetch(API_ORIGIN, { method: "HEAD", mode: "no-cors", cache: "no-store" }).catch(() => {});
}

els.cameraInput.onchange = () => { solvePhoto(els.cameraInput.files[0]); els.cameraInput.value = ""; };
els.photoInput.onchange = () => { solvePhoto(els.photoInput.files[0]); els.photoInput.value = ""; };
els.sendBtn.onclick = () => {
  const text = els.text.value.trim();
  if (!text) return;
  els.text.value = "";
  solve({ text, images: [] });
};
els.stopBtn.onclick = () => controller?.abort();

// ---- 範囲を選んで解き直す (指でなぞる) ----
let crop = null, dragStart = null;
function cropPoint(e) {
  const rect = els.cropImg.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  };
}
function showCropRect() {
  els.cropRect.hidden = !crop;
  if (!crop) return;
  const im = els.cropImg;
  Object.assign(els.cropRect.style, {
    left: im.offsetLeft + crop.x * im.clientWidth + "px",
    top: im.offsetTop + crop.y * im.clientHeight + "px",
    width: crop.w * im.clientWidth + "px",
    height: crop.h * im.clientHeight + "px",
  });
}
els.cropBtn.onclick = () => {
  if (!photo) return;
  crop = null;
  els.cropImg.src = photo.url;
  els.cropModal.hidden = false;
  showCropRect();
};
els.cropStage.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dragStart = cropPoint(e);
  els.cropStage.setPointerCapture(e.pointerId);
});
els.cropStage.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = cropPoint(e);
  crop = { x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y), w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y) };
  showCropRect();
});
els.cropStage.addEventListener("pointerup", () => {
  dragStart = null;
  if (crop && (crop.w < 0.03 || crop.h < 0.03)) crop = null;
  showCropRect();
});
els.cropCancel.onclick = () => { els.cropModal.hidden = true; };
els.cropDone.onclick = () => {
  els.cropModal.hidden = true;
  solveRegion(crop);
};

loadSettings();
warmConnection();
