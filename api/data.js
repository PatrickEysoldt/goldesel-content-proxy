const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { google } = require('googleapis');

// ─── Vercel Function Config ─────────────────────────────────────────────────
// Increase timeout for AI API calls (Claude, DALL-E) which can take 15-30s
module.exports.config = { maxDuration: 60 };

// ─── GA4 Client (cached per cold start) ──────────────────────────────────────
let _ga4Client = null;
function getGA4Client() {
  if (_ga4Client) return _ga4Client;
  const keyJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(keyJson);
  _ga4Client = new BetaAnalyticsDataClient({ credentials });
  return _ga4Client;
}

// ─── Search Console Client (cached per cold start) ───────────────────────────
let _gscClient = null;
function getSearchConsoleClient() {
  if (_gscClient) return _gscClient;
  const keyJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  _gscClient = google.searchconsole({ version: 'v1', auth });
  return _gscClient;
}

const GSC_SITE = 'https://goldesel.de/';
const propertyId = process.env.GA4_PROPERTY_ID;
const TOPSTORY_CATEGORY_ID = 234;

// ─── Batch: combine multiple actions in one serverless call ──────
async function batch(actions, range = '30daysAgo') {
  const results = {};
  const promises = actions.map(async (action) => {
    try {
      switch (action) {
        case 'kpis': results.kpis = await kpis(range); break;
        case 'top5': results.top5 = await top5(range); break;
        case 'sources': results.sources = await sources(range); break;
        case 'monthlyStats': results.monthlyStats = await monthlyStats(); break;
        case 'newArticles': results.newArticles = await newArticlesThisMonth(); break;
        case 'dailyPageviews': results.dailyPageviews = await dailyPageviews(range); break;
        case 'reviewCandidates': results.reviewCandidates = await reviewCandidates(); break;
        case 'contentAnalysis': results.contentAnalysis = await contentAnalysis(); break;
        case 'contentAttribution': results.contentAttribution = await contentAttribution(); break;
      }
    } catch (err) {
      results[action] = { _error: err.message };
    }
  });
  await Promise.all(promises);
  return results;
}

