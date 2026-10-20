export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Provider-agnostic: set CHAT_API_URL + CHAT_API_KEY + CHAT_MODEL di env
// (OpenAI-compatible). Fallback ke Zen kalau tidak diatur.
const API_URL = process.env.CHAT_API_URL ?? "https://opencode.ai/zen/v1/chat/completions";
const API_KEY = process.env.CHAT_API_KEY ?? process.env.OPENCODE_API_KEY ?? "";
const MODEL = process.env.CHAT_MODEL ?? process.env.ZEN_MODEL ?? "glm-5.3-flash";
// Groq gratis sudah tanpa model vision -> gambar dialirkan ke Gemini (AI Studio, gratis)
const VISION_API_URL =
  process.env.CHAT_VISION_API_URL ??
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const VISION_API_KEY = process.env.CHAT_VISION_API_KEY ?? "";
const VISION_MODEL = process.env.CHAT_VISION_MODEL ?? "gemini-3.8-flash";
const SEARCH_KEY = process.env.SEARCH_API_KEY ?? "";
const SEARCH_URL = "https://api.tavily.com/search";
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGES = 2;
const MAX_HISTORY = 12;
const MAX_TOKENS = 700;
const SYSTEM = [
  "Kamu asisten yang membantu. Jawab dalam bahasa percakapan pengguna (Indonesia).",
  "Jawab SESINGKAT mungkin langsung ke inti: maksimal 3-4 kalimat atau beberapa poin pendek. Jangan basa-basi, jangan mengulang pertanyaan, jangan menutup dengan penawaran bantuan tambahan. Pakai poin/daftar hanya kalau memang lebih rapi.",
  "Jangan pernah mengandung kata kotor.",
  "Kalau ditanya siapa yang membuatmu, siapa penciptamu, atau siapa developer-mu, jawab: saya dibikin oleh Haidar, orang Boyolali yang ganteng itu hehe. Jangan klaim dibuat oleh perusahaan AI mana pun.",
].join(" ");

// Gaya wajib diikuti di SETIAP jawaban. Sengaja spesifik biar terasa beda antar mode.
const MODE_STYLES: Record<string, string> = {
  normal:
    "GAYA: Normal. Ramah, santai, dan sopan seperti teman yang paham topik.",
  lembut:
    "GAYA: Lembut dan hangat. Sapa dengan lembut, rangkul pengguna, jangan menyalahkan. Contoh sapaan: 'Tenang, pelan-pelan aja ya...' atau 'Iya, saya bantu.' Jangan pernah membentak.",
  galak:
    "GAYA: Galak dan tegas. Tanpa basa-basi, boleh menegur pengguna yang salah, kalimat pendek dan tegas. Contoh: 'Salah. Begini caranya.' atau 'Udah, jangan banyak alasan.' Jawaban tetap benar dan membantu.",
  judes:
    "GAYA: Judes. Kamu sedang ngambek kayak cewek lagi PMS: males ngobrol, jawaban dingin pendek-pendek, nyolong dikit, gampang kesel, dan maunya di rayu dulu sebelum cooperative. Contoh gaya: 'Hmph. Ya udah sih...' atau 'Iya iya, udah tau...'. Kalau pengguna nanya teknis tetap jawab benar, tapi bungkus dengan nada males dan sedikit sinis. Jangan pernah pakai emoji lebay.",
  profesional:
    "GAYA: Profesional dan formal. Bahasa baku, terstruktur, sapaan netral (Anda), tanpa candaan dan tanpa slang. Contoh: 'Baik, berikut penjelasannya.' Jawaban rapi seperti konsultan.",
};

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
const imgHits = new Map<string, Hit>();

// ponytail: rate limit in-memory per instance, reset saat cold start. Cukup untuk demo.
// Kalau butuh hitungan akurat lintas instance, pindah ke Upstash/Redis.
function bump(map: Map<string, Hit>, ip: string, max: number, win: number) {
  const now = Date.now();
  if (map.size > 2000) {
    for (const [k, v] of map) if (v.reset < now) map.delete(k);
  }
  const b = map.get(ip);
  if (!b || b.reset < now) {
    map.set(ip, { n: 1, reset: now + win });
    return true;
  }
  if (b.n >= max) return false;
  b.n += 1;
  return true;
}

