import {
  CHARACTER_LIBRARY,
  getCharacterById,
  resetCharacterValues,
  summarizeTriggers,
  updateCharacterValue,
} from "./characters.js";
import { ArenaGame } from "./game.js";
import { clearOverrides, loadAllOverrides, saveOverrides, loadAllIntros, saveIntro } from "./db.js";
import { getAudioStream, playSound, resumeAudio, resetAudioStream } from "./sounds.js";

const rosterElement = document.getElementById("roster");
const rosterStatusElement = document.getElementById("roster-status");
const modalRosterStatusElement = document.getElementById("modal-roster-status");
const editorElement = document.getElementById("character-editor");
const startButton = document.getElementById("start-button");
const recordButton = document.getElementById("record-button");
const modeClassicButton = document.getElementById("mode-classic-button");
const modeTournamentButton = document.getElementById("mode-tournament-button");
const classicModePanel = document.getElementById("classic-mode-panel");
const tournamentModePanel = document.getElementById("tournament-mode-panel");
const tournamentFormatTeamButton = document.getElementById("tournament-format-team-button");
const tournamentFormatSoloButton = document.getElementById("tournament-format-solo-button");
const tournamentPanel = document.getElementById("tournament-panel");
const tournamentDrawButton = document.getElementById("tournament-draw-button");
const tournamentStartButton = document.getElementById("tournament-start-button");
const tournamentRecordButton = document.getElementById("tournament-record-button");
const openRosterButtonTournament = document.getElementById("open-roster-button-tournament");
const tournamentStatusElement = document.getElementById("tournament-status");
const tournamentSummaryElement = document.getElementById("tournament-summary");
const tournamentRoundIndicator = document.getElementById("tournament-round-indicator");
const tournamentGroupsElement = document.getElementById("tournament-groups");
const tournamentBracketElement = document.getElementById("tournament-bracket");
const resetButton = document.getElementById("reset-button");
const selectAllButton = document.getElementById("select-all-button");
const clearRosterButton = document.getElementById("clear-roster-button");
const openRosterButton = document.getElementById("open-roster-button");
const closeRosterButton = document.getElementById("close-roster-button");
const rosterModal = document.getElementById("roster-modal");
const edgeSpikesToggle = document.getElementById("edge-spikes-toggle");
const duelTimeInput = document.getElementById("duel-time-input");
const overlay = document.getElementById("overlay");
const matchVsBanner = document.getElementById("match-vs-banner");
const scoreboard = document.getElementById("scoreboard");
const feed = document.getElementById("feed");
const hudTimer = document.getElementById("hud-timer");
const hudPhase = document.getElementById("hud-phase");
const canvas = document.getElementById("arena-canvas");

const DEFAULT_DUEL_TIME = 45;
const RECORDING_FPS = 60;
const RECORDING_BITS_PER_SECOND = 24_000_000;
const RECORDING_END_HOLD_MS = 2500;
const ENTRY_HOLD_MS = 2000;
const TOURNAMENT_FORMATS = {
  team: {
    key: "team",
    title: "组队赛",
    requiredRoster: 16,
    groupSize: 2,
    lineupLabel: "双人小组",
    stageHeading: "双人组",
    finalLabel: "决胜组",
    drawTitle: "赛事抽签分组",
    drawSubtitle: "16 名角色随机分成 8 个双人小组",
    summaryIdle: "点击“随机抽签分组”生成 8 个双人小组，再开始整届赛事。",
    summaryReady: "已生成 8 个双人小组，赛程按固定半区推进。",
    championTitle: "决胜组出线",
    championSubtitle: "成为本届冠军组",
  },
  solo: {
    key: "solo",
    title: "个人战",
    requiredRoster: 8,
    groupSize: 1,
    lineupLabel: "个人选手",
    stageHeading: "个人",
    finalLabel: "决胜局",
    drawTitle: "个人战抽签",
    drawSubtitle: "8 名角色随机进入个人战赛程",
    summaryIdle: "点击“随机抽签分组”生成 8 名个人选手，再开始整届个人战。",
    summaryReady: "已生成 8 名个人选手，赛程按固定半区推进。",
    championTitle: "冠军诞生",
    championSubtitle: "赢下本届个人战",
  },
};
const TOURNAMENT_DRAW_MS = 3200;
const TOURNAMENT_BRACKET_HOLD_MS = 1800;
const TOURNAMENT_MATCH_OVERLAY_MS = 1600;
const TOURNAMENT_PROMOTION_MS = 1200;
const TOURNAMENT_RESULT_BRACKET_MS = TOURNAMENT_BRACKET_HOLD_MS + 2000;
const TOURNAMENT_CHAMPION_HOLD_MS = 2600;

