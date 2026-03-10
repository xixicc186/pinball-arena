import {
  CHARACTER_LIBRARY,
  getCharacterById,
  instantiateCharacter,
} from "./characters.js";

const WORLD_WIDTH = 540;
const WORLD_HEIGHT = 960;
// 全局游戏尺度系数：小球、技能半径、炮台射程等都乘以此系数
const GAME_SCALE = 4 / 3;
const MAX_DT = 1 / 30;
const DEFAULT_DUEL_TIME = 45;
const BASE_ESSENCE_INTERVAL = 3.2;
const DUEL_ESSENCE_INTERVAL = 1.15;
const MAX_ESSENCE_ON_FIELD = 6;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function length(vector) {
  return Math.hypot(vector.x, vector.y);
}

function normalize(vector) {
  const size = length(vector);
  if (!size) {
    return { x: 1, y: 0 };
  }
  return { x: vector.x / size, y: vector.y / size };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(vector, amount) {
  return { x: vector.x * amount, y: vector.y * amount };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function reflect(vector, normal) {
  const normalScale = 2 * dot(vector, normal);
  return {
    x: vector.x - normalScale * normal.x,
    y: vector.y - normalScale * normal.y,
  };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomUnit() {
  const angle = randomBetween(0, Math.PI * 2);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function formatTime(seconds) {
  return `${seconds.toFixed(1)}s`;
}

function closestPointOnSegment(point, a, b) {
  const segment = subtract(b, a);
  const lengthSquared = dot(segment, segment);
  if (!lengthSquared) {
    return a;
  }
  const t = clamp(dot(subtract(point, a), segment) / lengthSquared, 0, 1);
  return add(a, scale(segment, t));
}

function distanceToSegment(point, a, b) {
  return distance(point, closestPointOnSegment(point, a, b));
}

function pointInConvexPolygon(point, polygon) {
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const edge = subtract(next, current);
    const inward = normalize({ x: -edge.y, y: edge.x });
    if (dot(subtract(point, current), inward) < 0) {
      return false;
    }
  }
  return true;
}

function polygonInwardNormal(a, b) {
  const edge = subtract(b, a);
  return normalize({ x: -edge.y, y: edge.x });
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a, b, c) {
  return (
    b.x >= Math.min(a.x, c.x) - 0.001 &&
    b.x <= Math.max(a.x, c.x) + 0.001 &&
    b.y >= Math.min(a.y, c.y) - 0.001 &&
    b.y <= Math.max(a.y, c.y) + 0.001
  );
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);

  if (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  ) {
    return true;
  }

  if (Math.abs(abC) < 0.001 && onSegment(a, c, b)) {
    return true;
  }
  if (Math.abs(abD) < 0.001 && onSegment(a, d, b)) {
    return true;
  }
  if (Math.abs(cdA) < 0.001 && onSegment(c, a, d)) {
    return true;
  }
  if (Math.abs(cdB) < 0.001 && onSegment(c, b, d)) {
    return true;
  }
  return false;
}

function makeArena(options = {}) {
  const includeEdgeHazards = options.includeEdgeHazards ?? true;
  const center = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
  const sides = Math.floor(randomBetween(5, 11));
  const points = [];
  const offset = randomBetween(0, Math.PI * 2);
  const targetArea = randomBetween(165000, 185000);
  const circumradius = Math.sqrt(
    (2 * targetArea) / (sides * Math.sin((Math.PI * 2) / sides)),
  );

  for (let index = 0; index < sides; index += 1) {
    const angle = offset + (Math.PI * 2 * index) / sides;
    const radiusScale = randomBetween(0.985, 1.015);
    points.push({
      x: center.x + Math.cos(angle) * circumradius * radiusScale,
      y: center.y + Math.sin(angle) * circumradius * radiusScale,
    });
  }

  const walls = [];

  const spikes = [];
  if (includeEdgeHazards) {
    const spikeEdgeIndex = Math.floor(randomBetween(0, sides));
    const spikeStart = points[spikeEdgeIndex];
    const spikeEnd = points[(spikeEdgeIndex + 1) % points.length];
    const spikeLength = distance(spikeStart, spikeEnd);
    spikes.push({
      a: spikeStart,
      b: spikeEnd,
      normal: polygonInwardNormal(spikeStart, spikeEnd),
      depth: randomBetween(8, 12),
      contactDamage: 3,
      phase: randomBetween(0, Math.PI * 2),
      spikeCount: Math.max(6, Math.floor(spikeLength / 28)),
    });
  }

  return { points, walls, hazards: spikes, center, sides, targetArea };
}

export class ArenaGame {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.callbacks = callbacks;
    this.rafId = 0;
    this.lastFrame = 0;
    this.running = false;
    this.state = null;
  }

  start(selectedCharacterId, rosterIds = null, options = {}) {
    const chosenIds = Array.isArray(rosterIds) && rosterIds.length
      ? [...new Set(rosterIds)]
      : CHARACTER_LIBRARY.map((character) => character.id);
    const roster = chosenIds
      .map((id) => getCharacterById(id))
      .filter(Boolean);
    const selected = roster.find((character) => character.id === selectedCharacterId)
      ?? getCharacterById(selectedCharacterId)
      ?? roster[0]
      ?? CHARACTER_LIBRARY[0];

    if (!roster.length) {
      return;
    }

    this.state = {
      elapsed: 0,
      duelTriggered: false,
      matchOver: false,
      winnerId: null,
      selectedId: selected.id,
      settings: {
        includeEdgeHazards: options.includeEdgeHazards ?? true,
        duelTime: options.duelTime ?? DEFAULT_DUEL_TIME,
      },
      arena: makeArena({
        includeEdgeHazards: options.includeEdgeHazards ?? true,
      }),
      actors: [],
      essences: [],
      projectiles: [],
      pulses: [],
      particles: [],
      damageTexts: [],
      trails: [],
      turrets: [],
      strikes: [],
      beams: [],
      decoys: [],
      lasers: [],
      scheduledActions: [],
      shake: { amplitude: 0, duration: 0, timeLeft: 0 },
      nextEssenceIn: 1.5,
      announcements: [],
      deathOrder: [],
      finishOrder: [],
    };

    roster.forEach((character, index) => {
      this.state.actors.push(this.spawnActor(character, index, character.id === selected.id));
    });

    this.callbacks.onMatchStart?.(this.snapshot());
    this.announce(`${selected.name} 已进入角斗场。`);

    this.running = true;
    this.lastFrame = performance.now();
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame((timestamp) => this.frame(timestamp));
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  spawnActor(character, index, isPlayer) {
    const definition = instantiateCharacter(character);
    const radius = (definition.stats.radius ?? 18) * GAME_SCALE;
    const position = this.sampleFreePoint(radius + 8);
    const direction = randomUnit();
    const baseSpeed = definition.stats.speed * GAME_SCALE;

    const actor = {
      id: `${definition.id}-${index}-${Math.random().toString(16).slice(2, 8)}`,
      characterId: definition.id,
      name: definition.name,
      title: definition.title,
      color: definition.color,
      description: definition.description,
      isPlayer,
      definition,
      position,
      velocity: scale(direction, baseSpeed),
      radius,
      baseRadius: radius,
      stats: { ...definition.stats, speed: definition.stats.speed * GAME_SCALE },
      hp: definition.stats.maxHp,
      essence: 0,
      alive: true,
      highlightTime: 0,
      cooldowns: new Map(),
      hazardTimers: new Map(),
      state: {
        movementLock: 0,
        lockedPosition: null,
        invulnerableTime: 0,
        forcedTargetId: null,
        forcedTargetTime: 0,
        forcedTargetStrength: 0,
        radiusScale: 1,
        radiusScaleTime: 0,
        speedMultiplier: 1,
        speedMultiplierTime: 0,
        slowFactor: 1,
        slowTime: 0,
        poison: null,
        hazardImmune: false,
        frostStacks: 0,
        frostStackTime: 0,
        frozenTime: 0,
      },
    };

    definition.onSpawn?.({
      actor,
      game: this,
      api: this.createSkillApi(actor),
    });

    return actor;
  }

  sampleFreePoint(radius) {
    for (let attempts = 0; attempts < 160; attempts += 1) {
      const point = {
        x: randomBetween(110, WORLD_WIDTH - 110),
        y: randomBetween(85, WORLD_HEIGHT - 85),
      };
      if (!pointInConvexPolygon(point, this.state.arena.points)) {
        continue;
      }
      if (
        this.state.arena.hazards.some(
          (hazard) => distanceToSegment(point, hazard.a, hazard.b) < radius + hazard.depth + 18,
        )
      ) {
        continue;
      }
      if (
        this.state.actors.some(
          (actor) => actor.alive && distance(point, actor.position) < actor.radius + radius + 48,
        )
      ) {
        continue;
      }
      return point;
    }

    return {
      x: WORLD_WIDTH / 2 + randomBetween(-80, 80),
      y: WORLD_HEIGHT / 2 + randomBetween(-80, 80),
    };
  }

  frame(timestamp) {
    if (!this.running) {
      return;
    }

    const dt = Math.min((timestamp - this.lastFrame) / 1000, MAX_DT);
    this.lastFrame = timestamp;
    this.update(dt);
    this.render();
    this.callbacks.onStateChange?.(this.snapshot());
    this.rafId = requestAnimationFrame((nextTimestamp) => this.frame(nextTimestamp));
  }

  snapshot() {
    if (!this.state) {
      return null;
    }
    return {
      elapsed: this.state.elapsed,
      duelTriggered: this.state.duelTriggered,
      matchOver: this.state.matchOver,
      winnerId: this.state.winnerId,
      selectedId: this.state.selectedId,
      duelTime: this.state.settings.duelTime,
      nextPhaseIn: Math.max(0, this.state.settings.duelTime - this.state.elapsed),
      finishOrder: this.state.finishOrder,
      actors: this.state.actors.map((actor) => ({
        id: actor.id,
        characterId: actor.characterId,
        name: actor.name,
        color: actor.color,
        hp: Math.ceil(actor.hp),
        maxHp: actor.stats.maxHp,
        essence: actor.essence,
        maxEssence: actor.stats.maxEssence,
        alive: actor.alive,
        isPlayer: actor.isPlayer,
      })),
    };
  }

  update(dt) {
    const state = this.state;
    if (!state) {
      return;
    }

    if (state.matchOver) {
      this.updateShake(dt);
      this.updateScheduledActions(dt);
      this.updatePulses(dt);
      this.updateParticles(dt);
      this.updateDamageTexts(dt);
      this.updateStrikes(dt);
      return;
    }

    state.elapsed += dt;
    if (!state.duelTriggered && state.elapsed >= state.settings.duelTime) {
      state.duelTriggered = true;
      this.announce("决斗时刻已开启，精元喷涌而出。");
      this.spawnEssenceBurst(6);
    }

    state.nextEssenceIn -= dt;
    const interval = state.duelTriggered ? DUEL_ESSENCE_INTERVAL : BASE_ESSENCE_INTERVAL;
    if (state.nextEssenceIn <= 0) {
      state.nextEssenceIn += interval;
      if (state.essences.length < MAX_ESSENCE_ON_FIELD || state.duelTriggered) {
        this.spawnEssence();
      }
    }

    this.updateShake(dt);
    this.updateScheduledActions(dt);
    this.updateActors(dt);
    this.updateHolySwords(dt);
    this.updateLasers(dt);
    this.resolveActorCollisions();
    this.updateTrails(dt);
    this.updateTurrets(dt);
    this.resolveTurretCollisions();
    this.updateStrikes(dt);
    this.updateBeams(dt);
    this.updateDecoys(dt);
    this.resolveDecoyCollisions();
    this.updateEssences();
    this.updateProjectiles(dt);
    this.updatePulses(dt);
    this.updateParticles(dt);
    this.updateDamageTexts(dt);
    this.checkWinner();
  }

  updateShake(dt) {
    const shake = this.state.shake;
    if (shake.timeLeft > 0) {
      shake.timeLeft -= dt;
      if (shake.timeLeft <= 0) {
        shake.amplitude = 0;
      }
    }
  }

  updateScheduledActions(dt) {
    const snapshot = this.state.scheduledActions;
    this.state.scheduledActions = [];
    const toExecute = [];
    for (const action of snapshot) {
      action.timeLeft -= dt;
      if (action.timeLeft > 0) {
        this.state.scheduledActions.push(action);
      } else {
        toExecute.push(action);
      }
    }
    for (const action of toExecute) {
      action.execute?.();
    }
  }

  updateActors(dt) {
    for (const actor of this.state.actors) {
      if (!actor.alive) {
        continue;
      }

      actor.highlightTime = Math.max(0, actor.highlightTime - dt);
      this.updateActorCooldowns(actor, dt);
      this.updateActorState(actor, dt);
      if (!actor.alive) {
        continue;
      }

      this.tickTrigger(actor, "interval", dt);
      this.tickTrigger(actor, "trail", dt);
      this.tickTrigger(actor, "proximity", dt);

      if (actor.state.movementLock > 0 && actor.state.lockedPosition) {
        actor.position = { ...actor.state.lockedPosition };
        actor.velocity = scale(actor.velocity, Math.max(0, 1 - dt * 18));
        this.applyHazards(actor, dt);
        continue;
      }

      this.applyForcedChase(actor, dt);

      actor.position.x += actor.velocity.x * dt;
      actor.position.y += actor.velocity.y * dt;

      const bounced = this.resolveArenaCollision(actor);
      if (bounced) {
        this.fireTrigger(actor, "onWallBounce", { bounced });
      }

      this.applyHazards(actor, dt);

      const desiredSpeed = this.getEffectiveSpeed(actor);
      const currentSpeed = length(actor.velocity);
      const nextSpeed = lerp(currentSpeed, desiredSpeed, dt * 3);
      actor.velocity = scale(normalize(actor.velocity), Math.max(nextSpeed, desiredSpeed * 0.76));
    }
  }

  updateActorCooldowns(actor, dt) {
    for (const [key, value] of actor.cooldowns.entries()) {
      actor.cooldowns.set(key, value - dt);
    }
  }

  updateActorState(actor, dt) {
    for (const [hazardKey, timer] of actor.hazardTimers.entries()) {
      actor.hazardTimers.set(hazardKey, Math.max(0, timer - dt));
    }

    actor.state.movementLock = Math.max(0, actor.state.movementLock - dt);
    if (actor.state.movementLock <= 0) {
      actor.state.lockedPosition = null;
    }

    actor.state.invulnerableTime = Math.max(0, actor.state.invulnerableTime - dt);
    actor.state.forcedTargetTime = Math.max(0, actor.state.forcedTargetTime - dt);
    actor.state.radiusScaleTime = Math.max(0, actor.state.radiusScaleTime - dt);
    actor.state.speedMultiplierTime = Math.max(0, actor.state.speedMultiplierTime - dt);
    actor.state.slowTime = Math.max(0, actor.state.slowTime - dt);
    actor.state.frostStackTime = Math.max(0, actor.state.frostStackTime - dt);
    actor.state.frozenTime = Math.max(0, actor.state.frozenTime - dt);

    if (actor.state.forcedTargetTime <= 0) {
      actor.state.forcedTargetId = null;
      actor.state.forcedTargetStrength = 0;
    }
    if (actor.state.radiusScaleTime <= 0) {
      actor.state.radiusScale = 1;
    }
    if (actor.state.speedMultiplierTime <= 0) {
      actor.state.speedMultiplier = 1;
    }
    if (actor.state.slowTime <= 0) {
      actor.state.slowFactor = 1;
    }

    actor.radius = actor.baseRadius * actor.state.radiusScale;

    if (actor.state.poison?.timeLeft > 0) {
      actor.state.poison.timeLeft -= dt;
      actor.state.poison.tickTimer -= dt;
      while (actor.state.poison.tickTimer <= 0 && actor.state.poison.timeLeft > 0) {
        actor.state.poison.tickTimer += actor.state.poison.tickInterval;
        const attacker = this.findActorById(actor.state.poison.ownerId);
        this.applyDamage(actor, actor.state.poison.damage, {
          type: "poison",
          color: actor.state.poison.color,
          attacker,
        });
        if (!actor.alive) {
          break;
        }
      }
      if (actor.state.poison.timeLeft <= 0) {
        actor.state.poison = null;
      }
    }
  }

  tickTrigger(actor, type, dt) {
    const triggers = actor.definition.basicAttack?.triggers ?? [];
    for (const trigger of triggers) {
      if (trigger.type !== type) {
        continue;
      }

      const key = this.getTriggerKey(trigger);
      const next = actor.cooldowns.get(key) ?? 0;
      actor.cooldowns.set(key, next);

      if (type === "proximity") {
        const radius = trigger.radius ?? actor.stats.attackRange;
        const enemyInRange = this.getEnemies(actor).some(
          (enemy) => enemy.alive && distance(enemy.position, actor.position) <= radius + enemy.radius,
        );
        if (!enemyInRange) {
          continue;
        }
      }

      if (next <= 0) {
        this.executeBasicAttack(actor, trigger, null);
        actor.cooldowns.set(key, trigger.interval ?? trigger.cooldown ?? 1);
      }
    }
  }

  fireTrigger(actor, type, event) {
    const triggers = actor.definition.basicAttack?.triggers ?? [];
    for (const trigger of triggers) {
      if (trigger.type !== type) {
        continue;
      }

      const key = this.getTriggerKey(trigger);
      const cooldown = actor.cooldowns.get(key) ?? 0;
      if (cooldown > 0) {
        continue;
      }
      this.executeBasicAttack(actor, trigger, event);
      actor.cooldowns.set(key, trigger.cooldown ?? trigger.interval ?? 0.6);
    }
  }

  getTriggerKey(trigger) {
    return `${trigger.type}:${trigger.interval ?? ""}:${trigger.cooldown ?? ""}:${trigger.radius ?? ""}`;
  }

  executeBasicAttack(actor, trigger, event) {
    actor.definition.basicAttack?.execute?.({
      actor,
      trigger,
      event,
      api: this.createSkillApi(actor),
      enemies: this.getEnemies(actor),
      game: this,
    });
  }

  castUltimate(actor) {
    if (!actor.alive || !actor.definition.ultimate?.execute) {
      return;
    }
    actor.highlightTime = 0.45;
    this.announce(`${actor.name} 释放了 ${actor.definition.ultimate.name}。`);
    actor.definition.ultimate.execute({
      actor,
      api: this.createSkillApi(actor),
      enemies: this.getEnemies(actor),
      game: this,
    });
  }

  createSkillApi(actor) {
    return {
      actor,
      normalize,
      add,
      subtract,
      scale,
      distance: (left, right) => distance(left.position ?? left, right.position ?? right),
      findNearestEnemy: (range = actor.stats.attackRange) => this.findNearestEnemy(actor, range),
      findLowestHpEnemy: () => this.findLowestHpEnemy(actor),
      getEnemiesInRange: (range = actor.stats.attackRange) =>
        this.getEnemies(actor).filter(
          (enemy) => enemy.alive && distance(enemy.position, actor.position) <= range + enemy.radius,
        ),
      directionTo: (target) => normalize(subtract(target.position, actor.position)),
      spawnProjectile: (config) => this.spawnProjectile(actor, config),
      spawnPulse: (config) => this.spawnPulse(actor, config),
      createTrail: (config) => this.createTrail(actor, config),
      explodeOwnedTrails: (config) => this.explodeOwnedTrails(actor, config),
      spawnStrike: (config) => this.spawnStrike(actor, config),
      summonTurret: (config) => this.spawnTurret(actor, config),
      upgradeTurrets: (config) => this.upgradeTurrets(actor, config),
      dealDamage: (target, amount, options = {}) =>
        this.applyDamage(target, amount, { ...options, attacker: actor }),
      heal: (amount) => this.healActor(actor, amount),
      shake: (amount, duration) => this.shake(amount, duration),
      emitText: (text, position, color = "#ff6f69") =>
        this.spawnDamageText({
          text,
          position,
          color,
          velocityY: -28,
          lifetime: 0.8,
          size: 16,
        }),
      schedule: (delay, callback) =>
        this.scheduleAction(delay, () =>
          callback({
            actor,
            api: this.createSkillApi(actor),
            game: this,
          }),
        ),
      announce: (message) => this.announce(message),
      lockMovement: (duration) => this.lockActorMovement(actor, duration),
      grantInvulnerable: (duration) => {
        actor.state.invulnerableTime = Math.max(actor.state.invulnerableTime, duration);
      },
      setRadiusScale: (scaleValue, duration) => {
        actor.state.radiusScale = scaleValue;
        actor.state.radiusScaleTime = Math.max(actor.state.radiusScaleTime, duration);
        actor.radius = actor.baseRadius * actor.state.radiusScale;
      },
      setSpeedMultiplier: (multiplier, duration) => {
        actor.state.speedMultiplier = multiplier;
        actor.state.speedMultiplierTime = Math.max(actor.state.speedMultiplierTime, duration);
      },
      forceChase: (target, duration, strength = 5.2) => {
        if (!target) {
          return;
        }
        actor.state.forcedTargetId = target.id;
        actor.state.forcedTargetTime = Math.max(actor.state.forcedTargetTime, duration);
        actor.state.forcedTargetStrength = strength;
      },
      isPoisoned: (target, ownerId = actor.id) => this.isActorPoisonedBy(target, ownerId),
      createDrainBeam: (config) => this.spawnBeam(actor, config),
      spawnDecoy: (config) => this.spawnDecoy(actor, config),
      activateDecoys: (config) => this.activateDecoys(actor, config),
      spawnLaser: (config) => this.spawnLaser(actor, config),
      applyFrost: (target, options) => this.applyFrostStack(actor, target, options),
      forceFreezeTarget: (target, duration) => {
        if (!target.alive) return;
        target.state.frozenTime = Math.max(target.state.frozenTime, duration);
        this.lockActorMovement(target, duration);
      },
    };
  }

  scheduleAction(delay, execute) {
    this.state.scheduledActions.push({
      id: Math.random().toString(16).slice(2),
      timeLeft: delay,
      execute,
    });
  }

  lockActorMovement(actor, duration) {
    actor.state.movementLock = Math.max(actor.state.movementLock, duration);
    actor.state.lockedPosition = { ...actor.position };
    actor.velocity = { x: 0, y: 0 };
  }

  getEffectiveSpeed(actor) {
    let multiplier = 1;
    if (actor.state.slowTime > 0) {
      multiplier *= actor.state.slowFactor;
    }
    if (actor.state.speedMultiplierTime > 0) {
      multiplier *= actor.state.speedMultiplier;
    }
    return actor.stats.speed * multiplier;
  }

  applyForcedChase(actor, dt) {
    if (actor.state.forcedTargetTime <= 0) {
      return;
    }
    let target = this.findActorById(actor.state.forcedTargetId);
    if (!target?.alive) {
      target = this.findLowestHpEnemy(actor);
      actor.state.forcedTargetId = target?.id ?? null;
    }
    if (!target) {
      return;
    }

    const desiredDirection = normalize(subtract(target.position, actor.position));
    const steer = actor.state.forcedTargetStrength || 5.2;
    const steerWeight = clamp(dt * steer, 0, 0.92);
    const currentDirection = normalize(actor.velocity);
    const blended = normalize({
      x: lerp(currentDirection.x, desiredDirection.x, steerWeight),
      y: lerp(currentDirection.y, desiredDirection.y, steerWeight),
    });
    const speed = Math.max(length(actor.velocity), this.getEffectiveSpeed(actor) * 0.92);
    actor.velocity = scale(blended, speed);
  }

  resolveArenaCollision(entity) {
    let bounced = false;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let index = 0; index < this.state.arena.points.length; index += 1) {
        const current = this.state.arena.points[index];
        const next = this.state.arena.points[(index + 1) % this.state.arena.points.length];
        const edge = subtract(next, current);
        const inward = normalize({ x: -edge.y, y: edge.x });
        const distanceToEdge = dot(subtract(entity.position, current), inward);
        if (distanceToEdge < entity.radius) {
          const overlap = entity.radius - distanceToEdge + 0.4;
          entity.position = add(entity.position, scale(inward, overlap));
          if (dot(entity.velocity, inward) < 0) {
            entity.velocity = reflect(entity.velocity, inward);
            bounced = true;
          }
        }
      }

      for (const wall of this.state.arena.walls) {
        const nearest = closestPointOnSegment(entity.position, wall.a, wall.b);
        const delta = subtract(entity.position, nearest);
        const gap = length(delta);
        const limit = entity.radius + wall.thickness / 2;
        if (gap < limit) {
          const normal =
            gap > 0.001
              ? scale(delta, 1 / gap)
              : normalize({ x: wall.a.y - wall.b.y, y: wall.b.x - wall.a.x });
          entity.position = add(entity.position, scale(normal, limit - gap + 0.4));
          if (dot(entity.velocity, normal) < 0) {
            entity.velocity = reflect(entity.velocity, normal);
            bounced = true;
          }
        }
      }
    }
    return bounced;
  }

  applyHazards(actor, dt) {
    if (actor.state.hazardImmune) {
      return;
    }

    this.state.arena.hazards.forEach((hazard, index) => {
      const distanceFromEdge = distanceToSegment(actor.position, hazard.a, hazard.b);
      if (distanceFromEdge > actor.radius + hazard.depth * 0.7) {
        return;
      }
      const key = `hazard:${index}`;
      const timer = actor.hazardTimers.get(key) ?? 0;
      if (timer > 0) {
        return;
      }
      actor.hazardTimers.set(key, 0.45);
      actor.velocity = add(actor.velocity, scale(hazard.normal, 42));
      this.applyDamage(actor, hazard.contactDamage, {
        type: "hazard",
        color: "#ff5f59",
      });
    });
  }

  resolveActorCollisions() {
    const aliveActors = this.state.actors.filter((actor) => actor.alive);
    for (let leftIndex = 0; leftIndex < aliveActors.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < aliveActors.length; rightIndex += 1) {
        const left = aliveActors[leftIndex];
        const right = aliveActors[rightIndex];
        const delta = subtract(right.position, left.position);
        const gap = length(delta);
        const minGap = left.radius + right.radius;
        if (!gap || gap >= minGap) {
          continue;
        }

        const normal = scale(delta, 1 / gap);
        const overlap = minGap - gap;
        const leftAnchored = this.isActorAnchored(left);
        const rightAnchored = this.isActorAnchored(right);

        if (leftAnchored && !rightAnchored) {
          right.position = add(right.position, scale(normal, overlap + 0.2));
        } else if (!leftAnchored && rightAnchored) {
          left.position = add(left.position, scale(normal, -overlap - 0.2));
        } else {
          left.position = add(left.position, scale(normal, -overlap / 2));
          right.position = add(right.position, scale(normal, overlap / 2));
        }

        const relative = subtract(left.velocity, right.velocity);
        const closingSpeed = dot(relative, normal);
        if (closingSpeed < 0) {
          if (leftAnchored && !rightAnchored) {
            right.velocity = reflect(right.velocity, normal);
          } else if (!leftAnchored && rightAnchored) {
            left.velocity = reflect(left.velocity, scale(normal, -1));
          } else {
            const impulse = ((1 + 0.95) * -closingSpeed) / 2;
            left.velocity = add(left.velocity, scale(normal, impulse));
            right.velocity = add(right.velocity, scale(normal, -impulse));
          }
        }

        this.fireTrigger(left, "collision", { other: right, normal });
        this.fireTrigger(right, "collision", {
          other: left,
          normal: scale(normal, -1),
        });
      }
    }
  }

  isActorAnchored(actor) {
    return actor.state.movementLock > 0;
  }

  spawnEssence() {
    const position = this.sampleEssencePoint();
    this.state.essences.push({
      id: Math.random().toString(16).slice(2),
      position,
      radius: 10,
      pulse: randomBetween(0, Math.PI * 2),
    });
  }

  sampleEssencePoint() {
    const center = this.state.arena.center;
    for (let attempts = 0; attempts < 120; attempts += 1) {
      const point = {
        x: center.x + randomBetween(-140, 140),
        y: center.y + randomBetween(-95, 95),
      };
      if (!pointInConvexPolygon(point, this.state.arena.points)) {
        continue;
      }
      if (
        this.state.arena.hazards.some(
          (hazard) => distanceToSegment(point, hazard.a, hazard.b) < hazard.depth + 24,
        )
      ) {
        continue;
      }
      if (
        this.state.arena.walls.some((wall) => {
          const clearance = wall.thickness / 2 + 18;
          return distanceToSegment(point, wall.a, wall.b) < clearance;
        })
      ) {
        continue;
      }
      return point;
    }
    return { x: center.x, y: center.y };
  }

  spawnEssenceBurst(count) {
    for (let index = 0; index < count; index += 1) {
      this.spawnEssence();
    }
  }

  updateEssences() {
    this.state.essences = this.state.essences.filter((essence) => {
      for (const actor of this.state.actors) {
        if (!actor.alive) {
          continue;
        }
        if (distance(actor.position, essence.position) <= actor.radius + essence.radius) {
          actor.essence += 1;
          actor.highlightTime = 0.15;
          this.spawnDamageText({
            text: "+1 精元",
            position: actor.position,
            color: "#ffe17f",
            velocityY: -26,
            lifetime: 0.8,
            size: 15,
          });
          if (actor.essence >= actor.stats.maxEssence) {
            actor.essence = 0;
            this.castUltimate(actor);
          }
          return false;
        }
      }
      return true;
    });
  }

  spawnProjectile(owner, config) {
    const direction = normalize(config.direction ?? owner.velocity ?? { x: 1, y: 0 });
    const speed = config.speed ?? 320;
    const projectile = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      position: { ...(config.position ?? owner.position) },
      velocity: scale(direction, speed),
      radius: (config.radius ?? 5) * GAME_SCALE,
      damage: config.damage ?? 8,
      lifetime: config.lifetime ?? 2,
      color: config.color ?? owner.color,
      bounces: config.bounces ?? 0,
      knockback: config.knockback ?? 90,
      remainingHits: (config.pierce ?? 0) + 1,
      hitIds: new Set(),
      shape: config.shape ?? "orb",
      length: (config.length ?? Math.max((config.radius ?? 5) * 2.2, 8)) * GAME_SCALE,
      frostConfig: config.frostConfig ?? null,
    };
    this.state.projectiles.push(projectile);
    return projectile;
  }

  updateProjectiles(dt) {
    this.state.projectiles = this.state.projectiles.filter((projectile) => {
      projectile.position.x += projectile.velocity.x * dt;
      projectile.position.y += projectile.velocity.y * dt;
      projectile.lifetime -= dt;

      const before = projectile.bounces;
      const bounced = this.resolveArenaCollision(projectile);
      if (bounced && before !== Infinity) {
        projectile.bounces -= 1;
      }
      if (projectile.bounces < 0 || projectile.lifetime <= 0) {
        return false;
      }

      for (const actor of this.state.actors) {
        if (!actor.alive || actor.id === projectile.ownerId || projectile.hitIds.has(actor.id)) {
          continue;
        }
        if (distance(actor.position, projectile.position) > actor.radius + projectile.radius) {
          continue;
        }

        projectile.hitIds.add(actor.id);
        actor.velocity = add(
          actor.velocity,
          scale(normalize(projectile.velocity), projectile.knockback),
        );
        const attacker = this.findActorById(projectile.ownerId);
        this.applyDamage(actor, projectile.damage, {
          type: "skill",
          color: projectile.color,
          attacker,
        });
        if (projectile.frostConfig && actor.alive) {
          this.applyFrostStack(attacker, actor, projectile.frostConfig);
        }
        projectile.remainingHits -= 1;
        if (projectile.remainingHits <= 0) {
          return false;
        }
      }
      return true;
    });
  }

  spawnPulse(owner, config) {
    const pulse = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      position: { ...(config.position ?? owner.position) },
      radius: (config.radius ?? 100) * GAME_SCALE,
      lifetime: config.lifetime ?? 0.35,
      maxLifetime: config.lifetime ?? 0.35,
      color: config.color ?? owner.color,
      lineWidth: config.lineWidth ?? 6,
    };

    this.state.pulses.push(pulse);
    this.shake(config.shake ?? 12, 0.22);

    for (const actor of this.getEnemies(owner)) {
      if (!actor.alive) {
        continue;
      }
      if (distance(actor.position, pulse.position) > pulse.radius + actor.radius) {
        continue;
      }
      if (config.requireLineOfSight && !this.hasLineOfSight(pulse.position, actor.position)) {
        continue;
      }

      actor.velocity = add(
        actor.velocity,
        scale(normalize(subtract(actor.position, pulse.position)), config.knockback ?? 180),
      );
      this.applyDamage(actor, config.damage ?? 12, {
        type: "skill",
        color: pulse.color,
        attacker: owner,
      });
    }
    return pulse;
  }

  updatePulses(dt) {
    this.state.pulses = this.state.pulses.filter((pulse) => {
      pulse.lifetime -= dt;
      return pulse.lifetime > 0;
    });
  }

  createTrail(owner, config) {
    const trail = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      position: { ...(config.position ?? owner.position) },
      radius: (config.radius ?? 16) * GAME_SCALE,
      lifetime: config.lifetime ?? 2,
      maxLifetime: config.lifetime ?? 2,
      color: config.color ?? owner.color,
      pulse: randomBetween(0, Math.PI * 2),
      poisonDuration: config.poisonDuration ?? 1,
      poisonDamage: config.poisonDamage ?? 1,
      tickInterval: config.tickInterval ?? 0.5,
      slowFactor: config.slowFactor ?? 0.7,
      slowDuration: config.slowDuration ?? 0.55,
    };
    this.state.trails.push(trail);
    return trail;
  }

  updateTrails(dt) {
    this.state.trails = this.state.trails.filter((trail) => {
      trail.lifetime -= dt;
      if (trail.lifetime <= 0) {
        return false;
      }

      for (const actor of this.state.actors) {
        if (!actor.alive || actor.id === trail.ownerId) {
          continue;
        }
        if (distance(actor.position, trail.position) > actor.radius + trail.radius) {
          continue;
        }
        const owner = this.findActorById(trail.ownerId);
        this.applyPoison(actor, owner, trail);
      }

      return true;
    });
  }

  applyPoison(target, owner, trail) {
    target.state.slowFactor = Math.min(target.state.slowFactor, trail.slowFactor);
    target.state.slowTime = Math.max(target.state.slowTime, trail.slowDuration);
    target.state.poison = {
      ownerId: owner?.id ?? trail.ownerId,
      timeLeft: Math.max(target.state.poison?.timeLeft ?? 0, trail.poisonDuration),
      tickTimer: Math.min(target.state.poison?.tickTimer ?? trail.tickInterval, trail.tickInterval),
      tickInterval: trail.tickInterval,
      damage: trail.poisonDamage,
      color: trail.color,
    };
  }

  explodeOwnedTrails(owner, config = {}) {
    const owned = this.state.trails.filter((trail) => trail.ownerId === owner.id);
    if (!owned.length) {
      return 0;
    }

    owned.forEach((trail) => {
      this.state.pulses.push({
        id: Math.random().toString(16).slice(2),
        ownerId: owner.id,
        position: { ...trail.position },
        radius: config.pulseRadius ?? trail.radius * 1.8,
        lifetime: 0.22,
        maxLifetime: 0.22,
        color: config.pulseColor ?? trail.color,
        lineWidth: 4,
      });
      for (let index = 0; index < 6; index += 1) {
        const direction = randomUnit();
        this.state.particles.push({
          position: { ...trail.position },
          velocity: scale(direction, randomBetween(40, 120)),
          lifetime: randomBetween(0.2, 0.45),
          color: config.pulseColor ?? trail.color,
          size: randomBetween(2, 5),
        });
      }
    });

    this.state.trails = this.state.trails.filter((trail) => trail.ownerId !== owner.id);

    let damaged = 0;
    for (const enemy of this.getEnemies(owner)) {
      if (!enemy.alive || !this.isActorPoisonedBy(enemy, owner.id)) {
        continue;
      }
      damaged += 1;
      this.applyDamage(enemy, config.poisonedDamage ?? 10, {
        type: "skill",
        color: config.pulseColor ?? owner.color,
        attacker: owner,
      });
    }

    return damaged || owned.length;
  }

  isActorPoisonedBy(actor, ownerId) {
    return !!(actor.state.poison?.timeLeft > 0 && actor.state.poison.ownerId === ownerId);
  }

  spawnTurret(owner, config) {
    const current = this.state.turrets.filter((turret) => turret.ownerId === owner.id);
    if (current.length >= (config.maxCount ?? 3)) {
      return null;
    }

    const turret = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      position: { ...(config.position ?? owner.position) },
      radius: (config.radius ?? 15) * GAME_SCALE,
      level: 1,
      color: config.color ?? owner.color,
      projectileColor: config.projectileColor ?? config.color ?? owner.color,
      fireInterval: config.fireInterval ?? 1.2,
      fireCooldown: randomBetween(0.15, config.fireInterval ?? 1.2),
      damage: config.damage ?? 5,
      range: (config.range ?? 240) * GAME_SCALE,
      maxHits: config.maxHits ?? 2,
      hitsTaken: 0,
      contactTimers: new Map(),
      muzzleFlash: 0,
    };

    this.state.turrets.push(turret);
    this.spawnDamageText({
      text: "炮台",
      position: turret.position,
      color: turret.color,
      velocityY: -18,
      lifetime: 0.65,
      size: 14,
    });
    return turret;
  }

  upgradeTurrets(owner, config) {
    const turrets = this.state.turrets.filter((turret) => turret.ownerId === owner.id);
    turrets.forEach((turret) => {
      turret.level = 2;
      turret.damage = config.damage ?? turret.damage;
      turret.fireInterval *= config.fireIntervalMultiplier ?? 0.5;
      turret.maxHits = Math.max(turret.maxHits, config.maxHits ?? turret.maxHits);
      turret.color = config.color ?? turret.color;
      turret.projectileColor = config.projectileColor ?? turret.projectileColor;
      turret.fireCooldown = Math.min(turret.fireCooldown, turret.fireInterval);
      this.spawnDamageText({
        text: "升级",
        position: turret.position,
        color: turret.color,
        velocityY: -18,
        lifetime: 0.65,
        size: 14,
      });
    });
    return turrets.length;
  }

  updateTurrets(dt) {
    this.state.turrets = this.state.turrets.filter((turret) => {
      turret.muzzleFlash = Math.max(0, turret.muzzleFlash - dt);
      for (const [actorId, timer] of turret.contactTimers.entries()) {
        turret.contactTimers.set(actorId, Math.max(0, timer - dt));
      }

      turret.fireCooldown -= dt;
      if (turret.fireCooldown <= 0) {
        const target = this.findNearestHostileToPoint(turret.ownerId, turret.position, turret.range);
        if (target) {
          const owner = this.findActorById(turret.ownerId) ?? {
            id: turret.ownerId,
            position: turret.position,
            velocity: { x: 0, y: 0 },
            color: turret.color,
          };
          const direction = normalize(subtract(target.position, turret.position));
          this.spawnProjectile(owner, {
            position: add(turret.position, scale(direction, turret.radius - 1)),
            direction,
            speed: turret.level >= 2 ? 360 : 320,
            radius: turret.level >= 2 ? 4.8 : 4,
            damage: turret.damage,
            color: turret.projectileColor,
            lifetime: 1.8,
            bounces: 0,
            knockback: turret.level >= 2 ? 95 : 72,
            shape: "bolt",
            length: turret.level >= 2 ? 14 : 11,
          });
          turret.fireCooldown = turret.fireInterval;
          turret.muzzleFlash = 0.1;
        } else {
          turret.fireCooldown = Math.max(0.2, turret.fireInterval * 0.45);
        }
      }

      return turret.hitsTaken < turret.maxHits;
    });
  }

  resolveTurretCollisions() {
    for (const turret of this.state.turrets) {
      for (const actor of this.state.actors) {
        if (!actor.alive || actor.id === turret.ownerId) {
          continue;
        }
        const delta = subtract(actor.position, turret.position);
        const gap = length(delta);
        const minGap = actor.radius + turret.radius;
        if (!gap || gap >= minGap) {
          continue;
        }

        const normal = scale(delta, 1 / gap);
        actor.position = add(turret.position, scale(normal, minGap + 0.2));
        if (dot(actor.velocity, normal) < 0) {
          actor.velocity = reflect(actor.velocity, normal);
        }

        const contactCooldown = turret.contactTimers.get(actor.id) ?? 0;
        if (contactCooldown > 0) {
          continue;
        }

        turret.contactTimers.set(actor.id, 0.35);
        turret.hitsTaken += 1;
        this.spawnDamageText({
          text: "-1 结构",
          position: turret.position,
          color: "#ffd8ab",
          velocityY: -18,
          lifetime: 0.6,
          size: 13,
        });
        this.shake(5, 0.08);
      }
    }

    const before = this.state.turrets.length;
    this.state.turrets = this.state.turrets.filter((turret) => {
      if (turret.hitsTaken < turret.maxHits) {
        return true;
      }
      this.spawnTurretBreak(turret);
      return false;
    });

    if (before !== this.state.turrets.length) {
      this.announce("炮台被撞毁。");
    }
  }

  spawnTurretBreak(turret) {
    for (let index = 0; index < 10; index += 1) {
      const direction = randomUnit();
      this.state.particles.push({
        position: { ...turret.position },
        velocity: scale(direction, randomBetween(35, 120)),
        lifetime: randomBetween(0.25, 0.55),
        color: index % 2 === 0 ? turret.color : "#ffe2b8",
        size: randomBetween(2, 5),
      });
    }
  }

  spawnStrike(owner, config) {
    const strike = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      position: { ...(config.position ?? owner.position) },
      radius: (config.radius ?? 28) * GAME_SCALE,
      damage: config.damage ?? 30,
      delay: config.delay ?? 1,
      maxDelay: config.delay ?? 1,
      flashTime: 0,
      maxFlashTime: 0.18,
      resolved: false,
      color: config.color ?? owner.color,
      strikeType: config.strikeType ?? "bomb",
      lightningPath: null,
    };
    this.state.strikes.push(strike);
    return strike;
  }

  updateStrikes(dt) {
    this.state.strikes = this.state.strikes.filter((strike) => {
      if (!strike.resolved) {
        strike.delay -= dt;
        if (strike.delay <= 0) {
          this.resolveStrike(strike);
        }
        return true;
      }

      strike.flashTime -= dt;
      return strike.flashTime > 0;
    });
  }

  resolveStrike(strike) {
    strike.resolved = true;
    strike.maxFlashTime = strike.strikeType === "lightning" ? 0.42 : 0.22;
    strike.flashTime = strike.maxFlashTime;
    this.shake(18, 0.22);

    const owner = this.findActorById(strike.ownerId);
    for (const actor of this.state.actors) {
      if (!actor.alive || actor.id === strike.ownerId) {
        continue;
      }
      if (distance(actor.position, strike.position) > actor.radius + strike.radius) {
        continue;
      }
      this.applyDamage(actor, strike.damage, {
        type: "skill",
        color: strike.color,
        attacker: owner,
      });
    }

    if (strike.strikeType === "lightning") {
      // Generate jagged bolt path from top of screen to impact point
      const cx = strike.position.x;
      const cy = strike.position.y;
      const segments = 13;
      const path = [{ x: cx + randomBetween(-14, 14), y: 0 }];
      for (let s = 1; s < segments; s++) {
        const t = s / segments;
        path.push({ x: cx + randomBetween(-36, 36) * (1 - t * 0.55), y: cy * t });
      }
      path.push({ x: cx, y: cy });
      strike.lightningPath = path;

      // Electric arc sparks at impact
      const arcColors = ["#ffffff", "#ddf6ff", "#88ccff", "#4499ff", "#6688ff"];
      for (let i = 0; i < 38; i += 1) {
        const dir = randomUnit();
        const speed = randomBetween(120, 420);
        this.state.particles.push({
          position: { ...strike.position },
          velocity: { x: dir.x * speed, y: dir.y * speed },
          lifetime: randomBetween(0.08, 0.3),
          color: arcColors[Math.floor(Math.random() * arcColors.length)],
          size: randomBetween(1.5, 4.5),
        });
      }
      // Scattered secondary sparks along bolt path
      for (let i = 0; i < 14; i += 1) {
        const pt = path[Math.floor(Math.random() * path.length)];
        const dir = randomUnit();
        this.state.particles.push({
          position: { x: pt.x + randomBetween(-4, 4), y: pt.y + randomBetween(-4, 4) },
          velocity: { x: dir.x * randomBetween(30, 100), y: dir.y * randomBetween(30, 100) },
          lifetime: randomBetween(0.1, 0.28),
          color: i % 2 === 0 ? "#ffffff" : "#aaddff",
          size: randomBetween(1, 3),
        });
      }
    } else {
      const fireColors = ["#ffffff", "#ffffa0", "#ffcc44", "#ff8822", "#ff4400", "#cc2200"];
      for (let index = 0; index < 42; index += 1) {
        const direction = randomUnit();
        const speed = randomBetween(60, 240);
        this.state.particles.push({
          position: { ...strike.position },
          velocity: {
            x: direction.x * speed,
            y: direction.y * speed * randomBetween(0.5, 1.0),
          },
          lifetime: randomBetween(0.22, 0.65),
          color: fireColors[Math.floor(Math.random() * fireColors.length)],
          size: randomBetween(2.5, 7),
        });
      }
      // Smoke / debris ring at larger radius
      for (let index = 0; index < 14; index += 1) {
        const direction = randomUnit();
        this.state.particles.push({
          position: {
            x: strike.position.x + direction.x * strike.radius * randomBetween(0.4, 0.85),
            y: strike.position.y + direction.y * strike.radius * randomBetween(0.4, 0.85),
          },
          velocity: {
            x: direction.x * randomBetween(20, 80),
            y: direction.y * randomBetween(20, 80) - 30,
          },
          lifetime: randomBetween(0.3, 0.7),
          color: index % 2 === 0 ? "#994422" : "#665533",
          size: randomBetween(4, 9),
        });
      }
    }
  }

  hasLineOfSight(from, to) {
    return !this.state.arena.walls.some((wall) => segmentsIntersect(from, to, wall.a, wall.b));
  }

  findNearestHostileToPoint(ownerId, point, range = Infinity) {
    let nearest = null;
    let bestDistance = range;
    for (const actor of this.state.actors) {
      if (!actor.alive || actor.id === ownerId) {
        continue;
      }
      const currentDistance = distance(point, actor.position);
      if (currentDistance < bestDistance) {
        bestDistance = currentDistance;
        nearest = actor;
      }
    }
    return nearest;
  }

  updateParticles(dt) {
    this.state.particles = this.state.particles.filter((particle) => {
      particle.position = add(particle.position, scale(particle.velocity, dt));
      particle.velocity = scale(particle.velocity, 1 - dt * 1.2);
      particle.lifetime -= dt;
      return particle.lifetime > 0;
    });
  }

  spawnDamageText(config) {
    this.state.damageTexts.push({
      position: { ...config.position },
      text: config.text,
      color: config.color ?? "#ff5f59",
      velocityY: config.velocityY ?? -35,
      lifetime: config.lifetime ?? 0.7,
      size: config.size ?? 18,
    });
  }

  updateDamageTexts(dt) {
    this.state.damageTexts = this.state.damageTexts.filter((entry) => {
      entry.position.y += entry.velocityY * dt;
      entry.lifetime -= dt;
      return entry.lifetime > 0;
    });
  }

  applyDamage(target, amount, options = {}) {
    if (!target.alive) {
      return false;
    }
    if (target.state?.invulnerableTime > 0) {
      return false;
    }

    const rounded = Math.max(1, Math.round(amount));
    target.hp = Math.max(0, target.hp - rounded);
    target.highlightTime = 0.18;
    this.spawnDamageText({
      text: `-${rounded}`,
      position: target.position,
      color: options.color ?? "#ff5f59",
      velocityY: -32,
      lifetime: 0.76,
      size: rounded >= 20 ? 24 : 18,
    });

    if (rounded >= 18) {
      this.shake(14, 0.2);
    }

    if (target.hp <= 0) {
      this.killActor(target, options.attacker);
    }
    return true;
  }

  healActor(actor, amount) {
    if (!actor.alive) {
      return 0;
    }
    const nextHp = clamp(actor.hp + amount, 0, actor.stats.maxHp);
    const gained = nextHp - actor.hp;
    actor.hp = nextHp;
    if (gained > 0) {
      this.spawnDamageText({
        text: `+${Math.round(gained)}`,
        position: actor.position,
        color: "#ffe8c5",
        velocityY: -26,
        lifetime: 0.72,
        size: 16,
      });
    }
    return gained;
  }

  killActor(target, attacker) {
    if (!target.alive) {
      return;
    }
    target.alive = false;
    target.hp = 0;
    this.state.deathOrder.push({ id: target.id, characterId: target.characterId, name: target.name, color: target.color });
    this.announce(
      attacker ? `${target.name} 被 ${attacker.name} 处决。` : `${target.name} 被淘汰。`,
    );
    this.shake(24, 0.45);
    this.spawnDeathBurst(target);
    target.definition?.onDeath?.({
      actor: target,
      attacker,
      game: this,
      api: this.createSkillApi(target),
    });

    attacker?.definition?.onKill?.({
      actor: attacker,
      target,
      game: this,
      api: this.createSkillApi(attacker),
    });
  }

  spawnDeathBurst(target) {
    for (let index = 0; index < 28; index += 1) {
      const direction = randomUnit();
      this.state.particles.push({
        position: { ...target.position },
        velocity: scale(direction, randomBetween(65, 240)),
        lifetime: randomBetween(0.45, 0.95),
        color: index % 2 === 0 ? target.color : "#fff4d7",
        size: randomBetween(3, 7),
      });
    }
  }

  findActorById(id) {
    return this.state.actors.find((actor) => actor.id === id);
  }

  findNearestEnemy(actor, range = Infinity) {
    let nearest = null;
    let bestDistance = range;
    for (const enemy of this.getEnemies(actor)) {
      if (!enemy.alive) {
        continue;
      }
      const currentDistance = distance(actor.position, enemy.position);
      if (currentDistance < bestDistance) {
        bestDistance = currentDistance;
        nearest = enemy;
      }
    }
    return nearest;
  }

  findLowestHpEnemy(actor) {
    let target = null;
    for (const enemy of this.getEnemies(actor)) {
      if (!enemy.alive) {
        continue;
      }
      if (!target || enemy.hp < target.hp) {
        target = enemy;
      }
    }
    return target;
  }

  getEnemies(actor) {
    return this.state.actors.filter((entry) => entry.id !== actor.id);
  }

  shake(amplitude, duration) {
    this.state.shake = {
      amplitude: Math.max(this.state.shake.amplitude, amplitude),
      duration,
      timeLeft: duration,
    };
  }

  announce(message) {
    const stamp = formatTime(this.state?.elapsed ?? 0);
    this.state?.announcements?.push({ id: Math.random().toString(16).slice(2), stamp, message });
    if (this.state?.announcements?.length > 8) {
      this.state.announcements.shift();
    }
    this.callbacks.onAnnouncement?.({ stamp, message });
  }

  checkWinner() {
    if (this.state.matchOver) {
      return;
    }
    const alive = this.state.actors.filter((actor) => actor.alive);
    if (alive.length > 1) {
      return;
    }

    this.state.matchOver = true;
    this.state.winnerId = alive[0]?.id ?? null;

    // Build finish order: winner first, then deaths in reverse (last-dead = 2nd)
    const reversedDeaths = [...this.state.deathOrder].reverse();
    if (alive[0]) {
      this.state.finishOrder = [
        { id: alive[0].id, characterId: alive[0].characterId, name: alive[0].name, color: alive[0].color },
        ...reversedDeaths,
      ];
      alive[0].highlightTime = 999;
      this.announce(`${alive[0].name} 获胜。`);
    } else {
      this.state.finishOrder = reversedDeaths;
      this.announce("所有角色同时出局，本局无胜者。");
    }
    this.callbacks.onMatchEnd?.(this.snapshot());
  }

  render() {
    const ctx = this.ctx;
    const state = this.state;
    if (!state) {
      return;
    }

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const offsetX = 0;
    const offsetY = 0;
    const scaleX = this.canvas.width / WORLD_WIDTH;
    const scaleY = this.canvas.height / WORLD_HEIGHT;

    ctx.save();
    ctx.scale(scaleX, scaleY);
    ctx.translate(offsetX, offsetY);

    this.renderBackground(ctx, state);
    this.renderArena(ctx, state.arena);
    this.renderHazards(ctx, state);
    this.renderTrails(ctx, state);
    this.renderEssences(ctx, state);
    this.renderStrikes(ctx, state);
    this.renderTurrets(ctx, state);
    this.renderDecoys(ctx, state);
    this.renderProjectiles(ctx, state);
    this.renderPulses(ctx, state);
    this.renderBeams(ctx, state);
    this.renderLasers(ctx, state);
    this.renderActors(ctx, state);
    this.renderParticles(ctx, state);
    this.renderDamageTexts(ctx, state);

    ctx.restore();
  }

  renderBackground(ctx, state) {
    ctx.fillStyle = "#080808";
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= WORLD_WIDTH; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_WIDTH, y);
      ctx.stroke();
    }
    ctx.restore();

    const glow = ctx.createRadialGradient(
      state.arena.center.x,
      state.arena.center.y,
      0,
      state.arena.center.x,
      state.arena.center.y,
      240,
    );
    glow.addColorStop(0, "rgba(255, 255, 255, 0.06)");
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  }

  renderArena(ctx, arena) {
    ctx.save();
    ctx.beginPath();
    arena.points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.closePath();

    const fill = ctx.createLinearGradient(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    fill.addColorStop(0, "rgba(58, 58, 58, 0.2)");
    fill.addColorStop(1, "rgba(18, 18, 18, 0.46)");
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.strokeStyle = "rgba(236, 236, 236, 0.74)";
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.lineCap = "round";
    for (const wall of arena.walls) {
      ctx.strokeStyle = "rgba(235, 235, 235, 0.34)";
      ctx.lineWidth = wall.thickness + 3;
      ctx.beginPath();
      ctx.moveTo(wall.a.x, wall.a.y);
      ctx.lineTo(wall.b.x, wall.b.y);
      ctx.stroke();

      ctx.strokeStyle = "rgba(28, 28, 28, 0.92)";
      ctx.lineWidth = wall.thickness;
      ctx.beginPath();
      ctx.moveTo(wall.a.x, wall.a.y);
      ctx.lineTo(wall.b.x, wall.b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderHazards(ctx, state) {
    const time = state.elapsed;
    for (const hazard of state.arena.hazards) {
      ctx.save();
      const pulse = (Math.sin(time * 3.2 + hazard.phase) + 1) * 0.5;
      const segment = subtract(hazard.b, hazard.a);
      const step = scale(segment, 1 / hazard.spikeCount);

      ctx.strokeStyle = `rgba(255, 118, 92, ${0.7 + pulse * 0.18})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(hazard.a.x, hazard.a.y);
      ctx.lineTo(hazard.b.x, hazard.b.y);
      ctx.stroke();

      for (let index = 0; index < hazard.spikeCount; index += 1) {
        const baseA = add(hazard.a, scale(step, index));
        const baseB = add(hazard.a, scale(step, index + 1));
        const mid = scale(add(baseA, baseB), 0.5);
        const tip = add(mid, scale(hazard.normal, hazard.depth + pulse * 2.5));

        ctx.fillStyle = `rgba(255, 88, 68, ${0.35 + pulse * 0.22})`;
        ctx.strokeStyle = `rgba(255, 180, 154, ${0.3 + pulse * 0.2})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(baseA.x, baseA.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(baseB.x, baseB.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  renderTrails(ctx, state) {
    for (const trail of state.trails) {
      const life = trail.lifetime / trail.maxLifetime;
      const pulse = (Math.sin(state.elapsed * 4 + trail.pulse) + 1) * 0.5;
      ctx.save();
      ctx.globalAlpha = clamp(0.25 + life * 0.35, 0, 1);
      ctx.fillStyle = trail.color;
      ctx.beginPath();
      ctx.arc(trail.position.x, trail.position.y, trail.radius + pulse * 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = clamp(0.18 + life * 0.22, 0, 1);
      ctx.fillStyle = "rgba(20, 30, 10, 0.65)";
      ctx.beginPath();
      ctx.arc(trail.position.x, trail.position.y, trail.radius * 0.48, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  renderEssences(ctx, state) {
    for (const essence of state.essences) {
      const pulse = (Math.sin(state.elapsed * 4 + essence.pulse) + 1) * 0.5;
      ctx.save();
      ctx.fillStyle = `rgba(255, 230, 134, ${0.4 + pulse * 0.3})`;
      ctx.beginPath();
      ctx.arc(essence.position.x, essence.position.y, essence.radius + pulse * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff5c2";
      ctx.beginPath();
      ctx.arc(essence.position.x, essence.position.y, essence.radius * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  renderStrikes(ctx, state) {
    for (const strike of state.strikes) {
      ctx.save();
      if (!strike.resolved) {
        const progress = 1 - strike.delay / strike.maxDelay;
        ctx.strokeStyle = strike.color;
        ctx.globalAlpha = 0.3 + progress * 0.35;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(strike.position.x, strike.position.y, strike.radius + progress * 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (strike.strikeType === "lightning") {
          // Downward chevron arrow: warn "from above"
          const cx = strike.position.x;
          const cy = strike.position.y;
          ctx.beginPath();
          ctx.moveTo(cx - 7, cy - 7);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx + 7, cy - 7);
          ctx.moveTo(cx - 5, cy - 13);
          ctx.lineTo(cx, cy - 6);
          ctx.lineTo(cx + 5, cy - 13);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(strike.position.x - 8, strike.position.y);
          ctx.lineTo(strike.position.x + 8, strike.position.y);
          ctx.moveTo(strike.position.x, strike.position.y - 8);
          ctx.lineTo(strike.position.x, strike.position.y + 8);
          ctx.stroke();
        }
      } else if (strike.strikeType === "lightning") {
        const alpha = clamp(strike.flashTime / strike.maxFlashTime, 0, 1);
        const progress = 1 - alpha;
        const cx = strike.position.x;
        const cy = strike.position.y;

        // Full-screen white flash on first frame
        if (alpha > 0.88) {
          ctx.globalAlpha = (alpha - 0.88) / 0.12 * 0.18;
          ctx.fillStyle = "#ddf6ff";
          ctx.fillRect(0, 0, state.arena.center.x * 2, state.arena.center.y * 2);
          ctx.globalAlpha = 1;
        }

        // Jagged bolt from top to impact
        if (strike.lightningPath?.length > 1) {
          // Outer glow
          ctx.strokeStyle = `rgba(100, 180, 255, ${alpha * 0.55})`;
          ctx.lineWidth = 10 * alpha;
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.moveTo(strike.lightningPath[0].x, strike.lightningPath[0].y);
          for (const pt of strike.lightningPath.slice(1)) ctx.lineTo(pt.x, pt.y);
          ctx.stroke();

          // Mid glow
          ctx.strokeStyle = `rgba(180, 230, 255, ${alpha * 0.8})`;
          ctx.lineWidth = 4 * alpha;
          ctx.beginPath();
          ctx.moveTo(strike.lightningPath[0].x, strike.lightningPath[0].y);
          for (const pt of strike.lightningPath.slice(1)) ctx.lineTo(pt.x, pt.y);
          ctx.stroke();

          // Bright white core
          ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(strike.lightningPath[0].x, strike.lightningPath[0].y);
          for (const pt of strike.lightningPath.slice(1)) ctx.lineTo(pt.x, pt.y);
          ctx.stroke();
        }

        // Electric ring at impact, expanding outward
        const ringR = strike.radius * (0.6 + progress * 0.65);
        ctx.strokeStyle = `rgba(160, 220, 255, ${alpha * 0.9})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Outer fading ring
        ctx.strokeStyle = `rgba(100, 160, 255, ${alpha * 0.4})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR + 10 + progress * 14, 0, Math.PI * 2);
        ctx.stroke();

        // Impact flash – bright radial glow at ground zero
        const flashR = strike.radius * 0.65 * alpha;
        const flashGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, flashR);
        flashGrad.addColorStop(0,   `rgba(255, 255, 255, ${alpha})`);
        flashGrad.addColorStop(0.4, `rgba(180, 230, 255, ${alpha * 0.75})`);
        flashGrad.addColorStop(1,   `rgba(60, 130, 255, 0)`);
        ctx.fillStyle = flashGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, flashR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const alpha = clamp(strike.flashTime / strike.maxFlashTime, 0, 1);
        const progress = 1 - alpha;
        const cx = strike.position.x;
        const cy = strike.position.y;
        const fireballRadius = strike.radius * (0.55 + progress * 0.75);

        // Fireball core – radial gradient fading orange→red→transparent
        const fireGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, fireballRadius);
        fireGrad.addColorStop(0,   `rgba(255, 255, 200, ${alpha})`);
        fireGrad.addColorStop(0.25, `rgba(255, 200, 60, ${alpha * 0.95})`);
        fireGrad.addColorStop(0.55, `rgba(220, 80, 10, ${alpha * 0.8})`);
        fireGrad.addColorStop(0.85, `rgba(120, 30, 0, ${alpha * 0.45})`);
        fireGrad.addColorStop(1,   `rgba(60, 10, 0, 0)`);
        ctx.fillStyle = fireGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, fireballRadius, 0, Math.PI * 2);
        ctx.fill();

        // Shockwave ring expanding outward
        const ringRadius = strike.radius * (0.9 + progress * 0.5);
        ctx.strokeStyle = `rgba(255, 160, 40, ${alpha * 0.8})`;
        ctx.lineWidth = 3 + (1 - alpha) * 3;
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Outer thin smoke ring
        ctx.strokeStyle = `rgba(100, 60, 30, ${alpha * 0.35})`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius + 10 + progress * 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  renderTurrets(ctx, state) {
    for (const turret of state.turrets) {
      ctx.save();
      const angle = state.elapsed * (turret.level >= 2 ? 1.8 : 1);
      ctx.translate(turret.position.x, turret.position.y);

      ctx.fillStyle = turret.color;
      ctx.shadowBlur = 14;
      ctx.shadowColor = turret.color;
      ctx.beginPath();
      ctx.arc(0, 0, turret.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(30, 20, 10, 0.72)";
      ctx.beginPath();
      ctx.arc(0, 0, turret.radius * 0.52, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255, 241, 198, 0.8)";
      ctx.lineWidth = turret.level >= 2 ? 3 : 2;
      ctx.beginPath();
      ctx.arc(0, 0, turret.radius * 0.78, angle, angle + Math.PI * 1.6);
      ctx.stroke();

      const muzzleLength = turret.level >= 2 ? turret.radius + 9 : turret.radius + 6;
      ctx.rotate(angle);
      ctx.fillStyle = "#2d1c10";
      ctx.fillRect(0, -3, muzzleLength, turret.level >= 2 ? 6 : 5);
      if (turret.level >= 2) {
        ctx.fillRect(0, 5, muzzleLength - 4, 4);
      }
      if (turret.muzzleFlash > 0) {
        ctx.fillStyle = "rgba(255, 247, 210, 0.8)";
        ctx.beginPath();
        ctx.arc(muzzleLength, 0, 4 + turret.muzzleFlash * 30, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  renderProjectiles(ctx, state) {
    for (const projectile of state.projectiles) {
      ctx.save();
      ctx.fillStyle = projectile.color;
      ctx.shadowBlur = 16;
      ctx.shadowColor = projectile.color;

      if (projectile.shape === "needle" || projectile.shape === "bolt") {
        const angle = Math.atan2(projectile.velocity.y, projectile.velocity.x);
        ctx.translate(projectile.position.x, projectile.position.y);
        ctx.rotate(angle);

        const width = projectile.shape === "needle" ? projectile.radius * 1.1 : projectile.radius * 1.7;
        ctx.beginPath();
        ctx.moveTo(projectile.length * 0.5, 0);
        ctx.lineTo(-projectile.length * 0.4, width);
        ctx.lineTo(-projectile.length * 0.4, -width);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(projectile.position.x, projectile.position.y, projectile.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  renderPulses(ctx, state) {
    for (const pulse of state.pulses) {
      const progress = 1 - pulse.lifetime / pulse.maxLifetime;
      ctx.save();
      ctx.strokeStyle = pulse.color;
      ctx.globalAlpha = 0.5 * (pulse.lifetime / pulse.maxLifetime);
      ctx.lineWidth = pulse.lineWidth;
      ctx.beginPath();
      ctx.arc(
        pulse.position.x,
        pulse.position.y,
        pulse.radius * clamp(progress, 0.15, 1),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  renderActors(ctx, state) {
    for (const actor of state.actors) {
      ctx.save();
      if (!actor.alive) {
        ctx.globalAlpha = 0.25;
      }

      if (actor.state.invulnerableTime > 0) {
        if (actor.characterId === "holy-shield") {
          ctx.shadowBlur = 22;
          ctx.shadowColor = "#f5d070";
          ctx.strokeStyle = "rgba(245, 210, 90, 0.95)";
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(actor.position.x, actor.position.y, actor.radius + 9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = "rgba(255, 248, 180, 0.5)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(actor.position.x, actor.position.y, actor.radius + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.shadowBlur = 0;
        } else {
          ctx.strokeStyle = "rgba(255, 240, 195, 0.85)";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(actor.position.x, actor.position.y, actor.radius + 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      if (actor.state.frozenTime > 0) {
        ctx.strokeStyle = "rgba(147, 230, 255, 0.92)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(actor.position.x, actor.position.y, actor.radius + 6, 0, Math.PI * 2);
        ctx.stroke();
      } else if (actor.state.frostStacks > 0) {
        for (let si = 0; si < actor.state.frostStacks; si += 1) {
          const sa = -Math.PI / 2 + ((Math.PI * 2) / 3) * si;
          ctx.fillStyle = "#88ccff";
          ctx.beginPath();
          ctx.arc(
            actor.position.x + Math.cos(sa) * (actor.radius + 10),
            actor.position.y + Math.sin(sa) * (actor.radius + 10),
            3.5,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }

      this.renderActorBody(ctx, actor, state.elapsed);

      if (actor.characterId === "holy-shield" && actor.state.swordLength > 0) {
        this.renderHolySword(ctx, actor);
      }

      if (actor.characterId === "holy-shield" && (actor.state.shieldCharges ?? 0) > 0 && actor.state.invulnerableTime <= 0) {
        const charges = actor.state.shieldCharges;
        ctx.save();
        ctx.strokeStyle = "#f5d070";
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";
        ctx.shadowBlur = 8;
        ctx.shadowColor = "#f5d070";
        ctx.beginPath();
        ctx.arc(
          actor.position.x,
          actor.position.y,
          actor.radius + 9,
          -Math.PI / 2,
          -Math.PI / 2 + charges * ((Math.PI * 2) / 3),
        );
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(20, 12, 10, 0.85)";
      ctx.fillStyle = "#fff7eb";
      ctx.font = `700 ${Math.max(11, actor.radius * 0.8)}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const hpText = `${Math.ceil(actor.hp)}`;
      ctx.strokeText(hpText, actor.position.x, actor.position.y + 1);
      ctx.fillText(hpText, actor.position.x, actor.position.y + 1);
      ctx.restore();

      for (let index = 0; index < actor.stats.maxEssence; index += 1) {
        const angle = -Math.PI / 2 + ((Math.PI * 2) / Math.max(actor.stats.maxEssence, 1)) * index;
        const dotPosition = {
          x: actor.position.x + Math.cos(angle) * (actor.radius + 16),
          y: actor.position.y + Math.sin(angle) * (actor.radius + 16),
        };
        ctx.fillStyle = index < actor.essence ? "#ffe17f" : "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.arc(dotPosition.x, dotPosition.y, 3.1, 0, Math.PI * 2);
        ctx.fill();
      }

      if (state.matchOver && actor.alive) {
        ctx.strokeStyle = "rgba(255, 240, 176, 0.95)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(actor.position.x, actor.position.y, actor.radius + 16, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  renderActorBody(ctx, actor, elapsed) {
    const radius = actor.radius;
    const position = actor.position;
    const angle = Math.atan2(actor.velocity.y, actor.velocity.x);
    const glow = actor.highlightTime > 0 ? 22 : 12;

    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.shadowBlur = glow;
    ctx.shadowColor = actor.color;

    switch (actor.characterId) {
      case "bee-stinger":
        this.renderBeeBall(ctx, actor, angle);
        break;
      case "plague-mist":
        this.renderPlagueBall(ctx, actor, elapsed);
        break;
      case "meat-grinder":
        this.renderGrinderBall(ctx, actor, elapsed);
        break;
      case "storm-magnet":
        this.renderMagnetBall(ctx, actor, elapsed);
        break;
      case "turret-smith":
        this.renderTurretBall(ctx, actor, angle, elapsed);
        break;
      case "bomber-rex":
        this.renderBomberBall(ctx, actor, elapsed);
        break;
      case "blood-leech":
        this.renderLeechBall(ctx, actor, elapsed);
        break;
      case "phantom-mirror":
        this.renderMirrorBall(ctx, actor, elapsed);
        break;
      case "frost-core":
        this.renderFrostBall(ctx, actor, elapsed);
        break;
      case "holy-shield":
        this.renderHolyShieldBall(ctx, actor, elapsed);
        break;
      case "prism-refract":
        this.renderPrismBall(ctx, actor, elapsed);
        break;
      default:
        ctx.fillStyle = actor.color;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
  }

  renderBeeBall(ctx, actor, angle) {
    const radius = actor.radius;
    const shell = ctx.createRadialGradient(-radius * 0.25, -radius * 0.3, 2, 0, 0, radius);
    shell.addColorStop(0, "#fff2a7");
    shell.addColorStop(0.5, actor.color);
    shell.addColorStop(1, "#b16e18");

    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "rgba(36, 24, 10, 0.82)";
    [-radius * 0.75, 0, radius * 0.75].forEach((offset) => {
      ctx.fillRect(offset - 4, -radius * 1.4, 8, radius * 2.8);
    });
    ctx.restore();

    ctx.save();
    ctx.rotate(angle);
    ctx.fillStyle = "#4e2d0e";
    ctx.beginPath();
    ctx.moveTo(radius + 5, 0);
    ctx.lineTo(radius - 6, 4);
    ctx.lineTo(radius - 6, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.arc(-radius * 0.32, -radius * 0.34, radius * 0.34, 0, Math.PI * 2);
    ctx.fill();
  }

  renderPlagueBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const shell = ctx.createRadialGradient(-radius * 0.25, -radius * 0.25, 2, 0, 0, radius);
    shell.addColorStop(0, "#d7ff8e");
    shell.addColorStop(0.55, actor.color);
    shell.addColorStop(1, "#2f6125");

    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(32, 64, 20, 0.72)";
    for (const bubble of [
      { x: -radius * 0.24, y: -radius * 0.16, r: radius * 0.2 },
      { x: radius * 0.24, y: radius * 0.05, r: radius * 0.18 },
      { x: -radius * 0.05, y: radius * 0.3, r: radius * 0.12 },
    ]) {
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, bubble.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = `rgba(206, 255, 150, ${0.35 + Math.sin(elapsed * 5) * 0.1})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 2, Math.PI * 0.2, Math.PI * 1.2);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.arc(-radius * 0.32, -radius * 0.34, radius * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  renderGrinderBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const shell = ctx.createRadialGradient(-radius * 0.2, -radius * 0.24, 2, 0, 0, radius);
    shell.addColorStop(0, "#ffc1b6");
    shell.addColorStop(0.45, actor.color);
    shell.addColorStop(1, "#5c1311");

    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.78, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.rotate(elapsed * 2.8);
    ctx.fillStyle = "#ffd8d0";
    for (let index = 0; index < 10; index += 1) {
      const pointAngle = (Math.PI * 2 * index) / 10;
      const outer = radius + 4;
      const inner = radius * 0.78;
      ctx.beginPath();
      ctx.moveTo(Math.cos(pointAngle) * outer, Math.sin(pointAngle) * outer);
      ctx.lineTo(
        Math.cos(pointAngle + 0.18) * inner,
        Math.sin(pointAngle + 0.18) * inner,
      );
      ctx.lineTo(
        Math.cos(pointAngle - 0.18) * inner,
        Math.sin(pointAngle - 0.18) * inner,
      );
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle = "rgba(60, 10, 8, 0.7)";
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.36, 0, Math.PI * 2);
    ctx.fill();
  }

  renderMagnetBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const shell = ctx.createRadialGradient(-radius * 0.28, -radius * 0.34, 2, 0, 0, radius);
    shell.addColorStop(0, "#ddf3ff");
    shell.addColorStop(0.5, actor.color);
    shell.addColorStop(1, "#1b3869");

    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(214, 245, 255, 0.82)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.72, elapsed * 2.2, elapsed * 2.2 + Math.PI * 1.3);
    ctx.stroke();

    ctx.save();
    ctx.rotate(elapsed * 2.4);
    ctx.fillStyle = "#ff8a86";
    ctx.fillRect(-radius * 0.18, -radius - 1, radius * 0.36, 6);
    ctx.fillStyle = "#7fd5ff";
    ctx.fillRect(-radius * 0.18, radius - 5, radius * 0.36, 6);
    ctx.restore();

    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-radius * 0.55, -radius * 0.15);
    ctx.lineTo(-radius * 0.15, -radius * 0.45);
    ctx.lineTo(radius * 0.05, -radius * 0.08);
    ctx.lineTo(radius * 0.34, -radius * 0.28);
    ctx.stroke();
  }

  renderTurretBall(ctx, actor, angle, elapsed) {
    const radius = actor.radius;
    const shell = ctx.createRadialGradient(-radius * 0.24, -radius * 0.28, 2, 0, 0, radius);
    shell.addColorStop(0, "#ffe7b3");
    shell.addColorStop(0.52, actor.color);
    shell.addColorStop(1, "#6e4a1f");

    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(59, 35, 14, 0.72)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.64, elapsed * 1.5, elapsed * 1.5 + Math.PI * 1.5);
    ctx.stroke();

    ctx.save();
    ctx.rotate(angle);
    ctx.fillStyle = "#3a2412";
    ctx.fillRect(radius * 0.12, -3, radius + 2, 6);
    ctx.fillStyle = "#f5d5a5";
    ctx.beginPath();
    ctx.arc(radius * 0.2, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.arc(-radius * 0.34, -radius * 0.32, radius * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }

  renderParticles(ctx, state) {
    for (const particle of state.particles) {
      ctx.save();
      ctx.globalAlpha = clamp(particle.lifetime, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.position.x, particle.position.y, particle.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  renderDamageTexts(ctx, state) {
    for (const entry of state.damageTexts) {
      ctx.save();
      ctx.globalAlpha = clamp(entry.lifetime / 0.8, 0, 1);
      ctx.fillStyle = entry.color;
      ctx.font = `700 ${entry.size}px "Trebuchet MS", "Microsoft YaHei UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(entry.text, entry.position.x, entry.position.y);
      ctx.restore();
    }
  }

  // ── Beam system (汲取者) ───────────────────────────────────────────────

  spawnBeam(owner, config) {
    const beam = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      targetId: config.targetId,
      color: config.color ?? owner.color,
      lifetime: config.duration ?? 3,
      maxLifetime: config.duration ?? 3,
      thick: config.thick ?? false,
    };
    this.state.beams.push(beam);
    return beam;
  }

  updateBeams(dt) {
    this.state.beams = this.state.beams.filter((beam) => {
      beam.lifetime -= dt;
      if (beam.lifetime <= 0) return false;
      const owner = this.findActorById(beam.ownerId);
      const target = this.findActorById(beam.targetId);
      return owner?.alive && target?.alive;
    });
  }

  spawnDynamicWall() {
    const arena = this.state.arena;

    // 计算场地平均边长
    const totalLen = arena.points.reduce((sum, pt, i) => {
      const next = arena.points[(i + 1) % arena.points.length];
      return sum + distance(pt, next);
    }, 0);
    const sideLen = totalLen / arena.points.length;
    const halfLen = sideLen / 2;

    // 在场内随机取一个中心点（最多 30 次尝试）
    let pos = null;
    const inset = halfLen * 0.6;
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * (Math.min(WORLD_WIDTH, WORLD_HEIGHT) * 0.3);
      const candidate = {
        x: WORLD_WIDTH / 2 + Math.cos(angle) * r,
        y: WORLD_HEIGHT / 2 + Math.sin(angle) * r,
      };
      // 确保中心点足够靠内
      if (
        pointInConvexPolygon(candidate, arena.points) &&
        candidate.x > inset && candidate.x < WORLD_WIDTH - inset &&
        candidate.y > inset && candidate.y < WORLD_HEIGHT - inset
      ) {
        pos = candidate;
        break;
      }
    }
    if (!pos) pos = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };

    // 随机方向角
    const angle = Math.random() * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    arena.walls.push({
      a: { x: pos.x - dx * halfLen, y: pos.y - dy * halfLen },
      b: { x: pos.x + dx * halfLen, y: pos.y + dy * halfLen },
      thickness: 12,
      dynamic: true,
    });
  }

  renderBeams(ctx, state) {
    for (const beam of state.beams) {
      const owner = state.actors.find((a) => a.id === beam.ownerId);
      const target = state.actors.find((a) => a.id === beam.targetId);
      if (!owner?.alive || !target?.alive) continue;
      const alpha = clamp(beam.lifetime / beam.maxLifetime, 0.1, 0.75);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = beam.color;
      ctx.lineWidth = beam.thick ? 7 : 3;
      ctx.setLineDash(beam.thick ? [14, 6] : [8, 5]);
      ctx.shadowBlur = beam.thick ? 22 : 14;
      ctx.shadowColor = beam.color;
      ctx.beginPath();
      ctx.moveTo(owner.position.x, owner.position.y);
      ctx.lineTo(target.position.x, target.position.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ── Decoy system (欺诈师) ─────────────────────────────────────────────

  spawnDecoy(owner, config) {
    const current = this.state.decoys.filter((d) => d.ownerId === owner.id);
    if (current.length >= (config.maxCount ?? 3)) return null;
    const decoy = {
      id: Math.random().toString(16).slice(2),
      ownerId: owner.id,
      position: { ...owner.position },
      radius: owner.radius ?? 18,
      color: owner.color,
      hitsTaken: 0,
      maxHits: config.maxHits ?? 3,
      explodeDamage: config.explodeDamage ?? 8,
      explodeRadius: (config.explodeRadius ?? 48) * GAME_SCALE,
      contactTimers: new Map(),
    };
    this.state.decoys.push(decoy);
    return decoy;
  }

  updateDecoys(dt) {
    for (const decoy of this.state.decoys) {
      for (const [actorId, timer] of decoy.contactTimers.entries()) {
        decoy.contactTimers.set(actorId, Math.max(0, timer - dt));
      }
    }
  }

  resolveDecoyCollisions() {
    for (const decoy of this.state.decoys) {
      for (const actor of this.state.actors) {
        if (!actor.alive || actor.id === decoy.ownerId) continue;
        const delta = subtract(actor.position, decoy.position);
        const gap = length(delta);
        const minGap = actor.radius + decoy.radius;
        if (!gap || gap >= minGap) continue;

        const normal = scale(delta, 1 / gap);
        actor.position = add(decoy.position, scale(normal, minGap + 0.2));
        if (dot(actor.velocity, normal) < 0) {
          actor.velocity = reflect(actor.velocity, normal);
        }

        const cooldown = decoy.contactTimers.get(actor.id) ?? 0;
        if (cooldown > 0) continue;
        decoy.contactTimers.set(actor.id, 0.4);
        decoy.hitsTaken += 1;
      }
    }

    const before = this.state.decoys.length;
    this.state.decoys = this.state.decoys.filter((decoy) => {
      if (decoy.hitsTaken < decoy.maxHits) return true;
      this.spawnDecoyExplosion(decoy);
      return false;
    });
    if (before !== this.state.decoys.length) {
      this.announce("分身破碎。");
    }
  }

  spawnDecoyExplosion(decoy) {
    const owner = this.findActorById(decoy.ownerId);
    this.state.pulses.push({
      id: Math.random().toString(16).slice(2),
      ownerId: decoy.ownerId,
      position: { ...decoy.position },
      radius: decoy.explodeRadius,
      lifetime: 0.28,
      maxLifetime: 0.28,
      color: decoy.color,
      lineWidth: 5,
    });
    for (const actor of this.state.actors) {
      if (!actor.alive || actor.id === decoy.ownerId) continue;
      if (distance(actor.position, decoy.position) > actor.radius + decoy.explodeRadius) continue;
      this.applyDamage(actor, decoy.explodeDamage, { type: "skill", color: decoy.color, attacker: owner });
    }
    for (let i = 0; i < 10; i += 1) {
      this.state.particles.push({
        position: { ...decoy.position },
        velocity: scale(randomUnit(), randomBetween(40, 130)),
        lifetime: randomBetween(0.2, 0.45),
        color: i % 2 === 0 ? decoy.color : "#e8e0ff",
        size: randomBetween(2, 5),
      });
    }
    this.shake(8, 0.12);
  }

  activateDecoys(owner, config = {}) {
    const owned = this.state.decoys.filter((d) => d.ownerId === owner.id);
    if (!owned.length) return 0;
    owned.forEach((decoy) => {
      const target = this.findNearestHostileToPoint(owner.id, decoy.position, Infinity);
      if (target) {
        this.spawnProjectile(owner, {
          position: { ...decoy.position },
          direction: normalize(subtract(target.position, decoy.position)),
          speed: 620,
          radius: decoy.radius * 0.72,
          damage: config.activateDamage ?? 15,
          color: decoy.color,
          lifetime: 0.85,
          bounces: 0,
          knockback: 200,
        });
      }
    });
    this.state.decoys = this.state.decoys.filter((d) => d.ownerId !== owner.id);
    return owned.length;
  }

  renderDecoys(ctx, state) {
    for (const decoy of state.decoys) {
      ctx.save();
      ctx.globalAlpha = 0.52;
      ctx.shadowBlur = 10;
      ctx.shadowColor = decoy.color;
      ctx.fillStyle = decoy.color;
      ctx.beginPath();
      ctx.arc(decoy.position.x, decoy.position.y, decoy.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let i = 0; i < decoy.hitsTaken; i += 1) {
        const a = (Math.PI * 2 * i) / decoy.maxHits - Math.PI / 2;
        ctx.fillStyle = "rgba(255, 70, 70, 0.9)";
        ctx.beginPath();
        ctx.arc(
          decoy.position.x + Math.cos(a) * (decoy.radius + 8),
          decoy.position.y + Math.sin(a) * (decoy.radius + 8),
          3,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ── Frost stack system (绝对零度) ──────────────────────────────────────

  applyFrostStack(attacker, target, options = {}) {
    if (!target.alive) return;
    const maxStacks = options.maxStacks ?? 3;
    const stackDuration = options.stackDuration ?? 2;
    const freezeDuration = options.freezeDuration ?? 1.5;
    const slowFactor = options.slowFactor ?? 0.8;

    target.state.slowFactor = Math.min(target.state.slowFactor, slowFactor);
    target.state.slowTime = Math.max(target.state.slowTime, stackDuration);

    target.state.frostStacks = (target.state.frostStacks ?? 0) + 1;
    target.state.frostStackTime = stackDuration;

    if (target.state.frostStacks >= maxStacks) {
      target.state.frostStacks = 0;
      target.state.frostStackTime = 0;
      target.state.frozenTime = freezeDuration;
      this.lockActorMovement(target, freezeDuration);
      this.spawnDamageText({
        text: "冻结!",
        position: target.position,
        color: "#c8f0ff",
        velocityY: -26,
        lifetime: 0.9,
        size: 16,
      });
      this.shake(8, 0.14);
    }
  }

  // ── New character body renders ─────────────────────────────────────────

  renderBomberBall(ctx, actor, elapsed) {
    const radius = actor.radius;

    // 铸铁球体：深灰到黑，带橙红色危险纹路
    const shell = ctx.createRadialGradient(-radius * 0.28, -radius * 0.32, 1, 0, 0, radius);
    shell.addColorStop(0, "#7a6a5a");
    shell.addColorStop(0.45, "#3a2e28");
    shell.addColorStop(1, "#0e0b08");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // 赤红危险条纹（绕球赤道一圈）
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(elapsed * 0.6);
    ctx.strokeStyle = actor.color;
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = "#ffcc44";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 铆钉
    ctx.fillStyle = "#5a4a3a";
    for (let i = 0; i < 5; i += 1) {
      const a = (Math.PI * 2 * i) / 5 + elapsed * 0.28;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * radius * 0.82, Math.sin(a) * radius * 0.82, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 导火索：弯曲的线条从顶部延伸出去
    const fuseFlicker = Math.sin(elapsed * 18) * 1.5;
    ctx.save();
    ctx.strokeStyle = "#c8a060";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, -radius + 1);
    ctx.quadraticCurveTo(radius * 0.4 + fuseFlicker, -radius * 1.2, radius * 0.15, -radius * 1.65);
    ctx.stroke();
    ctx.restore();

    // 导火索火花：顶端的跳动火焰
    const sparkBright = 0.6 + Math.sin(elapsed * 22 + 1) * 0.4;
    ctx.save();
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#ff8800";
    ctx.fillStyle = `rgba(255, ${Math.floor(160 + sparkBright * 80)}, 30, ${sparkBright})`;
    ctx.beginPath();
    ctx.arc(radius * 0.15, -radius * 1.65, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 240, 120, ${sparkBright * 0.8})`;
    ctx.beginPath();
    ctx.arc(radius * 0.15, -radius * 1.65, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 高光
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.beginPath();
    ctx.arc(-radius * 0.34, -radius * 0.36, radius * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }

  renderLeechBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const heartbeat = (Math.sin(elapsed * 5.2) + 1) * 0.5;
    const heartbeat2 = (Math.sin(elapsed * 5.2 - 0.6) + 1) * 0.5;

    // 深红躯体，从暗紫到深红带透明质感
    const shell = ctx.createRadialGradient(-radius * 0.18, -radius * 0.24, 1, 0, 0, radius);
    shell.addColorStop(0, "#ff7a9a");
    shell.addColorStop(0.38, actor.color);
    shell.addColorStop(0.78, "#6a0820");
    shell.addColorStop(1, "#1a0208");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // 跳动外圈：心跳脉冲感
    ctx.save();
    ctx.strokeStyle = `rgba(220, 40, 90, ${0.18 + heartbeat * 0.55})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 2 + heartbeat * 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 100, 140, ${0.1 + heartbeat2 * 0.3})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 5 + heartbeat2 * 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 血管纹路：4条蜿蜒曲线向外辐射
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = `rgba(100, 5, 25, ${0.5 + heartbeat * 0.35})`;
    ctx.lineWidth = 1.8;
    for (let i = 0; i < 4; i += 1) {
      const a = (Math.PI * 2 * i) / 4 + elapsed * 0.15;
      const cx1 = Math.cos(a + 0.5) * radius * 0.35;
      const cy1 = Math.sin(a + 0.5) * radius * 0.35;
      const ex = Math.cos(a) * radius;
      const ey = Math.sin(a) * radius;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(cx1, cy1, ex, ey);
      ctx.stroke();
    }
    ctx.restore();

    // 中央瞳孔：竖瞳，随心跳张合
    const eyeW = radius * (0.12 + heartbeat * 0.06);
    const eyeH = radius * (0.28 + heartbeat * 0.1);
    ctx.save();
    ctx.fillStyle = "#0a0005";
    ctx.beginPath();
    ctx.ellipse(0, 0, eyeW, eyeH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 30, 60, ${0.6 + heartbeat * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, eyeW * 0.45, eyeH * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 高光
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(-radius * 0.34, -radius * 0.38, radius * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  renderMirrorBall(ctx, actor, elapsed) {
    const radius = actor.radius;

    // 主体：半透明紫色棱镜质感，双层渐变
    const shell = ctx.createRadialGradient(-radius * 0.22, -radius * 0.28, 1, 0, 0, radius);
    shell.addColorStop(0, "#f0e8ff");
    shell.addColorStop(0.3, "#c8a8ff");
    shell.addColorStop(0.65, actor.color);
    shell.addColorStop(1, "#200840");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // 棱镜切面：剪裁在球体内，顺时针旋转的彩色扇形
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.92, 0, Math.PI * 2);
    ctx.clip();
    const segCount = 8;
    const colors = ["rgba(200,160,255,0.22)", "rgba(160,220,255,0.18)", "rgba(255,180,240,0.18)", "rgba(180,255,200,0.14)"];
    ctx.rotate(elapsed * 0.9);
    for (let i = 0; i < segCount; i += 1) {
      const a0 = (Math.PI * 2 * i) / segCount;
      const a1 = (Math.PI * 2 * (i + 0.85)) / segCount;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 反向慢转的内层菱形框
    ctx.save();
    ctx.rotate(-elapsed * 0.5);
    ctx.strokeStyle = "rgba(230, 210, 255, 0.6)";
    ctx.lineWidth = 1.4;
    const sq = radius * 0.54;
    ctx.beginPath();
    ctx.moveTo(0, -sq);
    ctx.lineTo(sq, 0);
    ctx.lineTo(0, sq);
    ctx.lineTo(-sq, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 分身残影：偏移半透明复制自身
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.shadowBlur = 8;
    ctx.shadowColor = actor.color;
    const ghostOff = radius * 0.38;
    const ghostAngle = elapsed * 1.6;
    const ghostShell = ctx.createRadialGradient(0, 0, 1, 0, 0, radius * 0.7);
    ghostShell.addColorStop(0, "#e0d0ff");
    ghostShell.addColorStop(1, "rgba(170,136,238,0)");
    ctx.fillStyle = ghostShell;
    ctx.beginPath();
    ctx.arc(Math.cos(ghostAngle) * ghostOff, Math.sin(ghostAngle) * ghostOff, radius * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 闪光点
    const glintA = elapsed * 3.1;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(Math.cos(glintA) * radius * 0.6, Math.sin(glintA) * radius * 0.6, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(Math.cos(glintA + 2.1) * radius * 0.4, Math.sin(glintA + 2.1) * radius * 0.4, 1.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.beginPath();
    ctx.arc(-radius * 0.3, -radius * 0.34, radius * 0.26, 0, Math.PI * 2);
    ctx.fill();
  }

  renderFrostBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const frozen = actor.state.frozenTime > 0;
    const breathe = (Math.sin(elapsed * 2.4) + 1) * 0.5;

    // 冰晶核心：白蓝渐变，冻结时更亮更白
    const shell = ctx.createRadialGradient(0, 0, 1, 0, 0, radius);
    shell.addColorStop(0, frozen ? "#ffffff" : `rgba(220,245,255,${0.85 + breathe * 0.15})`);
    shell.addColorStop(0.35, frozen ? "#cceeff" : actor.color);
    shell.addColorStop(0.72, "#2266aa");
    shell.addColorStop(1, "#0a1e3a");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // 外层薄冰壳：有棱角感的多边形光圈
    ctx.save();
    ctx.rotate(elapsed * 0.35);
    ctx.strokeStyle = `rgba(180, 230, 255, ${frozen ? 0.7 : 0.35 + breathe * 0.2})`;
    ctx.lineWidth = frozen ? 2.2 : 1.4;
    const sides = 6;
    ctx.beginPath();
    for (let i = 0; i <= sides; i += 1) {
      const a = (Math.PI * 2 * i) / sides;
      const r = radius * (0.95 + Math.cos(a * 3) * 0.04);
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.stroke();
    ctx.restore();

    // 雪花主体：6臂，每臂有两段侧枝，慢速旋转
    ctx.save();
    ctx.rotate(elapsed * (frozen ? 0.2 : 0.55));
    ctx.strokeStyle = `rgba(210, 245, 255, ${frozen ? 0.92 : 0.72})`;
    ctx.lineWidth = frozen ? 2 : 1.6;
    ctx.lineCap = "round";
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI * 2 * i) / 6;
      const ex = Math.cos(a) * radius * 0.78;
      const ey = Math.sin(a) * radius * 0.78;
      // 主臂
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // 内侧枝
      const m1x = Math.cos(a) * radius * 0.38;
      const m1y = Math.sin(a) * radius * 0.38;
      const pa = a + Math.PI / 2;
      const bl = radius * 0.2;
      ctx.beginPath();
      ctx.moveTo(m1x + Math.cos(pa) * bl, m1y + Math.sin(pa) * bl);
      ctx.lineTo(m1x - Math.cos(pa) * bl, m1y - Math.sin(pa) * bl);
      ctx.stroke();
      // 外侧枝
      const m2x = Math.cos(a) * radius * 0.6;
      const m2y = Math.sin(a) * radius * 0.6;
      const bl2 = radius * 0.13;
      ctx.beginPath();
      ctx.moveTo(m2x + Math.cos(pa) * bl2, m2y + Math.sin(pa) * bl2);
      ctx.lineTo(m2x - Math.cos(pa) * bl2, m2y - Math.sin(pa) * bl2);
      ctx.stroke();
    }
    ctx.restore();

    // 内核：冷蓝色圆心
    const coreGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.28);
    coreGlow.addColorStop(0, frozen ? "rgba(255,255,255,0.9)" : "rgba(160,230,255,0.75)");
    coreGlow.addColorStop(1, "rgba(80,160,255,0)");
    ctx.fillStyle = coreGlow;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.28, 0, Math.PI * 2);
    ctx.fill();

    // 高光
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.beginPath();
    ctx.arc(-radius * 0.3, -radius * 0.34, radius * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 激光系统 (光棱) ──────────────────────────────────────────────────────

  raySegmentIntersect(origin, dir, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const denom = dir.x * aby - dir.y * abx;
    if (Math.abs(denom) < 0.0001) return null;
    const aox = a.x - origin.x;
    const aoy = a.y - origin.y;
    const t = (aox * aby - aoy * abx) / denom;
    const s = (aox * dir.y - aoy * dir.x) / denom;
    if (t < 0 || s < 0 || s > 1) return null;
    return { t, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t } };
  }

  findNearestWallHit(origin, dir) {
    let nearest = null;
    let nearestT = Infinity;

    const points = this.state.arena.points;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const hit = this.raySegmentIntersect(origin, dir, a, b);
      if (hit && hit.t > 0.5 && hit.t < nearestT) {
        const edge = subtract(b, a);
        let normal = normalize({ x: -edge.y, y: edge.x });
        if (dot(normal, dir) > 0) normal = scale(normal, -1);
        nearest = { t: hit.t, point: hit.point, normal };
        nearestT = hit.t;
      }
    }

    for (const wall of this.state.arena.walls) {
      const abx = wall.b.x - wall.a.x;
      const aby = wall.b.y - wall.a.y;
      const len = Math.hypot(abx, aby);
      if (len < 0.001) continue;
      const perp = { x: -aby / len, y: abx / len };
      const half = wall.thickness / 2;
      const edges = [
        [add(wall.a, scale(perp, half)), add(wall.b, scale(perp, half))],
        [add(wall.a, scale(perp, -half)), add(wall.b, scale(perp, -half))],
      ];
      for (const [ea, eb] of edges) {
        const hit = this.raySegmentIntersect(origin, dir, ea, eb);
        if (hit && hit.t > 0.5 && hit.t < nearestT) {
          const edge = subtract(eb, ea);
          let normal = normalize({ x: -edge.y, y: edge.x });
          if (dot(normal, dir) > 0) normal = scale(normal, -1);
          nearest = { t: hit.t, point: hit.point, normal };
          nearestT = hit.t;
        }
      }
    }

    return nearest;
  }

  castLaserSegments(origin, direction, maxBounces) {
    const segments = [];
    let current = { ...origin };
    let dir = normalize(direction);

    for (let bounce = 0; bounce <= maxBounces; bounce += 1) {
      const hit = this.findNearestWallHit(current, dir);
      if (!hit) break;
      segments.push({ start: { ...current }, end: { ...hit.point } });
      if (bounce >= maxBounces) break;
      dir = reflect(dir, hit.normal);
      current = { x: hit.point.x + dir.x * 0.5, y: hit.point.y + dir.y * 0.5 };
    }

    return segments;
  }

  spawnLaser(actor, config) {
    const segments = this.castLaserSegments(
      actor.position,
      config.direction,
      config.maxBounces ?? 3,
    );
    const laser = {
      id: Math.random().toString(16).slice(2),
      ownerId: actor.id,
      segments,
      color: config.color ?? "#ff4444",
      width: config.width ?? 3,
      damage: config.damage ?? 6,
      stunDuration: config.stunDuration ?? 0.2,
      lifetime: config.lifetime ?? 0.4,
      maxLifetime: config.lifetime ?? 0.4,
      hitEnemies: new Set(),
      persistent: config.persistent ?? false,
    };
    this.state.lasers.push(laser);
    this.applyLaserDamage(actor, laser);
    return laser;
  }

  applyLaserDamage(actor, laser) {
    const LASER_HALF = laser.width / 2 + 2;
    for (const enemy of this.state.actors) {
      if (!enemy.alive || enemy.id === actor.id) continue;
      if (laser.hitEnemies.has(enemy.id)) continue;
      for (const seg of laser.segments) {
        const dist = distanceToSegment(enemy.position, seg.start, seg.end);
        if (dist < enemy.radius + LASER_HALF) {
          laser.hitEnemies.add(enemy.id);
          this.applyDamage(enemy, laser.damage, { attacker: actor, color: laser.color });
          if (laser.stunDuration > 0 && enemy.alive) {
            this.lockActorMovement(enemy, laser.stunDuration);
          }
          break;
        }
      }
    }
  }

  updateLasers(dt) {
    this.state.lasers = this.state.lasers.filter((laser) => {
      laser.lifetime -= dt;
      if (laser.lifetime <= 0) return false;
      if (laser.persistent) {
        const actor = this.findActorById(laser.ownerId);
        if (actor?.alive) {
          this.applyLaserDamage(actor, laser);
        }
      }
      return true;
    });
  }

  renderLasers(ctx, state) {
    for (const laser of state.lasers) {
      const alpha = clamp(laser.lifetime / laser.maxLifetime, 0, 1);
      ctx.save();
      ctx.lineCap = "round";

      // 外层光晕
      ctx.globalAlpha = alpha * 0.55;
      ctx.shadowBlur = laser.width * 5;
      ctx.shadowColor = laser.color;
      ctx.strokeStyle = laser.color;
      ctx.lineWidth = laser.width * 2.2;
      for (const seg of laser.segments) {
        ctx.beginPath();
        ctx.moveTo(seg.start.x, seg.start.y);
        ctx.lineTo(seg.end.x, seg.end.y);
        ctx.stroke();
      }

      // 主光束
      ctx.globalAlpha = alpha * 0.92;
      ctx.shadowBlur = laser.width * 3;
      ctx.strokeStyle = laser.color;
      ctx.lineWidth = laser.width;
      for (const seg of laser.segments) {
        ctx.beginPath();
        ctx.moveTo(seg.start.x, seg.start.y);
        ctx.lineTo(seg.end.x, seg.end.y);
        ctx.stroke();
      }

      // 白色核心
      ctx.globalAlpha = alpha * 0.75;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = laser.width * 0.35;
      for (const seg of laser.segments) {
        ctx.beginPath();
        ctx.moveTo(seg.start.x, seg.start.y);
        ctx.lineTo(seg.end.x, seg.end.y);
        ctx.stroke();
      }

      // 反射节点
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.shadowBlur = 8;
      ctx.shadowColor = laser.color;
      for (let i = 1; i < laser.segments.length; i += 1) {
        const pt = laser.segments[i].start;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, laser.width * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  renderPrismBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const charging = actor.state.movementLock > 0;
    const spin = elapsed * 0.65;

    // 主体：纯白到珍珠灰
    const shell = ctx.createRadialGradient(-radius * 0.18, -radius * 0.22, 1, 0, 0, radius);
    shell.addColorStop(0, "#ffffff");
    shell.addColorStop(0.22, charging ? "#ffffff" : "#f2f4ff");
    shell.addColorStop(0.55, "#c8d0e8");
    shell.addColorStop(0.82, "#7880a0");
    shell.addColorStop(1, "#1a1c28");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // 宝石刻面：6条辐射线 + 两圈六边形
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(spin);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI * 2 * i) / 6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(200, 210, 240, 0.6)";
    for (const r of [radius * 0.44, radius * 0.78]) {
      ctx.beginPath();
      for (let i = 0; i <= 6; i += 1) {
        const a = (Math.PI * 2 * i) / 6;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 折射彩虹弧：内圈旋转彩色光谱（模拟棱镜色散）
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    const rainbowColors = ["#ff4444", "#ff9900", "#ffee00", "#44ff88", "#4499ff", "#cc44ff"];
    rainbowColors.forEach((color, i) => {
      const a0 = spin * 0.5 + (Math.PI * 2 * i) / rainbowColors.length;
      const a1 = spin * 0.5 + (Math.PI * 2 * (i + 0.72)) / rainbowColors.length;
      ctx.strokeStyle = color;
      ctx.globalAlpha = charging ? 0.42 : 0.18;
      ctx.lineWidth = radius * 0.18;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.66, a0, a1);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    // 蓄力：中心白光爆发，切面全亮
    if (charging) {
      const pulse = (Math.sin(elapsed * 22) + 1) * 0.5;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.85);
      glow.addColorStop(0, `rgba(255, 255, 255, ${0.7 + pulse * 0.3})`);
      glow.addColorStop(0.45, `rgba(230, 235, 255, ${0.3 + pulse * 0.2})`);
      glow.addColorStop(1, "rgba(200, 210, 255, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 旋转闪光点：模拟宝石棱角反光
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    for (let i = 0; i < 3; i += 1) {
      const ga = spin * 1.5 + (Math.PI * 2 * i) / 3;
      const gr = radius * 0.74;
      const gs = 1.6 + Math.sin(elapsed * 4.2 + i * 2.1) * 0.7;
      ctx.beginPath();
      ctx.arc(Math.cos(ga) * gr, Math.sin(ga) * gr, gs, 0, Math.PI * 2);
      ctx.fill();
    }

    // 主高光：椭圆镜面反光
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.ellipse(-radius * 0.25, -radius * 0.3, radius * 0.22, radius * 0.1, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.arc(radius * 0.2, radius * 0.25, radius * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 圣盾系统 ────────────────────────────────────────────────────────────

  updateHolySwords(dt) {
    const SWORD_ORBIT_SPEED = Math.PI * 0.75;
    const SWORD_HIT_THICKNESS = 7;

    for (const actor of this.state.actors) {
      if (!actor.alive || actor.characterId !== "holy-shield") continue;
      if (actor.state.swordLength <= 0) continue;

      actor.state.swordOrbitAngle = (actor.state.swordOrbitAngle ?? 0) + SWORD_ORBIT_SPEED * dt;

      if (!actor.state.swordDamageCooldowns) {
        actor.state.swordDamageCooldowns = new Map();
      }
      for (const [id, timer] of actor.state.swordDamageCooldowns.entries()) {
        if (timer <= 0) {
          actor.state.swordDamageCooldowns.delete(id);
        } else {
          actor.state.swordDamageCooldowns.set(id, timer - dt);
        }
      }

      const angle = actor.state.swordOrbitAngle;
      const swordBase = {
        x: actor.position.x + Math.cos(angle) * actor.radius,
        y: actor.position.y + Math.sin(angle) * actor.radius,
      };
      const tip = {
        x: actor.position.x + Math.cos(angle) * actor.state.swordLength,
        y: actor.position.y + Math.sin(angle) * actor.state.swordLength,
      };
      const swordDamage = actor.definition.tuning.ultimate.swordDamage;

      for (const enemy of this.state.actors) {
        if (!enemy.alive || enemy.id === actor.id) continue;
        if ((actor.state.swordDamageCooldowns.get(enemy.id) ?? 0) > 0) continue;
        const dist = distanceToSegment(enemy.position, swordBase, tip);
        if (dist < enemy.radius + SWORD_HIT_THICKNESS) {
          this.applyDamage(enemy, swordDamage, { attacker: actor, color: "#f5d070" });
          actor.state.swordDamageCooldowns.set(enemy.id, 0.45);
          this.shake(5, 0.08);
        }
      }
    }
  }

  renderHolySword(ctx, actor) {
    const angle = actor.state.swordOrbitAngle ?? 0;
    const swordLength = actor.state.swordLength;
    const ox = actor.position.x;
    const oy = actor.position.y;
    const baseX = ox + Math.cos(angle) * actor.radius;
    const baseY = oy + Math.sin(angle) * actor.radius;
    const tipX = ox + Math.cos(angle) * swordLength;
    const tipY = oy + Math.sin(angle) * swordLength;
    const perpX = -Math.sin(angle);
    const perpY = Math.cos(angle);

    ctx.save();
    ctx.shadowBlur = 20;
    ctx.shadowColor = "#f5d070";

    // 剑身渐变
    const grad = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
    grad.addColorStop(0, "rgba(255, 252, 190, 0.95)");
    grad.addColorStop(0.45, "#f5d070");
    grad.addColorStop(1, "rgba(220, 150, 20, 0.35)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // 核心白线
    ctx.strokeStyle = "rgba(255, 255, 230, 0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // 剑尖光点
    ctx.fillStyle = "rgba(255, 255, 210, 0.95)";
    ctx.beginPath();
    ctx.arc(tipX, tipY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // 护手
    ctx.strokeStyle = "rgba(245, 200, 60, 0.9)";
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(baseX + perpX * 9, baseY + perpY * 9);
    ctx.lineTo(baseX - perpX * 9, baseY - perpY * 9);
    ctx.stroke();

    ctx.restore();
  }

  renderHolyShieldBall(ctx, actor, elapsed) {
    const radius = actor.radius;
    const shielded = actor.state.invulnerableTime > 0;
    const pulse = (Math.sin(elapsed * 3.0) + 1) * 0.5;

    // 主体：金色到深琥珀，护盾激活时更亮
    const shell = ctx.createRadialGradient(-radius * 0.22, -radius * 0.28, 2, 0, 0, radius);
    shell.addColorStop(0, shielded ? "#fffbe0" : "#ffe88a");
    shell.addColorStop(0.38, shielded ? "#f8d860" : "#d4a830");
    shell.addColorStop(0.72, "#7a500f");
    shell.addColorStop(1, "#2e1800");
    ctx.fillStyle = shell;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // 盾纹：裁剪在球体内的菱形网格
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = `rgba(255, 230, 100, ${0.18 + pulse * 0.1})`;
    ctx.lineWidth = 1.1;
    const step = radius * 0.4;
    for (let i = -3; i <= 3; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * step - radius, -radius);
      ctx.lineTo(i * step + radius, radius);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(i * step + radius, -radius);
      ctx.lineTo(i * step - radius, radius);
      ctx.stroke();
    }
    ctx.restore();

    // 中央盾形十字标
    ctx.save();
    ctx.strokeStyle = shielded ? "rgba(255, 255, 210, 0.92)" : "rgba(255, 220, 80, 0.72)";
    ctx.lineWidth = shielded ? 3.5 : 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-radius * 0.36, 0);
    ctx.lineTo(radius * 0.36, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.44);
    ctx.lineTo(0, radius * 0.28);
    ctx.stroke();
    ctx.restore();

    // 护盾激活时的内层光晕
    if (shielded) {
      ctx.strokeStyle = `rgba(255, 240, 120, ${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 高光
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.arc(-radius * 0.3, -radius * 0.34, radius * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
}
