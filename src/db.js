// ─── Supabase 配置 ────────────────────────────────────────────────────────────
// 请将下方占位符替换为你自己的 Supabase 项目信息。
// 获取方式：Supabase 控制台 → Project Settings → API
// 详见 README.md 的「数据库配置」章节。
const SUPABASE_URL = "YOUR_SUPABASE_URL";       // 例：https://xxxx.supabase.co
const SUPABASE_KEY = "YOUR_SUPABASE_ANON_KEY";  // Project API Keys → anon public

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
