const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { validateReleaseMetadata, run } = require('./release-metadata.cjs');

function fixture(version = '0.3.0') {
  const manifest = { name: '@nestarc/data-subject', version };
  return {
    manifest,
    lockfile: { ...manifest, packages: { '': { ...manifest } } },
    changelog: `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-10-11\n`,
    tag: `v${version}`,
    prerelease: version.split('+')[0].includes('-') ? 'true' : 'false',
  };
}

function workspace(t, data = fixture()) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'data-subject-release-meta-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(data.manifest));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify(data.lockfile));
  fs.writeFileSync(path.join(cwd, 'CHANGELOG.md'), data.changelog);
  const output = path.join(cwd, 'output');
  return {
    cwd, output,
    env: { RELEASE_TAG: data.tag, RELEASE_PRERELEASE: data.prerelease, GITHUB_OUTPUT: output },
  };
}

for (const [version, distTag] of [
  ['0.3.0', 'latest'],
  ['1.0.0+build.001-with-hyphens', 'latest'],
  ['0.4.0-rc.1+build.001', 'next'],
  ['1.0.0-0.alpha-1', 'next'],
]) {
  test(`accepts ${version} and selects ${distTag}`, () => {
    assert.deepEqual(validateReleaseMetadata(fixture(version)), { version, dist_tag: distTag });
  });
}

for (const version of ['v0.3.0', '0.3', '01.3.0', '0.03.0', '0.3.00', '0.3.0-01',
  '0.3.0-rc.01', '0.3.0-', '0.3.0+build..1', '0.3.0-rc_1', '0.3.0\n', 3, null]) {
  test(`rejects invalid SemVer ${JSON.stringify(version)}`, () => {
    const data = fixture();
    data.manifest.version = version;
    assert.throws(() => validateReleaseMetadata(data), /valid SemVer/);
  });
}

for (const [label, mutate, message] of [
  ['different tag', (data) => { data.tag = 'v0.2.0'; }, /Release tag/],
  ['lock version', (data) => { data.lockfile.version = '0.2.0'; }, /package-lock/],
  ['lock name', (data) => { data.lockfile.name = 'other'; }, /package-lock/],
  ['lock root package version', (data) => { data.lockfile.packages[''].version = '0.2.0'; }, /package-lock/],
  ['lock root package name', (data) => { data.lockfile.packages[''].name = 'other'; }, /package-lock/],
  ['missing lock root package', (data) => { delete data.lockfile.packages; }, /package-lock/],
  ['missing package name', (data) => { delete data.manifest.name; }, /package name/],
  ['private package', (data) => { data.manifest.private = true; }, /private/],
  ['missing prerelease flag', (data) => { delete data.prerelease; }, /RELEASE_PRERELEASE/],
  ['invalid prerelease flag', (data) => { data.prerelease = '0'; }, /RELEASE_PRERELEASE/],
  ['stable flagged prerelease', (data) => { data.prerelease = 'true'; }, /prerelease flag/],
  ['missing changelog version', (data) => { data.changelog = '## [0.2.0] - 2026-10-11\n'; }, /dated heading/],
  ['undated changelog heading', (data) => { data.changelog = '## [0.3.0]\n'; }, /dated heading/],
  ['invalid calendar date', (data) => { data.changelog = '## [0.3.0] - 2026-02-30\n'; }, /dated heading/],
]) {
  test(`rejects ${label} without writing output`, (t) => {
    const data = fixture();
    mutate(data);
    assert.throws(() => validateReleaseMetadata(data), message);
    const state = workspace(t, data);
    fs.writeFileSync(state.output, 'previous=value\n');
    assert.throws(() => run(state), message);
    assert.equal(fs.readFileSync(state.output, 'utf8'), 'previous=value\n');
  });
}

test('rejects a prerelease version marked as stable', () => {
  const data = fixture('0.4.0-rc.1');
  data.prerelease = 'false';
  assert.throws(() => validateReleaseMetadata(data), /prerelease flag/);
});

test('CLI validates metadata and appends GitHub outputs', (t) => {
  const state = workspace(t, fixture('0.4.0-rc.1'));
  fs.writeFileSync(state.output, 'previous=value\n');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'release-metadata.cjs')], {
    cwd: state.cwd, env: { ...process.env, ...state.env }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(state.output, 'utf8'), 'previous=value\nversion=0.4.0-rc.1\ndist_tag=next\n');
});

test('CLI rejects shell-looking tag data without evaluating it or producing output', (t) => {
  const state = workspace(t);
  const marker = path.join(state.cwd, 'should-not-exist');
  state.env.RELEASE_TAG = `v0.3.0$(touch ${marker})`;
  const result = spawnSync(process.execPath, [path.join(__dirname, 'release-metadata.cjs')], {
    cwd: state.cwd, env: { ...process.env, ...state.env }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release tag must equal/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(state.output), false);
});

test('requires GITHUB_OUTPUT after validating metadata', (t) => {
  const state = workspace(t);
  delete state.env.GITHUB_OUTPUT;
  assert.throws(() => run(state), /GITHUB_OUTPUT/);
  assert.equal(fs.existsSync(state.output), false);
});
