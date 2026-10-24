import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<ExecResult>;

const MAX_OUTPUT = 256 * 1024;

/** Spawns without a shell; argv is never interpolated. Output is capped. */
export const spawnExec: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += String(chunk); });
    child.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });

export function scrub(text: string, secrets: Array<string | null | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) result = result.split(secret).join("***");
  }
  return result;
}
