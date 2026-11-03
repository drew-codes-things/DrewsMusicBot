const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GuildPlayer, DownloadManager, CancelledError, QueueItem, classify, commandsData,
  SPOTIFY_PLAYLIST, YOUTUBE_PLAYLIST, YOUTUBE_VIDEO, SEARCH, formatDuration,
} = require("../index.js");

const SONG = (n) => ({ title: `Song ${n}`, url: `u${n}` });
const titles = (items) => items.map((item) => item.track.title);

test("advance moves through the queue and keeps history", () => {
  const player = new GuildPlayer("g");
  [1, 2, 3].forEach((n) => player.enqueue(SONG(n)));
  assert.equal(player.advance().track.title, "Song 1");
  assert.equal(player.advance().track.title, "Song 2");
  assert.deepEqual(player.history.map((track) => track.title), ["Song 1"]);
  assert.deepEqual(titles(player.queue), ["Song 3"]);
});

test("going back replays the previous track and puts the current one next", () => {
  const player = new GuildPlayer("g");
  [1, 2].forEach((n) => player.enqueue(SONG(n)));
  player.advance();
  player.advance();
  assert.equal(player.goBack().track.title, "Song 1");
  assert.deepEqual(titles(player.queue), ["Song 2"]);
  assert.equal(new GuildPlayer("g").goBack(), null);
});

test("remove uses 1-based positions and rejects bad ones", () => {
  const player = new GuildPlayer("g");
  [1, 2, 3].forEach((n) => player.enqueue(SONG(n)));
  assert.equal(player.remove(2).track.title, "Song 2");
  assert.throws(() => player.remove(0), RangeError);
  assert.throws(() => player.remove(3), RangeError);
});

test("queries are classified by link type", () => {
  assert.equal(classify("https://open.spotify.com/playlist/abc"), SPOTIFY_PLAYLIST);
  assert.equal(classify("https://www.youtube.com/watch?v=x&list=PL1"), YOUTUBE_PLAYLIST);
  assert.equal(classify("https://youtu.be/x"), YOUTUBE_VIDEO);
  assert.equal(classify("  never gonna give you up "), SEARCH);
});

test("downloads per server never exceed the concurrency limit", async () => {
  let running = 0;
  let peak = 0;
  const manager = new DownloadManager(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    return "/tmp/file.opus";
  });
  const items = [1, 2, 3, 4, 5].map((n) => new QueueItem(SONG(n)));
  items.forEach((item) => manager.startDownload("g", item));
  await Promise.all(items.map((item) => item.downloadTask));
  assert.equal(peak, DownloadManager.MAX_CONCURRENT_DOWNLOADS);
  assert.ok(items.every((item) => item.filepath === "/tmp/file.opus"));
});

test("a cancelled download rejects and leaves no file", async () => {
  const manager = new DownloadManager(() => new Promise(() => {}));
  const item = new QueueItem(SONG(1));
  manager.startDownload("g", item);
  manager.cancel(item);
  await assert.rejects(item.downloadTask, CancelledError);
  assert.equal(item.filepath, null);
});

test("every slash command registers with a name and description", () => {
  const names = commandsData.map((command) => command.toJSON().name);
  assert.deepEqual([...new Set(names)].length, names.length);
  for (const name of ["assign", "play", "pause", "resume", "skip", "back", "queue", "remove", "clear"]) {
    assert.ok(names.includes(name), `missing /${name}`);
  }
  assert.ok(commandsData.every((command) => command.toJSON().description));
});

test("durations format as m:ss or h:mm:ss", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3725), "1:02:05");
});
