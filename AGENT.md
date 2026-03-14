# AGENT.md — 弹球角斗场 Agent 操作手册

本文档面向 AI Agent，描述如何完整执行「设计角色 → 接入游戏 → 录制视频 → 发布自媒体」的自动化流水线。

---

## 流水线总览

```
1. 读取角色库          src/characters.js → 理解现有模式
2. 设计新角色          生成 defineCharacter({...}) 代码
3. 写入源文件          characters.js + sounds.js（必须）
4. 启动本地服务器      npx serve . -p 8080
5. 浏览器自动化        CDP 连接 → 选角色 → 触发录制
6. 获取视频文件        拦截下载 → 保存到指定路径
7. 发布到自媒体        调用平台 API 上传视频
```

---

## 一、环境准备

### 依赖
- Node.js（运行静态服务器）
- Microsoft Edge 或 Chrome（支持 CDP 远程调试）
- Python（可选，备用服务器）

### 启动服务器
```bash
cd /path/to/pinball-arena
npx serve . -p 8080
# 或
python -m http.server 8080
```

### 启动浏览器（开启 CDP）
```bash
# Edge
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir=".edge-cdp" \
  --window-size=1080,1920 \
  http://localhost:8080

# Chrome
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/tmp/chrome-cdp" \
  --window-size=1080,1920 \
  http://localhost:8080
```

CDP 地址：`ws://localhost:9222`

---

## 二、读取现有角色库

在设计新角色前，先读取 `src/characters.js` 了解已有角色的风格和数值范围：

```
- 文件路径：src/characters.js
- 关键导出：CHARACTER_LIBRARY（数组，每项由 defineCharacter() 生成）
- 当前角色数：16 个（见文件末尾）
- 数值参考：maxHp 80-150，speed 140-220，maxEssence 2-5，radius 14-22
```

**设计建议：** 阅读 2-3 个现有角色的完整定义后再生成新角色，确保风格一致、数值平衡。

---

## 三、写入新角色

### 3.1 `src/characters.js` — 角色定义（必须）

在文件末尾的 `CHARACTER_LIBRARY` 数组中追加一个 `defineCharacter({...})` 调用。

**完整模板：**

```js
defineCharacter({
  id: "my-char",           // 唯一 kebab-case ID，不得与现有 ID 重复
  name: "角色名",           // 2-4 字
  title: "称号",            // 4-8 字
  color: "#ff8844",        // 十六进制颜色，用于 UI/粒子/光晕
  description: "能力描述",  // 一句话说明核心机制

  stats: {
    maxHp: 120,            // 生命值（参考范围：80-150）
    speed: 180,            // 移动速度 px/s（参考范围：140-220）
    maxEssence: 3,         // 大招所需精元（参考范围：2-5）
    attackRange: 200,      // proximity 触发器感知范围
    radius: 18,            // 碰撞半径（参考范围：14-22）
  },

  tuning: {
    basic: { cooldown: 1.2, damage: 15 },
    ult:   { radius: 200, damage: 40 },
  },

  editorSections: [
    {
      title: "平A参数",
      fields: [
        editableField("tuning.basic.cooldown", "冷却时间", { min: 0.1, step: 0.1, unit: "s" }),
        editableField("tuning.basic.damage",   "伤害",     { min: 1, step: 1 }),
      ],
    },
  ],

  onSpawn({ actor, api, game }) {
    // 初始化自定义状态，例：
    actor.state.myCounter = 0;
  },

  // 可选钩子
  onKill({ actor, target, api, game }) { },
  onDeath({ actor, attacker, api, game }) { },
  onAnyDeath({ actor, dead, attacker, api, game }) { },

  basicAttack: {
    name: "技能名",
    triggers: [
      // 从以下触发器中选一个或多个组合：
      { type: "interval",     interval: 1.2 },   // 定时
      { type: "collision",    cooldown: 0.5 },   // 碰撞敌人
      { type: "onWallBounce", cooldown: 0.8 },   // 撞墙
      { type: "trail",        interval: 0.3 },   // 移动轨迹
      { type: "proximity",    radius: 150 },     // 范围内有敌人
    ],
    execute({ actor, api, event, enemies, game }) {
      api.spawnProjectile({
        direction: actor.velocity,
        speed: 320,
        radius: 6,
        damage: 15,
        color: actor.definition.color,
        lifetime: 2,
        bounces: 2,
        knockback: 60,
      });
    },
  },

  ultimate: {
    name: "大招名",
    execute({ actor, api, enemies, game }) {
      api.spawnPulse({
        radius: 180,
        damage: 35,
        color: actor.definition.color,
        knockback: 120,
        shake: 8,
      });
    },
  },
});
```

