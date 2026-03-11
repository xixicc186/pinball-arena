function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => deepClone(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepClone(entry)]),
    );
  }
  return value;
}

function getByPath(target, path) {
  return path.split(".").reduce((value, key) => value?.[key], target);
}

function setByPath(target, path, nextValue) {
  const keys = path.split(".");
  const lastKey = keys.pop();
  const parent = keys.reduce((value, key) => value?.[key], target);
  if (!parent || lastKey == null) {
    return false;
  }
  parent[lastKey] = nextValue;
  return true;
}

function editableField(path, label, options = {}) {
  return {
    path,
    label,
    min: options.min ?? 0,
    max: options.max,
    step: options.step ?? 1,
    unit: options.unit ?? "",
  };
}

export function defineCharacter(config) {
  const requiredStats = ["maxHp", "speed", "maxEssence", "attackRange"];
  for (const key of requiredStats) {
    if (typeof config?.stats?.[key] !== "number") {
      throw new Error(`角色 ${config?.id ?? "unknown"} 缺少数值属性 ${key}`);
    }
  }
  return {
    radius: 18,
    visual: {
      motif: "default",
    },
    editorSections: [],
    tuning: {},
    basicAttack: {
      name: "基础攻击",
      triggers: [{ type: "interval", interval: 1 }],
      execute() {},
    },
    ultimate: {
      name: "终极技能",
      execute() {},
    },
    onSpawn() {},
    onKill() {},
    onDeath() {},
    ...config,
    stats: {
      radius: config?.stats?.radius ?? config.radius ?? 18,
      ...config.stats,
    },
    tuning: deepClone(config.tuning ?? {}),
    editorSections: deepClone(config.editorSections ?? []),
  };
}

export function instantiateCharacter(character) {
  return {
    ...character,
    stats: deepClone(character.stats),
    tuning: deepClone(character.tuning ?? {}),
    visual: deepClone(character.visual ?? {}),
    editorSections: deepClone(character.editorSections ?? []),
    basicAttack: {
      ...character.basicAttack,
      triggers: deepClone(character.basicAttack?.triggers ?? []),
    },
    ultimate: {
      ...character.ultimate,
    },
  };
}

export function summarizeTriggers(character) {
  return (character.basicAttack?.triggers ?? []).map((trigger) => {
    switch (trigger.type) {
      case "interval":
        return `时间轴 ${trigger.interval}s`;
      case "proximity":
        return `范围 ${trigger.radius ?? character.stats.attackRange}`;
      case "trail":
        return `轨迹 ${trigger.interval}s`;
      case "onWallBounce":
        return "撞墙触发";
      case "collision":
        return "碰撞切割";
      default:
        return trigger.type;
    }
  });
}

function radialBurst(api, actor, count, options = {}) {
  const total = options.count ?? count;
  const phaseOffset = options.phaseOffset ?? 0;
  for (let index = 0; index < total; index += 1) {
    const angle = phaseOffset + (Math.PI * 2 * index) / total;
    api.spawnProjectile({
      position: options.position ?? actor.position,
      direction: { x: Math.cos(angle), y: Math.sin(angle) },
      speed: options.speed ?? 280,
      radius: options.radius ?? 6,
      damage: options.damage ?? 10,
      color: options.color ?? actor.color,
      lifetime: options.lifetime ?? 2.2,
      bounces: options.bounces ?? 1,
      knockback: options.knockback ?? 140,
      shape: options.shape,
      length: options.length,
      pierce: options.pierce,
    });
  }
}

function scheduleBurstRain(api, options = {}) {
  const startDelay = options.startDelay ?? 0;
  const waves = options.waves ?? 10;
  const duration = options.duration ?? 2;
  const shots = options.shots ?? 12;

  for (let wave = 0; wave < waves; wave += 1) {
    const offset = waves <= 1 ? 0 : (duration / (waves - 1)) * wave;
    api.schedule(startDelay + offset, ({ actor, api: scheduledApi }) => {
      if (!actor.alive) {
        return;
      }
      radialBurst(scheduledApi, actor, shots, {
        ...options,
        phaseOffset: (wave % 2) * ((Math.PI * 2) / shots / 2),
      });
      scheduledApi.shake(5, 0.08);
    });
  }
}

// ─── 赌徒·轮盘 辅助函数 ───────────────────────────────────────────────────────
function applyWheelResult(result, actor, api, game, amount) {
  const others = game.state.actors.filter((a) => a.alive && a.id !== actor.id);
  switch (result) {
    case 1: {
      if (!others.length) { api.emitText("无目标", actor.position, "#aaa"); break; }
      const t1 = others[Math.floor(Math.random() * others.length)];
      game.applyDamage(t1, amount, { type: "skill", color: "#ff4444", attacker: actor });
      api.emitText(`${t1.name} -${amount}`, actor.position, "#ff6655");
      break;
    }
    case 2: {
      if (!others.length) { api.emitText("无目标", actor.position, "#aaa"); break; }
      const t2 = others[Math.floor(Math.random() * others.length)];
      game.healActor(t2, amount);
      api.emitText(`${t2.name} +${amount}`, actor.position, "#55ff88");
      break;
    }
    case 3:
      game.applyDamage(actor, amount, { type: "skill", color: "#ff8844" });
      api.emitText(`自己 -${amount}`, actor.position, "#ff8844");
      break;
    case 4:
      api.heal(amount);
      api.emitText(`自己 +${amount}`, actor.position, "#88ff66");
      break;
    case 5:
      for (const t5 of others) game.applyDamage(t5, amount, { type: "skill", color: "#ff3333", attacker: actor });
      api.emitText(`全场 -${amount}！`, actor.position, "#ff3333");
      api.shake(10, 0.2);
      break;
    case 6:
      for (const t6 of others) game.healActor(t6, amount);
      api.emitText(`全场 +${amount}！`, actor.position, "#33dd88");
      break;
    default: break;
  }
}

