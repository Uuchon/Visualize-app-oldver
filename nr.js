// ============================================================
// nr.js — ノイズ除去の共通部品（PC版 sketch.js / スマホ版 m.js の両方が使う）
//
//  録音ファイルの除去も、マイクのリアルタイム除去も、同じ計算（NRStream）を通します。
//    1) 雑音プロファイル: 2048点Hann窓FFTの「各周波数ビンの雑音の大きさ(平均振幅)」
//    2) ゲイン: g = max(1 − 強さ×|N|/|X|, 床)   → 周波数・時間方向に平滑化
//    3) 逆FFTして重ね合わせ（窓 Hann, hop=512）
//  設定（強さ・床）は NRCFG を共有します。
// ============================================================
'use strict';
const NR_N = 2048;
const NR_HOP = 512;
const NRCFG = { alpha: 1.8, beta: 0.05 };            // 強さ・床（録音もマイクも共通）

class NRFFT {
  constructor(N) {
    this.N = N;
    this.rev = new Uint16Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) { if (i & (1 << b)) { r |= 1 << (bits - 1 - b); } } this.rev[i] = r; }
    this.cos = new Float32Array(N / 2); this.sin = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) { this.cos[k] = Math.cos(2 * Math.PI * k / N); this.sin[k] = -Math.sin(2 * Math.PI * k / N); }
  }
  run(re, im, inverse) {
    const N = this.N, rev = this.rev;
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = inverse ? -this.sin[k] : this.sin[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) { for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; } }
  }
}

// ストリーム処理: 任意の長さのブロックを入れると、約 NR_N サンプル遅れて除去後の音が出てくる。
//  prof=null、または on=false のときは素通し（遅延も同じだけ入れて、ON/OFFで音がずれないようにする）
class NRStream {
  constructor() {
    const N = 2048, H = 512, bins = N / 2 + 1;
    this.N = N; this.H = H; this.bins = bins;
    this.fft = new NRFFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); }
    this.inb = new Float32Array(N); this.inPos = 0; this.cnt = 0;          // 入力リング
    this.dry = new Float32Array(N * 2); this.dryPos = 0;                   // 素通し用の遅延線
    this.acc = new Float32Array(N); this.fifo = new Float32Array(N * 8); this.fr = 0; this.fw = 0; this.fn = 0;
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.g = new Float32Array(bins); this.gs = new Float32Array(bins); this.gPrev = new Float32Array(bins).fill(1);
    this.prof = null; this.alpha = 1.8; this.beta = 0.05; this.on = false;
    this.learnSum = null; this.learnN = 0; this.learning = false;
    this.norm = 1.5;                                                        // Hann窓×Hann窓, hop=N/4 の重なり合計
  }
  setProfile(p) { this.prof = p && p.length === this.bins ? Float32Array.from(p) : null; this.gPrev.fill(1); }
  learnStart() { this.learnSum = new Float64Array(this.bins); this.learnN = 0; this.learning = true; }
  learnFinish() {
    this.learning = false;
    if (!this.learnSum || this.learnN < 8) { return null; }
    const raw = Float32Array.from(this.learnSum, v => v / this.learnN), b = this.bins, sm = new Float32Array(b);
    for (let i = 0; i < b; i++) { sm[i] = (raw[Math.max(0, i - 1)] + 2 * raw[i] + raw[Math.min(b - 1, i + 1)]) / 4; }
    this.learnSum = null; return sm;
  }
  _frame() {
    const { N, H, bins, re, im, win, g, gs, gPrev } = this;
    for (let i = 0; i < N; i++) { re[i] = this.inb[(this.inPos + i) % N] * win[i]; im[i] = 0; }
    this.fft.run(re, im, false);
    if (this.learning) {
      for (let b = 0; b < bins; b++) { this.learnSum[b] += Math.sqrt(re[b] * re[b] + im[b] * im[b]); }
      this.learnN++;
    }
    if (this.on && this.prof) {
      const prof = this.prof, alpha = this.alpha, beta = this.beta;
      for (let b = 0; b < bins; b++) {
        const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]) + 1e-12;
        g[b] = Math.max(1 - alpha * prof[b] / m, beta);
      }
      for (let b = 0; b < bins; b++) {                                      // 周波数・時間方向の平滑化（ミュージカルノイズ対策）
        const s = (g[Math.max(0, b - 1)] + 2 * g[b] + g[Math.min(bins - 1, b + 1)]) / 4;
        gs[b] = 0.6 * s + 0.4 * gPrev[b]; gPrev[b] = gs[b];
      }
      for (let k = 0; k < N; k++) { const gb = gs[k <= N / 2 ? k : N - k]; re[k] *= gb; im[k] *= gb; }
      this.fft.run(re, im, true);
      for (let i = 0; i < N; i++) { this.acc[i] += re[i] * win[i]; }
    } else {
      this.fft.run(re, im, true);                                           // 素通し（窓を2回かけて重ねるだけ）
      for (let i = 0; i < N; i++) { this.acc[i] += re[i] * win[i]; }
      this.gPrev.fill(1);
    }
    const FN = this.fifo.length;
    for (let i = 0; i < H; i++) { this.fifo[this.fw] = this.acc[i] / this.norm; this.fw = (this.fw + 1) % FN; this.fn++; }
    this.acc.copyWithin(0, H); this.acc.fill(0, N - H);
  }
  // x を処理して y に書く（同じ長さ）。x と y は同じ配列でもよい
  process(x, y) {
    const N = this.N, H = this.H, FN = this.fifo.length;
    for (let i = 0; i < x.length; i++) {
      this.inb[this.inPos] = x[i]; this.inPos = (this.inPos + 1) % N;        // inPos は「最も古い」位置
      if (++this.cnt === H) { this.cnt = 0; this._frame(); }
      if (this.fn > 0) { y[i] = this.fifo[this.fr]; this.fr = (this.fr + 1) % FN; this.fn--; } else { y[i] = 0; }
    }
  }
}

