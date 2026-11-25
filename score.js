// ================= 色譜（カラースコア） =================
// 時系列ログ(LOG.rec)を、楽譜のように1枚の画像にする。リゲティ《アルティキュラツィオン》の聴取楽譜のように、
// 時間を左→右、段(行)ごとに折り返して並べる。
//   ・最上段の帯          … その瞬間の色（色相=重心/F0・彩度=純音らしさ・明度=大きさ）
//   ・横棒                … 縦位置=スペクトル重心(標準)の周波数(対数) / 太さ=大きさ(明度) / 色=その瞬間の色
//   ・小さな黒い点        … いちばん強い周波数（主要周波数）
//   ・ふち取りのかたまり  … 「音のまとまり」（途切れずに続く区間）。番号つき
//   ・下段の灰色の棒      … 純音らしさ（高い=純音的 / 低い=ノイズ的）
// 世界地図に載せるときは、buildEventsJson() の「音のまとまり」ごとの代表色・特徴量を使う。
(function () {
  const BG = '#ffffff', INK = '#2d3436', MUT = '#8395a7', GRID = '#e6eaee', BLOB = '#efe7df';
  const F_LO = 50, F_HI = 10000;                      // 縦軸（対数）

  const num = (v, d) => (Number.isFinite(v) ? v : (d || 0));
  const hex2 = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtT = s => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return String(m).padStart(2, '0') + ':' + (r < 10 ? '0' : '') + r.toFixed(r % 1 ? 1 : 0); };
  const median = a => { if (!a.length) { return 0; } const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // 「音のまとまり」: active が続く区間（gap 秒以内の途切れは同じまとまりとみなす）
  function findEvents(recs, gap) {
    gap = gap || 0.35;
    const ev = []; let cur = null;
    for (const r of recs) {
      if (!r.act) { continue; }
      if (cur && r.t - cur.last <= gap) { cur.recs.push(r); cur.last = r.t; }
      else { cur = { recs: [r], last: r.t }; ev.push(cur); }
    }
    return ev.map((e, i) => {
      const rs = e.recs, a = rs[0].t, b = rs[rs.length - 1].t;
      // 代表色: 色相は円環平均、彩度・明度は平均
      let sx = 0, sy = 0, ss = 0, sb = 0, sr = [0, 0, 0];
      for (const r of rs) {
        const th = num(r.hue) * Math.PI / 180; sx += Math.cos(th); sy += Math.sin(th);
        ss += num(r.sat); sb += num(r.bi);
        for (let k = 0; k < 3; k++) { sr[k] += num(r.ci && r.ci[k]); }
      }
      const n = rs.length, hue = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
      const rgb = sr.map(v => v / n);
      return {
        id: i + 1, a, b, dur: b - a, n,
        hue, sat: ss / n, bri: sb / n, rgb, hex: hex2(rgb),
        cen: median(rs.map(r => num(r.cen))), dom: median(rs.map(r => num(r.dom))),
        flatStd: rs.reduce((s, r) => s + num(r.fs), 0) / n, flatUsed: rs.reduce((s, r) => s + num(r.flat), 0) / n,
        loLo: Math.min(...rs.map(r => num(r.cen, 1))), hiHi: Math.max(...rs.map(r => num(r.cen, 1))),
        spl: rs.reduce((s, r) => s + num(r.spl), 0) / n,
      };
    });
  }

  function niceStep(sec) { for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) { if (sec / s <= 14) { return s; } } return 600; }

  // opts: { title, lines:[...], rowSec, width, recs }
  function render(recs, opts) {
    opts = opts || {};
    const rec = recs.filter(r => Number.isFinite(r.t));
    const W = opts.width || 2000, M = 70, LBL = 62, TOP = 150;
    const t0 = rec.length ? rec[0].t : 0, t1 = rec.length ? rec[rec.length - 1].t : 1;
    const dur = Math.max(0.5, t1 - t0);
    let rowSec = opts.rowSec || clamp(Math.ceil(dur / 10), 10, 30);
    rowSec = Math.max(rowSec, dur / 24);                       // 最大24段
    if (rec.length && dur < rowSec) { rowSec = Math.ceil(dur); }
    const rows = Math.max(1, Math.ceil(dur / rowSec - 1e-9));
    const RIB = 16, FIELD = 170, FL = 26, GAPY = 46, ROWH = RIB + 8 + FIELD + 8 + FL + GAPY;
    const H = TOP + rows * ROWH + 40;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    const T = (s, x, y, size, col, bold, align) => { g.font = (bold ? '700 ' : '400 ') + size + 'px "Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif'; g.fillStyle = col || INK; g.textAlign = align || 'left'; g.fillText(s, x, y); };

    // ---- タイトル ----
    T(opts.title || 'WAVE LAB 色譜（カラースコア）', M, 64, 44, INK, true);
    const lines = opts.lines || [];
    lines.forEach((s, i) => T(s, M, 96 + i * 20, 14, MUT));
    // ---- 凡例 ----
    const lx = W - M - 640, ly = 34;
    g.strokeStyle = '#c8d0d8'; g.lineWidth = 1; g.strokeRect(lx, ly, 640, 96);
    T('読み方', lx + 10, ly + 20, 13, INK, true);
    const L = (i, s) => T(s, lx + 12 + (i % 2) * 318, ly + 42 + Math.floor(i / 2) * 20, 12, INK);
    L(0, '最上段の帯 = その瞬間の色'); L(1, '横棒の高さ = 周波数(重心)'); L(2, '横棒の太さ = 大きさ'); L(3, '黒い点 = いちばん強い周波数');
    L(4, 'ふち取り = 音のまとまり(番号)'); L(5, '下段の灰色 = 純音らしさ(高い=純音)');

    const events = findEvents(rec, opts.gap);
    const fy = (f, y0) => y0 + FIELD - clamp((Math.log10(clamp(f, F_LO, F_HI)) - Math.log10(F_LO)) / (Math.log10(F_HI) - Math.log10(F_LO)), 0, 1) * FIELD;
    const iw = W - M - LBL - M;                                     // 1段の横幅
    const px = sec => LBL + M + (sec / rowSec) * iw;

    for (let r = 0; r < rows; r++) {
      const ra = t0 + r * rowSec, rb = ra + rowSec;
      const y0 = TOP + r * ROWH + RIB + 8;                          // 主領域の上端
      const yR = TOP + r * ROWH;                                    // 色の帯の上端
      const yF = y0 + FIELD + 8;                                    // 純音らしさの上端
      // 段のラベル
      T(fmtT(ra - t0), LBL + M - 8, yR + 12, 12, MUT, true, 'right');
      // 周波数のグリッド
      g.strokeStyle = GRID; g.lineWidth = 1; g.fillStyle = MUT;
      for (const f of [100, 1000, 10000]) { const y = fy(f, y0); g.beginPath(); g.moveTo(LBL + M, y); g.lineTo(LBL + M + iw, y); g.stroke(); T(f >= 1000 ? (f / 1000) + 'k' : String(f), LBL + M - 8, y + 4, 11, MUT, false, 'right'); }
      // 段の枠
      g.strokeStyle = '#c8d0d8'; g.strokeRect(LBL + M, y0 - 2, iw, FIELD + 4);
      // 時間目盛り
      const st = niceStep(rowSec);
      for (let s = Math.ceil((ra - t0) / st) * st; s <= (rb - t0) + 1e-9; s += st) {
        const x = px(s - (ra - t0)); g.strokeStyle = '#d5dbe1'; g.beginPath(); g.moveTo(x, yF + FL + 2); g.lineTo(x, yF + FL + 7); g.stroke();
        if (Math.abs((s / st) % 2) < 1e-9 || st >= 10) { T(fmtT(s), x, yF + FL + 20, 11, MUT, false, 'center'); }
      }
      // 音のまとまり（ふち取り）
      for (const e of events) {
        const ea = Math.max(e.a, ra), eb = Math.min(e.b, rb); if (eb < ea) { continue; }
        const inRow = e.recs ? null : null; void inRow;
        const x1 = px(ea - ra) - 6, x2 = px(eb - ra) + 6;
        const yA = fy(e.hiHi, y0) - 10, yB = fy(e.loLo, y0) + 10;
        g.fillStyle = BLOB; g.strokeStyle = e.hex; g.lineWidth = 1.5;
        g.beginPath();
        if (g.roundRect) { g.roundRect(x1, Math.max(y0 - 2, yA), Math.max(10, x2 - x1), Math.min(y0 + FIELD + 2, yB) - Math.max(y0 - 2, yA), 12); } else { g.rect(x1, yA, x2 - x1, yB - yA); }
        g.globalAlpha = 0.55; g.fill(); g.globalAlpha = 0.9; g.stroke(); g.globalAlpha = 1;
        if (ea === e.a) { T(String(e.id), x1 + 3, Math.max(y0 + 10, yA - 3), 11, e.hex, true); }
      }
      // 各フレーム
      const dt = rec.length > 1 ? Math.max(0.02, median(rec.slice(1, 200).map((q, i) => q.t - rec[i].t))) : 0.05;
      const bw = Math.max(1.2, dt / rowSec * iw + 0.6);
      for (const q of rec) {
        if (q.t < ra || q.t >= rb) { continue; }
        const x = px(q.t - ra);
        // 色の帯（音が出ていない所は灰色）
        g.fillStyle = q.act && q.ci ? hex2(q.ci) : '#e9edf0'; g.fillRect(x, yR, bw, RIB);
        if (!q.act) { continue; }
        // 横棒（重心の高さ・太さ=明度）
        const th = 2 + clamp((num(q.bi) - 42) / 58, 0, 1) * 12;
        g.fillStyle = hex2(q.ci); g.globalAlpha = 0.92;
        g.fillRect(x, fy(q.cen, y0) - th / 2, bw, th); g.globalAlpha = 1;
        // 主要周波数の点
        g.fillStyle = 'rgba(45,52,54,.75)'; g.fillRect(x, fy(q.dom, y0) - 0.8, Math.max(1, bw * 0.8), 1.6);
        // 純音らしさ
        g.fillStyle = '#a4b0be'; const h = clamp(num(q.sat) / 100, 0, 1) * FL; g.fillRect(x, yF + FL - h, bw, h);
      }
      g.strokeStyle = '#e1e6ea'; g.beginPath(); g.moveTo(LBL + M, yF + FL + 0.5); g.lineTo(LBL + M + iw, yF + FL + 0.5); g.stroke();
      if (r === 0) { T('純音らしさ', LBL + M - 8, yF + FL - 6, 10, MUT, false, 'right'); }
    }
    T('WAVE LAB — 音の物理的特徴から色へ', M, H - 14, 11, MUT);
    T(new Date().toLocaleString('ja-JP'), W - M, H - 14, 11, MUT, false, 'right');
    return { canvas: cv, events };
  }


  // ---- 色キャンバス: 色と時間軸だけ。時系列ヒストリーをそのまま1枚の絵にする ----
  // opts: { rowSec, width, rowH, smooth(px), caption, labels(true/false) }
  function renderCanvas(recs, opts) {
    opts = opts || {};
    const rec = recs.filter(r => Number.isFinite(r.t));
    const W = opts.width || 2400, M = opts.labels === false ? 0 : 90, ROWH = opts.rowH || 130, GAP = 10, PAPER = [244, 241, 236];
    const t0 = rec.length ? rec[0].t : 0, t1 = rec.length ? rec[rec.length - 1].t : 1;
    const dur = Math.max(0.5, t1 - t0);
    let rowSec = opts.rowSec || clamp(Math.ceil(dur / 6), 10, 60);
    rowSec = Math.max(rowSec, dur / 30);
    if (dur < rowSec) { rowSec = Math.ceil(dur); }
    const rows = Math.max(1, Math.ceil(dur / rowSec - 1e-9));
    const iw = W - M - 40, TOPM = 30, BOTM = opts.caption === false ? 20 : 46;
    const labelH = opts.labels === false ? 0 : 20;
    const H = TOPM + rows * (ROWH + GAP + labelH) + BOTM;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    const T = (s, x, y, size, col, align) => { g.font = size + 'px "Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif'; g.fillStyle = col || MUT; g.textAlign = align || 'left'; g.fillText(s, x, y); };
    const dt = rec.length > 1 ? Math.max(0.02, median(rec.slice(1, 200).map((q, i) => q.t - rec[i].t))) : 0.05;
    const reach = Math.max(dt * 1.6, 0.12);                       // この秒数より離れたフレームは「無音」として紙の色
    const st = niceStep(rowSec);
    let k0 = 0;                                                   // rec は時間順: 走査位置
    for (let r = 0; r < rows; r++) {
      const ra = t0 + r * rowSec, y = TOPM + r * (ROWH + GAP + labelH);
      // 1ピクセル列ごとに、その時間幅に入るフレームの色を平均する
      const cols = Math.max(1, Math.floor(iw)), col = new Float32Array(cols * 3), has = new Uint8Array(cols);
      const secPerPx = rowSec / cols;
      for (let x = 0; x < cols; x++) {
        const a = ra + x * secPerPx, b = a + secPerPx; let sr = 0, sg = 0, sb = 0, n = 0;
        // a-reach〜b+reach に入る active フレームの平均（細い列でも色が途切れないように）
        for (let k = k0; k < rec.length; k++) {
          const q = rec[k]; if (q.t < a - reach) { k0 = k; continue; } if (q.t > b + reach) { break; }
          if (!q.act || !q.ci) { continue; }
          const w = (q.t >= a && q.t <= b) ? 1 : 0.35;
          sr += q.ci[0] * w; sg += q.ci[1] * w; sb += q.ci[2] * w; n += w;
        }
        if (n > 0) { col[x * 3] = sr / n; col[x * 3 + 1] = sg / n; col[x * 3 + 2] = sb / n; has[x] = 1; }
      }
      // 軽くぼかして、絵の具のようになめらかに（無音の境界は保つ）
      const sm = opts.smooth === undefined ? 3 : opts.smooth;
      const img = g.createImageData(cols, 1);
      for (let x = 0; x < cols; x++) {
        let sr = 0, sg = 0, sb = 0, n = 0;
        if (has[x]) { for (let d = -sm; d <= sm; d++) { const j = x + d; if (j >= 0 && j < cols && has[j]) { sr += col[j * 3]; sg += col[j * 3 + 1]; sb += col[j * 3 + 2]; n++; } } }
        const c = n ? [sr / n, sg / n, sb / n] : PAPER;
        img.data[x * 4] = c[0]; img.data[x * 4 + 1] = c[1]; img.data[x * 4 + 2] = c[2]; img.data[x * 4 + 3] = 255;
      }
      const tmp = document.createElement('canvas'); tmp.width = cols; tmp.height = 1; tmp.getContext('2d').putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false; g.drawImage(tmp, M, y, cols, ROWH);
      if (opts.labels !== false) {
        T(fmtT(ra - t0), M - 10, y + 14, 12, MUT, 'right');
        g.strokeStyle = '#c8d0d8'; g.lineWidth = 1;
        for (let s = Math.ceil((ra - t0) / st) * st; s <= (ra - t0) + rowSec + 1e-9; s += st) {
          const x = M + ((s - (ra - t0)) / rowSec) * cols; g.beginPath(); g.moveTo(x, y + ROWH); g.lineTo(x, y + ROWH + 5); g.stroke();
          if (st >= 5 || Math.abs((s / st) % 2) < 1e-9) { T(fmtT(s), x, y + ROWH + 17, 11, MUT, 'center'); }
        }
      }
    }
    if (opts.caption !== false) { T(opts.caption || 'WAVE LAB', M, H - 16, 12, MUT); T(new Date().toLocaleString('ja-JP'), W - 40, H - 16, 12, MUT, 'right'); }
    return { canvas: cv };
  }

  // 世界地図に載せるときのためのデータ（音のまとまりごと）
  function buildEventsJson(recs, meta) {
    const rec = recs.filter(r => Number.isFinite(r.t));
    const ev = findEvents(rec);
    return JSON.stringify({
      app: 'WAVE LAB', kind: 'sound-color-events', version: 1,
      saved_at: new Date().toISOString(),
      place: (meta && meta.place) || '', lat: meta && meta.lat !== undefined ? meta.lat : null, lon: meta && meta.lon !== undefined ? meta.lon : null,
      meta: meta || {},
      duration_s: rec.length ? +(rec[rec.length - 1].t - rec[0].t).toFixed(3) : 0,
      events: ev.map(e => ({
        id: e.id, start_s: +e.a.toFixed(3), end_s: +e.b.toFixed(3), duration_s: +e.dur.toFixed(3), frames: e.n,
        color: { hex: e.hex, hue_deg: +e.hue.toFixed(1), saturation_pct: +e.sat.toFixed(1), brightness_pct: +e.bri.toFixed(1) },
        centroid_hz_median: +e.cen.toFixed(1), dominant_hz_median: +e.dom.toFixed(1),
        flatness_std_db_mean: +e.flatStd.toFixed(2), flatness_used_db_mean: +e.flatUsed.toFixed(2), spl_db_mean: +e.spl.toFixed(1),
      })),
    }, null, 2);
  }

  window.WL_VERSION = 'Ver1';
  // 公開する機能のスイッチ。今回の卒論版(Ver1)では隠すもの。コードは残してあるので、true にすれば画面に戻る。
  window.WL_FEATURES = { eventsJson: false };
  window.WLScore = { render, renderCanvas, buildEventsJson, findEvents };
})();
