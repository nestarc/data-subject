import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('compiled lint CLI config loading', () => {
  let workspace: string;
  let cli: string;
  let schema: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'data-subject-cli #'));
    const output = join(workspace, 'compiled');
    execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'), '-p', resolve('tsconfig.build.json'),
      '--outDir', output,
    ], { cwd: resolve('.'), stdio: 'pipe' });
    cli = join(output, 'cli.js');
    schema = join(workspace, 'schema.prisma');
    writeFileSync(schema, 'model Customer {\n id String @id\n email String\n}\n');
  }, 30_000);

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test.each([
    ['.mjs', 'const reason = await Promise.resolve("Reviewed outside scope"); export default { suppressions: [{ model: "Customer", reason }] };'],
    ['.cjs', 'module.exports = { suppressions: [{ model: "Customer", reason: "Reviewed outside scope" }] };'],
    ['.json', '{"suppressions":[{"model":"Customer","reason":"Reviewed outside scope"}]}'],
  ])('loads %s config from a path containing spaces and URL-reserved characters', (extension, source) => {
    const config = join(workspace, `policy #file${extension}`);
    writeFileSync(config, source);
    const result = spawnSync(process.execPath, [
      cli, 'lint', '--schema', schema, '--config', config, '--format', 'json',
    ], { cwd: workspace, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, findings: [] });
  });
});
