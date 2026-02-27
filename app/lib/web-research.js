/**
 * Web Research — search the web, fetch pages, extract content, cache results
 *
 * Providers: SearXNG (default, self-hosted), Tavily, SerpAPI
 * Security: SSRF protection, domain allow/block lists, timeouts
 */

const crypto = require('crypto');
const { getSetting } = require('./settings');
const { query } = require('./db');

/* ════════════════════════════════════════════════════════════
   1. Decide whether to browse
   ════════════════════════════════════════════════════════════ */

const BROWSE_KEYWORDS = [
  'harga', 'price', 'pasaran', 'today', 'sekarang', 'latest', 'news',
  'release', 'availability', 'stock', 'near me', 'cuaca', 'weather',
  'terkini', 'semasa', 'current', 'update', 'baru',
  'berapa', 'how much', 'where to buy', 'review',
];

const FORCE_BROWSE   = ['cari web', 'search web', 'browse web', 'web search'];
const NO_BROWSE      = ['tanpa browse', 'no web', 'no browse', 'jangan cari web', 'offline'];

/**
 * Determine whether a user message should trigger web research.
 * @param {string} userMessage
 * @returns {{ shouldBrowse: boolean, reason: string }}
 */
function shouldBrowseWeb(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') {
    return { shouldBrowse: false, reason: 'empty_message' };
  }

  const lower = userMessage.toLowerCase().trim();

  // Explicit override: no browse
  for (const phrase of NO_BROWSE) {
    if (lower.includes(phrase)) {
      return { shouldBrowse: false, reason: 'user_opted_out' };
    }
  }

  // Explicit override: force browse
  for (const phrase of FORCE_BROWSE) {
    if (lower.includes(phrase)) {
      return { shouldBrowse: true, reason: 'user_forced' };
    }
  }

  // Keyword match
  for (const kw of BROWSE_KEYWORDS) {
    if (lower.includes(kw)) {
      return { shouldBrowse: true, reason: `keyword:${kw}` };
    }
  }

  // Question patterns implying current data
  if (/\b(di mana|where|when|bila|kapan)\b/i.test(lower) && /\b(beli|buy|get|dapat)\b/i.test(lower)) {
    return { shouldBrowse: true, reason: 'purchase_query' };
  }

  return { shouldBrowse: false, reason: 'no_trigger' };
}


/* ════════════════════════════════════════════════════════════
   2. SSRF & domain safety
   ════════════════════════════════════════════════════════════ */

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
  /^fd/,
  /^localhost$/i,
];

function isPrivateHost(hostname) {
  return PRIVATE_IP_RANGES.some(rx => rx.test(hostname));
}

/**
 * Check if URL is safe to fetch (not internal, respects allow/block lists)
 */
function isUrlSafe(urlStr, allowedDomains, blockedDomains) {
  try {
    const u = new URL(urlStr);
    // Only http/https
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    // SSRF: block private IPs
    if (isPrivateHost(u.hostname)) return false;
    // Block list
    if (blockedDomains && blockedDomains.length > 0) {
      for (const bd of blockedDomains) {
        if (!bd) continue;
        if (u.hostname === bd || u.hostname.endsWith('.' + bd)) return false;
      }
    }
    // Allow list (if set, only allow those domains)
    if (allowedDomains && allowedDomains.length > 0 && allowedDomains[0] !== '') {
      const allowed = allowedDomains.some(
        ad => u.hostname === ad || u.hostname.endsWith('.' + ad)
      );
      if (!allowed) return false;
    }
    return true;
  } catch {
    return false;
  }
}


/* ════════════════════════════════════════════════════════════
   3. Search providers
   ════════════════════════════════════════════════════════════ */

/**
 * Search via SearXNG (self-hosted)
 * @param {string} queryStr
 * @param {number} limit
 * @returns {Promise<{title: string, url: string, snippet: string}[]>}
 */