**可用 API 方法（execute 内）：**

| 方法 | 用途 |
|------|------|
| `api.spawnProjectile({direction, speed, radius, damage, color, lifetime, bounces, knockback, pierce})` | 发射抛射物 |
| `api.spawnPulse({radius, damage, color, knockback, shake})` | 范围脉冲 |
| `api.createTrail({position, radius, lifetime, color, poisonDamage, slowFactor})` | 地面效果 |
| `api.spawnStrike({position, delay, radius, damage, color})` | 延迟落雷 |
| `api.spawnLaser({direction, maxBounces, damage, stunDuration, color, width, lifetime})` | 激光 |
| `api.summonTurret({maxCount, radius, fireInterval, damage, range, maxHits})` | 炮台 |
| `api.dealDamage(target, amount, {ignoreInvulnerable})` | 直接扣血 |
| `api.heal(amount)` | 回血 |
| `api.schedule(delay, callback)` | 延迟执行 |
| `api.grantInvulnerable(duration)` | 无敌帧 |
| `api.setSpeedMultiplier(multiplier, duration)` | 临时变速 |
| `api.findNearestEnemy(range)` | 查找最近敌人 |
| `api.findLowestHpEnemy()` | 查找最低血量敌人 |
| `api.announce(message)` | 全场公告 |

### 3.2 `src/sounds.js` — 音效（必须）

在 `basicAttackSounds` 对象（约 line 108）和 `ultimateSounds` 对象（约 line 296）各添加一项：

```js
// basicAttackSounds（用 throttle 防重叠）
"my-char": throttle("ba:my-char", 120, (ctx, { impactSpeed }) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 440 + (impactSpeed ?? 0) * 0.5;
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
}),

// ultimateSounds（无需限流）
"my-char"(ctx) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 220;
  gain.gain.setValueAtTime(0.5, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.8);
},
```

### 3.3 `src/game.js` — 仅在需要自定义外观时修改

大多数角色**不需要改 game.js**。仅当角色需要特殊球体外观时，在 `renderActorBody()` 的 switch（约 line 2370）中添加：

```js
case "my-char":
  this.renderMyCharBall(ctx, actor, elapsed);
  break;
```

---

## 四、浏览器自动化（CDP）

服务器和浏览器启动后，通过 CDP 控制游戏。

### 4.1 连接

```python
import asyncio
from pycdp import cdp
# 或使用 playwright、puppeteer 等

# CDP WebSocket: ws://localhost:9222
```

### 4.2 选择参赛角色

游戏通过 `selectedRosterIds`（Set）管理出战角色。可直接在页面上下文中执行 JS 操作：

```js
// 在浏览器页面中执行（通过 CDP Runtime.evaluate）

// 查看所有可用角色 ID
window.CHARACTER_LIBRARY.map(c => ({ id: c.id, name: c.name }))

// 设置参赛名单（团队赛需要 16 人，个人战需要 8 人）
// 先清空
window.selectedRosterIds.clear();
// 再按需添加（id 必须存在于 CHARACTER_LIBRARY）
["bee-stinger", "plague-mist", "frost-core", /* ...共16个 */].forEach(id => {
  window.selectedRosterIds.add(id);
});
// 刷新 UI
window.renderRoster();
window.updateRosterStatus();
```

### 4.3 切换赛事模式

```js
// 切换到赛事模式（团队赛 / 个人战）
window.setAppMode("tournament");      // 赛事模式
// 设置赛事格式
window.tournamentFormat = "team";     // "team"=16人团队赛，"solo"=8人个人战
```

### 4.4 设置视频下载路径（在触发录制前）

通过 CDP `Page.setDownloadBehavior` 拦截下载到指定目录：

```python
# Playwright 示例
await context.route("**", lambda route: route.continue_())
# 设置下载路径
await page.set_download_behavior("allow", download_path="/output/videos")
```

### 4.5 触发录制

```js
// 通过 CDP 点击「录制整届赛事」按钮
document.getElementById("tournament-record-button").click();

// 游戏将自动：
// 1. 抽签排布对阵
// 2. 运行所有场次（约 2-5 分钟）
// 3. 录制完成后自动触发浏览器下载
```

### 4.6 等待录制完成

