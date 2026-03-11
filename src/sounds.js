// Web Audio API 合成音效系统（无需音频文件）

let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

export function resumeAudio() {
  const c = getCtx();
  if (c.state === "suspended") c.resume();
}

// 节流：防止同类音效在极短时间内重复播放
const lastPlayed = new Map();
function throttle(key, minMs) {
  const now = performance.now();
  if (now - (lastPlayed.get(key) ?? 0) < minMs) return true;
  lastPlayed.set(key, now);
  return false;
}

// 生成白噪声 BufferSource
function makeNoise(c, dur) {
  const n = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

function osc(c, type, freq) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  return o;
}

function gainNode(c, val) {
  const g = c.createGain();
  g.gain.value = val;
  return g;
}

// 主音量（统一控制整体音量）
let masterGain = null;
function getMaster(c) {
  if (!masterGain) {
    masterGain = c.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(c.destination);
  }
  return masterGain;
}

// 录制用音频流：将 masterGain 同时接入 MediaStreamDestination
let streamDest = null;
export function getAudioStream() {
  const c = getCtx();
  if (!streamDest) {
    streamDest = c.createMediaStreamDestination();
    getMaster(c).connect(streamDest);
  }
  return streamDest.stream;
}

// ─── 通用碰撞与弹墙音效 ────────────────────────────────────────────────────────

function playBallCollision(impactSpeed = 200) {
  if (throttle("ballCollision", 55)) return;
  const c = getCtx();
  const t = c.currentTime;
  const vol = Math.min(1, impactSpeed / 350) * 0.55 + 0.15;

  // 噪声冲击通过低通滤波器 → 浑厚的碰撞闷响
  const noise = makeNoise(c, 0.1);
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 280;
  const g = gainNode(c, vol);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  noise.connect(f); f.connect(g); g.connect(getMaster(c));
  noise.start(t); noise.stop(t + 0.1);
}