// ─── WordPress Helper ─────────────────────────────────────────────────────────
async function wpFetch(path) {
  const base = process.env.WP_URL;
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const res = await fetch(`${base}/wp-json/wp/v2/${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`WP error: ${res.status}`);
  return res.json();
}

// ─── Yoast Focus Keyword Helper ──────────────────────────────────────────────
// WP REST API doesn't expose Yoast meta by default. We try multiple strategies:
// 1. meta._yoast_wpseo_focuskw (if site has REST meta registration)
// 2. Direct DB query via custom WP REST endpoint (if available)  
// 3. Parse from yoast_head raw HTML string
// 4. Return empty string

function extractYoastFromMeta(post) {
  const meta = post.meta || {};
  const yoast = post.yoast_head_json || {};
  
  // Strategy 1: Direct meta field (requires WP snippet or Yoast Premium)
  const focusKw = meta._yoast_wpseo_focuskw || meta['yoast_wpseo_focuskw'] || '';
  if (focusKw) return { focusKeyword: focusKw, source: 'meta' };
  
  // Strategy 2: Parse from yoast_head raw HTML string
  // Yoast injects a hidden meta or JSON-LD; the focuskw isn't in yoast_head,
  // but we can check for some indicators
  const yoastHead = post.yoast_head || '';
  
  // Strategy 3: Check yoast_head_json (title, og_description exist here)
  return {
    focusKeyword: '',
    seoTitle: yoast.title || meta._yoast_wpseo_title || '',
    seoDescription: yoast.og_description || yoast.description || meta._yoast_wpseo_metadesc || '',
    source: 'none'
  };
}

// Batch fetch focus keywords via WP postmeta table (custom endpoint)
// This requires the WP snippet below to be installed on goldesel.de:
/*
  === WP CODE SNIPPET (Add to functions.php or Code Snippets Plugin) ===
  
  // Expose Yoast Focus Keyword in REST API
  add_action('rest_api_init', function() {
    register_rest_field('post', 'yoast_focuskw', array(
      'get_callback' => function($post) {
        return get_post_meta($post['id'], '_yoast_wpseo_focuskw', true) ?: '';
      },
      'schema' => array('type' => 'string', 'description' => 'Yoast Focus Keyword'),
    ));
  });
  
  === END SNIPPET ===
*/
async function fetchYoastFocusKeywords(postIds) {
  if (!postIds.length) return {};
  const base = process.env.WP_URL;
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  
  // Try fetching with the custom yoast_focuskw field (requires snippet above)
  const results = {};
  
  try {
    // Fetch posts with include filter — checks if yoast_focuskw field is available
    const ids = postIds.slice(0, 30).join(',');
    const res = await fetch(
      `${base}/wp-json/wp/v2/posts?include=${ids}&_fields=id,yoast_focuskw,meta&per_page=30`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (res.ok) {
      const posts = await res.json();
      for (const p of posts) {
        // Custom field from snippet
        if (p.yoast_focuskw) {
          results[p.id] = p.yoast_focuskw;
        }
        // Fallback: check meta
        else if (p.meta?._yoast_wpseo_focuskw) {
          results[p.id] = p.meta._yoast_wpseo_focuskw;
        }
      }
    }
  } catch (err) {
    // Snippet not installed — that's fine, we return empty
  }
  
  return results;
}

// ─── Datum-Helper ─────────────────────────────────────────────────────────────
function resolveDate(d) {
  if (d === 'today') return new Date();
  const match = d.match(/^(\d+)daysAgo$/);
  if (match) {
    const date = new Date();
    date.setDate(date.getDate() - parseInt(match[1]));
    return date;
  }
  return new Date(d);
}
const fmtDate = (d) => (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];

// ─── GA4: Views + Channel-Aufschlüsselung ────────────────────────────────────
async function getViewsByChannel({ startDate, endDate }) {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: 'pagePath' },
      { name: 'sessionDefaultChannelGroup' },
    ],
    metrics: [{ name: 'screenPageViews' }],
    limit: 10000,
  });

  const map = {};
  response.rows?.forEach(row => {
    const path = row.dimensionValues[0].value;
    const channel = row.dimensionValues[1].value;
    const views = parseInt(row.metricValues[0].value);
    if (!map[path]) map[path] = { total: 0, channels: {} };
    map[path].total += views;
    map[path].channels[channel] = (map[path].channels[channel] || 0) + views;
  });
  return map;
}

// ─── WP Artikel + GA4 Views + Channel-Split ──────────────────────────────────
async function getArticlesWithChannels({ startDate, endDate, wpQuery, limit = 100 }) {
  const resolvedStart = resolveDate(startDate);
  const resolvedEnd = resolveDate(endDate);
  const after = resolvedStart.toISOString();

  const baseQuery = `posts?per_page=${limit}&status=publish&after=${after}&orderby=date&order=desc&_fields=id,title,link,date,slug`;
  const query = wpQuery ? `${baseQuery}&${wpQuery}` : baseQuery;
  const posts = await wpFetch(query);
  if (!posts.length) return [];

  const viewMap = await getViewsByChannel({
    startDate: fmtDate(resolvedStart),
    endDate: fmtDate(resolvedEnd),
  });

  return posts.map(p => {
    // goldesel.de/news/slug/ is the primary article path
    const paths = [
      `/news/${p.slug}/`,
      `/news/${p.slug}`,
      `/artikel/${p.slug}/`,
      `/artikel/${p.slug}`,
      `/${p.slug}/`,
      `/${p.slug}`,
    ];
    let data = { total: 0, channels: {} };
    for (const path of paths) {
      if (viewMap[path]) { data = viewMap[path]; break; }
    }
    return {
      title: p.title.rendered,
      path: `/news/${p.slug}/`,
      url: (p.link || '').replace('goldeselblog.de', 'goldesel.de'),
      slug: p.slug,
      date: p.date,
      pageviews: data.total,
      channels: data.channels,
    };
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function top5(range = '30daysAgo') {
  const articles = await getArticlesWithChannels({ startDate: range, endDate: 'today', limit: 100 });
  return articles.sort((a, b) => b.pageviews - a.pageviews).slice(0, 5);
}

async function flop5(range = '30daysAgo') {
  const articles = await getArticlesWithChannels({ startDate: range, endDate: 'today', limit: 100 });
  // Include articles with 0 views — they are genuine flops (likely bad GA4 path match or no traffic)
  return articles.sort((a, b) => a.pageviews - b.pageviews).slice(0, 5);
}

async function top5NewThisMonth() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const articles = await getArticlesWithChannels({ startDate: fmtDate(firstDay), endDate: fmtDate(now), limit: 100 });
  return articles.sort((a, b) => b.pageviews - a.pageviews).slice(0, 5);
}

async function flop5NewThisMonth() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const articles = await getArticlesWithChannels({ startDate: fmtDate(firstDay), endDate: fmtDate(now), limit: 100 });
  return articles.sort((a, b) => a.pageviews - b.pageviews).slice(0, 5);
}

async function topstories() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const articles = await getArticlesWithChannels({
    startDate: fmtDate(firstDay),
    endDate: fmtDate(now),
    wpQuery: `categories=${TOPSTORY_CATEGORY_ID}`,
    limit: 50,
  });
  const sorted = articles.sort((a, b) => b.pageviews - a.pageviews);
  const totalPageviews = sorted.reduce((s, a) => s + a.pageviews, 0);
  const channelTotals = {};
  sorted.forEach(a => {
    Object.entries(a.channels).forEach(([ch, v]) => {
      channelTotals[ch] = (channelTotals[ch] || 0) + v;
    });
  });
  return {
    count: sorted.length,
    totalPageviews,
    avgPageviews: sorted.length > 0 ? Math.round(totalPageviews / sorted.length) : 0,
    channelTotals,
    articles: sorted,
  };
}

async function kpis(range = '30daysAgo') {
  const client = getGA4Client();
  // For comparison, use a "previous period" range
  const daysMap = { '1daysAgo': 1, '7daysAgo': 7, '30daysAgo': 30, '90daysAgo': 90 };
  const days = daysMap[range] || 30;
  const prevRange = `${days * 2}daysAgo`;
  
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [
      { startDate: range, endDate: 'today' },
      { startDate: prevRange, endDate: `${days}daysAgo` },
    ],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'newUsers' },
      { name: 'totalUsers' },
    ],
  });
  const m = response.rows[0].metricValues;
  const result = {
    pageviews: parseInt(m[0].value),
    sessions: parseInt(m[1].value),
    newUsers: parseInt(m[2].value),
    totalUsers: parseInt(m[3].value),
  };
  
  // Calculate deltas from second date range if available
  if (response.rows.length > 1) {
    const prev = response.rows[1].metricValues;
    const delta = (cur, prv) => {
      const c = parseInt(cur), p = parseInt(prv);
      if (!p) return null;
      return Math.round(((c - p) / p) * 100);
    };
    result.delta = {
      pageviews: delta(m[0].value, prev[0].value),
      sessions: delta(m[1].value, prev[1].value),
      newUsers: delta(m[2].value, prev[2].value),
    };
  }
  
  return result;
}

async function sources(range = '30daysAgo') {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: range, endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });
  return response.rows.map(row => ({
    channel: row.dimensionValues[0].value,
    sessions: parseInt(row.metricValues[0].value),
  }));
}

async function articles() {
  const posts = await wpFetch('posts?per_page=10&status=publish&_fields=id,title,link,date,slug');
  return posts.map(p => ({ id: p.id, title: p.title.rendered, url: p.link, date: p.date, slug: p.slug }));
}

// Content category analysis for strategy page
async function contentAnalysis() {
  // Fetch articles by WP category with GA4 performance
  const allArticles = await getArticlesWithChannels({ startDate: '90daysAgo', endDate: 'today', limit: 200 });

  // Also get categories from WP
  const cats = await wpFetch('categories?per_page=50&_fields=id,name,count,slug');
  const catMap = {};
  cats.forEach(c => { catMap[c.id] = c; });

  // Group articles by their WP categories
  const categoryPerformance = {};
  allArticles.forEach(a => {
    (a.categories || []).forEach(catId => {
      const cat = catMap[catId];
      if (!cat) return;
      if (!categoryPerformance[cat.name]) {
        categoryPerformance[cat.name] = { name: cat.name, slug: cat.slug, count: 0, totalPageviews: 0, articles: [], channels: {} };
      }
      const cp = categoryPerformance[cat.name];
      cp.count++;
      cp.totalPageviews += a.pageviews;
      cp.articles.push({ title: a.title, pageviews: a.pageviews, path: a.path });
      Object.entries(a.channels || {}).forEach(([ch, v]) => {
        cp.channels[ch] = (cp.channels[ch] || 0) + v;
      });
    });
  });

  // Calculate averages and sort
  const categories = Object.values(categoryPerformance).map(c => ({
    ...c,
    avgPageviews: c.count > 0 ? Math.round(c.totalPageviews / c.count) : 0,
    topChannel: Object.entries(c.channels).sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
    articles: c.articles.sort((a, b) => b.pageviews - a.pageviews).slice(0, 3), // top 3 per category
  })).sort((a, b) => b.totalPageviews - a.totalPageviews);

  // Overall stats
  const total = allArticles.length;
  const totalPV = allArticles.reduce((s, a) => s + a.pageviews, 0);

  return { categories, totalArticles: total, totalPageviews: totalPV, period: '90 Tage' };
}

// ─── Content Attribution + Engagement ────────────────────────────────────────
async function contentAttribution() {
  const client = getGA4Client();

  // 1. Get landing page data with engagement metrics
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'landingPagePlusQueryString' }],
    metrics: [
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'screenPageViews' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
      { name: 'engagementRate' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'landingPagePlusQueryString',
        stringFilter: { matchType: 'CONTAINS', value: '/news/' },
      },
    },
    orderBys: [{ metric: { metricName: 'newUsers' }, desc: true }],
    limit: 50,
  });

  const articles = (response.rows || []).map(row => {
    const path = row.dimensionValues[0].value;
    const slug = path.split('/').filter(Boolean).pop() || path;
    const bounceRaw = parseFloat(row.metricValues[4].value || 0);
    const engRaw = parseFloat(row.metricValues[5].value || 0);
    // GA4 returns these as percentages (0-100) already
    const bounceRate = bounceRaw > 1 ? bounceRaw : bounceRaw * 100;
    const engagementRate = engRaw > 1 ? engRaw : engRaw * 100;
    return {
      path,
      slug,
      title: decodeURIComponent(slug).replace(/-/g, ' '),
      newUsers: parseInt(row.metricValues[0].value) || 0,
      sessions: parseInt(row.metricValues[1].value) || 0,
      pageviews: parseInt(row.metricValues[2].value) || 0,
      avgSessionDuration: parseFloat(row.metricValues[3].value || 0).toFixed(0),
      bounceRate: bounceRate.toFixed(1),
      engagementRate: engagementRate.toFixed(1),
    };
  });

  // 2. Enrich with WP titles + CTA detection (in batches of 10 slugs)
  try {
    const slugsToFetch = articles.slice(0, 30).map(a => a.slug).filter(Boolean);
    const titleMap = {};
    const ctaMap = {};
    
    // WP REST API: fetch in batches of 10 using slug parameter
    for (let i = 0; i < slugsToFetch.length; i += 10) {
      const batch = slugsToFetch.slice(i, i + 10);
      const slugParam = batch.map(s => encodeURIComponent(s)).join(',');
      try {
        const wpArticles = await wpFetch(`posts?per_page=10&status=publish&slug=${slugParam}&_fields=slug,title,content`);
        (wpArticles || []).forEach(p => {
          titleMap[p.slug] = p.title?.rendered || p.slug;
          const content = (p.content?.rendered || '').toLowerCase();
          ctaMap[p.slug] = {
            hasCTA: content.includes('premium') || content.includes('jetzt testen') || content.includes('kostenlos') || content.includes('registrier') || content.includes('anmeld') || content.includes('goldesel.de/premium') || content.includes('cta') || content.includes('signup'),
            hasProductMention: content.includes('goldesel') && (content.includes('tool') || content.includes('plattform') || content.includes('analyse') || content.includes('signal') || content.includes('watchlist')),
            hasInternalLinks: (content.match(/href="https?:\/\/(goldesel\.de|goldeselblog\.de)[^"]*"/gi) || []).length,
          };
        });
      } catch (batchErr) {
        console.error('WP batch error:', batchErr.message);
      }
    }
    
    articles.forEach(a => {
      if (titleMap[a.slug]) a.title = titleMap[a.slug];
      if (ctaMap[a.slug]) a.cta = ctaMap[a.slug];
    });
  } catch (err) {
    console.error('WP enrichment failed:', err.message);
    // Continue with GA4 data only — titles will be slug-based
  }

  // 3. Summary stats
  const totalNewUsers = articles.reduce((s, a) => s + a.newUsers, 0);
  const totalSessions = articles.reduce((s, a) => s + a.sessions, 0);
  const avgEngagement = articles.length ? (articles.reduce((s, a) => s + parseFloat(a.engagementRate), 0) / articles.length).toFixed(1) : '0';
  const withCTA = articles.filter(a => a.cta?.hasCTA).length;
  const withoutCTA = articles.filter(a => a.cta && !a.cta.hasCTA).length;

  return {
    articles,
    summary: {
      totalNewUsers,
      totalSessions,
      avgEngagement,
      articleCount: articles.length,
      withCTA,
      withoutCTA,
    },
    period: '30 Tage',
  };
}

async function dailyPageviews(range = '30daysAgo') {
  const client = getGA4Client();
  
  const daysMap = { '1daysAgo': 1, '7daysAgo': 7, '30daysAgo': 30, '90daysAgo': 90 };
  const days = daysMap[range] || 30;
  const prevStart = `${days * 2}daysAgo`;
  const prevEnd = `${days + 1}daysAgo`;
  
  // Current period only
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: range, endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'newUsers' },
    ],
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
  });
  
  const current = (response.rows || []).map(row => ({
    date: row.dimensionValues[0].value,
    pageviews: parseInt(row.metricValues[0].value),
    sessions: parseInt(row.metricValues[1].value),
    newUsers: parseInt(row.metricValues[2].value),
  }));
  
  // Previous period (separate call, non-blocking)
  let prevData = [];
  try {
    const [prevResp] = await client.runReport({
      property: propertyId,
      dateRanges: [{ startDate: prevStart, endDate: prevEnd }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'sessions' },
        { name: 'newUsers' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
    });
    prevData = (prevResp.rows || []).map(row => ({
      date: row.dimensionValues[0].value,
      pageviews: parseInt(row.metricValues[0].value),
      sessions: parseInt(row.metricValues[1].value),
      newUsers: parseInt(row.metricValues[2].value),
    }));
  } catch (e) {
    // Previous period fetch failed, not critical
  }
  
  return { current, previous: prevData };
}

// Top articles for a specific date (for chart drill-down)
async function topArticlesForDate(dateStr) {
  // dateStr format: YYYYMMDD
  const formatted = dateStr.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: formatted, endDate: formatted }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'newUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'pagePath',
        stringFilter: { matchType: 'CONTAINS', value: '/news/' },
      },
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 5,
  });
  return (response.rows || []).map(row => ({
    path: row.dimensionValues[0].value,
    title: row.dimensionValues[1].value,
    pageviews: parseInt(row.metricValues[0].value),
    newUsers: parseInt(row.metricValues[1].value),
  }));
}

// Top pages by channel for dashboard breakdown
async function topPagesByChannel() {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [
      { name: 'sessionDefaultChannelGroup' },
      { name: 'pagePath' },
      { name: 'pageTitle' },
    ],
    metrics: [{ name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 50,
  });
  return (response.rows || []).map(row => ({
    channel: row.dimensionValues[0].value,
    path: row.dimensionValues[1].value,
    title: row.dimensionValues[2].value,
    pageviews: parseInt(row.metricValues[0].value),
  }));
}

// ─── Review: letzte Artikel mit Volltext für KI-Analyse ──────────────────────
async function reviewCandidates() {
  // Letzte 15 veröffentlichte + alle drafts/pending
  // Include yoast_head_json for SEO meta (Yoast REST API extension)
  const [published, drafts, pending] = await Promise.all([
    wpFetch('posts?per_page=15&status=publish&orderby=date&order=desc&_fields=id,title,link,date,slug,categories,author,excerpt,yoast_head_json,meta,yoast_focuskw'),
    wpFetch('posts?per_page=10&status=draft&orderby=date&order=desc&_fields=id,title,link,date,slug,categories,author,excerpt,yoast_head_json,meta,yoast_focuskw').catch(() => []),
    wpFetch('posts?per_page=10&status=pending&orderby=date&order=desc&_fields=id,title,link,date,slug,categories,author,excerpt,yoast_head_json,meta,yoast_focuskw').catch(() => []),
  ]);

  const allPosts = [...pending, ...drafts, ...published];
  
  // Batch-fetch focus keywords (separate call in case custom field is available)
  const postIds = allPosts.map(p => p.id);
  const focusKeywords = await fetchYoastFocusKeywords(postIds).catch(() => ({}));

  const mapPost = (p, status) => {
    // Yoast exposes data via yoast_head_json (REST API v2) or meta fields
    const yoast = p.yoast_head_json || {};
    const meta = p.meta || {};
    
    // Focus keyword: try all sources
    const focusKeyword = 
      p.yoast_focuskw ||                          // Custom REST field (from WP snippet)
      focusKeywords[p.id] ||                       // Batch-fetched
      meta._yoast_wpseo_focuskw ||                 // Direct meta (if exposed)
      meta['yoast_wpseo_focuskw'] ||               // Alternative key
      '';

    return {
      id: p.id,
      title: p.title.rendered,
      url: (p.link || '').replace('goldeselblog.de', 'goldesel.de'),
      date: p.date,
      slug: p.slug,
      excerpt: (p.excerpt?.rendered || '').replace(/<[^>]*>/g, '').trim().substring(0, 200),
      wpStatus: status,
      categories: p.categories || [],
      // Yoast SEO fields
      focusKeyword,
      seoTitle: yoast.title || meta._yoast_wpseo_title || '',
      seoDescription: yoast.og_description || yoast.description || meta._yoast_wpseo_metadesc || '',
      seoScore: yoast.schema?.mainEntityOfPage?.['@type'] || '',
    };
  };

  return [
    ...pending.map(p => mapPost(p, 'pending')),
    ...drafts.map(p => mapPost(p, 'draft')),
    ...published.map(p => mapPost(p, 'publish')),
  ];
}

// Volltext eines einzelnen Artikels für KI-Review (inkl. Yoast SEO Meta)
async function articleContent(postId) {
  if (!postId) throw new Error('postId parameter required');
  const post = await wpFetch(`posts/${postId}?_fields=id,title,content,excerpt,slug,link,date,categories,author,yoast_head_json,meta,yoast_focuskw`);

  // Also try batch keyword fetch for this single post
  const focusKeywords = await fetchYoastFocusKeywords([postId]).catch(() => ({}));
  // HTML-Tags entfernen für sauberen Text
  const rawHtml = post.content?.rendered || '';
  const plainText = rawHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  // Struktur-Analyse aus HTML
  const headings = [];
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi;
  const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi;
  let match;
  while ((match = h2Regex.exec(rawHtml)) !== null) {
    headings.push({ level: 'H2', text: match[1].replace(/<[^>]*>/g, '').trim() });
  }
  while ((match = h3Regex.exec(rawHtml)) !== null) {
    headings.push({ level: 'H3', text: match[1].replace(/<[^>]*>/g, '').trim() });
  }

  const wordCount = plainText.split(/\s+/).filter(w => w.length > 0).length;
  const hasImages = /<img /i.test(rawHtml);
  const hasTables = /<table/i.test(rawHtml);
  const hasLists = /<[uo]l/i.test(rawHtml);
  const internalLinks = (rawHtml.match(/href="https?:\/\/(goldesel\.de|goldeselblog\.de)[^"]*"/gi) || []).length;
  const externalLinks = (rawHtml.match(/href="https?:\/\/(?!goldesel\.de|goldeselblog\.de)[^"]*"/gi) || []).length;

  // Yoast SEO data - try all sources
  const yoast = post.yoast_head_json || {};
  const meta = post.meta || {};
  const focusKeyword = 
    post.yoast_focuskw ||                          // Custom REST field
    focusKeywords[postId] ||                        // Batch-fetched
    meta._yoast_wpseo_focuskw ||                   // Direct meta
    meta['yoast_wpseo_focuskw'] ||                 // Alternative key
    '';
  const seoTitle = yoast.title || meta._yoast_wpseo_title || '';
  const seoDescription = yoast.og_description || yoast.description || meta._yoast_wpseo_metadesc || '';

  return {
    id: post.id,
    title: post.title?.rendered || '',
    url: (post.link || '').replace('goldeselblog.de', 'goldesel.de'),
    slug: post.slug,
    date: post.date,
    content: plainText,
    contentHtml: rawHtml,
    wordCount,
    headings,
    structure: {
      h2Count: headings.filter(h => h.level === 'H2').length,
      h3Count: headings.filter(h => h.level === 'H3').length,
      hasImages,
      hasTables,
      hasLists,
      internalLinks,
      externalLinks,
    },
    seo: {
      focusKeyword,
      seoTitle,
      seoDescription,
    },
  };
}

// ─── WordPress: Publish a draft/pending post ──────────────────────────────
async function publishPost(postId) {
  if (!postId) throw new Error('postId parameter required');
  const base = process.env.WP_URL;
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const res = await fetch(`${base}/wp-json/wp/v2/posts/${postId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'publish' }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WP publish failed (${res.status}): ${err}`);
  }
  const post = await res.json();
  return {
    id: post.id,
    title: post.title?.rendered || '',
    status: post.status,
    url: (post.link || '').replace('goldeselblog.de', 'goldesel.de'),
  };
}

// ─── KI-Review via Claude API (server-side proxy) ─────────────────────────
async function aiReview(postId) {
  if (!postId) throw new Error('postId parameter required');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

  // Get full article content (now includes Yoast SEO data)
  const article = await articleContent(postId);
  const focusKW = article.seo?.focusKeyword || '';

  // Truncate if very long
  const text = article.content.length > 12000
    ? article.content.substring(0, 12000) + '\n[...gekürzt...]'
    : article.content;

  // Build keyword-aware prompt
  const keywordBlock = focusKW
    ? `\n\nWICHTIG — FOKUS-KEYWORD: "${focusKW}"
Das Fokus-Keyword wurde vom Redakteur in Yoast SEO hinterlegt. Prüfe speziell:
- Kommt das Fokus-Keyword im H1/Title vor?
- Kommt es in der Meta Description vor?
- Kommt es in mindestens einer H2 vor?
- Kommt es in den ersten 100 Wörtern des Textes vor?
- Wie oft kommt es insgesamt vor? (ideal: 0.5-1.5% Keyword-Dichte)
- Gibt es sinnvolle Variationen/Synonyme des Keywords im Text?
- Ist das Keyword im URL-Slug enthalten?
Gib eine separate "keywordAnalysis" mit Ergebnis.`
    : '\n\nHINWEIS: Kein Fokus-Keyword in Yoast hinterlegt. Schlage ein geeignetes Fokus-Keyword vor.';

  const systemPrompt = `Du bist ein SEO- und Content-Experte für Goldesel.de, eine deutsche Trading-Plattform. Analysiere den folgenden Artikel und gib ein strukturiertes Review. Bewerte auf einer Skala von 0-100. Antworte NUR mit dem JSON-Objekt, kein Markdown, keine Backticks.
${keywordBlock}

JSON Format:
{
  "score": 75,
  "seoScore": 70,
  "qualityScore": 80,
  "productScore": 65,
  "summary": "Kurze Gesamtbewertung in 2 Sätzen",
  "strengths": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "weaknesses": ["Schwäche 1", "Schwäche 2"],
  "seoImprovements": ["Konkreter SEO-Tipp 1", "Konkreter SEO-Tipp 2", "Konkreter SEO-Tipp 3"],
  "contentImprovements": ["Inhaltlicher Verbesserungsvorschlag 1", "Vorschlag 2"],
  "keywordSuggestions": ["Keyword 1", "Keyword 2", "Keyword 3"],
  "keywordAnalysis": {
    "focusKeyword": "${focusKW || '(keins gesetzt)'}",
    "inTitle": true,
    "inMetaDesc": true,
    "inH2": true,
    "inFirst100Words": true,
    "inSlug": true,
    "occurrences": 5,
    "density": "0.8%",
    "verdict": "Keyword gut platziert / Keyword fehlt in wichtigen Positionen / etc.",
    "suggestedKeyword": "Falls kein Fokus-KW gesetzt: Vorschlag hier"
  },
  "metaTitleSuggestion": "Vorschlag für optimierten Meta-Title (max 60 Zeichen, Fokus-Keyword am Anfang!)",
  "metaDescriptionSuggestion": "Vorschlag für Meta-Description (max 155 Zeichen, Fokus-Keyword enthalten!)"
}

Bewertungskriterien:
- SEO: Keyword-Optimierung (Fokus-Keyword!), Überschriften-Hierarchie, Meta-Potential, interne Verlinkung, Suchintent
- Qualität: Lesbarkeit, Mehrwert, Struktur, Tiefe der Analyse, E-E-A-T Signale
- Produktbezug: Relevanz für Goldesel-Nutzer, Premium-Konvertierungspotential, CTA-Möglichkeiten

Kontext: Goldesel ist eine Trading-Plattform mit Free- und Premium-Modell. Content soll informieren UND konvertieren.`;

  const seoMetaLine = focusKW ? `Fokus-Keyword (Yoast): ${focusKW}` : 'Fokus-Keyword: NICHT GESETZT';
  const yoastMeta = article.seo?.seoTitle ? `\nYoast Meta-Title: ${article.seo.seoTitle}` : '';
  const yoastDesc = article.seo?.seoDescription ? `\nYoast Meta-Desc: ${article.seo.seoDescription}` : '';

  const userMsg = `Titel: ${article.title}\nURL: ${article.url}\nSlug: ${article.slug}\n${seoMetaLine}${yoastMeta}${yoastDesc}\nWörter: ${article.wordCount}\nH2: ${article.structure.h2Count} | H3: ${article.structure.h3Count} | Bilder: ${article.structure.hasImages} | Int. Links: ${article.structure.internalLinks} | Ext. Links: ${article.structure.externalLinks}\n\nÜberschriften:\n${article.headings.map(h => `${h.level}: ${h.text}`).join('\n')}\n\nVolltext:\n${text}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.content?.map(c => c.text || '').join('') || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    const review = JSON.parse(cleaned);
    return { article, review };
  } catch (e) {
    throw new Error(`JSON parse error: ${cleaned.substring(0, 200)}`);
  }
}