```js
// 监听录制状态（在页面中轮询）
window.recordingState.active  // true = 录制中，false = 已结束
```

或监听 CDP 下载事件（`Page.downloadWillBegin` / `Page.downloadProgress`）判断视频保存完成。

### 4.7 完整自动化流程（伪代码）

```python
async def run_pipeline(character_ids: list[str], output_dir: str):
    # 1. 连接 CDP
    page = await connect_cdp("ws://localhost:9222")

    # 2. 设置下载路径
    await page.set_download_behavior("allow", download_path=output_dir)

    # 3. 选角色
    await page.evaluate(f"""
        window.selectedRosterIds = new Set({json.dumps(character_ids)});
        window.setAppMode("tournament");
        window.tournamentFormat = "team";
        window.renderRoster();
        window.updateRosterStatus();
    """)

    # 4. 触发录制
    await page.evaluate("""
        document.getElementById("tournament-record-button").click();
    """)

    # 5. 等待下载完成
    video_path = await wait_for_download(output_dir, timeout=600)

    return video_path
```

---

## 五、视频产物

| 属性 | 值 |
|------|----|
| 格式 | MP4（优先）或 WebM（降级） |
| 分辨率 | 1080×1920（竖屏） |
| 文件名格式 | `{赛事类型}_{日期时间}.mp4` |
| 内容 | VS 横幅 + 完整赛程 + 精元进度条 |

---

## 六、发布到自媒体

视频下载完成后，调用各平台 API 上传。以下为各平台接入方式：

### 抖音 / TikTok
- API 文档：[open.douyin.com](https://open.douyin.com)
- 接口：`POST /video/create/` — 上传视频
- 需要：access_token（提前在平台申请）

### B站（哔哩哔哩）
- API 文档：[openhome.bilibili.com](https://openhome.bilibili.com)
- 接口：`POST /x/vu/client/add` — 投稿接口
- 需要：access_key

### YouTube
- API：YouTube Data API v3
- 接口：`POST /upload/youtube/v3/videos`
- 需要：OAuth 2.0 access_token

### 通用发布模板（伪代码）

```python
async def publish_video(video_path: str, title: str, description: str):
    # 生成标题（可让 LLM 根据参赛角色生成）
    # 例：「【弹球角斗场】蜂刺 vs 绝对零度 — 谁才是最强弹球？」

    tasks = []

    if DOUYIN_TOKEN:
        tasks.append(upload_to_douyin(video_path, title, description))

    if BILIBILI_KEY:
        tasks.append(upload_to_bilibili(video_path, title, description))

    await asyncio.gather(*tasks)
```

---

## 七、完整端到端示例

```python
import asyncio

CHARACTER_IDS = [
    "bee-stinger", "plague-mist", "frost-core", "storm-magnet",
    "turret-smith", "bomber-rex", "blood-leech", "holy-shield",
    "phantom-mirror", "meat-grinder", "prism-refract", "storm-weather",
    "eagle-eye", "soul-caller", "gambler-wheel", "mirror-mimic"
]

async def main():
    # Step 1: 可选 — 让 LLM 设计新角色并写入 characters.js / sounds.js
    # new_char_code = llm_design_character(existing_chars)
    # append_to_file("src/characters.js", new_char_code)

    # Step 2: 启动服务器
    server = start_server(port=8080)

    # Step 3: 启动浏览器
    browser = start_browser_with_cdp(port=9222, url="http://localhost:8080")

    # Step 4: 运行录制流水线
    video_path = await run_pipeline(CHARACTER_IDS, output_dir="./output")

    # Step 5: 生成标题简介
    title = "【弹球角斗场】16 强年度大赛 — 谁才是最强弹球？"
    description = "全 16 名角色对抗，精元系统 + 技能乱斗，纯策略弹球！"

    # Step 6: 发布
    await publish_video(video_path, title, description)

asyncio.run(main())
```

---

## 八、注意事项

- **不要修改 `src/game.js` 的 tick() 顺序**，否则会破坏物理模拟
- **角色 ID 必须唯一**，检查 `CHARACTER_LIBRARY` 中是否已存在相同 ID
- **音效必须同步添加**，否则控制台报错（不影响游戏运行，但会产生 noise）
- **录制时间**：完整团队赛（16 人）约 3-6 分钟，设置 10 分钟超时保险
- **数据库配置**（可选）：若需保存角色调参，见 `README.md` 的「数据库配置」章节；不配置不影响录制流水线
