const { BetaAnalyticsDataClient } = require('@google-analytics/data');

// ─── GA4 Client ───────────────────────────────────────────────────────────────
function getGA4Client() {
  const keyJson = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(keyJson);
  return new BetaAnalyticsDataClient({ credentials });
}

const propertyId = process.env.GA4_PROPERTY_ID; // z.B. "properties/275714306"

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

// ─── Hilfsfunktion: WP Artikel + GA4 Views matchen ───────────────────────────
async function getArticlesWithViews({ startDate, endDate, limit = 100 }) {
  const client = getGA4Client();

  // WordPress: alle Artikel im Zeitraum holen (nach Publish-Datum)
  // GA4-Strings wie "30daysAgo" in echte Daten umrechnen
  const resolveDate = (d) => {
    if (d === 'today') return new Date();
    const match = d.match(/^(\d+)daysAgo$/);
    if (match) {
      const date = new Date();
      date.setDate(date.getDate() - parseInt(match[1]));
      return date;
    }
    return new Date(d);
  };
  const after = resolveDate(startDate).toISOString();
  const posts = await wpFetch(`posts?per_page=${limit}&status=publish&after=${after}&orderby=date&order=desc&_fields=id,title,link,date,slug`);

  if (!posts.length) return [];

  // GA4: Pageviews im Zeitraum für alle Seiten
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }],
    limit: 5000,
  });

  // Map: slug → pageviews
  const viewMap = {};
  response.rows?.forEach(row => {
    const path = row.dimensionValues[0].value;
    viewMap[path] = parseInt(row.metricValues[0].value);
  });

  // Artikel mit Views anreichern (WordPress Titel als Source of Truth)
  return posts.map(p => {
    const url = new URL(p.link);
    const path = url.pathname;
    // GA4 tracked Artikel unter /artikel/[slug]/ auf goldesel.de
    const ga4Path = `/artikel/${p.slug}/`;
    const pageviews = viewMap[ga4Path] || viewMap[`/artikel/${p.slug}`] || viewMap[path] || 0;
    return {
      title: p.title.rendered,
      path: ga4Path,
      url: p.link,
      slug: p.slug,
      date: p.date,
      pageviews,
    };
  });
}

// Top 5 Artikel nach Pageviews (letzte 30 Tage, nur echte WP Artikel)
async function top5() {
  const articles = await getArticlesWithViews({ startDate: '30daysAgo', endDate: 'today', limit: 100 });
  return articles
    .sort((a, b) => b.pageviews - a.pageviews)
    .slice(0, 5);
}

// Flop 5 Artikel (wenigste Pageviews, letzte 30 Tage, nur echte WP Artikel)
async function flop5() {
  const articles = await getArticlesWithViews({ startDate: '30daysAgo', endDate: 'today', limit: 100 });
  return articles
    .filter(a => a.pageviews > 0)
    .sort((a, b) => a.pageviews - b.pageviews)
    .slice(0, 5);
}
// Gesamt-KPIs (letzte 30 Tage)
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

// Traffic-Quellen (letzte 30 Tage)
async function sources() {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });

  return response.rows.map((row) => ({
    channel: row.dimensionValues[0].value,
    sessions: parseInt(row.metricValues[0].value),
  }));
}

// Neueste WordPress Artikel
async function articles() {
  const posts = await wpFetch('posts?per_page=10&status=publish&_fields=id,title,link,date,slug');
  return posts.map((p) => ({
    id: p.id,
    title: p.title.rendered,
    url: p.link,
    date: p.date,
    slug: p.slug,
  }));
}



// Vollständige Monatsstatistik inkl. Vormonatsvergleich
async function monthlyStats() {
  const client = getGA4Client();

  // Aktuellen Monat und Vormonat berechnen
  const now = new Date();
  const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayLastMonth = new Date(firstDayThisMonth - 1);
  const firstDayLastMonth = new Date(lastDayLastMonth.getFullYear(), lastDayLastMonth.getMonth(), 1);

  const fmt = (d) => d.toISOString().split('T')[0];

  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [
      { startDate: fmt(firstDayThisMonth), endDate: fmt(now), name: 'thisMonth' },
      { startDate: fmt(firstDayLastMonth), endDate: fmt(lastDayLastMonth), name: 'lastMonth' },
    ],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'newUsers' },
      { name: 'totalUsers' },
    ],
  });

  const extract = (dateRangeName) => {
    const row = response.rows?.find(r => r.dimensionValues?.[0]?.value === dateRangeName);
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

  const delta = (curr, prev) => {
    if (prev === 0) return null;
    return Math.round(((curr - prev) / prev) * 100);
  };

  return {
    thisMonth,
    lastMonth,
    delta: {
      pageviews: delta(thisMonth.pageviews, lastMonth.pageviews),
      sessions: delta(thisMonth.sessions, lastMonth.sessions),
      newUsers: delta(thisMonth.newUsers, lastMonth.newUsers),
    }
  };
}

// Neue Artikel diesen Monat (via WordPress) + ihre GA4 Pageviews
async function newArticlesThisMonth() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // WordPress: Artikel die diesen Monat erschienen sind
  const posts = await wpFetch(`posts?per_page=50&status=publish&after=${firstDay}&_fields=id,title,link,date,slug`);
  const articleCount = posts.length;

  if (articleCount === 0) return { count: 0, pageviews: 0, avgPageviews: 0, articles: [] };

  // GA4: Pageviews für diese Artikel
  const client = getGA4Client();
  const fmt = (d) => new Date(d).toISOString().split('T')[0];
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: fmt(firstDay), endDate: fmt(now) }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 100,
  });

  // Match GA4 paths to WordPress slugs
  const slugs = posts.map(p => p.slug);
  const matchedRows = response.rows?.filter(row => {
    const path = row.dimensionValues[0].value;
    return slugs.some(slug => path.includes(slug));
  }) || [];

  const totalPageviews = matchedRows.reduce((sum, row) => sum + parseInt(row.metricValues[0].value), 0);

  return {
    count: articleCount,
    pageviews: totalPageviews,
    avgPageviews: articleCount > 0 ? Math.round(totalPageviews / articleCount) : 0,
    articles: posts.map(p => ({ title: p.title.rendered, url: p.link, date: p.date })),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    let data;
    switch (action) {
      case 'top5':              data = await top5();                break;
      case 'flop5':             data = await flop5();               break;
      case 'kpis':              data = await kpis();                break;
      case 'sources':           data = await sources();             break;
      case 'articles':          data = await articles();            break;
      case 'monthlyStats':      data = await monthlyStats();        break;
      case 'newArticles':       data = await newArticlesThisMonth(); break;
      default:
        return res.status(400).json({ error: `Unbekannte action: "${action}". Verfügbar: top5, flop5, kpis, sources, articles, monthlyStats, newArticles` });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
