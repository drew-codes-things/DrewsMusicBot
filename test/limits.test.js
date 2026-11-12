const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { download, MusicController, MAX_TRACK_SECONDS } = require("../index.js");

const SONG = (n, durationSeconds = 60) => ({ title: `Song ${n}`, videoId: `v${n}`, url: `https://www.youtube.com/watch?v=v${n}`, durationSeconds });

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "musicbot-limits-"));
}

function fakeYtdlp({ writeFile }) {
  const calls = [];
  const fn = async (url, flags, execOptions) => {
    calls.push({ url, flags, execOptions });
    if (writeFile) {
      fs.writeFileSync(flags.output.replace("%(ext)s", "opus"), "audio");
    }
    return "";
  };
  return { fn, calls };
}

test("downloads skip live streams and long videos and are capped in size and time", async () => {
  const { fn, calls } = fakeYtdlp({ writeFile: true });
  await download(SONG(1), tempDir(), fn);
  const { flags, execOptions } = calls[0];
  assert.equal(MAX_TRACK_SECONDS, 3600);
  assert.equal(flags.matchFilter, "!is_live & duration <=? 3600");
  assert.match(String(flags.maxFilesize), /^\d+M$/);
  assert.ok(execOptions.timeout > 0);
});

test("a download that yt-dlp filtered out fails with a clear reason", async () => {
  const { fn } = fakeYtdlp({ writeFile: false });
  await assert.rejects(download(SONG(1), tempDir(), fn), /live stream, longer than 60 minutes or larger than/);
});

test("a download that produced its file resolves to that file", async () => {
  const { fn } = fakeYtdlp({ writeFile: true });
  const filepath = await download(SONG(1), tempDir(), fn);
  assert.ok(fs.existsSync(filepath));
  assert.ok(filepath.endsWith(".opus"));
});

function controllerWithReplies() {
  const dir = tempDir();
  const music = new MusicController({
    assignmentsPath: path.join(dir, "assignments.json"),
    queuesPath: path.join(dir, "queues.json"),
    downloadTrack: async () => null,
  });
  const started = [];
  music.downloadManager.startDownload = (guildId, item) => started.push(item.track.title);
  music.startPlayback = async () => {};
  music.announceQueue = async () => {};
  const replies = [];
  const interaction = {
    guildId: "g1",
    guild: { id: "g1" },
    replied: false,
    deferred: true,
    reply: async (payload) => replies.push(payload.content),
    followUp: async (payload) => replies.push(payload.content),
  };
  return { music, started, replies, interaction };
}

test("a single track over the limit is refused before anything is downloaded", async () => {
  const { music, started, replies, interaction } = controllerWithReplies();
  await music.queueTrack(interaction, SONG(1, MAX_TRACK_SECONDS + 1));
  assert.deepEqual(started, []);
  assert.equal(music.playerFor("g1").queue.length, 0);
  assert.match(replies[0], /longer than 60 minutes/);
});

test("playlists leave out tracks over the limit and say how many", async () => {
  const { music, started, replies, interaction } = controllerWithReplies();
  await music.queueMany(interaction, [SONG(1), SONG(2, MAX_TRACK_SECONDS * 3), SONG(3, null)], 0);
  assert.deepEqual(started, ["Song 1", "Song 3"]);
  assert.match(replies[0], /Queued 2 tracks/);
  assert.match(replies[0], /1 longer than 60 minutes left out/);
});

test("a failed download is logged with its reason, a cancelled one is not", async () => {
  const { DownloadManager, QueueItem, logger } = require("../index.js");
  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (...args) => warnings.push(args.join(" "));
  try {
    const failing = new DownloadManager(async () => { throw new Error("too long"); });
    const failed = new QueueItem(SONG(1));
    failing.startDownload("g", failed);
    await assert.rejects(failed.downloadTask);
    const hanging = new DownloadManager(() => new Promise(() => {}));
    const cancelled = new QueueItem(SONG(2));
    hanging.startDownload("g", cancelled);
    hanging.cancel(cancelled);
    await assert.rejects(cancelled.downloadTask);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    logger.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Song 1.*too long/);
});