async function monthlyStats() {
  const client = getGA4Client();
  const now = new Date();
  const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayLastMonth = new Date(firstDayThisMonth - 1);
  const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1);

  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [
      { startDate: fmtDate(firstDayThisMonth), endDate: fmtDate(now), name: 'thisMonth' },
      { startDate: fmtDate(firstDayLastMonth), endDate: fmtDate(lastDayLastMonth), name: 'lastMonth' },
    ],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'newUsers' },
      { name: 'totalUsers' },
    ],
  });

  const extract = (name) => {
    const row = response.rows?.find(r => r.dimensionValues?.[0]?.value === name);
    if (!row) return { pageviews: 0, sessions: 0, newUsers: 0, totalUsers: 0 };
    return {
      pageviews: parseInt(row.metricValues[0].value),
      sessions: parseInt(row.metricValues[1].value),
      newUsers: parseInt(row.metricValues[2].value),
      totalUsers: parseInt(row.metricValues[3].value),
    };
  };

  const thisMonth = extract('thisMonth');
  const lastMonth = extract('lastMonth');
  const delta = (c, p) => p === 0 ? null : Math.round(((c - p) / p) * 100);

  return {
    thisMonth, lastMonth,
    delta: {
      pageviews: delta(thisMonth.pageviews, lastMonth.pageviews),
      sessions: delta(thisMonth.sessions, lastMonth.sessions),
      newUsers: delta(thisMonth.newUsers, lastMonth.newUsers),
    }
  };
}

