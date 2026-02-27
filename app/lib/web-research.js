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
  'gpu', 'vram', 'ram', 'laptop', 'phone', 'shopee', 'lazada',
  'spec', 'model', 'compare', 'banding',
];

const FORCE_BROWSE   = ['cari web', 'search web', 'browse web', 'web search'];
const NO_BROWSE      = ['tanpa browse', 'no web', 'no browse', 'jangan cari web', 'offline'];

// Meta/complaint messages that should NOT trigger web research
const META_PATTERNS = [
  /\b(suruh|ask|tell).*\b(cari|search|find|check)/i,
  /\b(kenapa|why|don'?t).*\b(you|kau|awak)/i,
  /\b(still|masih|lagi).*\b(sama|same|suruh)/i,
  /\b(bukan|not|wrong|salah).*\b(tu|that|ini|this)/i,
  /\b(tak guna|useless|bodoh|stupid)/i,
];

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

  // Meta/complaint messages should NOT trigger web search
  for (const rx of META_PATTERNS) {
    if (rx.test(lower)) {
      return { shouldBrowse: false, reason: 'meta_complaint' };
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
   2a. Query reformulation — turn casual Malay into good search queries
   ════════════════════════════════════════════════════════════ */

// Filler words to strip from search queries (Malay + English)
const FILLER_WORDS = new Set([
  'boleh', 'tolong', 'nak', 'saya', 'aku', 'check', 'cek', 'tengok',
  'tak', 'tak?', 'gak', 'ke', 'ka', 'kah', 'la', 'lah', 'je', 'jer',
  'ni', 'tu', 'yang', 'kan', 'eh', 'ye', 'ya', 'ok', 'okay',
  'please', 'can', 'you', 'i', 'me', 'the', 'a', 'is', 'it',
  'ada', 'dekat', 'deakt', 'dkat', 'dekt', 'kat', 'dalam', 'dgn', 'dengan', 'utk', 'untuk',
  'di', 'dari', 'pada',
]);

// Platform/site hints — map keywords to site search syntax
const SITE_HINTS = [
  { patterns: ['shopee', 'shope', 'shopie'], site: 'shopee.com.my' },
  { patterns: ['lazada', 'lzd'], site: 'lazada.com.my' },
  { patterns: ['mudah', 'mudah.my'], site: 'mudah.my' },
  { patterns: ['amazon'], site: 'amazon.com' },
  { patterns: ['carousell'], site: 'carousell.com.my' },
];

// Term expansion — casual/abbreviated → canonical search terms
const TERM_EXPANSION = [
  { from: /\bvram\s*(\d+)(?:gb|g)?\b/i, to: 'GPU graphics card $1GB VRAM' },
  { from: /\bgpu\s*(\d+)(?:gb|g)?\b/i, to: 'GPU graphics card $1GB' },
  { from: /\bram\s*(\d+)(?:gb|g)?\b/i, to: 'RAM $1GB' },
  { from: /\blaptop\b/i, to: 'laptop' },
  { from: /\bhp\b(?!\d)/i, to: 'phone handphone' },
  { from: /\bfon\b/i, to: 'phone' },
];

/**
 * Reformulate a casual user message into an optimized search query.
 * @param {string} userMessage
 * @returns {{ query: string, siteHint: string|null, original: string }}
 */
function reformulateQuery(userMessage) {
  const original = userMessage;
  let q = userMessage.toLowerCase().trim();

  // 1. Detect site hint FIRST, then remove platform name from query
  let siteHint = null;
  for (const sh of SITE_HINTS) {
    for (const p of sh.patterns) {
      if (q.includes(p)) {
        siteHint = sh.site;
        q = q.replace(new RegExp(`\\b${p}\\b`, 'gi'), '').trim();
        break;
      }
    }
    if (siteHint) break;
  }

  // 2. Apply term expansion (vram 16 → GPU graphics card 16GB VRAM)
  for (const exp of TERM_EXPANSION) {
    if (exp.from.test(q)) {
      q = q.replace(exp.from, exp.to);
      break; // Only apply first match
    }
  }

  // 3. Strip filler words
  q = q.split(/\s+/).filter(w => !FILLER_WORDS.has(w.replace(/[?!.,]/g, ''))).join(' ');

  // 4. Clean up extra spaces and punctuation
  q = q.replace(/\s+/g, ' ').replace(/^[\s,.!?]+|[\s,.!?]+$/g, '').trim();

  // 5. If query became too short, fall back to original minus filler
  if (q.length < 5) q = userMessage.replace(/\b(boleh|tolong|check|cek)\b/gi, '').trim();

  // 6. Add price context if user asked about price but word got stripped
  if (/harga|price|berapa|how much/i.test(original) && !/harga|price/i.test(q)) {
    q = 'harga ' + q;
  }

  // 7. Add "Malaysia" for price queries to localize results
  if (/harga|price|berapa|rm\s*\d/i.test(original) && !/malaysia/i.test(q)) {
    q += ' Malaysia';
  }

  return { query: q, siteHint, original };
}


/* ════════════════════════════════════════════════════════════
   2b. SSRF & domain safety
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
    engines: 'google,bing,yahoo',  // Default engines (brave/duckduckgo/startpage) often fail
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
 * Score a search result's relevance to the query.
 * Higher = more relevant.
 */
function scoreRelevance(result, queryTerms) {
  let score = 0;
  const haystack = `${result.title} ${result.snippet}`.toLowerCase();

  for (const term of queryTerms) {
    if (term.length < 2) continue;
    if (haystack.includes(term)) score += 2;
    // Partial match (e.g. "16gb" matches "16 gb")
    const digits = term.match(/\d+/);
    if (digits && haystack.includes(digits[0])) score += 1;
  }

  // Bonus for price indicators
  if (/rm\s?\d|\$\d|harga|price/i.test(haystack)) score += 3;

  // Bonus for reputable e-commerce / tech domains
  try {
    const host = new URL(result.url).hostname;
    if (/shopee|lazada|mudah|carousell|lelong/i.test(host)) score += 2;
    if (/lowyat|amanz|soyacincau|technave/i.test(host)) score += 2;
  } catch {}

  return score;
}

/**
 * Select sources: deduplicate by domain, rank by relevance, limit count.
 * @param {{title: string, url: string, snippet: string}[]} results
 * @param {number} maxSources
 * @param {string} queryStr - the search query for relevance scoring
 * @returns {string[]} urls
 */
function selectSources(results, maxSources = 4, queryStr = '') {
  // Score and sort by relevance
  const queryTerms = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const scored = results.map(r => ({ ...r, _score: scoreRelevance(r, queryTerms) }));
  scored.sort((a, b) => b._score - a._score);

  const seenDomains = new Set();
  const selected = [];

  for (const r of scored) {
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

  // Assess source quality — do sources actually contain relevant data?
  const queryWords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let totalHits = 0;
  for (const src of sources) {
    const hay = `${src.title} ${src.text}`.toLowerCase();
    for (const w of queryWords) {
      if (hay.includes(w)) totalHits++;
    }
  }
  const avgRelevance = sources.length > 0 ? totalHits / (sources.length * queryWords.length) : 0;
  const sourcesWeak = avgRelevance < 0.3;

  const knowledgeFallback = sourcesWeak
    ? (isMalay
      ? '\n\n⚠️ SUMBER WEB TERHAD — sumber yang dijumpai mungkin tidak tepat sepenuhnya. GUNAKAN pengetahuan am kamu untuk melengkapkan jawapan. Nyatakan data mana dari sumber dan mana dari pengetahuan am. Jangan hanya kata "tiada maklumat" — bantu pengguna sebaik mungkin.'
      : '\n\n⚠️ LIMITED WEB SOURCES — the sources found may not be fully relevant. SUPPLEMENT with your own knowledge where needed. Clearly indicate which data is from sources vs your general knowledge. Do NOT just say "no information" — help the user as best you can.')
    : '';

  const systemPrompt = isMalay
    ? `Kamu menjawab soalan pengguna menggunakan maklumat daripada sumber web berikut.

BAHASA: Jawab dalam Bahasa Melayu MALAYSIA. Bukan Bahasa Indonesia.
- Guna "awak/kamu" BUKAN "Anda". Guna "tak" BUKAN "tidak". Guna "cari" BUKAN "mencari".
- Guna "laman web" BUKAN "situs web". Guna "telefon" BUKAN "ponsel".
- ${sourcesWeak ? 'Sumber agak terhad — GABUNGKAN data sumber + pengetahuan am kamu.' : 'Gunakan data dari sumber.'}

FORMAT JAWAPAN:
1. Mulakan dengan ringkasan 1 baris yang menjawab soalan terus.
2. Gunakan **bold** untuk data penting (nama produk, harga, spec). Guna emoji (🔹, 🔥, 👉) untuk kemudahan imbasan.
3. Senaraikan data spesifik dari sumber — nama, harga, kuantiti — dalam bullet points.
4. Petik sumber menggunakan [1], [2] di sebelah data yang disokong.
5. Akhiri dengan 👉 **Kesimpulan** — 1-2 ayat ringkasan utama.
6. Senaraikan "Sumber:" dengan tajuk dan URL.

PERATURAN:
- Ekstrak SEMUA harga, nama produk, dan kuantiti yang ada dalam sumber.
- Jangan kata "tiada maklumat" jika sumber ada data — cari lebih teliti.
- Jika sumber berbeza, nyatakan julat (cth "RM 2,000 – RM 7,000").
- Jangan reka data. Jika bagi anggaran, nyatakan ia anggaran.
- DILARANG KERAS: Jangan sekali-kali suruh pengguna "buka laman web", "search sendiri", "layari Shopee", "check di Google", atau apa-apa arahan cari sendiri. Itu kerja KAMU.
- DILARANG: Jangan beri langkah-langkah "Cara mencari harga" atau tutorial carian. Pengguna nak JAWAPAN.
- Guna gaya santai jika pengguna bercakap santai. Guna "awak" bukan "Anda", "tak" bukan "tidak".

PENGLIBATAN: Akhiri jawapan dengan soalan susulan yang relevan untuk bantu pengguna buat pilihan.
Contoh: "Nak saya carikan pilihan dalam bajet tertentu?" / "Ada model tertentu yang awak minat?"`
    : `You are answering the user's question using the provided web extracts.

RESPONSE FORMAT:
1. Start with a 1-line summary directly answering the question.
2. Use **bold** for key data (product names, prices, specs). Use emoji markers (🔹, 🔥, 👉) for scan-ability.
3. List specific data from sources — names, prices, quantities — in bullet points.
4. Cite sources using [1], [2] inline next to the data they support.
5. End with a 👉 **Summary** — 1-2 sentence key takeaway.
6. List "Sources:" with title + URL.

RULES:
- Extract ALL prices, product names, and quantities from the sources.
- Do NOT say "no information available" if sources contain relevant data — look harder.
- If sources differ, present the range and explain (e.g. "RM 2,000 – RM 7,000 depending on model").
- Do NOT invent data.
- Answer in the same language as the user's question.
- Match the user's tone — if they are casual, be casual.

ENGAGEMENT: End your reply with a relevant follow-up question to help the user narrow their choice.
Example: "Want me to compare specific models?" / "What's your budget range?"`;

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
  contextBlock += knowledgeFallback;

  // Add format reminder right before user question (LLMs pay more attention to recent instructions)
  const formatReminder = isMalay
    ? '\n\n📋 PERINGATAN FORMAT: Gunakan **bold**, emoji (🔹🔥👉), bullet points. Ekstrak semua data spesifik (nama produk, harga, spec). Akhiri dengan soalan susulan.'
    : '\n\n📋 FORMAT REMINDER: Use **bold**, emoji (🔹🔥👉), bullet points. Extract all specific data (product names, prices, specs). End with a follow-up question.';
  contextBlock += formatReminder;

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

  // Strip browse commands, then reformulate for better search
  let rawQuery = userMessage
    .replace(/\b(cari web|search web|browse web|web search)[:\s]*/gi, '')
    .replace(/\b(tanpa browse|no web|no browse)\b/gi, '')
    .trim();

  if (rawQuery.length < 3) rawQuery = userMessage;

  const reformulated = reformulateQuery(rawQuery);
  let searchQuery = reformulated.query;

  // If user mentioned a specific platform, add it to the query (SearxNG doesn't reliably support site: operator)
  const siteHint = reformulated.siteHint;
  const siteQuery = siteHint
    ? `${searchQuery} ${siteHint}`
    : null;

  console.log('[web-research] Original:', userMessage);
  console.log('[web-research] Reformulated:', searchQuery, siteQuery ? `(+ ${siteHint})` : '');

  try {
    // Step 1: Search — try site-enhanced first, then general
    let searchResults = [];

    if (siteQuery) {
      searchResults = await webSearch(siteQuery, 6);
      console.log('[web-research] Site search returned:', searchResults.length, 'results');
    }

    // If site search returned too few results, also do general search
    if (searchResults.length < 3) {
      const generalResults = await webSearch(searchQuery, 6);
      console.log('[web-research] General search returned:', generalResults.length, 'results');
      // Merge, preferring site-specific results
      const seenUrls = new Set(searchResults.map(r => r.url));
      for (const r of generalResults) {
        if (!seenUrls.has(r.url)) {
          searchResults.push(r);
          seenUrls.add(r.url);
        }
      }
    }

    console.log('[web-research] Total search results:', searchResults.length);
    if (searchResults.length > 0) {
      console.log('[web-research] Top results:', searchResults.slice(0, 3).map(r => r.title).join(' | '));
    }

    if (!searchResults || searchResults.length === 0) {
      console.log('[web-research] No search results — returning null');
      return null;
    }

    // Step 2: Select & filter sources (now with relevance scoring)
    const candidateUrls = selectSources(searchResults, Math.max(maxSources, maxFetch), searchQuery);
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
    console.log('[web-research] Fetched:', fetched.length, 'of', fetchUrls.length, 'pages');

    // Step 4b: If page fetches returned too few, create sources from search snippets
    // (e-commerce SPAs like Shopee return empty HTML, but snippets have useful data)
    let finalSources;
    if (fetched.length === 0 || fetched.every(s => s.text.length < 100)) {
      console.log('[web-research] Page content weak/empty — using search snippets as sources');
      finalSources = searchResults.slice(0, maxSources)
        .filter(r => r.snippet && r.snippet.length > 10)
        .map(r => ({
          url: r.url,
          title: r.title,
          text: `${r.title}. ${r.snippet}`,
        }));
      if (finalSources.length === 0) {
        console.log('[web-research] No usable snippets either — returning null');
        return null;
      }
    } else {
      // Filter out fetched pages with very little content (SPA shells)
      const usable = fetched.filter(s => s.text.length >= 100);
      if (usable.length === 0) {
        // All fetched pages were SPA shells — fall back to snippets
        console.log('[web-research] All fetched pages are SPA shells — using snippets');
        finalSources = searchResults.slice(0, maxSources)
          .filter(r => r.snippet && r.snippet.length > 10)
          .map(r => ({ url: r.url, title: r.title, text: `${r.title}. ${r.snippet}` }));
      } else {
        finalSources = usable.slice(0, maxSources);
        // Supplement with snippet data if we have fewer sources than desired
        if (finalSources.length < maxSources) {
          const fetchedUrls = new Set(finalSources.map(s => s.url));
          const snippetSources = searchResults
            .filter(r => !fetchedUrls.has(r.url) && r.snippet && r.snippet.length > 10)
            .slice(0, maxSources - finalSources.length)
            .map(r => ({ url: r.url, title: r.title, text: `${r.title}. ${r.snippet}` }));
          if (snippetSources.length > 0) {
            console.log('[web-research] Supplementing with', snippetSources.length, 'snippet sources');
            finalSources = finalSources.concat(snippetSources);
          }
        }
      }
    }

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
  reformulateQuery,
  webSearch,
  selectSources,
  fetchAndExtract,
  fetchAll,
  performWebResearch,
  buildWebContext,
  isUrlSafe,
  cacheCleanup,
};
