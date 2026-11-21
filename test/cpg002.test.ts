import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSourceFile, checkProject } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('CPG002 — unread piped spawn stdout/stderr while waiting on close/exit', () => {
  it('flags unread default piped stdio, explicit pipe + events.once, and unread stderr in cpg002-positive.ts', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'cpg002-positive.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.equal(report.findings.length, 3);
    assert.equal(report.summary.medium, 3);
    assert.ok(report.findings[0]?.message.includes('stdout and stderr'));
    assert.ok(report.findings[1]?.message.includes('stdout and stderr'));
    assert.ok(report.findings[2]?.message.includes('stderr'));
  });

  it('stays clean on ignore/inherit, .on("data"), .resume(), readline, for-await, and escaped child handles', () => {
    const report = checkProject({
      target: path.join(FIXTURES_DIR, 'cpg002-clean.ts'),
    });

    assert.equal(report.scannedFiles, 1);
    assert.deepEqual(report.findings, []);
  });

  it('handles stdio array holes/null/undefined vs stream helper & pipeline consumption and object/array escapes', () => {
    const snippet = [
      'import { spawn } from "node:child_process";',
      'import { pipeline } from "node:stream/promises";',
      'import { Writable } from "node:stream";',
      '',
      'export function arrayHoleUnread(): void {',
      '  const c = spawn("git", ["log"], { stdio: ["ignore", null, "ignore"] });',
      '  c.on("exit", () => {});',
      '}',
      '',
      'export async function consumedViaPipeline(sink: Writable): Promise<void> {',
      '  const c = spawn("git", ["log"], { stdio: ["ignore", "pipe", "ignore"] });',
      '  await pipeline(c.stdout, sink);',
      '  c.on("close", () => {});',
      '}',
      '',
      'export function escapedInReturnedObject() {',
      '  const child = spawn("git", ["log"]);',
      '  child.on("close", () => {});',
      '  return { child };',
      '}',
    ].join('\n');

    const findings = analyzeSourceFile({
      absolutePath: '/virtual/stdio-cases.ts',
      displayPath: 'stdio-cases.ts',
      content: snippet,
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'CPG002');
    assert.ok(findings[0]?.message.includes('stdout'));
  });
});
