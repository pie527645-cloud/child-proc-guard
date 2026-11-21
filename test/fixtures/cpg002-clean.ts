import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as readline from 'node:readline';

export async function cleanStdioIgnore(): Promise<void> {
  const child = spawn('git', ['gc'], { stdio: 'ignore' });
  await once(child, 'close');
}

export async function cleanStdioInherit(): Promise<void> {
  const child = spawn('git', ['status'], { stdio: 'inherit' });
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
}

export async function cleanStdioArrayIgnoreInherit(): Promise<void> {
  const child = spawn('git', ['fetch'], { stdio: ['ignore', 'inherit', 'inherit'] });
  await once(child, 'close');
}

export async function cleanDataAndResume(): Promise<string> {
  const child = spawn('git', ['log', '-5']);
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.resume();
  await once(child, 'close');
  return out;
}

export async function cleanReadlineInterface(): Promise<string[]> {
  const child = spawn('git', ['branch'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: child.stdout });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }
  await once(child, 'close');
  return lines;
}

export async function cleanForAwaitStream(): Promise<number> {
  const child = spawn('git', ['tag'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let bytes = 0;
  for await (const chunk of child.stdout) {
    bytes += (chunk as Buffer).length;
  }
  await once(child, 'close');
  return bytes;
}

export function cleanEscapeReturnedChild(): ChildProcess {
  const child = spawn('git', ['log']);
  child.on('close', () => {});
  return child;
}

export class CleanEscapedClassHolder {
  private child?: ChildProcess;

  public start(): void {
    const proc = spawn('git', ['log']);
    proc.on('exit', () => {});
    this.child = proc;
  }

  public getHandle(): ChildProcess | undefined {
    return this.child;
  }
}

function attachExternalConsumer(_proc: ChildProcess): void {}

export async function cleanEscapePassedToHelper(): Promise<void> {
  const child = spawn('git', ['log']);
  attachExternalConsumer(child);
  await once(child, 'close');
}
