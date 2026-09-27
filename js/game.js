(() => {
  'use strict';

  // ---------- 基础设置 ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = 320;
  const H = 480;
  canvas.width = W;
  canvas.height = H;

  const GROUND_Y = H - 52;
  const BOMB_X = 92;
  const BOMB_R = 12;
  const READY_Y = 208;
  const GRAVITY = 1500;
  const JUMP_V = -330;
  const PULL_TIME = 0.16;
  const NUKE_TAIL_X = 16; // 尾部喷口（机体局部坐标，-x 方向）
  const NUKE_TOP_Y = 12; // 机体半高，用于磁力场连接

  const PAL = {
    skyTop: '#0f1b3d',
    skyMid: '#2c3a6e',
    skyLow: '#7c4a8a',
    skyHorizon: '#e07a5f',
    skyline: '#1a2440',
    building: '#24355c',
    buildingDark: '#182642',
    windowLit: '#ffd166',
    windowDim: '#31436e',
    roof: '#3a4d7d',
    outline: '#0d1626',
    groundTop: '#2b2b3d',
    groundEdge: '#3a3a4f',
    road: '#14141f',
    dash: '#ffd166',
  };

  // ---------- DOM ----------
  const shakeWrap = document.getElementById('shakeWrap');
  const flashEl = document.getElementById('flash');
  const flashFullEl = document.getElementById('flashFull');
  const boomCanvas = document.getElementById('boomArt');
  const resultEl = document.getElementById('result');
  const finalScoreEl = document.getElementById('finalScore');
  const bestScoreEl = document.getElementById('bestScore');
  const newRecordEl = document.getElementById('newRecord');
  const restartBtn = document.getElementById('restartBtn');
  const muteBtn = document.getElementById('muteBtn');

  // ---------- 状态 ----------
  const state = {
    mode: 'ready', // ready | play | dead | over
  };

  let score = 0;
  let best = parseInt(storageGet('nukeBirdBest') || '0', 10) || 0;
  let elapsed = 0;
  let speed = 128;
  let gapSize = 122;
  let spawnDist = 208;
  let level = 1;
  let deadT = 0;
  let scorePop = 0;
  let time = 0;
  let groundOff = 0;
  let distantOff = 0;
  let rotorAngle = 0;
  let exhaustAcc = 0;

  const bomb = { y: READY_Y, vy: 0, rot: 0, pullT: 0 };
  const heli = { x: BOMB_X + 4, y: READY_Y - 46 };

  let buildings = [];
  let particles = [];
  let shocks = [];
  let mush = null;

  // ---------- 音效 ----------
  let audioCtx = null;
  let muted = storageGet('nukeBirdMuted') === '1';
  muteBtn.textContent = muted ? '🔇' : '🔊';

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    if (muted) return;
    ensureAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + (delay || 0);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    gain.gain.setValueAtTime(vol || 0.1, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function sfxTap() {
    tone(220, 0.11, 'square', 0.07, 560);
  }

  function sfxScore() {
    tone(660, 0.07, 'square', 0.07, null, 0);
    tone(990, 0.09, 'square', 0.07, null, 0.07);
  }

  function sfxBoom() {
    if (muted) return;
    ensureAudio();
    if (!audioCtx) return;
    const dur = 0.7;
    const len = Math.floor(audioCtx.sampleRate * dur);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 720;
    const g = audioCtx.createGain();
    g.gain.value = 0.35;
    src.connect(filter);
    filter.connect(g);
    g.connect(audioCtx.destination);
    src.start();
    tone(130, 0.55, 'sawtooth', 0.18, 38, 0);
  }

  // ---------- 小工具 ----------
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* 沙盒环境可能禁用 localStorage */
    }
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  function lerpColor(c1, c2, t) {
    const a = hexToRgb(c1);
    const b = hexToRgb(c2);
    return `rgb(${mix(a[0], b[0], t)},${mix(a[1], b[1], t)},${mix(a[2], b[2], t)})`;
  }

  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const nx = clamp(cx, rx, rx + rw);
    const ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  function pixelEllipse(g, cx, cy, rx, ry, color) {
    g.fillStyle = color;
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
        if ((dx * dx) / rx2 + (dy * dy) / ry2 <= 1) {
          g.fillRect(Math.round(cx + dx), Math.round(cy + dy), 1, 1);
        }
      }
    }
  }

  function drawText(text, x, y, size, fill, align, outline) {
    ctx.font = `${size}px "Press Start 2P","Microsoft YaHei",monospace`;
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, Math.round(size / 6));
    ctx.strokeStyle = outline || '#0d1626';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  // ---------- 精灵缓存 ----------
  function makeSprite(w, h, drawFn) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    drawFn(g);
    return c;
  }

  const sunSprite = makeSprite(64, 64, (g) => {
    pixelEllipse(g, 30, 30, 24, 24, PAL.sun || '#ffd166');
    pixelEllipse(g, 24, 24, 12, 12, '#fff3b0');
  });

  // ---------- 背景元素 ----------
  const STARS = [];
  for (let i = 0; i < 42; i++) {
    STARS.push({
      x: Math.random() * W,
      y: Math.random() * GROUND_Y * 0.55,
      ph: Math.random() * Math.PI * 2,
    });
  }

  const SKYLINE = [];
  (() => {
    let x = 0;
    while (x < 460) {
      const w = 20 + Math.floor(Math.random() * 26);
      const h = 40 + Math.floor(Math.random() * 72);
      SKYLINE.push({ x, w, h });
      x += w + 6;
    }
  })();

  const CLOUDS = [
    { x: 30, y: 74, blocks: [[0, 0, 14, 6], [4, -4, 12, 5], [14, 2, 10, 4], [7, 4, 12, 4]] },
    { x: 150, y: 120, blocks: [[0, 0, 12, 5], [3, -3, 10, 5], [12, 2, 8, 4]] },
    { x: 250, y: 54, blocks: [[0, 0, 16, 6], [5, -4, 13, 5], [15, 2, 11, 4], [8, 4, 12, 4]] },
    { x: 340, y: 140, blocks: [[0, 0, 10, 4], [2, -3, 9, 4], [10, 1, 8, 4]] },
    { x: 420, y: 96, blocks: [[0, 0, 14, 5], [4, -4, 12, 5], [14, 2, 10, 4]] },
  ];

  // ---------- 大楼生成 ----------
  function spawnBuilding() {
    const half = gapSize / 2;
    const minTopH = 36;
    const minBottomH = 46;
    const minC = gapSize + half + minTopH;
    const maxC = GROUND_Y - half - minBottomH;
    const center = minC + Math.random() * Math.max(1, maxC - minC);
    const gapY = center - half;
    const topH = gapY - gapSize;
    const x = buildings.length ? buildings[buildings.length - 1].x + spawnDist : W + 70;
    buildings.push({
      x,
      w: 62,
      topH,
      gapY,
      seed: Math.floor(Math.random() * 1000),
      scored: false,
    });
  }

  // ---------- 粒子 / 爆炸 ----------
  function spawnExplosion(x, y) {
    particles = [];
    // 三层冲击波，错开出现
    shocks = [
      { life: 0, max: 0.5, r0: 4, r1: 86, w: 4, color: '#ffffff' },
      { life: -0.07, max: 0.66, r0: 4, r1: 108, w: 3, color: '#ffd166' },
      { life: -0.16, max: 0.82, r0: 4, r1: 132, w: 2, color: '#ff8c42' },
    ];
    mush = { x, y, t: 0 };
    const fire = ['#ffffff', '#fff3b0', '#ffd166', '#ff8c42', '#e63946', '#8f2d56'];
    for (let i = 0; i < 150; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 330;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 50,
        life: 0,
        max: 0.5 + Math.random() * 0.8,
        size: 1 + Math.floor(Math.random() * 4),
        color: fire[Math.floor(Math.random() * fire.length)],
        grav: 260,
        drag: 1.3,
      });
    }
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 15 + Math.random() * 80;
      particles.push({
        x: x + (Math.random() - 0.5) * 16,
        y: y + (Math.random() - 0.5) * 16,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 26,
        life: 0,
        max: 1 + Math.random() * 0.9,
        size: 2 + Math.floor(Math.random() * 4),
        color: '#3a3a4f',
        grav: -20,
        drag: 0.6,
      });
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    particles = particles.filter((p) => p.life < p.max);
    for (const s of shocks) s.life += dt;
    shocks = shocks.filter((s) => s.life < s.max);
    if (mush) mush.t += dt;
  }

  // 尾焰火星 / 烟雾：朝机体后方喷出，并随气流向后拖
  function spawnExhaust() {
    const cos = Math.cos(bomb.rot);
    const sin = Math.sin(bomb.rot);
    const wx = BOMB_X - NUKE_TAIL_X * cos;
    const wy = bomb.y - NUKE_TAIL_X * sin;
    const dx = -cos; // 尾焰方向（机体后方）
    const dy = -sin;
    const px = -sin; // 垂直方向（抖动）
    const py = cos;
    const thrust = bomb.pullT > 0 ? 1 : 0.6;
    const spread = (Math.random() - 0.5) * 46;
    const sp = (70 + Math.random() * 80) * thrust;
    const bright = Math.random() < 0.55;
    particles.push({
      x: wx + (Math.random() - 0.5) * 4,
      y: wy + (Math.random() - 0.5) * 4,
      vx: dx * sp + px * spread - speed * 0.35,
      vy: dy * sp + py * spread,
      life: 0,
      max: bright ? 0.16 + Math.random() * 0.16 : 0.4 + Math.random() * 0.45,
      size: bright ? 1 : 2,
      color: bright
        ? ['#fff3b0', '#ffd166', '#ff8c42'][Math.floor(Math.random() * 3)]
        : ['#6a6f80', '#565b6e', '#41465a'][Math.floor(Math.random() * 3)],
      grav: bright ? 30 : -26,
      drag: bright ? 2.6 : 1.2,
    });
    if (particles.length > 220) particles.splice(0, particles.length - 220);
  }

  function updateExhaust(dt) {
    exhaustAcc += dt * (state.mode === 'play' ? 46 : 16);
    while (exhaustAcc >= 1) {
      spawnExhaust();
      exhaustAcc -= 1;
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const t = p.life / p.max;
      ctx.globalAlpha = clamp(1 - t, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // 冲击波
    const ox = Math.round(mush ? mush.x : BOMB_X);
    const oy = Math.round(mush ? mush.y : bomb.y);
    for (const s of shocks) {
      if (s.life <= 0) continue;
      const t = s.life / s.max;
      const r = s.r0 + (s.r1 - s.r0) * t;
      ctx.globalAlpha = clamp(1 - t, 0, 1);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 核爆蘑菇云：火球 + 上升云柱 + 伞盖
  function drawMushroom() {
    if (!mush) return;
    const t = Math.min(1, mush.t / 1.2);
    const fade = mush.t < 1.8 ? 1 : Math.max(0, 1 - (mush.t - 1.8) / 1.6);
    if (fade <= 0) return;

    const cx = Math.round(mush.x);
    const cy = Math.round(mush.y);
    const capY = Math.round(cy - 14 - t * 44);
    const capR = 8 + t * 22;

    ctx.globalAlpha = fade;

    // 火球
    if (t < 0.45) {
      const f = 1 - t / 0.45;
      ctx.globalAlpha = fade * f;
      pixelEllipse(ctx, cx, cy, Math.round(6 + t * 30), Math.round(6 + t * 30), '#ffd166');
      pixelEllipse(ctx, cx, cy, Math.round(4 + t * 18), Math.round(4 + t * 18), '#fff3b0');
      ctx.globalAlpha = fade;
    }

    // 云柱
    const stemH = cy - capY;
    for (let i = 0; i < stemH; i++) {
      const y = cy - i;
      const w = Math.round(8 + i * 0.18);
      ctx.fillStyle = '#4a3a38';
      ctx.fillRect(cx - Math.floor(w / 2) - 2, y, w + 4, 1);
      ctx.fillStyle = i < stemH * 0.55 ? '#7a5a4a' : '#5a4a44';
      ctx.fillRect(cx - Math.floor(w / 2), y, w, 1);
    }

    // 伞盖
    const capRy = Math.round(capR * 0.6);
    pixelEllipse(ctx, cx, capY, capR, capRy, '#4a3a38');
    pixelEllipse(ctx, cx - Math.round(capR * 0.7), capY + 4, Math.round(capR * 0.45), Math.round(capR * 0.3), '#4a3a38');
    pixelEllipse(ctx, cx + Math.round(capR * 0.7), capY + 4, Math.round(capR * 0.45), Math.round(capR * 0.3), '#4a3a38');
    pixelEllipse(ctx, cx, capY - 2, Math.round(capR * 0.78), Math.round(capR * 0.46), '#c98b4b');
    pixelEllipse(ctx, cx, capY - 4, Math.round(capR * 0.44), Math.round(capR * 0.26), '#ffd166');

    ctx.globalAlpha = 1;
  }

  // 全屏强光（画布内）
  function drawBlastFlash() {
    if (!mush) return;
    const t = Math.min(1, mush.t / 0.55);
    if (t >= 1) return;
    const a = Math.pow(1 - t, 1.5);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = a * 0.55;
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // 结算牌上的像素画：蘑菇云 + 城市废墟
  function drawBoomArt() {
    if (!boomCanvas) return;
    const c = boomCanvas.getContext('2d');
    const BW = boomCanvas.width;
    const BH = boomCanvas.height;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, BW, BH);

    // 核爆黄昏天空
    for (let y = 0; y < BH; y++) {
      const t = y / BH;
      c.fillStyle = t < 0.5
        ? lerpColor('#241634', '#6b2d3a', t / 0.5)
        : lerpColor('#6b2d3a', '#b25a33', (t - 0.5) / 0.5);
      c.fillRect(0, y, BW, 1);
    }

    const horizon = 34;
    const cx = 52;
    const capY = 13;
    const stemTop = capY + 6;

    // 云柱
    for (let y = stemTop; y < horizon; y++) {
      const w = 7 + Math.round((y - stemTop) * 0.22);
      c.fillStyle = '#6b4a3a';
      c.fillRect(cx - Math.floor(w / 2) - 2, y, w + 4, 1);
      c.fillStyle = '#a9703f';
      c.fillRect(cx - Math.floor(w / 2), y, w, 1);
    }

    // 伞盖
    pixelEllipse(c, cx, capY, 27, 10, '#5a3a34');
    pixelEllipse(c, cx - 20, capY + 4, 12, 6, '#5a3a34');
    pixelEllipse(c, cx + 20, capY + 4, 12, 6, '#5a3a34');
    pixelEllipse(c, cx, capY, 23, 8, '#c98b4b');
    pixelEllipse(c, cx, capY - 1, 17, 6, '#f0c87a');
    pixelEllipse(c, cx, capY - 2, 10, 4, '#fff3b0');
    pixelEllipse(c, cx - 14, capY - 5, 7, 4, '#c98b4b');
    pixelEllipse(c, cx + 13, capY - 6, 6, 3, '#f0c87a');

    // 城市废墟（缺口楼顶 + 亮面/暗面 + 火光窗）
    const ruins = [
      [1, 8, 17, 2], [10, 6, 11, 1], [17, 9, 21, 4], [27, 6, 9, 0],
      [61, 7, 14, 2], [69, 9, 23, 3], [79, 6, 12, 1], [86, 9, 18, 4], [96, 7, 8, 0],
    ];
    for (const r of ruins) {
      const x = r[0];
      const w = r[1];
      const h = r[2];
      const notch = r[3];
      const top = horizon - h;
      c.fillStyle = '#2a1b25';
      c.fillRect(x, top, w, h);
      c.fillStyle = '#241634';
      c.fillRect(x + (notch % w), top, Math.min(notch + 1, w), 1);
      c.fillRect(x + Math.floor(w / 2), top - 1, 2, 1);
      c.fillStyle = '#3a2431';
      c.fillRect(x, top + 1, 1, h - 1);
      c.fillStyle = '#1b0f18';
      c.fillRect(x + w - 1, top + 1, 1, h - 1);
      c.fillStyle = '#ff8c42';
      for (let k = 0; k < 3; k++) {
        const wx = x + 1 + ((k * 3 + x) % Math.max(1, w - 2));
        const wy = top + 2 + ((k * 5 + x) % Math.max(1, h - 3));
        c.fillRect(wx, wy, 1, 1);
      }
    }

    // 一栋倾斜的残楼
    for (let y = horizon - 15; y < horizon; y++) {
      const off = Math.round((horizon - y) * 0.18);
      c.fillStyle = '#2a1b25';
      c.fillRect(37 + off, y, 5, 1);
      c.fillStyle = '#1b0f18';
      c.fillRect(41 + off, y, 1, 1);
    }

    // 焦土地面与火光
    c.fillStyle = '#180f16';
    c.fillRect(0, horizon, BW, BH - horizon);
    c.fillStyle = '#3a1c20';
    c.fillRect(0, horizon, BW, 2);
    c.fillStyle = '#ff8c42';
    for (let x = 2; x < BW; x += 7) c.fillRect(x, horizon + 2 + ((x * 3) % 5), 1, 1);
    c.fillStyle = '#ffd166';
    for (let x = 5; x < BW; x += 11) c.fillRect(x, horizon + 1, 1, 1);

    // 空中火星 / 灰烬
    for (let i = 0; i < 26; i++) {
      const x = (i * 37) % BW;
      const y = ((i * 17) % (horizon - 6)) + 2;
      c.fillStyle = i % 3 === 0 ? '#ffd166' : i % 3 === 1 ? '#ff8c42' : '#8a5a44';
      c.fillRect(x, y, 1, 1);
    }
  }

  // ---------- 流程控制 ----------
  function resetRun() {
    score = 0;
    elapsed = 0;
    speed = 128;
    gapSize = 122;
    spawnDist = 208;
    level = 1;
    deadT = 0;
    scorePop = 0;
    groundOff = 0;
    distantOff = 0;
    exhaustAcc = 0;
    buildings = [];
    particles = [];
    shocks = [];
    mush = null;
    bomb.y = READY_Y;
    bomb.vy = 0;
    bomb.rot = 0;
    bomb.pullT = 0;
    heli.x = BOMB_X + 4;
    heli.y = READY_Y - 46;
  }

  function startGame() {
    resetRun();
    state.mode = 'play';
    spawnBuilding();
    startLoop();
    pull();
  }

  function pull() {
    bomb.vy = JUMP_V;
    bomb.pullT = PULL_TIME;
    sfxTap();
  }

  function die() {
    if (state.mode !== 'play') return;
    state.mode = 'dead';
    deadT = 0;
    spawnExplosion(BOMB_X, bomb.y);

    // 画布内强光
    flashEl.classList.remove('go');
    void flashEl.offsetWidth;
    flashEl.classList.add('go');
    // 铺满整个视口的强光
    flashFullEl.classList.remove('go');
    void flashFullEl.offsetWidth;
    flashFullEl.classList.add('go');
    // 主震 + 余震
    shakeWrap.classList.remove('shake');
    void shakeWrap.offsetWidth;
    shakeWrap.classList.add('shake');

    if (navigator.vibrate) {
      try { navigator.vibrate([140, 50, 180, 60, 260]); } catch (e) { /* ignore */ }
    }
    sfxBoom();
  }

  function showResult() {
    const isNew = score > best && score > 0;
    if (isNew) {
      best = score;
      storageSet('nukeBirdBest', String(best));
    }
    finalScoreEl.textContent = score;
    bestScoreEl.textContent = best;
    newRecordEl.classList.toggle('hidden', !isNew);
    drawBoomArt();
    resultEl.classList.remove('hidden');
  }

  function restart() {
    resultEl.classList.add('hidden');
    shakeWrap.classList.remove('shake');
    resetRun();
    state.mode = 'ready';
    startLoop();
  }

  // ---------- 更新 ----------
  function updateDifficulty() {
    const d = Math.min(40, score * 1.8 + elapsed * 0.6);
    speed = Math.min(236, 128 + d * 3.0);
    gapSize = Math.max(78, 122 - d * 1.2);
    spawnDist = Math.max(190, 208 - d * 0.5);
    level = Math.floor(d / 6) + 1;
  }

  function updateHeli(dt) {
    const targetX = BOMB_X + 4 + Math.sin(time * 2.1) * 2;
    const targetY = bomb.y - 64;
    heli.x += (targetX - heli.x) * Math.min(1, dt * 6);
    heli.y += (targetY - heli.y) * Math.min(1, dt * 7);
    heli.y = Math.max(20, heli.y);
  }

  function update(dt) {
    time += dt;
    updateParticles(dt);
    rotorAngle += dt * (state.mode === 'play' ? 42 : 26);

    const drift = state.mode === 'play' ? speed * 0.18 : 9;
    for (const c of CLOUDS) {
      c.x -= drift * dt;
      if (c.x < -50) c.x += W + 100;
    }
    if (state.mode === 'play') {
      distantOff = (distantOff + speed * 0.12 * dt) % 460;
      groundOff = (groundOff + speed * dt) % 26;
    } else {
      distantOff = (distantOff + 7 * dt) % 460;
      groundOff = (groundOff + 9 * dt) % 26;
    }

    if (state.mode === 'ready') {
      bomb.y = READY_Y + Math.sin(time * 2.6) * 5;
      bomb.rot = Math.sin(time * 2.6) * 0.12;
      updateHeli(dt);
      updateExhaust(dt);
      return;
    }

    if (state.mode === 'play') {
      elapsed += dt;
      updateDifficulty();

      bomb.vy += GRAVITY * dt;
      bomb.y += bomb.vy * dt;
      if (bomb.y < BOMB_R) {
        bomb.y = BOMB_R;
        bomb.vy = Math.max(bomb.vy, 0);
      }
      if (bomb.pullT > 0) bomb.pullT -= dt;

      const targetRot = bomb.vy < 0 ? -0.4 : Math.min(1.15, bomb.vy / 430);
      bomb.rot += (targetRot - bomb.rot) * Math.min(1, dt * 10);

      if (scorePop > 0) scorePop -= dt;

      for (const b of buildings) {
        b.x -= speed * dt;

        if (!b.scored && b.x + b.w < BOMB_X - BOMB_R) {
          b.scored = true;
          score += 1;
          scorePop = 0.22;
          sfxScore();
        }

        const hitTop = circleRect(BOMB_X, bomb.y, BOMB_R - 2, b.x - 1, -20, b.w + 2, b.topH + 20);
        const hitBottom = circleRect(BOMB_X, bomb.y, BOMB_R - 2, b.x - 1, b.gapY, b.w + 2, GROUND_Y - b.gapY);
        if (hitTop || hitBottom) {
          die();
          return;
        }
      }

      if (bomb.y + BOMB_R >= GROUND_Y) {
        die();
        return;
      }

      buildings = buildings.filter((b) => b.x + b.w > -90);
      if (buildings.length === 0 || buildings[buildings.length - 1].x <= W - spawnDist) {
        spawnBuilding();
      }

      updateHeli(dt);
      updateExhaust(dt);
      return;
    }

    if (state.mode === 'dead') {
      deadT += dt;
      updateHeli(dt);
      if (deadT > 0.95) {
        state.mode = 'over';
        showResult();
      }
      return;
    }

    if (state.mode === 'over') {
      updateHeli(dt);
    }
  }

  // ---------- 绘制 ----------
  function drawSky() {
    const bandH = 6;
    for (let y = 0; y < GROUND_Y; y += bandH) {
      const t = y / GROUND_Y;
      let col;
      if (t < 0.45) col = lerpColor(PAL.skyTop, PAL.skyMid, t / 0.45);
      else if (t < 0.75) col = lerpColor(PAL.skyMid, PAL.skyLow, (t - 0.45) / 0.3);
      else col = lerpColor(PAL.skyLow, PAL.skyHorizon, (t - 0.75) / 0.25);
      ctx.fillStyle = col;
      ctx.fillRect(0, y, W, bandH + 1);
    }
  }

  function drawStars() {
    for (const s of STARS) {
      const a = 0.35 + 0.35 * Math.sin(time * 2.2 + s.ph);
      ctx.globalAlpha = clamp(a, 0.05, 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawSun() {
    ctx.drawImage(sunSprite, 250, 56);
  }

  function drawSkyline() {
    const total = 460;
    const off = distantOff % total;
    ctx.fillStyle = PAL.skyline;
    for (let k = -1; k <= 1; k++) {
      for (const b of SKYLINE) {
        const x = b.x + k * total - off;
        if (x > W || x + b.w < 0) continue;
        ctx.fillRect(Math.round(x), GROUND_Y - b.h, b.w, b.h);
      }
    }
  }

  function drawClouds() {
    for (const c of CLOUDS) {
      const px = Math.round(c.x);
      const py = Math.round(c.y);
      ctx.fillStyle = '#eaf2ff';
      for (const b of c.blocks) ctx.fillRect(px + b[0], py + b[1], b[2], b[3]);
      ctx.fillStyle = '#b9cdea';
      for (const b of c.blocks) ctx.fillRect(px + b[0], py + b[1] + b[3] - 1, b[2], 1);
    }
  }

  function drawBuildingBody(x, y, w, h, roofAtTop, seed) {
    // 楼体
    ctx.fillStyle = PAL.building;
    ctx.fillRect(x, y, w, h);
    // 侧面阴影
    ctx.fillStyle = PAL.buildingDark;
    ctx.fillRect(x + w - 8, y, 8, h);
    // 窗户
    const cell = 9;
    const cols = Math.floor((w - 12) / cell);
    const rows = Math.floor((h - 14) / cell);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = ((c * 7 + r * 13 + seed) % 5) < 3;
        ctx.fillStyle = lit ? PAL.windowLit : PAL.windowDim;
        ctx.fillRect(x + 7 + c * cell, y + 8 + r * cell, 5, 6);
      }
    }
    // 描边
    ctx.strokeStyle = PAL.outline;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    // 面向间隙的屋顶 + 天线
    ctx.fillStyle = PAL.roof;
    if (roofAtTop) {
      ctx.fillRect(x - 2, y, w + 4, 4);
      ctx.fillStyle = PAL.outline;
      ctx.fillRect(x + w / 2 - 1, y - 8, 2, 8);
      if (Math.floor(time * 4) % 2 === 0) {
        ctx.fillStyle = '#ff5a5a';
        ctx.fillRect(x + w / 2 - 1, y - 9, 2, 2);
      }
    } else {
      ctx.fillRect(x - 2, y + h - 4, w + 4, 4);
      ctx.fillStyle = PAL.outline;
      ctx.fillRect(x + w / 2 - 1, y + h, 2, 8);
      if (Math.floor(time * 4 + 1) % 2 === 0) {
        ctx.fillStyle = '#ff5a5a';
        ctx.fillRect(x + w / 2 - 1, y + h + 8, 2, 2);
      }
    }
  }

  function drawBuildings() {
    for (const b of buildings) {
      drawBuildingBody(Math.round(b.x), 0, b.w, Math.round(b.topH), false, b.seed);
      drawBuildingBody(Math.round(b.x), Math.round(b.gapY), b.w, GROUND_Y - Math.round(b.gapY), true, b.seed);
    }
  }

  function drawGround() {
    ctx.fillStyle = PAL.groundTop;
    ctx.fillRect(0, GROUND_Y, W, 6);
    ctx.fillStyle = PAL.groundEdge;
    ctx.fillRect(0, GROUND_Y, W, 2);
    ctx.fillStyle = PAL.road;
    ctx.fillRect(0, GROUND_Y + 6, W, H - GROUND_Y - 6);
    ctx.fillStyle = PAL.dash;
    const yy = GROUND_Y + 22;
    for (let x = -26; x < W + 26; x += 26) {
      ctx.fillRect(Math.round(x - (groundOff % 26)), yy, 12, 3);
    }
  }

  function drawField() {
    const magnetBottom = heli.y + 39;
    const bombTop = bomb.y - NUKE_TOP_Y;
    const active = bomb.pullT > 0;
    const y0 = magnetBottom + 1;
    const y1 = bombTop - 1;
    if (y1 <= y0) return;

    // 激活时的光柱
    if (active) {
      ctx.globalAlpha = 0.16 + 0.1 * Math.sin(time * 24);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(Math.round(heli.x - 8), Math.round(y0), 16, Math.max(1, Math.round(y1 - y0)));
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = active ? 0.95 : 0.3;
    const baseColor = active ? '#ffd166' : '#7fd8ff';
    let i = 0;
    for (let y = y0; y < y1; y += 5) {
      const w = i % 2 === 0 ? 5 : 3;
      const sway = active ? Math.sin(time * 26 + y * 0.4) * 2 : Math.sin(time * 3 + y * 0.2);
      ctx.fillStyle = baseColor;
      ctx.fillRect(Math.round(heli.x - w / 2 + sway), Math.round(y), w, 2);
      i++;
    }
    ctx.globalAlpha = 1;
  }

  function drawHelicopter() {
    const hx = Math.round(heli.x);
    const hy = Math.round(heli.y);
    ctx.save();
    ctx.translate(hx, hy);

    // 起落架
    ctx.fillStyle = PAL.outline;
    ctx.fillRect(-7, 11, 2, 3);
    ctx.fillRect(5, 11, 2, 3);
    ctx.fillRect(-9, 13, 18, 2);

    // 尾梁
    ctx.fillStyle = '#e63946';
    ctx.fillRect(9, 2, 14, 4);
    ctx.fillStyle = '#a8dadc';
    ctx.fillRect(9, 2, 8, 2);
    // 尾翼
    ctx.fillStyle = '#e63946';
    ctx.fillRect(21, -2, 3, 7);
    // 尾桨
    ctx.save();
    ctx.translate(23, 1);
    ctx.rotate(rotorAngle * 1.6);
    ctx.fillStyle = PAL.outline;
    ctx.fillRect(-4, 0, 8, 1);
    ctx.restore();

    // 机身
    ctx.fillStyle = '#e63946';
    ctx.fillRect(-9, 1, 18, 10);
    ctx.fillStyle = '#b32534';
    ctx.fillRect(-9, 8, 18, 3);
    // 机头 + 挡风
    ctx.fillStyle = '#e63946';
    ctx.fillRect(-13, 3, 5, 6);
    ctx.fillStyle = '#a8dadc';
    ctx.fillRect(-11, 4, 4, 4);

    // 主轴 + 主旋翼
    ctx.fillStyle = PAL.outline;
    ctx.fillRect(-1, -2, 2, 3);
    ctx.save();
    ctx.translate(0, -2);
    ctx.rotate(rotorAngle);
    ctx.fillStyle = PAL.outline;
    ctx.fillRect(-16, -1, 32, 2);
    ctx.restore();

    // 吊索（像素链条）
    ctx.fillStyle = PAL.outline;
    ctx.fillRect(-1, 13, 2, 9);
    ctx.fillStyle = '#ffd166';
    for (let y = 14; y < 22; y += 3) ctx.fillRect(-1, y, 2, 1);

    // 马蹄磁铁（逐行像素块：台阶圆角 + 描边 + 磁极条纹）
    ctx.fillStyle = PAL.outline; // 外轮廓
    ctx.fillRect(-7, 21, 14, 1);
    ctx.fillRect(-9, 22, 18, 5);
    ctx.fillRect(-9, 27, 5, 11);
    ctx.fillRect(4, 27, 5, 11);

    ctx.fillStyle = '#e63946'; // 马蹄铁主体
    ctx.fillRect(-7, 22, 14, 1);
    ctx.fillRect(-8, 23, 16, 4);
    ctx.fillRect(-8, 27, 3, 10);
    ctx.fillRect(5, 27, 3, 10);

    ctx.fillStyle = '#ff8c8c'; // 左侧高光
    ctx.fillRect(-7, 22, 6, 1);
    ctx.fillRect(-8, 23, 1, 9);
    ctx.fillStyle = '#a82833'; // 右侧阴影
    ctx.fillRect(7, 23, 1, 9);
    ctx.fillStyle = PAL.outline; // 吊索挂点
    ctx.fillRect(-1, 23, 2, 2);

    ctx.fillStyle = '#ffffff'; // 磁极面
    ctx.fillRect(-8, 33, 3, 2);
    ctx.fillRect(5, 33, 3, 2);
    ctx.fillStyle = '#ffd166'; // N 极标记
    ctx.fillRect(-8, 35, 3, 2);
    ctx.fillStyle = '#4a86ff'; // S 极标记
    ctx.fillRect(5, 35, 3, 2);

    // 吸力激活时磁铁外发光
    if (bomb.pullT > 0) {
      ctx.globalAlpha = 0.4 + 0.35 * Math.sin(time * 18);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(-10, 20, 20, 1);
      ctx.fillRect(-10, 38, 20, 1);
      ctx.fillRect(-10, 20, 1, 19);
      ctx.fillRect(9, 20, 1, 19);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  // ---------- 核导弹（矮肥可爱 · 核标志 · 尾焰） ----------
  // 核弹三叶草标志：黄底 + 黑色三叶片
  function drawRadiation(g, cx, cy, r) {
    g.fillStyle = '#14141f';
    const rr = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > rr) continue;
        const d = Math.sqrt(d2);
        if (d < r * 0.26) {
          g.fillRect(cx + dx, cy + dy, 1, 1); // 中心圆点
          continue;
        }
        if (d < r * 0.45) continue; // 留白环
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (deg < 0) deg += 360;
        if ((deg + 90) % 120 < 60) g.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
  }

  // ---------- 核弹（Fallout 风格：矮胖弹体 · 辐射标志 · 尾焰） ----------
  // 只在椭圆内填像素，便于画环带、高光等细节
  function bodyRegion(g, cx, cy, rx, ry, color, keep) {
    g.fillStyle = color;
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        if ((dx * dx) / rx2 + (dy * dy) / ry2 > 1) continue;
        if (keep && !keep(dx, dy)) continue;
        g.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
  }

  // 尾部稳定翼：向后方张开的阶梯三角，up = true 为上翼
  function drawNukeFin(g, up) {
    const dir = up ? -1 : 1;
    for (let i = 0; i <= 5; i++) {
      const x = -9 - i;
      const outer = dir * (7 + i);
      const inner = dir * 7;
      const y0 = Math.min(inner, outer);
      const y1 = Math.max(inner, outer);
      for (let y = y0; y <= y1; y++) {
        g.fillStyle = Math.abs(y) >= Math.abs(outer) - 1 ? '#14141f' : '#46552f';
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  function drawNuke() {
    const thrust = bomb.pullT > 0 ? 1 : 0.6;
    const flicker = 0.8 + 0.2 * Math.sin(time * 43) + 0.08 * Math.sin(time * 97);

    ctx.save();
    ctx.translate(Math.round(BOMB_X), Math.round(bomb.y));
    ctx.rotate(bomb.rot);

    // 尾焰（先画，机体随后压住喷口）
    const fLen = Math.max(3, Math.round((6 + 11 * thrust) * flicker));
    for (let i = 0; i < fLen; i++) {
      const t = i / fLen;
      const h = Math.max(1, Math.round(8 * (1 - t * 0.8)));
      ctx.fillStyle = '#e63946';
      ctx.fillRect(-NUKE_TAIL_X - i, -Math.floor((h + 3) / 2), 1, h + 3);
    }
    for (let i = 0; i < fLen; i++) {
      const t = i / fLen;
      const h = Math.max(1, Math.round(5 * (1 - t * 0.8)));
      ctx.fillStyle = i < fLen * 0.35 ? '#fff3b0' : i < fLen * 0.7 ? '#ffd166' : '#ff8c42';
      ctx.fillRect(-NUKE_TAIL_X - i, -Math.floor(h / 2), 1, h);
    }

    // 尾部稳定翼
    drawNukeFin(ctx, true);
    drawNukeFin(ctx, false);

    // 矮胖弹体（Fallout Mini Nuke 的军绿配色）
    bodyRegion(ctx, 0, 0, 13, 10, '#14141f'); // 描边
    bodyRegion(ctx, 0, 0, 12, 9, '#55663a'); // 军绿主体
    bodyRegion(ctx, 0, 0, 12, 9, '#75874c', (dx, dy) => dy <= -5); // 顶部高光
    bodyRegion(ctx, 0, 0, 12, 9, '#3c4726', (dx, dy) => dy >= 5); // 底部暗部
    bodyRegion(ctx, 0, 0, 12, 9, '#d9b23a', (dx) => dx >= -7 && dx <= -5); // 黄色警示环
    bodyRegion(ctx, 0, 0, 12, 9, '#14141f', (dx) => dx === -8 || dx === -4); // 环带边线

    // 尾喷口
    ctx.fillStyle = '#14141f';
    ctx.fillRect(-15, -6, 3, 12);
    ctx.fillStyle = '#3a3f52';
    ctx.fillRect(-15, -5, 2, 10);
    ctx.fillStyle = '#14141f';
    ctx.fillRect(-15, -4, 2, 2);
    ctx.fillRect(-15, -1, 2, 2);
    ctx.fillRect(-15, 2, 2, 2);

    // 辐射标志
    pixelEllipse(ctx, 2, 0, 6, 6, '#14141f');
    pixelEllipse(ctx, 2, 0, 5, 5, '#d9b23a');
    drawRadiation(ctx, 2, 0, 4);

    // 铆钉
    ctx.fillStyle = '#14141f';
    ctx.fillRect(-10, -3, 1, 1);
    ctx.fillRect(-10, 3, 1, 1);

    ctx.restore();
  }

  function drawHUD() {
    const pop = scorePop > 0 ? 1 + Math.sin((0.22 - scorePop) / 0.22 * Math.PI) * 0.25 : 1;
    drawText(String(score), W / 2, 30, Math.round(20 * pop), '#ffffff', 'center', '#0d1626');
    drawText(`Lv.${level}`, W / 2, 52, 8, '#ffd166', 'center', '#0d1626');
  }

  function drawTitle() {
    drawText('磁 吸 核 弹', W / 2, 122, 24, '#ffd166', 'center', '#0d1626');
    drawText('磁 铁 直 升 机', W / 2, 154, 11, '#e8ecff', 'center', '#0d1626');

    const a = 0.55 + 0.45 * Math.sin(time * 4.2);
    ctx.globalAlpha = clamp(a, 0.15, 1);
    drawText('点击 / 空格 开始', W / 2, 300, 11, '#ffffff', 'center', '#0d1626');
    ctx.globalAlpha = 1;

    drawText('穿越大厦 · 躲避撞击', W / 2, 332, 8, '#9fb0d8', 'center', '#0d1626');
  }

  function render() {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);

    drawSky();
    drawStars();
    drawSun();
    drawSkyline();
    drawClouds();
    drawBuildings();
    drawGround();

    if (state.mode === 'ready' || state.mode === 'play') {
      drawParticles();
      drawField();
      drawHelicopter();
      drawNuke();
    } else if (state.mode === 'dead' || state.mode === 'over') {
      drawHelicopter();
      drawMushroom();
      drawParticles();
    }

    if (state.mode === 'play') drawHUD();
    if (state.mode === 'ready') drawTitle();
    drawBlastFlash();
  }

  // ---------- 主循环 ----------
  let last = performance.now();
  let running = false;

  function hasActiveFx() {
    return particles.length > 0 || shocks.length > 0 || (mush !== null && mush.t < 3.4);
  }

  function startLoop() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    if (state.mode === 'over' && !hasActiveFx()) {
      running = false; // 特效播完就停帧，省电
      return;
    }
    requestAnimationFrame(frame);
  }

  // ---------- 输入 ----------
  function onAction(e) {
    if (e && e.preventDefault) e.preventDefault();
    ensureAudio();
    if (state.mode === 'ready') {
      startGame();
    } else if (state.mode === 'play') {
      pull();
    }
  }

  canvas.addEventListener('pointerdown', onAction);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      onAction(e);
    } else if (e.code === 'Enter' && state.mode === 'over') {
      e.preventDefault();
      restart();
    }
  });

  restartBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ensureAudio();
    restart();
  });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    storageSet('nukeBirdMuted', muted ? '1' : '0');
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  // ---------- 移动端防护 ----------
  // 画面尺寸交给 CSS（svh 固定），避免手机地址栏伸缩触发重排导致闪烁
  const stopDefault = (e) => e.preventDefault();
  canvas.addEventListener('contextmenu', stopDefault); // 长按菜单
  canvas.addEventListener('dragstart', stopDefault); // 拖拽
  document.addEventListener('gesturestart', stopDefault); // iOS 捏合缩放
  document.addEventListener('selectstart', stopDefault); // 选中高亮

  // 强光播放完就隐藏，避免隐藏的白色图层在移动端反复合成闪烁
  flashEl.addEventListener('animationend', () => flashEl.classList.remove('go'));
  flashFullEl.addEventListener('animationend', () => flashFullEl.classList.remove('go'));

  // ---------- 启动 ----------
  resetRun();
  startLoop();
})();
