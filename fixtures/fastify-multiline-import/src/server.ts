import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerHealth,
  registerMetrics,
  type SpendBudget,
} from "./service-kit";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerHealth(app);
  registerMetrics(app);

  app.get("/policies/templates", async () => {
    return { templates: [] };
  });

  app.post("/policies/generate", async (request, reply) => {
    return reply.send({ id: randomUUID() });
  });

  return app;
}