// ---------- 雑音プロファイルの扱い ----------
const profDb = m => 20 * Math.log10(m + 1e-10) - 20 * Math.log10(NR_N / 4);         // 平均振幅 → dBFS
// プロファイル(sr基準)を、別のサンプリング周波数 srTo の同じビン数に直す
function nrResampleProfile(prof, srFrom, srTo) {
  if (!prof || srFrom === srTo) { return prof; }
  const bins = prof.length, out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const f = b * srTo / NR_N, x = f * NR_N / srFrom;
    const i = Math.floor(x), t = x - i;
    out[b] = x >= bins - 1 ? 0 : prof[i] * (1 - t) + prof[i + 1] * t;
  }
  return out;
}
// プロファイルを、AnalyserNode のビン(0〜255のバイト値, -100〜-30 dBFS)へ（画面の重ね描き用）
function nrProfBytes(prof, sr, nBins, ctxSr) {
  const out = new Array(nBins);
  for (let i = 0; i < nBins; i++) {
    const f = i * (ctxSr / 2) / nBins, x = Math.min(prof.length - 1.001, f * NR_N / sr), j = Math.floor(x), t = x - j;
    const m = prof[j] * (1 - t) + prof[j + 1] * t, db = profDb(m);
    out[i] = Math.max(0, Math.min(255, Math.round((db + 100) / 100 * 255)));
  }
  return out;
}