async function newArticlesThisMonth() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const articles = await getArticlesWithChannels({ startDate: fmtDate(firstDay), endDate: fmtDate(now), limit: 100 });
  const totalPageviews = articles.reduce((s, a) => s + a.pageviews, 0);
  return {
    count: articles.length,
    pageviews: totalPageviews,
    avgPageviews: articles.length > 0 ? Math.round(totalPageviews / articles.length) : 0,
    articles: articles.map(a => ({ title: a.title, url: a.url, date: a.date, pageviews: a.pageviews })),
  };
}

// ─── Search Console Helper ────────────────────────────────────────────────────
async function searchConsoleForPath(path, excludePath = null) {
  const sc = getSearchConsoleClient();
  const now = new Date();
  const endDate = fmtDate(now);
  const startDate = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayLastMonth = new Date(firstDayThisMonth - 1);
  const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1);
  const prevStart = fmtDate(firstDayLastMonth);
  const prevEnd = fmtDate(lastDayLastMonth);

  // Filter: include path, optionally exclude a sub-path
  // Filters within a group are AND'd
  const makeFilters = () => {
    const filters = [{ dimension: 'page', operator: 'contains', expression: path }];
    if (excludePath) filters.push({ dimension: 'page', operator: 'notContains', expression: excludePath });
    return [{ filters }];
  };

  // Each call independently wrapped so one failure doesn't block all
  const safeQuery = async (params) => {
    try {
      const result = await sc.searchanalytics.query(params);
      return result;
    } catch (err) {
      console.error(`GSC query failed for path="${path}":`, err.message);
      return { data: { rows: [] } };
    }
  };

  const [summary, prevSummary, keywords, pages] = await Promise.all([
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensionFilterGroups: makeFilters() } }),
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate: prevStart, endDate: prevEnd, dimensionFilterGroups: makeFilters() } }),
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: ['query'], dimensionFilterGroups: makeFilters(), rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] } }),
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: ['page'], dimensionFilterGroups: makeFilters(), rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] } }),
  ]);

  const s = summary.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const p = prevSummary.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const delta = (c, prev) => prev === 0 ? null : Math.round(((c - prev) / prev) * 100);

  return {
    summary: {
      clicks: Math.round(s.clicks),
      impressions: Math.round(s.impressions),
      ctr: Math.round(s.ctr * 1000) / 10,
      position: Math.round(s.position * 10) / 10,
    },
    delta: {
      clicks: delta(s.clicks, p.clicks),
      impressions: delta(s.impressions, p.impressions),
      ctr: Math.round((s.ctr - p.ctr) * 1000) / 10,
      position: Math.round((p.position - s.position) * 10) / 10,
    },
    keywords: keywords.data.rows?.map(r => ({
      keyword: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    })) || [],
    pages: pages.data.rows?.map(r => ({
      page: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    })) || [],
  };
}

