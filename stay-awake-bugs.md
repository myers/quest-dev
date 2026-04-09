# stay-awake bugs

## Bug 1: Plugin hooks not loaded by Claude Code

**Symptom:** Stay-awake exits after idle timeout (default 5 min) even during active Claude Code sessions.

**Root cause:** The PostToolUse hook in `hooks/hooks.json` is never executed by Claude Code. The SIGUSR1 signal that resets the idle timer never fires, so the idle timer always expires.

**Evidence:**
- Stay-awake output shows no "Activity detected, resetting idle timer" messages between startup and "Idle timeout reached, exiting..."
- Running the hook script manually (`bash hooks/scripts/send-stay-awake-signal.sh`) works — the signal is received and the timer resets
- Sending `kill -USR1 $(cat ~/.quest-dev-stay-awake.pid)` directly works
- The plugin's `hooks.json` is properly formatted but Claude Code doesn't load it

**Workaround:** Add the hook directly to the project's `.claude/projects/.../settings.json`:
```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "/path/to/quest-dev/hooks/scripts/send-stay-awake-signal.sh"
    }
  ]
}
```

**Fix options:**
- Investigate why Claude Code doesn't load plugin hooks (may be a Claude Code bug, not quest-dev)
- Document the manual hook setup as a required step in the README

## Bug 2: Cascading timeout corruption

**Symptom:** After stay-awake exits, Quest screen_off_timeout is set to 15000ms (15s) instead of the real default (300000ms / 5 min). Quest goes to sleep almost immediately.

**Root cause:** Stay-awake captures `screen_off_timeout` at startup as "original" and restores it on exit. If a previous stay-awake crashed or its watchdog failed to restore properly, the timeout may already be corrupted. The next stay-awake then captures the corrupted value as "original" and the bad value propagates.

**Sequence:**
1. Stay-awake A starts, saves original=300000, sets to 86400000
2. Stay-awake A dies abnormally — watchdog fails to restore (adb not on PATH, etc.)
3. Stay-awake B starts later after something sets timeout to 15000 (or watchdog partially ran)
4. Stay-awake B saves original=15000, sets to 86400000
5. Stay-awake B exits normally, restores to 15000
6. Quest sleeps in 15 seconds

**Evidence:**
```
Original screen timeout: 15000ms (15s)   <-- should be 300000
...
Restoring original settings...
Screen timeout restored to 15000ms (15s)  <-- restores to bad value
```

**Fix options:**
- Clamp original to a sane minimum: `originalTimeout = Math.max(originalTimeout, 60000)`
- Store the pre-stay-awake timeout in a separate file (e.g., `~/.quest-dev-original-timeout`) and only overwrite it if the current timeout isn't 86400000 (i.e., don't save a value that was set by a previous stay-awake)
- Add a `--restore-default` command to manually reset to 300000

Simplest fix in `stayAwakeCommand()`:
```typescript
originalTimeout = await getScreenTimeout();
// Don't save our own 24-hour timeout as "original"
if (originalTimeout === 86400000) {
  originalTimeout = 300000; // Quest default
}
```
