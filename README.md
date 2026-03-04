# quest-dev

CLI tools for Meta Quest development — stay awake, screenshots, URL opening, logcat, and battery via ADB.

## Installation

```bash
npm install -g @myerscarpenter/quest-dev
```

## Prerequisites

- **ADB** - Android Debug Bridge must be installed and in your PATH
  - macOS: `brew install android-platform-tools`
  - Linux: `sudo apt install adb`
  - Windows: [Download Platform Tools](https://developer.android.com/tools/releases/platform-tools)

- **Quest Device** - Connected via USB with [Developer Mode and USB Debugging enabled](https://developers.meta.com/horizon/documentation/native/android/mobile-device-setup/)

- **cdp-cli** (optional) - For smart tab reuse in the `open` command

  ```bash
  npm install -g @myerscarpenter/cdp-cli
  ```

## Usage

### Screenshot

Take a screenshot from Quest and save it locally:

```bash
quest-dev screenshot ./screenshot.jpg
quest-dev screenshot ~/Pictures/quest-capture.jpg
```

This uses Quest's native screenshot service which captures the full VR view, including immersive content that CDP screenshots can't capture.

### Open URL

Open a URL in Quest Browser with automatic ADB port forwarding:

```bash
quest-dev open http://localhost:3000/
quest-dev open http://localhost:9004/my-xr-app/
```

This command:

1. Sets up ADB reverse port forwarding (Quest → Host) so the Quest can reach your dev server
2. Sets up ADB forward port forwarding (Host → Quest) for CDP communication
3. If Quest Browser is already running with the URL, reloads the tab
4. If a blank tab exists, navigates it to the URL
5. Otherwise, launches Quest Browser with the URL

Port forwarding is idempotent - safe to run multiple times without issues.

### Stay Awake

Keep your Quest awake during development by disabling autosleep, guardian, and system dialogs using the Meta Scriptable Testing API.

```bash
quest-dev stay-awake --pin 1234
```

**Config file** — avoid passing `--pin` every time by creating `.quest-dev.json` in your project or `~/.config/quest-dev/config.json` globally:

```json
{
  "pin": "1234",
  "idleTimeout": 300000,
  "lowBattery": 10
}
```

**Flags:**

- `--status` — show current Scriptable Testing properties without changing anything
- `--disable` — manually disable test mode (restore all properties)
- `--idle-timeout <ms>` — auto-exit after inactivity (default: 300000ms / 5min)
- `--low-battery <percent>` — auto-exit when battery drops below threshold (default: 10%)
- `--verbose` — log battery status every 60s instead of only on 5% boundary crossings

**Activity signaling** — reset the idle timer from another process:

```bash
kill -USR1 $(cat ~/.quest-dev-stay-awake.pid)
```

**Watchdog** — a child process monitors the parent PID and automatically restores Quest settings if the parent dies (terminal close, `kill`, etc.), preventing a drained battery.

Requires Quest OS v44+ and your Meta Store PIN.

### Logcat

Capture Android logcat output for Quest debugging. Quest's ring buffer fills fast under VR load, so always start capture before testing.

```bash
quest-dev logcat start              # start capturing (clears ring buffer first)
quest-dev logcat start --filter "Unity:V"  # capture with filter
quest-dev logcat status             # check if capturing
quest-dev logcat tail               # tail the current log file
quest-dev logcat stop               # stop capturing, show file info
```

Log files are saved to `./logs/logcat/` with a `latest.txt` symlink.

### Battery

Show Quest battery level and charging status:

```bash
quest-dev battery
```

## How It Works

- **screenshot**: Triggers `com.oculus.metacam/.capture.CaptureService` via ADB, waits for the JPEG to be fully written (by checking for the EOI marker), pulls the file, then deletes it from the Quest

- **open**: Uses ADB for port forwarding and browser launching. If `cdp-cli` is installed, it uses CDP to intelligently reuse existing tabs instead of opening new ones.

- **stay-awake**: Uses the Meta Scriptable Testing API (`content://com.oculus.rc`) to disable autosleep, guardian, and dialogs. A watchdog child process ensures cleanup on exit.

- **logcat**: Spawns a background `adb logcat` process writing to timestamped files. Clears the ring buffer on start to avoid stale data.

- **battery**: Reads battery level and charging state via `adb shell dumpsys battery`.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run locally
node build/index.js screenshot ./test.jpg
node build/index.js open http://localhost:3000/
```

## License

MIT
