"use strict";

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { execFile } = require("child_process");

const MAX_PLAYLIST_TRACKS = 250;

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require("@discordjs/voice");

const SpotifyWebApiNode = require("spotify-web-api-node");
const ffmpegPath = require("ffmpeg-static");

const YT_DLP_BINARY_PATH = path.join(__dirname, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const YT_DLP_MAX_BUFFER = 100 * 1024 * 1024;

function ytDlpFlagsToArgs(flags = {}) {
  const args = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === false) continue;
    const flagName = "--" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    if (value === true) {
      args.push(flagName);
    } else {
      args.push(flagName, String(value));
    }
  }
  return args;
}

function defaultYtdlp(urlOrQuery, flags = {}, execOptions = {}) {
  return new Promise((resolve, reject) => {
    const args = [...ytDlpFlagsToArgs(flags), "--", urlOrQuery];
    execFile(
      YT_DLP_BINARY_PATH,
      args,
      { maxBuffer: YT_DLP_MAX_BUFFER, windowsHide: true, ...execOptions },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed.startsWith("{") ? JSON.parse(trimmed) : trimmed);
      }
    );
  });
}

function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info: (...args) => console.log(`[${timestamp()}] INFO:`, ...args),
  error: (...args) => console.error(`[${timestamp()}] ERROR:`, ...args),
};

const SPOTIFY_PLAYLIST = "spotify_playlist";
const YOUTUBE_PLAYLIST = "youtube_playlist";
const YOUTUBE_VIDEO = "youtube_video";
const SEARCH = "search";

const SPOTIFY_PLAYLIST_RE = /open\.spotify\.com\/playlist\//;
const YOUTUBE_HOST_RE = /(youtube\.com|youtu\.be)/;
const PLAYLIST_PARAM_RE = /[?&]list=/;

function classify(query) {
  const stripped = query.trim();
  if (SPOTIFY_PLAYLIST_RE.test(stripped)) {
    return SPOTIFY_PLAYLIST;
  }
  if (YOUTUBE_HOST_RE.test(stripped)) {
    if (PLAYLIST_PARAM_RE.test(stripped)) {
      return YOUTUBE_PLAYLIST;
    }
    return YOUTUBE_VIDEO;
  }
  return SEARCH;
}

const STORAGE_BASE_DIR = __dirname;
const DEFAULT_ASSIGNMENTS_PATH = path.join(STORAGE_BASE_DIR, "data", "assignments.json");

function loadAssignments(filePath = DEFAULT_ASSIGNMENTS_PATH) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const assignments = {};
  for (const [guildId, channelId] of Object.entries(raw)) {
    assignments[guildId] = String(channelId);
  }
  return assignments;
}

function saveAssignments(assignments, filePath = DEFAULT_ASSIGNMENTS_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(assignments, null, 2));
}

class QueueItem {
  constructor(track, filepath = null) {
    this.track = track;
    this.filepath = filepath;
    this.downloadTask = null;
  }
}

class GuildPlayer {
  constructor(guildId) {
    this.guildId = guildId;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.voiceConnection = null;
    this.audioPlayer = null;
    this.pendingTransition = "advance";
    this.startingPlayback = false;
  }

  enqueue(track) {
    const item = new QueueItem(track);
    this.queue.push(item);
    return item;
  }

  remove(position) {
    const index = position - 1;
    if (index < 0 || index >= this.queue.length) {
      throw new RangeError(`No track at position ${position}`);
    }
    return this.queue.splice(index, 1)[0];
  }

  clear() {
    const removed = this.queue;
    this.queue = [];
    return removed;
  }

  advance() {
    if (this.current !== null) {
      this.history.push(this.current.track);
    }
    this.current = this.queue.length ? this.queue.shift() : null;
    return this.current;
  }

  goBack() {
    if (!this.history.length) {
      return null;
    }
    if (this.current !== null) {
      this.queue.unshift(new QueueItem(this.current.track));
    }
    this.current = new QueueItem(this.history.pop());
    return this.current;
  }
}

