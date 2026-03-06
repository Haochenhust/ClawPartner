import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { Hono } from "hono";
import { createLogger } from "../shared/logger.js";
import type { CentralController } from "../kernel/central-controller.js";
import { startFeishuLongConnection } from "./feishu-ws.js";
import { TRACE_VIEWER_HTML } from "./trace-viewer.html.js";
import type { AppConfig } from "../shared/types.js";

const log = createLogger("gateway");
const LOGS_DIR = join(process.cwd(), "logs");

export function createGateway(
  controller: CentralController,
  feishuConfig: AppConfig["feishu"],
) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));
  app.get("/favicon.ico", (c) => c.body(null, 204));

  /** Trace 可视化页面 */
  app.get("/trace", (c) =>
    c.html(TRACE_VIEWER_HTML),
  );

  /** 列出所有运行批次（logs 下按 年月日时分秒 命名的目录） */
  app.get("/api/trace/runs", (c) => {
    if (!existsSync(LOGS_DIR)) {
      return c.json([]);
    }
    const names = readdirSync(LOGS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^\d{8}-\d{6}$/.test(n))
      .sort()
      .reverse();
    return c.json(names.map((name) => ({
      name,
      hasTrace: existsSync(join(LOGS_DIR, name, "trace.jsonl")),
    })));
  });

  /** 获取指定批次的 trace 记录（trace.jsonl 每行一条 JSON） */
  app.get("/api/trace", async (c) => {
    let run = c.req.query("run");
    if (!run) {
      if (!existsSync(LOGS_DIR)) return c.json([]);
      const names = readdirSync(LOGS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((n) => /^\d{8}-\d{6}$/.test(n))
        .sort()
        .reverse();
      run = names[0];
    }
    if (!run) return c.json([]);
    const tracePath = join(LOGS_DIR, run, "trace.jsonl");
    if (!existsSync(tracePath)) return c.json([]);
    const raw = readFileSync(tracePath, "utf8");
    const spans = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return c.json(spans);
  });

  /** 获取指定批次的 Agent 详情（agent-details.jsonl）：order 为 messageId 首次出现顺序，details 按 messageId 索引，便于调试展示 */
  app.get("/api/trace/details", async (c) => {
    const run = c.req.query("run");
    if (!run) return c.json({ order: [], details: {} });
    const detailsPath = join(LOGS_DIR, run, "agent-details.jsonl");
    if (!existsSync(detailsPath)) return c.json({ order: [], details: {} });
    const raw = readFileSync(detailsPath, "utf8");
    const order: string[] = [];
    const byMessageId: Record<string, unknown> = {};
    for (const line of raw.split("\n").filter((l) => l.trim())) {
      try {
        const row = JSON.parse(line) as { messageId?: string };
        if (row.messageId) {
          if (!byMessageId[row.messageId]) order.push(row.messageId);
          byMessageId[row.messageId] = row;
        }
      } catch {
        // skip malformed lines
      }
    }
    return c.json({ order, details: byMessageId });
  });

  startFeishuLongConnection(feishuConfig, controller);

  log.info("Gateway routes registered (Feishu long connection, GET /trace)");
  return app;
}
