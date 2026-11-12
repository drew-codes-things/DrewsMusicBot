const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { download, removeLeftoverDownloads } = require("../index.js");

const SONG = { title: "Song", videoId: "v1", url: "https://www.youtube.com/watch?v=v1", durationSeconds: 60 };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "musicbot-cleanup-"));
}

test("leftover downloads from an earlier run are removed at start", () => {
  const root = tempDir();
  const downloads = path.join(root, "downloads");
  fs.mkdirSync(path.join(downloads, "g1"), { recursive: true });
  fs.mkdirSync(path.join(downloads, "g2"), { recursive: true });
  fs.writeFileSync(path.join(downloads, "g1", "t0.opus"), "a");
  fs.writeFileSync(path.join(downloads, "g1", "t1.webm.part"), "a");
  fs.writeFileSync(path.join(downloads, "g2", "t2.opus"), "a");
  fs.writeFileSync(path.join(root, "keep.json"), "{}");
  assert.equal(removeLeftoverDownloads(downloads), 3);
  assert.deepEqual(fs.readdirSync(downloads), []);
  assert.ok(fs.existsSync(path.join(root, "keep.json")));
});

test("a missing downloads folder is fine", () => {
  assert.equal(removeLeftoverDownloads(path.join(tempDir(), "nothing-here")), 0);
});

test("a cancelled download removes its partial files", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "other-track.opus"), "keep");
  const controller = new AbortController();
  const fakeYtdlp = (url, flags, execOptions) => new Promise((resolve, reject) => {
    fs.writeFileSync(flags.output.replace("%(ext)s", "webm.part"), "partial");
    execOptions.signal.addEventListener("abort", () => reject(new Error("killed")), { once: true });
  });
  const pending = download(SONG, dir, fakeYtdlp, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /killed/);
  assert.deepEqual(fs.readdirSync(dir), ["other-track.opus"]);
});

test("a filtered download leaves nothing behind", async () => {
  const dir = tempDir();
  const fakeYtdlp = async (url, flags) => {
    fs.writeFileSync(flags.output.replace("%(ext)s", "webm.part"), "partial");
    return "";
  };
  await assert.rejects(download(SONG, dir, fakeYtdlp));
  assert.deepEqual(fs.readdirSync(dir), []);
});
