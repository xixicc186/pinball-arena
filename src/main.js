import {
  CHARACTER_LIBRARY,
  getCharacterById,
  resetCharacterValues,
  summarizeTriggers,
  updateCharacterValue,
} from "./characters.js";
import { ArenaGame } from "./game.js";
import { clearOverrides, getLeaderboard, loadAllOverrides, saveOverrides, updateCharacterScores } from "./db.js";

const rosterElement = document.getElementById("roster");
const rosterStatusElement = document.getElementById("roster-status");
const modalRosterStatusElement = document.getElementById("modal-roster-status");
const editorElement = document.getElementById("character-editor");
const startButton = document.getElementById("start-button");
const recordButton = document.getElementById("record-button");
const resetButton = document.getElementById("reset-button");
const selectAllButton = document.getElementById("select-all-button");
const clearRosterButton = document.getElementById("clear-roster-button");
const openRosterButton = document.getElementById("open-roster-button");
const closeRosterButton = document.getElementById("close-roster-button");
const rosterModal = document.getElementById("roster-modal");
const openLeaderboardButton = document.getElementById("open-leaderboard-button");
const closeLeaderboardButton = document.getElementById("close-leaderboard-button");
const saveLeaderboardButton = document.getElementById("save-leaderboard-button");
const leaderboardModal = document.getElementById("leaderboard-modal");
const leaderboardRowsEl = document.getElementById("leaderboard-rows");
const edgeSpikesToggle = document.getElementById("edge-spikes-toggle");
const duelTimeInput = document.getElementById("duel-time-input");
const overlay = document.getElementById("overlay");
const entryStage = document.getElementById("entry-stage");
const entryStageCards = document.getElementById("entry-stage-cards");
const scoreboard = document.getElementById("scoreboard");
const feed = document.getElementById("feed");
const hudTimer = document.getElementById("hud-timer");
const hudPhase = document.getElementById("hud-phase");
const canvas = document.getElementById("arena-canvas");

const DEFAULT_DUEL_TIME = 45;
const RECORDING_FPS = 60;
const RECORDING_BITS_PER_SECOND = 24_000_000;
const RECORDING_END_HOLD_MS = 5000;
const ENTRY_CARD_STAGGER_MS = 200;
const ENTRY_HOLD_MS = 1800;
const ENTRY_OUTRO_MS = 1100;

let selectedId = CHARACTER_LIBRARY[0].id;
let selectedRosterIds = new Set(CHARACTER_LIBRARY.map((character) => character.id));
const matchSettings = {
  includeEdgeHazards: true,
  duelTime: DEFAULT_DUEL_TIME,
};
const recordingState = {
  active: false,
  recorder: null,
  stream: null,
  chunks: [],
  mimeType: "",
  renderCanvas: null,
  renderCtx: null,
  latestSnapshot: null,
  stopTimeoutId: null,
  stopAnimationFrameId: null,
  drawLoopId: null,
  pendingMatchResult: null,
};

// 排行榜：{ characterId: { name, score } }
let leaderboardScores = {};
// 当前对局结算结果
let currentMatchResult = null;
const entryState = {
  active: false,
  outroActive: false,
  outroStartTime: 0,
  outroBalls: [],      // canvas-relative positions for recording-mode transition
  timeoutIds: [],
  characters: [],
  animFrameId: null,
  animStart: 0,
};
const battleFeedItems = [];

function sanitizeDuelTime(value) {
  return Math.max(5, Math.min(180, Math.round(value || DEFAULT_DUEL_TIME)));
}

function pushFeed(stamp, message) {
  battleFeedItems.unshift({ stamp, message });
  if (battleFeedItems.length > 3) {
    battleFeedItems.length = 3;
  }

  const item = document.createElement("div");
  item.className = "feed-item";
  item.innerHTML = `<time>${stamp}</time><span>${message}</span>`;
  feed.prepend(item);

  while (feed.childElementCount > 3) {
    feed.removeChild(feed.lastElementChild);
  }

  renderRecordingFrame();
}

function formatEditorValue(value) {
  if (typeof value !== "number") {
    return "";
  }
  if (Number.isInteger(value)) {
    return `${value}`;
  }
  return `${Number(value.toFixed(3))}`;
}

function getRosterIds() {
  return CHARACTER_LIBRARY
    .map((character) => character.id)
    .filter((id) => selectedRosterIds.has(id));
}

function syncRosterSelection() {
  return;
}

function canStartMatch() {
  return getRosterIds().length >= 2;
}

function updateRosterStatus() {
  const selectedCount = getRosterIds().length;
  const text = selectedCount >= 2
    ? `已选择 ${selectedCount} 名出战角色`
    : `已选择 ${selectedCount} 名出战角色，至少需要 2 名才能开始`;

  rosterStatusElement.textContent = text;
  modalRosterStatusElement.textContent =
    `${text}。点击卡片切换编辑对象，标记为”出战”的角色将全部参与对战。`;

  if (entryState.active) {
    startButton.disabled = true;
    startButton.textContent = "登场中...";
    return;
  }

  startButton.disabled = !canStartMatch() || recordingState.active;
  startButton.textContent = canStartMatch() ? "开始出战" : "至少选择 2 名角色";
}

function collectOverrides(character) {
  const result = {};
  character.editorSections.flatMap((section) => section.fields).forEach((field) => {
    result[field.path] = field.path.split(".").reduce((value, key) => value?.[key], character);
  });
  return result;
}

function openRosterModal() {
  rosterModal.classList.remove("hidden");
  rosterModal.setAttribute("aria-hidden", "false");
}

function closeRosterModal() {
  rosterModal.classList.add("hidden");
  rosterModal.setAttribute("aria-hidden", "true");
}