let selectedId = CHARACTER_LIBRARY[0].id;
let selectedRosterIds = new Set();
let appMode = "classic";
let tournamentFormat = "team";
const matchSettings = {
  includeEdgeHazards: true,
  duelTime: DEFAULT_DUEL_TIME,
};
const tournamentState = {
  groups: [],
  rounds: [],
  active: false,
  currentMatchId: null,
  currentRoundLabel: "",
  championGroupId: null,
  generated: false,
  pendingResolve: null,
  pendingReject: null,
  cancelled: false,
  sceneStopper: null,
  latestResult: null,
  format: "team",
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

const entryState = { active: false };
let bannerAnimFrameId = null;
let bannerCanvasLoopId = null;
let bannerCanvasStart = 0;
const bannerEssenceData = new Map(); // characterId → { essence, maxEssence }
const bannerEssenceFills = new Map(); // characterId → fill element
const battleFeedItems = [];
const tournamentPreviewBuffers = new Map();

// 出场介绍文字覆盖（从 Supabase 加载，key = characterId）
const introCache = {};

function getIntroText(characterId, character) {
  const row = introCache[characterId] ?? {};
  return {
    name: row.name ?? character.name,
    title: row.title ?? character.title,
    description: row.description ?? character.description,
    basicAttackName: row.basic_attack_name ?? character.basicAttack?.name ?? "",
    ultimateName: row.ultimate_name ?? character.ultimate?.name ?? "",
  };
}

function sanitizeDuelTime(value) {
  return Math.max(5, Math.min(180, Math.round(value || DEFAULT_DUEL_TIME)));
}

function shuffle(array) {
  const result = [...array];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getSelectedCharacters() {
  return getRosterIds()
    .map((id) => getCharacterById(id))
    .filter(Boolean);
}

function getTournamentConfig(format = tournamentFormat) {
  return TOURNAMENT_FORMATS[format] ?? TOURNAMENT_FORMATS.team;
}

function canStartTournament() {
  return getRosterIds().length === getTournamentConfig().requiredRoster;
}

function getCurrentRecordButton() {
  return appMode === "tournament" ? tournamentRecordButton : recordButton;
}

function getCurrentStartButton() {
  return appMode === "tournament" ? tournamentStartButton : startButton;
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
  return appMode === "tournament" ? canStartTournament() : getRosterIds().length >= 2;
}

function updateRosterStatus() {
  const activeStartButton = getCurrentStartButton();
  const selectedCount = getRosterIds().length;
  const tournamentConfig = getTournamentConfig();
  const classicText = selectedCount >= 2
    ? `已选择 ${selectedCount} 名出战角色`
    : `已选择 ${selectedCount} 名出战角色，至少需要 2 名才能开始`;
  const tournamentText = selectedCount === tournamentConfig.requiredRoster
    ? `已选择 ${selectedCount} 名出战角色，已满足${tournamentConfig.title}人数要求`
    : `已选择 ${selectedCount} 名出战角色，${tournamentConfig.title}需要恰好 ${tournamentConfig.requiredRoster} 名`;

  rosterStatusElement.textContent = classicText;
  tournamentStatusElement.textContent = tournamentText;
  modalRosterStatusElement.textContent =
    `${appMode === "tournament" ? tournamentText : classicText}。点击卡片切换编辑对象，标记为“出战”的角色将参与当前玩法。`;

  if (entryState.active) {
    startButton.disabled = true;
    tournamentStartButton.disabled = true;
    activeStartButton.textContent = "登场中...";
    return;
  }

  startButton.disabled = !canStartMatch() || recordingState.active || tournamentState.active;
  tournamentStartButton.disabled = !canStartMatch() || recordingState.active || tournamentState.active;
  activeStartButton.textContent = appMode === "tournament"
    ? (canStartMatch() ? `开始${tournamentConfig.title}` : `需要 ${tournamentConfig.requiredRoster} 名角色`)
    : (canStartMatch() ? "开始出战" : "至少选择 2 名角色");
  if (appMode === "tournament") {
    startButton.textContent = "开始出战";
  } else {
    tournamentStartButton.textContent = "开始赛事";
  }
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
      invalidateTournamentBracket();
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

  // ── 出场介绍编辑区 ──
  const introBlock = document.createElement("section");
  introBlock.className = "editor-section";

  const introTitle = document.createElement("h3");
  introTitle.textContent = "出场介绍文字";
  introBlock.appendChild(introTitle);

  const introNote = document.createElement("p");
  introNote.className = "editor-note";
  introNote.textContent = "修改后将保存到云端，下次出场动画中生效。留空则恢复默认文字。";
  introBlock.appendChild(introNote);

  const introGrid = document.createElement("div");
  introGrid.className = "editor-grid intro-text-grid";

  const intro = getIntroText(character.id, character);

  const introFields = [
    { key: "name", label: "角色名", value: intro.name, placeholder: character.name },
    { key: "title", label: "副标题", value: intro.title, placeholder: character.title },
    { key: "description", label: "介绍文字", value: intro.description, placeholder: character.description, multiline: true },
    { key: "basicAttackName", label: "普攻名称", value: intro.basicAttackName, placeholder: character.basicAttack?.name ?? "" },
    { key: "ultimateName", label: "大招名称", value: intro.ultimateName, placeholder: character.ultimate?.name ?? "" },
  ];

  introFields.forEach(({ key, label, value, placeholder, multiline }) => {
    const wrapper = document.createElement("label");
    wrapper.className = "field intro-field";

    const span = document.createElement("span");
    span.textContent = label;
    wrapper.appendChild(span);

    const input = multiline
      ? document.createElement("textarea")
      : document.createElement("input");

    if (!multiline) input.type = "text";
    input.className = "intro-input";
    input.value = value;
    input.placeholder = `默认：${placeholder}`;
    if (multiline) {
      input.rows = 3;
    }

    const saveStatus = document.createElement("span");
    saveStatus.className = "intro-save-status";

    input.addEventListener("blur", async () => {
      const raw = input.value.trim();
      const dbKey = {
        name: "name",
        title: "title",
        description: "description",
        basicAttackName: "basic_attack_name",
        ultimateName: "ultimate_name",
      }[key];

      if (!introCache[character.id]) introCache[character.id] = {};
      if (raw === "") {
        introCache[character.id][dbKey] = null;
      } else {
        introCache[character.id][dbKey] = raw;
      }

      saveStatus.textContent = "保存中…";
      saveStatus.className = "intro-save-status saving";

      const row = introCache[character.id];
      await saveIntro(character.id, {
        name: row.name ?? null,
        title: row.title ?? null,
        description: row.description ?? null,
        basicAttackName: row.basic_attack_name ?? null,
        ultimateName: row.ultimate_name ?? null,
      });

      saveStatus.textContent = "已保存";
      saveStatus.className = "intro-save-status saved";
      setTimeout(() => { saveStatus.textContent = ""; saveStatus.className = "intro-save-status"; }, 2000);
    });

    wrapper.append(input, saveStatus);
    introGrid.appendChild(wrapper);
  });

  introBlock.appendChild(introGrid);
  editorElement.appendChild(introBlock);
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
      const teamLabel = actor.teamLabel ?? "";
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
              ${teamLabel ? `<span class="score-title">${teamLabel}</span>` : ""}
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
    hudPhase.textContent = appMode === "tournament"
      ? "赛事流程待开始"
      : `常规阶段，${matchSettings.duelTime}s 后进入决斗`;
    return;
  }

  hudTimer.textContent = `${snapshot.elapsed.toFixed(1)}s`;
  if (appMode === "tournament" && tournamentState.currentRoundLabel) {
    hudPhase.textContent = `${tournamentState.currentRoundLabel} 对局中`;
    return;
  }
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

function getTournamentGroupById(groupId) {
  return tournamentState.groups.find((group) => group.id === groupId) ?? null;
}

function getTournamentMatchById(matchId) {
  for (const round of tournamentState.rounds) {
    const match = round.matches.find((entry) => entry.id === matchId);
    if (match) {
      return match;
    }
  }
  return null;
}

function resolveTournamentRef(ref) {
  if (!ref) {
    return null;
  }
  if (ref.type === "group") {
    return ref.id;
  }
  const match = getTournamentMatchById(ref.id);
  return match?.winnerGroupId ?? null;
}

function getGroupsForMatch(match) {
  const leftGroupId = resolveTournamentRef(match.leftRef);
  const rightGroupId = resolveTournamentRef(match.rightRef);
  return [getTournamentGroupById(leftGroupId), getTournamentGroupById(rightGroupId)];
}

function getGroupMatchStatus(groupId) {
  if (!groupId) {
    return "";
  }
  if (tournamentState.championGroupId === groupId) {
    return "champion";
  }
  if (tournamentState.rounds.some((round) => round.matches.some((match) => match.loserGroupId === groupId))) {
    return "eliminated";
  }
  if (tournamentState.currentMatchId) {
    const currentMatch = getTournamentMatchById(tournamentState.currentMatchId);
    const [leftGroup, rightGroup] = currentMatch ? getGroupsForMatch(currentMatch) : [];
    if (leftGroup?.id === groupId || rightGroup?.id === groupId) {
      return "active";
    }
  }
  return "pending";
}

function buildTournamentRounds(groups, format = tournamentFormat) {
  const config = getTournamentConfig(format);
  const createMatch = (id, label, roundLabel, leftRef, rightRef) => ({
    id,
    label,
    roundLabel,
    leftRef,
    rightRef,
    winnerGroupId: null,
    loserGroupId: null,
  });

  return [
    {
      key: "quarterfinals",
      label: "8进4",
      matches: [
        createMatch("qf-1", "对局 1", "8进4", { type: "group", id: groups[0].id }, { type: "group", id: groups[1].id }),
        createMatch("qf-2", "对局 2", "8进4", { type: "group", id: groups[2].id }, { type: "group", id: groups[3].id }),
        createMatch("qf-3", "对局 3", "8进4", { type: "group", id: groups[4].id }, { type: "group", id: groups[5].id }),
        createMatch("qf-4", "对局 4", "8进4", { type: "group", id: groups[6].id }, { type: "group", id: groups[7].id }),
      ],
    },
    {
      key: "semifinals",
      label: "4进2",
      matches: [
        createMatch("sf-1", "对局 5", "4进2", { type: "match", id: "qf-1" }, { type: "match", id: "qf-2" }),
        createMatch("sf-2", "对局 6", "4进2", { type: "match", id: "qf-3" }, { type: "match", id: "qf-4" }),
      ],
    },
    {
      key: "final",
      label: config.finalLabel,
      matches: [
        createMatch("final-1", "决胜战", config.finalLabel, { type: "match", id: "sf-1" }, { type: "match", id: "sf-2" }),
      ],
    },
  ];
}

function getTournamentWinnerSlotId(matchId) {
  return `winner:${matchId}`;
}

function getTournamentSourceSlotIds(match) {
  return [match.leftRef, match.rightRef].map((ref) => (
    ref.type === "group" ? `group:${ref.id}` : getTournamentWinnerSlotId(ref.id)
  ));
}

function getTournamentBracketLayout() {
  const config = getTournamentConfig();
  const stageX = [0.11, 0.39, 0.67, 0.89];
  const groupY = Array.from({ length: 8 }, (_, index) => 0.11 + index * 0.11);
  const quarterY = [0, 1, 2, 3].map((index) => (groupY[index * 2] + groupY[index * 2 + 1]) / 2);
  const semiY = [0, 1].map((index) => (quarterY[index * 2] + quarterY[index * 2 + 1]) / 2);
  const finalY = [(semiY[0] + semiY[1]) / 2];

  const slots = {};
  tournamentState.groups.forEach((group, index) => {
    slots[`group:${group.id}`] = { x: stageX[0], y: groupY[index], stage: 0 };
  });
  tournamentState.rounds[0]?.matches.forEach((match, index) => {
    slots[getTournamentWinnerSlotId(match.id)] = { x: stageX[1], y: quarterY[index], stage: 1 };
  });
  tournamentState.rounds[1]?.matches.forEach((match, index) => {
    slots[getTournamentWinnerSlotId(match.id)] = { x: stageX[2], y: semiY[index], stage: 2 };
  });
  if (tournamentState.rounds[2]?.matches[0]) {
    slots[getTournamentWinnerSlotId(tournamentState.rounds[2].matches[0].id)] = {
      x: stageX[3],
      y: finalY[0],
      stage: 3,
    };
  }

  return {
    stageX,
    slots,
    headings: [
      { label: config.stageHeading, x: stageX[0] },
      { label: "8进4", x: stageX[1] },
      { label: "4进2", x: stageX[2] },
      { label: config.finalLabel, x: stageX[3] },
    ],
  };
}

function getTournamentSlotGroup(slotId) {
  if (!slotId) {
    return null;
  }
  if (slotId.startsWith("group:")) {
    return getTournamentGroupById(slotId.slice(6));
  }
  if (slotId.startsWith("winner:")) {
    const match = getTournamentMatchById(slotId.slice(7));
    return getTournamentGroupById(match?.winnerGroupId);
  }
  return null;
}

function getTournamentNextSlotId(matchId) {
  return getTournamentWinnerSlotId(matchId);
}

function getTournamentGroupColors(group) {
  return {
    primary: group?.members?.[0]?.color ?? "#f4dc9c",
    secondary: group?.members?.[1]?.color ?? group?.members?.[0]?.color ?? "#ffffff",
  };
}

function getTournamentGroupDisplayText(group) {
  if (!group?.members?.length) {
    return "待定";
  }
  return group.members.map((member) => member.name).join(" / ");
}

function getWinningSourceSlotId(match, winnerGroupId) {
  const [leftGroup, rightGroup] = getGroupsForMatch(match);
  const [leftSlotId, rightSlotId] = getTournamentSourceSlotIds(match);
  return leftGroup?.id === winnerGroupId ? leftSlotId : rightGroup?.id === winnerGroupId ? rightSlotId : leftSlotId;
}

function generateTournamentGroups() {
  const config = getTournamentConfig();
  const characters = shuffle(getSelectedCharacters()).slice(0, config.requiredRoster);
  const groups = [];
  for (let index = 0; index < characters.length; index += config.groupSize) {
    const groupIndex = index / config.groupSize;
    groups.push({
      id: `group-${groupIndex + 1}`,
      label: `${String.fromCharCode(65 + groupIndex)}组`,
      members: characters.slice(index, index + config.groupSize).map((character) => ({
        id: character.id,
        name: character.name,
        title: character.title,
        color: character.color,
      })),
    });
  }

  tournamentState.groups = groups;
  tournamentState.rounds = buildTournamentRounds(groups, tournamentFormat);
  tournamentState.generated = true;
  tournamentState.championGroupId = null;
  tournamentState.latestResult = null;
  tournamentState.currentMatchId = null;
  tournamentState.currentRoundLabel = "抽签完成";
  tournamentState.format = tournamentFormat;
  renderTournamentPanel();
  return groups;
}

function getTournamentRosterPool() {
  return getSelectedCharacters().map((character) => ({
    id: character.id,
    name: character.name,
    title: character.title,
    color: character.color,
  }));
}

function setTournamentFormat(format) {
  if (!TOURNAMENT_FORMATS[format] || tournamentState.active || format === tournamentFormat) {
    return;
  }
  tournamentFormat = format;
  tournamentState.format = format;
  invalidateTournamentBracket();
  updateRosterStatus();
  updateRecordButton();
}

function getTournamentPreviewBuffer(size) {
  const key = `${size}`;
  if (!tournamentPreviewBuffers.has(key)) {
    const buffer = document.createElement("canvas");
    buffer.width = size;
    buffer.height = size;
    tournamentPreviewBuffers.set(key, buffer);
  }
  return tournamentPreviewBuffers.get(key);
}

function drawFallbackTournamentBall(ctx, x, y, diameter, color = "#7a7a7a", alpha = 1) {
  const radius = diameter / 2;
  const gradient = ctx.createRadialGradient(
    x - radius * 0.32,
    y - radius * 0.34,
    radius * 0.14,
    x,
    y,
    radius,
  );
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.38, color);
  gradient.addColorStop(1, "rgba(10,10,10,0.92)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = Math.max(2, diameter * 0.05);
  ctx.stroke();
  ctx.restore();
}

function drawTournamentBallPreview(ctx, x, y, diameter, member, alpha = 1, elapsed = 0) {
  const character = member?.id ? getCharacterById(member.id) : null;
  if (!character) {
    drawFallbackTournamentBall(ctx, x, y, diameter, member?.color, alpha);
    return;
  }

  const bufferSize = Math.max(64, Math.round(diameter * 2));
  const buffer = getTournamentPreviewBuffer(bufferSize);
  const bufferCtx = buffer.getContext("2d");
  bufferCtx.clearRect(0, 0, buffer.width, buffer.height);
  game.renderBallPreview(bufferCtx, character, elapsed);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(buffer, x - diameter / 2, y - diameter / 2, diameter, diameter);
  ctx.restore();
}

function renderTournamentBallCanvases(root = document) {
  root.querySelectorAll("canvas[data-ball-character-id]").forEach((ballCanvas) => {
    const characterId = ballCanvas.dataset.ballCharacterId;
    const size = Number(ballCanvas.dataset.ballSize || 58);
    const dpr = window.devicePixelRatio || 1;
    const pixelSize = Math.max(1, Math.round(size * dpr));
    if (ballCanvas.width !== pixelSize || ballCanvas.height !== pixelSize) {
      ballCanvas.width = pixelSize;
      ballCanvas.height = pixelSize;
      ballCanvas.style.width = `${size}px`;
      ballCanvas.style.height = `${size}px`;
    }
    const ctx = ballCanvas.getContext("2d");
    ctx.clearRect(0, 0, ballCanvas.width, ballCanvas.height);
    const character = getCharacterById(characterId);
    if (!character) {
      drawFallbackTournamentBall(ctx, ballCanvas.width / 2, ballCanvas.height / 2, ballCanvas.width * 0.92);
      return;
    }
    game.renderBallPreview(ctx, character, performance.now() / 1000);
  });
}

function renderTournamentPanel() {
  tournamentPanel.classList.toggle("hidden", appMode !== "tournament");
  if (appMode !== "tournament") {
    return;
  }

  const config = getTournamentConfig();
  tournamentFormatTeamButton?.classList.toggle("active", tournamentFormat === "team");
  tournamentFormatSoloButton?.classList.toggle("active", tournamentFormat === "solo");
  tournamentFormatTeamButton?.setAttribute("aria-pressed", tournamentFormat === "team" ? "true" : "false");
  tournamentFormatSoloButton?.setAttribute("aria-pressed", tournamentFormat === "solo" ? "true" : "false");
  if (tournamentFormatTeamButton) {
    tournamentFormatTeamButton.disabled = tournamentState.active;
  }
  if (tournamentFormatSoloButton) {
    tournamentFormatSoloButton.disabled = tournamentState.active;
  }
  tournamentSummaryElement.textContent = tournamentState.generated
    ? config.summaryReady
    : config.summaryIdle;
  tournamentRoundIndicator.textContent = tournamentState.currentRoundLabel || "等待抽签";
  tournamentDrawButton.disabled = !canStartTournament() || tournamentState.active;

  if (!tournamentState.generated) {
    tournamentGroupsElement.classList.add("hidden");
    tournamentGroupsElement.innerHTML = "";
    tournamentBracketElement.innerHTML = "";
    return;
  }

  tournamentGroupsElement.classList.add("hidden");
  tournamentGroupsElement.innerHTML = "";
  const layout = getTournamentBracketLayout();
  const slotIds = Object.keys(layout.slots);
  const connectorPaths = tournamentState.rounds.flatMap((round) =>
    round.matches.map((match) => {
      const targetSlotId = getTournamentWinnerSlotId(match.id);
      const targetPos = layout.slots[targetSlotId];
      const sourcePoints = getTournamentSourceSlotIds(match)
        .map((slotId) => layout.slots[slotId])
        .filter(Boolean);
      return sourcePoints.map((sourcePos) => {
        const midX = (sourcePos.x + targetPos.x) / 2;
        return `
          <path
            d="M ${sourcePos.x * 100} ${sourcePos.y * 100}
               L ${midX * 100} ${sourcePos.y * 100}
               L ${midX * 100} ${targetPos.y * 100}
               L ${targetPos.x * 100} ${targetPos.y * 100}"
          />
        `;
      }).join("");
    }),
  ).join("");

  tournamentBracketElement.innerHTML = `
    <div class="tournament-tree">
      <svg class="tournament-tree-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${connectorPaths}
      </svg>
      ${layout.headings.map((heading) => `
        <div class="tournament-tree-heading" style="left:${heading.x * 100}%">${heading.label}</div>
      `).join("")}
      ${slotIds.map((slotId) => {
        const group = getTournamentSlotGroup(slotId);
        const pos = layout.slots[slotId];
        const status = group ? getGroupMatchStatus(group.id) : "pending";
        const members = group?.members ?? [];
        return `
          <div
            class="tournament-tree-slot ${status}"
            style="left:${pos.x * 100}%; top:${pos.y * 100}%;"
            data-slot-id="${slotId}"
            ${group ? `data-group-id="${group.id}"` : ""}
          >
            <div class="tournament-tree-token">
              <div class="tournament-tree-balls">
                ${members.map((member) => `
                  <canvas
                    class="tournament-tree-ball-preview"
                    width="58"
                    height="58"
                    data-ball-character-id="${member.id}"
                    data-ball-size="58"
                    aria-label="${member.name}"
                  ></canvas>
                `).join("")}
              </div>
            </div>
            <div class="tournament-tree-meta">
              <div class="tournament-tree-members">
                ${members.length
                  ? members.map((member) => `<span style="color:${member.color}">${member.name}</span>`).join("")
                  : "<span>等待晋级</span>"}
              </div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
  renderTournamentBallCanvases(tournamentBracketElement);
}

function captureTournamentPromotion(match, winnerGroupId) {
  const sourceSlotId = getWinningSourceSlotId(match, winnerGroupId);
  const sourceElement = tournamentBracketElement.querySelector(
    `[data-slot-id="${sourceSlotId}"][data-group-id="${winnerGroupId}"]`,
  );
  if (!sourceElement) {
    return null;
  }
  const sourceToken = sourceElement.querySelector(".tournament-tree-token") ?? sourceElement;
  return {
    winnerGroupId,
    sourceSlotId,
    targetSlotId: getTournamentNextSlotId(match.id),
    sourceRect: sourceToken.getBoundingClientRect(),
  };
}

async function animateTournamentPromotion(promotion) {
  if (!promotion) {
    return;
  }

  const targetElement = tournamentBracketElement.querySelector(
    `[data-slot-id="${promotion.targetSlotId}"][data-group-id="${promotion.winnerGroupId}"]`,
  );
  if (!targetElement) {
    return;
  }

  const token = targetElement.querySelector(".tournament-tree-token");
  if (!token) {
    return;
  }

  const targetRect = token.getBoundingClientRect();
  const floating = document.createElement("div");
  floating.className = "tournament-promotion-float";
  floating.style.width = `${targetRect.width}px`;
  floating.style.height = `${targetRect.height}px`;
  floating.style.left = `${promotion.sourceRect.left + promotion.sourceRect.width * 0.5}px`;
  floating.style.top = `${promotion.sourceRect.top + promotion.sourceRect.height * 0.3}px`;
  floating.innerHTML = token.outerHTML;
  document.body.appendChild(floating);
  renderTournamentBallCanvases(floating);

  targetElement.classList.add("promotion-target");
  await floating.animate([
    {
      transform: "translate(-50%, -50%) scale(1)",
      opacity: 1,
      filter: "drop-shadow(0 0 0 rgba(255,255,255,0))",
    },
    {
      transform: `translate(${targetRect.left + targetRect.width * 0.5 - (promotion.sourceRect.left + promotion.sourceRect.width * 0.5)}px, ${targetRect.top + targetRect.height * 0.5 - (promotion.sourceRect.top + promotion.sourceRect.height * 0.3)}px) translate(-50%, -50%) scale(0.92)`,
      opacity: 0.94,
      filter: "drop-shadow(0 0 18px rgba(255,226,137,0.45))",
    },
  ], {
    duration: TOURNAMENT_PROMOTION_MS,
    easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    fill: "forwards",
  }).finished.catch(() => {});

  floating.remove();
  window.setTimeout(() => targetElement.classList.remove("promotion-target"), 700);
}

function resetTournamentRunState() {
  tournamentState.active = false;
  tournamentState.currentMatchId = null;
  tournamentState.currentRoundLabel = tournamentState.generated ? "等待开赛" : "等待抽签";
  tournamentState.pendingResolve = null;
  tournamentState.pendingReject = null;
  tournamentState.cancelled = false;
}

function invalidateTournamentBracket() {
  if (tournamentState.active) {
    return;
  }
  tournamentState.groups = [];
  tournamentState.rounds = [];
  tournamentState.generated = false;
  tournamentState.championGroupId = null;
  tournamentState.latestResult = null;
  tournamentState.currentMatchId = null;
  tournamentState.currentRoundLabel = "等待抽签";
  tournamentState.format = tournamentFormat;
  renderTournamentPanel();
}

function resetTournamentBracketProgress() {
  tournamentState.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      match.winnerGroupId = null;
      match.loserGroupId = null;
    });
  });
  tournamentState.championGroupId = null;
  tournamentState.latestResult = null;
  tournamentState.currentMatchId = null;
  tournamentState.currentRoundLabel = "等待开赛";
  renderTournamentPanel();
}

