"use client";

import { useEffect, useState } from "react";

interface SentimentData {
  sentiment: "bullish" | "bearish" | "neutral";
  summary: string;
  narrative: string;
  tweets: { id: string; text: string; created_at: string }[];
  analyzedAt: string;
  cached?: boolean;
  error?: string;
}

export default function Home() {
  const [data, setData] = useState<SentimentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    fetch("/api/sentiment")
      .then((r) => r.json())
      .then((d) => { setData(d); setImgError(false); })
      .finally(() => setLoading(false));
  }, []);

  const isBullish = data?.sentiment === "bullish";
  const isBearish = data?.sentiment === "bearish";

  const accentColor = isBullish
    ? "text-green-400"
    : isBearish
    ? "text-red-400"
    : "text-yellow-400";

  const bgGlow = isBullish
    ? "shadow-[0_0_120px_rgba(74,222,128,0.15)]"
    : isBearish
    ? "shadow-[0_0_120px_rgba(248,113,113,0.15)]"
    : "shadow-[0_0_120px_rgba(250,204,21,0.10)]";

  const borderColor = isBullish
    ? "border-green-500/30"
    : isBearish
    ? "border-red-500/30"
    : "border-yellow-500/30";

  const imageSrc = isBullish ? "/bullish.jpg" : "/bearish.jpg";
  const sentimentLabel = isBullish ? "BULLISH" : isBearish ? "BEARISH" : "NEUTRAL";

  return (
    <main className="min-h-screen flex flex-col items-center justify-start bg-black px-4 py-12">
      {/* Header */}
      <div className="mb-10 text-center">
        <p className="text-zinc-500 text-sm uppercase tracking-widest mb-2">
          @TaikiMaeda2 on X
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
          Is Taiki{" "}
          {loading ? (
            <span className="text-zinc-600 animate-pulse">loading…</span>
          ) : (
            <span className={accentColor}>{sentimentLabel}</span>
          )}
          ?
        </h1>
      </div>

      {/* Error state */}
      {!loading && data?.error && (
        <div className="max-w-lg w-full rounded-2xl border border-red-500/30 bg-red-950/20 p-6 text-center text-red-400 text-sm">
          <p className="font-semibold mb-1">Could not fetch sentiment</p>
          <p className="text-red-400/70">{data.error}</p>
          <p className="mt-3 text-zinc-500 text-xs">
            Make sure <code className="text-zinc-300">X_BEARER_TOKEN</code> and{" "}
            <code className="text-zinc-300">ANTHROPIC_API_KEY</code> are set.
          </p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="max-w-md w-full flex flex-col items-center gap-6 animate-pulse">
          <div className="w-72 h-72 rounded-3xl bg-zinc-800" />
          <div className="w-48 h-8 rounded-lg bg-zinc-800" />
          <div className="w-full h-4 rounded bg-zinc-800" />
          <div className="w-5/6 h-4 rounded bg-zinc-800" />
        </div>
      )}

      {/* Main content */}
      {!loading && !data?.error && data && (
        <div className="w-full max-w-2xl flex flex-col items-center gap-8">
          {/* Face image */}
          <div
            className={`relative rounded-3xl overflow-hidden border ${borderColor} ${bgGlow} transition-all duration-700`}
          >
            {imgError ? (
              <div
                className={`flex items-center justify-center w-full max-w-sm sm:max-w-md h-64 text-8xl select-none ${
                  isBullish ? "bg-green-950/40" : isBearish ? "bg-red-950/40" : "bg-zinc-900"
                }`}
              >
                {isBullish ? "🚀" : isBearish ? "🐻" : "😐"}
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageSrc}
                alt={sentimentLabel}
                className="object-cover w-full max-w-sm sm:max-w-md"
                onError={() => setImgError(true)}
              />
            )}
            {/* Sentiment badge overlay */}
            <div
              className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-6 py-2 rounded-full text-lg font-black tracking-widest backdrop-blur-sm border ${borderColor} ${
                isBullish
                  ? "bg-green-500/20 text-green-400"
                  : isBearish
                  ? "bg-red-500/20 text-red-400"
                  : "bg-yellow-500/20 text-yellow-400"
              }`}
            >
              {sentimentLabel}
            </div>
          </div>

          {/* Summary card */}
          <div
            className={`w-full rounded-2xl border ${borderColor} bg-zinc-900/60 p-6 space-y-3`}
          >
            <p className={`text-xl font-semibold leading-snug ${accentColor}`}>
              {data.summary}
            </p>
            <p className="text-zinc-400 text-base leading-relaxed">
              {data.narrative}
            </p>
          </div>

          {/* Recent tweets */}
          {data.tweets?.length > 0 && (
            <div className="w-full space-y-2">
              <p className="text-zinc-500 text-xs uppercase tracking-widest mb-3">
                Recent posts used for analysis
              </p>
              {data.tweets.map((tweet) => (
                <div
                  key={tweet.id}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-400 leading-relaxed"
                >
                  {tweet.text}
                </div>
              ))}
            </div>
          )}

          {/* Footer meta */}
          <div className="text-center text-zinc-600 text-xs space-y-1">
            <p>
              Analyzed{" "}
              {new Date(data.analyzedAt).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {data.cached && " · cached"}
            </p>
            <p>Refreshes every 30 minutes</p>
            <a
              href="https://x.com/TaikiMaeda2"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Follow @TaikiMaeda2 →
            </a>
          </div>
        </div>
      )}
    </main>
  );
}
