const SUPABASE_URL = "https://ubncpacodhlolhwuwfcb.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVibmNwYWNvZGhsb2xod3V3ZmNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4NzA0OTYsImV4cCI6MjA4ODQ0NjQ5Nn0.38j2iImWHZPat9Q90qcFJRurJGVV1qOPkMRi-Vl8LtI";

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

const TABLE = `${SUPABASE_URL}/rest/v1/character_tuning`;
const LEADERBOARD_TABLE = `${SUPABASE_URL}/rest/v1/character_leaderboard`;

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

// 获取排行榜数据，返回 { characterId: { name, score } }
export async function getLeaderboard() {
  try {
    const res = await fetch(
      `${LEADERBOARD_TABLE}?select=character_id,character_name,score&order=score.desc`,
      { headers: HEADERS },
    );
    if (!res.ok) return {};
    const rows = await res.json();
    return Object.fromEntries(
      rows.map((row) => [row.character_id, { name: row.character_name, score: row.score }]),
    );
  } catch {
    return {};
  }
}

// 批量写入角色积分（upsert）
// updates: [{ characterId, name, newScore }]
export async function updateCharacterScores(updates) {
  if (!updates.length) return;
  const body = updates.map(({ characterId, name, newScore }) => ({
    character_id: characterId,
    character_name: name,
    score: newScore,
    updated_at: new Date().toISOString(),
  }));
  try {
    await fetch(LEADERBOARD_TABLE, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(body),
    });
  } catch {
    // 网络错误时静默失败
  }
}