function stopTournamentScene() {
  tournamentState.sceneStopper?.();
  tournamentState.sceneStopper = null;
}

function drawTournamentGroupToken(ctx, x, y, radius, group, alpha = 1, elapsed = 0) {
  const members = group?.members?.length ? group.members : [{ color: "#7a7a7a" }];
  const count = Math.max(1, members.length);
  const ballDiameter = radius * 1.7;
  const spread = count === 1 ? 0 : radius * 0.92;
  ctx.save();
  ctx.globalAlpha = alpha;

  members.forEach((member, index) => {
    const offset = count === 1 ? 0 : (index === 0 ? -spread : spread);
    const orbX = x + offset;
    drawTournamentBallPreview(ctx, orbX, y, ballDiameter, member, 1, elapsed);
  });
  ctx.restore();
}

function renderTournamentBracketCanvas(ctx, scene, elapsed, width, height) {
  const layout = getTournamentBracketLayout();
  const slotPositions = Object.fromEntries(
    Object.entries(layout.slots).map(([slotId, pos]) => [
      slotId,
      {
        x: pos.x * width,
        y: 320 + pos.y * (height - 520),
      },
    ]),
  );

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(4,4,6,0.98)";
  ctx.lineWidth = 16;

  tournamentState.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      const target = slotPositions[getTournamentWinnerSlotId(match.id)];
      getTournamentSourceSlotIds(match).forEach((slotId) => {
        const source = slotPositions[slotId];
        if (!source || !target) {
          return;
        }
        const midX = (source.x + target.x) / 2;
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(midX, source.y);
        ctx.lineTo(midX, target.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      });
    });
  });

  layout.headings.forEach((heading) => {
    ctx.fillStyle = "#f4dc9c";
    ctx.font = '700 24px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(heading.label, heading.x * width, 286);
  });

  Object.entries(slotPositions).forEach(([slotId, point]) => {
    const group = getTournamentSlotGroup(slotId);
    const isPlaceholder = !group;
    const status = group ? getGroupMatchStatus(group.id) : "pending";
    let alpha = status === "eliminated" ? 0.38 : 1;
    if (scene.promotion?.targetSlotId === slotId) {
      const moveT = Math.min(1, elapsed / TOURNAMENT_PROMOTION_MS);
      alpha *= moveT > 0.82 ? 1 : 0.18;
    }

    if (isPlaceholder) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.arc(point.x, point.y, 28, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    drawTournamentGroupToken(ctx, point.x, point.y, 34, group, alpha, elapsed / 1000);
    if (status === "champion") {
      ctx.strokeStyle = "rgba(255,226,137,0.5)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 48, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = status === "eliminated" ? "rgba(255,255,255,0.72)" : "#ffffff";
    ctx.font = '500 15px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(getTournamentGroupDisplayText(group), point.x, point.y + 54);
  });

  if (scene.promotion) {
    const source = slotPositions[scene.promotion.sourceSlotId];
    const target = slotPositions[scene.promotion.targetSlotId];
    const group = getTournamentGroupById(scene.promotion.winnerGroupId);
    if (source && target && group) {
      const moveT = Math.min(1, elapsed / TOURNAMENT_PROMOTION_MS);
      const eased = moveT < 0.5 ? 4 * moveT * moveT * moveT : 1 - Math.pow(-2 * moveT + 2, 3) / 2;
      const x = source.x + (target.x - source.x) * eased;
      const y = source.y + (target.y - source.y) * eased;
      drawTournamentGroupToken(ctx, x, y, 38, group, 1, elapsed / 1000);
    }
  }

  ctx.restore();
}

function renderTournamentScene(scene, elapsed) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#050505");
  bg.addColorStop(1, "#171717");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.arc(width * 0.12, height * 0.14, width * 0.18, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.fillStyle = "#f4dc9c";
  ctx.font = '600 34px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(scene.eyebrow ?? "TOURNAMENT", width / 2, 120);
  ctx.fillStyle = "#ffffff";
  ctx.font = '700 70px Georgia, "Microsoft YaHei UI", serif';
  ctx.fillText(scene.title, width / 2, 210);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = '500 28px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(scene.subtitle ?? "", width / 2, 260);

  if (scene.type === "draw") {
    const pool = scene.pool;
    const groupWidth = 232;
    const memberRows = Math.max(1, Math.max(...scene.groups.map((group) => group.members.length)));
    const groupHeight = memberRows > 1 ? 170 : 120;
    const startX = 60;
    const startY = 340;
    const gapX = 18;
    const gapY = 18;
    scene.groups.forEach((group, index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);
      const x = startX + col * (groupWidth + gapX);
      const y = startY + row * (groupHeight + gapY);
      const settleProgress = Math.min(1, elapsed / TOURNAMENT_DRAW_MS);
      const settleThreshold = (index + 1) / scene.groups.length;
      const settled = settleProgress >= settleThreshold;

      fillRoundedPanel(ctx, x, y, groupWidth, groupHeight, 22);
      group.members.forEach((member, memberIndex) => {
        const displayMember = settled
          ? member
          : pool[(Math.floor(elapsed / 70) + index * 5 + memberIndex * 3) % pool.length];
        const tokenY = y + 64 + memberIndex * 58;
        drawTournamentBallPreview(ctx, x + 36, tokenY + 4, 38, displayMember, 1, elapsed / 1000);
        ctx.fillStyle = displayMember.color;
        ctx.font = '700 24px "Microsoft YaHei UI", sans-serif';
        ctx.fillText(displayMember.name, x + 68, tokenY + 8);
      });
    });
    return;
  }

  if (scene.type === "champion") {
    const group = scene.group;
    if (!group) {
      return;
    }
    fillRoundedPanel(ctx, 160, 360, width - 320, 820, 32);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffe9a8";
    ctx.font = '700 42px "Microsoft YaHei UI", sans-serif';
    ctx.fillText("决胜组出线", width / 2, 430);
    group.members.forEach((member, index) => {
      const centerX = width / 2 + (index - (group.members.length - 1) / 2) * 320;
      drawTournamentBallPreview(ctx, centerX, 650, 176, member, 1, elapsed / 1000);
      ctx.fillStyle = member.color;
      ctx.font = '700 38px "Microsoft YaHei UI", sans-serif';
      ctx.fillText(member.name, centerX, 790);
      ctx.fillStyle = "rgba(255,255,255,0.68)";
      ctx.font = '500 24px "Microsoft YaHei UI", sans-serif';
      ctx.fillText(member.title, centerX, 832);
    });
    return;
  }

  renderTournamentBracketCanvas(ctx, scene, elapsed, width, height);
}