class CancelledError extends Error {
  constructor(message = "Download cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

class Semaphore {
  constructor(maxConcurrent) {
    this._maxConcurrent = maxConcurrent;
    this._active = 0;
    this._waiters = [];
  }

  acquire() {
    if (this._active < this._maxConcurrent) {
      this._active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._waiters.push(() => {
        this._active += 1;
        resolve();
      });
    });
  }

  release() {
    this._active -= 1;
    const next = this._waiters.shift();
    if (next) next();
  }
}

function rejectOnAbort(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(new CancelledError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

class DownloadManager {
  constructor(downloadFn) {
    this._downloadFn = downloadFn;
    this._semaphores = new Map();
    this._state = new WeakMap();
  }

  _semaphoreFor(guildId) {
    if (!this._semaphores.has(guildId)) {
      this._semaphores.set(guildId, new Semaphore(DownloadManager.MAX_CONCURRENT_DOWNLOADS));
    }
    return this._semaphores.get(guildId);
  }

  startDownload(guildId, item) {
    const controller = new AbortController();
    const state = { controller, settled: false };
    this._state.set(item, state);

    item.downloadTask = this._runDownload(guildId, item, controller.signal).finally(() => {
      state.settled = true;
    });
    item.downloadTask.catch(() => {});
  }

  async _runDownload(guildId, item, signal) {
    const semaphore = this._semaphoreFor(guildId);
    await semaphore.acquire();
    try {
      item.filepath = await rejectOnAbort(this._downloadFn(guildId, item.track, signal), signal);
    } finally {
      semaphore.release();
    }
  }

  cancel(item) {
    const state = this._state.get(item);
    if (state && !state.settled) {
      state.controller.abort();
    } else if (item.filepath) {
      DownloadManager.deleteFile(item);
    }
  }

  static deleteFile(item) {
    if (item.filepath) {
      try {
        if (fs.existsSync(item.filepath)) {
          fs.unlinkSync(item.filepath);
        }
      } catch (error) {
        logger.error(`Failed to delete ${item.filepath}:`, error.message);
      }
    }
    item.filepath = null;
  }
}

DownloadManager.MAX_CONCURRENT_DOWNLOADS = 2;

function trackFromEntry(entry) {
  const videoId = entry.id;
  return {
    title: entry.title || "Unknown title",
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    durationSeconds: entry.duration ?? null,
  };
}

async function search(query, limit = 5, ytdlpFn = defaultYtdlp) {
  const flags = { flatPlaylist: true, dumpSingleJson: true, noWarnings: true, quiet: true, skipDownload: true };
  const info = await ytdlpFn(`ytsearch${limit}:${query}`, flags);
  const entries = info.entries || [];
  return entries.map(trackFromEntry);
}

async function getVideoInfo(url, ytdlpFn = defaultYtdlp) {
  const flags = { dumpSingleJson: true, noWarnings: true, quiet: true, skipDownload: true };
  const info = await ytdlpFn(url, flags);
  return trackFromEntry(info);
}

async function extractPlaylistTracks(url, ytdlpFn = defaultYtdlp) {
  const flags = {
    flatPlaylist: true,
    dumpSingleJson: true,
    noWarnings: true,
    quiet: true,
    skipDownload: true,
    playlistItems: `1-${MAX_PLAYLIST_TRACKS + 1}`,
  };
  const info = await ytdlpFn(url, flags);
  const entries = info.entries || [];
  return entries.map(trackFromEntry);
}

async function download(track, destDir, ytdlpFn = defaultYtdlp, signal = undefined) {
  fs.mkdirSync(destDir, { recursive: true });
  const stem = crypto.randomUUID().replace(/-/g, "");
  const flags = {
    quiet: true,
    noWarnings: true,
    format: "bestaudio/best",
    output: path.join(destDir, `${stem}.%(ext)s`),
    extractAudio: true,
    audioFormat: "opus",
    audioQuality: "128K",
    ffmpegLocation: ffmpegPath,
  };
  const execaOptions = signal ? { signal } : undefined;
  await ytdlpFn(track.url, flags, execaOptions);
  return path.join(destDir, `${stem}.opus`);
}

const SPOTIFY_PLAYLIST_ID_RE = /playlist\/([a-zA-Z0-9]+)/;
const SPOTIFY_PAGE_SIZE = 100;
const SPOTIFY_SCOPES = ["playlist-read-private", "playlist-read-collaborative"];
const SPOTIFY_REDIRECT_PORT = Number(process.env.SPOTIFY_REDIRECT_PORT) || 8888;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SPOTIFY_TOKEN_PATH = path.join(STORAGE_BASE_DIR, "data", "spotify-token.json");
const SPOTIFY_TOKEN_REFRESH_MARGIN_MS = 60_000;

class SpotifyAccessError extends Error {
  constructor() {
    super(
      "Spotify rejected this playlist (403 Forbidden). This isn't specific to this playlist - Spotify restricts playlist-track reads for apps still in Development Mode, even for the bot owner's own public playlists. The bot owner needs to request Extended Quota Mode for this app in the Spotify Developer Dashboard; see the README's Spotify setup section."
    );
    this.name = "SpotifyAccessError";
  }
}

function extractPlaylistId(url) {
  const match = SPOTIFY_PLAYLIST_ID_RE.exec(url);
  if (!match) {
    throw new Error(`Not a Spotify playlist URL: ${url}`);
  }
  return match[1];
}

function loadSpotifyRefreshToken() {
  if (!fs.existsSync(SPOTIFY_TOKEN_PATH)) {
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_PATH, "utf8"));
  return raw.refreshToken || null;
}

function saveSpotifyRefreshToken(refreshToken) {
  fs.mkdirSync(path.dirname(SPOTIFY_TOKEN_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SPOTIFY_TOKEN_PATH, JSON.stringify({ refreshToken }, null, 2), { mode: 0o600 });
  fs.chmodSync(SPOTIFY_TOKEN_PATH, 0o600);
}

async function loginSpotifyInteractively(api) {
  const state = crypto.randomUUID();
  const authorizeUrl = api.createAuthorizeURL(SPOTIFY_SCOPES, state, true);
  logger.info("Spotify: open this URL in a browser to authorize the bot (one-time setup):");
  logger.info(authorizeUrl);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, SPOTIFY_REDIRECT_URI);
      if (requestUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = requestUrl.searchParams.get("error");
      const returnedState = requestUrl.searchParams.get("state");
      const authCode = requestUrl.searchParams.get("code");

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error ? `Spotify authorization failed: ${error}. You can close this tab.` : "Spotify authorized - you can close this tab.");
      server.close();

      if (error) {
        reject(new Error(`Spotify authorization failed: ${error}`));
      } else if (returnedState !== state) {
        reject(new Error("Spotify authorization callback had a mismatched state parameter."));
      } else {
        resolve(authCode);
      }
    });
    server.on("error", reject);
    server.listen(SPOTIFY_REDIRECT_PORT, "127.0.0.1");
  });

  const grant = await api.authorizationCodeGrant(code);
  api.setAccessToken(grant.body.access_token);
  api.setRefreshToken(grant.body.refresh_token);
  saveSpotifyRefreshToken(grant.body.refresh_token);
  return Date.now() + grant.body.expires_in * 1000;
}