async function searchSearXNG(queryStr, limit = 6) {
  const baseUrl = await getSetting('web_research.searxng_url', 'http://searxng:8080');
  const params = new URLSearchParams({
    q: queryStr,
    format: 'json',
    categories: 'general',
    language: 'auto',
    safesearch: '1',
  });

  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 10_000);

  try {
    const res = await fetch(`${baseUrl}/search?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: ac.signal,
    });
    clearTimeout(tm);

    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    const data = await res.json();

    return (data.results || []).slice(0, limit).map(r => ({
      title:   r.title || '',
      url:     r.url || '',
      snippet: r.content || '',
    }));
  } catch (err) {
    clearTimeout(tm);
    throw new Error(`SearXNG search failed: ${err.message}`);
  }
}

/**
 * Search via Tavily API
 */
async function searchTavily(queryStr, limit = 6) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY not set');

  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 10_000);

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: queryStr,
        max_results: limit,
        search_depth: 'basic',
        include_answer: false,
      }),
      signal: ac.signal,
    });
    clearTimeout(tm);

    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const data = await res.json();

    return (data.results || []).slice(0, limit).map(r => ({
      title:   r.title || '',
      url:     r.url || '',
      snippet: r.content || '',
    }));
  } catch (err) {
    clearTimeout(tm);
    throw new Error(`Tavily search failed: ${err.message}`);
  }
}

/**
 * Search via SerpAPI (Google)
 */
async function searchSerpAPI(queryStr, limit = 6) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY not set');

  const params = new URLSearchParams({
    q: queryStr,
    api_key: apiKey,
    engine: 'google',
    num: String(limit),
  });

  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 10_000);

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: ac.signal,
    });
    clearTimeout(tm);

    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const data = await res.json();

    return (data.organic_results || []).slice(0, limit).map(r => ({
      title:   r.title || '',
      url:     r.link || '',
      snippet: r.snippet || '',
    }));
  } catch (err) {
    clearTimeout(tm);
    throw new Error(`SerpAPI search failed: ${err.message}`);
  }
}

/**
 * Universal search dispatcher
 */
async function webSearch(queryStr, limit = 6) {
  const provider = await getSetting('web_research.search_provider', 'searxng');

  switch (provider) {
    case 'tavily':  return searchTavily(queryStr, limit);
    case 'serpapi': return searchSerpAPI(queryStr, limit);
    case 'searxng':
    default:        return searchSearXNG(queryStr, limit);
  }
}


/* ════════════════════════════════════════════════════════════
   4. Select best sources
   ════════════════════════════════════════════════════════════ */

/**
 * Select sources: deduplicate by domain, prefer reputable, limit count.
 * @param {{title: string, url: string, snippet: string}[]} results
 * @param {number} maxSources
 * @returns {string[]} urls
 */
function selectSources(results, maxSources = 4) {
  const seenDomains = new Set();
  const selected = [];

  for (const r of results) {
    try {
      const hostname = new URL(r.url).hostname;
      if (seenDomains.has(hostname)) continue;
      seenDomains.add(hostname);
      selected.push(r.url);
      if (selected.length >= maxSources) break;
    } catch {
      // Skip invalid URLs
    }
  }

  return selected;
}


/* ════════════════════════════════════════════════════════════
   5. Fetch & extract page content
   ════════════════════════════════════════════════════════════ */

const USER_AGENT = 'Mozilla/5.0 (compatible; GetouchBot/1.0; +https://getouch.co)';
const MAX_TEXT_LENGTH = 20_000; // characters per page

/**
 * Strip HTML tags and extract readable text.
 * Lightweight extraction without Readability dependency.
 */
function extractText(html) {
  // Remove scripts, styles, SVGs, navs, footers, headers, forms
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Try to extract <article> or <main> content first
  const articleMatch = text.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  const mainMatch    = text.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);

  if (articleMatch) {
    text = articleMatch[1];
  } else if (mainMatch) {
    text = mainMatch[1];
  }

  // Strip remaining HTML
  text = text
    .replace(/<[^>]+>/g, ' ')          // remove tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();

  return text.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Extract <title> from HTML
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim().replace(/\s+/g, ' ') : '';
}

/**
 * Fetch a single URL and extract clean text.
 * @param {string} url
 * @param {number} timeoutSec
 * @returns {Promise<{url: string, title: string, text: string} | null>}
 */
async function fetchAndExtract(url, timeoutSec = 8) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), timeoutSec * 1000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8',
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    clearTimeout(tm);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
      return null;
    }

    const html = await res.text();
    const title = extractTitle(html) || url;
    const text  = extractText(html);

    if (text.length < 50) return null; // Too little content

    return { url, title, text };
  } catch (err) {
    clearTimeout(tm);
    return null; // Skip failed fetches silently
  }
}

/**
 * Fetch multiple URLs in parallel with concurrency limit.
 */
async function fetchAll(urls, timeoutSec = 8) {
  const results = await Promise.allSettled(
    urls.map(u => fetchAndExtract(u, timeoutSec))
  );
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}


/* ════════════════════════════════════════════════════════════
   6. Cache layer (PostgreSQL)
   ════════════════════════════════════════════════════════════ */

function makeCacheKey(queryStr, urls) {
  const raw = JSON.stringify({ q: queryStr.toLowerCase().trim(), u: urls.sort() });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Lookup cached results.
 * @returns {Promise<{url,title,text}[] | null>}
 */
async function cacheGet(queryStr, urls) {
  const key = makeCacheKey(queryStr, urls);
  try {
    const res = await query(
      `SELECT results FROM web_cache WHERE cache_key = $1 AND expires_at > NOW() LIMIT 1`,
      [key]
    );
    if (res.rows.length > 0) return res.rows[0].results;
  } catch {}
  return null;
}

/**
 * Store results in cache.
 */
async function cacheSet(queryStr, urls, results, ttlMinutes = 30) {
  const key = makeCacheKey(queryStr, urls);
  try {
    await query(
      `INSERT INTO web_cache (cache_key, query, urls, results, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 minute' * $5)
       ON CONFLICT (cache_key) DO UPDATE
         SET results = $4, expires_at = NOW() + INTERVAL '1 minute' * $5`,
      [key, queryStr, urls, JSON.stringify(results), ttlMinutes]
    );
  } catch (err) {
    console.error('[web-research] Cache write failed:', err.message);
  }
}

/**
 * Clean expired cache entries (call periodically).
 */
async function cacheCleanup() {
  try {
    await query(`DELETE FROM web_cache WHERE expires_at < NOW()`);
  } catch {}
}


/* ════════════════════════════════════════════════════════════
   7. Build LLM context from web results
   ════════════════════════════════════════════════════════════ */

/**
 * Build a system prompt + context for web-augmented answers.
 * @param {{url: string, title: string, text: string}[]} sources
 * @param {string} userMessage
 * @returns {{ systemPrompt: string, contextBlock: string, sourcesFooter: string }}
 */
function buildWebContext(sources, userMessage) {
  // Detect if Malay
  const isMalay = /\b(boleh|cari|harga|apa|di mana|bagaimana|berapa|untuk|saya|tolong)\b/i.test(userMessage);

  const systemPrompt = isMalay
    ? `Anda menjawab soalan pengguna menggunakan maklumat daripada sumber web berikut. Petik sumber menggunakan [1], [2], dsb. Jika maklumat tidak mencukupi, nyatakan. Jawab dalam bahasa yang sama seperti soalan pengguna. Berikan jawapan ringkas dahulu, kemudian bukti sokongan dengan citation. Akhir sekali senaraikan "Sumber:" dengan tajuk dan URL. Jangan reka harga — jika sumber berbeza, nyatakan julat harga.`
    : `You are answering the user's question using the provided web extracts. Cite sources using [1], [2], etc.
If info is missing or insufficient, say so honestly.
Answer in the same language as the user's question.
Provide a concise answer first, then supporting evidence with citations [1][2].
End with a "Sources:" list showing title + URL.
Do not invent prices — if ranges differ across sources, present the range and explain.`;

  let contextBlock = '--- WEB RESEARCH RESULTS ---\n\n';
  const sourcesList = [];

  sources.forEach((src, i) => {
    const num = i + 1;
    // Truncate text to ~3000 chars per source for prompt efficiency
    const truncText = src.text.length > 3000
      ? src.text.slice(0, 3000) + '…'
      : src.text;
    contextBlock += `[${num}] ${src.title}\nURL: ${src.url}\n${truncText}\n\n`;
    sourcesList.push(`[${num}] ${src.title} — ${src.url}`);
  });

  contextBlock += '--- END WEB RESULTS ---';
  const sourcesFooter = sourcesList.join('\n');

  return { systemPrompt, contextBlock, sourcesFooter };
}


/* ════════════════════════════════════════════════════════════
   8. Main orchestrator
   ════════════════════════════════════════════════════════════ */

/**
 * Full web research pipeline:
 * 1. Search
 * 2. Select sources
 * 3. Check cache
 * 4. Fetch & extract (if not cached)
 * 5. Return context for LLM
 *
 * @param {string} userMessage - The original user message
 * @returns {Promise<{
 *   sources: {url: string, title: string, text: string}[],
 *   systemPrompt: string,
 *   contextBlock: string,
 *   searchResults: {title,url,snippet}[],
 *   provider: string,
 *   durationMs: number,
 *   fromCache: boolean,
 * } | null>}
 */
async function performWebResearch(userMessage) {
  const startTime = Date.now();

  // Load settings
  const maxSources = parseInt(await getSetting('web_research.max_sources', 4), 10);
  const maxFetch   = parseInt(await getSetting('web_research.max_fetch', 4), 10);
  const cacheTtl   = parseInt(await getSetting('web_research.cache_ttl_minutes', 30), 10);
  const timeoutSec = parseInt(await getSetting('web_research.timeout_seconds', 8), 10);
  const provider   = await getSetting('web_research.search_provider', 'searxng');

  const rawAllowed = await getSetting('web_research.allowed_domains', '');
  const rawBlocked = await getSetting('web_research.blocked_domains', 'localhost,127.0.0.1');

  const allowedDomains = typeof rawAllowed === 'string'
    ? rawAllowed.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const blockedDomains = typeof rawBlocked === 'string'
    ? rawBlocked.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Strip browse commands from query for cleaner search
  let searchQuery = userMessage
    .replace(/\b(cari web|search web|browse web|web search)[:\s]*/gi, '')
    .replace(/\b(tanpa browse|no web|no browse)\b/gi, '')
    .trim();

  if (searchQuery.length < 3) searchQuery = userMessage;

  try {
    // Step 1: Search
    const searchResults = await webSearch(searchQuery, 6);
    if (!searchResults || searchResults.length === 0) {
      return null;
    }

    // Step 2: Select & filter sources
    const candidateUrls = selectSources(searchResults, Math.max(maxSources, maxFetch));
    const safeUrls = candidateUrls.filter(u => isUrlSafe(u, allowedDomains, blockedDomains));

    if (safeUrls.length === 0) return null;

    const fetchUrls = safeUrls.slice(0, maxFetch);

    // Step 3: Check cache
    const cached = await cacheGet(searchQuery, fetchUrls);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      const ctx = buildWebContext(cached.slice(0, maxSources), userMessage);
      return {
        sources: cached.slice(0, maxSources),
        systemPrompt: ctx.systemPrompt,
        contextBlock: ctx.contextBlock,
        searchResults,
        provider,
        durationMs: Date.now() - startTime,
        fromCache: true,
      };
    }

    // Step 4: Fetch & extract
    const fetched = await fetchAll(fetchUrls, timeoutSec);
    if (fetched.length === 0) return null;

    const finalSources = fetched.slice(0, maxSources);

    // Step 5: Cache results
    await cacheSet(searchQuery, fetchUrls, finalSources, cacheTtl);

    // Step 6: Build context
    const ctx = buildWebContext(finalSources, userMessage);

    return {
      sources: finalSources,
      systemPrompt: ctx.systemPrompt,
      contextBlock: ctx.contextBlock,
      searchResults,
      provider,
      durationMs: Date.now() - startTime,
      fromCache: false,
    };
  } catch (err) {
    console.error('[web-research] Pipeline error:', err.message);
    return null;
  }
}


/* ── Periodic cache cleanup (every 10 minutes) ─────────── */
setInterval(cacheCleanup, 10 * 60 * 1000);


module.exports = {
  shouldBrowseWeb,
  webSearch,
  selectSources,
  fetchAndExtract,
  fetchAll,
  performWebResearch,
  buildWebContext,
  isUrlSafe,
  cacheCleanup,
};