function playTournamentScene(scene, duration) {
  stopTournamentScene();
  return new Promise((resolve) => {
    const start = performance.now();
    let rafId = 0;
    const frame = (now) => {
      const elapsed = now - start;
      renderTournamentScene(scene, elapsed);
      if (elapsed >= duration || tournamentState.cancelled) {
        tournamentState.sceneStopper = null;
        resolve();
        return;
      }
      rafId = requestAnimationFrame(frame);
    };
    tournamentState.sceneStopper = () => {
      cancelAnimationFrame(rafId);
      resolve();
    };
    rafId = requestAnimationFrame(frame);
  });
}

function getNextTournamentMatch() {
  for (const round of tournamentState.rounds) {
    for (const match of round.matches) {
      const [leftGroup, rightGroup] = getGroupsForMatch(match);
      if (!match.winnerGroupId && leftGroup && rightGroup) {
        return match;
      }
    }
  }
  return null;
}

function getTournamentWinnerFromSnapshot(snapshot, match) {
  const [leftGroup, rightGroup] = getGroupsForMatch(match);
  const candidateIds = [leftGroup?.id, rightGroup?.id].filter(Boolean);
  if (snapshot?.winnerTeamId && candidateIds.includes(snapshot.winnerTeamId)) {
    return snapshot.winnerTeamId;
  }

  const scores = new Map(candidateIds.map((id) => [id, 0]));
  snapshot?.actors?.forEach((actor) => {
    if (!scores.has(actor.teamId)) {
      return;
    }
    const weight = actor.hp + (actor.alive ? actor.maxHp * 2 : 0);
    scores.set(actor.teamId, (scores.get(actor.teamId) ?? 0) + weight);
  });

  const sorted = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  return sorted[0]?.[0] ?? leftGroup?.id ?? null;
}

