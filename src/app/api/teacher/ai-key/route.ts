import { currentTeacher, json } from "@/lib/auth";
import { aiKeyStatus, deleteAiKey, last4, normalizeAiKey, saveAiKey } from "@/lib/ai-key";
import { envApiKey } from "@/lib/feedback/client";

// 교사 화면의 'AI 키' 칸: 연수에서 받은 OpenRouter 키를 앱에 넣고(암호화해 DB에 저장, src/lib/ai-key.ts), 지우고, 상태를 봅니다.
// 키 값은 어떤 응답에도 담지 않습니다(끝 4자리만). 키는 로그·오류·event_log에도 남기지 않습니다.
// GET    → { configured, last4, fromEnv }  (fromEnv: Cloudflare 환경 변수 OPENROUTER_API_KEY가 있어 그 키를 씀)
// PUT    { key } → { ok, configured: true, last4(넣은 키의 끝 4자리), fromEnv }
// DELETE → { ok, configured, last4, fromEnv }  (환경 변수 키가 있으면 지운 뒤에도 그 키가 쓰임)

export async function GET() {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  return json(await aiKeyStatus());
}

export async function PUT(req: Request) {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  const key = normalizeAiKey(body?.key);
  if (!key) {
    return json({ error: "OpenRouter 키 모양이 아니에요. 받은 키(sk-or-로 시작)를 빈칸 없이 그대로 붙여 넣어 주세요.", code: "bad_key" }, 400);
  }
  await saveAiKey(key);
  // fromEnv가 true면 저장은 했지만 환경 변수 키가 먼저 쓰입니다(교사 화면이 안내).
  return json({ ok: true, configured: true, last4: last4(key), fromEnv: !!envApiKey() });
}

export async function DELETE() {
  const t = await currentTeacher();
  if (!t) return json({ error: "unauthorized" }, 401);
  await deleteAiKey();
  return json({ ok: true, ...(await aiKeyStatus()) });
}
