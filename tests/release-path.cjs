"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const release = worker.match(/^const SHELL_RELEASE = "([a-z0-9-]+)";/m)[1];
module.exports = file => path.join(root, "releases", release, file);
