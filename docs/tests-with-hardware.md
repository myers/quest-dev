# Hardware Tests

Tests that require a physical Quest device connected via ADB.

## stay-awake command

### Prerequisites

- Quest 3 connected via USB, ADB authorized
- Quest OS v44+
- Meta Store PIN known
- `.quest-dev.json` in project root: `{ "pin": "<pin>", "idleTimeout": 60000, "lowBattery": 15 }`

### Test 1: --status flag (read-only)

```bash
node build/index.js stay-awake --status
```

Expected: Shows all four properties (disable_guardian, disable_dialogs, disable_autosleep, set_proximity_close) as false.

### Test 2: --status works without config file

```bash
node build/index.js stay-awake --status
```

Expected: No PIN needed for status — works without `.quest-dev.json`.

### Test 3: Enable test mode — short run

```bash
node build/index.js stay-awake --idle-timeout 30000
```

Expected:
- Shows current properties (all false)
- Enables test mode (prints confirmation)
- Wakes screen
- Shows battery level
- Prints idle timeout and low battery threshold

Verify on device:
```bash
adb shell content call --uri content://com.oculus.rc --method GET_PROPERTY
```
Should show all true.

Then Ctrl-C. Should print "Restoring settings..." and "Test mode disabled". Verify properties restored to false.

### Test 4: --disable manual restore

Enable manually first:
```bash
adb shell content call --uri content://com.oculus.rc --method SET_PROPERTY \
  --extra 'disable_guardian:b:true' --extra 'disable_dialogs:b:true' \
  --extra 'disable_autosleep:b:true' --extra 'PIN:s:<pin>'
```

Then restore via CLI:
```bash
node build/index.js stay-awake --disable
```

Expected: Reads PIN from config, restores all properties to false.

### Test 5: Battery monitoring

```bash
node build/index.js stay-awake --idle-timeout 120000
```

Expected: Shows initial battery level. If charging, should log when battery crosses a 5% boundary (e.g. 85% → 90%). Monitor checks every 60s.

### Test 6: --verbose battery output

```bash
node build/index.js stay-awake --idle-timeout 120000 --verbose
```

Expected: Prints battery level on every 60s check, not just at 5% boundaries.

### Test 7: SIGUSR1 extends idle timeout

```bash
node build/index.js stay-awake --pin <pin> --idle-timeout 20000 --verbose &
PID=$!
sleep 5
kill -USR1 $PID
sleep 5
kill -USR1 $PID
sleep 15
kill $PID
```

Expected: Two timestamped `[HH:MM:SS] Activity detected, resetting idle timer` log lines. Process stays alive past the original 20s because signals keep resetting the timer.

### Test 8: CLI flags override config

```bash
node build/index.js stay-awake --idle-timeout 15000 --low-battery 20
```

Expected: Should show "idle timeout: 15s, low battery exit: 20%" overriding the config values (60s / 15).

### Test 9: Config file values used as defaults

```bash
node build/index.js stay-awake
```

Expected: Should show "idle timeout: 60s, low battery exit: 15%" (from `.quest-dev.json`).

### Test 10: Watchdog cleanup after kill -9

```bash
node build/index.js stay-awake --idle-timeout 120000 &
PARENT_PID=$!
sleep 3
adb shell content call --uri content://com.oculus.rc --method GET_PROPERTY
# Should show all true
kill -9 $PARENT_PID
sleep 8
adb shell content call --uri content://com.oculus.rc --method GET_PROPERTY
# Should show all false — watchdog restored them
```

Expected: Watchdog detects parent death within ~5s and restores all properties to false.
