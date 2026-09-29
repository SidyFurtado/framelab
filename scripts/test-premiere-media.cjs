const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framelab-media-test-'));
try {
  const bundle = path.join(root, 'media.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '../src/tools/download/premiereMedia.ts')],
    outfile: bundle, bundle: true, platform: 'node', logLevel: 'silent' });
  const helper = path.join(root, 'prepare.sh');
  fs.writeFileSync(helper, require(bundle).premiereMediaUnix);
  const ffmpeg = path.join(root, 'ffmpeg');
  fs.writeFileSync(ffmpeg, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('-movflags')) {
  if (process.env.VIDEO !== 'invalid') {
    console.error('Stream #0:0: Video: ' + process.env.VIDEO + ', yuv420p, 3840x2160');
    if (process.env.AUDIO) console.error('Stream #0:1: Audio: ' + process.env.AUDIO + ', stereo');
  }
  process.exit(1); // ffmpeg -i without an output always exits 1
}
fs.writeFileSync(process.env.AUDIT, JSON.stringify(args));
fs.writeFileSync(args.at(-1), 'converted');
process.exit(process.env.FAIL_CONVERSION === '1' ? 1 : 0);
`, { mode: 0o755 });

  let index = 0;
  function run(video, audio, fail = false, missing = false) {
    const source = path.join(root, `${++index} espaço ' " & $() % \\ newline\n.mp4`);
    const audit = path.join(root, 'audit.json');
    fs.rmSync(audit, { force: true });
    fs.writeFileSync(source, 'original');
    const result = spawnSync('/bin/bash', [helper, source], { encoding: 'utf8',
      env: { ...process.env, FRAMELAB_FFMPEG: missing ? '' : ffmpeg,
        VIDEO: video, AUDIO: audio, FAIL_CONVERSION: fail ? '1' : '0', AUDIT: audit } });
    const marker = result.stdout.split('\n').find(line => line.startsWith('FRAMELAB_FILE:'));
    const args = fs.existsSync(audit) ? JSON.parse(fs.readFileSync(audit, 'utf8')) : null;
    assert.equal(fs.readdirSync(root).some(name => name.includes('.framelab.')), false);
    if (fail || missing || video === 'invalid') {
      assert.notEqual(result.status, 0);
      assert.equal(marker, undefined, 'Failed conversion must never be imported');
      assert.equal(fs.readFileSync(source, 'utf8'), 'original');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(marker.slice('FRAMELAB_FILE:'.length)), source);
      assert.equal(fs.readFileSync(source, 'utf8'), args ? 'converted' : 'original');
    }
    return args;
  }
  assert.equal(run('h264', 'aac'), null, 'Compatible files must not be re-encoded');
  assert.equal(run('h264', ''), null, 'Silent videos must work');
  const both = run('av1', 'opus');
  assert.equal(both[both.indexOf('-c:v') + 1], 'libx264');
  assert.equal(both[both.indexOf('-c:a') + 1], 'aac');
  assert.equal(both.includes('-s'), false, 'Resolution must be preserved');
  assert.equal(both.includes('-r'), false, 'Frame rate must be preserved');
  const audioOnly = run('h264', 'opus');
  assert.equal(audioOnly[audioOnly.indexOf('-c:v') + 1], 'copy');
  const videoOnly = run('vp9', 'aac');
  assert.equal(videoOnly[videoOnly.indexOf('-c:a') + 1], 'copy');
  run('av1', 'opus', true);
  run('invalid', '');
  run('h264', 'aac', false, true);
  console.log('Premiere media: codec conversion, passthrough, silent video, safe paths and failure recovery passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
