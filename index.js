// index.js
// Cloudflare Worker — Megatube resolver + D1 catalog + MP4 URL caching
// D1 binding: DB  |  Cron: scheduled pre-warm

// ─── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
function jsonRes(data, extra = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function clampLimit(v, def = 60, max = 120) {
  const n = Number(v || def);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

// ─── SHARED CACHE HELPER ───────────────────────────────────────────────────
// All Worker-cache reads/writes flow through these two functions.
// Key convention:
//   Resolver   → https://mgcache.v/{videoId}
//   /api/*     → https://mgcache.api/{pathname}?{search}

async function cacheGet(key) {
  return caches.default.match(new Request(key));
}

function cachePut(key, response, ttl, ctx) {
  const clone = response.clone();
  clone.headers.set('Cache-Control', `public, max-age=${ttl}`);
  ctx.waitUntil(caches.default.put(new Request(key), clone));
}

const resolverKey = (id)             => `https://mgcache.v/${id}`;
const apiKey      = (path, search)   => `https://mgcache.api${path}?${search}`;

// ─── MP4 RESOLVER ──────────────────────────────────────────────────────────
// Three-layer cache:
//   1. Worker cache (fastest, edge-local, 7 days)
//   2. D1 mp4_cache table (persistent, survives Worker restarts)
//   3. Fresh fetch from MegaTube + HEAD validation

async function resolveVideoId(videoId, pageUrl, env, ctx) {
  const wKey = resolverKey(videoId);

  // Layer 1 — Worker cache
  const workerHit = await cacheGet(wKey);
  if (workerHit) {
    const data = await workerHit.clone().json();
    return { ...data, cached: true, cacheLayer: 'worker' };
  }

  // Layer 2 — D1 persistent cache
  const row = await env.DB
    .prepare('SELECT mp4_url, all_urls FROM mp4_cache WHERE video_id = ?')
    .bind(videoId)
    .first();

  if (row) {
    const result = {
      success: true, cached: true, cacheLayer: 'd1',
      video: row.mp4_url,
      all: JSON.parse(row.all_urls || '[]'),
      videoId,
    };
    const res = jsonRes(result, { 'Cache-Control': 'public, max-age=604800', 'X-Cache': 'HIT-D1' });
    ctx.waitUntil(caches.default.put(new Request(wKey), res.clone()));
    return result;
  }

  // Layer 3 — Fetch from MegaTube
  const page = await fetch(pageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.megatube.xxx/' },
  });
  const html = await page.text();
  const raw = html.match(/https:\/\/www\.megatube\.xxx\/get_file\/[^"' ]+\.mp4(?:\?[^"' ]*)?/g);
  if (!raw?.length) return { success: false, error: 'MP4 not found', videoId };

  const cleaned = [...new Set(raw)].map(v => v.replace(/&amp;/g, '&'));

  // Quality priority: non-_low non-download > non-_low > fallback
  const candidates = [
    cleaned.find(v => !v.includes('_low') && !v.includes('download=true')),
    cleaned.find(v => !v.includes('_low')),
    ...cleaned,
  ].filter(Boolean);

  let best = null;
  for (const c of candidates) {
    try {
      const head = await fetch(c, { method: 'HEAD', headers: { 'Referer': 'https://www.megatube.xxx/' } });
      if (head.ok) { best = c; break; }
    } catch (_) {}
  }
  if (!best) return { success: false, error: 'Dead MP4 URL', videoId };

  // Write to D1 (upsert)
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO mp4_cache (video_id, mp4_url, all_urls, cached_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         mp4_url   = excluded.mp4_url,
         all_urls  = excluded.all_urls,
         cached_at = excluded.cached_at`
    ).bind(videoId, best, JSON.stringify(cleaned), Date.now()).run()
  );

  const result = { success: true, cached: false, cacheLayer: 'fresh', video: best, all: cleaned, videoId };

  // Write to Worker cache
  const res = jsonRes(result, { 'Cache-Control': 'public, max-age=604800', 'X-Cache': 'MISS' });
  ctx.waitUntil(caches.default.put(new Request(wKey), res.clone()));

  return result;
}

// ─── ROUTE HANDLERS ────────────────────────────────────────────────────────

async function handleResolver(request, env, ctx) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return jsonRes({ success: false, error: 'Missing url parameter' }, {}, 400);
  const match = target.match(/\/videos\/(\d+)\//);
  if (!match)  return jsonRes({ success: false, error: 'Invalid Megatube URL' }, {}, 400);

  const result = await resolveVideoId(match[1], target, env, ctx);
  const xCache = result.cached ? `HIT-${(result.cacheLayer || 'CACHE').toUpperCase()}` : 'MISS';
  return jsonRes(result, { 'Cache-Control': 'public, max-age=604800', 'X-Cache': xCache });
}

async function handleVideosApi(request, env, ctx) {
  if (!env.DB) return jsonRes({ success: false, error: 'Missing D1 binding: DB' }, {}, 500);

  const url  = new URL(request.url);
  const wKey = apiKey('/videos', url.searchParams.toString());
  const hit  = await cacheGet(wKey);
  if (hit) return new Response(hit.body, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });

  const q         = (url.searchParams.get('q')         || '').trim().toLowerCase();
  const performer = (url.searchParams.get('performer') || '').trim().toLowerCase();
  const studio    = (url.searchParams.get('studio')    || '').trim().toLowerCase();
  const id        = url.searchParams.get('id');
  const limit     = clampLimit(url.searchParams.get('limit'), 60, 120);
  const offset    = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  let sql = `SELECT id, performer_group, group_count, performer, url, title, studio,
    original_duration, categories, tags, pornstars, description, embed_url,
    source, original_title FROM records WHERE 1=1`;
  const binds = [];

  if (id) { sql += ' AND id=?'; binds.push(Number(id)); }
  if (q) {
    sql += ' AND (lower(title) LIKE ? OR lower(performer_group) LIKE ? OR lower(performer) LIKE ? OR lower(studio) LIKE ? OR lower(description) LIKE ?)';
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }
  if (performer) { sql += ' AND (lower(performer_group)=? OR lower(performer)=?)'; binds.push(performer, performer); }
  if (studio)    { sql += ' AND lower(studio)=?'; binds.push(studio); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  const result = await env.DB.prepare(sql).bind(...binds).all();
  const res = jsonRes(
    { success: true, count: result.results?.length ?? 0, results: result.results ?? [] },
    { 'Cache-Control': 'public, max-age=60', 'X-Cache': 'MISS' }
  );
  cachePut(wKey, res, 60, ctx);
  return res;
}

async function handleStatsApi(request, env, ctx) {
  if (!env.DB) return jsonRes({ success: false, error: 'Missing D1 binding: DB' }, {}, 500);

  const wKey = apiKey('/stats', '');
  const hit  = await cacheGet(wKey);
  if (hit) return new Response(hit.body, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' } });

  const [total, groups, studios, mp4s] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM records'),
    env.DB.prepare('SELECT COUNT(DISTINCT performer_group) AS n FROM records'),
    env.DB.prepare('SELECT COUNT(DISTINCT studio) AS n FROM records'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM mp4_cache'),
  ]);

  const res = jsonRes({
    success: true,
    total_records:    total.results[0]?.n   ?? 0,
    performer_groups: groups.results[0]?.n  ?? 0,
    studios:          studios.results[0]?.n ?? 0,
    cached_mp4:       mp4s.results[0]?.n    ?? 0,
  }, { 'Cache-Control': 'public, max-age=300', 'X-Cache': 'MISS' });

  cachePut(wKey, res, 300, ctx);
  return res;
}

async function handlePing(env) {
  return jsonRes({ success: true, has_DB: !!env.DB, ts: new Date().toISOString() });
}

// ─── CRON: PRE-WARM MP4 CACHE ──────────────────────────────────────────────
// Triggered on schedule. Picks records not yet in mp4_cache and resolves
// their streaming URLs proactively so every user request is a cache hit.

async function prewarmBatch(env, ctx, batchSize = 20) {
  if (!env.DB) return;

  const uncached = await env.DB.prepare(`
    SELECT r.id, r.url FROM records r
    LEFT JOIN mp4_cache c ON c.video_id = CAST(r.id AS TEXT)
    WHERE c.video_id IS NULL
    ORDER BY r.id DESC
    LIMIT ?
  `).bind(batchSize).all();

  if (!uncached.results?.length) {
    console.log('[cron] All records already cached');
    return;
  }

  console.log(`[cron] Pre-warming ${uncached.results.length} URLs`);

  for (const row of uncached.results) {
    try {
      const res = await resolveVideoId(String(row.id), row.url, env, ctx);
      console.log(`[cron] ${row.id}: ${res.success ? res.video?.split('/').pop() : res.error}`);
    } catch (err) {
      console.log(`[cron] ${row.id} failed: ${err}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('[cron] Batch complete');
}

// ─── ROUTER ────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/videos') return handleVideosApi(request, env, ctx);
      if (pathname === '/api/stats')  return handleStatsApi(request, env, ctx);
      if (pathname === '/api/ping')   return handlePing(env);
      return handleResolver(request, env, ctx);
    } catch (err) {
      console.log(err);
      return jsonRes({ success: false, error: String(err) }, {}, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log(`[cron] triggered: ${event.cron}`);
    ctx.waitUntil(prewarmBatch(env, ctx, 20));
  },
};