function renderRoster() {
  rosterElement.innerHTML = "";
  syncRosterSelection();

  CHARACTER_LIBRARY.forEach((character) => {
    const included = selectedRosterIds.has(character.id);
    const selected = character.id === selectedId;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `character-card${selected ? " selected" : ""}${included ? "" : " excluded"}`;
    card.style.setProperty("--card-glow", `${character.color}55`);

    const tags = summarizeTriggers(character)
      .map((tag) => `<span class="tag">${tag}</span>`)
      .join("");

    card.innerHTML = `
      <div class="card-topline">
        <div class="card-title">
          <span class="swatch" style="color:${character.color}; background:${character.color};"></span>
          <div>
            <strong>${character.name}</strong>
            <span>${character.title}</span>
          </div>
        </div>
        <div class="card-controls">
          <span class="card-toggle${selected ? " active" : " ghost"}"></span>
          <span class="card-toggle${included ? " active" : " ghost"}"></span>
        </div>
      </div>
      <p class="card-desc">${character.description}</p>
      <div class="tag-row">${tags}</div>
      <div class="stats-row">
        <span class="stat">HP ${character.stats.maxHp}</span>
        <span class="stat">閫熷害 ${character.stats.speed}</span>
        <span class="stat">绮惧厓 ${character.stats.maxEssence}</span>
        <span class="stat">绱㈡晫 ${character.stats.attackRange}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      selectedId = character.id;
      renderRoster();
      renderEditor();
    });

    const toggles = card.querySelectorAll(".card-toggle");
    toggles[0].textContent = selected ? "正在编辑" : "点击编辑";
    toggles[1].textContent = included ? "出战" : "不出战";
    toggles[0].addEventListener("click", (event) => {
      event.stopPropagation();
      selectedId = character.id;
      renderRoster();
      renderEditor();
    });

    toggles[1].addEventListener("click", (event) => {
      event.stopPropagation();
      if (included) {
        selectedRosterIds.delete(character.id);
      } else {
        selectedRosterIds.add(character.id);
      }
      renderRoster();
    });

    rosterElement.appendChild(card);
  });

  updateRosterStatus();
  updateRecordButton();
}

function renderEditor() {
  const character = getCharacterById(selectedId);
  if (!character) {
    editorElement.innerHTML = '<p class="editor-empty">鏈壘鍒拌鑹查厤缃€?/p>';
    return;
  }

  editorElement.innerHTML = `
    <section class="editor-section">
      <h3>${character.name} 路 ${character.title}</h3>
      <p class="editor-note">${character.description}</p>
    </section>
  `;

  character.editorSections.forEach((section) => {
    const block = document.createElement("section");
    block.className = "editor-section";

    const title = document.createElement("h3");
    title.textContent = section.title;
    block.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "editor-grid";

    section.fields.forEach((field) => {
      const wrapper = document.createElement("label");
      wrapper.className = "field";

      const text = document.createElement("span");
      text.textContent = field.unit ? `${field.label} (${field.unit})` : field.label;

      const input = document.createElement("input");
      input.type = "number";
      input.min = `${field.min ?? 0}`;
      if (field.max != null) {
        input.max = `${field.max}`;
      }
      input.step = `${field.step ?? 1}`;
      input.value = formatEditorValue(
        field.path.split(".").reduce((value, key) => value?.[key], character),
      );

      input.addEventListener("change", () => {
        const nextValue = Number(input.value);
        if (Number.isNaN(nextValue)) {
          input.value = formatEditorValue(
            field.path.split(".").reduce((value, key) => value?.[key], character),
          );
          return;
        }

        const clamped = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, nextValue));
        updateCharacterValue(character.id, field.path, clamped);
        saveOverrides(character.id, collectOverrides(character));
        renderRoster();
        renderEditor();
      });

      wrapper.append(text, input);
      grid.appendChild(wrapper);
    });

    block.appendChild(grid);
    editorElement.appendChild(block);
  });
}

function renderScoreboard(snapshot) {
  if (!snapshot) {
    scoreboard.innerHTML = "";
    return;
  }

  const rows = [...snapshot.actors].sort((left, right) => {
    if (left.alive !== right.alive) {
      return left.alive ? -1 : 1;
    }
    return right.hp - left.hp;
  });

  scoreboard.innerHTML = rows
    .map((actor) => {
      const character = getCharacterById(actor.characterId);
      const hpRatio = actor.maxHp ? actor.hp / actor.maxHp : 0;
      const essenceRatio = actor.maxEssence ? actor.essence / actor.maxEssence : 0;
      const title = character?.title ?? "";
      const skillText = [
        character?.basicAttack?.name ? `骞矨 ${character.basicAttack.name}` : "",
        character?.ultimate?.name ? `澶ф嫑 ${character.ultimate.name}` : "",
      ]
        .filter(Boolean)
        .join(" 路 ");

      return `
        <div class="score-row${actor.isPlayer ? " player" : ""}${actor.alive ? "" : " dead"}">
          <div class="score-row-head">
            <div class="score-name">
              <strong style="color:${actor.color}">${actor.name}</strong>
              ${title ? `<span class="score-title">${title}</span>` : ""}
            </div>
            <span class="score-state">${actor.alive ? "瀛樻椿" : "娣樻卑"}</span>
          </div>
          <div class="hp-bar">
            <div class="hp-fill" style="width:${Math.max(hpRatio, 0) * 100}%"></div>
          </div>
          <div class="essence-bar">
            <div class="essence-fill" style="width:${Math.max(essenceRatio, 0) * 100}%"></div>
          </div>
          <div class="score-meta">HP ${actor.hp}/${actor.maxHp} 路 绮惧厓 ${actor.essence}/${actor.maxEssence}</div>
          ${skillText ? `<div class="score-skills">${skillText}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function updateHud(snapshot) {
  if (!snapshot) {
    hudTimer.textContent = "0.0s";
    hudPhase.textContent = `常规阶段，${matchSettings.duelTime}s 后进入决斗`;
    return;
  }

  hudTimer.textContent = `${snapshot.elapsed.toFixed(1)}s`;
  hudPhase.textContent = snapshot.duelTriggered
    ? "决斗时刻"
    : `常规阶段，${snapshot.nextPhaseIn.toFixed(1)}s 后进入决斗`;
}

function syncDuelTimeInput() {
  duelTimeInput.value = `${matchSettings.duelTime}`;
}

function getScoreboardEntries(snapshot) {
  if (!snapshot) {
    return [];
  }

  return [...snapshot.actors]
    .sort((left, right) => {
      if (left.alive !== right.alive) {
        return left.alive ? -1 : 1;
      }
      return right.hp - left.hp;
    })
    .map((actor) => {
      const character = getCharacterById(actor.characterId);

      return {
        ...actor,
        title: character?.title ?? "",
      };
    });
}

function getHudDisplay(snapshot) {
  if (!snapshot) {
    return {
      timer: "0.0s",
      phase: `常规阶段，${matchSettings.duelTime}s 后进入决斗`,
    };
  }

  return {
    timer: `${snapshot.elapsed.toFixed(1)}s`,
    phase: snapshot.duelTriggered ? "决斗时刻" : `常规阶段，${snapshot.nextPhaseIn.toFixed(1)}s 后进入决斗`,
  };
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const nextRadius = Math.min(radius, width * 0.5, height * 0.5);

  ctx.beginPath();
  ctx.moveTo(x + nextRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, nextRadius);
  ctx.arcTo(x + width, y + height, x, y + height, nextRadius);
  ctx.arcTo(x, y + height, x, y, nextRadius);
  ctx.arcTo(x, y, x + width, y, nextRadius);
  ctx.closePath();
}

function fillRoundedPanel(ctx, x, y, width, height, radius) {
  ctx.save();
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = "rgba(8, 8, 8, 0.78)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.stroke();
  ctx.restore();
}

function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
  if (!text) {
    return [""];
  }

  const lines = [];
  let current = "";

  for (const char of Array.from(text)) {
    const next = `${current}${char}`;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = char;
      if (lines.length === maxLines) {
        break;
      }
      continue;
    }
    current = next;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  if (!lines.length) {
    lines.push("");
  }

  if (lines.length === maxLines && current && lines[lines.length - 1] !== current) {
    const truncated = lines[lines.length - 1];
    lines[lines.length - 1] = truncated.length > 1 ? `${truncated.slice(0, -1)}...` : "...";
  }

  return lines;
}

function drawTextBlock(ctx, text, x, y, maxWidth, lineHeight, maxLines = Infinity) {
  const lines = wrapText(ctx, text, maxWidth, maxLines);
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight);
  });
  return lines.length;
}

function drawRecordingOverlay(ctx, width, height, margin, radius) {
  if (overlay.classList.contains("hidden")) {
    return;
  }

  const eyebrow = overlay.querySelector(".overlay-eyebrow")?.textContent?.trim() ?? "";
  const title = overlay.querySelector("h2")?.textContent?.trim() ?? "";
  const body = [...overlay.querySelectorAll("p")]
    .map((element) => element.textContent?.trim() ?? "")
    .filter((text) => text && text !== eyebrow)
    .join(" ");

  if (!eyebrow && !title && !body) {
    return;
  }

  const portrait = height > width;
  const panelWidth = portrait
    ? width - margin * 2
    : Math.min(Math.round(width * 0.34), width - margin * 2);
  const padding = Math.round(width * 0.012);
  const lineGap = Math.round(height * 0.01);

  ctx.save();
  ctx.font = `600 ${Math.round(height * 0.014)}px "Microsoft YaHei UI", sans-serif`;
  const eyebrowHeight = Math.round(height * 0.016);

  ctx.font = `700 ${Math.round(height * 0.026)}px Georgia, "Microsoft YaHei UI", serif`;
  const titleLineHeight = Math.round(height * 0.03);
  const titleLines = wrapText(ctx, title, panelWidth - padding * 2, 3);

  ctx.font = `500 ${Math.round(height * 0.013)}px "Microsoft YaHei UI", sans-serif`;
  const bodyLineHeight = Math.round(height * 0.018);
  const bodyLines = body ? wrapText(ctx, body, panelWidth - padding * 2, 3) : [];

  const panelHeight =
    padding * 2 +
    eyebrowHeight +
    lineGap +
    titleLines.length * titleLineHeight +
    (bodyLines.length ? lineGap + bodyLines.length * bodyLineHeight : 0);
  const x = margin;
  const y = height - margin - panelHeight;

  fillRoundedPanel(ctx, x, y, panelWidth, panelHeight, radius);

  let cursorY = y + padding + eyebrowHeight;
  ctx.fillStyle = "#f3d2a2";
  ctx.font = `600 ${Math.round(height * 0.014)}px "Microsoft YaHei UI", sans-serif`;
  if (eyebrow) {
    ctx.fillText(eyebrow, x + padding, cursorY);
    cursorY += lineGap;
  }

  ctx.fillStyle = "#fff7eb";
  ctx.font = `700 ${Math.round(height * 0.026)}px Georgia, "Microsoft YaHei UI", serif`;
  titleLines.forEach((line) => {
    cursorY += titleLineHeight;
    ctx.fillText(line, x + padding, cursorY);
  });

  if (bodyLines.length) {
    cursorY += lineGap;
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.font = `500 ${Math.round(height * 0.013)}px "Microsoft YaHei UI", sans-serif`;
    bodyLines.forEach((line) => {
      cursorY += bodyLineHeight;
      ctx.fillText(line, x + padding, cursorY);
    });
  }
  ctx.restore();
}

// 根据参赛人数计算每个名次的积分变化
// 2人: [+1,-1]  3人: [+1,0,-1]  4人: [+2,+1,0,-1]  5人: [+2,+1,0,-1,-2] ...
function getScoreChanges(n) {
  if (n === 2) return [1, -1];
  const max = Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) => max - i);
}

// 在 canvas 上绘制本场积分结算面板
function drawMatchResultOnCanvas(ctx, W, H, matchResult) {
  if (!matchResult || !matchResult.entries.length) return;

  const entries = matchResult.entries;
  const n = entries.length;

  const mg = 32;
  const rd = 18;
  const headerH = Math.round(H * 0.055);
  const rowH = Math.round(H * 0.062);
  const pad = Math.round(W * 0.032);
  const panelW = Math.min(Math.round(W * 0.85), W - mg * 2);
  const panelH = headerH + rowH * n + pad;
  const panelX = Math.round((W - panelW) / 2);
  const panelY = Math.round((H - panelH) / 2);

  ctx.save();

  // 面板背景
  fillRoundedPanel(ctx, panelX, panelY, panelW, panelH, rd);

  // 标题
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f3d2a2";
  ctx.font = `700 ${Math.round(H * 0.022)}px "Microsoft YaHei UI", sans-serif`;
  ctx.fillText("本场积分结算", W / 2, panelY + headerH * 0.52);

  // 分隔线
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelX + pad, panelY + headerH);
  ctx.lineTo(panelX + panelW - pad, panelY + headerH);
  ctx.stroke();

  const rankColors = ["#ffd700", "#c0c0c0", "#cd7f32"];

  entries.forEach((entry, i) => {
    const rowY = panelY + headerH + rowH * i;
    const midY = rowY + rowH * 0.5;
    const rankColor = i < 3 ? rankColors[i] : "rgba(200,200,200,0.55)";

    // 名次圈
    const rankX = panelX + pad + Math.round(W * 0.042);
    ctx.beginPath();
    ctx.arc(rankX, midY, Math.round(H * 0.022), 0, Math.PI * 2);
    ctx.fillStyle = i < 3 ? rankColor + "33" : "rgba(255,255,255,0.08)";
    ctx.fill();
    ctx.strokeStyle = rankColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = rankColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(H * 0.02)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(`${i + 1}`, rankX, midY);

    // 角色名称（带颜色）
    ctx.fillStyle = entry.color;
    ctx.textAlign = "left";
    ctx.font = `600 ${Math.round(H * 0.022)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(entry.name, panelX + pad + Math.round(W * 0.1), midY);

    // 积分变化
    const deltaText = entry.delta > 0 ? `+${entry.delta}` : `${entry.delta}`;
    ctx.fillStyle = entry.delta > 0 ? "#4ade80" : entry.delta < 0 ? "#f87171" : "rgba(160,160,160,0.8)";
    ctx.textAlign = "right";
    ctx.font = `700 ${Math.round(H * 0.026)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(deltaText, panelX + panelW - pad - Math.round(W * 0.18), midY);

    // 总分
    ctx.fillStyle = "rgba(255,247,235,0.75)";
    ctx.textAlign = "right";
    ctx.font = `500 ${Math.round(H * 0.017)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(`总分 ${entry.newScore}`, panelX + panelW - pad, midY);
  });

  ctx.restore();
}

function renderRecordingFrame(snapshot = recordingState.latestSnapshot) {
  if (snapshot) {
    recordingState.latestSnapshot = snapshot;
  }
}
function canRecordCanvas() {
  return typeof canvas.captureStream === "function" && typeof MediaRecorder !== "undefined";
}

function getRecordingMimeType() {
  const mimeTypes = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  return mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function getRecordingExtension(mimeType) {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

function buildRecordingFilename() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];

  return `pinball-duel-${parts.join("")}`;
}

function updateRecordButton() {
  if (!recordButton) {
    return;
  }

  const supported = canRecordCanvas();

  if (entryState.active) {
    recordButton.disabled = true;
    recordButton.textContent = "登场中...";
    return;
  }

  recordButton.disabled = recordingState.active ? false : !canStartMatch() || !supported;
  if (recordingState.active) {
    recordButton.textContent = "停止录制";
    return;
  }

  recordButton.textContent = supported ? "录制对局" : "无法录制";
}

function downloadRecording(blob, mimeType) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${buildRecordingFilename()}.${getRecordingExtension(mimeType)}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearScheduledRecordingStop() {
  if (recordingState.stopTimeoutId != null) {
    clearTimeout(recordingState.stopTimeoutId);
    recordingState.stopTimeoutId = null;
  }

  if (recordingState.stopAnimationFrameId != null) {
    cancelAnimationFrame(recordingState.stopAnimationFrameId);
    recordingState.stopAnimationFrameId = null;
  }
}

function drawRoundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth, maxSize, minSize = 16) {
  let size = maxSize;
  ctx.font = ctx.font.replace(/\d+px/, `${size}px`);
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    ctx.font = ctx.font.replace(/\d+px/, `${size}px`);
  }
  return size;
}

// ── 出场动画（Entry Animation）────────────────────────────────────────────────

function showEntryStage() {
  if (!recordingState.active) {
    entryStage.classList.remove("hidden");
  }
}

function hideEntryStage() {
  if (entryState.outroActive) return;
  entryStage.classList.remove("entry-stage-outro");
  entryStage.classList.add("hidden");
  entryStageCards.innerHTML = "";
  entryState.characters = [];
  stopEntryBallLoop();
}

function runEntryOutroTransition() {
  // outroActive 已由 startMatch 在 game.start() 之前设置为 true
  return new Promise((resolve) => {
    const dpr = window.devicePixelRatio || 1;
    const animStart = entryState.animStart;
    const arenaCanvas = document.getElementById("arena-canvas");
    const arenaRect = arenaCanvas.getBoundingClientRect();

    // 游戏世界坐标 → CSS 屏幕坐标的换算比例
    const cssScaleX = arenaRect.width / 540;   // WORLD_WIDTH = 540
    const cssScaleY = arenaRect.height / 960;  // WORLD_HEIGHT = 960

    // 建立 characterId → actor 的映射（game.state.actors 是活跃引用，位置实时更新）
    const actorByCharId = {};
    // 录制模式：构建 canvas 飞行小球数据，重启录制循环渲染转场
    if (recordingState.active) {
      const cssW = arenaCanvas.width / dpr;  // canvas 的 CSS 宽（等于 arenaRect.width）
      const cssH = arenaCanvas.height / dpr;
      const layout = getRecordingLayout(cssW, cssH, entryState.characters.length);
      entryState.outroStartTime = performance.now();
      entryState.outroBalls = entryState.characters.map((character, i) => ({
        character,
        actor: null,  // 在 actorByCharId 建立后填充，见下方
        startCx: layout.innerX + layout.cardPadH + layout.ballSize / 2,
        startCy: layout.cardsTop + i * (layout.cardH + layout.cardGap) + layout.cardH / 2,
        startSize: layout.ballSize,
      }));
      startEntryRecordingLoop(); // 重启录制循环以渲染转场
    }
    if (game.state && game.state.actors) {
      for (const actor of game.state.actors) {
        actorByCharId[actor.characterId] = actor;
      }
    }
    // 录制模式：回填 outroBalls 中的 actor 引用（actorByCharId 刚建好）
    if (recordingState.active) {
      entryState.outroBalls.forEach((ball) => {
        ball.actor = actorByCharId[ball.character.id] ?? null;
      });
    }

    // 录制模式下 HTML 出场舞台是隐藏的，需从录制画布布局反算小球屏幕坐标
    const recordingPositions = recordingState.active ? getRecordingBallScreenPositions() : null;

    // 捕获每个卡片小球的屏幕位置，创建飞行浮层
    const flyingBalls = Array.from(entryStageCards.children).map((card, index) => {
      const ballCanvas = card.querySelector(".entry-card-ball");
      const character = entryState.characters[index];
      if (!ballCanvas || !character) return null;

      const actor = actorByCharId[character.id];

      // 录制模式：从录制画布布局计算起点；普通模式：从 HTML DOM 取位置
      let startCx, startCy, startSize;
      if (recordingPositions && recordingPositions[index]) {
        const rp = recordingPositions[index];
        startCx = rp.x;
        startCy = rp.y;
        startSize = rp.size;
      } else {
        const rect = ballCanvas.getBoundingClientRect();
        startSize = rect.width;
        startCx = rect.left + startSize / 2;
        startCy = rect.top + startSize / 2;
      }
      // 目标尺寸：actor 在屏幕上的实际直径
      const targetSize = actor ? actor.radius * cssScaleX * 2 : startSize * 0.35;

      const flyCanvas = document.createElement("canvas");
      flyCanvas.width = Math.round(startSize * dpr);
      flyCanvas.height = Math.round(startSize * dpr);
      flyCanvas.style.cssText = `
        position: fixed;
        left: ${startCx - startSize / 2}px;
        top: ${startCy - startSize / 2}px;
        width: ${startSize}px;
        height: ${startSize}px;
        pointer-events: none;
        z-index: 1000;
      `;
      const elapsed = (performance.now() - animStart) / 1000;
      game.renderBallPreview(flyCanvas.getContext("2d"), character, elapsed);
      document.body.appendChild(flyCanvas);

      return { flyCanvas, character, actor, startCx, startCy, startSize, targetSize };
    }).filter(Boolean);

    // 触发 CSS 转场：快速淡出覆盖层，场地迅速显现
    entryStage.classList.add("entry-stage-outro");

    const startTime = performance.now();
    let rafId;

    const animLoop = (now) => {
      const t = Math.min((now - startTime) / ENTRY_OUTRO_MS, 1);
      // ease-in-out cubic：缓入缓出，起步温柔，落地平稳
      const moveEase = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const ballElapsed = (now - animStart) / 1000;

      flyingBalls.forEach(({ flyCanvas, character, actor, startCx, startCy, startSize, targetSize }) => {
        // 追踪 actor 的实时位置（actor.position 由游戏物理每帧更新）
        let targetCx, targetCy;
        if (actor && actor.alive !== false && actor.position) {
          targetCx = arenaRect.left + actor.position.x * cssScaleX;
          targetCy = arenaRect.top + actor.position.y * cssScaleY;
        } else {
          targetCx = arenaRect.left + arenaRect.width / 2;
          targetCy = arenaRect.top + arenaRect.height / 2;
        }

        // 当前尺寸：从 startSize 线性缩小到 targetSize
        const currentSize = startSize + (targetSize - startSize) * moveEase;
        // 当前中心位置
        const cx = startCx + (targetCx - startCx) * moveEase;
        const cy = startCy + (targetCy - startCy) * moveEase;

        // 透明度：前 72% 完全不透明，72%~97% 渐隐（让小球充分抵达后再消失）
        const fadeStart = 0.72;
        const fadeEnd = 0.97;
        const opacity = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (fadeEnd - fadeStart));

        flyCanvas.style.left = `${cx - currentSize / 2}px`;
        flyCanvas.style.top = `${cy - currentSize / 2}px`;
        flyCanvas.style.width = `${currentSize}px`;
        flyCanvas.style.height = `${currentSize}px`;
        flyCanvas.style.opacity = opacity;

        if (opacity > 0.02) {
          const flyCtx = flyCanvas.getContext("2d");
          flyCtx.clearRect(0, 0, flyCanvas.width, flyCanvas.height);
          game.renderBallPreview(flyCtx, character, ballElapsed);
        }
      });

      if (t < 1) {
        rafId = requestAnimationFrame(animLoop);
      } else {
        flyingBalls.forEach(({ flyCanvas }) => flyCanvas.remove());
        entryState.outroBalls = [];
        entryState.outroActive = false; // 录制循环的退出条件
        resolve();
      }
    };

    rafId = requestAnimationFrame(animLoop);
  });
}

