const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const TEST_REDIRECT_PORT = 18931;
process.env.SPOTIFY_REDIRECT_PORT = String(TEST_REDIRECT_PORT);

const { MusicController, getSpotifyClient, loginSpotifyInteractively, SpotifyUnavailableError } = require("../index.js");

const PLAYLIST = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";

function controller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicbot-spotify-"));
  return new MusicController({
    assignmentsPath: path.join(dir, "assignments.json"),
    queuesPath: path.join(dir, "queues.json"),
    downloadTrack: async () => null,
  });
}

function recordingInteraction() {
  const said = [];
  const interaction = {
    guildId: "g1",
    replied: false,
    deferred: false,
    reply: async (payload) => { interaction.replied = true; said.push(payload.content); },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => said.push(payload.content),
    followUp: async (payload) => said.push(payload.content),
  };
  return { interaction, said };
}

function withoutSpotifyKeys(fn) {
  const saved = { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SPOTIFY_CLIENT_SECRET };
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  return Promise.resolve(fn()).finally(() => {
    if (saved.id !== undefined) process.env.SPOTIFY_CLIENT_ID = saved.id;
    if (saved.secret !== undefined) process.env.SPOTIFY_CLIENT_SECRET = saved.secret;
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

test("a Spotify link without Spotify keys answers at once and opens no login port", async () => {
  await withoutSpotifyKeys(async () => {
    const { interaction, said } = recordingInteraction();
    await controller().handleSpotifyPlaylist(interaction, PLAYLIST);
    assert.equal(said.length, 1);
    assert.match(said[0], /Spotify playlist import isn't set up/);
    assert.ok(await portIsFree(TEST_REDIRECT_PORT));
  });
});

test("a Spotify client still waiting for its owner's login gives up with a clear error", async () => {
  const neverReady = () => new Promise(() => {});
  await assert.rejects(
    getSpotifyClient({ waitMs: 20, ensureClient: neverReady }),
    (error) => error instanceof SpotifyUnavailableError && /log in/i.test(error.message)
  );
});

test("the user sees the waiting-for-login message instead of a hang", async () => {
  const music = controller();
  const { interaction, said } = recordingInteraction();
  process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "id";
  process.env.SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "secret";
  music.loadSpotifyTracks = () => Promise.reject(new SpotifyUnavailableError("Spotify is waiting for the bot owner to log in."));
  await music.handleSpotifyPlaylist(interaction, PLAYLIST);
  assert.deepEqual(said, ["Spotify is waiting for the bot owner to log in."]);
});

test("the interactive login stops waiting and frees its port after the timeout", async () => {
  const api = { createAuthorizeURL: () => "https://accounts.spotify.com/authorize?redacted" };
  await assert.rejects(loginSpotifyInteractively(api, 50), /timed out/);
  assert.ok(await portIsFree(TEST_REDIRECT_PORT));
});