// Redaktionelle Artikel: goldesel.de/news/ aber NICHT /aktien/news/
// Verwende Regex statt contains+notContains für zuverlässigere Filterung
async function searchConsoleNews() {
  return searchConsoleForPathRegex(
    '/news/',                              // include: URLs mit /news/
    '^https://goldesel\\.de/aktien/news/'  // exclude regex: URLs die mit /aktien/news/ starten
  );
}
// KI News: goldesel.de/aktien/news/
async function searchConsoleAktienNews() { return searchConsoleForPath('/aktien/news/'); }

// Regex-basierte Variante für komplexere Filter
async function searchConsoleForPathRegex(includePath, excludeRegex = null) {
  const sc = getSearchConsoleClient();
  const now = new Date();
  const endDate = fmtDate(now);
  const startDate = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayLastMonth = new Date(firstDayThisMonth - 1);
  const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1);
  const prevStart = fmtDate(firstDayLastMonth);
  const prevEnd = fmtDate(lastDayLastMonth);

  const makeFilters = () => {
    const filters = [{ dimension: 'page', operator: 'contains', expression: includePath }];
    if (excludeRegex) {
      filters.push({ dimension: 'page', operator: 'excludingRegex', expression: excludeRegex });
    }
    return [{ filters }];
  };

  const safeQuery = async (params) => {
    try {
      const result = await sc.searchanalytics.query(params);
      return result;
    } catch (err) {
      console.error(`GSC regex query failed for include="${includePath}" exclude="${excludeRegex}":`, err.message);
      return { data: { rows: [] } };
    }
  };

  const [summary, prevSummary, keywords, pages] = await Promise.all([
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensionFilterGroups: makeFilters() } }),
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate: prevStart, endDate: prevEnd, dimensionFilterGroups: makeFilters() } }),
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: ['query'], dimensionFilterGroups: makeFilters(), rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] } }),
    safeQuery({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: ['page'], dimensionFilterGroups: makeFilters(), rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] } }),
  ]);

  const s = summary.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const p = prevSummary.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const deltaCalc = (c, prev) => prev === 0 ? null : Math.round(((c - prev) / prev) * 100);

  return {
    summary: {
      clicks: Math.round(s.clicks),
      impressions: Math.round(s.impressions),
      ctr: Math.round(s.ctr * 1000) / 10,
      position: Math.round(s.position * 10) / 10,
    },
    delta: {
      clicks: deltaCalc(s.clicks, p.clicks),
      impressions: deltaCalc(s.impressions, p.impressions),
      ctr: Math.round((s.ctr - p.ctr) * 1000) / 10,
      position: Math.round((p.position - s.position) * 10) / 10,
    },
    keywords: keywords.data.rows?.map(r => ({
      keyword: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    })) || [],
    pages: pages.data.rows?.map(r => ({
      page: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    })) || [],
  };
}
// Debug: top pages without filter + filtered views for /news/ and /aktien/news/
async function searchConsoleDebug() {
  const sc = getSearchConsoleClient();
  const now = new Date();
  const startDate = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const endDate = fmtDate(now);

  const queryPages = async (filters) => {
    try {
      const result = await sc.searchanalytics.query({
        siteUrl: GSC_SITE,
        requestBody: {
          startDate, endDate,
          dimensions: ['page'],
          rowLimit: 10,
          orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }],
          ...(filters ? { dimensionFilterGroups: filters } : {}),
        },
      });
      return (result.data.rows || []).map(r => ({
        page: r.keys[0],
        clicks: Math.round(r.clicks),
        impressions: Math.round(r.impressions),
      }));
    } catch (err) {
      return [{ error: err.message }];
    }
  };

  const [allPages, newsPages, aktienNewsPages] = await Promise.all([
    queryPages(null),
    queryPages([{ filters: [
      { dimension: 'page', operator: 'contains', expression: '/news/' },
      { dimension: 'page', operator: 'excludingRegex', expression: '^https://goldesel\\.de/aktien/news/' }
    ]}]),
    queryPages([{ filters: [
      { dimension: 'page', operator: 'contains', expression: '/aktien/news/' }
    ]}]),
  ]);

  return {
    info: 'Debug: zeigt Top-Seiten ungefiltert + gefiltert für /news/ und /aktien/news/',
    gscSite: GSC_SITE,
    dateRange: { startDate, endDate },
    allPages,
    newsPages_excludingAktien: newsPages,
    aktienNewsPages,
  };
}