function clearEntryTimers() {
  entryState.timeoutIds.forEach((id) => clearTimeout(id));
  entryState.timeoutIds = [];
}

function stopEntryBallLoop() {
  if (entryState.animFrameId != null) {
    cancelAnimationFrame(entryState.animFrameId);
    entryState.animFrameId = null;
  }
}

function startEntryBallLoop() {
  stopEntryBallLoop();
  entryState.animStart = performance.now();

  const loop = () => {
    if (!entryState.active) {
      entryState.animFrameId = null;
      return;
    }
    const elapsed = (performance.now() - entryState.animStart) / 1000;
    entryState.characters.forEach((character, index) => {
      const card = entryStageCards.children[index];
      const ballCanvas = card?.querySelector(".entry-card-ball");
      if (!ballCanvas) return;
      const bCtx = ballCanvas.getContext("2d");
      bCtx.clearRect(0, 0, ballCanvas.width, ballCanvas.height);
      game.renderBallPreview(bCtx, character, elapsed);
    });
    entryState.animFrameId = requestAnimationFrame(loop);
  };

  entryState.animFrameId = requestAnimationFrame(loop);
}

function runEntryAnimation(characterIds) {
  clearEntryTimers();
  entryState.active = true;
  entryState.characters = characterIds.map((id) => getCharacterById(id)).filter(Boolean);
  entryStageCards.innerHTML = "";

  showEntryStage();
  startEntryRecordingLoop();
  updateRosterStatus();
  updateRecordButton();

  const dpr = window.devicePixelRatio || 1;
  const cssSize = 64;
  const canvasSize = Math.round(cssSize * dpr);

  entryState.characters.forEach((character, index) => {
    const card = document.createElement("article");
    card.className = "entry-card";
    card.style.setProperty("--char-color", character.color);
    card.style.animationDelay = `${index * ENTRY_CARD_STAGGER_MS}ms`;

    const basicName = character.basicAttack?.name ?? "";
    const ultName = character.ultimate?.name ?? "";
    const skillsHtml = [
      basicName ? `<div class="entry-skill"><span class="entry-skill-label">普攻</span><span class="entry-skill-name">${basicName}</span></div>` : "",
      ultName ? `<div class="entry-skill"><span class="entry-skill-label">大招</span><span class="entry-skill-name">${ultName}</span></div>` : "",
    ].join("");

    card.innerHTML = `
      <canvas class="entry-card-ball" width="${canvasSize}" height="${canvasSize}" style="width:${cssSize}px;height:${cssSize}px;"></canvas>
      <div class="entry-card-info">
        <div class="entry-card-name">${character.name}</div>
        <div class="entry-card-title">${character.title}</div>
        ${character.description ? `<div class="entry-card-desc">${character.description}</div>` : ""}
        <div class="entry-card-skills">${skillsHtml}</div>
      </div>
    `;
    entryStageCards.appendChild(card);
  });

  startEntryBallLoop();

  const totalAnimTime = entryState.characters.length * ENTRY_CARD_STAGGER_MS + 400 + ENTRY_HOLD_MS;

  return new Promise((resolve) => {
    const doneId = window.setTimeout(() => {
      stopEntryBallLoop();
      stopEntryRecordingLoop();
      entryState.active = false;
      clearEntryTimers();
      updateRosterStatus();
      updateRecordButton();
      resolve(characterIds);
    }, totalAnimTime);
    entryState.timeoutIds.push(doneId);
  });
}

