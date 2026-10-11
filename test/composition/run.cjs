/* Fresh, locked consumer of published integrations and the local npm tarball. */
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database with CREATE ROLE permission');
if (process.env.npm_config_force === 'true' || process.env.npm_config_legacy_peer_deps === 'true')
  throw new Error('Peer dependency bypass is not supported');
const root = path.resolve(__dirname, '../..');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'data-subject-composition-'));
const schemaName = `ds_composition_${randomUUID().replaceAll('-', '')}`;
const env = { ...process.env, COMPOSITION_SCHEMA: schemaName,
  npm_config_cache: process.env.npm_config_cache || path.join(os.tmpdir(), 'data-subject-npm-cache') };
function run(command, args, dir = cwd) {
  execFileSync(command, args, { cwd: dir, env, stdio: 'inherit' });
}
try {
  run('npm', ['run', 'build'], root);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', cwd], { cwd: root, env, encoding: 'utf8' }));
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(__dirname, file), path.join(cwd, file));
  fs.copyFileSync(path.join(__dirname, 'smoke.ts.in'), path.join(cwd, 'smoke.ts'));
  fs.copyFileSync(path.join(root, 'examples/nestarc-composition/composition.ts'), path.join(cwd, 'composition.ts'));
  fs.copyFileSync(path.join(root, 'examples/nestarc-composition/delivery-receipts.sql'), path.join(cwd, 'delivery-receipts.sql'));
  fs.writeFileSync(path.join(cwd, 'schema.prisma'),
    'generator client {\n provider = "prisma-client"\n output = "./generated/client"\n moduleFormat = "cjs"\n}\n' +
    'datasource db {\n provider = "postgresql"\n}\n' +
    fs.readFileSync(path.join(__dirname, '../compatibility/models.prisma'), 'utf8'));
  const databaseUrl = new URL(env.DATABASE_URL);
  databaseUrl.searchParams.set('schema', schemaName);
  env.DATABASE_URL = databaseUrl.toString();
  fs.writeFileSync(path.join(cwd, 'prisma.config.ts'), 'import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "schema.prisma", datasource: { url: process.env.DATABASE_URL! } });\n');
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', esModuleInterop: true,
    strict: true, skipLibCheck: false, outDir: 'build', experimentalDecorators: true, emitDecoratorMetadata: true,
  }, include: ['smoke.ts', 'composition.ts', 'generated/**/*.ts'] }));
  run('npm', ['ci', '--strict-peer-deps', '--no-audit', '--no-fund']);
  run('npm', ['install', '--save=false', '--package-lock=false', '--strict-peer-deps', '--no-audit', '--no-fund', path.join(cwd, packed[0].filename)]);
  const prisma = path.join(cwd, 'node_modules/.bin/prisma');
  run(prisma, ['generate']);
  try {
    run(prisma, ['db', 'push']);
    run(path.join(cwd, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json']);
    run(process.execPath, ['build/smoke.js']);
  } finally {
    execFileSync(prisma, ['db', 'execute', '--stdin'], {
      cwd, env, input: `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`, stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
} finally {
  if (process.env.KEEP_COMPOSITION_WORKSPACE) console.log(`Composition workspace retained: ${cwd}`);
  else fs.rmSync(cwd, { recursive: true, force: true });
}
