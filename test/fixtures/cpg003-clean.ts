import { type ChildProcess, spawn } from 'node:child_process';
import treeKill from 'tree-kill';

export function killDetachedProcessGroupPosix(): void {
  const child = spawn('node', ['worker.js'], { detached: true, stdio: 'ignore' });
  if (child.pid !== undefined) {
    process.kill(-child.pid, 'SIGTERM');
  }
}

export function killDetachedCrossPlatformBranch(): void {
  const child = spawn('node', ['daemon.js'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  if (process.platform === 'win32') {
    child.kill('SIGTERM');
  } else if (child.pid !== undefined) {
    process.kill(-child.pid, 'SIGTERM');
  }
}

export function killDetachedWithTreeKill(): void {
  const child = spawn('node', ['service.js'], { detached: true, stdio: 'ignore' });
  if (child.pid !== undefined) {
    treeKill(child.pid, 'SIGTERM');
  } else {
    child.kill('SIGTERM');
  }
}

export class DetachedServiceClean {
  private proc?: ChildProcess;

  public start(): void {
    this.proc = spawn('node', ['agent.js'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
  }

  public stop(): void {
    if (!this.proc) {
      return;
    }
    if (process.platform === 'win32') {
      this.proc.kill('SIGTERM');
    } else if (this.proc.pid !== undefined) {
      const pgid = -this.proc.pid;
      process.kill(pgid, 'SIGTERM');
    }
  }
}
