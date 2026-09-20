const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildSync } = require("esbuild");

// Execute the generated shell protocol, including paths with spaces and
// shell metacharacters. No network or changes to the installed plugin.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "framelab-download-test-"));
try {
  const bundle = path.join(root, "ytdlp.cjs");
  buildSync({
    entryPoints: [path.join(__dirname, "../src/tools/download/ytdlp.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
  });
  const dl = require(bundle);
  const fake = path.join(root, "fake-ytdlp");
  fs.writeFileSync(fake, `#!/bin/bash
DEST=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -P) DEST="$2"; shift;;
    --print) [ "$2" = 'after_move:FRAMELAB_FILE:%(filepath)j' ] || exit 20; shift;;
    --print-to-file) echo 'ERROR: old protocol' >&2; exit 21;;
    https://*) URL="$1";;
  esac
  shift
done
if [ "$URL" = 'https://example.test/fail' ]; then
  echo 'ERROR: HTTP Error 403: Forbidden' >&2
  exit 1
fi
FILE="$DEST/Enough Is Enough [fixture].mp4"
[ -f "$FILE" ] || printf 'video fixture' > "$FILE"
echo '[download] 100% of 13B' >&2
printf 'FRAMELAB_FILE:"%s"\\n' "$FILE"
`, { mode: 0o755 });

  function run(name, urls, sameDestination = false) {
    const work = path.join(root, name, "work ' & espaço");
    const dest = sameDestination ? work : path.join(root, name, "dest ' & espaço");
    fs.mkdirSync(work, { recursive: true });
    // run() assigns fresh protocol files for each invocation in the panel.
    for (const name of ["dl-files.txt", "dl-log.txt", "dl-result.json"]) {
      fs.rmSync(path.join(work, name), { force: true });
    }
    // Prevent provisioning and UI interaction during protocol tests.
    fs.writeFileSync(path.join(work, "deno"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    let script = dl.downloadScriptUnix(urls, dl.findQuality("720"),
      { ...dl.DEFAULT_CONFIG, ytdlpPath: fake }, work, dest, [], fake);
    script = script.replace(/^if pgrep -xq Terminal;.*$/m, "");
    const file = path.join(work, "download.command");
    fs.writeFileSync(file, script);
    const result = spawnSync("/bin/bash", [file], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(fs.readFileSync(path.join(work, "dl-result.json"), "utf8"));
    const log = fs.readFileSync(path.join(work, "dl-log.txt"), "utf8");
    const listed = dl.parseDownloadedFiles(log).join("\n");
    return { outcome, listed, log, dest };
  }

  for (const same of [false, true]) {
    const result = run(`success-${same}`, ["https://example.test/video"], same);
    assert.equal(result.outcome.ok, true);
    assert.equal(result.listed, path.join(result.dest, "Enough Is Enough [fixture].mp4"));
    assert.equal(fs.readFileSync(result.listed, "utf8"), "video fixture");
    assert.match(result.log, /\[download\] 100%/);
    if (!same) assert.equal(fs.existsSync(path.join(result.dest, "dl-files.txt")), false);
    // Re-run against an existing file: the path still must reach the panel.
    assert.equal(run(`success-${same}`, ["https://example.test/video"], same).listed, result.listed);
  }
  const failure = run("failure", ["https://example.test/fail"]);
  assert.equal(failure.outcome.ok, false);
  assert.equal(failure.outcome.failed, 1);
  assert.equal(failure.listed, "");
  assert.match(failure.log, /ERROR: HTTP Error 403/);
  const partial = run("partial", ["https://example.test/fail", "https://example.test/video"]);
  assert.equal(partial.outcome.failed, 1);
  assert.equal(partial.listed, path.join(partial.dest, "Enough Is Enough [fixture].mp4"));
  assert.match(dl.describeRunError("missing-files", ""), /não informou o arquivo/);
  const tricky = 'C:\\Vídeos\\a "quote" & 100%.mp4';
  assert.deepEqual(dl.parseDownloadedFiles([
    `FRAMELAB_FILE:${JSON.stringify(tricky)}`,
    ...Array(30).fill('[download] 50% of 10MiB'),
    'FRAMELAB_FILE:broken', 'FRAMELAB_FILE:null', 'FRAMELAB_FILE:"NA"',
    `FRAMELAB_FILE:${JSON.stringify(tricky)}`,
    'FRAMELAB_FILE:"/Volumes/External/video.mp4"',
  ].join('\r\n')), [tricky, '/Volumes/External/video.mp4']);

  const windows = dl.downloadScriptWin(["https://example.test/video"], dl.findQuality("720"),
    dl.DEFAULT_CONFIG, "C:\\Work", "C:\\Videos");
  assert.match(windows, /--print "after_move:FRAMELAB_FILE:%%\(filepath\)j" --no-simulate --no-quiet --progress/);
  assert.match(windows, />>"%WORK%\\dl-log.txt" 2>&1/);
  assert.doesNotMatch(windows, /--print-to-file|type "%DEST%\\dl-files/);
  console.log("Download protocol: success, existing files, same folder, failure and partial batch passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