function playWallBounce() {
  if (throttle("wallBounce", 90)) return;
  const c = getCtx();
  const t = c.currentTime;

  // 短促的弹击声
  const o = osc(c, "sine", 380);
  const g = gainNode(c, 0.28);
  g.gain.setValueAtTime(0.28, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
  o.connect(g); g.connect(getMaster(c));
  o.start(t); o.stop(t + 0.06);
}

// ─── 各角色普攻音效 ────────────────────────────────────────────────────────────

const basicAttackSounds = {

  // 蜂刺：高频追踪光针 — 尖锐上扫
  "bee-stinger"() {
    if (throttle("ba:bee-stinger", 180)) return;
    const c = getCtx(); const t = c.currentTime;
    const o = osc(c, "sine", 1400);
    o.frequency.exponentialRampToValueAtTime(2400, t + 0.08);
    const g = gainNode(c, 0.38);
    g.gain.setValueAtTime(0.38, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g); g.connect(getMaster(c));
    o.start(t); o.stop(t + 0.11);
  },

  // 瘟疫：剧毒尾迹 — 低沉起泡声
  "plague-mist"() {
    if (throttle("ba:plague-mist", 380)) return;
    const c = getCtx(); const t = c.currentTime;
    const n = makeNoise(c, 0.22);
    const f = c.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 360; f.Q.value = 2.5;
    const lfo = osc(c, "sine", 9);
    const lg = gainNode(c, 130);
    lfo.connect(lg); lg.connect(f.frequency);
    const g = gainNode(c, 0.75);
    g.gain.setValueAtTime(0.75, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(f); f.connect(g); g.connect(getMaster(c));
    lfo.start(t); n.start(t); n.stop(t + 0.22); lfo.stop(t + 0.22);
  },

  // 绞肉机：高频锯齿 — 锯齿波研磨
  "meat-grinder"() {
    if (throttle("ba:meat-grinder", 140)) return;
    const c = getCtx(); const t = c.currentTime;
    const o = osc(c, "sawtooth", 95);
    const f = c.createBiquadFilter();
    f.type = "highpass"; f.frequency.value = 65;
    const g = gainNode(c, 0.48);
    g.gain.setValueAtTime(0.48, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    o.connect(f); f.connect(g); g.connect(getMaster(c));
    o.start(t); o.stop(t + 0.12);
  },

  // 磁暴：弹射电弧 — 电流放电
  "storm-magnet"() {
    if (throttle("ba:storm-magnet", 280)) return;
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 方波频率下扫
    const o = osc(c, "square", 200);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.13);
    const go = gainNode(c, 0.32);
    go.gain.setValueAtTime(0.32, t);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(go); go.connect(master);
    // 高频噼啪
    const n = makeNoise(c, 0.12);
    const nf = c.createBiquadFilter();
    nf.type = "bandpass"; nf.frequency.value = 3500; nf.Q.value = 0.6;
    const gn = gainNode(c, 0.22);
    gn.gain.setValueAtTime(0.22, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    n.connect(nf); nf.connect(gn); gn.connect(master);
    o.start(t); n.start(t); o.stop(t + 0.15); n.stop(t + 0.13);
  },

  // 炮台：微型无人机 — 机械发射音
  "turret-smith"() {
    if (throttle("ba:turret-smith", 190)) return;
    const c = getCtx(); const t = c.currentTime;
    const n = makeNoise(c, 0.05);
    const f = c.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 900; f.Q.value = 4;
    const g = gainNode(c, 0.52);
    g.gain.setValueAtTime(0.52, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f); f.connect(g); g.connect(getMaster(c));
    n.start(t); n.stop(t + 0.06);
  },

  // 轰炸机：抛物线榴弹 — 弹出呼啸
  "bomber-rex"() {
    if (throttle("ba:bomber-rex", 480)) return;
    const c = getCtx(); const t = c.currentTime;
    const n = makeNoise(c, 0.28);
    const f = c.createBiquadFilter();
    f.type = "highpass"; f.frequency.value = 2200;
    f.frequency.exponentialRampToValueAtTime(180, t + 0.28);
    const g = gainNode(c, 0.38);
    g.gain.setValueAtTime(0.2, t);
    g.gain.linearRampToValueAtTime(0.38, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    n.connect(f); f.connect(g); g.connect(getMaster(c));
    n.start(t); n.stop(t + 0.29);
  },

  // 汲取者：鲜血锁链 — 锁链射出嗖声 + 咬合冲击
  "blood-leech"() {
    if (throttle("ba:blood-leech", 380)) return;
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 锁链射出：高频噪声下扫（嗖）
    const n = makeNoise(c, 0.14);
    const f = c.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = 3200; f.Q.value = 1.2;
    f.frequency.exponentialRampToValueAtTime(420, t + 0.14);
    const g = gainNode(c, 0.58);
    g.gain.setValueAtTime(0.12, t);
    g.gain.linearRampToValueAtTime(0.58, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    n.connect(f); f.connect(g); g.connect(master);
    n.start(t); n.stop(t + 0.15);
    // 咬合瞬间：中频锯齿冲击
    const o = osc(c, "sawtooth", 280);
    o.frequency.exponentialRampToValueAtTime(95, t + 0.1);
    const go = gainNode(c, 0.45);
    go.gain.setValueAtTime(0.45, t + 0.03);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(go); go.connect(master);
    o.start(t + 0.03); o.stop(t + 0.19);
  },

  // 欺诈师：光影镜像 — 闪烁和弦
  "phantom-mirror"() {
    if (throttle("ba:phantom-mirror", 300)) return;
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    [620, 930, 1240].forEach((freq, i) => {
      const o = osc(c, "sine", freq);
      const g = gainNode(c, 0.2);
      g.gain.setValueAtTime(0.2, t + i * 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + i * 0.02);
      o.connect(g); g.connect(master);
      o.start(t + i * 0.02); o.stop(t + 0.18 + i * 0.02);
    });
  },

  // 光棱：高能射线 — 激光扫射
  "prism-refract"() {
    if (throttle("ba:prism-refract", 200)) return;
    const c = getCtx(); const t = c.currentTime;
    const o = osc(c, "sine", 2000);
    o.frequency.exponentialRampToValueAtTime(3600, t + 0.09);
    const g = gainNode(c, 0.33);
    g.gain.setValueAtTime(0.33, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g); g.connect(getMaster(c));
    o.start(t); o.stop(t + 0.11);
  },

  // 圣盾：充能护甲 — 金属撞击叮响
  "holy-shield"() {
    if (throttle("ba:holy-shield", 280)) return;
    const c = getCtx(); const t = c.currentTime;
    const o = osc(c, "sine", 920);
    const g = gainNode(c, 0.42);
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g); g.connect(getMaster(c));
    o.start(t); o.stop(t + 0.33);
  },

  // 风暴·气象台：气旋卷起 — 低频呼啸扫频
  "storm-weather"() {
    if (throttle("ba:storm-weather", 500)) return;
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    const n = makeNoise(c, 0.55);
    const bf = c.createBiquadFilter();
    bf.type = "bandpass"; bf.frequency.value = 320; bf.Q.value = 1.2;
    bf.frequency.exponentialRampToValueAtTime(680, t + 0.55);
    const gn = gainNode(c, 0.0);
    gn.gain.setValueAtTime(0.0, t);
    gn.gain.linearRampToValueAtTime(0.45, t + 0.18);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.58);
    n.connect(bf); bf.connect(gn); gn.connect(master);
    const o = c.createOscillator();
    o.type = "sine"; o.frequency.value = 140;
    o.frequency.exponentialRampToValueAtTime(90, t + 0.55);
    const go = gainNode(c, 0.18);
    go.gain.setValueAtTime(0.18, t);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(go); go.connect(master);
    n.start(t); o.start(t); n.stop(t + 0.6); o.stop(t + 0.56);
  },

  // 绝对零度：寒冰散射 — 冰晶碎裂
  "frost-core"() {
    if (throttle("ba:frost-core", 280)) return;
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    const o = osc(c, "sine", 1900);
    const go = gainNode(c, 0.32);
    go.gain.setValueAtTime(0.32, t);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(go); go.connect(master);
    const n = makeNoise(c, 0.1);
    const nf = c.createBiquadFilter();
    nf.type = "highpass"; nf.frequency.value = 4500;
    const gn = gainNode(c, 0.18);
    gn.gain.setValueAtTime(0.18, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    n.connect(nf); nf.connect(gn); gn.connect(master);
    o.start(t); n.start(t); o.stop(t + 0.13); n.stop(t + 0.11);
  },
};

// ─── 各角色大招音效（更宏大、更持久）─────────────────────────────────────────

const ultimateSounds = {

  // 死亡绽放：多频爆发绽放
  "bee-stinger"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    [700, 1100, 1600, 2300].forEach((freq, i) => {
      const o = osc(c, "sine", freq);
      o.frequency.exponentialRampToValueAtTime(freq * 2.8, t + 0.35);
      const g = gainNode(c, 0.28);
      g.gain.setValueAtTime(0.28, t + i * 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45 + i * 0.05);
      o.connect(g); g.connect(master);
      o.start(t + i * 0.05); o.stop(t + 0.5 + i * 0.05);
    });
  },

  // 全屏毒爆：大型毒云涌出
  "plague-mist"() {
    const c = getCtx(); const t = c.currentTime;
    const n = makeNoise(c, 0.55);
    const f = c.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 550;
    const lfo = osc(c, "sine", 5);
    const lg = gainNode(c, 180);
    lfo.connect(lg); lg.connect(f.frequency);
    const g = gainNode(c, 0.72);
    g.gain.setValueAtTime(0.72, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    n.connect(f); f.connect(g); g.connect(getMaster(c));
    lfo.start(t); n.start(t); n.stop(t + 0.56); lfo.stop(t + 0.56);
  },

  // 嗜血冲锋：工业重锯齿下扫
  "meat-grinder"() {
    const c = getCtx(); const t = c.currentTime;
    const o = osc(c, "sawtooth", 160);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
    const f = c.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 900;
    const g = gainNode(c, 0.75);
    g.gain.setValueAtTime(0.75, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(f); f.connect(g); g.connect(getMaster(c));
    o.start(t); o.stop(t + 0.51);
  },

  // 天怒神罚：霹雳雷鸣
  "storm-magnet"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 低频雷鸣
    const n = makeNoise(c, 0.65);
    const f = c.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 700;
    const g = gainNode(c, 0.88);
    g.gain.setValueAtTime(0.88, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    n.connect(f); f.connect(g); g.connect(master);
    n.start(t); n.stop(t + 0.66);
    // 高频霹啪
    const n2 = makeNoise(c, 0.12);
    const f2 = c.createBiquadFilter();
    f2.type = "bandpass"; f2.frequency.value = 5500; f2.Q.value = 0.5;
    const g2 = gainNode(c, 0.5);
    g2.gain.setValueAtTime(0.5, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n2.connect(f2); f2.connect(g2); g2.connect(master);
    n2.start(t); n2.stop(t + 0.13);
  },

  // 火力覆盖：快速连射机枪
  "turret-smith"() {
    const c = getCtx(); const t = c.currentTime;
    for (let i = 0; i < 7; i++) {
      const delay = i * 0.075;
      const n = makeNoise(c, 0.055);
      const f = c.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 3.5;
      const g = gainNode(c, 0.48);
      g.gain.setValueAtTime(0.48, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.055);
      n.connect(f); f.connect(g); g.connect(getMaster(c));
      n.start(t + delay); n.stop(t + delay + 0.07);
    }
  },

  // 地毯式轰炸：连续爆炸
  "bomber-rex"() {
    const c = getCtx(); const t = c.currentTime;
    for (let i = 0; i < 5; i++) {
      const delay = i * 0.11;
      const n = makeNoise(c, 0.22);
      const f = c.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = 380;
      const g = gainNode(c, 0.72);
      g.gain.setValueAtTime(0.72, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.22);
      n.connect(f); f.connect(g); g.connect(getMaster(c));
      n.start(t + delay); n.stop(t + delay + 0.23);
    }
  },

  // 血池降临：多锁链同时咬合 — 湿重冲击 + 血腥低吼
  "blood-leech"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 血腥低吼（低频共鸣）
    const o = osc(c, "sawtooth", 130);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.5);
    const fLow = c.createBiquadFilter();
    fLow.type = "lowpass"; fLow.frequency.value = 600;
    const go = gainNode(c, 0.85);
    go.gain.setValueAtTime(0.85, t);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(fLow); fLow.connect(go); go.connect(master);
    o.start(t); o.stop(t + 0.56);
    // 湿重冲击噪声
    const n = makeNoise(c, 0.18);
    const fMid = c.createBiquadFilter();
    fMid.type = "bandpass"; fMid.frequency.value = 850; fMid.Q.value = 1.5;
    const gn = gainNode(c, 0.78);
    gn.gain.setValueAtTime(0.78, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(fMid); fMid.connect(gn); gn.connect(master);
    n.start(t); n.stop(t + 0.19);
    // 三道锁链射出（错开 30ms）
    [0, 0.03, 0.07].forEach((delay) => {
      const nb = makeNoise(c, 0.12);
      const fb = c.createBiquadFilter();
      fb.type = "bandpass"; fb.frequency.value = 2800; fb.Q.value = 1;
      fb.frequency.exponentialRampToValueAtTime(380, t + delay + 0.12);
      const gb = gainNode(c, 0.48);
      gb.gain.setValueAtTime(0.48, t + delay);
      gb.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.13);
      nb.connect(fb); fb.connect(gb); gb.connect(master);
      nb.start(t + delay); nb.stop(t + delay + 0.14);
    });
  },

  // 镜像杀阵：玻璃碎裂 + 泛音环绕
  "phantom-mirror"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 玻璃碎裂噪声
    const n = makeNoise(c, 0.12);
    const nf = c.createBiquadFilter();
    nf.type = "highpass"; nf.frequency.value = 5000;
    const gn = gainNode(c, 0.55);
    gn.gain.setValueAtTime(0.55, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(nf); nf.connect(gn); gn.connect(master);
    n.start(t); n.stop(t + 0.13);
    // 泛音余韵
    [480, 720, 960, 1440, 1920].forEach((freq, i) => {
      const o = osc(c, "sine", freq);
      const g = gainNode(c, 0.22);
      g.gain.setValueAtTime(0.22, t + i * 0.035);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45 + i * 0.035);
      o.connect(g); g.connect(master);
      o.start(t + i * 0.035); o.stop(t + 0.5 + i * 0.035);
    });
  },

  // 死光扫射：持续激光上扫
  "prism-refract"() {
    const c = getCtx(); const t = c.currentTime;
    const o = osc(c, "sine", 1400);
    o.frequency.exponentialRampToValueAtTime(5500, t + 0.55);
    const g = gainNode(c, 0.55);
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(g); g.connect(getMaster(c));
    o.start(t); o.stop(t + 0.56);
  },

  // 绝对领域：神圣钟鸣泛音
  "holy-shield"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    [440, 880, 1320, 1760, 2200].forEach((freq, i) => {
      const o = osc(c, "sine", freq);
      const g = gainNode(c, 0.32 / (i + 1));
      g.gain.setValueAtTime(0.32 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.91);
    });
  },

  // 寒冰连射：冰爆全屏
  // 风暴·气象台：终极风暴 — 轰鸣共鸣 + 多层风啸
  "storm-weather"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 低频轰鸣
    const o1 = c.createOscillator();
    o1.type = "sawtooth"; o1.frequency.value = 60;
    o1.frequency.linearRampToValueAtTime(40, t + 0.7);
    const g1 = gainNode(c, 0.28);
    g1.gain.setValueAtTime(0.28, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.72);
    o1.connect(g1); g1.connect(master); o1.start(t); o1.stop(t + 0.73);
    // 宽频风啸噪声
    const n = makeNoise(c, 0.65);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 800;
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.65);
    const gn = gainNode(c, 0.0);
    gn.gain.setValueAtTime(0.0, t);
    gn.gain.linearRampToValueAtTime(0.5, t + 0.08);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    n.connect(lp); lp.connect(gn); gn.connect(master);
    n.start(t); n.stop(t + 0.72);
    // 高频呼啸扫频
    const o2 = c.createOscillator();
    o2.type = "sine"; o2.frequency.value = 480;
    o2.frequency.exponentialRampToValueAtTime(220, t + 0.65);
    const g2 = gainNode(c, 0.22);
    g2.gain.setValueAtTime(0.22, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    o2.connect(g2); g2.connect(master); o2.start(t); o2.stop(t + 0.66);
  },

  "frost-core"() {
    const c = getCtx(); const t = c.currentTime;
    const master = getMaster(c);
    // 高频冰雪噪声
    const n = makeNoise(c, 0.45);
    const nf = c.createBiquadFilter();
    nf.type = "highpass"; nf.frequency.value = 6000;
    const gn = gainNode(c, 0.52);
    gn.gain.setValueAtTime(0.52, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    n.connect(nf); nf.connect(gn); gn.connect(master);
    n.start(t); n.stop(t + 0.46);
    // 冰晶音调上扫
    const o = osc(c, "sine", 1500);
    o.frequency.exponentialRampToValueAtTime(2600, t + 0.45);
    const go = gainNode(c, 0.45);
    go.gain.setValueAtTime(0.45, t);
    go.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(go); go.connect(master);
    o.start(t); o.stop(t + 0.46);
  },
};

// ─── 落雷与爆炸命中音效 ────────────────────────────────────────────────────────

// 雷电落地：尖锐霹雳 + 低频震荡
function playLightningImpact() {
  if (throttle("lightningImpact", 60)) return;
  const c = getCtx(); const t = c.currentTime;
  const master = getMaster(c);
  // 全频噪声冲击（模拟雷击瞬间）
  const n = makeNoise(c, 0.25);
  const g = gainNode(c, 1.2);
  g.gain.setValueAtTime(1.2, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  n.connect(g); g.connect(master);
  n.start(t); n.stop(t + 0.26);
  // 电弧嗡鸣（方波，穿透力强）
  const o = osc(c, "square", 160);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  const go = gainNode(c, 0.7);
  go.gain.setValueAtTime(0.7, t);
  go.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  const fLow = c.createBiquadFilter();
  fLow.type = "lowpass"; fLow.frequency.value = 1800;
  o.connect(fLow); fLow.connect(go); go.connect(master);
  o.start(t); o.stop(t + 0.21);
  // 高频电弧裂声（2000-4000Hz 可被大多数扬声器还原）
  const n2 = makeNoise(c, 0.12);
  const f2 = c.createBiquadFilter();
  f2.type = "bandpass"; f2.frequency.value = 3000; f2.Q.value = 0.8;
  const g2 = gainNode(c, 1.0);
  g2.gain.setValueAtTime(1.0, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  n2.connect(f2); f2.connect(g2); g2.connect(master);
  n2.start(t); n2.stop(t + 0.13);
}

// 榴弹爆炸：浑厚爆炸冲击
function playBombExplosion() {
  if (throttle("bombExplosion", 60)) return;
  const c = getCtx(); const t = c.currentTime;
  const master = getMaster(c);
  // 全频冲击噪声（快速衰减，有穿透力）
  const n = makeNoise(c, 0.4);
  const g = gainNode(c, 1.3);
  g.gain.setValueAtTime(1.3, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  n.connect(g); g.connect(master);
  n.start(t); n.stop(t + 0.41);
  // 爆炸中频体（500-1200Hz，大多数设备可还原）
  const n2 = makeNoise(c, 0.2);
  const f2 = c.createBiquadFilter();
  f2.type = "bandpass"; f2.frequency.value = 700; f2.Q.value = 1.2;
  const g2 = gainNode(c, 1.0);
  g2.gain.setValueAtTime(1.0, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  n2.connect(f2); f2.connect(g2); g2.connect(master);
  n2.start(t); n2.stop(t + 0.21);
  // 爆炸音调（锯齿波下扫，增加厚重感）
  const o = osc(c, "sawtooth", 200);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.22);
  const fSaw = c.createBiquadFilter();
  fSaw.type = "lowpass"; fSaw.frequency.value = 1200;
  const go = gainNode(c, 0.8);
  go.gain.setValueAtTime(0.8, t);
  go.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  o.connect(fSaw); fSaw.connect(go); go.connect(master);
  o.start(t); o.stop(t + 0.26);
}

// ─── 圣剑命中音效 ──────────────────────────────────────────────────────────────

function playSwordHit() {
  if (throttle("swordHit", 120)) return;
  const c = getCtx(); const t = c.currentTime;
  const master = getMaster(c);
  // 金属斩击（高频锯齿 + 低通，模拟剑刃切入）
  const o = osc(c, "sawtooth", 520);
  o.frequency.exponentialRampToValueAtTime(180, t + 0.08);
  const f = c.createBiquadFilter();
  f.type = "lowpass"; f.frequency.value = 2200;
  const g = gainNode(c, 0.72);
  g.gain.setValueAtTime(0.72, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(f); f.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.11);
  // 神圣余韵（正弦泛音，金色光感）
  const o2 = osc(c, "sine", 1100);
  o2.frequency.exponentialRampToValueAtTime(680, t + 0.18);
  const g2 = gainNode(c, 0.45);
  g2.gain.setValueAtTime(0.45, t + 0.02);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o2.connect(g2); g2.connect(master);
  o2.start(t + 0.02); o2.stop(t + 0.23);
}

// ─── 炮台部署音效 ──────────────────────────────────────────────────────────────

function playTurretPlace() {
  const c = getCtx(); const t = c.currentTime;
  const master = getMaster(c);
  // 金属落地闷响
  const n = makeNoise(c, 0.07);
  const f = c.createBiquadFilter();
  f.type = "bandpass"; f.frequency.value = 520; f.Q.value = 3.5;
  const g = gainNode(c, 0.9);
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + 0.08);
  // 机械锁定滴声（短促高频正弦）
  const o = osc(c, "sine", 1400);
  o.frequency.linearRampToValueAtTime(1100, t + 0.06);
  const go = gainNode(c, 0.5);
  go.gain.setValueAtTime(0.5, t);
  go.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(go); go.connect(master);
  o.start(t); o.stop(t + 0.1);
}

// ─── 冻结音效 ──────────────────────────────────────────────────────────────────

function playFreeze() {
  const c = getCtx(); const t = c.currentTime;
  const master = getMaster(c);
  // 冰晶炸裂噪声（高频）
  const n = makeNoise(c, 0.22);
  const f = c.createBiquadFilter();
  f.type = "highpass"; f.frequency.value = 3500;
  const g = gainNode(c, 0.85);
  g.gain.setValueAtTime(0.85, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + 0.23);
  // 冰封音调下降（玻璃音色）
  const o = osc(c, "sine", 1800);
  o.frequency.exponentialRampToValueAtTime(420, t + 0.28);
  const go = gainNode(c, 0.7);
  go.gain.setValueAtTime(0.7, t);
  go.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(go); go.connect(master);
  o.start(t); o.stop(t + 0.31);
  // 短促冰击（中频）
  const n2 = makeNoise(c, 0.06);
  const f2 = c.createBiquadFilter();
  f2.type = "bandpass"; f2.frequency.value = 1200; f2.Q.value = 2;
  const g2 = gainNode(c, 0.65);
  g2.gain.setValueAtTime(0.65, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  n2.connect(f2); f2.connect(g2); g2.connect(master);
  n2.start(t); n2.stop(t + 0.07);
}

// ─── 对外统一接口 ──────────────────────────────────────────────────────────────

export function playSound({ type, characterId, impactSpeed, strikeType }) {
  try {
    resumeAudio();
    if (type === "ballCollision") {
      playBallCollision(impactSpeed);
    } else if (type === "wallBounce") {
      playWallBounce();
    } else if (type === "basicAttack") {
      basicAttackSounds[characterId]?.();
    } else if (type === "ultimate") {
      ultimateSounds[characterId]?.();
    } else if (type === "swordHit") {
      playSwordHit();
    } else if (type === "turretPlace") {
      playTurretPlace();
    } else if (type === "freeze") {
      playFreeze();
    } else if (type === "strikeExplode") {
      if (strikeType === "lightning") {
        playLightningImpact();
      } else {
        playBombExplosion();
      }
    }
  } catch {
    // 音频错误不应影响游戏运行
  }
}
