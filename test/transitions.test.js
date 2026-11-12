const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MusicController } = require("../index.js");

const SONG = (n) => ({ title: `Song ${n}`, videoId: `v${n}`, url: `https://www.youtube.com/watch?v=v${n}`, durationSeconds: 60 });
const GUILD = { id: "g1" };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicbot-"));
  const audioFile = path.join(dir, "track.opus");
  fs.writeFileSync(audioFile, "");
  const downloads = new Map();
  const music = new MusicController({
    assignmentsPath: path.join(dir, "assignments.json"),
    queuesPath: path.join(dir, "queues.json"),
    downloadTrack: (guildId, track) => {
      downloads.set(track.title, deferred());
      return downloads.get(track.title).promise;
    },
  });
  const player = music.playerFor(GUILD.id);
  const played = [];
  const stops = [];
  player.audioPlayer = {
    state: { status: "idle" },
    play: () => played.push(player.current.track.title),
    stop: (force) => { stops.push(force); return true; },
  };
  const queue = (n) => music.downloadManager.startDownload(GUILD.id, player.enqueue(SONG(n)));
  const interaction = { guildId: GUILD.id, guild: GUILD, reply: async () => {} };
  return { music, player, played, stops, downloads, audioFile, queue, interaction };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("skipping a track that is still downloading moves on and never plays it", async () => {
  const { music, player, played, downloads, audioFile, queue, interaction } = setup();
  queue(1);
  queue(2);
  const firstPlayback = music.playItem(GUILD, player, player.advance());
  await settle();
  await Promise.all([music.skip(interaction), settle().then(() => downloads.get("Song 2").resolve(audioFile))]);
  downloads.get("Song 1").resolve(audioFile);
  await firstPlayback;
  await settle();
  assert.equal(player.current.track.title, "Song 2");
  assert.deepEqual(played, ["Song 2"]);
});

test("skip and back stop a paused track straight away", async () => {
  for (const command of ["skip", "back"]) {
    const { music, player, stops, queue, interaction } = setup();
    queue(1);
    player.advance();
    player.history.push(SONG(0));
    player.audioPlayer.state.status = "paused";
    await music[command](interaction);
    assert.deepEqual(stops, [true], `/${command} while paused`);
  }
});
