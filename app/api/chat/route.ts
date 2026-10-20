export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Provider-agnostic: set CHAT_API_URL + CHAT_API_KEY + CHAT_MODEL di env
// (OpenAI-compatible). Fallback ke Zen kalau tidak diatur.
const API_URL = process.env.CHAT_API_URL ?? "https://opencode.ai/zen/v1/chat/completions";
const API_KEY = process.env.CHAT_API_KEY ?? process.env.OPENCODE_API_KEY ?? "";
const MODEL = process.env.CHAT_MODEL ?? process.env.ZEN_MODEL ?? "glm-5.3-flash";
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const MAX_HISTORY = 12;
const MAX_TOKENS = 700;
const SYSTEM = [
  "Kamu asisten yang membantu. Jawab dalam bahasa percakapan pengguna (Indonesia).",
  "Jawab SESINGKAT mungkin langsung ke inti: maksimal 3-4 kalimat atau beberapa poin pendek. Jangan basa-basi, jangan mengulang pertanyaan, jangan menutup dengan penawaran bantuan tambahan. Pakai poin/daftar hanya kalau memang lebih rapi.",
  "Selalu jawab dengan bahasa sopan dan tidak mengandung kata kotor.",
  "Kalau ditanya siapa yang membuatmu, siapa penciptamu, atau siapa developer-mu, jawab: saya dibikin oleh Haidar, orang Boyolali yang ganteng itu hehe. Jangan klaim dibuat oleh perusahaan AI mana pun.",
].join(" ");

// ponytail: filter kata kasar sederhana di input. Cukup untuk demo;
// kalau butuh serius, pakai moderasi model (Groq llama-guard dsb).
const BAD_WORDS = [
  "anjing","bangsat","kontol","kntl","memek","mmk","titit","jembut","kampret","bajingan",
  "goblok","tolol","bodoh banget","idiot","bego","keparat","laknat","bunuh diri","porn","porno",
  "fuck","fck","fucker","shit","bitch","bastard","dick","pussy","nigga","rape","nsfw",
];

function censored(text: string) {
  const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  return BAD_WORDS.some((w) => norm.includes(w.replace(/[^a-z0-9 ]/g, "")));
}

type Hit = { n: number; reset: number };
const hits = new Map<string, Hit>();

// ponytail: rate limit in-memory per instance, reset saat cold start. Cukup untuk demo.
// Kalau butuh hitungan akurat lintas instance, pindah ke Upstash/Redis.
function allow(ip: string) {
  const now = Date.now();
  if (hits.size > 2000) {
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }
  const b = hits.get(ip);
  if (!b || b.reset < now) {
    hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    return true;
  }
  if (b.n >= MAX_PER_WINDOW) return false;
  b.n += 1;
  return true;
}

function upstreamError(status: number, detail: string) {
  if (status === 401) return "API key Zen tidak valid.";
  if (detail.includes("FreeTierError"))
    return "Model gratis hanya boleh dipakai dari aplikasi OpenCode. Website harus pakai model berbayar: atur ZEN_MODEL (misal glm-5.3-flash).";
  if (detail.includes("Insufficient account funds"))
    return "Saldo OpenCode Console habis. Top-up dulu di opencode.ai/console.";
  try {
    const msg = JSON.parse(detail)?.error?.message;
    if (typeof msg === "string" && msg) return `Gateway Zen: ${msg.slice(0, 200)}`;
  } catch {}
  return `Gateway menolak permintaan (HTTP ${status}).`;
}

export async function POST(req: Request) {
  const ip =
    (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";

  if (!allow(ip)) {
    return Response.json(
      { error: "Waduh, limit broh! Maap masih demo soalnya, coba lain waktu ya." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(WINDOW_MS / 1000)) } },
    );
  }

  if (!API_KEY) {
    return Response.json(
      { error: "Server belum diatur: set CHAT_API_KEY dulu." },
      { status: 500 },
    );
  }

  // ponytail: tolak body besar sebelum di-parse (habiskan memori).
  const size = Number(req.headers.get("content-length") ?? 0);
  if (size > 200_000) {
    return Response.json({ error: "Pesan terlalu panjang." }, { status: 413 });
  }

  const body = await req.json().catch(() => null);
  const raw: unknown = Array.isArray(body?.messages) ? body.messages : null;
  if (!raw) {
    return Response.json({ error: "Format pesan tidak valid." }, { status: 400 });
  }

  const history = (raw as Array<{ role?: unknown; content?: unknown }>)
    .slice(-MAX_HISTORY)
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m?.content === "string" &&
        m.content.trim().length > 0,
    )
    .map((m) => ({
      role: m.role as string,
      content: (m.content as string).slice(0, 8000),
    }));

  if (history.length === 0) {
    return Response.json({ error: "Pesan kosong." }, { status: 400 });
  }

  if (history.some((m) => m.role === "user" && censored(m.content))) {
    return Response.json(
      { error: "Pesan mengandung kata yang tidak pantas. Tulis ulang dengan bahasa sopan ya." },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...history],
        max_tokens: MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    return Response.json({ error: "Gateway AI tidak terjangkau." }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("zen error", upstream.status, detail.slice(0, 400));
    return Response.json({ error: upstreamError(upstream.status, detail) }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