// 录制版布局（单列，左右贴边，卡片高度 1.5×，垂直居中）
function getRecordingLayout(cssW, cssH, characterCount) {
  // 小球 & 卡片尺寸：ballSize 按宽度等比，做到约原来 1.5× 高度
  const ballSize   = Math.round(Math.min(cssW * 0.19, 140));
  const cardPadV   = Math.round(ballSize * 0.24);
  const cardPadH   = Math.round(ballSize * 0.22);
  const cardH      = ballSize + cardPadV * 2;
  const cardGap    = Math.round(ballSize * 0.15);
  // 左右贴到视频边缘（仅留 4px 边距）
  const innerPad   = 4;
  const cardW      = cssW - innerPad * 2;
  const innerX     = innerPad;

  // 字体随 ballSize 同步放大
  const eyebrowSize = Math.round(Math.min(cssW * 0.028, 22));
  const titleSize   = Math.round(Math.min(cssW * 0.075, 62));
  const nameSize    = Math.round(Math.min(cssW * 0.050, 40));
  const smallSize   = Math.round(Math.min(cssW * 0.030, 22));
  const pillSize    = Math.round(Math.min(cssW * 0.024, 17));

  // 垂直居中
  const headerGap  = Math.round(cssH * 0.04);
  const headerH    = eyebrowSize + 8 + titleSize;
  const cardsH     = characterCount * cardH + Math.max(0, characterCount - 1) * cardGap;
  const totalH     = headerH + headerGap + cardsH;
  const contentTop = Math.max(12, (cssH - totalH) / 2);

  const eyebrowY  = contentTop + eyebrowSize / 2;
  const titleY    = contentTop + eyebrowSize + 8 + titleSize / 2;
  const cardsTop  = contentTop + headerH + headerGap;

  return {
    innerX, cardW, cardH, cardGap, cardPadV, cardPadH, ballSize,
    eyebrowSize, titleSize, nameSize, smallSize, pillSize,
    eyebrowY, titleY, cardsTop,
  };
}

