const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { logger } = require("../index.js");

test("the logger has every level the code calls", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const levels = new Set([...source.matchAll(/\blogger\.(\w+)\(/g)].map((match) => match[1]));
  for (const level of levels) {
    assert.equal(typeof logger[level], "function", `logger.${level} is called but not defined`);
  }
});