async function refreshSpotifyAccessToken(api) {
  const grant = await api.refreshAccessToken();
  api.setAccessToken(grant.body.access_token);
  if (grant.body.refresh_token) {
    api.setRefreshToken(grant.body.refresh_token);
    saveSpotifyRefreshToken(grant.body.refresh_token);
  }
  return Date.now() + grant.body.expires_in * 1000;
}

let spotifyClientPromise = null;
let spotifyTokenExpiresAt = 0;

async function initializeSpotifyClient() {
  const api = new SpotifyWebApiNode({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: SPOTIFY_REDIRECT_URI,
  });
  const storedRefreshToken = loadSpotifyRefreshToken();
  if (storedRefreshToken) {
    api.setRefreshToken(storedRefreshToken);
    try {
      spotifyTokenExpiresAt = await refreshSpotifyAccessToken(api);
      return api;
    } catch (error) {
      logger.error("Spotify: stored token no longer works, re-authorizing -", error.message);
    }
  }
  spotifyTokenExpiresAt = await loginSpotifyInteractively(api);
  return api;
}

function ensureSpotifyClient() {
  if (!spotifyClientPromise) {
    spotifyClientPromise = initializeSpotifyClient().catch((error) => {
      spotifyClientPromise = null;
      throw error;
    });
  }
  return spotifyClientPromise;
}

