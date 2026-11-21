import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export async function runGitCommand(
  args: readonly string[],
  timeoutMs = 10_000
): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync('git', [...args], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
}
