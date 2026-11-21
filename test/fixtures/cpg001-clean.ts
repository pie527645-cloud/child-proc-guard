import * as cp from 'node:child_process';
import {
  exec,
  execFile,
  type ExecFileOptions,
  execFileSync,
  execSync,
  spawnSync,
} from 'node:child_process';
import * as util from 'node:util';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = util.promisify(cp.execFile);

const SHARED_OPTS = {
  timeout: 5_000,
  encoding: 'utf8' as const,
};

export async function runTimedAndSignaledCalls(
  callerOptions: ExecFileOptions,
  abortController: AbortController
): Promise<void> {
  // 1. exec with timeout
  exec('git status', { timeout: 3_000 }, (_err, _stdout) => {});

  // 2. execFile 3-arg overload (file, opts, cb) with AbortSignal
  execFile('git', { signal: abortController.signal }, (_err, _stdout) => {});

  // 3. execFile 4-arg overload (file, args, opts, cb) with local const opts
  execFile('git', ['rev-parse', 'HEAD'], SHARED_OPTS, (_err, _stdout) => {});

  // 4. execSync with positive timeout
  execSync('git status --short', { timeout: 10_000 });

  // 5. execFileSync with local const opts spread
  const syncOpts = { ...SHARED_OPTS, maxBuffer: 2 * 1024 * 1024 };
  execFileSync('git', ['diff', '--stat'], syncOpts);

  // 6. spawnSync with AbortSignal.timeout
  spawnSync('git', ['log', '-1'], { signal: AbortSignal.timeout(4_000) });

  // 7. promisified exec with timeout
  await execAsync('uname -s', { timeout: 2_000 });

  // 8. promisified execFile with signal
  await execFileAsync('git', ['describe', '--tags'], { signal: abortController.signal });

  // 9. Opaque caller options passed directly must NOT false-positive
  execFile('git', ['status'], callerOptions, (_err, _stdout) => {});
}
