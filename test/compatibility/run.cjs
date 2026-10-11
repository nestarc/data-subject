/* Installs the packed library into a fresh consumer, never imports src/. */
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const matrix = ['nest10-prisma5', 'nest11-prisma7'];
const selected = process.argv[2] ? [process.argv[2]] : matrix;
if (selected.some((name) => !matrix.includes(name))) throw new Error('Unknown compatibility profile');
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'data-subject-compat-'));
const env = { ...process.env, npm_config_cache: process.env.npm_config_cache || path.join(os.tmpdir(), 'data-subject-npm-cache') };
function run(command, args, cwd = root, extraEnv = {}) {
  execFileSync(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: 'inherit' });
}
try {
  run('npm', ['run', 'build']);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', workspace], { cwd: root, env, encoding: 'utf8' }));
  const tarball = path.join(workspace, packed[0].filename);
  for (const name of selected) {
    const cwd = path.join(workspace, name);
    fs.mkdirSync(cwd);
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(__dirname, name, file), path.join(cwd, file));
    const schemaName = `ds_${name.replaceAll('-', '_')}_${randomUUID().replaceAll('-', '')}`;
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.searchParams.set('schema', schemaName);
    const fixtureEnv = { DATABASE_URL: databaseUrl.toString() };
    const modern = name === 'nest11-prisma7';
    const generator = modern
      ? 'generator client {\n  provider = "prisma-client"\n  output = "./generated/client"\n  moduleFormat = "cjs"\n}\n'
      : 'generator client {\n  provider = "prisma-client-js"\n}\n';
    const datasource = `datasource db {\n  provider = "postgresql"\n${modern ? '' : '  url = env("DATABASE_URL")\n'}}\n`;
    fs.writeFileSync(path.join(cwd, 'schema.prisma'), generator + datasource + fs.readFileSync(path.join(__dirname, 'models.prisma'), 'utf8'));
    if (modern) fs.writeFileSync(path.join(cwd, 'prisma.config.ts'), 'import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "schema.prisma", datasource: { url: process.env.DATABASE_URL! } });\n');
    fs.writeFileSync(path.join(cwd, 'client.ts'), modern
      ? 'import { PrismaClient } from "./generated/client/client";\nimport { PrismaPg } from "@prisma/adapter-pg";\nconst connectionString = process.env.DATABASE_URL!;\nexport const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: new URL(connectionString).searchParams.get("schema")! }) });\n'
      : 'import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();\n');
    for (const file of ['smoke', 'p1', 'p2']) fs.copyFileSync(path.join(__dirname, `${file}.ts.in`), path.join(cwd, `${file}.ts`));
    fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', esModuleInterop: true, strict: true, skipLibCheck: true, outDir: 'build', experimentalDecorators: true, emitDecoratorMetadata: true }, include: ['smoke.ts', 'p1.ts', 'p2.ts', 'client.ts', 'generated/**/*.ts'] }));
    console.log(`\nChecking ${name} from ${packed[0].filename}`);
    run('npm', ['ci', '--no-audit', '--no-fund'], cwd, fixtureEnv);
    run('npm', ['install', '--save=false', '--package-lock=false', '--strict-peer-deps', '--no-audit', '--no-fund', tarball], cwd, fixtureEnv);
    const prisma = path.join(cwd, 'node_modules/.bin/prisma');
    run(prisma, ['generate'], cwd, fixtureEnv);
    try {
      run(prisma, ['db', 'push'], cwd, fixtureEnv);
      // Exercise the shipped P1 migration against an existing request table,
      // including its partial expiry index, inside this fixture's empty schema.
      const migration = fs.readFileSync(path.join(cwd, 'node_modules/@nestarc/data-subject/prisma/p1-durable-execution.sql'), 'utf8');
      execFileSync(prisma, ['db', 'execute', '--stdin'], {
        cwd,
        env: { ...env, ...fixtureEnv },
        input: `DROP TABLE "${schemaName}"."DataSubjectExecution";\nSET search_path TO "${schemaName}";\n${migration}`,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      const jobsMigration = fs.readFileSync(path.join(cwd, 'node_modules/@nestarc/data-subject/prisma/p2-jobs.sql'), 'utf8');
      execFileSync(prisma, ['db', 'execute', '--stdin'], {
        cwd,
        env: { ...env, ...fixtureEnv },
        input: `SET search_path TO "${schemaName}";\n${jobsMigration}`,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      run(path.join(cwd, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], cwd, fixtureEnv);
      run(process.execPath, ['build/smoke.js'], cwd, fixtureEnv);
    } finally {
      execFileSync(prisma, ['db', 'execute', '--stdin'], {
        cwd,
        env: { ...env, ...fixtureEnv },
        input: `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
    }
  }
} finally {
  if (process.env.KEEP_COMPATIBILITY_WORKSPACE) console.log(`Compatibility workspace retained: ${workspace}`);
  else fs.rmSync(workspace, { recursive: true, force: true });
}
