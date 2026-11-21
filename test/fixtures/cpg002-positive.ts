import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function deadlockDefaultStdio(): Promise<number | null> {
  // 1. Default piped stdout & stderr, neither read, waiting on close
  const child = spawn('git', ['log', '-p']);
  return await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
}

export async function deadlockExplicitPipeEventsOnce(): Promise<void> {
  // 2. Explicit stdio: 'pipe', unread streams, waiting via events.once(child, 'exit')
  const child = spawn('git', ['diff'], { stdio: 'pipe' });
  await once(child, 'exit');
}

export async function deadlockStderrLeftPipedAndUnread(): Promise<string> {
  // 3. stdout is read, but stderr remains piped by default and is never read while waiting on close
  const child = spawn('git', ['log']);
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(child, 'close');
  return Buffer.concat(chunks).toString('utf8');
}
