const test = require("node:test");
const assert = require("node:assert/strict");
const { mapWithConcurrency } = require("../index.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mapWithConcurrency keeps input order and respects the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [30, 5, 20, 1, 15, 10];
  const out = await mapWithConcurrency(items, 3, async (ms, index) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(ms);
    inFlight -= 1;
    return `${index}:${ms}`;
  });
  assert.deepEqual(out, items.map((ms, i) => `${i}:${ms}`));
  assert.equal(peak, 3);
});

test("mapWithConcurrency handles empty input and a limit larger than the input", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 10, async (x) => x * 2), [2, 4]);
});