async function getSpotifyClient() {
  const api = await ensureSpotifyClient();
  if (Date.now() >= spotifyTokenExpiresAt - SPOTIFY_TOKEN_REFRESH_MARGIN_MS) {
    spotifyTokenExpiresAt = await refreshSpotifyAccessToken(api);
  }
  return api;
}

async function getPlaylistTracks(url, client = null, fetchImpl = fetch) {
  const spotifyClient = client || (await getSpotifyClient());
  const playlistId = extractPlaylistId(url);
  const accessToken = spotifyClient.getAccessToken();
  const tracks = [];

  let offset = 0;
  for (;;) {
    const response = await fetchImpl(
      `https://api.spotify.com/v1/playlists/${playlistId}/items?offset=${offset}&limit=${SPOTIFY_PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!response.ok) {
      if (response.status === 403) {
        throw new SpotifyAccessError();
      }
      throw new Error(`Spotify API error (${response.status}) reading playlist items.`);
    }
    const body = await response.json();
    const items = body.items || [];
    for (const entry of items) {
      const item = entry.item;
      if (!item) continue;
      const artists = item.artists || [];
      const artist = artists.length ? artists[0].name : "";
      tracks.push([item.name, artist]);
    }
    if (items.length === 0 || tracks.length > MAX_PLAYLIST_TRACKS) {
      break;
    }
    offset += items.length;
    const { total } = body;
    const hasMore = typeof total === "number" ? offset < total : items.length === SPOTIFY_PAGE_SIZE;
    if (!hasMore) {
      break;
    }
  }
  return tracks;
}

const SEARCH_RESULT_LIMIT = 5;
const SELECT_MENU_TIMEOUT_MS = 60_000;

function formatDuration(seconds) {
  if (!seconds) {
    return "Unknown length";
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

const QUEUE_DISPLAY_LIMIT = 25;
const MESSAGE_CONTENT_LIMIT = 1900;

function truncateForDiscord(content) {
  return content.length <= MESSAGE_CONTENT_LIMIT ? content : `${content.slice(0, MESSAGE_CONTENT_LIMIT - 1)}…`;
}

function formatTrackList(queue) {
  const shown = queue.slice(0, QUEUE_DISPLAY_LIMIT);
  const lines = shown.map((item, index) => `${index + 1}. ${item.track.title}`);
  if (queue.length > QUEUE_DISPLAY_LIMIT) {
    lines.push(`…and ${queue.length - QUEUE_DISPLAY_LIMIT} more.`);
  }
  return lines;
}

function formatQueueAnnouncement(player) {
  const lines = [
    player.current ? `▶️ Now playing: **${player.current.track.title}**` : "▶️ Nothing playing yet.",
  ];
  if (player.queue.length) {
    lines.push("", "**Up next:**", ...formatTrackList(player.queue));
  } else {
    lines.push("Queue is empty.");
  }
  return truncateForDiscord(lines.join("\n"));
}

const commandsData = [
  new SlashCommandBuilder()
    .setName("assign")
    .setDescription("Bind this server's music playback to a voice channel.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The voice channel the bot should play music in")
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Search for a song, or paste a YouTube/Spotify link (including playlists).")
    .addStringOption((option) =>
      option.setName("query").setDescription("A song to search for, or a YouTube/Spotify link").setRequired(true)
    ),
  new SlashCommandBuilder().setName("pause").setDescription("Pause the current track."),
  new SlashCommandBuilder().setName("resume").setDescription("Resume the paused track."),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track."),
  new SlashCommandBuilder().setName("back").setDescription("Go back to the previous track."),
  new SlashCommandBuilder().setName("queue").setDescription("Show the upcoming queue."),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a track from the queue by its position.")
    .addIntegerOption((option) =>
      option.setName("position").setDescription("Position shown by /queue").setRequired(true)
    ),
  new SlashCommandBuilder().setName("clear").setDescription("Clear the entire queue."),
].map((command) => command.setContexts(InteractionContextType.Guild));

async function defaultDownloadTrack(guildId, track, signal) {
  const destDir = path.join(STORAGE_BASE_DIR, "downloads", String(guildId));
  return download(track, destDir, undefined, signal);
}

async function notifyInteractionFailure(interaction, message) {
  if (!interaction.isRepliable?.()) {
    return;
  }
  const payload = { content: message, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

class MusicController {
  constructor({ downloadTrack = defaultDownloadTrack, assignmentsPath = DEFAULT_ASSIGNMENTS_PATH } = {}) {
    this.players = new Map();
    this.assignmentsPath = assignmentsPath;
    this.assignments = loadAssignments(assignmentsPath);
    this.downloadManager = new DownloadManager((guildId, track, signal) => downloadTrack(guildId, track, signal));
  }

  playerFor(guildId) {
    if (!this.players.has(guildId)) {
      this.players.set(guildId, new GuildPlayer(guildId));
    }
    return this.players.get(guildId);
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    switch (interaction.commandName) {
      case "assign":
        return this.assign(interaction);
      case "play":
        return this.play(interaction);
      case "pause":
        return this.pause(interaction);
      case "resume":
        return this.resume(interaction);
      case "skip":
        return this.skip(interaction);
      case "back":
        return this.back(interaction);
      case "queue":
        return this.showQueue(interaction);
      case "remove":
        return this.remove(interaction);
      case "clear":
        return this.clear(interaction);
      default:
        return undefined;
    }
  }

  async assign(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need the Manage Server permission to use /assign.", flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = interaction.options.getChannel("channel", true);
    this.assignments[interaction.guildId] = channel.id;
    saveAssignments(this.assignments, this.assignmentsPath);
    await interaction.reply({ content: `Music will now play in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }

  async play(interaction) {
    if (!(interaction.guildId in this.assignments)) {
      await interaction.reply({
        content: "No voice channel is set up yet. Ask an admin to run /assign first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString("query", true);
    const kind = classify(query);
    if (kind === SEARCH) {
      return this.handleSearch(interaction, query);
    }
    if (kind === YOUTUBE_VIDEO) {
      return this.handleSingleVideo(interaction, query);
    }
    if (kind === YOUTUBE_PLAYLIST) {
      return this.handleYoutubePlaylist(interaction, query);
    }
    return this.handleSpotifyPlaylist(interaction, query);
  }

  async handleSearch(interaction, query) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const results = await search(query, SEARCH_RESULT_LIMIT);
    if (!results.length) {
      await interaction.editReply({ content: `No results found for '${query}'.` });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("track-select")
      .setPlaceholder("Choose a track...")
      .addOptions(
        results.map((track, index) => ({
          label: track.title.slice(0, 100),
          description: formatDuration(track.durationSeconds),
          value: String(index),
        }))
      );
    const row = new ActionRowBuilder().addComponents(menu);
    const message = await interaction.editReply({ content: "Pick a track:", components: [row] });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: SELECT_MENU_TIMEOUT_MS,
      max: 1,
      filter: (selectInteraction) => selectInteraction.user.id === interaction.user.id,
    });

    collector.on("collect", (selectInteraction) => {
      const chosen = results[Number(selectInteraction.values[0])];
      this.handleTrackSelected(selectInteraction, chosen);
    });
  }

  async handleTrackSelected(selectInteraction, chosenTrack) {
    try {
      await this.queueTrack(selectInteraction, chosenTrack);
    } catch (error) {
      logger.error("Error handling track selection:", error);
      await notifyInteractionFailure(selectInteraction, "Something went wrong queueing that track.");
    }
  }

  async handleSingleVideo(interaction, url) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const track = await getVideoInfo(url);
    await this.queueTrack(interaction, track);
  }

  async handleYoutubePlaylist(interaction, url) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tracks = await extractPlaylistTracks(url);
    const truncated = tracks.length > MAX_PLAYLIST_TRACKS;
    await this.queueMany(interaction, tracks.slice(0, MAX_PLAYLIST_TRACKS), 0, truncated);
  }

  async handleSpotifyPlaylist(interaction, url) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let pairs;
    try {
      pairs = await getPlaylistTracks(url);
    } catch (error) {
      if (error instanceof SpotifyAccessError) {
        await interaction.editReply({ content: error.message });
        return;
      }
      throw error;
    }
    const truncated = pairs.length > MAX_PLAYLIST_TRACKS;
    const tracks = [];
    let skipped = 0;
    for (const [title, artist] of pairs.slice(0, MAX_PLAYLIST_TRACKS)) {
      const searchQuery = `${artist} - ${title} audio`.replace(/^[\s-]+|[\s-]+$/g, "");
      const matches = await search(searchQuery, 1);
      if (matches.length) {
        tracks.push(matches[0]);
      } else {
        skipped += 1;
      }
    }
    await this.queueMany(interaction, tracks, skipped, truncated);
  }

  async queueMany(interaction, tracks, skipped, truncated = false) {
    const guildId = interaction.guildId;
    const player = this.playerFor(guildId);
    const wasIdle = player.current === null && !player.startingPlayback;
    for (const track of tracks) {
      const item = player.enqueue(track);
      this.downloadManager.startDownload(guildId, item);
    }

    let summary = `Queued ${tracks.length} tracks from playlist.`;
    if (skipped) {
      summary += ` (${skipped} couldn't be matched.)`;
    }
    if (truncated) {
      summary += ` (Capped at ${MAX_PLAYLIST_TRACKS} tracks - the playlist has more.)`;
    }
    await interaction.followUp({ content: summary, flags: MessageFlags.Ephemeral });

    if (tracks.length) {
      if (wasIdle && player.queue.length) {
        await this.startPlayback(interaction.guild, player);
      }
      await this.announceQueue(interaction.channel, player);
    }
  }

  async queueTrack(interaction, track) {
    const guildId = interaction.guildId;
    const player = this.playerFor(guildId);
    const item = player.enqueue(track);
    this.downloadManager.startDownload(guildId, item);

    const message = `Queued **${track.title}**.`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }

    const wasIdle = player.current === null && !player.startingPlayback;
    if (wasIdle) {
      await this.startPlayback(interaction.guild, player);
    }
    await this.announceQueue(interaction.channel, player);
  }

  async announceQueue(channel, player) {
    if (!channel || typeof channel.send !== "function") {
      return;
    }
    await channel.send({ content: formatQueueAnnouncement(player) });
  }

  async startPlayback(guild, player) {
    player.startingPlayback = true;
    try {
      await this.connectAndPlayNext(guild, player);
    } finally {
      player.startingPlayback = false;
    }
  }

  async connectAndPlayNext(guild, player) {
    const channelId = this.assignments[guild.id];
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel) {
      return;
    }

    if (!player.voiceConnection || player.voiceConnection.state.status === VoiceConnectionStatus.Destroyed) {
      const voiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
      });
      try {
        await entersState(voiceConnection, VoiceConnectionStatus.Ready, 10_000);
      } catch (error) {
        voiceConnection.destroy();
        throw new Error(
          `Couldn't connect to the voice channel (timed out after 10s) - voice traffic may be blocked on this host's network. (${error.message})`
        );
      }
      player.voiceConnection = voiceConnection;
      player.audioPlayer = createAudioPlayer();
      player.voiceConnection.subscribe(player.audioPlayer);
      player.audioPlayer.on(AudioPlayerStatus.Idle, () => {
        this.onPlaybackFinished(guild, player).catch((error) => logger.error("Playback transition error:", error));
      });
      player.audioPlayer.on("error", (error) => {
        logger.error(`Playback error in guild ${guild.id}:`, error.message);
      });
    }

    const item = player.advance();
    await this.playItem(guild, player, item);
  }

  async playItem(guild, player, item) {
    if (!item) {
      return;
    }
    if (item.downloadTask) {
      try {
        await item.downloadTask;
      } catch {
      }
    }
    if (!item.filepath) {
      await this.onPlaybackFinished(guild, player);
      return;
    }

    const resource = createAudioResource(fs.createReadStream(item.filepath), { inputType: StreamType.OggOpus });
    player.audioPlayer.play(resource);
  }

  async onPlaybackFinished(guild, player) {
    const transition = player.pendingTransition;
    player.pendingTransition = "advance";
    const finished = player.current;

    let nextItem;
    if (transition === "back") {
      nextItem = player.goBack();
      if (nextItem) {
        this.downloadManager.startDownload(guild.id, nextItem);
      }
      if (player.queue.length) {
        this.downloadManager.startDownload(guild.id, player.queue[0]);
      }
    } else {
      nextItem = player.advance();
    }

    if (finished) {
      DownloadManager.deleteFile(finished);
    }

    await this.playItem(guild, player, nextItem);
  }

  async pause(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player?.audioPlayer || player.audioPlayer.state.status !== AudioPlayerStatus.Playing) {
      await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
      return;
    }
    player.audioPlayer.pause();
    await interaction.reply({ content: "Paused.", flags: MessageFlags.Ephemeral });
  }

  async resume(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player?.audioPlayer || player.audioPlayer.state.status !== AudioPlayerStatus.Paused) {
      await interaction.reply({ content: "Nothing is paused.", flags: MessageFlags.Ephemeral });
      return;
    }
    player.audioPlayer.unpause();
    await interaction.reply({ content: "Resumed.", flags: MessageFlags.Ephemeral });
  }

  async skip(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player?.current) {
      await interaction.reply({ content: "Nothing to skip.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: `Skipped **${player.current.track.title}**.`, flags: MessageFlags.Ephemeral });
    player.pendingTransition = "advance";
    player.audioPlayer.stop();
  }

  async back(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player?.history.length) {
      await interaction.reply({ content: "No previous track.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: "Going back...", flags: MessageFlags.Ephemeral });
    player.pendingTransition = "back";
    const status = player.audioPlayer?.state.status;
    if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Paused) {
      player.audioPlayer.stop();
    } else {
      await this.onPlaybackFinished(interaction.guild, player);
    }
  }

  async showQueue(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player?.queue.length) {
      await interaction.reply({ content: "The queue is empty.", flags: MessageFlags.Ephemeral });
      return;
    }
    const content = truncateForDiscord(formatTrackList(player.queue).join("\n"));
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  async remove(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player) {
      await interaction.reply({ content: "The queue is empty.", flags: MessageFlags.Ephemeral });
      return;
    }
    const position = interaction.options.getInteger("position", true);
    let item;
    try {
      item = player.remove(position);
    } catch {
      await interaction.reply({ content: `No track at position ${position}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    this.downloadManager.cancel(item);
    await interaction.reply({ content: `Removed **${item.track.title}**.`, flags: MessageFlags.Ephemeral });
  }

  async clear(interaction) {
    const player = this.players.get(interaction.guildId);
    if (!player?.queue.length) {
      await interaction.reply({ content: "The queue is already empty.", flags: MessageFlags.Ephemeral });
      return;
    }
    const removed = player.clear();
    for (const item of removed) {
      this.downloadManager.cancel(item);
    }
    await interaction.reply({ content: `Cleared ${removed.length} tracks from the queue.`, flags: MessageFlags.Ephemeral });
  }
}

function buildDiscordClient() {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
}

async function registerCommands(clientId, token) {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commandsData.map((command) => command.toJSON()) });
}

function installProcessErrorGuards() {
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection (bot is staying up):", reason);
  });
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception (bot is staying up):", error);
  });
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set - copy .env.example to .env and fill it in.");
  }

  installProcessErrorGuards();

  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    ensureSpotifyClient().then(
      () => logger.info("Spotify: authorized."),
      (error) => logger.error("Spotify: authorization failed -", error.message)
    );
  } else {
    logger.info("Spotify: SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET not set - Spotify playlist import disabled.");
  }

  const client = buildDiscordClient();
  const music = new MusicController();

  client.once(Events.ClientReady, async (readyClient) => {
    await registerCommands(readyClient.user.id, token);
    logger.info(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await music.handleInteraction(interaction);
    } catch (error) {
      logger.error("Error handling interaction:", error);
      await notifyInteractionFailure(interaction, "Something went wrong handling that command.");
    }
  });

  await client.login(token);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error("Fatal error starting bot:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  logger,
  SPOTIFY_PLAYLIST,
  YOUTUBE_PLAYLIST,
  YOUTUBE_VIDEO,
  SEARCH,
  classify,
  DEFAULT_PATH: DEFAULT_ASSIGNMENTS_PATH,
  loadAssignments,
  saveAssignments,
  QueueItem,
  GuildPlayer,
  DownloadManager,
  CancelledError,
  defaultYtdlp,
  trackFromEntry,
  search,
  getVideoInfo,
  extractPlaylistTracks,
  download,
  extractPlaylistId,
  getPlaylistTracks,
  SpotifyAccessError,
  MAX_PLAYLIST_TRACKS,
  MusicController,
  commandsData,
  formatDuration,
  formatQueueAnnouncement,
  buildDiscordClient,
  registerCommands,
  main,
};
