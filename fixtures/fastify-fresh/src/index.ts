import Fastify from "fastify";

const fastify = Fastify();

fastify.get("/status", async () => {
  return { status: "ok" };
});

fastify.route({
  method: "GET",
  url: "/weather",
  handler: async () => {
    return { forecast: "sunny", tempF: 72 };
  },
});

fastify.listen({ port: 3001 });
