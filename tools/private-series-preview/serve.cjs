"use strict";

const { execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const { resolve } = require("node:path");

const repo = resolve(__dirname, "../..");
const [revision, portArg] = process.argv.slice(2);
const port = Number(portArg || 43219);
if (!/^[a-f0-9]{40}$/u.test(revision || "") || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Usage: node tools/private-series-preview/serve.cjs <full-commit-sha> [port]");
}
const app = "releases/legacy-series-2/";
const tool = "tools/private-series-preview/";
const file = path => execFileSync("git", ["show", revision + ":" + path], { cwd:repo, maxBuffer:16 * 1024 * 1024 });
const scripts = "text/javascript; charset=utf-8";
const routes = new Map([
    ["/", [file(tool + "index.html"), "text/html; charset=utf-8"]],
    ["/preview.css", [file(tool + "preview.css"), "text/css; charset=utf-8"]],
    ["/preview.js", [file(tool + "preview.js"), scripts]],
    ["/model.js", [file(tool + "model.js"), scripts]],
    ["/v11-core.js", [file(app + "v11-core.js"), scripts]],
    ["/vendor/opencc.js", [file(app + "vendor/opencc-js-1.4.1-full.js"), scripts]],
    ["/icon.svg", [file("icons/app-icon.svg"), "image/svg+xml"]],
    ["/manifest.webmanifest", [Buffer.from(JSON.stringify({
        name:"Anime Tracker 私人驗收", short_name:"追番驗收", start_url:"/", scope:"/", display:"standalone",
        theme_color:"#111827", background_color:"#111827", icons:[{ src:"/icon.svg", sizes:"any", type:"image/svg+xml" }]
    })), "application/manifest+json"]],
    ["/sw.js", [Buffer.from(file(tool + "sw.js").toString().replaceAll("__REVISION__", revision)), scripts]]
]);
routes.set("/index.html", routes.get("/"));
routes.set("/favicon.ico", routes.get("/icon.svg"));

const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
    + "manifest-src 'self'; worker-src 'self'; connect-src 'none'; form-action 'none'; "
    + "object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const common = {
    "X-Anime-Preview-Commit":revision, "X-Robots-Tag":"noindex, nofollow, noarchive",
    "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff", "Cache-Control":"no-store"
};
createServer((request, response) => {
    // This origin has no API, file uploads, or dynamic URL handling.
    if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { ...common, Allow:"GET, HEAD" });
        return response.end();
    }
    const route = routes.get(request.url);
    if (!route) { response.writeHead(404, common); return response.end(); }
    const [body, type] = route;
    const csp = request.url === "/sw.js" ? "default-src 'none'; connect-src 'self'; script-src 'self'" : policy;
    const disposition = type.startsWith("text/html;") ? { "Content-Disposition":"inline" } : {};
    response.writeHead(200, { ...common, ...disposition, "Content-Type":type,
        "Content-Security-Policy":csp, "Content-Length":body.length });
    return response.end(request.method === "HEAD" ? undefined : body);
}).listen(port, "127.0.0.1", () => console.log(`Private preview ${revision} ready on http://127.0.0.1:${port}/`));
