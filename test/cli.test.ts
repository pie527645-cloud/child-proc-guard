import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import type { CheckReport, SarifLog } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');

interface CliExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeSubprocessCli(
  args: readonly string[],
  cwd: string = REPO_ROOT
): CliExecResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 15_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : 2,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? ''),
    };
  }
}

describe('CLI contract, thresholds, and exit codes (0 / 1 / 2)', () => {
  it('ensures dist/cli.js starts with LF #!/usr/bin/env node shebang and zero CRLF', () => {
    const raw = fs.readFileSync(CLI_PATH, 'utf8');
    assert.equal(raw.startsWith('#!/usr/bin/env node\n'), true);
    assert.equal(raw.includes('\r\n'), false);
  });

  it('handles --help and --version with exit code 0', () => {
    const out: string[] = [];
    const code = runCli(['--help'], {
      stdout: (m) => out.push(m),
      stderr: () => {},
    });
    assert.equal(code, 0);
    assert.ok(out.join('\n').includes('child-proc-guard check [target]'));

    const verRes = invokeSubprocessCli(['--version']);
    assert.equal(verRes.status, 0);
    assert.equal(verRes.stdout.trim(), '1.0.0');
  });

  it('returns 0 on self-check and enforces --fail-on and --include-tests accurately', () => {
    const selfRes = invokeSubprocessCli(['check', '.', '--format', 'json']);
    assert.equal(selfRes.status, 0);
    const selfReport = JSON.parse(selfRes.stdout) as CheckReport;
    assert.equal(selfReport.summary.total, 0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-cli-thresholds-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

      // CPG001 (low) in src/task.ts
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'task.ts'),
        [
          'import { execSync } from "node:child_process";',
          'export function run(): void {',
          '  execSync("git status");',
          '}',
        ].join('\n'),
        'utf8'
      );

      // CPG002 (medium) in test/bad.test.ts (excluded by default)
      fs.writeFileSync(
        path.join(tmpDir, 'test', 'bad.test.ts'),
        [
          'import { spawn } from "node:child_process";',
          'export function runTest(): void {',
          '  const child = spawn("git", ["log"]);',
          '  child.on("close", () => {});',
          '}',
        ].join('\n'),
        'utf8'
      );

      // Default --fail-on medium: 1 low finding -> exit code 0!
      const defaultRes = invokeSubprocessCli(['check', tmpDir, '--format', 'json']);
      assert.equal(defaultRes.status, 0);
      const defaultReport = JSON.parse(defaultRes.stdout) as CheckReport;
      assert.equal(defaultReport.summary.total, 1);
      assert.equal(defaultReport.summary.low, 1);

      // --fail-on low: 1 low finding >= low -> exit code 1!
      const lowFailRes = invokeSubprocessCli(['check', tmpDir, '--fail-on', 'low']);
      assert.equal(lowFailRes.status, 1);

      // --include-tests (default --fail-on medium): picks up CPG002 medium -> exit code 1!
      const incTestsRes = invokeSubprocessCli([
        'check',
        tmpDir,
        '--include-tests',
        '--format',
        'sarif',
      ]);
      assert.equal(incTestsRes.status, 1);
      const sarif = JSON.parse(incTestsRes.stdout) as SarifLog;
      assert.equal(sarif.runs[0].results.length, 2);

      // --include-tests --fail-on none -> always exit code 0!
      const noneRes = invokeSubprocessCli([
        'check',
        tmpDir,
        '--include-tests',
        '--fail-on=none',
      ]);
      assert.equal(noneRes.status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 on invalid arguments, missing targets, or SYMLINK_ESCAPE_BLOCKED', () => {
    assert.equal(invokeSubprocessCli([]).status, 2);
    assert.equal(invokeSubprocessCli(['invalid-cmd']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', '--bad-flag']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', '--format', 'yaml']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', '--fail-on', 'blocker']).status, 2);
    assert.equal(invokeSubprocessCli(['check', '.', 'second-target']).status, 2);
    assert.equal(invokeSubprocessCli(['check', './non-existent-path-98765']).status, 2);

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-cli-symroot-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-cli-symout-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'ext.ts'), 'export const x = 1;\n', 'utf8');
      fs.symlinkSync(
        outsideDir,
        path.join(rootDir, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );

      const symRes = invokeSubprocessCli(['check', rootDir]);
      assert.equal(symRes.status, 2);
      assert.ok(symRes.stderr.includes('SYMLINK_ESCAPE_BLOCKED'));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
