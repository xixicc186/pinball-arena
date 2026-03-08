# 弹球角斗场

这是一个不依赖构建工具的浏览器版原型，直接实现了 `游戏机制.md` 里的核心机制：

- 自动弹跳移动，角色碰撞只产生击退，不直接造成伤害
- 随机多边形场地、内部围墙、危险区持续伤害
- 精元生成与收集，大招在精元充满后自动释放
- 四类平A触发模板：时间轴、撞墙、范围判定、轨迹
- 角色选择、自动开局、胜负结算、飘字、震屏、死亡爆炸等反馈

## 运行

建议在当前目录启动一个静态服务器，然后在浏览器打开：

```powershell
python -m http.server 8080
```

访问 `http://localhost:8080`。

## 角色扩展入口

角色定义集中在 [src/characters.js](C:\文件\弹球角斗场\src\characters.js)。

新增角色时只需要往 `CHARACTER_LIBRARY` 里追加一个 `defineCharacter({...})`：

```js
defineCharacter({
  id: "new-role",
  name: "新角色",
  title: "角色定位",
  color: "#ffaa55",
  description: "角色说明",
  stats: {
    maxHp: 120,
    speed: 180,
    maxEssence: 3,
    attackRange: 200,
    radius: 18,
  },
  basicAttack: {
    name: "平A名称",
    triggers: [
      { type: "interval", interval: 1.2 },
      { type: "proximity", radius: 110, cooldown: 1.5 },
      { type: "trail", interval: 0.35 },
      { type: "onWallBounce", cooldown: 0.5 },
    ],
    execute({ actor, api, trigger, event }) {
      api.spawnProjectile({
        direction: actor.velocity,
        speed: 320,
        damage: 12,
      });
    },
  },
  ultimate: {
    name: "大招名称",
    execute({ actor, api }) {
      api.spawnPulse({
        radius: 140,
        damage: 20,
      });
    },
  },
});
```

## 核心文件

- [index.html](C:\文件\弹球角斗场\index.html): 页面骨架和选择界面
- [styles.css](C:\文件\弹球角斗场\styles.css): UI 和战斗面板样式
- [src/main.js](C:\文件\弹球角斗场\src\main.js): 角色选择、HUD、战斗播报
- [src/game.js](C:\文件\弹球角斗场\src\game.js): 物理、场地、资源、战斗和反馈系统
- [src/characters.js](C:\文件\弹球角斗场\src\characters.js): 角色库与技能接口
