import {
  CHARACTER_LIBRARY,
  getCharacterById,
  resetCharacterValues,
  summarizeTriggers,
  updateCharacterValue,
} from "./characters.js";
import { ArenaGame } from "./game.js";
import { clearOverrides, loadAllOverrides, saveOverrides } from "./db.js";

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
const RECORDING_END_HOLD_MS = 2200;
const DRAW_SPIN_INTERVAL_MS = 90;
const DRAW_SETTLE_BASE_MS = 1200;
const DRAW_SETTLE_STEP_MS = 320;
const DRAW_END_HOLD_MS = 650;

let selectedId = CHARACTER_LIBRARY[0].id;
let selectedRosterIds = new Set(CHARACTER_LIBRARY.map((character) => character.id));
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
};
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
          <span class="card-toggle${selected ? " active" : " ghost"}">${selected ? "姝ｅ湪缂栬緫" : "鐐规缂栬緫"}</span>
          <span class="card-toggle${included ? " active" : " ghost"}">${included ? "鍙傛垬" : "寰呭懡"}</span>
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

function renderRecordingFrame(snapshot = recordingState.latestSnapshot) {
  if (!recordingState.active || !recordingState.renderCanvas || !recordingState.renderCtx) {
    return;
  }

  if (snapshot) {
    recordingState.latestSnapshot = snapshot;
  }

  const currentSnapshot = recordingState.latestSnapshot;
  const ctx = recordingState.renderCtx;
  const width = recordingState.renderCanvas.width;
  const height = recordingState.renderCanvas.height;
  const margin = Math.round(width * 0.01875);
  const gap = Math.round(width * 0.00625);
  const panelWidth = Math.round(width * 0.24);
  const radius = Math.round(width * 0.0085);
  const hud = getHudDisplay(currentSnapshot);
  const statusHeight = Math.round(height * 0.105);

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(canvas, 0, 0, width, height);

  fillRoundedPanel(ctx, margin, margin, panelWidth, statusHeight, radius);

  const pad = Math.round(width * 0.0105);
  const innerWidth = panelWidth - pad * 2;
  {
    const statusX = margin + pad;
    const statusY = margin + pad;
    const statusBlockWidth = (innerWidth - gap) / 2;

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.font = `600 ${Math.round(height * 0.011)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText("璁℃椂", statusX, statusY);
    ctx.fillText("闃舵", statusX + statusBlockWidth + gap, statusY);

    ctx.fillStyle = "#fff7eb";
    ctx.font = `700 ${Math.round(height * 0.018)}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(hud.timer, statusX, statusY + Math.round(height * 0.026));

    ctx.font = `700 ${Math.round(height * 0.015)}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
    drawTextBlock(
      ctx,
      hud.phase,
      statusX + statusBlockWidth + gap,
      statusY + Math.round(height * 0.008),
      statusBlockWidth,
      Math.round(height * 0.017),
      2,
    );
    ctx.restore();

    drawRecordingOverlay(ctx, width, height, margin, radius);
    return;
  }

  ctx.save();
  ctx.fillStyle = "#f3d2a2";
  ctx.font = `600 ${Math.round(height * 0.016)}px Georgia, "Microsoft YaHei UI", serif`;
  ctx.fillText("鎴樻枟鎾姤", margin + pad, margin + pad + Math.round(height * 0.004));

  const feedTop = margin + pad + Math.round(height * 0.028);
  const itemGap = Math.round(height * 0.009);
  const itemHeight = Math.round(height * 0.044);
  battleFeedItems.forEach((entry, index) => {
    const itemY = feedTop + index * (itemHeight + itemGap);
    fillRoundedPanel(ctx, margin + pad, itemY, innerWidth, itemHeight, Math.round(radius * 0.78));

    ctx.fillStyle = "#f3d2a2";
    ctx.font = `600 ${Math.round(height * 0.012)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(entry.stamp, margin + pad * 1.5, itemY + Math.round(height * 0.016));

    ctx.fillStyle = "#f5efe7";
    ctx.font = `500 ${Math.round(height * 0.0125)}px "Microsoft YaHei UI", sans-serif`;
    drawTextBlock(
      ctx,
      entry.message,
      margin + pad * 1.5,
      itemY + Math.round(height * 0.031),
      innerWidth - pad,
      Math.round(height * 0.0135),
      2,
    );
  });
  ctx.restore();

  ctx.save();
  const statusX = margin + pad;
  const statusY = margin + feedHeight + gap + pad;
  const statusBlockWidth = (innerWidth - gap) / 2;

  ctx.fillStyle = "rgba(255,255,255,0.68)";
  ctx.font = `600 ${Math.round(height * 0.011)}px "Microsoft YaHei UI", sans-serif`;
  ctx.fillText("璁℃椂", statusX, statusY);
  ctx.fillText("闃舵", statusX + statusBlockWidth + gap, statusY);

  ctx.fillStyle = "#fff7eb";
  ctx.font = `700 ${Math.round(height * 0.018)}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
  ctx.fillText(hud.timer, statusX, statusY + Math.round(height * 0.026));

  ctx.font = `700 ${Math.round(height * 0.015)}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
  drawTextBlock(
    ctx,
    hud.phase,
    statusX + statusBlockWidth + gap,
    statusY + Math.round(height * 0.008),
    statusBlockWidth,
    Math.round(height * 0.017),
    2,
  );
  ctx.restore();

  ctx.save();
  const scorePanelY = height - margin - scorePanelHeight;
  const scoreX = margin + pad;
  const scoreY = scorePanelY + pad + Math.round(height * 0.004);
  const scoreInnerWidth = panelWidth - pad * 2;

  ctx.fillStyle = "#f3d2a2";
  ctx.font = `600 ${Math.round(height * 0.016)}px Georgia, "Microsoft YaHei UI", serif`;
  ctx.fillText("瀛樻椿鍒楄〃", scoreX, scoreY);

  const rowTop = scorePanelY + pad + Math.round(height * 0.028);
  const rowHeight = Math.round(height * 0.06);
  scoreboardEntries.forEach((actor, index) => {
    const rowY = rowTop + index * (rowHeight + itemGap);
    if (rowY + rowHeight > scorePanelY + scorePanelHeight - pad) {
      return;
    }

    fillRoundedPanel(ctx, scoreX, rowY, scoreInnerWidth, rowHeight, Math.round(radius * 0.78));

    ctx.fillStyle = actor.color;
    ctx.font = `700 ${Math.round(height * 0.013)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(actor.name, scoreX + Math.round(width * 0.006), rowY + Math.round(height * 0.018));

    ctx.textAlign = "right";
    ctx.fillStyle = actor.alive ? "#f5efe7" : "rgba(245, 239, 231, 0.55)";
    ctx.font = `600 ${Math.round(height * 0.0105)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(actor.alive ? "瀛樻椿" : "娣樻卑", scoreX + scoreInnerWidth - Math.round(width * 0.006), rowY + Math.round(height * 0.018));

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.font = `500 ${Math.round(height * 0.01)}px "Microsoft YaHei UI", sans-serif`;
    if (actor.title) {
      ctx.fillText(actor.title, scoreX + Math.round(width * 0.006), rowY + Math.round(height * 0.028));
    }

    const barX = scoreX + Math.round(width * 0.006);
    const barWidth = scoreInnerWidth - Math.round(width * 0.012);
    const hpY = rowY + Math.round(height * 0.034);
    const essenceY = hpY + Math.round(height * 0.012);

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRectPath(ctx, barX, hpY, barWidth, Math.round(height * 0.007), Math.round(height * 0.0035));
    ctx.fill();
    roundRectPath(ctx, barX, essenceY, barWidth, Math.round(height * 0.007), Math.round(height * 0.0035));
    ctx.fill();

    ctx.fillStyle = "#ff916f";
    roundRectPath(
      ctx,
      barX,
      hpY,
      Math.max(0, barWidth * (actor.maxHp ? actor.hp / actor.maxHp : 0)),
      Math.round(height * 0.007),
      Math.round(height * 0.0035),
    );
    ctx.fill();

    ctx.fillStyle = "#f6dc7d";
    roundRectPath(
      ctx,
      barX,
      essenceY,
      Math.max(0, barWidth * (actor.maxEssence ? actor.essence / actor.maxEssence : 0)),
      Math.round(height * 0.007),
      Math.round(height * 0.0035),
    );
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.font = `500 ${Math.round(height * 0.01)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(
      `HP ${actor.hp}/${actor.maxHp} 路 绮惧厓 ${actor.essence}/${actor.maxEssence}`,
      barX,
      rowY + Math.round(height * 0.054),
    );
  });
  ctx.restore();

  drawRecordingOverlay(ctx, width, height, margin, radius);
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

function renderDrawOnCanvas() {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const slots = [...drawStageSlotsElement.querySelectorAll(".draw-slot")];

  ctx.save();
  ctx.fillStyle = "rgba(6, 6, 12, 0.96)";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#f3d2a2";
  ctx.font = `600 ${Math.round(H * 0.019)}px "Microsoft YaHei UI", serif`;
  ctx.fillText("Draft", W / 2, H * 0.26);

  ctx.fillStyle = "#fff7eb";
  ctx.font = `700 ${Math.round(H * 0.038)}px Georgia, "Microsoft YaHei UI", serif`;
  ctx.fillText("随机抽取本局参战选手", W / 2, H * 0.335);

  const summaryText = drawStageSummaryElement.textContent ?? "";
  if (summaryText) {
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.font = `500 ${Math.round(H * 0.017)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(summaryText, W / 2, H * 0.395);
  }

  const slotCount = slots.length || 1;
  const slotW = Math.round(W * 0.165);
  const slotH = Math.round(H * 0.26);
  const slotGap = Math.round(W * 0.022);
  const totalW = slotCount * slotW + (slotCount - 1) * slotGap;
  const startX = (W - totalW) / 2;
  const slotTop = H * 0.46;
  const r = Math.round(W * 0.007);

  slots.forEach((slotEl, i) => {
    const settled = slotEl.classList.contains("settled");
    const name = slotEl.querySelector(".draw-slot-label")?.textContent ?? "---";
    const title = slotEl.querySelector(".draw-slot-title")?.textContent ?? "";
    const indexLabel = slotEl.querySelector(".draw-slot-index")?.textContent ?? `Slot ${i + 1}`;
    const accentColor = slotEl.style.getPropertyValue("--slot-accent") || "rgba(255,255,255,0.15)";

    const x = startX + i * (slotW + slotGap);

    ctx.beginPath();
    const rx = Math.min(r, slotW / 2, slotH / 2);
    ctx.moveTo(x + rx, slotTop);
    ctx.arcTo(x + slotW, slotTop, x + slotW, slotTop + slotH, rx);
    ctx.arcTo(x + slotW, slotTop + slotH, x, slotTop + slotH, rx);
    ctx.arcTo(x, slotTop + slotH, x, slotTop, rx);
    ctx.arcTo(x, slotTop, x + slotW, slotTop, rx);
    ctx.closePath();
    ctx.fillStyle = settled ? `rgba(35,30,15,0.95)` : "rgba(16,16,28,0.95)";
    ctx.fill();
    ctx.strokeStyle = settled ? accentColor || "rgba(243,210,162,0.55)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = settled ? 3 : 1.5;
    ctx.stroke();

    const cx = x + slotW / 2;

    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = `500 ${Math.round(H * 0.013)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(indexLabel, cx, slotTop + Math.round(H * 0.042));

    ctx.fillStyle = settled ? "#fff7eb" : "rgba(200,200,200,0.55)";
    ctx.font = `${settled ? "700" : "500"} ${Math.round(H * 0.028)}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(name, cx, slotTop + slotH * 0.52);

    if (title) {
      ctx.fillStyle = settled ? "#f3d2a2" : "rgba(255,255,255,0.38)";
      ctx.font = `500 ${Math.round(H * 0.015)}px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(title, cx, slotTop + slotH * 0.52 + Math.round(H * 0.032));
    }

    if (settled) {
      ctx.fillStyle = "rgba(243,210,162,0.7)";
      ctx.font = `600 ${Math.round(H * 0.013)}px "Microsoft YaHei UI", sans-serif`;
      ctx.fillText("✓ 已确定", cx, slotTop + slotH - Math.round(H * 0.03));
    }
  });

  ctx.restore();
}

function startDrawRecordingLoop() {
  if (!recordingState.active) return;

  const loop = () => {
    if (!recordingState.active || drawStage.classList.contains("hidden")) {
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

    recorder.addEventListener("stop", () => {
      const chunks = [...recordingState.chunks];
      const finalMimeType = recordingState.mimeType;

      recordingState.stream?.getTracks().forEach((track) => track.stop());
      resetRecordingState();

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
  drawStage.classList.remove("hidden");
}

function hideDrawStage() {
  drawStage.classList.add("hidden");
  drawStageSummaryElement.textContent = "";
  drawStageSlotsElement.innerHTML = "";
}

function sampleDrawRoster(poolIds, count) {
  const remaining = [...poolIds];
  const chosen = [];

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
  `;

  return {
    element,
    nameElement: element.querySelector(".draw-slot-label"),
    titleElement: element.querySelector(".draw-slot-title"),
  };
}

function updateDrawSlot(slot, character, settled = false) {
  slot.element.style.setProperty("--slot-accent", `${character.color}66`);
  slot.element.classList.toggle("spinning", !settled);
  slot.element.classList.toggle("settled", settled);
  slot.nameElement.textContent = character.name;
  slot.titleElement.textContent = character.title;
}

function runDrawSequence(poolIds, drawCount) {
  const chosenIds = sampleDrawRoster(poolIds, drawCount);
  const slotViews = [];

  clearDrawTimers();
  drawState.active = true;
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
  showDrawStage();
  startDrawRecordingLoop();
  drawStageSummaryElement.textContent = `从 ${poolIds.length} 名候选中随机抽取 ${drawCount} 名角色进入本局。`;
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
  const drawnIds = await runDrawSequence(poolIds, drawCount);
  const focusId = drawnIds.includes(selectedId) ? selectedId : drawnIds[0];

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
  },
  onMatchStart(snapshot) {
    hideDrawStage();
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    battleFeedItems.length = 0;
    feed.innerHTML = "";
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
  const allOverrides = await loadAllOverrides();
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

renderRoster();
renderEditor();
renderScoreboard(null);
syncDuelTimeInput();
syncDrawCountInput();
updateHud(null);
initDb();

