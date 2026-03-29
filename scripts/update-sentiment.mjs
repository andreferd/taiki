/**
 * Runs in GitHub Actions every 30 minutes.
 * Fetches Taiki's latest YouTube videos → analyzes with GLM-5 → writes data/sentiment.json
 *
 * YouTube RSS is completely free, requires no auth, and is never blocked.
 * Channel: https://www.youtube.com/@thehumblefarmer
 */

import { writeFileSync } from "fs";

const YOUTUBE_CHANNEL_ID = "UC7B3Y1yrg4S7mmgoR-NsfxA";
const YOUTUBE_RSS = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
const MOR_API_BASE = "https://api.mor.org/api/v1";

// ── YouTube Atom feed parsing ─────────────────────────────────────────────────
function parseYouTubeAtom(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const videoIdMatch = entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);
    const descMatch = entry.match(/<media:description>([\s\S]*?)<\/media:description>/);

    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const description = descMatch
      ? descMatch[1].trim().slice(0, 300)
      : "";

    entries.push({
      id: videoIdMatch?.[1]?.trim() ?? String(entries.length),
      // Combine title + description snippet as our "text" for analysis
      text: description ? `${title} — ${description}` : title,
      title,
      created_at: publishedMatch?.[1]?.trim() ?? "",
    });
  }

  return entries.slice(0, 15);
}

async function fetchVideos() {
  console.log("Fetching YouTube RSS…");
  const res = await fetch(YOUTUBE_RSS, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; bot)" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`YouTube RSS failed: HTTP ${res.status}`);

  const xml = await res.text();
  const videos = parseYouTubeAtom(xml);

  if (videos.length === 0) throw new Error("YouTube RSS returned 0 videos");

  console.log(`✓ Fetched ${videos.length} videos from YouTube`);
  return videos;
}

// ── GLM-5 analysis ────────────────────────────────────────────────────────────
const BULLISH_KEYWORDS = [
  ["bullish", 3], ["long", 2], ["buy", 2], ["buying", 2], ["accumulate", 3],
  ["bottom", 3], ["bottoming", 3], ["breakout", 2], ["bounce", 2],
  ["higher", 1], ["upside", 2], ["target", 1], ["moon", 2], ["pump", 2],
  ["rally", 2], ["reversal", 2], ["dip", 1], ["add", 1], ["recovery", 2],
  ["strong", 1], ["strength", 1], ["hold", 1], ["hodl", 2], ["ath", 2],
  ["conviction", 2], ["confident", 2], ["opportunity", 1], ["up", 1],
];
const BEARISH_KEYWORDS = [
  ["bearish", 3], ["short", 2], ["sell", 2], ["selling", 2], ["dump", 2],
  ["crash", 3], ["correction", 2], ["breakdown", 2], ["resistance", 1],
  ["lower", 1], ["downside", 2], ["risk", 1], ["caution", 2], ["careful", 1],
  ["down", 1], ["drop", 2], ["falling", 2], ["bear", 2], ["macro", 1],
  ["liquidation", 2], ["fear", 2], ["worried", 2], ["concern", 1],
  ["weak", 1], ["weakness", 1], ["rejected", 1], ["failed", 1],
  ["danger", 2], ["warning", 2], ["trap", 2],
];

function keywordFallback(videos) {
  const scored = videos.map((v) => {
    const lower = v.text.toLowerCase();
    let score = 0;
    for (const [kw, w] of BULLISH_KEYWORDS) if (lower.includes(kw)) score += w;
    for (const [kw, w] of BEARISH_KEYWORDS) if (lower.includes(kw)) score -= w;
    return { video: v, score };
  });
  const total = scored.reduce((s, x) => s + x.score, 0);
  const sentiment = total > 2 ? "bullish" : total < -2 ? "bearish" : "neutral";
  const sorted = [...scored].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const top = sorted[0]?.video;
  const label = sentiment === "bullish" ? "bullish 📈" : sentiment === "bearish" ? "bearish 📉" : "neutral 😐";
  return {
    sentiment,
    summary: top
      ? `Taiki is ${label} — latest video: "${top.title}"`
      : `Taiki appears ${label} based on recent videos.`,
    narrative: sorted
      .filter((s) => s.score !== 0)
      .slice(0, 3)
      .map((s) => s.video.title)
      .join(" / ") || "Not enough signal to form a clear narrative.",
  };
}

async function analyzeWithGLM(videos) {
  const apiKey = process.env.MOR_API_KEY;
  if (!apiKey) {
    console.warn("MOR_API_KEY not set — using keyword fallback");
    return keywordFallback(videos);
  }

  const content = videos
    .map((v, i) => `${i + 1}. [${v.created_at.slice(0, 10)}] ${v.text}`)
    .join("\n\n");

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
        content: `Analyze these recent YouTube videos by crypto analyst Taiki Maeda (@thehumblefarmer / @TaikiMaeda2).
Based on the titles and descriptions, determine if he is currently BULLISH or BEARISH on crypto/markets.

Videos (newest first):
${content}

Respond ONLY with a JSON object — no markdown, no extra text:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "summary": "One crisp sentence verdict based on his latest content",
  "narrative": "2–3 sentences on his key thesis and what he is watching"
}`,
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    console.warn(`GLM-5 error ${res.status} — using keyword fallback`);
    return keywordFallback(videos);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  try {
    const analysis = JSON.parse(clean);
    console.log("✓ GLM-5 analysis:", analysis.sentiment);
    return { sentiment: analysis.sentiment, summary: analysis.summary, narrative: analysis.narrative };
  } catch {
    console.warn("GLM-5 response parse failed — using keyword fallback");
    return keywordFallback(videos);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const videos = await fetchVideos();
const analysis = await analyzeWithGLM(videos);

const result = {
  ...analysis,
  tweets: videos.slice(0, 6).map((v) => ({
    id: v.id,
    text: `🎬 ${v.title}`,
    created_at: v.created_at,
  })),
  analyzedAt: new Date().toISOString(),
  source: "youtube",
};

writeFileSync("data/sentiment.json", JSON.stringify(result, null, 2));
console.log("✓ Wrote data/sentiment.json");
console.log(JSON.stringify(result, null, 2));