// ---------- 録音ファイル用（オフライン） ----------
const NRO = { fft: null, win: null };
function nrInit() {
  if (NRO.fft) { return; }
  NRO.fft = new NRFFT(NR_N); NRO.win = new Float32Array(NR_N);
  for (let i = 0; i < NR_N; i++) { NRO.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NR_N); }
}
function nrFrameMag(x, p, re, im, mag) {
  const N = NR_N, bins = N / 2 + 1;
  for (let i = 0; i < N; i++) { re[i] = x[p + i] * NRO.win[i]; im[i] = 0; }
  NRO.fft.run(re, im, false);
  for (let b = 0; b < bins; b++) { mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]); }
}
// 録音から雑音プロファイルを推定。戻り値 {prof, method}
//   head: 冒頭0.5秒の平均 / auto: 静かな区間があればその平均、なければ各周波数の下位20%
function nrEstimateProfile(x, sr, mode, hop) {
  nrInit();
  const N = NR_N, bins = N / 2 + 1, nF = Math.floor((x.length - N) / hop) + 1;
  if (nF < 4) { return null; }
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(bins), prof = new Float32Array(bins);
  let method = '';
  if (mode === 'head') {
    const n = Math.min(nF, Math.max(4, Math.floor(0.5 * sr / hop)));
    for (let f = 0; f < n; f++) { nrFrameMag(x, f * hop, re, im, mag); for (let b = 0; b < bins; b++) { prof[b] += mag[b]; } }
    for (let b = 0; b < bins; b++) { prof[b] /= n; }
    method = '冒頭0.5秒';
  } else {
    const e = new Float32Array(nF);
    for (let f = 0; f < nF; f++) { let s = 0; const p = f * hop; for (let i = 0; i < N; i += 8) { s += x[p + i] * x[p + i]; } e[f] = s; }
    const cand = []; for (let f = 0; f < nF; f++) { if (e[f] > 1e-9) { cand.push(f); } }
    const pool = cand.length >= 8 ? cand : Array.from({ length: nF }, (_, i) => i);
    pool.sort((a, b) => e[a] - e[b]);
    const nq = Math.max(8, Math.floor(pool.length * 0.1)), nl = Math.max(8, Math.floor(pool.length * 0.3));
    let qe = 0, le = 0;
    for (let i = 0; i < nq; i++) { qe += e[pool[i]]; }
    for (let i = 0; i < nl; i++) { le += e[pool[pool.length - 1 - i]]; }
    const contrast = 10 * Math.log10((le / nl + 1e-12) / (qe / nq + 1e-12));
    if (contrast >= 12) {
      for (let i = 0; i < nq; i++) { nrFrameMag(x, pool[i] * hop, re, im, mag); for (let b = 0; b < bins; b++) { prof[b] += mag[b]; } }
      for (let b = 0; b < bins; b++) { prof[b] /= nq; }
      method = '静かな区間の平均';
    } else {
      const step = Math.max(1, Math.floor(nF / 400)), sel = [];
      for (let f = 0; f < nF; f += step) { sel.push(f); }
      const M = sel.length, mags = new Float32Array(M * bins);
      for (let k = 0; k < M; k++) { nrFrameMag(x, sel[k] * hop, re, im, mag); mags.set(mag, k * bins); }
      const col = new Float32Array(M), q = Math.floor(M * 0.2);
      for (let b = 0; b < bins; b++) { for (let k = 0; k < M; k++) { col[k] = mags[k * bins + b]; } col.sort(); prof[b] = col[q] * 1.6; }
      // 鳴りっぱなしの音（一定のトーン・楽器の持続音）は、雑音と区別できず一緒に消えてしまう。
      // そこで、細い山（周りの中央値の1.5倍を超える部分）は雑音とみなさず、広い帯域にわたる雑音の床だけを雑音とする。
      const W = 20, win = new Float32Array(2 * W + 1), clipped = new Float32Array(bins);
      for (let b = 0; b < bins; b++) {
        let n = 0;
        for (let k = Math.max(0, b - W); k <= Math.min(bins - 1, b + W); k++) { win[n++] = prof[k]; }
        const part = win.subarray(0, n).slice().sort(), med = part[n >> 1];
        clipped[b] = Math.min(prof[b], med * 1.5);
      }
      prof.set(clipped);
      method = '周波数ごとの下位20%（持続する音は雑音にしない）';
    }
  }
  const sm = new Float32Array(bins);
  for (let b = 0; b < bins; b++) { sm[b] = (prof[Math.max(0, b - 1)] + 2 * prof[b] + prof[Math.min(bins - 1, b + 1)]) / 4; }
  return { prof: sm, method };
}
// 1チャンネルを除去（マイクと同じ NRStream で計算する）。onProgress(0..1), cancelled() → true で中止（null を返す）
async function nrDenoiseChannel(x, prof, alpha, beta, onProgress, cancelled) {
  const st = new NRStream(); st.setProfile(prof); st.alpha = alpha; st.beta = beta; st.on = true;
  const len = x.length, lag = st.N, y = new Float32Array(len), CH = 8192;
  const outBuf = new Float32Array(CH);
  let wrote = 0, fed = 0, k = 0;
  const total = len + lag;
  while (fed < total) {
    const n = Math.min(CH, total - fed), inp = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = fed + i; inp[i] = j < len ? x[j] : 0; }      // 最後に無音を足して、遅れ分を押し出す
    const o = outBuf.subarray(0, n); st.process(inp, o);
    for (let i = 0; i < n; i++) { const j = fed + i - lag; if (j >= 0 && j < len) { y[j] = o[i]; } }
    fed += n;
    if (++k % 40 === 0) { onProgress(fed / total); await new Promise(r => setTimeout(r, 0)); if (cancelled()) { return null; } }
  }
  return y;
}

