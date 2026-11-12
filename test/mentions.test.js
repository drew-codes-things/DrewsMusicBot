const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDiscordClient } = require("../index.js");

test("messages the bot sends can never ping anyone", async () => {
  const client = buildDiscordClient();
  try {
    assert.deepEqual(client.options.allowedMentions, { parse: [] });
  } finally {
    await client.destroy();
  }
});
