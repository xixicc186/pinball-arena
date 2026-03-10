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
const drawCountInput = document.getElementById("draw-count-input");
const overlay = document.getElementById("overlay");
const drawStage = document.getElementById("draw-stage");
const drawStageSummaryElement = document.getElementById("draw-stage-summary");
const drawStageSlotsElement = document.getElementById("draw-stage-slots");
const scoreboard = document.getElementById("scoreboard");
const feed = document.getElementById("feed");
const hudTimer = document.getElementById("hud-timer");
const hudPhase = document.getElementById("hud-phase");
const canvas = document.getElementById("arena-canvas");

const DEFAULT_DUEL_TIME = 45;
const DEFAULT_DRAW_COUNT = Math.max(2, Math.min(4, CHARACTER_LIBRARY.length));
const RECORDING_FPS = 60;
const RECORDING_BITS_PER_SECOND = 24_000_000;
const RECORDING_END_HOLD_MS = 5000;
const DRAW_SPIN_INTERVAL_MS = 90;
const DRAW_SETTLE_BASE_MS = 1200;
const DRAW_SETTLE_STEP_MS = 320;
const DRAW_END_HOLD_MS = 650;

let selectedId = CHARACTER_LIBRARY[0].id;
let selectedRosterIds = new Set(CHARACTER_LIBRARY.map((character) => character.id));
let guaranteedIds = new Set();
const matchSettings = {
  includeEdgeHazards: true,
  duelTime: DEFAULT_DUEL_TIME,
  drawCount: DEFAULT_DRAW_COUNT,
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
const drawState = {
  active: false,
  intervalIds: [],
  timeoutIds: [],
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

function sanitizeDrawCount(value, eligibleCount = getRosterIds().length) {
  const rounded = Math.round(value || DEFAULT_DRAW_COUNT);
  if (eligibleCount < 2) {
    return Math.max(2, rounded);
  }
  return Math.max(2, Math.min(eligibleCount, rounded));
}

function canStartMatch() {
  const eligibleCount = getRosterIds().length;
  return eligibleCount >= 2 && matchSettings.drawCount >= 2 && matchSettings.drawCount <= eligibleCount;
}

function syncDrawCountInput() {
  const eligibleCount = getRosterIds().length;
  matchSettings.drawCount = sanitizeDrawCount(matchSettings.drawCount, eligibleCount);
  drawCountInput.min = "2";
  drawCountInput.max = `${Math.max(2, eligibleCount)}`;
  drawCountInput.value = `${matchSettings.drawCount}`;
}

function updateRosterStatus() {
  const eligibleCount = getRosterIds().length;
  const drawCount = Math.min(matchSettings.drawCount, Math.max(eligibleCount, 0));

  let text = `已选择 ${eligibleCount} 名参与抽取角色`;
  if (eligibleCount >= 2) {
    text += `，将随机抽取 ${drawCount} 名进入对战`;
  } else {
    text += "，至少需要 2 名角色才能开始";
  }

  rosterStatusElement.textContent = text;
  modalRosterStatusElement.textContent =
    `${text}。点击卡片切换编辑对象，只有标记为“参与抽取”的角色才会进入抽签池。`;

  if (drawState.active) {
    startButton.disabled = true;
    startButton.textContent = "抽取中...";
    return;
  }

  startButton.disabled = !canStartMatch() || recordingState.active;
  startButton.textContent = canStartMatch() ? "开始抽取并开战" : "至少选择 2 名角色";
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
    const guaranteed = guaranteedIds.has(character.id);
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
          <span class="card-toggle${guaranteed ? " guaranteed" : " ghost"}"></span>
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
    toggles[1].textContent = included ? "参与抽取" : "不参与抽取";
    toggles[2].textContent = guaranteed ? "★ 必选" : "随机";
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
        guaranteedIds.delete(character.id);
      } else {
        selectedRosterIds.add(character.id);
      }
      renderRoster();
    });

    toggles[2].addEventListener("click", (event) => {
      event.stopPropagation();
      if (!included) return;
      if (guaranteed) {
        guaranteedIds.delete(character.id);
      } else {
        guaranteedIds.add(character.id);
      }
      renderRoster();
    });

    rosterElement.appendChild(card);
  });

  syncDrawCountInput();
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

  if (drawState.active) {
    recordButton.disabled = true;
    recordButton.textContent = "抽取中...";
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

function stopDrawRecordingLoop() {
  if (recordingState.drawLoopId != null) {
    cancelAnimationFrame(recordingState.drawLoopId);
    recordingState.drawLoopId = null;
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

function renderDrawOnCanvas() {
  if (!recordingState.active) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;   // 1080
  const H = canvas.height;  // 1920

  const slots = [...drawStageSlotsElement.querySelectorAll(".draw-slot")];
  const slotCount = Math.max(1, slots.length);

  ctx.save();

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = "#080808";
  ctx.fillRect(0, 0, W, H);

  // Radial glow top-left
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.85);
  grd.addColorStop(0, "rgba(255,255,255,0.06)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // Radial glow bottom-right
  const grd2 = ctx.createRadialGradient(W, H, 0, W, H, W * 0.7);
  grd2.addColorStop(0, "rgba(255,255,255,0.04)");
  grd2.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd2;
  ctx.fillRect(0, 0, W, H);

  // ── Layout constants (fixed, not derived from cardH) ────────────────────────
  const cardMg  = 28;
  const cardGap = 14;
  const cardRd  = 14;
  const cardPad = 20;
  const nameSz  = 48;
  const skillGapPx = 54;   // gap between skill rows
  const lblSz   = 18;
  const valSz   = 30;
  const rowH    = lblSz + 5 + valSz + 14;  // one stat row height = 67px

  // ── Calculate card height from settled content ───────────────────────────────
  // top pad + SLOT(19) + gap(30) + name(nameSz) + gap(10) + title(20)
  //   + gap_to_skills(56) + skill1(19) + skillGap + skill2(19) + gap_to_div(22)
  //   + divider(1) + statsGap(20) + 2*rowH + bottom pad
  const cardH = cardPad + 19 + 30 + nameSz + 10 + 20 + 56
              + 19 + skillGapPx + 19 + 22 + 1 + 20 + 2 * rowH + cardPad;
  // ≈ 482px

  const totalGap = cardGap * (slotCount - 1);
  const cardW    = Math.floor((W - cardMg * 2 - totalGap) / slotCount);

  // ── Header sizes ─────────────────────────────────────────────────────────────
  // eyebrow(26) →+42→ title(76) →+90→ summary(30) →+56→ cards
  const headerH = 42 + 90 + 56 + cardH;   // total block height from eyebrow top

  // ── Vertical centering ───────────────────────────────────────────────────────
  const hx        = cardMg;
  const headerTop = Math.round((H - headerH) / 2);
  const cardsTop  = headerTop + 42 + 90 + 56;

  // ── Draw header ──────────────────────────────────────────────────────────────
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // DRAFT eyebrow
  ctx.fillStyle = "#c8a96e";
  ctx.font = `600 26px "Microsoft YaHei UI", sans-serif`;
  ctx.fillText("D R A F T", hx, headerTop);

  // Main title
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 76px Georgia, "Microsoft YaHei UI", serif`;
  ctx.fillText("随机抽取本局参战选手", hx, headerTop + 42);

  // Summary
  const summaryText = drawStageSummaryElement.textContent ?? "";
  if (summaryText) {
    ctx.fillStyle = "rgba(255,255,255,0.52)";
    ctx.font = `400 30px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(summaryText, hx, headerTop + 42 + 90);
  }

  // ── Cards panel ──────────────────────────────────────────────────────────────
  // Panel behind all cards
  drawRoundRect(ctx, cardMg - 12, cardsTop - 16, W - (cardMg - 12) * 2, cardH + 32, 20);
  ctx.fillStyle = "rgba(255,255,255,0.025)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.stroke();

  slots.forEach((slotEl, i) => {
    const settled = slotEl.classList.contains("settled");
    const name = slotEl.querySelector(".draw-slot-label")?.textContent ?? "---";
    const title = slotEl.querySelector(".draw-slot-title")?.textContent ?? "";
    const indexLabel = slotEl.querySelector(".draw-slot-index")?.textContent ?? `Slot ${i + 1}`;
    const character = settled ? CHARACTER_LIBRARY.find((c) => c.name === name) : null;

    const cx = cardMg + i * (cardW + cardGap);
    const cy = cardsTop;

    // ── Card background ──
    drawRoundRect(ctx, cx, cy, cardW, cardH, cardRd);
    if (settled && character) {
      const bg = ctx.createLinearGradient(cx, cy, cx + cardW * 0.6, cy + cardH);
      bg.addColorStop(0, "rgba(28,22,10,0.97)");
      bg.addColorStop(1, "rgba(12,12,12,0.97)");
      ctx.fillStyle = bg;
    } else {
      ctx.fillStyle = "rgba(14,14,22,0.96)";
    }
    ctx.fill();

    // Card border
    ctx.strokeStyle = settled && character
      ? character.color + "70"
      : "rgba(255,255,255,0.10)";
    ctx.lineWidth = settled ? 1.5 : 1;
    ctx.stroke();

    // ── Color accent (settled only) ──
    if (settled && character) {
      ctx.save();
      drawRoundRect(ctx, cx, cy, cardW, cardH, cardRd);
      ctx.clip();

      // Left edge bar gradient
      const barGrad = ctx.createLinearGradient(cx, cy, cx, cy + cardH * 0.55);
      barGrad.addColorStop(0, character.color + "ee");
      barGrad.addColorStop(1, character.color + "00");
      ctx.fillStyle = barGrad;
      ctx.fillRect(cx, cy, 4, cardH);

      // Top glow
      const topGlow = ctx.createLinearGradient(cx, cy, cx, cy + cardH * 0.3);
      topGlow.addColorStop(0, character.color + "28");
      topGlow.addColorStop(1, "transparent");
      ctx.fillStyle = topGlow;
      ctx.fillRect(cx, cy, cardW, cardH * 0.3);

      ctx.restore();
    }

    const tx = cx + cardPad + (settled ? 6 : 0);
    const tw = cardW - cardPad * 2 - (settled ? 6 : 0);

    if (!settled) {
      // ── Spinning state ──
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const midX = cx + cardW / 2;

      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = `600 22px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(indexLabel.toUpperCase(), midX, cy + cardPad + 10);

      ctx.fillStyle = "rgba(200,200,200,0.55)";
      ctx.font = `700 38px "Microsoft YaHei UI", sans-serif`;
      fitText(ctx, name, cardW - 20, 38);
      ctx.fillText(name, midX, cy + cardH / 2 - 19);

      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = `400 22px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText("抽取中...", midX, cy + cardH / 2 + 30);
    } else {
      // ── Settled state ──
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      // SLOT N label
      ctx.fillStyle = "rgba(255,255,255,0.38)";
      ctx.font = `600 19px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(indexLabel.toUpperCase(), tx, cy + cardPad);

      // Character name — auto-fit
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 48px "Microsoft YaHei UI", sans-serif`;
      const nameSz = fitText(ctx, name, tw, 48, 22);
      ctx.fillText(name, tx, cy + cardPad + 30);

      // Title
      ctx.fillStyle = "rgba(255,255,255,0.50)";
      ctx.font = `400 20px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(title, tx, cy + cardPad + 30 + nameSz + 10);

      // ── Skills ──
      const skillsTop = cy + cardPad + 30 + nameSz + 10 + 28 + 28;
      const basicName = slotEl.querySelector(".draw-slot-basic-name")?.textContent ?? "—";
      const ultName   = slotEl.querySelector(".draw-slot-ult-name")?.textContent ?? "—";
      const skillGap  = skillGapPx;

      [["普攻", basicName], ["大招", ultName]].forEach(([label, val], si) => {
        const sy = skillsTop + si * skillGap;

        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(255,255,255,0.38)";
        ctx.font = `500 19px "Microsoft YaHei UI", sans-serif`;
        ctx.fillText(label, tx, sy);

        ctx.textAlign = "right";
        ctx.fillStyle = "#fff7eb";
        ctx.font = `600 19px "Microsoft YaHei UI", sans-serif`;
        // Trim if too long
        let v = val;
        while (ctx.measureText(v).width > tw - 32 && v.length > 1) v = v.slice(0, -1);
        ctx.fillText(v, cx + cardW - cardPad, sy);
      });

      // Horizontal divider
      const divY = skillsTop + 2 * skillGap + 22;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, divY);
      ctx.lineTo(cx + cardW - cardPad, divY);
      ctx.stroke();

      // ── Stats grid ──
      const hp      = slotEl.querySelector(".draw-slot-stat-hp")?.textContent ?? "—";
      const speed   = slotEl.querySelector(".draw-slot-stat-speed")?.textContent ?? "—";
      const essence = slotEl.querySelector(".draw-slot-stat-essence")?.textContent ?? "—";
      const range   = slotEl.querySelector(".draw-slot-stat-range")?.textContent ?? "—";
      const radius  = slotEl.querySelector(".draw-slot-stat-radius")?.textContent ?? "—";

      const statRows = [
        [["HP", hp], ["速度", speed], ["精元", essence]],
        [["索敌", range], ["体型", radius]],
      ];

      const colW    = tw / 3;
      const statsTop = divY + 20;

      statRows.forEach((row, ri) => {
        row.forEach(([label, value], ci) => {
          const sx = tx + ci * colW + colW / 2;
          const sy = statsTop + ri * rowH;

          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(255,255,255,0.38)";
          ctx.font = `500 ${lblSz}px "Microsoft YaHei UI", sans-serif`;
          ctx.fillText(label, sx, sy);

          ctx.fillStyle = "#ffffff";
          ctx.font = `700 ${valSz}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
          ctx.fillText(value, sx, sy + lblSz + 5);
        });
      });
    }
  });

  ctx.restore();
}
function startDrawRecordingLoop() {
  if (!recordingState.active) return;

  const loop = () => {
    if (!recordingState.active || !drawState.active) {
      recordingState.drawLoopId = null;
      return;
    }
    renderDrawOnCanvas();
    recordingState.drawLoopId = requestAnimationFrame(loop);
  };

  recordingState.drawLoopId = requestAnimationFrame(loop);
}