// ─── AI Assist (generic prompt → Claude) ─────────────────────────────────────
async function aiAssist(prompt, mode) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set on server');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
      system: 'Du bist ein erfahrener Finanzredakteur bei goldesel.de, einem deutschen Finanz- und Trading-Portal. Antworte auf Deutsch. Sei präzise und professionell.',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.substring(0, 200)}`);
  }

  const json = await res.json();
  const text = json.content?.map(b => b.text).join('\n') || '';
  return { text, mode };
}

// ─── Image Generation (DALL-E 3) ────────────────────────────────────────────
async function generateImage(prompt, style = 'vivid', size = '1792x1024') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nicht gesetzt. Bitte in Vercel Environment Variables eintragen.');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size, // 1792x1024 (landscape, ideal for article headers)
      style, // 'vivid' or 'natural'
      response_format: 'b64_json',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Image API ${res.status}: ${errText.substring(0, 300)}`);
  }

  const json = await res.json();
  const imageData = json.data?.[0];
  return {
    b64: imageData.b64_json,
    revisedPrompt: imageData.revised_prompt,
  };
}

// Upload image to WordPress Media Library
async function uploadWPMedia(b64Data, filename, mimeType = 'image/png') {
  const base = process.env.WP_URL;
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  const buffer = Buffer.from(b64Data, 'base64');

  const res = await fetch(`${base}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
    body: buffer,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WP Media Upload ${res.status}: ${errText.substring(0, 200)}`);
  }

  const media = await res.json();
  return {
    id: media.id,
    url: media.source_url,
    link: media.link,
  };
}

