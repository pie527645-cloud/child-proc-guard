import { type ChildProcess, spawn } from 'node:child_process';

export function killDetachedDirectly(): void {
  // 1. detached: true + child.kill() leaves process group alive
  const child = spawn('node', ['worker.js'], { detached: true, stdio: 'ignore' });
  child.unref();
  child.kill('SIGTERM');
}

export function killPosixDetachedDirectly(): void {
  // 2. detached: process.platform !== 'win32' + child.kill() without process.kill(-pid)
  const child = spawn('node', ['daemon.js'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  child.kill('SIGKILL');
}

export class DetachedServiceBuggy {
  private proc?: ChildProcess;

  public start(): void {
    this.proc = spawn('node', ['agent.js'], { detached: true, stdio: 'ignore' });
  }

  public stop(): void {
    // 3. Class-stored detached handle terminated via this.proc.kill() only
    this.proc?.kill('SIGTERM');
  }
}
