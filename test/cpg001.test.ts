import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSourceFile, checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('CPG001 — missing timeout or AbortSignal on subprocess helpers', () => {
  it('flags all 8 untimed sync/async/promisified calls in cpg001-positive.ts', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'cpg001-positive.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.equal(report.findings.length, 8);
    assert.equal(report.summary.low, 8);
    for (const finding of report.findings) {
      assert.equal(finding.ruleId, 'CPG001');
      assert.equal(finding.severity, 'low');
    }
  });

  it('stays completely clean on timeout, signal, local const opts, and opaque options in cpg001-clean.ts', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'cpg001-clean.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.total, 0);
  });

  it('supports CommonJS require("child_process") and util.promisify tracking while respecting shadowing', () => {
    const cjsSource = [
      'const cp = require("node:child_process");',
      'const { promisify } = require("node:util");',
      'const execFileP = promisify(cp.execFile);',
      'async function bad() {',
      '  cp.execSync("git status");',
      '  await execFileP("git", ["status"]);',
      '}',
      'function shadowed(execSync) {',
      '  execSync("not child_process");',
      '}',
    ].join('\n');

    const findings = analyzeSourceFile({
      absolutePath: '/virtual/cjs-sample.cjs',
      displayPath: 'cjs-sample.cjs',
      content: cjsSource,
    });

    assert.equal(findings.length, 2);
    assert.equal(findings[0]?.ruleId, 'CPG001');
    assert.equal(findings[1]?.ruleId, 'CPG001');
  });

  it('never matches RegExp.exec(), db.exec(), redis.exec(), or custom helpers', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'non-child-process.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.deepEqual(report.findings, []);
  });
});
