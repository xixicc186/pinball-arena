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
const overlay = document.getElementById("overlay");
const scoreboard = document.getElementById("scoreboard");
const feed = document.getElementById("feed");
const hudTimer = document.getElementById("hud-timer");
const hudPhase = document.getElementById("hud-phase");
const canvas = document.getElementById("arena-canvas");

const DEFAULT_DUEL_TIME = 45;
const RECORDING_FPS = 60;
const RECORDING_BITS_PER_SECOND = 24_000_000;
const RECORDING_END_HOLD_MS = 2200;

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
  if (!selectedRosterIds.has(selectedId)) {
    selectedRosterIds.add(selectedId);
  }
}

function updateRosterStatus() {
  const count = getRosterIds().length;
  const text = `已选择 ${count} 名参战角色`;
  rosterStatusElement.textContent = text;
  modalRosterStatusElement.textContent = `${text}，点击卡片可切换编辑对象。`;
  startButton.disabled = count < 2;
  startButton.textContent = count < 2 ? "至少选择 2 名角色" : "开始游戏";
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
          <span class="card-toggle${selected ? " active" : " ghost"}">${selected ? "正在编辑" : "点此编辑"}</span>
          <span class="card-toggle${included ? " active" : " ghost"}">${included ? "参战" : "待命"}</span>
        </div>
      </div>
      <p class="card-desc">${character.description}</p>
      <div class="tag-row">${tags}</div>
      <div class="stats-row">
        <span class="stat">HP ${character.stats.maxHp}</span>
        <span class="stat">速度 ${character.stats.speed}</span>
        <span class="stat">精元 ${character.stats.maxEssence}</span>
        <span class="stat">索敌 ${character.stats.attackRange}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      selectedId = character.id;
      syncRosterSelection();
      renderRoster();
      renderEditor();
    });

    const toggles = card.querySelectorAll(".card-toggle");
    toggles[0].addEventListener("click", (event) => {
      event.stopPropagation();
      selectedId = character.id;
      syncRosterSelection();
      renderRoster();
      renderEditor();
    });

    toggles[1].addEventListener("click", (event) => {
      event.stopPropagation();
      if (character.id === selectedId) {
        selectedRosterIds.add(character.id);
      } else if (included && getRosterIds().length > 2) {
        selectedRosterIds.delete(character.id);
      } else if (!included) {
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
    editorElement.innerHTML = '<p class="editor-empty">未找到角色配置。</p>';
    return;
  }

  editorElement.innerHTML = `
    <section class="editor-section">
      <h3>${character.name} · ${character.title}</h3>
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
        character?.basicAttack?.name ? `平A ${character.basicAttack.name}` : "",
        character?.ultimate?.name ? `大招 ${character.ultimate.name}` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      return `
        <div class="score-row${actor.isPlayer ? " player" : ""}${actor.alive ? "" : " dead"}">
          <div class="score-row-head">
            <div class="score-name">
              <strong style="color:${actor.color}">${actor.name}</strong>
              ${title ? `<span class="score-title">${title}</span>` : ""}
            </div>
            <span class="score-state">${actor.alive ? "存活" : "淘汰"}</span>
          </div>
          <div class="hp-bar">
            <div class="hp-fill" style="width:${Math.max(hpRatio, 0) * 100}%"></div>
          </div>
          <div class="essence-bar">
            <div class="essence-fill" style="width:${Math.max(essenceRatio, 0) * 100}%"></div>
          </div>
          <div class="score-meta">HP ${actor.hp}/${actor.maxHp} · 精元 ${actor.essence}/${actor.maxEssence}</div>
          ${skillText ? `<div class="score-skills">${skillText}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function updateHud(snapshot) {
  if (!snapshot) {
    hudTimer.textContent = "0.0s";
    hudPhase.textContent = `常规阶段 · ${matchSettings.duelTime}s后进入`;
    return;
  }

  hudTimer.textContent = `${snapshot.elapsed.toFixed(1)}s`;
  hudPhase.textContent = snapshot.duelTriggered
    ? "决斗时刻"
    : `常规阶段 · ${snapshot.nextPhaseIn.toFixed(1)}s后进入`;
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
      phase: `常规阶段 · ${matchSettings.duelTime}s后进入`,
    };
  }

  return {
    timer: `${snapshot.elapsed.toFixed(1)}s`,
    phase: snapshot.duelTriggered ? "决斗时刻" : `常规阶段 · ${snapshot.nextPhaseIn.toFixed(1)}s后进入`,
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
    lines[lines.length - 1] = truncated.length > 1 ? `${truncated.slice(0, -1)}…` : "…";
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
    ctx.fillText("计时", statusX, statusY);
    ctx.fillText("阶段", statusX + statusBlockWidth + gap, statusY);

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
  ctx.fillText("战斗播报", margin + pad, margin + pad + Math.round(height * 0.004));

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
  ctx.fillText("计时", statusX, statusY);
  ctx.fillText("阶段", statusX + statusBlockWidth + gap, statusY);

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
  ctx.fillText("存活列表", scoreX, scoreY);

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
    ctx.fillText(actor.alive ? "存活" : "淘汰", scoreX + scoreInnerWidth - Math.round(width * 0.006), rowY + Math.round(height * 0.018));

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
      `HP ${actor.hp}/${actor.maxHp} · 精元 ${actor.essence}/${actor.maxEssence}`,
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

  const count = getRosterIds().length;
  const supported = canRecordCanvas();

  startButton.disabled = count < 2 || recordingState.active;
  recordButton.disabled = recordingState.active ? false : count < 2 || !supported;
  if (recordingState.active) {
    recordButton.textContent = "暂停录制";
    return;
  }

  recordButton.textContent = supported ? "录制对局" : "无法录制";
  return;
  if (recordingState.active) {
    recordButton.textContent = "录制中...";
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

function resetRecordingState() {
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

function startMatch({ record = false } = {}) {
  if (recordingState.active) {
    return;
  }

  const rosterIds = getRosterIds();
  if (rosterIds.length < 2) {
    return;
  }

  if (record && !startCanvasRecording()) {
    return;
  }

  closeRosterModal();
  game.start(selectedId, rosterIds, {
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
    if (winner) {
      overlay.innerHTML = `
        <p class="overlay-eyebrow">Victory</p>
        <h2>${winner.name}获得最终胜利</h2>
      `;
      overlay.querySelector("h2").textContent = `${winner.name}获得最终胜利`;
      overlay.querySelector("h2").textContent = `${winner.name}获得最终胜利`;
      renderRecordingFrame(snapshot);
      scheduleCanvasRecordingStop();
      return;
    }

    overlay.innerHTML = `
      <p class="overlay-eyebrow">Draw</p>
      <h2>本局同归于尽</h2>
    `;
    overlay.querySelector("h2").textContent = "本局同归于尽";
    overlay.querySelector("h2").textContent = "本局同归于尽";
    renderRecordingFrame(snapshot);
    scheduleCanvasRecordingStop();
    return;
    overlay.innerHTML = winner
      ? `
        <p class="overlay-eyebrow">Victory</p>
        <h2>${winner.name} 获胜</h2>
        <p>当前对局使用你选择的参战名单。你可以继续调整角色和参战阵容，再重新开局测试。</p>
      `
      : `
        <p class="overlay-eyebrow">Draw</p>
        <h2>本局同归于尽</h2>
        <p>所有参战角色同时出局。你可以继续调整角色参数、参战阵容或阶段时间。</p>
      `;
    if (winner) {
      overlay.innerHTML = `
        <p class="overlay-eyebrow">Victory</p>
        <h2>${winner.name}获得最终胜利</h2>
      `;
      return;
      overlay.innerHTML = `
        <p class="overlay-eyebrow">Victory</p>
        <h2>${winner.name} 鑾疯儨</h2>
      `;
    }
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
  const fallback = CHARACTER_LIBRARY.find((character) => character.id !== selectedId);
  if (fallback) {
    selectedRosterIds.add(fallback.id);
  }
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
updateHud(null);
initDb();
