# QualityServer

Print job API server for Quality Tire & Lube.

## What it does

The dashboard at `qualitytirelube.com` sends print jobs here.  
The print client at the shop polls for pending jobs, claims them, and prints.

```
Dashboard ──POST /api/print/jobs──▶ QualityServer ◀──GET /api/print/jobs/pending── Print Client
                                        (AWS)                                      (Shop Mac)
```

## API Routes

| Method | Path | Who calls it | Purpose |
|--------|------|-------------|---------|
| `GET` | `/health` | Anyone | Health check |
| `GET` | `/api/print/stats` | Dashboard | Queue stats |
| `POST` | `/api/print/jobs` | Dashboard | Create a print job |
| `GET` | `/api/print/jobs` | Dashboard | List all jobs |
| `GET` | `/api/print/jobs/pending` | Print Client | Poll for pending jobs |
| `POST` | `/api/print/jobs/:id/claim` | Print Client | Claim a job for printing |
| `POST` | `/api/print/jobs/:id/complete` | Print Client | Mark job completed |
| `POST` | `/api/print/jobs/:id/fail` | Print Client | Mark job failed (auto-retries 3x) |
| `GET` | `/api/print/printers` | Dashboard | List registered printers |
| `POST` | `/api/print/printers` | Print Client | Register printers |
| `PUT` | `/api/print/printers/status` | Print Client | Update printer statuses |
| `POST` | `/api/print/clients/register` | Print Client | Register a print client |

## Auth

All routes use API key auth via `X-API-Key` header.  
Set the key in `.env` as `API_KEY`. If not set, auth is disabled (dev mode).

## Run locally

```bash
npm install
npm run dev
```

## Deploy to AWS

### Option A: Elastic Beanstalk
```bash
eb init quality-server --platform node.js --region us-east-1
eb create quality-server-prod
eb setenv API_KEY=your-secret-key ALLOWED_ORIGINS=https://qualitytirelube.com
```

### Option B: EC2 + PM2
```bash
# On EC2 instance:
git clone <repo>
cd QualityServer
npm install --production
API_KEY=your-secret-key pm2 start src/index.js --name quality-server
```

### Option C: Docker (ECS/Fargate)
```bash
docker build -t quality-server .
docker run -p 3000:3000 -e API_KEY=your-secret-key quality-server
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `API_KEY` | Yes (prod) | — | Shared secret for X-API-Key header |
| `ALLOWED_ORIGINS` | No | `https://qualitytirelube.com,https://www.qualitytirelube.com` | Comma-separated CORS origins |
| `NODE_ENV` | No | `development` | `production` enables strict CORS + required API key |
