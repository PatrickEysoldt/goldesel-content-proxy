# goldesel-content-proxy

Proxy-Server für den Goldesel Content Copilot. Verbindet Google Analytics 4 und WordPress.

## Setup

### 1. Repository auf GitHub erstellen
- Neues Repository mit dem Namen `goldesel-content-proxy` anlegen
- Alle Dateien aus diesem Ordner hochladen

### 2. Vercel Deployment
- vercel.com → mit GitHub einloggen
- "Add New Project" → dieses Repository auswählen → "Deploy"

### 3. Environment Variables in Vercel
Settings → Environment Variables:

| Name | Wert |
|------|------|
| `GA4_PROPERTY_ID` | `properties/275714306` |
| `GA4_SERVICE_ACCOUNT_JSON` | Gesamter Inhalt der JSON-Datei |
| `WP_URL` | `https://goldesel.de` |
| `WP_USER` | WordPress Benutzername |
| `WP_APP_PASS` | WordPress Application Password |

### 4. Redeploy
Deployments → neuester Eintrag → `...` → "Redeploy"

## API Endpoints

```
GET /api/data?action=top5      → Top 5 Artikel nach Pageviews (30 Tage)
GET /api/data?action=kpis      → Gesamt-KPIs (Pageviews, Sessions, User)
GET /api/data?action=sources   → Traffic-Quellen
GET /api/data?action=articles  → Neueste WordPress Artikel
```

## Test
Nach dem Deployment im Browser aufrufen:
`https://goldesel-content-proxy.vercel.app/api/data?action=top5`