// Generate image + optionally upload to WP
async function generateArticleImage(prompt, style = 'vivid', uploadToWP = false, filename = 'article-image.png') {
  const image = await generateImage(prompt, style);
  
  let wpMedia = null;
  if (uploadToWP) {
    wpMedia = await uploadWPMedia(image.b64, filename);
  }

  return {
    imageBase64: image.b64.substring(0, 100) + '...', // Don't send full b64 back, too large
    imageDataUrl: `data:image/png;base64,${image.b64}`,
    revisedPrompt: image.revisedPrompt,
    wpMedia,
  };
}

// ─── Create WP Post ──────────────────────────────────────────────────────────
async function createWPPost(title, content, status = 'draft', options = {}) {
  const base = process.env.WP_URL;
  const user = process.env.WP_USER;
  const pass = process.env.WP_APP_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  const postData = {
    title,
    content,
    status,
  };

  // Optional fields
  if (options.categories && options.categories.length) postData.categories = options.categories;
  if (options.tags && options.tags.length) postData.tags = options.tags;
  if (options.excerpt) postData.excerpt = options.excerpt;
  if (options.slug) postData.slug = options.slug;
  if (options.featured_media) postData.featured_media = options.featured_media;

  const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(postData),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WP create error ${res.status}: ${errText.substring(0, 200)}`);
  }

  const post = await res.json();
  return { id: post.id, link: post.link, status: post.status, editLink: `${base}/wp-admin/post.php?post=${post.id}&action=edit` };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── POST body handling ──
  let body = {};
  if (req.method === 'POST') {
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch { body = {}; }
  }

  try {
    let data;
    switch (action) {
      case 'batch': {
        const actions = (req.query.actions || '').split(',').filter(Boolean);
        if (!actions.length) throw new Error('actions parameter required (comma-separated)');
        data = await batch(actions, req.query.range || '30daysAgo');
        break;
      }
      case 'top5':         data = await top5(req.query.range || '30daysAgo');               break;
      case 'flop5':        data = await flop5(req.query.range || '30daysAgo');              break;
      case 'top5New':      data = await top5NewThisMonth();   break;
      case 'flop5New':     data = await flop5NewThisMonth();  break;
      case 'topstories':   data = await topstories();         break;
      case 'kpis':         data = await kpis(req.query.range || '30daysAgo');               break;
      case 'sources':      data = await sources(req.query.range || '30daysAgo');            break;
      case 'articles':           data = await articles();              break;
      case 'reviewCandidates':   data = await reviewCandidates();      break;
      case 'articleContent':     data = await articleContent(req.query.postId); break;
      case 'publishPost':        data = await publishPost(req.query.postId);   break;
      case 'aiReview':           data = await aiReview(req.query.postId);      break;
      case 'aiAssist':           data = await aiAssist(body.prompt, body.mode); break;
      case 'createPost':         data = await createWPPost(body.title, body.content, body.status || 'draft', {
        categories: body.categories,
        tags: body.tags,
        excerpt: body.excerpt,
        slug: body.slug,
        featured_media: body.featured_media,
      }); break;
      case 'generateImage':      data = await generateArticleImage(body.prompt, body.style || 'vivid', body.uploadToWP !== false, body.filename || 'article-image.png'); break;
      case 'topArticlesForDate': data = await topArticlesForDate(req.query.date); break;
      case 'searchconsole':          data = await searchConsoleNews();        break;
      case 'searchconsoleNews':       data = await searchConsoleNews();        break;
      case 'searchconsoleAktienNews': data = await searchConsoleAktienNews();  break;
      case 'searchconsoleDebug':      data = await searchConsoleDebug();       break;
      case 'monthlyStats': data = await monthlyStats();    break;
      case 'newArticles':  data = await newArticlesThisMonth(); break;
      case 'dailyPageviews': data = await dailyPageviews(req.query.range || '30daysAgo'); break;
      case 'topPagesByChannel': data = await topPagesByChannel(); break;
      case 'contentAnalysis': data = await contentAnalysis(); break;
      case 'contentAttribution': data = await contentAttribution(); break;
      default:
        return res.status(400).json({ success: false, error: `Unbekannte action: "${action}". Verfügbar: top5, flop5, top5New, flop5New, topstories, kpis, sources, articles, monthlyStats, newArticles, searchconsoleNews, searchconsoleAktienNews, searchconsoleDebug, reviewCandidates, articleContent, publishPost, aiReview, aiAssist (POST), createPost (POST)` });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
