import { type ChildProcess, execFileSync, spawn } from 'node:child_process';

export class BackgroundWorkerManager {
  private worker?: ChildProcess;

  public start(scriptPath: string): void {
    const child = spawn(process.execPath, [scriptPath], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    child.unref();
    this.worker = child;
  }

  public stop(): void {
    const proc = this.worker;
    if (!proc || proc.pid === undefined) {
      return;
    }
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
    this.worker = undefined;
  }
}