// ---------- マイク用（リアルタイム） ----------
// 戻り値: { node: 入力を受けて除去後を出すAudioNode, raw: 除去前を見る AnalyserNode, st?: (ScriptProcessor時のみ),
//           setProfile(p,sr), setOn(b), setStrength(a,b), learnStart(), learnFinish() → Promise<Float32Array|null> }
async function nrCreateLive(ctx) {
  const WSRC = `${NRFFT.toString()}\n${NRStream.toString()}
class NRProc extends AudioWorkletProcessor {
  constructor() { super(); this.st = new NRStream(); this.port.onmessage = e => this.msg(e.data); }
  msg(m) {
    const s = this.st;
    if (m.t === 'prof') { s.setProfile(m.p); } else if (m.t === 'on') { s.on = m.v; } else if (m.t === 'par') { s.alpha = m.a; s.beta = m.b; }
    else if (m.t === 'ls') { s.learnStart(); } else if (m.t === 'lf') { const p = s.learnFinish(); this.port.postMessage({ t: 'prof', p }, p ? [p.buffer] : []); }
  }
  process(inputs, outputs) {
    const i = inputs[0] && inputs[0][0], o = outputs[0] && outputs[0][0];
    if (!o) { return true; }
    if (!i) { o.fill(0); return true; }
    this.st.process(i, o);
    for (let c = 1; c < outputs[0].length; c++) { outputs[0][c].set(o); }
    return true;
  }
}
registerProcessor('nrproc', NRProc);`;
  const raw = ctx.createAnalyser(); raw.fftSize = 2048; raw.smoothingTimeConstant = 0.8; raw.minDecibels = -100; raw.maxDecibels = 0;
  const api = { raw, kind: '', sr: ctx.sampleRate, prof: null, profSr: ctx.sampleRate, resolveLearn: null };
  let useWorklet = false;
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([WSRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'nrproc', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = e => { if (e.data.t === 'prof' && api.resolveLearn) { api.resolveLearn(e.data.p); api.resolveLearn = null; } };
      api.node = node; api.kind = 'worklet';
      api._post = m => node.port.postMessage(m);
      useWorklet = true;
    } catch (e) { useWorklet = false; }
  }
  if (!useWorklet) {                                           // file:// など、Workletが使えない環境
    const sp = ctx.createScriptProcessor(4096, 1, 1), st = new NRStream();
    sp.onaudioprocess = e => { st.process(e.inputBuffer.getChannelData(0), e.outputBuffer.getChannelData(0)); };
    api.node = sp; api.st = st; api.kind = 'script';
    api._post = m => {
      if (m.t === 'prof') { st.setProfile(m.p); } else if (m.t === 'on') { st.on = m.v; } else if (m.t === 'par') { st.alpha = m.a; st.beta = m.b; }
      else if (m.t === 'ls') { st.learnStart(); } else if (m.t === 'lf') { const p = st.learnFinish(); if (api.resolveLearn) { api.resolveLearn(p); api.resolveLearn = null; } }
    };
  }
  const zero = ctx.createGain(); zero.gain.value = 0; api.node.connect(zero); zero.connect(ctx.destination);   // 処理を止めさせないため
  api.setProfile = (p, sr) => {
    const q = p ? nrResampleProfile(p, sr || ctx.sampleRate, ctx.sampleRate) : null;
    api.prof = q; api.profSr = ctx.sampleRate; api._post({ t: 'prof', p: q ? Float32Array.from(q) : null });
  };
  api.setOn = v => api._post({ t: 'on', v: !!v });
  api.setStrength = (a, b) => api._post({ t: 'par', a, b });
  api.learnStart = () => api._post({ t: 'ls' });
  api.learnFinish = () => new Promise(res => { api.resolveLearn = res; api._post({ t: 'lf' }); });
  api.setStrength(NRCFG.alpha, NRCFG.beta);
  return api;
}
if (typeof module !== 'undefined') { module.exports = { NRFFT, NRStream, nrEstimateProfile, nrDenoiseChannel, nrResampleProfile, profDb, NRCFG }; }