function applyTournamentMatchResult(match, snapshot) {
  const [leftGroup, rightGroup] = getGroupsForMatch(match);
  const winnerGroupId = getTournamentWinnerFromSnapshot(snapshot, match);
  const loserGroupId = [leftGroup?.id, rightGroup?.id].find((id) => id && id !== winnerGroupId) ?? null;
  match.winnerGroupId = winnerGroupId;
  match.loserGroupId = loserGroupId;
  tournamentState.latestResult = {
    matchId: match.id,
    winnerGroupId,
    loserGroupId,
  };
  if (match.id === "final-1") {
    tournamentState.championGroupId = winnerGroupId;
  }
  renderTournamentPanel();
  return tournamentState.latestResult;
}

function setAppMode(mode) {
  appMode = mode;
  const isClassic = mode === "classic";
  classicModePanel.classList.toggle("hidden", !isClassic);
  tournamentModePanel.classList.toggle("hidden", isClassic);
  tournamentPanel.classList.toggle("hidden", isClassic);
  modeClassicButton.classList.toggle("active", isClassic);
  modeTournamentButton.classList.toggle("active", !isClassic);
  modeClassicButton.setAttribute("aria-selected", isClassic ? "true" : "false");
  modeTournamentButton.setAttribute("aria-selected", !isClassic ? "true" : "false");
  renderTournamentPanel();
  updateRosterStatus();
  updateRecordButton();
  updateHud(game.snapshot?.() ?? null);
}

function waitForTournamentMatchEnd() {
  return new Promise((resolve, reject) => {
    tournamentState.pendingResolve = resolve;
    tournamentState.pendingReject = reject;
  });
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
  if (snapshot) {
    recordingState.latestSnapshot = snapshot;
  }
}

function canRecordCanvas() {
  return typeof canvas.captureStream === "function" && typeof MediaRecorder !== "undefined";
}

// ── WebM → MP4 转换（FFmpeg.wasm，按需懒加载）─────────────────────────────────
let _ffmpeg = null;

async function loadFFmpeg() {
  if (_ffmpeg) return _ffmpeg;
  const { FFmpeg } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js");
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
    wasmURL: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
  });
  _ffmpeg = ffmpeg;
  return ffmpeg;
}

async function convertWebMToMP4(webmBlob, onProgress) {
  const ffmpeg = await loadFFmpeg();
  const handler = ({ progress }) => onProgress?.(progress);
  ffmpeg.on("progress", handler);
  try {
    await ffmpeg.writeFile("input.webm", new Uint8Array(await webmBlob.arrayBuffer()));
    await ffmpeg.exec(["-i", "input.webm", "-c:v", "copy", "-c:a", "aac", "output.mp4"]);
    const data = await ffmpeg.readFile("output.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", handler);
    ffmpeg.deleteFile("input.webm").catch(() => {});
    ffmpeg.deleteFile("output.mp4").catch(() => {});
  }
}