function computeWheelFinalAngle(segments, result) {
  const N = segments.length;
  const segAngle = (Math.PI * 2) / N;
  const winIdx = segments.indexOf(result);
  const rawAngle = -Math.PI / 2 - winIdx * segAngle - segAngle / 2;
  const normalized = ((rawAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return normalized + 6 * Math.PI * 2; // 6 full rotations before landing
}

export const CHARACTER_LIBRARY = [
  defineCharacter({
    id: "bee-stinger",
    name: "蜂刺",
    title: "极限速射",
    color: "#ffc94d",
    description: "超轻血量换来最强单体点杀，光针频率高、弹体细、压制力极强。",
    visual: {
      motif: "bee",
    },
    stats: {
      maxHp: 70,
      speed: 204,
      maxEssence: 3,
      attackRange: 320,
      radius: 16,
    },
    tuning: {
      basic: {
        speed: 520,
        radius: 2.6,
        damage: 2,
        lifetime: 1.1,
        knockback: 28,
        length: 16,
      },
      ultimate: {
        lockDuration: 0.5,
        startDelay: 0.5,
        duration: 2,
        waves: 12,
        shots: 16,
        speed: 360,
        radius: 2.4,
        damage: 2,
        lifetime: 1.5,
        knockback: 48,
        length: 13,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.attackRange", "索敌范围", { min: 40, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "发射间隔", { min: 0.05, step: 0.01, unit: "s" }),
          editableField("tuning.basic.damage", "光针伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.speed", "光针速度", { min: 60, step: 5 }),
          editableField("tuning.basic.lifetime", "光针持续", { min: 0.1, step: 0.05, unit: "s" }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.startDelay", "蓄力时间", { min: 0, step: 0.05, unit: "s" }),
          editableField("tuning.ultimate.duration", "持续时间", { min: 0.2, step: 0.1, unit: "s" }),
          editableField("tuning.ultimate.waves", "发射波数", { min: 1, step: 1 }),
          editableField("tuning.ultimate.shots", "每波针数", { min: 1, step: 1 }),
          editableField("tuning.ultimate.damage", "单针伤害", { min: 1, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "追踪光针",
      triggers: [{ type: "interval", interval: 0.33 }],
      execute({ actor, api }) {
        const target = api.findNearestEnemy(actor.stats.attackRange);
        if (!target) {
          return;
        }
        const tuning = actor.definition.tuning.basic;
        api.spawnProjectile({
          position: actor.position,
          direction: api.directionTo(target),
          speed: tuning.speed,
          radius: tuning.radius,
          damage: tuning.damage,
          color: "#fff2a6",
          lifetime: tuning.lifetime,
          bounces: 0,
          knockback: tuning.knockback,
          shape: "needle",
          length: tuning.length,
        });
      },
    },
    ultimate: {
      name: "死亡绽放",
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.ultimate;
        api.lockMovement(tuning.lockDuration);
        api.emitText("蓄针", actor.position, "#ffe89f");
        api.shake(10, 0.18);
        scheduleBurstRain(api, {
          startDelay: tuning.startDelay,
          duration: tuning.duration,
          waves: tuning.waves,
          shots: tuning.shots,
          speed: tuning.speed,
          radius: tuning.radius,
          damage: tuning.damage,
          color: "#fff5bc",
          lifetime: tuning.lifetime,
          bounces: 0,
          knockback: tuning.knockback,
          shape: "needle",
          length: tuning.length,
        });
      },
    },
  }),
  defineCharacter({
    id: "plague-mist",
    name: "瘟疫",
    title: "尾迹封锁",
    color: "#70db5d",
    description: "移动就会泼洒毒液，靠持续减速和掉血封死走位，再用毒爆收割。",
    visual: {
      motif: "plague",
    },
    stats: {
      maxHp: 100,
      speed: 176,
      maxEssence: 2,
      attackRange: 150,
      radius: 18,
    },
    tuning: {
      basic: {
        trailRadius: 17,
        trailLifetime: 2,
        poisonDuration: 1.1,
        poisonDamage: 1,
        tickInterval: 0.5,
        slowFactor: 0.62,
        slowDuration: 0.6,
      },
      ultimate: {
        pulseRadius: 28,
        poisonedDamage: 10,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.attackRange", "控制范围", { min: 40, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "尾迹间隔", { min: 0.05, step: 0.01, unit: "s" }),
          editableField("tuning.basic.trailLifetime", "尾迹持续", { min: 0.2, step: 0.1, unit: "s" }),
          editableField("tuning.basic.poisonDamage", "中毒伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.tickInterval", "掉血间隔", { min: 0.1, step: 0.1, unit: "s" }),
          editableField("tuning.basic.slowFactor", "减速倍率", { min: 0.1, max: 1, step: 0.01 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.poisonedDamage", "毒爆伤害", { min: 1, step: 1 }),
          editableField("tuning.ultimate.pulseRadius", "爆炸范围", { min: 10, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "剧毒尾迹",
      triggers: [{ type: "trail", interval: 0.14 }],
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.basic;
        const backward = api.normalize({
          x: -actor.velocity.x,
          y: -actor.velocity.y,
        });
        api.createTrail({
          position: {
            x: actor.position.x + backward.x * 11,
            y: actor.position.y + backward.y * 11,
          },
          radius: tuning.trailRadius,
          lifetime: tuning.trailLifetime,
          color: "#8af46d",
          poisonDuration: tuning.poisonDuration,
          poisonDamage: tuning.poisonDamage,
          tickInterval: tuning.tickInterval,
          slowFactor: tuning.slowFactor,
          slowDuration: tuning.slowDuration,
        });
      },
    },
    ultimate: {
      name: "全屏毒爆",
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.ultimate;
        const exploded = api.explodeOwnedTrails({
          pulseRadius: tuning.pulseRadius,
          pulseColor: "#c2ff81",
          poisonedDamage: tuning.poisonedDamage,
        });
        if (!exploded) {
          api.emitText("无尾迹", actor.position, "#b8ff84");
        }
        api.shake(15, 0.28);
      },
    },
  }),
  defineCharacter({
    id: "meat-grinder",
    name: "绞肉机",
    title: "近战碾碎",
    color: "#ff685d",
    description: "依靠锯齿碰撞直接切血，免疫地图尖刺，还能在击杀后瞬间回血继续滚雪球。",
    visual: {
      motif: "grinder",
    },
    stats: {
      maxHp: 150,
      speed: 164,
      maxEssence: 4,
      attackRange: 80,
      radius: 21,
    },
    tuning: {
      basic: {
        contactDamage: 5,
      },
      passive: {
        healOnKill: 30,
      },
      ultimate: {
        radiusScale: 1.5,
        duration: 6,
        chaseStrength: 6.5,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.radius", "球体半径", { min: 8, step: 1 }),
        ],
      },
      {
        title: "平A与被动",
        fields: [
          editableField("basicAttack.triggers.0.cooldown", "碰撞冷却", { min: 0.01, step: 0.01, unit: "s" }),
          editableField("tuning.basic.contactDamage", "碰撞伤害", { min: 1, step: 1 }),
          editableField("tuning.passive.healOnKill", "击杀回血", { min: 0, step: 1 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.radiusScale", "体型倍率", { min: 1, step: 0.1 }),
          editableField("tuning.ultimate.duration", "持续时间", { min: 0.5, step: 0.1, unit: "s" }),
          editableField("tuning.ultimate.chaseStrength", "追击强度", { min: 0.5, step: 0.1 }),
        ],
      },
    ],
    onSpawn({ actor }) {
      actor.state.hazardImmune = true;
    },
    onKill({ actor, api }) {
      api.heal(actor.definition.tuning.passive.healOnKill);
      api.emitText(`+${actor.definition.tuning.passive.healOnKill}`, actor.position, "#ffd5c9");
    },
    basicAttack: {
      name: "高频锯齿",
      triggers: [{ type: "collision", cooldown: 0.16 }],
      execute({ actor, event, api }) {
        if (!event?.other?.alive) {
          return;
        }
        api.dealDamage(event.other, actor.definition.tuning.basic.contactDamage, {
          color: "#ff9a84",
        });
        api.shake(6, 0.08);
      },
    },
    ultimate: {
      name: "嗜血冲锋",
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.ultimate;
        const target = api.findLowestHpEnemy();
        api.setRadiusScale(tuning.radiusScale, tuning.duration);
        api.grantInvulnerable(tuning.duration);
        api.forceChase(target, tuning.duration, tuning.chaseStrength);
        api.emitText("嗜血", actor.position, "#ffd2c8");
        api.shake(18, 0.32);
      },
    },
  }),
  defineCharacter({
    id: "storm-magnet",
    name: "磁暴",
    title: "反弹雷环",
    color: "#69beff",
    description: "一旦撞墙就释放电弧，靠场地几何制造范围压制，再用延迟落雷惩罚站位。",
    visual: {
      motif: "magnet",
    },
    stats: {
      maxHp: 100,
      speed: 182,
      maxEssence: 3,
      attackRange: 140,
      radius: 18,
    },
    tuning: {
      basic: {
        pulseRadius: 96,
        damage: 5,
        knockback: 150,
      },
      ultimate: {
        delay: 1,
        radius: 28,
        damage: 30,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.attackRange", "判定范围", { min: 20, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.cooldown", "撞墙冷却", { min: 0, step: 0.01, unit: "s" }),
          editableField("tuning.basic.damage", "脉冲伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.pulseRadius", "脉冲半径", { min: 10, step: 1 }),
          editableField("tuning.basic.knockback", "脉冲击退", { min: 0, step: 5 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.delay", "落雷延迟", { min: 0, step: 0.05, unit: "s" }),
          editableField("tuning.ultimate.radius", "落雷范围", { min: 10, step: 1 }),
          editableField("tuning.ultimate.damage", "落雷伤害", { min: 1, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "弹射电弧",
      triggers: [{ type: "onWallBounce", cooldown: 0.02 }],
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.basic;
        api.spawnPulse({
          radius: tuning.pulseRadius,
          damage: tuning.damage,
          color: "#9ae1ff",
          knockback: tuning.knockback,
          requireLineOfSight: true,
          shake: 7,
        });
      },
    },
    ultimate: {
      name: "天怒神罚",
      execute({ actor, api, enemies }) {
        const tuning = actor.definition.tuning.ultimate;
        let strikeCount = 0;
        enemies
          .filter((enemy) => enemy.alive)
          .forEach((enemy) => {
            strikeCount += 1;
            api.spawnStrike({
              position: enemy.position,
              delay: tuning.delay,
              radius: tuning.radius,
              damage: tuning.damage,
              color: "#c9eeff",
              strikeType: "lightning",
            });
          });
        if (strikeCount > 0) {
          api.shake(16, 0.3);
        }
      },
    },
  }),
  defineCharacter({
    id: "turret-smith",
    name: "炮台",
    title: "阵地推进",
    color: "#d7a35f",
    description: "定期在移动路径上铺设炮台，拖住战场节奏后再一键升级成机枪塔进行火力覆盖。",
    visual: {
      motif: "turret",
    },
    stats: {
      maxHp: 120,
      speed: 156,
      maxEssence: 3,
      attackRange: 230,
      radius: 18,
    },
    tuning: {
      basic: {
        maxCount: 3,
        radius: 15,
        fireInterval: 1.2,
        damage: 5,
        range: 250,
        maxHits: 2,
      },
      ultimate: {
        damage: 8,
        fireIntervalMultiplier: 0.5,
        maxHits: 3,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.attackRange", "控场范围", { min: 20, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "召唤间隔", { min: 0.2, step: 0.1, unit: "s" }),
          editableField("tuning.basic.maxCount", "炮台上限", { min: 1, step: 1 }),
          editableField("tuning.basic.damage", "炮台伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.fireInterval", "开火间隔", { min: 0.1, step: 0.05, unit: "s" }),
          editableField("tuning.basic.maxHits", "耐撞次数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.damage", "升级伤害", { min: 1, step: 1 }),
          editableField("tuning.ultimate.fireIntervalMultiplier", "攻速倍率", { min: 0.1, step: 0.05 }),
          editableField("tuning.ultimate.maxHits", "升级耐撞", { min: 1, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "微型无人机",
      triggers: [{ type: "interval", interval: 5 }],
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.basic;
        const spawned = api.summonTurret({
          maxCount: tuning.maxCount,
          radius: tuning.radius,
          fireInterval: tuning.fireInterval,
          damage: tuning.damage,
          range: tuning.range,
          maxHits: tuning.maxHits,
          color: "#f1c27b",
          projectileColor: "#ffd89b",
        });
        if (!spawned) {
          api.emitText("已满", actor.position, "#f4d4a8");
        }
      },
    },
    ultimate: {
      name: "火力覆盖",
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.ultimate;
        const upgraded = api.upgradeTurrets({
          damage: tuning.damage,
          fireIntervalMultiplier: tuning.fireIntervalMultiplier,
          maxHits: tuning.maxHits,
          color: "#ffe4a9",
          projectileColor: "#fff1b3",
        });
        if (!upgraded) {
          api.emitText("无炮台", actor.position, "#ffe2aa");
        }
        api.shake(14, 0.25);
      },
    },
  }),
  defineCharacter({
    id: "bomber-rex",
    name: "轰炸机",
    title: "重火力轰炸",
    color: "#ff7a4d",
    description: "每隔2.5秒向随机敌人当前位置投掷高爆榴弹，落地后产生延迟爆炸。死亡后尸体附近区域会在5秒倒计时后遭到一次重轰炸。大招停滞无敌，随后向场地倾泻五枚重型榴弹。",
    visual: { motif: "bomber" },
    stats: {
      maxHp: 90,
      speed: 168,
      maxEssence: 3,
      attackRange: 260,
      radius: 18,
    },
    tuning: {
      basic: {
        delay: 0.5,
        radius: 38,
        damage: 12,
      },
      passive: {
        deathDelay: 5,
        deathRadius: 52,
        deathDamage: 30,
        deathScatter: 28,
      },
      ultimate: {
        lockDuration: 1,
        count: 5,
        delay: 0.7,
        radius: 44,
        damage: 14,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "发射间隔", { min: 0.5, step: 0.1, unit: "s" }),
          editableField("tuning.basic.delay", "引爆延迟", { min: 0.1, step: 0.05, unit: "s" }),
          editableField("tuning.basic.radius", "爆炸范围", { min: 10, step: 1 }),
          editableField("tuning.basic.damage", "爆炸伤害", { min: 1, step: 1 }),
        ],
      },
      {
        title: "被动",
        fields: [
          editableField("tuning.passive.deathDelay", "遗爆延迟", { min: 0.5, step: 0.1, unit: "s" }),
          editableField("tuning.passive.deathRadius", "遗爆范围", { min: 10, step: 1 }),
          editableField("tuning.passive.deathDamage", "遗爆伤害", { min: 1, step: 1 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.lockDuration", "停滞时间", { min: 0.2, step: 0.1, unit: "s" }),
          editableField("tuning.ultimate.count", "榴弹数量", { min: 1, step: 1 }),
          editableField("tuning.ultimate.damage", "大招伤害", { min: 1, step: 1 }),
          editableField("tuning.ultimate.radius", "大招范围", { min: 10, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "抛物线榴弹",
      triggers: [{ type: "interval", interval: 2.5 }],
      execute({ actor, api, enemies }) {
        const living = enemies.filter((e) => e.alive);
        if (!living.length) return;
        const target = living[Math.floor(Math.random() * living.length)];
        const pos = { ...target.position };
        const tuning = actor.definition.tuning.basic;
        api.spawnStrike({ position: pos, delay: tuning.delay, radius: tuning.radius, damage: tuning.damage, color: "#ff6633" });
      },
    },
    onDeath({ actor, api }) {
      const tuning = actor.definition.tuning.passive;
      const angle = Math.random() * Math.PI * 2;
      const offset = Math.random() * tuning.deathScatter;
      const position = {
        x: actor.position.x + Math.cos(angle) * offset,
        y: actor.position.y + Math.sin(angle) * offset,
      };

      api.spawnStrike({
        position,
        delay: tuning.deathDelay,
        radius: tuning.deathRadius,
        damage: tuning.deathDamage,
        color: "#ff6633",
      });
    },
    ultimate: {
      name: "地毯式轰炸",
      execute({ actor, api, enemies }) {
        const tuning = actor.definition.tuning.ultimate;
        api.lockMovement(tuning.lockDuration);
        api.grantInvulnerable(tuning.lockDuration);
        api.emitText("轰炸", actor.position, "#ff8866");
        api.shake(16, 0.28);
        const living = enemies.filter((e) => e.alive);
        for (let i = 0; i < tuning.count; i += 1) {
          const capturedTarget = living.length ? living[Math.floor(Math.random() * living.length)] : null;
          api.schedule(tuning.lockDuration + i * 0.28, ({ actor: a, api: sApi, game }) => {
            if (!a.alive) return;
            const center = game.state.arena.center;
            const pos = capturedTarget?.alive
              ? { ...capturedTarget.position }
              : { x: center.x + (Math.random() - 0.5) * 220, y: center.y + (Math.random() - 0.5) * 150 };
            sApi.spawnStrike({ position: pos, delay: tuning.delay, radius: tuning.radius, damage: tuning.damage, color: "#ff5522" });
          });
        }
      },
    },
  }),
  defineCharacter({
    id: "blood-leech",
    name: "汲取者",
    title: "锁链吸血",
    color: "#cc4466",
    description: "每隔4秒向最近敌人发射吸血锁链，命中后每0.5秒吸取2滴血，目标死亡则断开。大招移速减半，向所有敌人强制发射无法断开的锁链。",
    visual: { motif: "leech" },
    stats: {
      maxHp: 110,
      speed: 158,
      maxEssence: 3,
      attackRange: 280,
      radius: 18,
    },
    tuning: {
      basic: {
        drainDamage: 2,
        healAmount: 2,
        tickInterval: 0.5,
        maxTicks: 6,
      },
      ultimate: {
        drainDamage: 3,
        healAmount: 3,
        tickInterval: 0.5,
        maxTicks: 6,
        speedDebuff: 0.5,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.attackRange", "索链范围", { min: 40, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "发射间隔", { min: 1, step: 0.5, unit: "s" }),
          editableField("tuning.basic.drainDamage", "每次吸血", { min: 1, step: 1 }),
          editableField("tuning.basic.healAmount", "每次回血", { min: 0, step: 1 }),
          editableField("tuning.basic.maxTicks", "最大次数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.drainDamage", "大招吸血", { min: 1, step: 1 }),
          editableField("tuning.ultimate.healAmount", "大招回血", { min: 0, step: 1 }),
          editableField("tuning.ultimate.maxTicks", "大招次数", { min: 1, step: 1 }),
        ],
      },
    ],
    onSpawn({ actor }) {
      actor.state.drainActive = false;
    },
    basicAttack: {
      name: "鲜血锁链",
      triggers: [{ type: "interval", interval: 4 }],
      execute({ actor, api }) {
        if (actor.state.drainActive) return;
        const tuning = actor.definition.tuning.basic;
        const target = api.findNearestEnemy();
        if (!target) return;

        actor.state.drainActive = true;
        const targetId = target.id;
        const totalDuration = tuning.tickInterval * tuning.maxTicks;
        const beam = api.createDrainBeam({ targetId, duration: totalDuration, color: actor.color });

        let ticks = 0;
        function tick({ actor: a, api: sApi, game }) {
          const currentTarget = game.findActorById(targetId);
          if (!currentTarget?.alive || !a.alive || ticks >= tuning.maxTicks) {
            a.state.drainActive = false;
            beam.lifetime = 0;
            return;
          }
          sApi.dealDamage(currentTarget, tuning.drainDamage);
          sApi.heal(tuning.healAmount);
          ticks += 1;
          sApi.schedule(tuning.tickInterval, tick);
        }
        api.schedule(tuning.tickInterval, tick);
      },
    },
    ultimate: {
      name: "血池降临",
      execute({ actor, api, enemies }) {
        const tuning = actor.definition.tuning.ultimate;
        const totalDuration = tuning.tickInterval * tuning.maxTicks;
        api.setSpeedMultiplier(tuning.speedDebuff, totalDuration);
        api.emitText("汲取", actor.position, "#ff6688");
        api.shake(12, 0.22);

        const targets = enemies.filter((e) => e.alive);
        if (!targets.length) return;

        targets.forEach((target) => {
          const targetId = target.id;
          const beam = api.createDrainBeam({ targetId, duration: totalDuration, color: "#ff4466", thick: true });
          let ticks = 0;
          function tick({ actor: a, api: sApi, game }) {
            const currentTarget = game.findActorById(targetId);
            if (!currentTarget?.alive || !a.alive || ticks >= tuning.maxTicks) {
              beam.lifetime = 0;
              return;
            }
            sApi.dealDamage(currentTarget, tuning.drainDamage);
            sApi.heal(tuning.healAmount);
            ticks += 1;
            sApi.schedule(tuning.tickInterval, tick);
          }
          api.schedule(tuning.tickInterval, tick);
        });
      },
    },
  }),
  defineCharacter({
    id: "phantom-mirror",
    name: "分身师",
    title: "分身迷惑",
    color: "#aa88ee",
    description: "每次碰撞敌方小球或撞墙后都有概率在原地留下一个静止分身，分身被撞击3次后爆炸造成范围伤害，最多同时存在3个。大招激活所有分身向最近敌人高速冲撞。",
    visual: { motif: "mirror" },
    stats: {
      maxHp: 80,
      speed: 186,
      maxEssence: 2,
      attackRange: 200,
      radius: 18,
    },
    tuning: {
      basic: {
        spawnChance: 0.5,
        maxCount: 3,
        maxHits: 3,
        explodeDamage: 8,
        explodeRadius: 48,
      },
      ultimate: {
        activateDamage: 15,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("tuning.basic.spawnChance", "生成概率", { min: 0.05, max: 1, step: 0.05 }),
          editableField("tuning.basic.maxCount", "分身上限", { min: 1, step: 1 }),
          editableField("tuning.basic.maxHits", "分身耐撞", { min: 1, step: 1 }),
          editableField("tuning.basic.explodeDamage", "爆炸伤害", { min: 1, step: 1 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.activateDamage", "冲撞伤害", { min: 1, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "光影镜像",
      triggers: [
        { type: "collision", cooldown: 0 },
        { type: "onWallBounce", cooldown: 0 },
      ],
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.basic;
        if (Math.random() >= tuning.spawnChance) return;
        api.spawnDecoy({
          maxCount: tuning.maxCount,
          maxHits: tuning.maxHits,
          explodeDamage: tuning.explodeDamage,
          explodeRadius: tuning.explodeRadius,
        });
      },
    },
    ultimate: {
      name: "镜像杀阵",
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.ultimate;
        const count = api.activateDecoys({ activateDamage: tuning.activateDamage });
        if (!count) {
          api.emitText("无分身", actor.position, "#ccaaff");
        } else {
          api.shake(14, 0.24);
          api.emitText("激活", actor.position, "#e0ccff");
        }
      },
    },
  }),
  defineCharacter({
    id: "prism-refract",
    name: "激光",
    title: "折射者",
    color: "#e8f0ff",
    description: "每3秒蓄力后发射一道随机方向的红色激光，可反射3次，命中造成6点伤害并使敌人僵直0.2秒。大招停止移动，同时射出3道持续3秒的粗壮激光，每道各命中一次敌人造成10点伤害。",
    visual: { motif: "prism" },
    stats: {
      maxHp: 85,
      speed: 178,
      maxEssence: 3,
      attackRange: 300,
      radius: 17,
    },
    tuning: {
      basic: {
        chargeDuration: 0.5,
        damage: 6,
        maxBounces: 3,
        stunDuration: 0.2,
        lifetime: 0.45,
      },
      ultimate: {
        damage: 10,
        maxBounces: 5,
        duration: 3,
        laserCount: 3,
        stunDuration: 0.2,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "发射间隔", { min: 0.5, step: 0.1, unit: "s" }),
          editableField("tuning.basic.chargeDuration", "蓄力时间", { min: 0.1, step: 0.05, unit: "s" }),
          editableField("tuning.basic.damage", "激光伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.maxBounces", "反射次数", { min: 0, step: 1 }),
          editableField("tuning.basic.lifetime", "光束持续", { min: 0.1, step: 0.05, unit: "s" }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.damage", "激光伤害", { min: 1, step: 1 }),
          editableField("tuning.ultimate.maxBounces", "反射次数", { min: 0, step: 1 }),
          editableField("tuning.ultimate.duration", "持续时间", { min: 0.5, step: 0.5, unit: "s" }),
          editableField("tuning.ultimate.laserCount", "激光数量", { min: 1, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "高能射线",
      triggers: [{ type: "interval", interval: 3 }],
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.basic;
        api.lockMovement(tuning.chargeDuration);
        api.emitText("蓄力", actor.position, "#ff9999");
        api.schedule(tuning.chargeDuration, ({ actor: a, api: sApi }) => {
          if (!a.alive) return;
          const angle = Math.random() * Math.PI * 2;
          sApi.spawnLaser({
            direction: { x: Math.cos(angle), y: Math.sin(angle) },
            maxBounces: tuning.maxBounces,
            damage: tuning.damage,
            stunDuration: tuning.stunDuration,
            color: "#ff4444",
            width: 3,
            lifetime: tuning.lifetime,
            persistent: false,
          });
          sApi.shake(6, 0.1);
        });
      },
    },
    ultimate: {
      name: "死光扫射",
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.ultimate;
        api.lockMovement(tuning.duration);
        api.emitText("死光", actor.position, "#ff6644");
        api.shake(16, 0.28);
        const phaseOffset = Math.random() * Math.PI * 2;
        for (let i = 0; i < tuning.laserCount; i += 1) {
          const angle = phaseOffset + (Math.PI * 2 * i) / tuning.laserCount;
          api.spawnLaser({
            direction: { x: Math.cos(angle), y: Math.sin(angle) },
            maxBounces: tuning.maxBounces,
            damage: tuning.damage,
            stunDuration: tuning.stunDuration,
            color: "#ff6600",
            width: 7,
            lifetime: tuning.duration,
            persistent: true,
          });
        }
      },
    },
  }),
  defineCharacter({
    id: "holy-shield",
    name: "盾狗",
    title: "防守反击",
    color: "#f5d070",
    description: "碰撞两次充能金色护盾，护盾期间免疫所有伤害。大招召唤等同自身半径长度的环绕圣剑，再次释放则延长圣剑。",
    visual: { motif: "bastion" },
    stats: {
      maxHp: 140,
      speed: 152,
      maxEssence: 3,
      attackRange: 80,
      radius: 20,
    },
    tuning: {
      basic: {
        shieldDuration: 5,
        chargesNeeded: 2,
      },
      ultimate: {
        swordDamage: 8,
        swordStep: 20,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
          editableField("stats.radius", "球体半径", { min: 8, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("tuning.basic.shieldDuration", "护盾时长", { min: 1, step: 0.5, unit: "s" }),
          editableField("tuning.basic.chargesNeeded", "充能次数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.swordDamage", "圣剑伤害", { min: 1, step: 1 }),
          editableField("tuning.ultimate.swordStep", "每次增加长度", { min: 1, step: 1 }),
        ],
      },
    ],
    onSpawn({ actor }) {
      actor.state.shieldCharges = 0;
      actor.state.swordLength = 0;
      actor.state.swordOrbitAngle = 0;
      actor.state.swordDamageCooldowns = new Map();
    },
    basicAttack: {
      name: "充能护甲",
      triggers: [
        { type: "collision", cooldown: 0.3 },
        { type: "onWallBounce", cooldown: 0.3 },
      ],
      execute({ actor, api }) {
        if (actor.state.invulnerableTime > 0) return;
        const tuning = actor.definition.tuning.basic;
        actor.state.shieldCharges = (actor.state.shieldCharges ?? 0) + 1;
        if (actor.state.shieldCharges >= tuning.chargesNeeded) {
          actor.state.shieldCharges = 0;
          api.grantInvulnerable(tuning.shieldDuration);
          api.emitText("圣盾！", actor.position, "#f5d070");
          api.shake(10, 0.18);
        }
      },
    },
    ultimate: {
      name: "绝对领域",
      execute({ actor, api }) {
        const step = actor.definition.tuning.ultimate.swordStep;
        if (actor.state.swordLength <= 0) {
          actor.state.swordLength = actor.baseRadius + step;
          api.emitText("圣剑", actor.position, "#f5d070");
        } else {
          actor.state.swordLength += step;
          api.emitText(`剑+${step}`, actor.position, "#fff2b0");
        }
        api.shake(12, 0.2);
      },
    },
  }),
  defineCharacter({
    id: "frost-core",
    name: "绝对零度",
    title: "极致减速",
    color: "#88ccff",
    description: "不断向八个随机方向散射穿透型冰刺，每次命中叠加一层减速，叠满3层冻结敌人1.5秒。大招连续释放4次平A，快速堆叠冻结层数。",
    visual: { motif: "frost" },
    stats: {
      maxHp: 120,
      speed: 170,
      maxEssence: 4,
      attackRange: 300,
      radius: 18,
    },
    tuning: {
      basic: {
        damage: 3,
        speed: 340,
        lifetime: 1.4,
        knockback: 60,
        pierceCount: 2,
        slowFactor: 0.8,
        stackDuration: 2,
        maxStacks: 3,
        freezeDuration: 1.5,
      },
      ultimate: {
        shotCount: 4,
        shotDelay: 0.2,
        needleCount: 8,
        damage: 3,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A",
        fields: [
          editableField("basicAttack.triggers.0.interval", "发射间隔", { min: 0.2, step: 0.05, unit: "s" }),
          editableField("tuning.basic.damage", "冰刺伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.slowFactor", "减速倍率", { min: 0.05, max: 0.95, step: 0.05 }),
          editableField("tuning.basic.freezeDuration", "冻结时间", { min: 0.5, step: 0.1, unit: "s" }),
        ],
      },
      {
        title: "大招",
        fields: [
          editableField("tuning.ultimate.shotCount", "发射次数", { min: 1, step: 1 }),
          editableField("tuning.ultimate.shotDelay", "射击间隔", { min: 0.05, step: 0.05, unit: "s" }),
          editableField("tuning.ultimate.needleCount", "每次冰刺数", { min: 1, step: 1 }),
          editableField("tuning.ultimate.damage", "冰刺伤害", { min: 1, step: 1 }),
        ],
      },
    ],
    basicAttack: {
      name: "寒冰散射",
      triggers: [{ type: "interval", interval: 1.5 }],
      execute({ actor, api }) {
        const tuning = actor.definition.tuning.basic;
        for (let i = 0; i < 8; i += 1) {
          const angle = Math.random() * Math.PI * 2;
          api.spawnProjectile({
            position: actor.position,
            direction: { x: Math.cos(angle), y: Math.sin(angle) },
            speed: tuning.speed,
            radius: 4.5,
            damage: tuning.damage,
            color: "#c8f0ff",
            lifetime: tuning.lifetime,
            bounces: 0,
            knockback: tuning.knockback,
            pierce: tuning.pierceCount,
            shape: "needle",
            length: 14,
            frostConfig: {
              maxStacks: tuning.maxStacks,
              stackDuration: tuning.stackDuration,
              slowFactor: tuning.slowFactor,
              freezeDuration: tuning.freezeDuration,
            },
          });
        }
      },
    },
    ultimate: {
      name: "寒冰连射",
      execute({ actor, api }) {
        const basic = actor.definition.tuning.basic;
        const ult = actor.definition.tuning.ultimate;
        const fireOnce = ({ actor: a, api: sApi }) => {
          for (let i = 0; i < ult.needleCount; i += 1) {
            const angle = Math.random() * Math.PI * 2;
            sApi.spawnProjectile({
              position: a.position,
              direction: { x: Math.cos(angle), y: Math.sin(angle) },
              speed: basic.speed,
              radius: 4.5,
              damage: ult.damage,
              color: "#c8f0ff",
              lifetime: basic.lifetime,
              bounces: 0,
              knockback: basic.knockback,
              pierce: basic.pierceCount,
              shape: "needle",
              length: 14,
              frostConfig: {
                maxStacks: basic.maxStacks,
                stackDuration: basic.stackDuration,
                slowFactor: basic.slowFactor,
                freezeDuration: basic.freezeDuration,
              },
            });
          }
        };
        fireOnce({ actor, api });
        for (let s = 1; s < ult.shotCount; s += 1) {
          api.schedule(ult.shotDelay * s, fireOnce);
        }
      },
    },
  }),

  // ─── 鹰眼·狙击手 ──────────────────────────────────────────────────────────
  defineCharacter({
    id: "eagle-eye",
    name: "鹰眼",
    title: "狙击手",
    color: "#4a6038",
    description: "极限视距与单点秒杀。锁定血量最少的敌人，静止瞄准后发射可被遮挡的高伤子弹；击杀即刷新冷却，连杀不停。大招进入隐身无敌状态，向全场所有敌人各补一枪。",
    stats: {
      maxHp: 80,
      speed: 165,
      maxEssence: 3,
      attackRange: 9999,
      radius: 17,
    },
    tuning: {
      basic: {
        aimDuration: 2,
        bulletSpeed: 1200,
        damage: 20,
        knockback: 30,
      },
      ult: {
        stealthDuration: 0.4,
        shotDelay: 0.35,
        damage: 20,
        bulletSpeed: 1200,
        knockback: 50,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A · 致命锁定",
        fields: [
          editableField("basicAttack.triggers.0.interval", "狙击间隔", { min: 0.5, step: 0.5, unit: "s" }),
          editableField("tuning.basic.aimDuration", "瞄准时间", { min: 0.2, max: 5, step: 0.1, unit: "s" }),
          editableField("tuning.basic.bulletSpeed", "子弹速度", { min: 200, step: 50 }),
          editableField("tuning.basic.damage", "单发伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.knockback", "击退力", { min: 0, step: 5 }),
        ],
      },
      {
        title: "大招 · 死神降临",
        fields: [
          editableField("tuning.ult.stealthDuration", "隐身基础时长", { min: 0.1, max: 2, step: 0.1, unit: "s" }),
          editableField("tuning.ult.shotDelay", "各枪间隔", { min: 0.1, max: 2, step: 0.05, unit: "s" }),
          editableField("tuning.ult.damage", "单发伤害", { min: 1, step: 1 }),
          editableField("tuning.ult.knockback", "击退力", { min: 0, step: 5 }),
        ],
      },
    ],
    basicAttack: {
      name: "致命锁定",
      triggers: [{ type: "interval", interval: 4 }],
      execute({ actor, api }) {
        const t = actor.definition.tuning.basic;
        const target = api.findLowestHpEnemy();
        if (!target) return;

        actor.state.aimingTargetId = target.id;
        api.lockMovement(t.aimDuration);

        api.schedule(t.aimDuration, ({ actor, api }) => {
          if (!actor.alive) return;
          actor.state.aimingTargetId = null;
          if (!target.alive) return;

          const dx = target.position.x - actor.position.x;
          const dy = target.position.y - actor.position.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len < 1) return;

          api.spawnProjectile({
            position: { ...actor.position },
            direction: { x: dx / len, y: dy / len },
            speed: t.bulletSpeed,
            radius: 4,
            damage: t.damage,
            color: "#ff3333",
            lifetime: 2.5,
            bounces: 0,
            knockback: t.knockback,
            pierce: 0,
          });
        });
      },
    },
    onKill({ actor }) {
      // 击杀刷新冷却，立即开始下一次瞄准
      for (const [key] of actor.cooldowns) {
        if (key.startsWith("interval:")) {
          actor.cooldowns.set(key, 0);
        }
      }
    },
    ultimate: {
      name: "死神降临",
      execute({ actor, api, enemies }) {
        const t = actor.definition.tuning.ult;
        const targets = enemies.filter((e) => e.alive);
        if (targets.length === 0) return;

        const totalDuration = t.stealthDuration + targets.length * t.shotDelay + 0.5;
        api.grantInvulnerable(totalDuration);
        actor.state.stealthTime = totalDuration;

        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          api.schedule(t.stealthDuration + i * t.shotDelay, ({ actor, api }) => {
            if (!actor.alive || !target.alive) return;

            const dx = target.position.x - actor.position.x;
            const dy = target.position.y - actor.position.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) return;

            api.spawnProjectile({
              position: { ...actor.position },
              direction: { x: dx / len, y: dy / len },
              speed: t.bulletSpeed,
              radius: 4,
              damage: t.damage,
              color: "#ff2222",
              lifetime: 2.5,
              bounces: 0,
              knockback: t.knockback,
              pierce: 0,
            });
          });
        }
      },
    },
  }),

  // ─── 风暴·气象台 ──────────────────────────────────────────────────────────
  defineCharacter({
    id: "storm-weather",
    name: "风暴",
    title: "气象台",
    color: "#7ea4b8",
    description: "全场搅局者。发射游荡气旋捕获并缴械敌人，被卷入者持续受到撕裂伤害；终极风暴同时释放三个巨型龙卷风，体型与速度大幅提升。",
    stats: {
      maxHp: 100,
      speed: 180,
      maxEssence: 3,
      attackRange: 600,
      radius: 18,
    },
    tuning: {
      basic: {
        radiusFactor: 1.0,
        speedFactor: 0.5,
        damage: 2,
        lifetime: 3,
      },
      ult: {
        count: 3,
        radiusFactor: 1.5,
        speedFactor: 1.0,
        damage: 4,
        lifetime: 5,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A · 微型气旋",
        fields: [
          editableField("basicAttack.triggers.0.interval", "发射间隔", { min: 0.5, step: 0.5, unit: "s" }),
          editableField("tuning.basic.radiusFactor", "气旋半径倍数", { min: 0.3, max: 4, step: 0.1 }),
          editableField("tuning.basic.speedFactor", "速度系数（×自身速度）", { min: 0.1, max: 2, step: 0.05 }),
          editableField("tuning.basic.damage", "每跳伤害", { min: 1, step: 1 }),
          editableField("tuning.basic.lifetime", "持续时间", { min: 0.5, max: 10, step: 0.5, unit: "s" }),
        ],
      },
      {
        title: "大招 · 终极风暴",
        fields: [
          editableField("tuning.ult.count", "龙卷风数量", { min: 1, max: 6, step: 1 }),
          editableField("tuning.ult.radiusFactor", "体型倍数（×自身半径）", { min: 0.5, max: 4, step: 0.1 }),
          editableField("tuning.ult.speedFactor", "速度系数（×自身速度）", { min: 0.1, max: 3, step: 0.1 }),
          editableField("tuning.ult.damage", "每跳伤害", { min: 1, step: 1 }),
          editableField("tuning.ult.lifetime", "持续时间", { min: 1, max: 12, step: 0.5, unit: "s" }),
        ],
      },
    ],
    basicAttack: {
      name: "微型气旋",
      triggers: [{ type: "interval", interval: 4 }],
      execute({ actor, api }) {
        const t = actor.definition.tuning.basic;
        const angle = Math.random() * Math.PI * 2;
        api.spawnTornado({
          radius: actor.baseRadius * t.radiusFactor,
          speed: actor.stats.speed * t.speedFactor,
          damage: t.damage,
          lifetime: t.lifetime,
          disarm: false,
          direction: { x: Math.cos(angle), y: Math.sin(angle) },
        });
      },
    },
    ultimate: {
      name: "终极风暴",
      execute({ actor, api }) {
        const t = actor.definition.tuning.ult;
        const baseAngle = Math.random() * Math.PI * 2;
        for (let i = 0; i < t.count; i++) {
          const angle = baseAngle + (i / t.count) * Math.PI * 2;
          api.spawnTornado({
            radius: actor.baseRadius * t.radiusFactor,
            speed: actor.stats.speed * t.speedFactor,
            damage: t.damage,
            lifetime: t.lifetime,
            disarm: true,
            direction: { x: Math.cos(angle), y: Math.sin(angle) },
          });
        }
      },
    },
  }),

  // ─── 招魂者 ──────────────────────────────────────────────────────────────────
  defineCharacter({
    id: "soul-caller",
    name: "招魂者",
    title: "亡灵巫师",
    color: "#7b52ab",
    description: "场上任意角色死亡时，在其尸骸处召唤3只追踪幽灵。幽灵附身敌人后环绕轨道飘荡；大招引爆所有附身幽灵，每只造成10点穿透伤害，无视无敌护盾。",
    stats: {
      maxHp: 200,
      speed: 120,
      maxEssence: 4,
      attackRange: 999,
      radius: 18,
    },
    tuning: {
      basic: {},
      ult: {
        ghostDamage: 10,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A · 怨灵苏醒",
        fields: [
          editableField("basicAttack.triggers.0.interval", "召唤间隔", { min: 0.5, step: 0.5, unit: "s" }),
        ],
      },
      {
        title: "大招 · 百鬼夜行",
        fields: [
          editableField("tuning.ult.ghostDamage", "每只幽灵伤害", { min: 1, step: 1 }),
        ],
      },
    ],
    onSpawn({ actor }) {
      actor.state.ghosts = [];
    },
    onAnyDeath({ actor, target }) {
      // 在死亡角色的位置生成3只追踪幽灵
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2;
        actor.state.ghosts.push({
          id: Math.random().toString(16).slice(2),
          position: {
            x: target.position.x + Math.cos(angle) * 10,
            y: target.position.y + Math.sin(angle) * 10,
          },
          status: "seeking",
          targetId: null,
          orbitAngle: angle,
          age: 0,
        });
      }
    },
    basicAttack: {
      name: "怨灵苏醒",
      triggers: [{ type: "interval", interval: 3 }],
      execute({ actor }) {
        const angle = Math.random() * Math.PI * 2;
        actor.state.ghosts.push({
          id: Math.random().toString(16).slice(2),
          position: {
            x: actor.position.x + Math.cos(angle) * actor.radius * 0.5,
            y: actor.position.y + Math.sin(angle) * actor.radius * 0.5,
          },
          status: "seeking",
          targetId: null,
          orbitAngle: angle,
          age: 0,
        });
      },
    },
    ultimate: {
      name: "百鬼夜行",
      execute({ actor, api }) {
        api.lockMovement(2.0);
        api.grantInvulnerable(2.1);
        api.schedule(2.0, ({ actor, api, game }) => {
          const t = actor.definition.tuning.ult;
          game.state.ghostVeil = { time: 2.5 };
          game.shake(20, 0.4);
          // 统计每个目标上的附身幽灵数量
          const detonations = new Map();
          actor.state.ghosts = actor.state.ghosts.filter((ghost) => {
            if (ghost.status === "possessing" && ghost.targetId) {
              detonations.set(ghost.targetId, (detonations.get(ghost.targetId) ?? 0) + 1);
              return false;
            }
            return true;
          });
          // 引爆幽灵，伤害穿透无敌
          for (const [targetId, count] of detonations) {
            const target = game.findActorById(targetId);
            if (target && target.alive) {
              game.applyDamage(target, count * t.ghostDamage, {
                type: "skill",
                color: "#4dff8e",
                attacker: actor,
                ignoreInvulnerable: true,
                redirected: true, // 百鬼夜行直接作用于本体，绕过幻镜拟态/偷天换日的伤害转移
              });
            }
          }
          if (detonations.size > 0) {
            api.emitText("百鬼夜行！", actor.position, "#4dff8e");
          }
        });
      },
    },
  }),

  defineCharacter({
    id: "gambler-wheel",
    name: "赌徒",
    title: "轮盘",
    color: "#f0c040",
    description: "自身生命极低。平A每3秒转动轮盘，历时2秒后随机落到1-6：1=随机敌人-10血，2=随机敌人+10血，3=自己-10血，4=自己+10血，5=全场敌人-10血，6=全场敌人+10血。大招（2精元）开启皇家赌场，仅含1、4、5三个选项，效果加倍。",
    stats: {
      maxHp: 100,
      speed: 205,
      maxEssence: 2,
      attackRange: 999,
      radius: 18,
    },
    tuning: {
      basic: {
        spinInterval: 3,
        spinDuration: 2,
        effectAmount: 10,
      },
      ult: {
        spinDuration: 2.5,
        effectAmount: 30,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A · 轮盘",
        fields: [
          editableField("tuning.basic.spinInterval", "触发间隔", { min: 1, step: 0.5, unit: "s" }),
          editableField("tuning.basic.spinDuration", "旋转时长", { min: 0.5, step: 0.5, unit: "s" }),
          editableField("tuning.basic.effectAmount", "效果数值", { min: 1, step: 1 }),
        ],
      },
      {
        title: "大招 · 皇家赌场",
        fields: [
          editableField("tuning.ult.spinDuration", "旋转时长", { min: 0.5, step: 0.5, unit: "s" }),
          editableField("tuning.ult.effectAmount", "效果数值", { min: 1, step: 1 }),
        ],
      },
    ],
    onSpawn({ actor }) {
      actor.state.wheel = null;
    },
    basicAttack: {
      name: "轮盘",
      triggers: [{ type: "interval", interval: 3 }],
      execute({ actor, api, game }) {
        if (actor.state.wheel) return;
        const t = actor.definition.tuning.basic;
        const segments = [1, 2, 3, 4, 5, 6];
        const result = segments[Math.floor(Math.random() * segments.length)];
        actor.state.wheel = {
          startTime: game.state.elapsed,
          duration: t.spinDuration,
          finalAngle: computeWheelFinalAngle(segments, result),
          segments,
          result,
          isUlt: false,
          resolved: false,
        };
        api.schedule(t.spinDuration, ({ actor, api, game }) => {
          if (!actor.state.wheel) return;
          actor.state.wheel.resolved = true;
          applyWheelResult(actor.state.wheel.result, actor, api, game, actor.definition.tuning.basic.effectAmount);
          api.schedule(1.4, ({ actor }) => { actor.state.wheel = null; });
        });
      },
    },
    ultimate: {
      name: "皇家赌场",
      execute({ actor, api, game }) {
        if (actor.state.wheel) return;
        const t = actor.definition.tuning.ult;
        const segments = [1, 4, 5];
        const result = segments[Math.floor(Math.random() * segments.length)];
        actor.state.wheel = {
          startTime: game.state.elapsed,
          duration: t.spinDuration,
          finalAngle: computeWheelFinalAngle(segments, result),
          segments,
          result,
          isUlt: true,
          resolved: false,
        };
        api.announce("皇家赌场！命运的轮盘开始旋转！");
        api.schedule(t.spinDuration, ({ actor, api, game }) => {
          if (!actor.state.wheel) return;
          actor.state.wheel.resolved = true;
          applyWheelResult(actor.state.wheel.result, actor, api, game, actor.definition.tuning.ult.effectAmount);
          api.schedule(1.8, ({ actor }) => { actor.state.wheel = null; });
        });
      },
    },
  }),

  defineCharacter({
    id: "mirror-mimic",
    name: "幻镜",
    title: "替身使者",
    color: "#78c8f0",
    description: "自身生命极低。平A每5秒随机拟态一名存活敌人，持续4秒，期间自身所受伤害转化为真实伤害直接施加给被拟态目标。大招（需3精元）锁定血量最高的角色为宿主，场上所有角色外形变为宿主，非宿主所受伤害全部转移至宿主，持续5秒。",
    stats: {
      maxHp: 100,
      speed: 210,
      maxEssence: 3,
      attackRange: 999,
      radius: 18,
    },
    tuning: {
      basic: {
        mimicInterval: 5,
        mimicDuration: 4,
      },
      ult: {
        duration: 5,
      },
    },
    editorSections: [
      {
        title: "基础属性",
        fields: [
          editableField("stats.maxHp", "生命值", { min: 1, step: 1 }),
          editableField("stats.speed", "移动速度", { min: 20, step: 1 }),
          editableField("stats.maxEssence", "大招点数", { min: 1, step: 1 }),
        ],
      },
      {
        title: "平A · 拟态窃取",
        fields: [
          editableField("tuning.basic.mimicInterval", "触发间隔", { min: 1, step: 0.5, unit: "s" }),
          editableField("tuning.basic.mimicDuration", "拟态持续", { min: 0.5, step: 0.5, unit: "s" }),
        ],
      },
      {
        title: "大招 · 偷天换日",
        fields: [
          editableField("tuning.ult.duration", "持续时间", { min: 1, step: 0.5, unit: "s" }),
        ],
      },
    ],
    onSpawn({ actor }) {
      actor.state.mimicTargetId = null;
    },
    basicAttack: {
      name: "拟态窃取",
      triggers: [{ type: "interval", interval: 5 }],
      execute({ actor, api, enemies }) {
        const t = actor.definition.tuning.basic;
        const living = enemies.filter((e) => e.alive);
        if (!living.length) return;
        const target = living[Math.floor(Math.random() * living.length)];
        actor.state.mimicTargetId = target.id;
        api.emitText("拟态！", actor.position, "#78c8f0");
        api.schedule(t.mimicDuration, ({ actor }) => {
          actor.state.mimicTargetId = null;
        });
      },
    },
    ultimate: {
      name: "偷天换日",
      execute({ actor, api, game }) {
        const t = actor.definition.tuning.ult;
        const all = game.state.actors.filter((a) => a.alive);
        if (!all.length) return;
        const host = all.reduce((best, a) => (a.hp > best.hp ? a : best), all[0]);
        game.state.mirrorUlt = { hostId: host.id };
        api.announce(`偷天换日！所有伤害归于 ${host.name}！`);
        api.emitText("偷天换日", actor.position, "#c8f0ff");
        api.schedule(t.duration, ({ game }) => {
          game.state.mirrorUlt = null;
        });
      },
    },
  }),
];

const CHARACTER_DEFAULTS = Object.fromEntries(
  CHARACTER_LIBRARY.map((character) => [
    character.id,
    Object.fromEntries(
      character.editorSections.flatMap((section) =>
        section.fields.map((field) => [field.path, deepClone(getByPath(character, field.path))]),
      ),
    ),
  ]),
);

export function getCharacterById(id) {
  return CHARACTER_LIBRARY.find((character) => character.id === id);
}

export function updateCharacterValue(id, path, nextValue) {
  const character = getCharacterById(id);
  if (!character || Number.isNaN(nextValue)) {
    return false;
  }
  return setByPath(character, path, nextValue);
}

export function resetCharacterValues(id) {
  const character = getCharacterById(id);
  const defaults = CHARACTER_DEFAULTS[id];
  if (!character || !defaults) {
    return false;
  }
  Object.entries(defaults).forEach(([path, value]) => {
    setByPath(character, path, deepClone(value));
  });
  return true;
}
