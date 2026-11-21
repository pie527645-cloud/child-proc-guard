import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSourceFile, checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('CPG003 — detached spawn killed with child.kill() without group/tree kill', () => {
  it('flags detached: true and POSIX-detached handles killed only with child.kill() in cpg003-positive.ts', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'cpg003-positive.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.equal(report.findings.length, 3);
    assert.equal(report.summary.medium, 3);
    for (const finding of report.findings) {
      assert.equal(finding.ruleId, 'CPG003');
      assert.equal(finding.severity, 'medium');
    }
  });

  it('stays clean when process.kill(-pid), win32/POSIX branch, or tree-kill is used in cpg003-clean.ts', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'cpg003-clean.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.deepEqual(report.findings, []);
  });

  it('isolates scope so a clean function in the same file does not mask a buggy function', () => {
    const mixedSource = [
      'import { spawn } from "node:child_process";',
      '',
      'export function buggyKill(): void {',
      '  const a = spawn("node", ["a.js"], { detached: true, stdio: "ignore" });',
      '  a.kill("SIGTERM");',
      '}',
      '',
      'export function properKill(): void {',
      '  const b = spawn("node", ["b.js"], { detached: true, stdio: "ignore" });',
      '  if (process.platform === "win32") {',
      '    b.kill("SIGTERM");',
      '  } else if (b.pid) {',
      '    process.kill(-b.pid, "SIGTERM");',
      '  }',
      '}',
    ].join('\n');

    const findings = analyzeSourceFile({
      absolutePath: '/virtual/mixed.ts',
      displayPath: 'mixed.ts',
      content: mixedSource,
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'CPG003');
    assert.equal(findings[0]?.line, 5);
  });
});
