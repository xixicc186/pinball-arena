# Pinball Arena

A build-tool-free browser prototype implementing the core mechanics of the game design document:

- Automatic bouncing movement; actor collisions only cause knockback, no direct damage
- Random polygon arenas with interior walls and hazard zones dealing persistent damage
- Essence generation and collection; ultimates fire automatically when essence is full
- Four basic attack trigger templates: interval, wall bounce, proximity, and trail
- Character selection, auto-start, win/loss resolution, floating text, screen shake, death explosions, and other feedback effects

## Running

Start a static server in the project directory and open in your browser:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Adding Characters

All character definitions live in [src/characters.js](src/characters.js).

To add a new character, append a `defineCharacter({...})` call to `CHARACTER_LIBRARY`:

```js
defineCharacter({
  id: "new-role",
  name: "New Character",
  title: "Role Archetype",
  color: "#ffaa55",
  description: "Character description.",
  stats: {
    maxHp: 120,
    speed: 180,
    maxEssence: 3,
    attackRange: 200,
    radius: 18,
  },
  basicAttack: {
    name: "Basic Attack Name",
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
    name: "Ultimate Name",
    execute({ actor, api }) {
      api.spawnPulse({
        radius: 140,
        damage: 20,
      });
    },
  },
});
```

## Core Files

- [index.html](index.html): Page structure and character selection screen
- [styles.css](styles.css): UI and battle panel styles
- [src/main.js](src/main.js): Character selection, HUD, and battle announcements
- [src/game.js](src/game.js): Physics, arena, resources, combat, and feedback systems
- [src/characters.js](src/characters.js): Character library and ability interface
