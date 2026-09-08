import express from "express";
import cron from "node-cron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getSetting, setSetting } from "./src/db.js";
import { listRepos, listLanguages, getRepoHistory, refresh, getStats } from "./src/tracker.js";
import { runScheduledRefresh, getScheduleState } from "./src/scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 读取项目根目录 .env（GITHUB_TOKEN / PORT / CRON_SCHEDULE）
try { process.loadEnvFile(join(__dirname, ".env")); } catch {}
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const PORT = Number(process.env.PORT) || 3001;
const TOKEN = process.env.GITHUB_TOKEN || "";
const DEFAULT_MIN_STARS = 1000;
const DEFAULT_MIN_GROWTH = 0;
const CRON = process.env.CRON_SCHEDULE || "0 9 * * *";

const cronValid = cron.validate(CRON);
let cronTask = null;

const toNum = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

app.get("/api/settings", (_req, res) => {
  res.json({
    minStars: Number(getSetting("minStars", DEFAULT_MIN_STARS)),
    minGrowth: Number(getSetting("minGrowth", DEFAULT_MIN_GROWTH)),
    tokenConfigured: Boolean(TOKEN),
  });
});

app.put("/api/settings", (req, res) => {
  try {
    const body = req.body || {};
    if (body.minStars !== undefined) setSetting("minStars", toNum(body.minStars, DEFAULT_MIN_STARS));
    if (body.minGrowth !== undefined) setSetting("minGrowth", toNum(body.minGrowth, DEFAULT_MIN_GROWTH));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/repos", (req, res) => {
  const minStars = toNum(req.query.minStars, toNum(getSetting("minStars", DEFAULT_MIN_STARS), DEFAULT_MIN_STARS));
  const minGrowth = toNum(req.query.minGrowth, toNum(getSetting("minGrowth", DEFAULT_MIN_GROWTH), DEFAULT_MIN_GROWTH));
  const language = req.query.language || "";
  const sort = req.query.sort || "growth";
  const window = req.query.window || "day";
  const repos = listRepos({ minStars, minGrowth, language, sort, window });
  res.json({ repos, count: repos.length, minStars, minGrowth, languages: listLanguages(), sort, window });
});

app.get("/api/repos/:id/history", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  const data = getRepoHistory(id);
  if (!data) return res.status(404).json({ error: "项目不存在" });
  res.json(data);
});

app.get("/api/stats", (_req, res) => {
  res.json({
    ...getStats(),
    tokenConfigured: Boolean(TOKEN),
    auto: {
      schedule: CRON,
      enabled: cronValid,
      nextRun: cronValid && cronTask ? cronTask.getNextRun()?.toISOString() ?? null : null,
      ...getScheduleState(),
    },
  });
});

app.post("/api/refresh", async (req, res) => {
  const minStars = toNum(req.body?.minStars, toNum(getSetting("minStars", DEFAULT_MIN_STARS), DEFAULT_MIN_STARS));
  try {
    const summary = await refresh({ minStars, token: TOKEN });
    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

if (cronValid) {
  cronTask = cron.schedule(CRON, () => {
    runScheduledRefresh({ token: TOKEN }).catch((e) => console.error("[auto refresh]", e));
  });
}

app.listen(PORT, () => {
  console.log(`GitHub Star Tracker running at http://localhost:${PORT}`);
  console.log(`GitHub token configured: ${Boolean(TOKEN)}`);
  if (cronValid) console.log(`Auto refresh schedule: ${CRON}` + (cronTask?.getNextRun() ? ` (next ${cronTask.getNextRun().toISOString()})` : ""));
  else console.warn(`Invalid CRON_SCHEDULE "${CRON}" detected; auto refresh disabled.`);
});
