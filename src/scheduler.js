import { getSetting } from "./db.js";
import { refresh } from "./tracker.js";

let running = false;
const state = {
  lastAutoAt: null,
  lastAutoOk: null,
  lastAutoMessage: null,
};

export async function runScheduledRefresh({ token }) {
  if (running) return { skipped: true, reason: "上一轮仍在执行" };
  running = true;
  try {
    const minStars = Number(getSetting("minStars", 1000)) || 1000;
    const summary = await refresh({ minStars, token });
    state.lastAutoAt = new Date().toISOString();
    state.lastAutoOk = true;
    state.lastAutoMessage = `抓取完成：更新 ${summary.upserted} 个项目`;
    return summary;
  } catch (e) {
    state.lastAutoAt = new Date().toISOString();
    state.lastAutoOk = false;
    state.lastAutoMessage = String(e.message || e);
    throw e;
  } finally {
    running = false;
  }
}

export function getScheduleState() {
  return { ...state, running };
}