// 返回录制画布上每个小球的屏幕坐标（用于飞行动画起点）
function getRecordingBallScreenPositions() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const { innerX, cardH, cardGap, cardPadH, ballSize, cardsTop } =
    getRecordingLayout(cssW, cssH, entryState.characters.length);

  const canvasRect = canvas.getBoundingClientRect();

  return entryState.characters.map((_, i) => {
    const ballCx = innerX + cardPadH + ballSize / 2;
    const ballCy = cardsTop + i * (cardH + cardGap) + cardH / 2;
    return {
      x: canvasRect.left + ballCx,
      y: canvasRect.top + ballCy,
      size: ballSize,
    };
  });
}

// 录制转场：游戏已完成本帧渲染，在 canvas 上叠加淡出的出场卡片 + 飞行小球
function renderEntryOutroOnCanvas() {
  if (!recordingState.active) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  const now = performance.now();
  const t = Math.min((now - entryState.outroStartTime) / ENTRY_OUTRO_MS, 1);
  const elapsed = (now - entryState.animStart) / 1000;

  const layout = getRecordingLayout(W, H, entryState.characters.length);
  const { innerX, cardW, cardH, cardGap, cardPadV, cardPadH, ballSize,
          eyebrowSize, titleSize, nameSize, smallSize, pillSize,
          eyebrowY, titleY, cardsTop } = layout;

  ctx.save();
  ctx.scale(dpr, dpr);

  // ── 1. 淡出背景覆盖层（匹配 CSS 500ms 淡出，共 1100ms 总时长）
  const overlayFade = Math.max(0, 1 - t * (ENTRY_OUTRO_MS / 500));
  if (overlayFade > 0.005) {
    ctx.globalAlpha = overlayFade * 0.88;
    ctx.fillStyle = "#040404";
    ctx.fillRect(0, 0, W, H);
    const grd = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.9);
    grd.addColorStop(0, "rgba(255,255,255,0.07)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);

    // ── 2. 淡出标题和卡片（跟背景同步）
    ctx.globalAlpha = overlayFade;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f3d2a2";
    ctx.font = `600 ${eyebrowSize}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText("B A T T L E   S T A R T", W / 2, eyebrowY);
    ctx.fillStyle = "#f3f3f3";
    ctx.font = `700 ${titleSize}px Georgia, "Microsoft YaHei UI", serif`;
    ctx.fillText("参战选手登场", W / 2, titleY);

    entryState.characters.forEach((character, i) => {
      const cardX = innerX;
      const cardY = cardsTop + i * (cardH + cardGap);
      drawRoundRect(ctx, cardX, cardY, cardW, cardH, 18);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const ballCx = cardX + cardPadH + ballSize / 2;
      const ballCy = cardY + cardH / 2;
      const offCanvas = document.createElement("canvas");
      offCanvas.width = Math.round(ballSize * dpr);
      offCanvas.height = Math.round(ballSize * dpr);
      game.renderBallPreview(offCanvas.getContext("2d"), character, elapsed);
      ctx.drawImage(offCanvas, ballCx - ballSize / 2, ballCy - ballSize / 2, ballSize, ballSize);

      const infoX = cardX + cardPadH + ballSize + Math.round(ballSize * 0.22);
      const infoMaxW = cardX + cardW - cardPadH - infoX;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = character.color;
      ctx.font = `700 ${nameSize}px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(character.name, infoX, cardY + cardPadV, infoMaxW);
      ctx.fillStyle = "#a6a6a6";
      ctx.font = `400 ${smallSize}px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(character.title, infoX, cardY + cardPadV + nameSize + 4, infoMaxW);
    });
    ctx.globalAlpha = 1;
  }

  // ── 3. 飞行小球（canvas 版，独立透明度，匹配 HTML DOM 版参数）
  const moveEase = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const fadeStart = 0.72;
  const fadeEnd = 0.97;
  const ballOpacity = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (fadeEnd - fadeStart));

  if (ballOpacity > 0.02) {
    entryState.outroBalls.forEach(({ character, actor, startCx, startCy, startSize }) => {
      // actor 位置（游戏坐标）→ canvas CSS 坐标
      const targetX = actor ? actor.position.x * (W / 540) : W / 2;
      const targetY = actor ? actor.position.y * (H / 960) : H / 2;
      const targetSize = actor ? actor.radius * (W / 540) * 2 : startSize * 0.35;

      const currentSize = startSize + (targetSize - startSize) * moveEase;
      const cx = startCx + (targetX - startCx) * moveEase;
      const cy = startCy + (targetY - startCy) * moveEase;

      const offCanvas = document.createElement("canvas");
      offCanvas.width = Math.round(startSize * dpr);
      offCanvas.height = Math.round(startSize * dpr);
      game.renderBallPreview(offCanvas.getContext("2d"), character, elapsed);

      ctx.save();
      ctx.globalAlpha = ballOpacity;
      ctx.drawImage(offCanvas, cx - currentSize / 2, cy - currentSize / 2, currentSize, currentSize);
      ctx.restore();
    });
  }

  ctx.restore();
}

function renderEntryOnCanvas() {
  if (!recordingState.active) return;
  // 转场阶段：游戏已渲染本帧，叠加淡出覆盖层 + canvas 飞行小球
  if (entryState.outroActive) {
    renderEntryOutroOnCanvas();
    return;
  }
  if (!entryState.active) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  // 以 CSS 像素为单位绘制，最后由 dpr scale 映射到设备像素
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  const elapsedMs = performance.now() - entryState.animStart;
  const elapsed = elapsedMs / 1000;

  ctx.save();
  ctx.scale(dpr, dpr);

  // ── 背景（匹配 .entry-stage CSS）──
  ctx.fillStyle = "#040404";
  ctx.fillRect(0, 0, W, H);
  const grd = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.9);
  grd.addColorStop(0, "rgba(255,255,255,0.07)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // ── 统一布局（垂直居中、比例放大）──
  const characters = entryState.characters;
  const {
    innerX, cardW, cardH, cardGap, cardPadV, cardPadH, ballSize,
    eyebrowSize, titleSize, nameSize, smallSize, pillSize,
    eyebrowY, titleY, cardsTop,
  } = getRecordingLayout(W, H, characters.length);

  // ── 标题区 ──
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#f3d2a2";
  ctx.font = `600 ${eyebrowSize}px "Microsoft YaHei UI", sans-serif`;
  ctx.fillText("B A T T L E   S T A R T", W / 2, eyebrowY);

  ctx.fillStyle = "#f3f3f3";
  ctx.font = `700 ${titleSize}px Georgia, "Microsoft YaHei UI", serif`;
  ctx.fillText("参战选手登场", W / 2, titleY);

  // ── 卡片区 ──
  characters.forEach((character, i) => {
    const cardX = innerX;
    const cardY = cardsTop + i * (cardH + cardGap);

    // 入场动画（stagger slide-in）
    const cardElapsedMs = elapsedMs - i * ENTRY_CARD_STAGGER_MS;
    if (cardElapsedMs <= 0) return;
    const animT = Math.min(cardElapsedMs / 380, 1);
    const ease = 1 - Math.pow(1 - animT, 3);

    ctx.save();
    ctx.globalAlpha = ease;
    ctx.translate(0, (1 - ease) * 18);

    // 卡片背景
    drawRoundRect(ctx, cardX, cardY, cardW, cardH, 18);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 小球预览
    const ballCx = cardX + cardPadH + ballSize / 2;
    const ballCy = cardY + cardH / 2;
    const offCanvas = document.createElement("canvas");
    offCanvas.width = Math.round(ballSize * dpr);
    offCanvas.height = Math.round(ballSize * dpr);
    game.renderBallPreview(offCanvas.getContext("2d"), character, elapsed);
    ctx.drawImage(offCanvas, ballCx - ballSize / 2, ballCy - ballSize / 2, ballSize, ballSize);

    // 文字信息
    const infoX = cardX + cardPadH + ballSize + Math.round(ballSize * 0.22);
    const infoMaxW = cardX + cardW - cardPadH - infoX;

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = character.color;
    ctx.font = `700 ${nameSize}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(character.name, infoX, cardY + cardPadV, infoMaxW);

    ctx.fillStyle = "#a6a6a6";
    ctx.font = `400 ${smallSize}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(character.title, infoX, cardY + cardPadV + nameSize + 4, infoMaxW);

    if (character.description) {
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText(character.description, infoX, cardY + cardPadV + nameSize + 4 + smallSize + 5, infoMaxW);
    }

    // 技能 pill 标签
    const basicName = character.basicAttack?.name ?? "";
    const ultName   = character.ultimate?.name ?? "";
    const skills = [
      basicName ? { label: "普攻", name: basicName } : null,
      ultName   ? { label: "大招", name: ultName   } : null,
    ].filter(Boolean);

    if (skills.length) {
      ctx.font = `400 ${pillSize}px "Microsoft YaHei UI", sans-serif`;
      const pillH = pillSize + 8;
      const skillY = cardY + cardH - cardPadV - pillH / 2;
      let skillX = infoX;

      skills.forEach(({ label, name }) => {
        const labelW = ctx.measureText(label).width;
        const nameW  = ctx.measureText(name).width;
        const pillW  = labelW + nameW + 16 + 6;

        drawRoundRect(ctx, skillX, skillY - pillH / 2, pillW, pillH, pillH / 2);
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textBaseline = "middle";
        ctx.fillStyle = "#a6a6a6";
        ctx.fillText(label, skillX + 8, skillY);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(name, skillX + 8 + labelW + 6, skillY);

        skillX += pillW + 6;
        ctx.textBaseline = "top";
      });
    }

    ctx.restore();
  });

  ctx.restore();
}

function startEntryRecordingLoop() {
  if (!recordingState.active) return;
  stopEntryRecordingLoop(); // 防止重复启动

  const loop = () => {
    // 继续到 active（出场动画）和 outroActive（转场动画）都结束为止
    if (!recordingState.active || (!entryState.active && !entryState.outroActive)) {
      recordingState.drawLoopId = null;
      return;
    }
    renderEntryOnCanvas();
    recordingState.drawLoopId = requestAnimationFrame(loop);
  };

  recordingState.drawLoopId = requestAnimationFrame(loop);
}

function stopEntryRecordingLoop() {
  if (recordingState.drawLoopId != null) {
    cancelAnimationFrame(recordingState.drawLoopId);
    recordingState.drawLoopId = null;
  }
}


function resetRecordingState() {
  stopEntryRecordingLoop();
  clearScheduledRecordingStop();
  recordingState.active = false;
  recordingState.recorder = null;
  recordingState.stream = null;
  recordingState.chunks = [];
  recordingState.mimeType = "";
  recordingState.renderCanvas = null;
  recordingState.renderCtx = null;
  recordingState.latestSnapshot = null;
  recordingState.pendingMatchResult = null;
  updateRecordButton();
}

function scheduleCanvasRecordingStop() {
  if (!recordingState.active) {
    return;
  }

  clearScheduledRecordingStop();

  const renderUntilStop = () => {
    if (!recordingState.active) {
      recordingState.stopAnimationFrameId = null;
      return;
    }

    renderRecordingFrame();
    recordingState.stopAnimationFrameId = requestAnimationFrame(renderUntilStop);
  };

  recordingState.stopAnimationFrameId = requestAnimationFrame(renderUntilStop);
  recordingState.stopTimeoutId = setTimeout(() => {
    clearScheduledRecordingStop();

    if (recordingState.recorder?.state === "recording") {
      recordingState.recorder.requestData();
    }
    stopCanvasRecording();
  }, RECORDING_END_HOLD_MS);
}

function startCanvasRecording() {
  if (!canRecordCanvas()) {
    window.alert("Canvas recording is not supported in this browser.");
    updateRecordButton();
    return false;
  }

  try {
    const mimeType = getRecordingMimeType();
    const stream = canvas.captureStream(RECORDING_FPS);
    const options = {
      videoBitsPerSecond: RECORDING_BITS_PER_SECOND,
    };

    if (mimeType) {
      options.mimeType = mimeType;
    }

    const recorder = new MediaRecorder(stream, options);

    recordingState.active = true;
    recordingState.recorder = recorder;
    recordingState.stream = stream;
    recordingState.chunks = [];
    recordingState.mimeType = mimeType || "video/webm";
    recordingState.renderCanvas = null;
    recordingState.renderCtx = null;
    updateRecordButton();

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        recordingState.chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", async () => {
      const chunks = [...recordingState.chunks];
      const finalMimeType = recordingState.mimeType;
      const pendingResult = recordingState.pendingMatchResult;

      recordingState.stream?.getTracks().forEach((track) => track.stop());
      resetRecordingState();

      if (pendingResult) {
        if (window.confirm("是否将本场积分写入总积分排行榜？")) {
          await updateCharacterScores(
            pendingResult.entries.map((e) => ({
              characterId: e.characterId,
              name: e.name,
              newScore: e.newScore,
            })),
          );
          // 刷新本地排行榜缓存
          leaderboardScores = await getLeaderboard();
        }
      }

      if (chunks.length) {
        const blob = new Blob(chunks, { type: finalMimeType });
        if (window.confirm("录制已完成，是否导出这段视频？")) {
          downloadRecording(blob, finalMimeType);
        }
      }
    });

    recorder.addEventListener("error", () => {
      recordingState.stream?.getTracks().forEach((track) => track.stop());
      resetRecordingState();
      window.alert("Recording failed. Please try again.");
    });

    recorder.start(250);
    return true;
  } catch (error) {
    resetRecordingState();
    window.alert("Unable to start recording. Check MediaRecorder support.");
    return false;
  }
}

function stopCanvasRecording() {
  clearScheduledRecordingStop();

  if (!recordingState.recorder || recordingState.recorder.state === "inactive") {
    return;
  }

  recordingState.recorder.stop();
}

function stopRecordedMatch() {
  if (!recordingState.active) {
    return;
  }

  const snapshot = game.snapshot?.() ?? null;
  if (snapshot) {
    recordingState.latestSnapshot = snapshot;
    renderRecordingFrame(snapshot);
  } else {
    renderRecordingFrame();
  }

  game.stop();
  stopCanvasRecording();
}

async function startMatch({ record = false } = {}) {
  if (recordingState.active || entryState.active) {
    return;
  }

  const selectedIds = getRosterIds();
  if (selectedIds.length < 2) {
    return;
  }

  if (record && !startCanvasRecording()) {
    return;
  }

  game.stop();
  closeRosterModal();
  overlay.classList.add("hidden");
  overlay.innerHTML = "";

  await runEntryAnimation(selectedIds);

  // 必须在 game.start() 之前设置，防止 onMatchStart 同步调用 hideEntryStage() 打断转场
  entryState.outroActive = true;

  const focusId = selectedIds.includes(selectedId) ? selectedId : selectedIds[0];
  game.start(focusId, selectedIds, {
    includeEdgeHazards: matchSettings.includeEdgeHazards,
    duelTime: matchSettings.duelTime,
  });
  // 冻结 actor（不渲染实体，只显示落点标记圈），避免转场期间场地内已有小球运动
  game.startEntryTransition();

  // 转场：场地快速显现，小球飞向各自的落点标记（冻结坐标，无偏差）
  await runEntryOutroTransition();

  // 解冻：actor 获得初始速度，战斗开始
  game.endEntryTransition();
  hideEntryStage();
}

const game = new ArenaGame(canvas, {
  onAnnouncement({ stamp, message }) {
    pushFeed(stamp, message);
  },
  onStateChange(snapshot) {
    updateHud(snapshot);
    renderScoreboard(snapshot);
    recordingState.latestSnapshot = snapshot;
    renderRecordingFrame(snapshot);
    if (snapshot.matchOver && currentMatchResult) {
      drawMatchResultOnCanvas(canvas.getContext("2d"), canvas.width, canvas.height, currentMatchResult);
    }
  },
  onMatchStart(snapshot) {
    hideEntryStage();
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    battleFeedItems.length = 0;
    feed.innerHTML = "";
    currentMatchResult = null;
    updateHud(snapshot);
    renderScoreboard(snapshot);
    recordingState.latestSnapshot = snapshot;
    renderRecordingFrame(snapshot);
  },
  onMatchEnd(snapshot) {
    const winner = snapshot.actors.find((actor) => actor.id === snapshot.winnerId);
    recordingState.latestSnapshot = snapshot;
    overlay.classList.remove("hidden");
    overlay.innerHTML = winner
      ? `
        <p class="overlay-eyebrow">Victory</p>
        <h2>${winner.name} 获得最终胜利</h2>
      `
      : `
        <p class="overlay-eyebrow">Draw</p>
        <h2>本局同归于尽</h2>
      `;

    // 计算本场积分结算
    const finishOrder = snapshot.finishOrder ?? [];
    if (finishOrder.length > 0) {
      const deltas = getScoreChanges(finishOrder.length);
      currentMatchResult = {
        entries: finishOrder.map((actor, i) => ({
          characterId: actor.characterId,
          name: actor.name,
          color: actor.color,
          position: i + 1,
          delta: deltas[i],
          currentScore: leaderboardScores[actor.characterId]?.score ?? 0,
          newScore: (leaderboardScores[actor.characterId]?.score ?? 0) + deltas[i],
        })),
      };
    } else {
      currentMatchResult = null;
    }

    if (recordingState.active && currentMatchResult) {
      recordingState.pendingMatchResult = currentMatchResult;
    }

    renderRecordingFrame(snapshot);
    scheduleCanvasRecordingStop();
  },
});

startButton.addEventListener("click", () => {
  startMatch();
});

recordButton?.addEventListener("click", () => {
  if (recordingState.active) {
    stopRecordedMatch();
    return;
  }

  startMatch({ record: true });
});

resetButton.addEventListener("click", () => {
  resetCharacterValues(selectedId);
  clearOverrides(selectedId);
  renderRoster();
  renderEditor();
});

selectAllButton.addEventListener("click", () => {
  selectedRosterIds = new Set(CHARACTER_LIBRARY.map((character) => character.id));
  renderRoster();
});

clearRosterButton.addEventListener("click", () => {
  selectedRosterIds = new Set([selectedId]);
  renderRoster();
});

openRosterButton.addEventListener("click", () => {
  openRosterModal();
});

closeRosterButton.addEventListener("click", () => {
  closeRosterModal();
});

rosterModal.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeModal === "true") {
    closeRosterModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !rosterModal.classList.contains("hidden")) {
    closeRosterModal();
  }
});

edgeSpikesToggle.addEventListener("change", () => {
  matchSettings.includeEdgeHazards = edgeSpikesToggle.checked;
});

duelTimeInput.addEventListener("change", () => {
  matchSettings.duelTime = sanitizeDuelTime(Number(duelTimeInput.value));
  syncDuelTimeInput();
  if (!overlay.classList.contains("hidden")) {
    updateHud(null);
  }
});

async function initDb() {
  const [allOverrides, scores] = await Promise.all([loadAllOverrides(), getLeaderboard()]);
  leaderboardScores = scores;
  let hasChanges = false;
  for (const [characterId, overrides] of Object.entries(allOverrides)) {
    for (const [path, value] of Object.entries(overrides)) {
      updateCharacterValue(characterId, path, value);
      hasChanges = true;
    }
  }
  if (hasChanges) {
    renderRoster();
    renderEditor();
  }
}

// ── 积分排行榜 Modal ──────────────────────────────────────────────────────────

function openLeaderboardModal() {
  renderLeaderboardModal();
  leaderboardModal.classList.remove("hidden");
  leaderboardModal.setAttribute("aria-hidden", "false");
}

function closeLeaderboardModal() {
  leaderboardModal.classList.add("hidden");
  leaderboardModal.setAttribute("aria-hidden", "true");
}

function renderLeaderboardModal() {
  const entries = CHARACTER_LIBRARY.map((char) => ({
    characterId: char.id,
    name: char.name,
    color: char.color,
    score: leaderboardScores[char.id]?.score ?? 0,
  })).sort((a, b) => b.score - a.score);

  if (entries.length === 0) {
    leaderboardRowsEl.innerHTML = `<tr><td colspan="4" class="leaderboard-empty">暂无积分数据</td></tr>`;
    return;
  }

  leaderboardRowsEl.innerHTML = entries.map((entry, i) => {
    const rank = i + 1;
    const badgeClass = rank <= 3 ? `rank-${rank}` : "rank-other";
    return `
      <tr data-character-id="${entry.characterId}">
        <td class="lb-rank"><span class="lb-rank-badge ${badgeClass}">${rank}</span></td>
        <td class="lb-name">
          <div class="lb-name-cell">
            <span class="lb-color-dot" style="background:${entry.color}"></span>
            <span class="lb-char-name">${entry.name}</span>
          </div>
        </td>
        <td class="lb-score">
          <input type="number" value="${entry.score}" min="0" step="1" data-original="${entry.score}" />
        </td>
        <td class="lb-actions">
          <button type="button" data-reset-id="${entry.characterId}">清零</button>
        </td>
      </tr>`;
  }).join("");

  // 清零按钮
  leaderboardRowsEl.querySelectorAll("[data-reset-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      const input = row.querySelector("input[type=number]");
      if (input) input.value = "0";
    });
  });
}

async function saveLeaderboard() {
  saveLeaderboardButton.disabled = true;
  saveLeaderboardButton.textContent = "保存中…";

  const rows = leaderboardRowsEl.querySelectorAll("tr[data-character-id]");
  const updates = [];
  rows.forEach((row) => {
    const characterId = row.dataset.characterId;
    const input = row.querySelector("input[type=number]");
    if (!input) return;
    const newScore = Math.max(0, parseInt(input.value, 10) || 0);
    const char = CHARACTER_LIBRARY.find((c) => c.id === characterId);
    updates.push({ characterId, name: char?.name ?? characterId, newScore });
  });

  await updateCharacterScores(updates);
  leaderboardScores = await getLeaderboard();

  saveLeaderboardButton.disabled = false;
  saveLeaderboardButton.textContent = "保存修改";
  renderLeaderboardModal();
}

openLeaderboardButton?.addEventListener("click", openLeaderboardModal);
closeLeaderboardButton?.addEventListener("click", closeLeaderboardModal);
saveLeaderboardButton?.addEventListener("click", saveLeaderboard);
leaderboardModal?.querySelector("[data-close-leaderboard]")?.addEventListener("click", closeLeaderboardModal);

// ─────────────────────────────────────────────────────────────────────────────

renderRoster();
renderEditor();
renderScoreboard(null);
syncDuelTimeInput();
updateHud(null);
initDb();

