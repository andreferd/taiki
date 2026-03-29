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

// In-memory cache (persists across requests in the same server instance)
let cache: { data: SentimentResult | null; timestamp: number } = {
  data: null,
  timestamp: 0,
};

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchTweets(): Promise<Tweet[]> {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) throw new Error("X_BEARER_TOKEN environment variable is not set");

  // Resolve user ID
  const userRes = await fetch(
    "https://api.twitter.com/2/users/by/username/TaikiMaeda2",
    { headers: { Authorization: `Bearer ${bearerToken}` } }
  );
  if (!userRes.ok) {
    const err = await userRes.text();
    throw new Error(`X API user lookup failed (${userRes.status}): ${err}`);
  }
  const { data: user } = await userRes.json();

  // Fetch recent tweets + replies
  const tweetsRes = await fetch(
    `https://api.twitter.com/2/users/${user.id}/tweets` +
      `?max_results=20&tweet.fields=created_at,text&exclude=retweets`,
    { headers: { Authorization: `Bearer ${bearerToken}` } }
  );
  if (!tweetsRes.ok) {
    const err = await tweetsRes.text();
    throw new Error(`X API timeline failed (${tweetsRes.status}): ${err}`);
  }
  const { data } = await tweetsRes.json();
  return data || [];
}

export async function GET() {
  // Serve from cache if still fresh
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    return NextResponse.json({ ...cache.data, cached: true });
  }

  try {
    const tweets = await fetchTweets();

    const anthropic = new Anthropic();
    const tweetsText = tweets
      .map((t, i) => `${i + 1}. ${t.text}`)
      .join("\n\n");

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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
