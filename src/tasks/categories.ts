/**
 * Risk categories of a Claude Code tool call. Shared by the server (tests,
 * display) and the worker's PreToolUse hook: a call whose categories intersect
 * policy.approvalActions waits for the owner.
 *
 * The matchers are deliberately broad: a false positive costs one tap, a false
 * negative lets a push or a deploy through unseen.
 */
export type Category = 'push' | 'deploy' | 'delete' | 'prod';

export const CATEGORIES: readonly Category[] = ['push', 'deploy', 'delete', 'prod'];

const PUSH = [/\bgit\s+push\b/i, /\bgh\s+pr\s+(create|merge)\b/i, /\bgh\s+release\b/i];

const DEPLOY = [
  /\b(deploy|vercel|netlify|fly|kubectl|helm|terraform\s+apply|docker\s+(push|compose\s+up))\b/i,
  /(^|[\s/.;&|(])deploy\//i,
];

const DELETE = [
  /\brm\s+-[a-zA-Z]*[rf]/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)/,
  /\bdrop\s+(table|database)\b/i,
];

const PROD = [/\bprod\b/i, /\b(ssh|scp)\s/];

/** Categories of one tool call; empty = no approval needed. */
export function categorize(tool: string, input: unknown): Category[] {
  const out: Category[] = [];
  const command = tool === 'Bash' ? bashCommand(input) : '';
  if (tool === 'Bash') {
    if (PUSH.some((r) => r.test(command))) out.push('push');
    if (DEPLOY.some((r) => r.test(command))) out.push('deploy');
    if (DELETE.some((r) => r.test(command))) out.push('delete');
  }
  const all = `${stringify(input)}\n${command}`;
  if (PROD.some((r) => r.test(all))) out.push('prod');
  return out;
}

function bashCommand(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return (input as { command: string }).command;
  }
  return '';
}

function stringify(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}