function getRecordingMimeType() {
  const mimeTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
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
  const activeButton = getCurrentRecordButton();
  if (!activeButton) {
    return;
  }

  const supported = canRecordCanvas();

  if (entryState.active) {
    activeButton.disabled = true;
    activeButton.textContent = "登场中...";
    return;
  }

  activeButton.disabled = recordingState.active ? false : !canStartMatch() || !supported || tournamentState.active;
  if (recordingState.active) {
    activeButton.textContent = appMode === "tournament" ? "停止录制赛事" : "停止录制";
    return;
  }

  activeButton.textContent = supported
    ? (appMode === "tournament" ? "录制整届赛事" : "录制对局")
    : "无法录制";
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

// ── VS 横幅（持久显示在角斗场顶部）────────────────────────────────────────────

function makeBannerPlayerEl(character, ballCssSize, ballCanvasSize) {
  const intro = getIntroText(character.id, character);
  const skillsHtml = [
    intro.basicAttackName ? `<div class="entry-skill"><span class="entry-skill-label">普攻</span><span class="entry-skill-name">${intro.basicAttackName}</span></div>` : "",
    intro.ultimateName ? `<div class="entry-skill"><span class="entry-skill-label">大招</span><span class="entry-skill-name">${intro.ultimateName}</span></div>` : "",
  ].join("");

  const player = document.createElement("div");
  player.className = "banner-vs-player";
  player.style.setProperty("--char-color", character.color);
  player.innerHTML = `
    <div class="banner-vs-name">${intro.name}</div>
    <div class="banner-vs-sub">
      <canvas class="banner-vs-ball" width="${ballCanvasSize}" height="${ballCanvasSize}" style="width:${ballCssSize}px;height:${ballCssSize}px;"></canvas>
      <div class="entry-card-skills">${skillsHtml}</div>
    </div>
    <div class="banner-essence-bar">
      <div class="banner-essence-fill"></div>
    </div>
  `;
  return player;
}

// teams: optional [[char, char], [char, char]] for 2v2 team layout
function showMatchVsBanner(characters, teams) {
  const dpr = window.devicePixelRatio || 1;
  const ballCssSize = 52;
  const ballCanvasSize = Math.round(ballCssSize * dpr);

  matchVsBanner.innerHTML = "";
  bannerEssenceFills.clear();
  bannerEssenceData.clear();

  function registerPlayer(character, playerEl) {
    const fill = playerEl.querySelector(".banner-essence-fill");
    bannerEssenceFills.set(character.id, fill);
    bannerEssenceData.set(character.id, { essence: 0, maxEssence: character.stats?.maxEssence ?? 5 });
  }

  if (teams && teams.length === 2) {
    // Team layout: [col1] VS [col2]
    const layout = document.createElement("div");
    layout.className = "banner-team-layout";

    teams.forEach((teamChars, ti) => {
      if (ti > 0) {
        const sep = document.createElement("span");
        sep.className = "banner-team-vs-sep";
        sep.textContent = "VS";
        layout.appendChild(sep);
      }

      const col = document.createElement("div");
      col.className = "banner-team-col";

      teamChars.forEach((character) => {
        const player = makeBannerPlayerEl(character, ballCssSize, ballCanvasSize);
        col.appendChild(player);
        registerPlayer(character, player);
      });

      layout.appendChild(col);
    });

    matchVsBanner.appendChild(layout);
  } else {
    // Solo layout: flat row with VS between each
    const vsRow = document.createElement("div");
    vsRow.className = "banner-vs-row";

    characters.forEach((character, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "banner-vs-sep";
        sep.textContent = "VS";
        vsRow.appendChild(sep);
      }

      const player = makeBannerPlayerEl(character, ballCssSize, ballCanvasSize);
      vsRow.appendChild(player);
      registerPlayer(character, player);
    });

    matchVsBanner.appendChild(vsRow);
  }

  matchVsBanner.classList.remove("hidden");
  startBannerBallLoop(characters);
}

function hideMatchVsBanner() {
  stopBannerBallLoop();
  stopBannerCanvasOverlay();
  bannerEssenceFills.clear();
  bannerEssenceData.clear();
  matchVsBanner.classList.add("hidden");
  matchVsBanner.innerHTML = "";
}

function stopBannerBallLoop() {
  if (bannerAnimFrameId != null) {
    cancelAnimationFrame(bannerAnimFrameId);
    bannerAnimFrameId = null;
  }
}

function startBannerBallLoop(characters) {
  stopBannerBallLoop();
  const start = performance.now();
  const loop = () => {
    const elapsed = (performance.now() - start) / 1000;
    const ballCanvases = matchVsBanner.querySelectorAll(".banner-vs-ball");
    characters.forEach((character, i) => {
      const ballCanvas = ballCanvases[i];
      if (!ballCanvas) return;
      const bCtx = ballCanvas.getContext("2d");
      bCtx.clearRect(0, 0, ballCanvas.width, ballCanvas.height);
      game.renderBallPreview(bCtx, character, elapsed);
    });
    bannerAnimFrameId = requestAnimationFrame(loop);
  };
  bannerAnimFrameId = requestAnimationFrame(loop);
}

function startBannerCanvasOverlay(characters, teams) {
  stopBannerCanvasOverlay();
  bannerCanvasStart = performance.now();

  // px = native canvas pixels per CSS display pixel (fixed for this match session)
  const rect = canvas.getBoundingClientRect();
  const px = rect.width > 0 ? canvas.width / rect.width : 2;

  const loop = () => {
    if (matchVsBanner.classList.contains("hidden")) {
      bannerCanvasLoopId = null;
      return;
    }
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const elapsed = (performance.now() - bannerCanvasStart) / 1000;

    ctx.save();
    drawBannerOnCanvas(ctx, W, H, px, characters, elapsed, teams);
    ctx.restore();

    bannerCanvasLoopId = requestAnimationFrame(loop);
  };
  bannerCanvasLoopId = requestAnimationFrame(loop);
}

function stopBannerCanvasOverlay() {
  if (bannerCanvasLoopId != null) {
    cancelAnimationFrame(bannerCanvasLoopId);
    bannerCanvasLoopId = null;
  }
}