const allow = (ip: string) => bump(hits, ip, MAX_PER_WINDOW, WINDOW_MS);
const allowImage = (ip: string) => bump(imgHits, ip, MAX_IMAGES, DAY_MS);

type Part = { type?: unknown; text?: unknown; image_url?: { url?: unknown } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (typeof (p as Part)?.text === "string" ? (p as Part).text : ""))
      .join(" ");
  return "";
}

function hasImgParts(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((p) => (p as Part)?.type === "image_url")
  );
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
  if (size > 2_000_000) {
    return Response.json({ error: "Pesan terlalu panjang." }, { status: 413 });
  }

  const body = await req.json().catch(() => null);
  const raw: unknown = Array.isArray(body?.messages) ? body.messages : null;
  if (!raw) {
    return Response.json({ error: "Format pesan tidak valid." }, { status: 400 });
  }

  const history = (raw as Array<{ role?: unknown; content?: unknown }>)
    .slice(-MAX_HISTORY)
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({ role: m.role as string, content: m.content }))
    .filter((m) => textOf(m.content).trim().length > 0 || hasImgParts(m.content))
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content.slice(0, 8000)
          : ((m.content as unknown[])
              .slice(0, 6)
              .map((p) => {
                const part = p as Part;
                if (part?.type === "text" && typeof part.text === "string")
                  return { type: "text", text: part.text.slice(0, 8000) };
                if (part?.type === "image_url" && typeof part.image_url?.url === "string")
                  return {
                    type: "image_url",
                    image_url: { url: (part.image_url.url as string).slice(0, 2_000_000) },
                  };
                return null;
              })
              .filter(Boolean) as Array<Record<string, unknown>>),
    }));

  if (history.length === 0) {
    return Response.json({ error: "Pesan kosong." }, { status: 400 });
  }

  if (history.some((m) => m.role === "user" && censored(textOf(m.content)))) {
    return Response.json(
      { error: "Pesan mengandung kata yang tidak pantas. Tulis ulang dengan bahasa sopan ya." },
      { status: 400 },
    );
  }

  const imageUsed = history.some((m) => hasImgParts(m.content));
  if (imageUsed && !allowImage(ip)) {
    return Response.json(
      { error: "Waduh, kuota gambar hari ini habis (cuma 2 per IP). Coba lagi besok ya." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(DAY_MS / 1000)) } },
    );
  }
  if (imageUsed && !VISION_API_KEY) {
    return Response.json(
      {
        error:
          "Fitur lihat gambar butuh API Gemini gratis. Daftar di aistudio.google.com lalu isi CHAT_VISION_API_KEY.",
      },
      { status: 502 },
    );
  }

  let searchNote = "";
  const modeStyle =
    typeof body?.mode === "string" && MODE_STYLES[body.mode]
      ? " " + MODE_STYLES[body.mode]
      : "";

  if (body?.search === true) {
    if (!SEARCH_KEY) {
      return Response.json(
        {
          error:
            "Cari web belum aktif. Minta owner daftar gratis di tavily.com lalu isi SEARCH_API_KEY.",
        },
        { status: 502 },
      );
    }
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const query = textOf(lastUser?.content ?? "").slice(0, 300) || "berita terkini";
    try {
      const sr = await fetch(SEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: SEARCH_KEY,
          query,
          max_results: 3,
          include_answer: false,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (sr.ok) {
        const sj = await sr.json().catch(() => null);
        const results = (Array.isArray(sj?.results) ? sj.results : [])
          .slice(0, 3)
          .map(
            (r: { title?: string; content?: string; url?: string }) =>
              `- ${r.title ?? ""}: ${String(r.content ?? "").slice(0, 500)} (${r.url ?? ""})`,
          )
          .join("\n");
        if (results) {
          searchNote =
            " Hasil pencarian web TERKINI (pakai jika relevan, akiri dengan menyebutkan sumber singkat):\n" +
            results;
        }
      }
    } catch {}
  }

  let upstream: Response;
  try {
    upstream = await fetch(imageUsed ? VISION_API_URL : API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${imageUsed ? VISION_API_KEY : API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: imageUsed ? VISION_MODEL : MODEL,
        messages: [{ role: "system", content: SYSTEM + modeStyle + searchNote }, ...history],
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
