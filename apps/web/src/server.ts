import index from "../index.html";

const server = Bun.serve({
  port: Number(process.env.WEB_PORT ?? 3000),
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`OPD web app listening on http://localhost:${server.port}`);
