import { NextResponse } from "next/server";

interface Tweet {
  id: string;
  text: string;
  created_at: string;
}

interface SentimentResult {
  sentiment: "bullish" | "bearish" | "neutral";
  summary: string;
  narrative: string;
  tweets: Tweet[];
  analyzedAt: string;
  cached?: boolean;
  stale?: boolean;
}

// ── Morpheus / GLM-5 analysis ────────────────────────────────────────────────
const MOR_API_BASE = "https://api.mor.org/api/v1";

async function analyzeWithGLM(
  tweets: Tweet[]
): Promise<Pick<SentimentResult, "sentiment" | "summary" | "narrative">> {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) throw new Error("MOR_API_KEY environment variable is not set");

  const tweetsText = tweets.map((t, i) => `${i + 1}. ${t.text}`).join("\n\n");

  const res = await fetch(`${MOR_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "glm-5",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Analyze these recent posts from crypto analyst Taiki Maeda (@TaikiMaeda2) and determine if he is currently BULLISH or BEARISH on crypto/markets.

Posts:
${tweetsText}

Respond ONLY with a JSON object — no markdown, no extra text:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "summary": "One crisp sentence verdict",
  "narrative": "2–3 sentences on his key thesis and what he is watching"
}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Morpheus API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";

  // Strip possible markdown fences before parsing
  const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const analysis = JSON.parse(clean);

  return {
    sentiment: analysis.sentiment,
    summary: analysis.summary,
    narrative: analysis.narrative,
  };
}

// ── Keyword fallback (used if MOR_API_KEY is absent) ────────────────────────
const BULLISH_KEYWORDS: [string, number][] = [
  ["bullish", 3], ["long", 2], ["buy", 2], ["buying", 2], ["accumulate", 3],
  ["accumulating", 3], ["breakout", 2], ["bounce", 1], ["support", 1],
  ["higher", 1], ["upside", 2], ["target", 1], ["moon", 2], ["pump", 2],
  ["rally", 2], ["reversal", 1], ["bottom", 2], ["dip", 1], ["add", 1],
  ["adding", 1], ["calls", 1], ["up", 1], ["green", 1], ["recover", 1],
  ["recovery", 1], ["strong", 1], ["strength", 1], ["hold", 1], ["hodl", 2],
  ["ath", 2], ["all time high", 3], ["conviction", 2], ["confident", 2],
];
const BEARISH_KEYWORDS: [string, number][] = [
  ["bearish", 3], ["short", 2], ["sell", 2], ["selling", 2], ["dump", 2],
  ["dumping", 2], ["correction", 2], ["breakdown", 2], ["resistance", 1],
  ["lower", 1], ["downside", 2], ["risk", 1], ["caution", 2], ["careful", 1],
  ["puts", 1], ["down", 1], ["red", 1], ["drop", 1], ["falling", 1],
  ["bear", 2], ["macro", 1], ["hedge", 1], ["hedging", 1], ["exit", 2],
  ["liquidation", 2], ["fear", 2], ["worried", 2], ["concern", 1],
  ["weak", 1], ["weakness", 1], ["rejected", 1], ["failed", 1],
];

function keywordFallback(
  tweets: Tweet[]
): Pick<SentimentResult, "sentiment" | "summary" | "narrative"> {
  const scored = tweets.map((t) => {
    const lower = t.text.toLowerCase();
    let score = 0;
    for (const [kw, w] of BULLISH_KEYWORDS) if (lower.includes(kw)) score += w;
    for (const [kw, w] of BEARISH_KEYWORDS) if (lower.includes(kw)) score -= w;
    return { tweet: t, score };
  });
  const total = scored.reduce((s, x) => s + x.score, 0);
  const sentiment: SentimentResult["sentiment"] =
    total > 2 ? "bullish" : total < -2 ? "bearish" : "neutral";
  const sorted = [...scored].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const top = sorted[0]?.tweet;
  const label = sentiment === "bullish" ? "bullish 📈" : sentiment === "bearish" ? "bearish 📉" : "neutral 😐";
  return {
    sentiment,
    summary: top
      ? `Taiki is ${label} — "${top.text.slice(0, 120)}${top.text.length > 120 ? "…" : ""}"`
      : `Taiki appears ${label} based on recent posts.`,
    narrative: sorted
      .filter((s) => s.score !== 0)
      .slice(0, 3)
      .map((s) => s.tweet.text.slice(0, 140))
      .join(" / ") || "Not enough signal to form a clear narrative.",
  };
}

// ── Nitter RSS fetching ──────────────────────────────────────────────────────
const NITTER_INSTANCES = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.cz",
  "https://nitter.1d4.us",
  "https://nitter.esmailelbob.xyz",
];

function parseRSS(xml: string): Tweet[] {
  const tweets: Tweet[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleMatch =
      item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      item.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!titleMatch) continue;
    const text = titleMatch[1].replace(/<[^>]*>/g, "").trim();
    if (text.startsWith("RT by")) continue;
    tweets.push({
      id: linkMatch?.[1]?.split("/").pop() ?? String(tweets.length),
      text,
      created_at: dateMatch?.[1] ?? "",
    });
  }
  return tweets.slice(0, 20);
}

async function fetchTweetsFromNitter(): Promise<Tweet[]> {
  const errors: string[] = [];
  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetch(`${instance}/TaikiMaeda2/rss`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
        signal: AbortSignal.timeout(6000),
        next: { revalidate: 0 },
      });
      if (!res.ok) { errors.push(`${instance}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const tweets = parseRSS(xml);
      if (tweets.length === 0) { errors.push(`${instance}: 0 tweets parsed`); continue; }
      return tweets;
    } catch (err) {
      errors.push(`${instance}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(`All nitter instances failed:\n${errors.join("\n")}`);
}

// ── Cache ────────────────────────────────────────────────────────────────────
let cache: { data: SentimentResult | null; timestamp: number } = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000;

// ── Route ────────────────────────────────────────────────────────────────────
export async function GET() {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    return NextResponse.json({ ...cache.data, cached: true });
  }

  try {
    const tweets = await fetchTweetsFromNitter();

    // Use GLM-5 if key is set, otherwise fall back to keyword scoring
    const analysis = process.env.MOR_API_KEY
      ? await analyzeWithGLM(tweets)
      : keywordFallback(tweets);

    const result: SentimentResult = {
      ...analysis,
      tweets: tweets.slice(0, 6),
      analyzedAt: new Date().toISOString(),
    };

    cache = { data: result, timestamp: Date.now() };
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (cache.data) {
      return NextResponse.json({ ...cache.data, cached: true, stale: true });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
