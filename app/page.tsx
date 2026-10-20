"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  ChatCircleDots,
  Moon,
  SpeakerHigh,
  SpeakerSlash,
  Stop,
  Sun,
  WarningCircle,
} from "@phosphor-icons/react";

type Msg = { role: "user" | "assistant"; content: string };

const STARTER_POOL = [
  "Jelaskan cara kerja HTTP dengan bahasa sederhana",
  "Bantu saya menulis email penawaran ke klien",
  "Bandingkan React dan Vue untuk proyek kecil",
  "Ide konten media sosial untuk kedai kopi",
  "Buat caption Instagram untuk produk skincare",
  "Jelaskan apa itu API dengan analogi sehari-hari",
  "Tips presentasi biar tidak gugup",
  "Bantu susun CV singkat untuk fresh graduate",
  "Ide judul skripsi tentang UMKM digital",
  "Buat puisi pendek tentang hujan sore",
  "Ringkas artikel panjang jadi poin-poin penting",
  "Daftar belanja mingguan yang hemat untuk anak kos",
];

const PLACEHOLDERS = [
  "Tulis pesan...",
  "Tanya apa saja...",
  "Minta contoh atau ide...",
  "Minta tolong nulis apa pun...",
];

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starters, setStarters] = useState<string[]>([]);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [limited, setLimited] = useState(false);
  const [ph, setPh] = useState(0);
  const [splash, setSplash] = useState<"on" | "out" | "off">("on");
  const [speaking, setSpeaking] = useState<number | null>(null);

  const mainRef = useRef<HTMLElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  useEffect(() => {
    const el = mainRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    setStarters([...STARTER_POOL].sort(() => Math.random() - 0.5).slice(0, 4));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setPh((p) => p + 1), 3200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const t1 = setTimeout(() => setSplash("out"), 750);
    const t2 = setTimeout(() => setSplash("off"), 1150);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // siapkan daftar suara TTS (Chrome perlu "dipanasin" sekali)
  useEffect(() => {
    if ("speechSynthesis" in window) speechSynthesis.getVoices();
    return () => {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    };
  }, []);

  function speak(i: number, text: string) {
    if (!("speechSynthesis" in window)) return;
    if (speaking === i) {
      speechSynthesis.cancel();
      setSpeaking(null);
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("id"));
    if (voice) u.voice = voice;
    u.lang = "id-ID";
    u.onend = () => setSpeaking(null);
    u.onerror = () => setSpeaking(null);
    setSpeaking(i);
    speechSynthesis.speak(u);
  }

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const t = saved === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = t;
    setTheme(t);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    setTheme(next);
  }

  async function send(text: string) {
    const value = text.trim();
    if (!value || busy) return;

    setError(null);
    setInput("");
    setBusy(true);
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      setSpeaking(null);
    }

    const next: Msg[] = [...messages, { role: "user", content: value }];
    setMessages([...next, { role: "assistant", content: "" }]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const append = (delta: string) =>
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          copy[copy.length - 1] = { ...last, content: last.content + delta };
        }
        return copy;
      });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessages((prev) =>
          prev.filter(
            (m, i) => !(i === prev.length - 1 && m.role === "assistant" && m.content === ""),
          ),
        );
        if (res.status === 429) {
          setLimited(true);
          return;
        }
        setError(data?.error ?? "Permintaan gagal. Coba lagi.");
        return;
      }

      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) append(delta);
          } catch {
            // potongan SSE belum utuh, lanjut
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setError("Koneksi terputus. Coba lagi.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      setMessages((prev) =>
        prev.length && prev[prev.length - 1].role === "assistant" && prev[prev.length - 1].content === ""
          ? prev.slice(0, -1)
          : prev,
      );
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (finePointer) {
      e.preventDefault();
      send(input);
    }
  }

  const empty = messages.length === 0;
  const streaming = busy && messages[messages.length - 1]?.role === "assistant";

  return (
    <div className="flex h-[100svh] flex-col">
      {splash !== "off" && (
        <div
          role="status"
          aria-label="Memuat"
          className={"splash" + (splash === "out" ? " splash-out" : "")}
        >
          <div className="flex flex-col items-center gap-5">
            <div className="rings">
              <div className="ring ring1" />
              <div className="ring ring2" />
              <div className="ring ring3" />
              <div className="ring ring4" />
            </div>
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              memuat...
            </span>
          </div>
        </div>
      )}
      <header className="glass-bar animate-fade-down relative z-10 shrink-0 border-b border-[var(--glass-line)]">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-2.5 px-4">
          <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-accent-soft text-accent">
            <ChatCircleDots size={16} weight="fill" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">HCHBOT</span>
          <span className="ml-auto rounded-full border border-line px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
            Ndadev
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Ganti tema terang atau gelap"
            className="grid h-8 w-8 place-items-center rounded-full border border-line text-muted transition hover:rotate-12 hover:border-accent/40 hover:text-accent active:scale-95"
          >
            {theme === null ? (
              <span className="block h-4 w-4" />
            ) : (
              <span key={theme} className="animate-pop grid place-items-center">
                {theme === "dark" ? <Sun size={15} /> : <Moon size={15} weight="fill" />}
              </span>
            )}
          </button>
        </div>
      </header>

      <main
        ref={mainRef}
        className="chat-scroll relative -mt-14 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-20 sm:pb-10 sm:pt-24">
          {empty ? (
            <div className="animate-fade-up">
              <h1 className="text-[27px] font-semibold leading-[1.15] tracking-tight sm:text-4xl">
                Ada yang bisa saya bantu?
              </h1>
              <p className="mt-2.5 max-w-[52ch] text-[15px] leading-relaxed text-muted">
                Tulis pertanyaan di kolom bawah, atau mulai dari salah satu ide ini.
              </p>
              <ul className="mt-7 space-y-2">
                {starters.map((s, i) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => send(s)}
                      style={{ animationDelay: `${i * 55}ms` }}
                      className="glass animate-fade-up group flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-[14.5px] leading-snug transition hover:-translate-y-px hover:border-accent/40 hover:bg-accent-soft active:scale-[0.99]"
                    >
                      <span className="min-w-0 flex-1">{s}</span>
                      <ArrowRight
                        size={16}
                        className="shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="space-y-5">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <li key={i} className="animate-fade-up flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-accent to-accent-strong px-4 py-2.5 text-[15px] leading-relaxed text-onaccent shadow-[0_1px_10px_var(--accent-soft)]">
                      {m.content}
                    </div>
                  </li>
                ) : (
                  <li key={i} className="animate-fade-up flex gap-3">
                    <span
                      className={
                        "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[8px] bg-accent-soft text-accent" +
                        (streaming && i === messages.length - 1 ? " pulse-soft" : "")
                      }
                    >
                      <ChatCircleDots size={14} weight="fill" />
                    </span>
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.7]">
                        {m.content}
                        {streaming && i === messages.length - 1 && (
                          <span className="caret ml-0.5 inline-block h-[1.05em] w-[0.45em] translate-y-[0.15em] bg-accent align-baseline" />
                        )}
                      </p>
                      {m.content && !(streaming && i === messages.length - 1) && (
                        <button
                          type="button"
                          onClick={() => speak(i, m.content)}
                          aria-label={speaking === i ? "Berhenti membacakan" : "Bacakan jawaban"}
                          title="Dengarkan jawaban"
                          className="mt-1.5 inline-grid h-7 w-7 place-items-center rounded-full text-muted transition hover:bg-accent-soft hover:text-accent active:scale-95"
                        >
                          {speaking === i ? (
                            <SpeakerSlash size={14} weight="fill" />
                          ) : (
                            <SpeakerHigh size={14} />
                          )}
                        </button>
                      )}
                    </div>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </main>

      {error && (
        <div className="shrink-0 px-4 pb-1">
          <p
            key={error}
            role="alert"
            className="animate-fade-up mx-auto flex w-full max-w-3xl items-start gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-[13.5px] leading-snug text-accent"
          >
            <WarningCircle size={16} className="mt-px shrink-0" />
            {error}
          </p>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="glass-bar animate-fade-up shrink-0 border-t border-[var(--glass-line)]"
      >
        <div className="mx-auto w-full max-w-3xl px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="flex items-end gap-2 rounded-2xl border border-[var(--glass-line)] bg-surface/55 py-1.5 pl-4 pr-1.5 transition hover:border-accent/30 focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/25">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={
                input ? "Tulis pesan..." : PLACEHOLDERS[ph % PLACEHOLDERS.length]
              }
              aria-label="Pesan"
              className="max-h-32 min-h-[28px] flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-6 text-ink outline-none placeholder:text-muted"
            />
            {busy ? (
              <button
                type="button"
                onClick={stop}
                aria-label="Berhenti"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line text-ink transition hover:border-accent/50 hover:text-accent active:scale-95"
              >
                <Stop size={13} weight="fill" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Kirim"
                disabled={!input.trim()}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-strong text-onaccent shadow-[0_2px_12px_var(--accent-soft)] transition enabled:hover:scale-105 enabled:hover:brightness-110 enabled:active:scale-95 disabled:opacity-25"
              >
                <ArrowUp size={18} weight="bold" />
              </button>
            )}
          </div>
          <p className="mt-2 text-center text-[11px] text-muted">
            Respons bisa keliru. Periksa info penting.
          </p>
        </div>
      </form>

      {limited && (
        <div
          className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/45 px-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Batas permintaan tercapai"
          onClick={() => setLimited(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="animate-zoom glass w-full max-w-sm rounded-3xl p-6 text-center"
          >
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
              <WarningCircle size={26} weight="fill" />
            </span>
            <h2 className="mt-4 text-xl font-semibold tracking-tight">
              Waduh, limit broh!
            </h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
              Maap, masih demo soalnya. Coba lain waktu ya.
            </p>
            <button
              type="button"
              onClick={() => setLimited(false)}
              className="mt-5 w-full rounded-full bg-gradient-to-br from-accent to-accent-strong px-4 py-2.5 text-sm font-medium text-onaccent shadow-[0_4px_16px_var(--accent-soft)] transition hover:brightness-110 active:scale-95"
            >
              Siap, nanti coba lagi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
