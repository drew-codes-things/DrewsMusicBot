const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classify, getVideoInfo, MusicController, YOUTUBE_VIDEO, YOUTUBE_PLAYLIST, UNSUPPORTED_YOUTUBE_LINK } = require("../index.js");

test("only links to one video count as a video", () => {
  for (const link of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  ]) {
    assert.equal(classify(link), YOUTUBE_VIDEO, link);
  }
});

test("channel, search and bare YouTube links are not treated as a video", () => {
  for (const link of [
    "https://www.youtube.com/@SomeChannel",
    "https://www.youtube.com/results?search_query=x",
    "youtube.com",
    "https://www.youtube.com/channel/UC123",
    "https://youtu.be/",
    "https://www.youtube.com/watch",
  ]) {
    assert.equal(classify(link), UNSUPPORTED_YOUTUBE_LINK, link);
  }
});

test("playlists are still playlists", () => {
  assert.equal(classify("https://www.youtube.com/playlist?list=PL1"), YOUTUBE_PLAYLIST);
  assert.equal(classify("https://www.youtube.com/watch?v=x&list=PL1"), YOUTUBE_PLAYLIST);
});

test("video lookups never expand a playlist", async () => {
  let seenFlags;
  await getVideoInfo("https://www.youtube.com/watch?v=x", async (url, flags) => {
    seenFlags = flags;
    return { id: "x", title: "X", duration: 10 };
  });
  assert.equal(seenFlags.noPlaylist, true);
});

test("an unsupported YouTube link gets an explanation instead of a lookup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicbot-links-"));
  fs.writeFileSync(path.join(dir, "assignments.json"), JSON.stringify({ g1: "c1" }));
  const music = new MusicController({
    assignmentsPath: path.join(dir, "assignments.json"),
    queuesPath: path.join(dir, "queues.json"),
    downloadTrack: async () => null,
  });
  const said = [];
  music.handleSingleVideo = async () => said.push("looked up");
  music.handleSearch = async () => said.push("searched");
  const interaction = {
    guildId: "g1",
    options: { getString: () => "https://www.youtube.com/@SomeChannel" },
    reply: async (payload) => said.push(payload.content),
  };
  await music.play(interaction);
  assert.equal(said.length, 1);
  assert.match(said[0], /video or playlist link/);
});
