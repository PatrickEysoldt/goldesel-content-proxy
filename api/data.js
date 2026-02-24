const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { google } = require('googleapis');

// ─── GA4 Client ───────────────────────────────────────────────────────────────
function getGA4Client() {
  const keyJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(keyJson);
  return new BetaAnalyticsDataClient({ credentials });
}

// ─── Search Console Client ────────────────────────────────────────────────────
function getSearchConsoleClient() {
  const keyJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return google.searchconsole({ version: 'v1', auth });
}

const GSC_SITE = 'https://goldesel.de/';
const propertyId = process.env.GA4_PROPERTY_ID;
const TOPSTORY_CATEGORY_ID = 234;

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

async function top5() {
  const articles = await getArticlesWithChannels({ startDate: '30daysAgo', endDate: 'today', limit: 100 });
  return articles.sort((a, b) => b.pageviews - a.pageviews).slice(0, 5);
}

async function flop5() {
  const articles = await getArticlesWithChannels({ startDate: '30daysAgo', endDate: 'today', limit: 100 });
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

async function kpis() {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'newUsers' },
      { name: 'totalUsers' },
    ],
  });
  const m = response.rows[0].metricValues;
  return {
    pageviews: parseInt(m[0].value),
    sessions: parseInt(m[1].value),
    newUsers: parseInt(m[2].value),
    totalUsers: parseInt(m[3].value),
  };
}

async function sources() {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
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

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    let data;
    switch (action) {
      case 'top5':         data = await top5();               break;
      case 'flop5':        data = await flop5();              break;
      case 'top5New':      data = await top5NewThisMonth();   break;
      case 'flop5New':     data = await flop5NewThisMonth();  break;
      case 'topstories':   data = await topstories();         break;
      case 'kpis':         data = await kpis();               break;
      case 'sources':      data = await sources();            break;
      case 'articles':     data = await articles();           break;
      case 'searchconsole':          data = await searchConsoleNews();        break;
      case 'searchconsoleNews':       data = await searchConsoleNews();        break;
      case 'searchconsoleAktienNews': data = await searchConsoleAktienNews();  break;
      case 'searchconsoleDebug':      data = await searchConsoleDebug();       break;
      case 'monthlyStats': data = await monthlyStats();    break;
      case 'newArticles':  data = await newArticlesThisMonth(); break;
      default:
        return res.status(400).json({ success: false, error: `Unbekannte action: "${action}". Verfügbar: top5, flop5, top5New, flop5New, topstories, kpis, sources, articles, monthlyStats, searchconsoleNews, searchconsoleAktienNews, newArticles` });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
