import { NextResponse } from "next/server";

// The sentiment JSON is kept fresh by a GitHub Actions cron (every 30 min).
// We just read it from the raw GitHub URL — no scraping from Vercel needed.
const RAW_URL =
  "https://raw.githubusercontent.com/andreferd/taiki/main/data/sentiment.json";

// In-memory cache so we don't hit GitHub on every request
let cache: { data: unknown; timestamp: number } = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    const res = await fetch(RAW_URL, {
      // Bypass GitHub's CDN cache so we always get the latest commit
      headers: { "Cache-Control": "no-cache" },
      next: { revalidate: 0 },
    });

    if (!res.ok) throw new Error(`GitHub raw fetch failed: HTTP ${res.status}`);

    const data = await res.json();
    cache = { data, timestamp: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    if (cache.data) return NextResponse.json(cache.data); // return stale on error
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
