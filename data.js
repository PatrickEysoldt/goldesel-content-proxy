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

// ─── Actions ──────────────────────────────────────────────────────────────────

// Top 5 Artikel nach Pageviews (letzte 30 Tage)
async function top5() {
  const client = getGA4Client();
  const [response] = await client.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 5,
  });

  return response.rows.map((row) => ({
    path: row.dimensionValues[0].value,
    title: row.dimensionValues[1].value,
    pageviews: parseInt(row.metricValues[0].value),
  }));
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
      case 'top5':     data = await top5();     break;
      case 'kpis':     data = await kpis();     break;
      case 'sources':  data = await sources();  break;
      case 'articles': data = await articles(); break;
      default:
        return res.status(400).json({ error: `Unbekannte action: "${action}". Verfügbar: top5, kpis, sources, articles` });
    }
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