function resetRecordingState() {
  stopDrawRecordingLoop();
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

function clearDrawTimers() {
  drawState.intervalIds.forEach((id) => clearInterval(id));
  drawState.timeoutIds.forEach((id) => clearTimeout(id));
  drawState.intervalIds = [];
  drawState.timeoutIds = [];
}

function showDrawStage() {
  if (!recordingState.active) {
    drawStage.classList.remove("hidden");
  }
}

function hideDrawStage() {
  drawStage.classList.add("hidden");
  drawStageSummaryElement.textContent = "";
  drawStageSlotsElement.innerHTML = "";
}

function sampleDrawRoster(poolIds, count, forcedIds = []) {
  const forced = forcedIds.filter((id) => poolIds.includes(id)).slice(0, count);
  const remaining = poolIds.filter((id) => !forced.includes(id));
  const chosen = [...forced];

  while (chosen.length < count && remaining.length) {
    const index = Math.floor(Math.random() * remaining.length);
    chosen.push(remaining.splice(index, 1)[0]);
  }

  return chosen;
}

function createDrawSlot(slotIndex) {
  const element = document.createElement("article");
  element.className = "draw-slot spinning";
  element.innerHTML = `
    <span class="draw-slot-index">Slot ${slotIndex + 1}</span>
    <strong class="draw-slot-label">---</strong>
    <span class="draw-slot-title">等待抽取</span>
    <div class="draw-slot-details">
      <div class="draw-slot-skills">
        <div class="draw-slot-skill">
          <span class="draw-slot-skill-label">普攻</span>
          <span class="draw-slot-skill-name draw-slot-basic-name">—</span>
        </div>
        <div class="draw-slot-skill">
          <span class="draw-slot-skill-label">大招</span>
          <span class="draw-slot-skill-name draw-slot-ult-name">—</span>
        </div>
      </div>
      <div class="draw-slot-stats">
        <div class="draw-slot-stat">
          <span class="draw-slot-stat-label">HP</span>
          <span class="draw-slot-stat-value draw-slot-stat-hp">—</span>
        </div>
        <div class="draw-slot-stat">
          <span class="draw-slot-stat-label">速度</span>
          <span class="draw-slot-stat-value draw-slot-stat-speed">—</span>
        </div>
        <div class="draw-slot-stat">
          <span class="draw-slot-stat-label">精元</span>
          <span class="draw-slot-stat-value draw-slot-stat-essence">—</span>
        </div>
        <div class="draw-slot-stat">
          <span class="draw-slot-stat-label">索敌</span>
          <span class="draw-slot-stat-value draw-slot-stat-range">—</span>
        </div>
        <div class="draw-slot-stat">
          <span class="draw-slot-stat-label">体型</span>
          <span class="draw-slot-stat-value draw-slot-stat-radius">—</span>
        </div>
      </div>
    </div>
  `;

  return {
    element,
    nameElement: element.querySelector(".draw-slot-label"),
    titleElement: element.querySelector(".draw-slot-title"),
    basicNameElement: element.querySelector(".draw-slot-basic-name"),
    ultNameElement: element.querySelector(".draw-slot-ult-name"),
    statHpElement: element.querySelector(".draw-slot-stat-hp"),
    statSpeedElement: element.querySelector(".draw-slot-stat-speed"),
    statEssenceElement: element.querySelector(".draw-slot-stat-essence"),
    statRangeElement: element.querySelector(".draw-slot-stat-range"),
    statRadiusElement: element.querySelector(".draw-slot-stat-radius"),
  };
}

function updateDrawSlot(slot, character, settled = false) {
  slot.element.style.setProperty("--slot-accent", `${character.color}66`);
  slot.element.classList.toggle("spinning", !settled);
  slot.element.classList.toggle("settled", settled);
  slot.nameElement.textContent = character.name;
  slot.titleElement.textContent = character.title;

  if (settled) {
    slot.basicNameElement.textContent = character.basicAttack?.name ?? "—";
    slot.ultNameElement.textContent = character.ultimate?.name ?? "—";
    slot.statHpElement.textContent = character.stats.maxHp;
    slot.statSpeedElement.textContent = character.stats.speed;
    slot.statEssenceElement.textContent = character.stats.maxEssence;
    slot.statRangeElement.textContent = character.stats.attackRange;
    slot.statRadiusElement.textContent = character.stats.radius;
  }
}

function runDrawSequence(poolIds, drawCount, forcedIds = []) {
  const chosenIds = sampleDrawRoster(poolIds, drawCount, forcedIds);
  const slotViews = [];

  clearDrawTimers();
  drawState.active = true;
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
  showDrawStage();
  startDrawRecordingLoop();
  const forcedCount = forcedIds.filter((id) => poolIds.includes(id)).length;
  drawStageSummaryElement.textContent = forcedCount > 0
    ? `从 ${poolIds.length} 名候选中抽取 ${drawCount} 名（含 ${forcedCount} 名必选）进入本局。`
    : `从 ${poolIds.length} 名候选中随机抽取 ${drawCount} 名角色进入本局。`;
  drawStageSlotsElement.innerHTML = "";

  chosenIds.forEach((_, index) => {
    const slot = createDrawSlot(index);
    slotViews.push(slot);
    drawStageSlotsElement.appendChild(slot.element);
  });

  updateRosterStatus();
  updateRecordButton();

  return new Promise((resolve) => {
    slotViews.forEach((slot, index) => {
      const intervalId = window.setInterval(() => {
        const randomId = poolIds[Math.floor(Math.random() * poolIds.length)];
        const randomCharacter = getCharacterById(randomId);
        if (randomCharacter) {
          updateDrawSlot(slot, randomCharacter, false);
        }
      }, DRAW_SPIN_INTERVAL_MS);
      drawState.intervalIds.push(intervalId);

      const timeoutId = window.setTimeout(() => {
        clearInterval(intervalId);
        const finalCharacter = getCharacterById(chosenIds[index]);
        if (finalCharacter) {
          updateDrawSlot(slot, finalCharacter, true);
        }

        if (index === chosenIds.length - 1) {
          drawStageSummaryElement.textContent =
            `本局参战：${chosenIds.map((id) => getCharacterById(id)?.name ?? id).join("、")}`;
        }
      }, DRAW_SETTLE_BASE_MS + index * DRAW_SETTLE_STEP_MS);
      drawState.timeoutIds.push(timeoutId);
    });

    const doneTimeoutId = window.setTimeout(() => {
      stopDrawRecordingLoop();
      drawState.active = false;
      clearDrawTimers();
      updateRosterStatus();
      updateRecordButton();
      resolve(chosenIds);
    }, DRAW_SETTLE_BASE_MS + chosenIds.length * DRAW_SETTLE_STEP_MS + DRAW_END_HOLD_MS);
    drawState.timeoutIds.push(doneTimeoutId);
  });
}

async function startMatch({ record = false } = {}) {
  if (recordingState.active || drawState.active) {
    return;
  }

  const poolIds = getRosterIds();
  const drawCount = sanitizeDrawCount(matchSettings.drawCount, poolIds.length);
  if (poolIds.length < 2 || drawCount < 2 || drawCount > poolIds.length) {
    return;
  }

  if (record && !startCanvasRecording()) {
    return;
  }

  game.stop();
  closeRosterModal();
  const forcedIds = [...guaranteedIds].filter((id) => poolIds.includes(id));
  const drawnIds = await runDrawSequence(poolIds, drawCount, forcedIds);
  const focusId = drawnIds.includes(selectedId) ? selectedId : drawnIds[0];

  await new Promise((resolve) => setTimeout(resolve, 2000));
  hideDrawStage();
  game.start(focusId, drawnIds, {
    includeEdgeHazards: matchSettings.includeEdgeHazards,
    duelTime: matchSettings.duelTime,
  });
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
    hideDrawStage();
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

drawCountInput.addEventListener("change", () => {
  matchSettings.drawCount = sanitizeDrawCount(Number(drawCountInput.value));
  syncDrawCountInput();
  updateRosterStatus();
  updateRecordButton();
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
syncDrawCountInput();
updateHud(null);
initDb();

