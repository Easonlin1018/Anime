"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workerPath = path.join(root, "sw.js");
const worker = fs.readFileSync(workerPath, "utf8");
const release = worker.match(/^const SHELL_RELEASE = "([a-z0-9-]+)";/m)[1];
const hashBlock = /^const SHELL_HASHES = (\{[\s\S]*?^\});/m;
const files = Object.keys(JSON.parse(worker.match(hashBlock)[1]));
const hashes = Object.fromEntries(files.map(file => {
    const text = fs.readFileSync(path.join(root, "releases", release, file), "utf8")
        .replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n");
    return [file, createHash("sha256").update(text).digest("hex")];
}));
const updated = worker.replace(hashBlock, `const SHELL_HASHES = ${JSON.stringify(hashes, null, 4)};`);
if (process.argv.includes("--check")) {
    if (updated !== worker) throw new Error("SW shell hashes do not match the immutable release files");
} else {
    fs.writeFileSync(workerPath, updated);
}