function drawBannerPlayerOnCanvas(ctx, character, cx, nameY, subCy, barY, playerColW, ballSz, gap, barH, nameSz, skillSz, px, elapsed) {
  const intro = getIntroText(character.id, character);

  // Name
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = character.color;
  ctx.font = `900 ${nameSz}px "Microsoft YaHei UI", sans-serif`;
  ctx.fillText(intro.name, cx, nameY);

  // Ball + skill names
  const skills = [
    intro.basicAttackName ? { label: "普攻", name: intro.basicAttackName } : null,
    intro.ultimateName   ? { label: "大招", name: intro.ultimateName }   : null,
  ].filter(Boolean);

  ctx.font = `600 ${skillSz}px "Microsoft YaHei UI", sans-serif`;
  const maxSkillW = skills.reduce((max, s) => Math.max(max, ctx.measureText(s.label + " " + s.name).width), 0);
  const subBlockW = ballSz + gap + maxSkillW;
  const ballCx = cx - subBlockW / 2 + ballSz / 2;
  const skillX = cx - subBlockW / 2 + ballSz + gap;

  const offCanvas = document.createElement("canvas");
  offCanvas.width  = ballSz;
  offCanvas.height = ballSz;
  game.renderBallPreview(offCanvas.getContext("2d"), character, elapsed);
  ctx.drawImage(offCanvas, ballCx - ballSz / 2, subCy - ballSz / 2, ballSz, ballSz);

  skills.forEach(({ label, name: skillName }, si) => {
    const sy = subCy + (si - (skills.length - 1) / 2) * (skillSz + Math.round(5 * px));
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `400 ${skillSz}px "Microsoft YaHei UI", sans-serif`;
    const lw = ctx.measureText(label + " ").width;
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText(label + " ", skillX, sy);
    ctx.font = `600 ${skillSz}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(skillName, skillX + lw, sy);
  });

  // Essence bar
  const barW = Math.min(playerColW * 0.72, Math.round(140 * px));
  const barX = cx - barW / 2;
  const essData = bannerEssenceData.get(character.id);
  const ratio = essData && essData.maxEssence > 0 ? essData.essence / essData.maxEssence : 0;

  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(barX, barY, barW, barH);
  if (ratio > 0.001) {
    ctx.fillStyle = character.color;
    ctx.fillRect(barX, barY, barW * ratio, barH);
  }
}

function drawBannerOnCanvas(ctx, W, H, px, characters, elapsed, teams) {
  // All sizes in CSS-equivalent px, then multiplied by px → native canvas pixels
  const nameSz  = Math.round(30 * px);
  const vsSz    = Math.round(22 * px);
  const skillSz = Math.round(13 * px);
  const ballSz  = Math.round(52 * px);
  const barH    = Math.round(5 * px);
  const gap     = Math.round(8 * px);
  const padTop  = Math.round(10 * px);
  const rowGap  = Math.round(10 * px); // gap between players in team column

  // Player block height (name + sub + bar)
  const subH    = ballSz;
  const playerBlockH = nameSz + gap + subH + gap + barH;

  // Total banner height: for teams, 2 stacked player blocks; for solo, 1 player block
  const isTeam = teams && teams.length === 2;
  const bannerH = padTop + (isTeam ? playerBlockH * 2 + rowGap : playerBlockH) + Math.round(14 * px);

  // Background gradient
  const grd = ctx.createLinearGradient(0, 0, 0, bannerH + Math.round(10 * px));
  grd.addColorStop(0, "rgba(4,4,4,0.80)");
  grd.addColorStop(1, "rgba(4,4,4,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, bannerH + Math.round(10 * px));

  if (isTeam) {
    // Team layout: [left col] [VS] [right col]
    const vsColW     = vsSz * 3.0;
    const teamColW   = (W - vsColW) / 2;
    const leftCx     = teamColW / 2;
    const rightCx    = teamColW + vsColW + teamColW / 2;
    const vsCx       = teamColW + vsColW / 2;

    // VS in the vertical center of the banner content area
    const vsCy = padTop + playerBlockH + rowGap / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `900 ${vsSz}px "Microsoft YaHei UI", sans-serif`;
    ctx.fillText("VS", vsCx, vsCy);

    teams.forEach((teamChars, ti) => {
      const cx = ti === 0 ? leftCx : rightCx;
      teamChars.forEach((character, pi) => {
        const baseY = padTop + pi * (playerBlockH + rowGap);
        const nameY = baseY + nameSz / 2;
        const subCy = baseY + nameSz + gap + subH / 2;
        const barY  = baseY + nameSz + gap + subH + gap;
        drawBannerPlayerOnCanvas(ctx, character, cx, nameY, subCy, barY, teamColW, ballSz, gap, barH, nameSz, skillSz, px, elapsed);
      });
    });
  } else {
    // Solo layout: flat row
    const n = characters.length;
    const vsColW     = vsSz * 3.0;
    const playerColW = (W - vsColW * (n - 1)) / n;
    const playerCx   = (i) => playerColW * (i + 0.5) + vsColW * i;
    const vsCx       = (i) => playerColW * (i + 1) + vsColW * (i + 0.5);

    const nameY = padTop + nameSz / 2;
    const subCy = padTop + nameSz + gap + subH / 2;
    const barY  = padTop + nameSz + gap + subH + gap;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `900 ${vsSz}px "Microsoft YaHei UI", sans-serif`;
    for (let i = 0; i < n - 1; i++) {
      ctx.fillText("VS", vsCx(i), nameY);
    }

    characters.forEach((character, i) => {
      drawBannerPlayerOnCanvas(ctx, character, playerCx(i), nameY, subCy, barY, playerColW, ballSz, gap, barH, nameSz, skillSz, px, elapsed);
    });
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
  updateRosterStatus();
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
    getAudioStream().getAudioTracks().forEach((track) => stream.addTrack(track));
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

      recordingState.stream?.getTracks().forEach((track) => track.stop());
      resetAudioStream();
      resetRecordingState();

      if (chunks.length) {
        const webmBlob = new Blob(chunks, { type: finalMimeType });
        if (!window.confirm("录制已完成，是否导出这段视频？")) return;

        downloadRecording(webmBlob, finalMimeType);

        if (!window.confirm("是否同时转换为 MP4？\n（首次使用需加载约 25MB 的转换工具）")) return;

        const btn = getCurrentRecordButton();
        if (btn) { btn.textContent = "加载转换工具..."; btn.disabled = true; }

        try {
          const mp4Blob = await convertWebMToMP4(webmBlob, (p) => {
            if (btn) btn.textContent = `MP4 转换中 ${Math.round(p * 100)}%`;
          });
          const url = URL.createObjectURL(mp4Blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${buildRecordingFilename()}.mp4`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
          console.error("MP4 conversion failed:", err);
          window.alert("MP4 转换失败，请使用已下载的 WebM 文件。");
        } finally {
          updateRecordButton();
        }
      }
    });

    recorder.addEventListener("error", () => {
      recordingState.stream?.getTracks().forEach((track) => track.stop());
      resetAudioStream();
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

  if (tournamentState.active) {
    stopTournamentRun();
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
  if (appMode === "tournament") {
    return startTournament({ record });
  }
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

  entryState.active = true;
  updateRosterStatus();
  updateRecordButton();

  const characters = selectedIds.map((id) => getCharacterById(id)).filter(Boolean);
  showMatchVsBanner(characters);

  const focusId = selectedIds.includes(selectedId) ? selectedId : selectedIds[0];
  game.start(focusId, selectedIds, {
    includeEdgeHazards: matchSettings.includeEdgeHazards,
    duelTime: matchSettings.duelTime,
  });
  if (recordingState.active) startBannerCanvasOverlay(characters);
  game.startEntryTransition();

  await new Promise((resolve) => setTimeout(resolve, ENTRY_HOLD_MS));

  game.endEntryTransition();
  entryState.active = false;
  updateRosterStatus();
  updateRecordButton();
}

function stopTournamentRun() {
  tournamentState.cancelled = true;
  stopTournamentScene();
  hideMatchVsBanner();
  if (tournamentState.pendingResolve) {
    const resolve = tournamentState.pendingResolve;
    tournamentState.pendingResolve = null;
    tournamentState.pendingReject = null;
    resolve(null);
  }
  game.stop();
}

async function runTournamentMatch(match) {
  const [leftGroup, rightGroup] = getGroupsForMatch(match);
  if (!leftGroup || !rightGroup) {
    return null;
  }

  tournamentState.currentMatchId = match.id;
  tournamentState.currentRoundLabel = `${match.roundLabel} · ${getTournamentGroupDisplayText(leftGroup)} VS ${getTournamentGroupDisplayText(rightGroup)}`;
  renderTournamentPanel();

  await playTournamentScene({
    type: "bracket",
    title: `${getTournamentGroupDisplayText(leftGroup)} VS ${getTournamentGroupDisplayText(rightGroup)}`,
    subtitle: `${match.roundLabel} ${match.label}`,
    rounds: tournamentState.rounds,
    activeMatchId: match.id,
  }, TOURNAMENT_MATCH_OVERLAY_MS);

  if (tournamentState.cancelled) {
    return null;
  }

  const competitors = [leftGroup, rightGroup].flatMap((group) =>
    group.members.map((member) => ({
      characterId: member.id,
      teamId: group.id,
      teamLabel: getTournamentGroupDisplayText(group),
    })),
  );
  const focusId = competitors[0]?.characterId;

  overlay.classList.add("hidden");
  overlay.innerHTML = "";

  entryState.active = true;
  updateRosterStatus();
  updateRecordButton();

  const competitorChars = competitors.map((c) => getCharacterById(c.characterId)).filter(Boolean);
  const leftChars = leftGroup.members.map((m) => getCharacterById(m.id)).filter(Boolean);
  const rightChars = rightGroup.members.map((m) => getCharacterById(m.id)).filter(Boolean);
  const teamGroups = leftChars.length > 0 && rightChars.length > 0 ? [leftChars, rightChars] : null;
  showMatchVsBanner(competitorChars, teamGroups);

  game.start(focusId, competitors, {
    includeEdgeHazards: matchSettings.includeEdgeHazards,
    duelTime: matchSettings.duelTime,
  });
  if (recordingState.active) startBannerCanvasOverlay(competitorChars, teamGroups);
  game.startEntryTransition();

  await new Promise((resolve) => setTimeout(resolve, ENTRY_HOLD_MS));

  game.endEntryTransition();
  entryState.active = false;
  updateRosterStatus();
  updateRecordButton();

  const snapshot = await waitForTournamentMatchEnd();
  game.stop();
  if (!snapshot || tournamentState.cancelled) {
    return null;
  }

  const winnerGroupId = getTournamentWinnerFromSnapshot(snapshot, match);
  const promotion = captureTournamentPromotion(match, winnerGroupId);
  applyTournamentMatchResult(match, snapshot);
  await animateTournamentPromotion(promotion);
  const winnerGroup = getTournamentGroupById(match.winnerGroupId);
  tournamentState.currentRoundLabel = `${getTournamentGroupDisplayText(winnerGroup)} 晋级`;
  renderTournamentPanel();

  await playTournamentScene({
    type: "bracket",
    title: winnerGroup ? `${getTournamentGroupDisplayText(winnerGroup)} 晋级` : "赛果已更新",
    subtitle: `${match.roundLabel} ${match.label} 结束`,
    rounds: tournamentState.rounds,
    activeMatchId: match.id,
    promotion: promotion
      ? {
        winnerGroupId,
        sourceSlotId: promotion.sourceSlotId,
        targetSlotId: promotion.targetSlotId,
      }
      : null,
  }, TOURNAMENT_RESULT_BRACKET_MS);

  return snapshot;
}

async function startTournament({ record = false } = {}) {
  const tournamentConfig = getTournamentConfig();
  if (tournamentState.active || entryState.active) {
    return;
  }
  if (!canStartTournament()) {
    return;
  }

  if (record && !startCanvasRecording()) {
    return;
  }

  closeRosterModal();
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
  battleFeedItems.length = 0;
  feed.innerHTML = "";
  game.stop();
  resetTournamentRunState();
  tournamentState.active = true;
  tournamentState.cancelled = false;

  if (!tournamentState.generated) {
    generateTournamentGroups();
    await playTournamentScene({
      type: "draw",
      eyebrow: "RANDOM DRAW",
      title: tournamentConfig.drawTitle,
      subtitle: tournamentConfig.drawSubtitle,
      groups: tournamentState.groups,
      pool: getTournamentRosterPool(),
    }, TOURNAMENT_DRAW_MS);
  } else {
    resetTournamentBracketProgress();
    await playTournamentScene({
      type: "bracket",
      title: `${tournamentConfig.title}赛程已就绪`,
      subtitle: `按顺序开始每一轮${tournamentConfig.lineupLabel}对决`,
      rounds: tournamentState.rounds,
      activeMatchId: null,
    }, TOURNAMENT_BRACKET_HOLD_MS);
  }

  try {
    let match = getNextTournamentMatch();
    while (match && !tournamentState.cancelled) {
      const snapshot = await runTournamentMatch(match);
      if (!snapshot) {
        break;
      }
      match = getNextTournamentMatch();
    }

    if (!tournamentState.cancelled && tournamentState.championGroupId) {
      const championGroup = getTournamentGroupById(tournamentState.championGroupId);
      tournamentState.currentRoundLabel = "冠军已诞生";
      renderTournamentPanel();
      await playTournamentScene({
        type: "champion",
        eyebrow: "TOURNAMENT WINNER",
        title: tournamentConfig.championTitle,
        subtitle: championGroup ? `${getTournamentGroupDisplayText(championGroup)} ${tournamentConfig.championSubtitle}` : "",
        group: championGroup,
      }, TOURNAMENT_CHAMPION_HOLD_MS);
    }
  } finally {
    tournamentState.active = false;
    tournamentState.currentMatchId = null;
    tournamentState.currentRoundLabel = tournamentState.championGroupId ? "冠军已诞生" : "等待开赛";
    renderTournamentPanel();
    updateRosterStatus();
    updateRecordButton();
    if (recordingState.active) {
      scheduleCanvasRecordingStop();
    }
  }
}

const game = new ArenaGame(canvas, {
  onAnnouncement({ stamp, message }) {
    if (!tournamentState.active) {
      pushFeed(stamp, message);
    }
  },
  onSound(event) {
    playSound(event);
  },
  onStateChange(snapshot) {
    updateHud(snapshot);
    renderScoreboard(snapshot);
    recordingState.latestSnapshot = snapshot;
    renderRecordingFrame(snapshot);
    // Update essence progress bars
    if (bannerEssenceFills.size > 0) {
      for (const actor of snapshot.actors) {
        const fill = bannerEssenceFills.get(actor.characterId);
        if (fill) {
          const pct = actor.maxEssence > 0 ? (actor.essence / actor.maxEssence) * 100 : 0;
          fill.style.width = `${pct}%`;
        }
        if (bannerEssenceData.has(actor.characterId)) {
          bannerEssenceData.set(actor.characterId, { essence: actor.essence, maxEssence: actor.maxEssence });
        }
      }
    }
  },
  onMatchStart(snapshot) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    if (!tournamentState.active) {
      battleFeedItems.length = 0;
      feed.innerHTML = "";
    }
    updateHud(snapshot);
    renderScoreboard(snapshot);
    recordingState.latestSnapshot = snapshot;
    renderRecordingFrame(snapshot);
  },
  onMatchEnd(snapshot) {
    recordingState.latestSnapshot = snapshot;
    renderRecordingFrame(snapshot);

    if (tournamentState.active) {
      if (tournamentState.pendingResolve) {
        const resolve = tournamentState.pendingResolve;
        tournamentState.pendingResolve = null;
        tournamentState.pendingReject = null;
        resolve(snapshot);
      }
      return;
    }

    hideMatchVsBanner();
    const winner = snapshot.actors.find((actor) => actor.id === snapshot.winnerId);
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

    scheduleCanvasRecordingStop();
  },
});

startButton.addEventListener("click", () => {
  resumeAudio();
  startMatch();
});

tournamentStartButton?.addEventListener("click", () => {
  resumeAudio();
  startTournament();
});

recordButton?.addEventListener("click", () => {
  resumeAudio();
  if (recordingState.active) {
    stopRecordedMatch();
    return;
  }

  startMatch({ record: true });
});

tournamentRecordButton?.addEventListener("click", () => {
  resumeAudio();
  if (recordingState.active) {
    stopRecordedMatch();
    return;
  }
  startTournament({ record: true });
});

modeClassicButton?.addEventListener("click", () => {
  if (tournamentState.active) {
    return;
  }
  setAppMode("classic");
});

modeTournamentButton?.addEventListener("click", () => {
  if (tournamentState.active) {
    return;
  }
  setAppMode("tournament");
});

tournamentFormatTeamButton?.addEventListener("click", () => {
  setTournamentFormat("team");
});

tournamentFormatSoloButton?.addEventListener("click", () => {
  setTournamentFormat("solo");
});

tournamentDrawButton?.addEventListener("click", async () => {
  if (tournamentState.active || !canStartTournament()) {
    return;
  }
  const tournamentConfig = getTournamentConfig();
  generateTournamentGroups();
  await playTournamentScene({
    type: "draw",
    eyebrow: "RANDOM DRAW",
    title: tournamentConfig.drawTitle,
    subtitle: tournamentConfig.drawSubtitle,
    groups: tournamentState.groups,
    pool: getTournamentRosterPool(),
  }, TOURNAMENT_DRAW_MS);
  tournamentState.currentRoundLabel = "抽签完成";
  renderTournamentPanel();
});

resetButton.addEventListener("click", () => {
  resetCharacterValues(selectedId);
  clearOverrides(selectedId);
  renderRoster();
  renderEditor();
});

selectAllButton.addEventListener("click", () => {
  selectedRosterIds = new Set(CHARACTER_LIBRARY.map((character) => character.id));
  invalidateTournamentBracket();
  renderRoster();
});

clearRosterButton.addEventListener("click", () => {
  selectedRosterIds = new Set([selectedId]);
  invalidateTournamentBracket();
  renderRoster();
});

openRosterButton.addEventListener("click", () => {
  openRosterModal();
});

openRosterButtonTournament?.addEventListener("click", () => {
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
  const [allOverrides, allIntros] = await Promise.all([loadAllOverrides(), loadAllIntros()]);

  let hasChanges = false;
  for (const [characterId, overrides] of Object.entries(allOverrides)) {
    for (const [path, value] of Object.entries(overrides)) {
      updateCharacterValue(characterId, path, value);
      hasChanges = true;
    }
  }

  for (const [characterId, row] of Object.entries(allIntros)) {
    introCache[characterId] = row;
  }

  if (hasChanges || Object.keys(allIntros).length > 0) {
    renderRoster();
    renderEditor();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

renderRoster();
renderEditor();
renderScoreboard(null);
syncDuelTimeInput();
updateHud(null);
setAppMode("classic");
renderTournamentPanel();
initDb();
