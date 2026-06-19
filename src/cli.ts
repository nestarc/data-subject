#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  formatLintReport,
  lintPrismaSchema,
  shouldFailLint,
  type DataSubjectLintConfig,
  type DataSubjectLintSeverity,
} from './lint';

const nodeRequire = createRequire(__filename);

interface CliOptions {
  command?: string;
  schema?: string;
  config?: string;
  format: 'text' | 'json';
  failOn: DataSubjectLintSeverity;
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.command !== 'lint') {
    printHelp();
    process.exitCode = opts.command ? 1 : 0;
    return;
  }

  if (!opts.schema) {
    throw new Error('data-subject lint requires --schema');
  }

  const schemaSource = readFileSync(resolve(opts.schema), 'utf8');
  const config = await loadConfig(opts.config);
  const report = lintPrismaSchema(schemaSource, config);

  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLintReport(report));
  }

  if (shouldFailLint(report, opts.failOn)) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: argv[0],
    format: 'text',
    failOn: 'error',
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--schema') {
      opts.schema = requireValue(arg, next);
      index += 1;
      continue;
    }
    if (arg === '--config') {
      opts.config = requireValue(arg, next);
      index += 1;
      continue;
    }
    if (arg === '--format') {
      const value = requireValue(arg, next);
      if (value !== 'text' && value !== 'json') {
        throw new Error('--format must be text or json');
      }
      opts.format = value;
      index += 1;
      continue;
    }
    if (arg === '--fail-on') {
      const value = requireValue(arg, next);
      if (value !== 'warning' && value !== 'error') {
        throw new Error('--fail-on must be warning or error');
      }
      opts.failOn = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.command = undefined;
      return opts;
    }

    throw new Error(`unknown option: ${arg}`);
  }

  return opts;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function loadConfig(
  configPath: string | undefined,
): Promise<DataSubjectLintConfig> {
  if (!configPath) {
    return {};
  }

  const fullPath = resolve(configPath);
  const ext = extname(fullPath);

  if (ext === '.json') {
    return JSON.parse(readFileSync(fullPath, 'utf8')) as DataSubjectLintConfig;
  }

  if (ext === '.mjs') {
    const mod = (await import(pathToFileURL(fullPath).href)) as {
      default?: DataSubjectLintConfig;
    };
    return mod.default ?? {};
  }

  if (ext === '.js' || ext === '.cjs') {
    const loaded = nodeRequire(fullPath) as unknown;
    if (isConfigModule(loaded)) {
      return loaded.default ?? {};
    }
    return loaded as DataSubjectLintConfig;
  }

  throw new Error(
    'data-subject lint supports .json, .js, .cjs, and .mjs config files',
  );
}

function isConfigModule(
  value: unknown,
): value is { default?: DataSubjectLintConfig } {
  return typeof value === 'object' && value !== null && 'default' in value;
}

function printHelp(): void {
  console.log(`Usage:
  data-subject lint --schema prisma/schema.prisma [--config data-subject.config.json]

Options:
  --schema <path>       Prisma schema path
  --config <path>       Optional lint config (.json, .js, .cjs, .mjs)
  --format <text|json>  Output format, defaults to text
  --fail-on <level>     warning or error, defaults to error`);
}
