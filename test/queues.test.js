const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MusicController, loadQueues } = require("../index.js");

const SONG = (n) => ({ title: `Song ${n}`, videoId: `v${n}`, url: `https://www.youtube.com/watch?v=v${n}`, durationSeconds: 60 });

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicbot-"));
  return { assignmentsPath: path.join(dir, "assignments.json"), queuesPath: path.join(dir, "queues.json") };
}

function controller(paths) {
  const music = new MusicController({ ...paths, downloadTrack: async () => null });
  music.downloadManager.startDownload = () => {};
  return music;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the queue and the current track are saved as they change", async () => {
  const paths = tempPaths();
  const music = controller(paths);
  const player = music.playerFor("g1");
  player.enqueue(SONG(1));
  player.enqueue(SONG(2));
  player.enqueue(SONG(3));
  player.advance();
  await flush();
  assert.deepEqual(loadQueues(paths.queuesPath).g1.map((t) => t.title), ["Song 1", "Song 2", "Song 3"]);
  player.remove(1);
  await flush();
  assert.deepEqual(loadQueues(paths.queuesPath).g1.map((t) => t.title), ["Song 1", "Song 3"]);
  player.clear();
  player.advance();
  await flush();
  assert.deepEqual(loadQueues(paths.queuesPath), {});
});

test("saved queues come back after a restart for assigned guilds only", async () => {
  const paths = tempPaths();
  fs.writeFileSync(paths.assignmentsPath, JSON.stringify({ g1: "c1" }));
  fs.writeFileSync(paths.queuesPath, JSON.stringify({ g1: [SONG(1), SONG(2)], g2: [SONG(9)], g3: [{ bogus: true }] }));
  const music = controller(paths);
  const started = [];
  music.startPlayback = async (guild, player) => { started.push(guild.id); };
  const guilds = new Map([["g1", { id: "g1" }], ["g2", { id: "g2" }]]);
  const restored = await music.restoreQueues({ guilds: { cache: guilds } });
  assert.equal(restored, 2);
  assert.deepEqual(started, ["g1"]);
  assert.deepEqual(music.playerFor("g1").queue.map((item) => item.track.title), ["Song 1", "Song 2"]);
  assert.equal(music.players.has("g2"), false);
});

test("a corrupt queue file is reported and ignored", async () => {
  const paths = tempPaths();
  fs.writeFileSync(paths.queuesPath, "{not json");
  const music = controller(paths);
  assert.equal(await music.restoreQueues({ guilds: { cache: new Map() } }), 0);
});
