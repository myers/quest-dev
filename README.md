# quest-dev

CLI tools for Meta Quest Browser development. Take screenshots and open URLs on your Quest device via ADB.

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

## How It Works

- **screenshot**: Triggers `com.oculus.metacam/.capture.CaptureService` via ADB, waits for the JPEG to be fully written (by checking for the EOI marker), pulls the file, then deletes it from the Quest

- **open**: Uses ADB for port forwarding and browser launching. If `cdp-cli` is installed, it uses CDP to intelligently reuse existing tabs instead of opening new ones.

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
