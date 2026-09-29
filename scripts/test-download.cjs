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
RUNTIME=''
PREPARE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --js-runtimes) RUNTIME="\${2#deno:}"; shift;;
    --exec) PREPARE=1; shift;;
    -P) DEST="$2"; shift;;
    --print) [ "$2" = 'after_move:FRAMELAB_FILE:%(filepath)j' ] || exit 20; shift;;
    --print-to-file) echo 'ERROR: old protocol' >&2; exit 21;;
    --cookies-from-browser)
      printf '%s' "$2" > "$WORK/cookies-arg"
      STAGED="\${2#*:}"
      if [ "$STAGED" != "$2" ] && [ -f "$STAGED/Cookies" ]; then cp "$STAGED/Cookies" "$WORK/cookies-staged"; fi
      shift;;
    https://*) URL="$1";;
  esac
  shift
done
[ -n "$RUNTIME" ] && "$RUNTIME" --version >/dev/null 2>&1 || exit 22
if [ "$URL" = 'https://example.test/fail' ]; then
  echo 'ERROR: HTTP Error 403: Forbidden' >&2
  exit 1
fi
FILE="$DEST/Enough Is Enough [fixture].mp4"
[ -f "$FILE" ] || printf 'video fixture' > "$FILE"
echo '[download] 100% of 13B' >&2
if [ "$PREPARE" = 1 ]; then
  /bin/bash "$WORK/dl-log.txt.premiere.sh" "$FILE"
else
  printf 'FRAMELAB_FILE:"%s"\\n' "$FILE"
fi
`, { mode: 0o755 });
  const fakeFfmpeg = path.join(root, "fake-ffmpeg");
  fs.writeFileSync(fakeFfmpeg, `#!/bin/bash
echo 'Stream #0:0: Video: h264 (High), yuv420p, 1280x720' >&2
echo 'Stream #0:1: Audio: aac, 48000 Hz, stereo' >&2
exit 1
`, { mode: 0o755 });

  function run(name, urls, sameDestination = false, runtime = "cached", options = {}) {
    const work = path.join(root, name, "work ' & espaço");
    const tmp = path.join(root, name, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const dest = sameDestination ? work : path.join(root, name, "dest ' & espaço");
    fs.mkdirSync(work, { recursive: true });
    // run() assigns fresh protocol files for each invocation in the panel.
    for (const name of ["dl-files.txt", "dl-log.txt", "dl-result.json"]) {
      fs.rmSync(path.join(work, name), { force: true });
    }
    const validDeno = "#!/bin/bash\necho 'deno 2.7.0'\n";
    fs.writeFileSync(path.join(work, "deno"), runtime === "cached" ? validDeno :
      "#!/bin/bash\necho 'bad CPU type in executable' >&2\nexit 127\n", { mode: 0o755 });
    const bin = path.join(work, "bin");
    fs.mkdirSync(bin, { recursive: true });
    // Isolate system runtimes and provisioning; no network is used.
    fs.writeFileSync(path.join(bin, "deno"), runtime === "path" ? validDeno :
      "#!/bin/bash\nexit 127\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/bash\necho arm64\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
case "$*" in
  *deno-aarch64-apple-darwin.zip*) printf arm64 > "$WORK/runtime-download"; exit 0;;
  *) exit 23;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "unzip"), `#!/bin/bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-d' ]; then printf '#!/bin/bash\\necho "deno 2.7.0"\\n' > "$2/deno"; exit 0; fi
  shift
