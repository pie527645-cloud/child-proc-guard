import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as readline from 'node:readline';

export async function streamLogLines(
  repoDir: string,
  signal: AbortSignal
): Promise<readonly string[]> {
  const child = spawn('git', ['log', '--oneline', '-20'], {
    cwd: repoDir,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const rl = readline.createInterface({ input: child.stdout });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }

  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) {
    const errMsg = Buffer.concat(stderrChunks).toString('utf8').trim();
    throw new Error(`git log exited with ${String(code)}: ${errMsg}`);
  }
  return lines;
}
