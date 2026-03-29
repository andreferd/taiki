/**
 * Runs in GitHub Actions every 30 minutes.
 * Fetches Taiki's tweets via Nitter RSS → analyzes with GLM-5 → writes data/sentiment.json
 */

import { writeFileSync } from "fs";

const NITTER_INSTANCES = [
  "https://nitter.net",
  "https://nitter.tiekoetter.com",
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.cz",
];

const MOR_API_BASE = "https://api.mor.org/api/v1";

// ── RSS parsing ───────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const tweets = [];
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

async function fetchTweets() {
  const errors = [];
  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetch(`${instance}/TaikiMaeda2/rss`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { errors.push(`${instance}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const tweets = parseRSS(xml);
      if (tweets.length === 0) { errors.push(`${instance}: 0 tweets parsed`); continue; }
      console.log(`✓ Fetched ${tweets.length} tweets from ${instance}`);
      return tweets;
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
    }
  }
  throw new Error(`All nitter instances failed:\n${errors.join("\n")}`);
}

// ── GLM-5 analysis ────────────────────────────────────────────────────────────
const BULLISH_KEYWORDS = [
  ["bullish", 3], ["long", 2], ["buy", 2], ["buying", 2], ["accumulate", 3],
  ["accumulating", 3], ["breakout", 2], ["bounce", 1], ["support", 1],
  ["higher", 1], ["upside", 2], ["target", 1], ["moon", 2], ["pump", 2],
  ["rally", 2], ["reversal", 1], ["bottom", 2], ["dip", 1], ["add", 1],
  ["adding", 1], ["calls", 1], ["up", 1], ["green", 1], ["recover", 1],
  ["recovery", 1], ["strong", 1], ["strength", 1], ["hold", 1], ["hodl", 2],
  ["ath", 2], ["conviction", 2], ["confident", 2],
];
const BEARISH_KEYWORDS = [
  ["bearish", 3], ["short", 2], ["sell", 2], ["selling", 2], ["dump", 2],
  ["dumping", 2], ["correction", 2], ["breakdown", 2], ["resistance", 1],
  ["lower", 1], ["downside", 2], ["risk", 1], ["caution", 2], ["careful", 1],
  ["puts", 1], ["down", 1], ["red", 1], ["drop", 1], ["falling", 1],
  ["bear", 2], ["macro", 1], ["hedge", 1], ["hedging", 1], ["exit", 2],
  ["liquidation", 2], ["fear", 2], ["worried", 2], ["concern", 1],
  ["weak", 1], ["weakness", 1], ["rejected", 1], ["failed", 1],
];

function keywordFallback(tweets) {
  const scored = tweets.map((t) => {
    const lower = t.text.toLowerCase();
    let score = 0;
    for (const [kw, w] of BULLISH_KEYWORDS) if (lower.includes(kw)) score += w;
    for (const [kw, w] of BEARISH_KEYWORDS) if (lower.includes(kw)) score -= w;
    return { tweet: t, score };
  });
  const total = scored.reduce((s, x) => s + x.score, 0);
  const sentiment = total > 2 ? "bullish" : total < -2 ? "bearish" : "neutral";
  const sorted = [...scored].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const top = sorted[0]?.tweet;
  const label = sentiment === "bullish" ? "bullish 📈" : sentiment === "bearish" ? "bearish 📉" : "neutral 😐";
  return {
    sentiment,
    summary: top
      ? `Taiki is ${label} — "${top.text.slice(0, 120)}${top.text.length > 120 ? "…" : ""}"`
      : `Taiki appears ${label} based on recent posts.`,
    narrative: sorted.filter((s) => s.score !== 0).slice(0, 3).map((s) => s.tweet.text.slice(0, 140)).join(" / ") ||
      "Not enough signal to form a clear narrative.",
  };
}

async function analyzeWithGLM(tweets) {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) {
    console.warn("MOR_API_KEY not set, using keyword fallback");
    return keywordFallback(tweets);
  }

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
      messages: [{
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
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    console.warn(`GLM-5 error ${res.status}, using keyword fallback`);
    return keywordFallback(tweets);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const analysis = JSON.parse(clean);
  console.log("✓ GLM-5 analysis complete:", analysis.sentiment);
  return { sentiment: analysis.sentiment, summary: analysis.summary, narrative: analysis.narrative };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const tweets = await fetchTweets();
const analysis = await analyzeWithGLM(tweets);

const result = {
  ...analysis,
  tweets: tweets.slice(0, 6),
  analyzedAt: new Date().toISOString(),
};

writeFileSync("data/sentiment.json", JSON.stringify(result, null, 2));
console.log("✓ Wrote data/sentiment.json");
console.log(result);
