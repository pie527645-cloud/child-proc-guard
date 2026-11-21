# @pie527645-cloud/child-proc-guard

Static TypeScript and JavaScript AST auditor for Node.js `child_process` reliability hazards: missing subprocess timeouts/cancellation signals, piped `stdout`/`stderr` buffer deadlocks, and orphaned detached process groups.

`child-proc-guard` parses TypeScript and JavaScript sources directly with the TypeScript Compiler API (`0` runtime subprocess spawning) and tracks imports and aliases strictly from `'child_process'` / `'node:child_process'` and `util.promisify(...)` — never false-positiving on `RegExp.prototype.exec()`, database `.exec()`, or unrelated methods.

## Installation & Build

Requires **Node.js `>=20.18.1`**.

```bash
npm install @pie527645-cloud/child-proc-guard
```

From source:

```bash
npm install
npm run lint
npm run build
npm test
```

## CLI Usage

```bash
child-proc-guard check [target] [--format text|json|sarif] [--fail-on high|medium|low|info|none] [--include-tests]
```

### CLI Flags

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | `.` | File or directory to scan |
| `--format <text\|json\|sarif>` | `text` | Output report format (`sarif` emits SARIF v2.1.0) |
| `--fail-on <high\|medium\|low\|info\|none>` | `medium` | Minimum severity that causes exit code `1` (`none` always exits `0`) |
| `--include-tests` | `false` | Scan `test/`, `tests/`, `__tests__/`, `*.test.*`, and `*.spec.*` |
| `-h, --help` | — | Print CLI usage help |
| `-v, --version` | — | Print package version |

### Exit Codes

| Exit Code | Condition |
| --- | --- |
| `0` | Clean scan, `--fail-on none`, or all findings strictly below `--fail-on` |
| `1` | At least one finding at or above `--fail-on` |
| `2` | Invalid CLI arguments, missing target path, or blocked symlink/path traversal (`SYMLINK_ESCAPE_BLOCKED`) |

## Programmatic API

```ts
import { checkProject, formatSarif } from '@pie527645-cloud/child-proc-guard';

const report = checkProject({
  target: './src',
  failOn: 'low',
  includeTests: false,
});

if (report.summary.total > 0) {
  console.log(formatSarif(report));
}
```

## Rules (v1)

| Rule ID | Severity | Summary | Clean When |
| --- | --- | --- | --- |
| `CPG001` | `low` | `exec`, `execFile`, `execSync`, `execFileSync`, `spawnSync`, or promisified `exec`/`execFile` called without a `timeout` or `AbortSignal` `signal` option | Positive `timeout` (`timeout > 0`), `signal` (`AbortSignal`), or opaque caller options object passed |
| `CPG002` | `medium` | `spawn(...)` with piped `stdout` and/or `stderr` left unread in scope while waiting on `'close'` or `'exit'`, risking a 64 KiB OS pipe buffer deadlock | `stdio` is `'ignore'`/`'inherit'` (or `'ignore'`/`'inherit'` on that stream), stream is consumed (`.on('data')`, `.pipe()`, `pipeline()`, `for await`, `.resume()`, `readline.createInterface`, or helper pass), or `child` handle escapes scope |
| `CPG003` | `medium` | `spawn(..., { detached: true })` (or `detached: process.platform !== 'win32'`) terminated via `child.kill()` without group or process-tree termination | `process.kill(-child.pid, ...)` / `process.kill(-pid, ...)` or `tree-kill` is used in scope (including cross-platform `win32` / POSIX branches) |

## `CPG003`: `win32` vs POSIX Behavior Difference

Node.js `detached: true` and `process.kill(-pid)` behave fundamentally differently on POSIX versus Windows (`win32`):

- **POSIX (`linux`, `darwin`, BSD):** `spawn(..., { detached: true })` calls `setsid(2)`, making the child the leader of a new process group (`pgid === child.pid`). Calling `child.kill('SIGTERM')` signals **only** the direct child PID, leaving any grandchildren it spawned running as orphans. Passing a **negative PID** to `process.kill(-child.pid, 'SIGTERM')` signals the entire process group.
- **Windows (`win32`):** Windows has no POSIX process-group negation semantics. Calling `process.kill(-child.pid, 'SIGTERM')` on Windows **does not kill a process tree** — Node.js rejects negative PIDs on `win32` and throws `EINVAL` or `ESRCH`. On Windows, terminating an entire subprocess tree requires `taskkill /PID <pid> /T /F` or a cross-platform library such as `tree-kill`.

Cross-platform pattern recognized as clean by `CPG003`:

```ts
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['worker.js'], {
  detached: process.platform !== 'win32',
  stdio: 'ignore',
});

export function stopWorker(): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    child.kill('SIGTERM'); // or execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 })
  } else {
    process.kill(-child.pid, 'SIGTERM');
  }
}
```

## Prior Art

`child-proc-guard` focuses strictly on statically decidable `child_process` lifecycle, pipe backpressure, and process-group hazards that complement existing linters without duplicating their rules:

- **Bun `no-unhandled-emitter-errors`:** Missing `'error'` listeners on `EventEmitter` instances (including `ChildProcess` returned by `spawn`) are already covered by general EventEmitter error-handling analyzers such as Bun's `no-unhandled-emitter-errors` rule, and frequently produce false positives when handles wrap into promises or helper abstractions; missing `spawn` `'error'` listeners are intentionally excluded from v1.
- **`eslint-plugin-runtime-cleanup`:** Unawaited or floating subprocess/timer handles in general async control flow overlap with resource/handle cleanup linters such as `eslint-plugin-runtime-cleanup`, whereas `child-proc-guard` specifically targets concrete `child_process` deadlocks (`CPG002`), unbounded blocking/execution (`CPG001`), and orphaned detached process groups (`CPG003`); generic floating handle tracking is excluded.
- **`eslint-plugin-security` (`detect-child-process`):** `eslint-plugin-security`'s `detect-child-process` rule focuses exclusively on command-injection sinks (`exec` with non-literal strings or shell invocation) rather than operational reliability, timeout enforcement, stdio pipe deadlocks, or detached process-tree cleanup.

## License

MIT
