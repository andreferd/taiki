import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

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
}

// In-memory cache (resets on cold start, good enough for serverless)
let cache: { data: SentimentResult | null; timestamp: number } = {
  data: null,
  timestamp: 0,
};

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Public nitter instances — tried in order until one responds
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

    // Title can be CDATA-wrapped or plain
    const titleMatch =
      item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      item.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

    if (!titleMatch) continue;

    // Strip any residual HTML tags (nitter sometimes includes them in titles)
    const text = titleMatch[1].replace(/<[^>]*>/g, "").trim();
    // Skip RT noise
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

      if (!res.ok) {
        errors.push(`${instance}: HTTP ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const tweets = parseRSS(xml);

      if (tweets.length === 0) {
        errors.push(`${instance}: parsed 0 tweets`);
        continue;
      }

      return tweets;
    } catch (err) {
      errors.push(`${instance}: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error(`All nitter instances failed:\n${errors.join("\n")}`);
}

export async function GET() {
  // Serve cache if still fresh
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    return NextResponse.json({ ...cache.data, cached: true });
  }

  try {
    const tweets = await fetchTweetsFromNitter();

    const anthropic = new Anthropic();
    const tweetsText = tweets.map((t, i) => `${i + 1}. ${t.text}`).join("\n\n");

    const message = await anthropic.messages.create({
      model: "claude-opus-4-6",
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
    });

    const content = message.content[0];
    if (content.type !== "text") throw new Error("Unexpected Claude response type");

    const analysis = JSON.parse(content.text);

    const result: SentimentResult = {
      sentiment: analysis.sentiment,
      summary: analysis.summary,
      narrative: analysis.narrative,
      tweets: tweets.slice(0, 6),
      analyzedAt: new Date().toISOString(),
    };

    cache = { data: result, timestamp: Date.now() };
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // If we have stale cache, return it with a warning rather than erroring
    if (cache.data) {
      return NextResponse.json({ ...cache.data, cached: true, stale: true });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
