import type { FastifyInstance } from "fastify";

export interface SpendBudget {
  limit: number;
}

export function registerHealth(app: FastifyInstance): void {
  app.get("/health", async () => ({ ok: true }));
}

export function registerMetrics(app: FastifyInstance): void {
  app.get("/metrics", async () => ({ metrics: {} }));
}
