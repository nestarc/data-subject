const fs = require('node:fs');
const path = require('node:path');

function validateReleaseMetadata({ manifest, lockfile, changelog, tag, prerelease }) {
  const version = manifest.version;
  const match = typeof version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match[0] !== version || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error('package.json version must be valid SemVer 2.0.0');
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error('package.json must have a package name');
  }
  if (manifest.private) throw new Error('Cannot release a private package');
  if (tag !== `v${version}`) throw new Error('Release tag must equal v<package.json version>');
  for (const entry of [lockfile, lockfile.packages?.['']]) {
    if (entry?.name !== manifest.name || entry?.version !== version) {
      throw new Error('package-lock.json root name/version must match package.json');
    }
  }
  if (prerelease !== 'true' && prerelease !== 'false') {
    throw new Error('RELEASE_PRERELEASE must be true or false');
  }
  const isPrerelease = Boolean(match[4]);
  if ((prerelease === 'true') !== isPrerelease) {
    throw new Error('GitHub prerelease flag must match the package version');
  }
  const headings = changelog.split(/\r?\n/).map((line) =>
    /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line));
  const heading = headings.find((entry) => entry?.[1] === version);
  const date = heading && new Date(`${heading[2]}T00:00:00.000Z`);
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== heading[2]) {
    throw new Error('CHANGELOG.md must contain a valid dated heading for the release version');
  }
  return { version, dist_tag: isPrerelease ? 'next' : 'latest' };
}

function run({ cwd = process.cwd(), env = process.env } = {}) {
  const read = (file) => fs.readFileSync(path.join(cwd, file), 'utf8');
  const metadata = validateReleaseMetadata({
    manifest: JSON.parse(read('package.json')),
    lockfile: JSON.parse(read('package-lock.json')),
    changelog: read('CHANGELOG.md'),
    tag: env.RELEASE_TAG,
    prerelease: env.RELEASE_PRERELEASE,
  });
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  fs.appendFileSync(env.GITHUB_OUTPUT, `version=${metadata.version}\ndist_tag=${metadata.dist_tag}\n`);
  return metadata;
}

module.exports = { validateReleaseMetadata, run };

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Release metadata validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
