import type {
  FailOnThreshold,
  Finding,
  RuleId,
  RuleMetadata,
  Severity,
  SeveritySummary,
} from './types.js';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const RULES: readonly RuleMetadata[] = [
  {
    id: 'CPG001',
    name: 'missing-subprocess-timeout-or-signal',
    defaultSeverity: 'low',
    shortDescription:
      'Subprocess helper called without an explicit timeout or AbortSignal.',
    fullDescription:
      'Detects exec, execFile, execSync, execFileSync, spawnSync, and promisified exec/execFile invocations that omit both a positive timeout option and an AbortSignal signal option, risking unbounded worker or event-loop hangs.',
    helpText:
      'Pass a positive timeout (for example { timeout: 10000 }) or an AbortSignal (for example { signal: AbortSignal.timeout(10000) }) in the options object.',
  },
  {
    id: 'CPG002',
    name: 'unread-piped-stdio-deadlock',
    defaultSeverity: 'medium',
    shortDescription:
      'Piped spawn stdout/stderr left unread while awaiting close or exit.',
    fullDescription:
      'Detects spawn calls with piped stdout and/or stderr where the piped stream is never consumed in scope while the caller waits on close or exit, which deadlocks once the child fills the OS pipe buffer.',
    helpText:
      'Read or drain piped streams (via data listeners, pipe, pipeline, readline, for-await, or resume), or configure stdio as ignore or inherit for unused output streams.',
  },
  {
    id: 'CPG003',
    name: 'detached-child-kill-orphans-group',
    defaultSeverity: 'medium',
    shortDescription:
      'Detached child process terminated via child.kill() without group or tree termination.',
    fullDescription:
      'Detects detached spawn handles killed via child.kill() without process.kill(-pid) on POSIX or tree-kill, leaving grandchild processes orphaned in the detached process group.',
    helpText:
      'On POSIX, signal the negative process group ID via process.kill(-child.pid, signal); on Windows or cross-platform code, use tree-kill or guard win32 vs POSIX group termination.',
  },
];

export const RULE_MAP: ReadonlyMap<RuleId, RuleMetadata> = new Map(
  RULES.map((rule) => [rule.id, rule])
);

export function summarizeFindings(findings: readonly Finding[]): SeveritySummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let info = 0;

  for (const finding of findings) {
    switch (finding.severity) {
      case 'high':
        high += 1;
        break;
      case 'medium':
        medium += 1;
        break;
      case 'low':
        low += 1;
        break;
      case 'info':
        info += 1;
        break;
    }
  }

  return {
    total: findings.length,
    high,
    medium,
    low,
    info,
  };
}

export function exceedsFailOnThreshold(
  findings: readonly Finding[],
  failOn: FailOnThreshold
): boolean {
  if (failOn === 'none') {
    return false;
  }
  const minRank = SEVERITY_RANK[failOn];
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= minRank);
}
