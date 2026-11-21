import * as cp from 'node:child_process';
import { exec, execFile, execFileSync, execSync, spawnSync } from 'child_process';
import * as util from 'node:util';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = util.promisify(cp.execFile);

export async function runUntimedCalls(): Promise<void> {
  // 1. exec without options
  exec('git status', (_err, _stdout) => {});

  // 2. execFile with args + callback, no options
  execFile('git', ['rev-parse', 'HEAD'], (_err, _stdout) => {});

  // 3. execFile with options object missing timeout and signal
  execFile('git', ['diff'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (_err, _stdout) => {});

  // 4. execSync without options
  execSync('git branch --show-current');

  // 5. execFileSync with local const opts missing timeout/signal
  const badLocalOpts = { encoding: 'utf8' as const, cwd: '/srv/app' };
  execFileSync('git', ['log', '-1'], badLocalOpts);

  // 6. spawnSync with timeout: 0 (disabled timeout)
  spawnSync('git', ['status', '--porcelain'], { timeout: 0 });

  // 7. promisified exec without options
  await execAsync('uname -a');

  // 8. promisified execFile with args only
  await execFileAsync('git', ['tag', '--list']);
}
