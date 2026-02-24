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
    const ga4Path = `/artikel/${p.slug}/`;
    const data = viewMap[ga4Path] || viewMap[`/artikel/${p.slug}`] || { total: 0, channels: {} };
    return {
      title: p.title.rendered,
      path: ga4Path,
      url: p.link,
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
  return articles.filter(a => a.pageviews > 0).sort((a, b) => a.pageviews - b.pageviews).slice(0, 5);
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
  return articles.filter(a => a.pageviews > 0).sort((a, b) => a.pageviews - b.pageviews).slice(0, 5);
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

// Search Console: Klicks, Impressionen, CTR, Position + Top Keywords + Top Seiten
async function searchConsoleData() {
  const sc = getSearchConsoleClient();
  const now = new Date();
  const endDate = fmtDate(now);
  const startDate = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayLastMonth = new Date(firstDayThisMonth - 1);
  const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1);
  const prevStart = fmtDate(firstDayLastMonth);
  const prevEnd = fmtDate(lastDayLastMonth);

  // Zwei Pfade: /news/ und /aktien/news/ – separate Queries dann zusammenführen

  const makeFilter = (path) => ({
    filters: [{ dimension: 'page', operator: 'contains', expression: path }],
  });

  // Zwei separate Queries für /news/ und /aktien/news/, dann zusammenführen
  const [summaryNews, summaryAktien, prevNews, prevAktien, keywordsRes, pagesRes] = await Promise.all([
    sc.searchanalytics.query({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: [], dimensionFilterGroups: [makeFilter('/news/')] } }),
    sc.searchanalytics.query({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: [], dimensionFilterGroups: [makeFilter('/aktien/news/')] } }),
    sc.searchanalytics.query({ siteUrl: GSC_SITE, requestBody: { startDate: prevStart, endDate: prevEnd, dimensions: [], dimensionFilterGroups: [makeFilter('/news/')] } }),
    sc.searchanalytics.query({ siteUrl: GSC_SITE, requestBody: { startDate: prevStart, endDate: prevEnd, dimensions: [], dimensionFilterGroups: [makeFilter('/aktien/news/')] } }),
    sc.searchanalytics.query({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: ['query'], dimensionFilterGroups: [makeFilter('/news/')], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] } }),
    sc.searchanalytics.query({ siteUrl: GSC_SITE, requestBody: { startDate, endDate, dimensions: ['page'], dimensionFilterGroups: [makeFilter('/news/')], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] } }),
  ]);

  // Zusammenführen der Summary-Daten
  const merge = (a, b) => {
    const ra = a.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const rb = b.data.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const clicks = ra.clicks + rb.clicks;
    const impressions = ra.impressions + rb.impressions;
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: (ra.position + rb.position) / 2,
    };
  };

  const s = merge(summaryNews, summaryAktien);
  const p = merge(prevNews, prevAktien);
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
    keywords: keywordsRes.data.rows?.map(r => ({
      keyword: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    })) || [],
    pages: pagesRes.data.rows?.map(r => ({
      page: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    })) || [],
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
      case 'searchconsole': data = await searchConsoleData();    break;
      case 'newArticles':  data = await newArticlesThisMonth(); break;
      default:
        return res.status(400).json({ error: `Unbekannte action. Verfügbar: top5, flop5, top5New, flop5New, topstories, kpis, sources, articles, monthlyStats, newArticles` });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
