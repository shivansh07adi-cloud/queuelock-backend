# Deploying the backend

Everything here uses free tiers, matching the SRS's zero-cost plan. This
assumes you already have a GitHub account (needed for both Render and
Vercel to deploy from).

## 1. Push this repo to GitHub

If you haven't already:
```
git init
git add .
git commit -m "FlashBook backend"
git remote add origin <your-github-repo-url>
git push -u origin main
```
`node_modules`, `.env`, and `.next` are already in `.gitignore` - don't
commit those.

## 2. Set up Redis (Upstash)

1. Go to [upstash.com](https://upstash.com), sign up free, create a new
   Redis database.
2. Pick a region close to where you'll deploy the backend (matters for
   latency).
3. Copy the connection string - it'll look like
   `rediss://default:xxxx@xxxx.upstash.io:6379` (note the double-s in
   `rediss://` - that's TLS, which Upstash requires and `ioredis` handles
   automatically, no code changes needed).

## 3. Set up Postgres (Supabase)

You likely already have this from local development. If you want a
separate production database:
1. Create a new project at [supabase.com](https://supabase.com).
2. Settings → Database → Connection string (URI mode, "Transaction" pooling
   mode is fine for this app's usage pattern).
3. Once you have the connection string, run the migration against it
   **before** your first deploy:
   ```
   DATABASE_URL="<your-production-url>" npm run migrate
   ```

## 4. Deploy to Render

**Option A - using the included `render.yaml` (recommended):**
1. Go to [render.com](https://render.com), sign up free.
2. New → Blueprint, connect your GitHub repo. Render will read
   `render.yaml` automatically and set up the service.
3. It'll prompt you for the values marked `sync: false` in the blueprint -
   paste in your Upstash `REDIS_URL`, Supabase `DATABASE_URL`, and leave
   `CORS_ORIGIN` for now (you'll set it after deploying the frontend, in
   step 6 below).
4. Deploy. Render will run `npm install` then `npm start`.

**Option B - manual setup**, if you'd rather not use the blueprint:
1. New → Web Service, connect your repo.
2. Build command: `npm install`. Start command: `npm start`.
3. Add the environment variables listed in `.env.example` manually in the
   dashboard's Environment tab.
4. Health check path: `/health`.

## 5. Verify it's live

```
curl https://<your-render-url>.onrender.com/health
```
Should return `{"status":"ok","phase":7}`.

Render's free tier spins the service down after inactivity - the first
request after a while will be slow (10-30s) while it wakes back up. That's
normal, not a bug; worth a line in your project README so it doesn't look
broken to someone clicking a demo link cold.

## 6. Lock down CORS

Once your frontend is deployed (see the frontend README) and you know its
URL, go back to the Render dashboard and set:
```
CORS_ORIGIN=https://your-frontend.vercel.app
```
This is the difference between "any website can make authenticated
requests to your API using a visitor's token" and "only your actual
frontend can." Redeploy after changing it (Render does this automatically
on env var changes).

## A note on the BullMQ workers

The confirmation/analytics/cleanup workers currently run in the same
process as the Express server (see `src/index.js` - `startAllWorkers()`
runs right alongside `app.listen()`). That's fine for this project's scale
and keeps the free-tier deployment to one service instead of two. A
larger-scale production system would typically run workers as a separate
Render "background worker" service so a slow job can't compete with the API
for the same process's CPU - worth knowing as a "here's what I'd do
differently at scale" talking point, but not necessary to actually build
for this project.
