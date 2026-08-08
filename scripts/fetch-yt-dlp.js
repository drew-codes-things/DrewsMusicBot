"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const RELEASES_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const BIN_DIR = path.join(__dirname, "..", "bin");

const STANDALONE_ASSET_BY_PLATFORM = {
  win32: "yt-dlp.exe",
  darwin: "yt-dlp_macos",
  linux: "yt-dlp_linux",
};

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "discord-music-bot-postinstall" } }, (res) => {
        const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
        if (isRedirect && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(get(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} failed with status ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function destinationPath(assetName) {
  const filename = assetName.endsWith(".exe") ? "yt-dlp.exe" : "yt-dlp";
  return path.join(BIN_DIR, filename);
}

async function main() {
  const assetName = STANDALONE_ASSET_BY_PLATFORM[process.platform];
  if (!assetName) {
    throw new Error(
      `fetch-yt-dlp: unsupported platform "${process.platform}" - no standalone yt-dlp build is published for it.`
    );
  }

  const releaseBody = await get(RELEASES_URL);
  const release = JSON.parse(releaseBody.toString("utf8"));
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(`fetch-yt-dlp: no "${assetName}" asset found in the latest yt-dlp release.`);
  }

  const binary = await get(asset.browser_download_url);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const destination = destinationPath(assetName);
  fs.writeFileSync(destination, binary, { mode: 0o755 });
  fs.chmodSync(destination, 0o755);
  console.log(`fetch-yt-dlp: installed ${assetName} to ${destination}`);
}

main().catch((error) => {
  console.error("fetch-yt-dlp: failed to fetch yt-dlp -", error.message);
  console.error("The bot will not be able to search or play anything until this is resolved.");
  console.error("You can try again later with: npm run fetch-yt-dlp");
});