done
exit 24
`, { mode: 0o755 });
    let script = dl.downloadScriptUnix(urls, dl.findQuality("720"),
      { ...dl.DEFAULT_CONFIG, ytdlpPath: fake, cookies: options.cookies ?? "none" },
      work, dest, [], fakeFfmpeg);
    script = script.replace(/^if pgrep -xq Terminal;.*$/m, "");
    script = script.replace(/\/opt\/homebrew\/bin\/deno|\/usr\/local\/bin\/deno/g, "/nonexistent-framelab-test/deno");
    script = script.replace('"$HOME/.deno/bin/deno"', '"$WORK/missing-deno"');
    const file = path.join(work, "download.command");
    fs.writeFileSync(file, script);
    const result = spawnSync("/bin/bash", [file], { encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WORK: work, TMPDIR: tmp,
        HOME: options.home ?? process.env.HOME } });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(fs.readFileSync(path.join(work, "dl-result.json"), "utf8"));
    const log = fs.readFileSync(path.join(work, "dl-log.txt"), "utf8");
    const listed = dl.parseDownloadedFiles(log).join("\n");
    const read = (file) => fs.existsSync(path.join(work, file))
      ? fs.readFileSync(path.join(work, file), "utf8") : null;
    return { outcome, listed, log, dest, work, tmp,
      cookiesArg: read("cookies-arg"), cookiesStaged: read("cookies-staged") };
  }

  // Cookies: a browser the agent cannot read must never stop the download.
  const support = (home) => path.join(home, "Library", "Application Support");
  const missingHome = path.join(root, "home-missing");
  fs.mkdirSync(missingHome, { recursive: true });
  const missing = run("cookies-missing", ["https://example.test/video"], false, "cached",
    { cookies: "chrome", home: missingHome });
  assert.equal(missing.outcome.ok, true, missing.log);
  assert.equal(missing.cookiesArg, null, "No browser, no cookies flag");
  assert.equal(dl.parseCookieTrouble(missing.log), "missing");

  const blockedHome = path.join(root, "home-blocked");
  const blockedChrome = path.join(support(blockedHome), "Google", "Chrome");
  fs.mkdirSync(blockedChrome, { recursive: true });
  fs.chmodSync(blockedChrome, 0o000); // what macOS privacy protection looks like to ls
  try {
    const blocked = run("cookies-blocked", ["https://example.test/video"], false, "cached",
      { cookies: "chrome", home: blockedHome });
    assert.equal(blocked.outcome.ok, true, blocked.log);
    assert.equal(blocked.cookiesArg, null, "Unreadable browser must be skipped, not passed on");
    assert.equal(dl.parseCookieTrouble(blocked.log), "blocked");
  } finally {
    fs.chmodSync(blockedChrome, 0o755);
  }

  // Readable Chrome: only the last-used profile's database reaches yt-dlp,
  // even with a newer internal "Cookies" (Gemini) inside that profile.
  const readableHome = path.join(root, "home-readable");
  const chrome = path.join(support(readableHome), "Google", "Chrome");
  fs.mkdirSync(path.join(chrome, "Profile 4", "Storage", "ext", "glic", "x"), { recursive: true });
  fs.mkdirSync(path.join(chrome, "Default"), { recursive: true });
  fs.writeFileSync(path.join(chrome, "Local State"),
    JSON.stringify({ profile: { last_used: "Profile 4" } }));
  fs.writeFileSync(path.join(chrome, "Default", "Cookies"), "default profile");
  fs.writeFileSync(path.join(chrome, "Profile 4", "Cookies"), "profile 4");
  fs.writeFileSync(path.join(chrome, "Profile 4", "Storage", "ext", "glic", "x", "Cookies"), "decoy");
  const readable = run("cookies-readable", ["https://example.test/video"], false, "cached",
    { cookies: "chrome", home: readableHome });
  assert.equal(readable.outcome.ok, true, readable.log);
  assert.match(readable.cookiesArg, /^chrome:\//);
  assert.equal(readable.cookiesStaged, "profile 4");
  assert.equal(dl.parseCookieTrouble(readable.log), null);
  assert.deepEqual(fs.readdirSync(readable.tmp), [], "The staged cookie copy must be deleted");

  fs.mkdirSync(path.join(support(readableHome), "Firefox"), { recursive: true });
  const firefox = run("cookies-firefox", ["https://example.test/video"], false, "cached",
    { cookies: "firefox", home: readableHome });
  assert.equal(firefox.cookiesArg, "firefox");
  const safari = run("cookies-safari", ["https://example.test/video"], false, "cached",
    { cookies: "safari", home: missingHome });
  assert.equal(safari.outcome.ok, true, safari.log);
  assert.equal(safari.cookiesArg, null);
  assert.equal(dl.parseCookieTrouble(safari.log), "blocked");

  const noCookies = run("cookies-none", ["https://example.test/video"]);
  assert.equal(noCookies.cookiesArg, null);
  assert.equal(dl.parseCookieTrouble(noCookies.log), null);

  const probe = dl.probeScriptUnix(["https://example.test/video"], "t",
    { ...dl.DEFAULT_CONFIG, cookies: "chrome" }, "/work");
  assert.match(probe, /\$\{CK:\+--cookies-from-browser "\$CK"\} -J/);
  assert.match(probe, /FRAMELAB_COOKIES:blocked/);
  const fallback = run("runtime-path", ["https://example.test/video"], false, "path");
  assert.equal(fallback.outcome.ok, true, fallback.log);
  assert.equal(fs.existsSync(path.join(fallback.work, "runtime-download")), false);
  const repaired = run("runtime-repair", ["https://example.test/video"], false, "repair");
  assert.equal(repaired.outcome.ok, true, repaired.log);
  assert.equal(fs.readFileSync(path.join(repaired.work, "runtime-download"), "utf8"), "arm64");
  assert.match(fs.readFileSync(path.join(repaired.work, "deno"), "utf8"), /deno 2\.7\.0/);
  assert.equal(fs.readdirSync(repaired.work).some(name => name.startsWith("deno-install.")), false);

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
  assert.match(windows, /--exec "after_move:powershell .*%%\(filepath\)q" --no-simulate --no-quiet --progress/);
  assert.doesNotMatch(windows, /--print "after_move:FRAMELAB_FILE/);
  assert.match(windows, /--merge-output-format mp4 --remux-video mp4/);
  const audio = dl.downloadScriptWin(["https://example.test/audio"], dl.findQuality("audio"),
    dl.DEFAULT_CONFIG, "C:\\Work", "C:\\Audio");
  assert.match(audio, /--print "after_move:FRAMELAB_FILE:%%\(filepath\)j"/);
  assert.doesNotMatch(audio, /--exec/);
  // Instagram: the real complaint quotes "--cookies-from-browser", which the
  // generic login rule would otherwise steal.
  const igLocked = "ERROR: [Instagram] DAtest123: Instagram sent an empty media response. " +
    "Check if this post is accessible in your browser without being logged-in. If it is not, " +
    "then use --cookies-from-browser or --cookies for the authentication.";
  assert.match(dl.diagnoseLog(igLocked), /O Instagram não entregou esse link sem login/);
  assert.equal(dl.shortReason(igLocked), "Instagram pediu login");
  assert.match(dl.diagnoseLog("ERROR: [Instagram] Dc5Uq11i7W9: No video formats found!"),
    /Não há vídeo nesse link/);
  assert.match(dl.diagnoseLog("ERROR: Sign in to confirm you're not a bot"), /escolha o navegador/);
  // A cookie database yt-dlp cannot open is not a login wall.
  const unreadable = 'Extracting cookies from chrome\nERROR: could not find chrome cookies ' +
    'database in "/Users/x/Library/Application Support/Google/Chrome"';
  assert.match(dl.diagnoseLog(unreadable), /Não deu para ler os cookies/);
  assert.equal(dl.shortReason(unreadable), "cookies ilegíveis");
  assert.match(dl.diagnoseLog("ERROR: [site] 123: This video is only available for registered " +
    "users. Use --cookies-from-browser or --cookies for the authentication."), /O site pediu login/);
  assert.match(dl.diagnoseLog("Extracting cookies from chrome\nERROR: HTTP Error 404: Not Found"),
    /HTTP Error 404/, "The word cookies alone must not read as a login wall");
  // A page the generic extractor cannot parse is an unsupported site, and
  // yt-dlp's bug-report boilerplate never reaches the editor.
  const boilerplate = "; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , " +
    "filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U";
  const noPlayer = `ERROR: [generic] Unable to extract flashvars${boilerplate}`;
  assert.equal(dl.diagnoseLog(noPlayer), "O yt-dlp não sabe ler os vídeos desse site.");
  assert.equal(dl.shortReason(noPlayer), "site não suportado");
  assert.equal(dl.diagnoseLog(`ERROR: [somesite] 42: Unable to extract title${boilerplate}`),
    "O yt-dlp reclamou: [somesite] 42: Unable to extract title");
  assert.equal(dl.needsLogin(noPlayer), false);
  assert.equal(dl.needsLogin("ERROR: Sign in to confirm you're not a bot"), true);
  assert.equal(dl.needsLogin("ERROR: [youtube] abc123: Private video"), true);
  assert.equal(dl.describeCookieTrouble("blocked", "Chrome", true),
    "sem cookies (o macOS bloqueou o Chrome)");
  assert.match(dl.describeCookieTrouble("blocked", "Chrome"), /Acesso Total ao Disco/);

  assert.match(windows, />>"%WORK%\\dl-log.txt" 2>&1/);
  assert.doesNotMatch(windows, /--print-to-file|type "%DEST%\\dl-files/);
  console.log("Download protocol: success, existing files, same folder, failure, partial batch, incompatible runtime recovery and unreadable browser cookies passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
