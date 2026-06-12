/** One-shot cleanup of pre-multi-device singletons. Liveness-checked so a
 * still-running old daemon/stay-awake is never orphaned. */
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function isAliveDefault(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function cleanupLegacyArtifacts(isAlive: (pid: number) => boolean = isAliveDefault): void {
  const legacyDaemon = join(homedir(), '.local', 'share', 'quest-dev', 'daemon.json');
  const legacyPid = join(homedir(), '.quest-dev-stay-awake.pid');
  for (const path of [legacyDaemon, legacyPid]) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      const pid = path.endsWith('.json') ? JSON.parse(raw).pid : parseInt(raw, 10);
      if (Number.isFinite(pid) && isAlive(pid)) continue; // still running — leave it
    } catch { /* unparseable — safe to remove */ }
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}
