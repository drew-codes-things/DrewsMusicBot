# Discord Music Bot

A self-hosted Discord bot that streams music into a voice channel. Search
for a song or paste a YouTube/Spotify link - including full playlists -
pick a track, and control playback with slash commands. Audio is
downloaded via `yt-dlp` on demand and deleted immediately after it plays.

Spotify playlists are matched to YouTube a few tracks at a time (four
lookups in flight, see `SPOTIFY_MATCH_CONCURRENCY` in `index.js`), so a
long playlist queues in seconds rather than minutes. A track that cannot
be matched is skipped and counted in the "couldn't be matched" summary.

Whenever a track (or playlist) is added to the queue, the bot also posts
an up-to-date "now playing / up next" listing into the channel the
`/play` command was used in, so everyone watching can see what's queued.

Runs on Windows, macOS, and Linux. The entire bot lives in one file,
`index.js`; `npm install` also pulls down everything needed to decode/encode
audio (`ffmpeg-static`) and to run `yt-dlp` (a platform-specific standalone
binary, fetched by `scripts/fetch-yt-dlp.js`) - there's nothing to install
system-wide.

## Setup

1. **Create a Discord bot application:**
   - Go to the [Discord Developer Portal](https://discord.com/developers/applications), create an application, add a Bot user.
   - Under **Bot**, enable no privileged intents (this bot only needs default intents plus voice, not message content).
   - Copy the bot token into `.env` as `DISCORD_BOT_TOKEN`.
   - Under **OAuth2 > URL Generator**, select the `bot` and `applications.commands` scopes, and the `Connect`/`Speak` bot permissions, then use the generated URL to invite the bot to your server.

2. **Create a Spotify app** (needed only for importing Spotify playlists):
   - Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app.
   - Copy the Client ID and Client Secret into `.env` as `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
   - Under **Settings > Redirect URIs**, add `http://127.0.0.1:8888/callback` (or whatever port you set `SPOTIFY_REDIRECT_PORT` to in `.env`) - this is only used locally, for the one-time login below.
   - Under **User Management**, add the Spotify account you'll log in
     with in step 4. New apps default to Development Mode, which since
     Spotify's February 2026 platform changes only allows up to 5
     explicitly allowlisted accounts to authenticate at all - without
     this, even the login in step 4 will fail for your own account.

3. **Install dependencies and run** (requires Node.js 22.12+ - see note below):
   ```bash
   npm install
   cp .env.example .env   # then fill in your tokens
   npm start
   ```

   Node 22.12+ is what `@discordjs/voice` officially declares as required
   (it's bundled `npm install` as an advisory warning, not a hard block).
   This isn't optional pickiness: Discord now requires all non-stage
   voice connections to speak its E2EE protocol (DAVE), and
   `@discordjs/voice` >=0.19 needs `@snazzah/davey` (installed
   automatically as a dependency) to support it - without it, every
   voice connection is rejected with close code 4017 and `/play` just
   times out after 10 seconds with no other symptom. We've verified this
   also works on Node 18.19, but that's unsupported by the library
   itself; upgrade if you hit anything odd.

4. **One-time Spotify login** (only if you filled in the Spotify keys): on
   first run, the bot prints an `accounts.spotify.com` URL to the console -
   open it, log in as yourself, and approve. It only needs to be done once;
   the resulting token is saved to `data/spotify-token.json` (already
   gitignored) and reused across restarts. It only asks again if that
   stored token is later revoked from your Spotify account settings.
   Spotify's playlist-reading endpoints require a real logged-in user -
   there's no way around this step; app-only credentials alone are no
   longer accepted for reading playlists. **Everyone who uses `/play` on a
   Spotify link is querying Spotify as you** - see the "is this safe?"
   note below.

Slash commands are (re-)registered automatically with Discord every time
the bot logs in. Spotify login doesn't block that - the bot connects to
Discord immediately, and only a `/play` on a Spotify link before you've
finished logging in has to wait.

### Is it safe to use your own Spotify login for a bot other people use?

Yes, with the scope this bot actually needs. Every Discord user's `/play`
on a Spotify link maps to exactly one fixed, read-only call
(`getPlaylistTracks`) - there's no command that turns user input into a
write to your Spotify account, and Discord users never see or can reach
the stored token. The login above only requests `playlist-read-private`
and `playlist-read-collaborative` - read-only, nothing that can modify
your account. The one real shared cost is Spotify's API rate limit, which
is tied to your app; heavy use by others can throttle it for everyone,
same as any shared resource.

### Whose Spotify playlists actually work with `/play`?

Because of Spotify's 2024 application changes, `/play` on a Spotify link
only works for playlists that the logged-in account (whoever completed
the one-time login above) owns, or has been added to as a collaborator -
viewer or editor. A playlist that account has no relationship to will
fail even if it's public.

If someone wants their playlist to work with `/play`, they don't need to
run the bot themselves: they just add the logged-in account as a
collaborator on their playlist in Spotify. Once that's done, the
playlist's link works for anyone in the server, not just the account
owner or the person who was added - the bot always reads it through the
one logged-in account, regardless of who runs `/play`.

### Playlist import limit

`/play` on a playlist link (YouTube or Spotify) queues at most **250
tracks**. Larger playlists are truncated, not rejected - the first 250 get
queued and the confirmation message says so.

### About the bundled ffmpeg/yt-dlp, and why there's no native Opus dependency

- **ffmpeg** comes from the `ffmpeg-static` package - a prebuilt binary for
  Windows/macOS/Linux downloaded at `npm install` time, and pointed at by
  the download step (`yt-dlp --ffmpeg-location`) - so no system-wide
  ffmpeg install or `PATH` setup is needed on any platform.
- Tracks are downloaded straight to **Ogg-Opus** (yt-dlp's
  `--audio-format opus`) - Discord's own wire format for voice audio -
  instead of mp3. That means playback only has to *demux* the file
  (`@discordjs/voice`'s `StreamType.OggOpus`, backed by `prism-media`'s
  pure-JS Ogg demuxer), not transcode it in real time, so the bot has no
  dependency on `@discordjs/opus` or any other native Opus encoder/addon
  - one less thing to compile at install time, and one less lossy
  transcode per track.
- **yt-dlp** ships in two forms on GitHub: a lightweight build that still
  needs a system Python, and a fully standalone one that bundles its own
  interpreter. `scripts/fetch-yt-dlp.js` runs automatically after `npm
  install` and downloads the standalone build straight from GitHub releases
  into `./bin` (not a wrapper package - none of the npm wrappers avoid a
  Python dependency on every platform) - so, like ffmpeg, nothing extra
  needs to be on the host. If the download fails (e.g. no network at
  install time), rerun it with `npm run fetch-yt-dlp`.

## Commands

| Command | Description |
|---|---|
| `/assign #channel` | (Admin) Bind this server's playback to a voice channel. Required before `/play` works. |
| `/play <query>` | Search, or paste a YouTube video/playlist or Spotify playlist link. Posts an updated queue listing to the channel once the track(s) are added. |
| `/pause` / `/resume` | Pause or resume the current track. |
| `/skip` | Skip to the next queued track. |
| `/back` | Go back to the previous track. |
| `/queue` | Show the upcoming queue (only visible to you). |
| `/remove <position>` | Remove one track from the queue by its `/queue` position. |
| `/clear` | Clear the entire queue. |

### Queues survive restarts

The current track and everything queued after it are saved to `data/queues.json` whenever the queue changes. When the bot starts again it re-queues them in each server that still has an assigned channel, starting from the track that was playing. Delete that file to start with empty queues.

## Running the tests

```bash
npm test
```

All tests run against mocked yt-dlp/Spotify/Discord interfaces - no
network access or a live bot session is required.

## Manual verification checklist

- [ ] Queue a few tracks, restart the bot, and confirm it rejoins the assigned channel and carries on from the track that was playing.

Automated tests cover queue/history logic, download concurrency, and
command registration, but real voice playback needs a live bot and
Discord server to verify:

- [ ] `/assign` a voice channel as a non-admin - confirm it's rejected.
- [ ] `/assign` a voice channel as an admin - confirm it succeeds.
- [ ] `/play` a search query before `/assign` has ever been run - confirm the "no channel assigned" message.
- [ ] `/play` a search query - confirm the select menu appears, only the invoking user can pick a result, and the bot joins the assigned channel and starts playing.
- [ ] `/play` a second search while a track is already playing - confirm it's added to the queue instead of interrupting playback.
- [ ] `/play` a single YouTube video URL - confirm it queues directly, no search picker.
- [ ] `/play` a YouTube playlist URL - confirm every track gets queued.
- [ ] `/play` a Spotify playlist URL - confirm tracks are matched and queued, with a summary of any that couldn't be matched.
- [ ] First run with Spotify keys set - confirm the authorize URL is printed, logging in completes the flow, and `data/spotify-token.json` is created; restart the bot and confirm it *doesn't* prompt again.
- [ ] `/play` a YouTube or Spotify playlist with 250+ tracks - confirm exactly 250 get queued and the confirmation message says it was capped.
- [ ] After any `/play` that successfully queues something - confirm a non-ephemeral "now playing / up next" message is posted to the channel the command was used in.
- [ ] `/pause` then `/resume` - confirm playback pauses and resumes correctly.
- [ ] `/skip` - confirm the current track's downloaded file is deleted and the next track plays.
- [ ] `/back` - confirm it returns to the previous track (re-downloading it), and the track it interrupted is put back at the front of the queue.
- [ ] `/queue` - confirm the displayed positions match what `/remove` expects.
- [ ] `/remove <position>` - confirm the right track is removed and its file (if partially/fully downloaded) is cleaned up.
- [ ] `/clear` - confirm the whole queue empties and all its files are cleaned up.
- [ ] Run the bot in two different Discord servers at once, playing different songs simultaneously - confirm neither server's queue, playback, or downloads affect the other.
- [ ] Queue 3+ tracks in one server at once - confirm only 2 download at a time (watch the `downloads/{guild_id}/` folder) rather than all downloading in parallel.
