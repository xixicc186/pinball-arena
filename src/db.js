// ─── Supabase 配置 ────────────────────────────────────────────────────────────
// 从 src/config.js 读取（该文件已 gitignore，不会上传到 GitHub）。
// 首次配置：cp src/config.example.js src/config.js，然后填入真实值。
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

const TABLE = `${SUPABASE_URL}/rest/v1/character_tuning`;
const INTRO_TABLE = `${SUPABASE_URL}/rest/v1/character_intro`;

export async function loadAllOverrides() {
  try {
    const res = await fetch(`${TABLE}?select=character_id,overrides`, {
      headers: HEADERS,
    });
    if (!res.ok) return {};
    const rows = await res.json();
    return Object.fromEntries(rows.map((row) => [row.character_id, row.overrides]));
  } catch {
    return {};
  }
}

export async function saveOverrides(characterId, overrides) {
  try {
    await fetch(TABLE, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        character_id: characterId,
        overrides,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // 网络错误时静默失败，不影响游戏运行
  }
}

export async function clearOverrides(characterId) {
  try {
    await fetch(`${TABLE}?character_id=eq.${encodeURIComponent(characterId)}`, {
      method: "DELETE",
      headers: HEADERS,
    });
  } catch {
    // 网络错误时静默失败
  }
}

// ─── 出场介绍文字 ─────────────────────────────────────────────────────────────

export async function loadAllIntros() {
  try {
    const res = await fetch(
      `${INTRO_TABLE}?select=character_id,name,title,description,basic_attack_name,ultimate_name`,
      { headers: HEADERS },
    );
    if (!res.ok) return {};
    const rows = await res.json();
    return Object.fromEntries(rows.map((row) => [row.character_id, row]));
  } catch {
    return {};
  }
}

export async function saveIntro(characterId, intro) {
  try {
    await fetch(INTRO_TABLE, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        character_id: characterId,
        name: intro.name ?? null,
        title: intro.title ?? null,
        description: intro.description ?? null,
        basic_attack_name: intro.basicAttackName ?? null,
        ultimate_name: intro.ultimateName ?? null,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // 网络错误时静默失败
  }
}
