#!/usr/bin/env node

/**
 * Quest Dev CLI
 * Command-line tools for Meta Quest Browser development
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { screenshotCommand } from './commands/screenshot.js';
import { openCommand } from './commands/open.js';
import { tailCommand } from './commands/logcat.js';
import { batteryCommand } from './commands/battery.js';
import { stayAwakeStatus, stayAwakeDisable, stayAwakeWatchdog } from './commands/stay-awake.js';
import { castCommand } from './commands/cast.js';
import { saveConfig, loadConfig } from './utils/config.js';
import { setVerbose } from './utils/verbose.js';
import { ensureDaemon, daemonRequest, discoverDaemon, daemonFetch } from './daemon/client.js';
import { startDaemon } from './daemon/daemon.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8')
);
const version = packageJson.version;

// Create CLI
const cli = yargs(hideBin(process.argv))
  .scriptName('quest-dev')
  .version(version)
  .usage('Usage: $0 <command> [options]')
  .demandCommand(1, '')
  .strict()
  .option('verbose', {
    describe: 'Show detailed debug output',
    type: 'boolean',
    default: false,
    global: true,
  })
  .fail((msg, err, yargs) => {
    yargs.showHelp();
    if (err) console.error(err.message);
    process.exit(1);
  })
  .help()
  .alias('help', 'h')
  .epilog('Requires ADB and Quest connected via USB. Sets up CDP on port 9223 for cdp-cli.');

// Screenshot command (standalone — no daemon needed)
cli.command(
  'screenshot <directory>',
  'Take a screenshot from Quest and save to directory with auto-generated filename',
  (yargs) => {
    return yargs
      .positional('directory', {
        describe: 'Output directory path (e.g., ~/screenshots)',
        type: 'string',
        demandOption: true
      })
      .option('caption', {
        describe: 'Caption to embed in JPEG COM metadata',
        type: 'string',
        alias: 'c'
      });
  },
  async (argv) => {
    await screenshotCommand(
      argv.directory as string,
      argv.caption as string | undefined
    );
  }
);

// Open command (standalone)
cli.command(
  'open <url>',
  'Open URL in Quest browser (sets up CDP debugging port forwarding)',
  (yargs) => {
    return yargs
      .positional('url', {
        describe: 'URL to open (localhost URLs get reverse forwarding for dev server access)',
        type: 'string',
        demandOption: true
      })
      .option('close-others', {
        describe: 'Close all other tabs before opening',
        type: 'boolean',
        default: false
      })
      .option('browser', {
        describe: 'Browser package name (e.g., com.oculus.browser, org.chromium.chrome)',
        type: 'string',
        default: 'com.oculus.browser',
        alias: 'b'
      });
  },
  async (argv) => {
    await openCommand(
      argv.url as string,
      argv.closeOthers as boolean,
      argv.browser as string
    );
  }
);

// Logcat command — delegates to daemon for start/stop/status, tail remains standalone
cli.command(
  'logcat <action>',
  'Capture Android logcat to files (CRITICAL: always start before testing to avoid losing crash logs)',
  (yargs) => {
    return yargs
      .positional('action', {
        describe: 'Action to perform',
        type: 'string',
        choices: ['start', 'stop', 'status', 'tail'],
        demandOption: true
      })
      .option('filter', {
        describe: 'Logcat filter expression (e.g., "*:W" for warnings+, "chromium:V *:S" for chromium only)',
        type: 'string'
      });
  },
  async (argv) => {
    const action = argv.action as string;

    if (action === 'tail') {
      await tailCommand();
      return;
    }

    // Delegate to daemon
    const info = await ensureDaemon();
    switch (action) {
      case 'start': {
        const result = await daemonFetch(info, '/logcat/start', {
          body: { filter: argv.filter },
        }) as { ok: boolean; file?: string; pid?: number };
        if (result.ok) {
          console.log(`Capturing (PID: ${result.pid})`);
          console.log(`File: ${result.file}`);
          console.log('');
          console.log('Now run your test. When done: quest-dev logcat stop');
        }
        break;
      }
      case 'stop': {
        const result = await daemonFetch(info, '/logcat/stop', {
          method: 'POST',
        }) as { ok: boolean };
        if (result.ok) {
          // Show file info
          const status = await daemonFetch(info, '/logcat/status') as {
            file?: string;
            size?: string;
            lines?: number;
          };
          console.log('Capture stopped');
          if (status.file) {
            console.log(`File: ${status.file}`);
            if (status.size) console.log(`Size: ${status.size} (${status.lines} lines)`);
          }
        }
        break;
      }
      case 'status': {
        const result = await daemonFetch(info, '/logcat/status') as {
          capturing: boolean;
          pid?: number;
          file?: string;
          size?: string;
          lines?: number;
        };
        if (result.capturing) {
          console.log(`Capturing (PID: ${result.pid})`);
          if (result.file) {
            console.log(`File: ${result.file}`);
            if (result.size) console.log(`Size: ${result.size} (${result.lines} lines)`);
          }
        } else {
          console.log('Not capturing');
        }
        break;
      }
    }
  }
);

// Battery command (standalone)
cli.command(
  'battery',
  'Show Quest battery percentage and charging status',
  () => {},
  async () => {
    await batteryCommand();
  }
);

// Cast command (still runs its own server — not yet integrated with daemon)
cli.command(
  'cast',
  'Cast Quest screen — streams video, serves REST API and web dashboard',
  (yargs) => {
    return yargs
      .option('port', {
        describe: 'HTTP server port',
        type: 'number',
        default: 8080,
      })
      .option('listen-port', {
        describe: 'TCP listen port for Quest connections',
        type: 'number',
        default: 4445,
      })
      .option('pin', {
        describe: 'Meta Store PIN for stay-awake (or save with: quest-dev config --pin)',
        type: 'string',
      })
      .option('idle-timeout', {
        describe: 'Idle timeout in ms (default: 300000 = 5 min)',
        type: 'number',
      })
      .option('low-battery', {
        describe: 'Exit when battery drops to this % (default: 10)',
        type: 'number',
      })
      .option('width', {
        describe: 'Initial capture width',
        type: 'number',
        default: 2064,
      })
      .option('height', {
        describe: 'Initial capture height',
        type: 'number',
        default: 1162,
      })
      .option('open', {
        describe: 'Open dashboard in default browser',
        type: 'boolean',
        default: false,
      })
      .epilog(`REST API (served on --port, default 8080):

  GET   /help          API reference (plain text)
  GET   /screenshot    Latest frame as JPEG
  GET   /stream        MJPEG stream
  GET   /status        JSON session state, resolution, fps, pose
  GET   /layers        Available layers and active layer ID
  GET   /events        SSE stream (state changes, toasts)

  POST  /config        { width, height }
  POST  /eye           { mode: "left"|"right"|"stereo" }
  POST  /pose          { x, y, z, yaw, pitch } or { dx, dy, dz, d_yaw, d_pitch }
  POST  /pose-loop     { active: true|false }  (omit to toggle)
  POST  /click         { x, y, layer, hold_ms }
  POST  /gaze          { action: "enable"|"click", yaw, pitch, dwell_ms }
  POST  /mud           { type, payload_hex }
  POST  /home          Press Home button
  POST  /reset-view    Reset camera pose, stop pose loop
  POST  /restart       Restart cast session
  POST  /stop          Stop casting`);
  },
  async (argv) => {
    await castCommand({
      port: argv.port as number,
      listenPort: argv.listenPort as number,
      pin: argv.pin as string | undefined,
      idleTimeout: argv.idleTimeout as number | undefined,
      lowBattery: argv.lowBattery as number | undefined,
      width: argv.width as number,
      height: argv.height as number,
      verbose: argv.verbose as boolean,
      open: argv.open as boolean,
    });
  }
);

// Stay-awake command — delegates to daemon
cli.command(
  'stay-awake',
  'Keep Quest awake (disables autosleep, guardian, dialogs) via daemon',
  (yargs) => {
    return yargs
      .option('pin', {
        describe: 'Meta Store PIN (or save with: quest-dev config --pin)',
        type: 'string',
      })
      .option('disable', {
        describe: 'Manually restore all test properties and exit',
        type: 'boolean',
        default: false,
      })
      .option('status', {
        describe: 'Show current property values and exit',
        type: 'boolean',
        default: false,
      });
  },
  async (argv) => {
    if (argv.status) {
      await stayAwakeStatus();
      return;
    }
    if (argv.disable) {
      // Try daemon first, fall back to direct
      const existing = discoverDaemon();
      if (existing) {
        await daemonFetch(existing, '/stay-awake/disable', { method: 'POST' });
        console.log('Stay-awake disabled via daemon');
      } else {
        await stayAwakeDisable(argv.pin as string | undefined);
      }
      return;
    }

    // Enable via daemon
    const info = await ensureDaemon();
    const result = await daemonFetch(info, '/stay-awake/enable', {
      body: { pin: argv.pin },
    }) as { ok: boolean; error?: string };
    if (result.ok) {
      console.log('Stay-awake enabled via daemon');
      console.log(`Daemon PID: ${info.pid}, port: ${info.port}`);
    } else {
      console.error('Failed to enable stay-awake:', result.error);
      process.exit(1);
    }
  }
);

// Deploy command — auto-starts daemon, deploys APK, reports crash/success
cli.command(
  'deploy <apk>',
  'Deploy APK to Quest (auto-starts daemon, enables stay-awake, installs, launches, checks for crash)',
  (yargs) => {
    return yargs
      .positional('apk', {
        describe: 'Path to APK file',
        type: 'string',
        demandOption: true,
      })
      .option('crash-wait', {
        describe: 'Time in ms to wait before crash check (default: 5000)',
        type: 'number',
        default: 5000,
      });
  },
  async (argv) => {
    const apkPath = resolve(argv.apk as string);
    const info = await ensureDaemon();

    console.log(`Deploying: ${apkPath}`);
    const result = await daemonFetch(info, '/deploy', {
      body: {
        apk_path: apkPath,
        crash_wait_ms: argv.crashWait,
      },
    }) as {
      ok: boolean;
      package: string;
      crashed: boolean;
      logcatLines?: string[];
      logcatFile?: string;
      error?: string;
    };

    if (result.ok) {
      console.log(`\nDeploy successful: ${result.package} is running`);
      if (result.logcatFile) {
        console.log(`Logcat: ${result.logcatFile}`);
      }
    } else if (result.crashed) {
      console.error(`\nCRASH DETECTED: ${result.package}`);
      if (result.logcatLines && result.logcatLines.length > 0) {
        console.error('\n--- Crash logcat ---');
        for (const line of result.logcatLines) {
          console.error(line);
        }
        console.error('--- End crash logcat ---\n');
      }
      if (result.error) {
        console.error(result.error);
      }
      if (result.logcatFile) {
        console.error(`Logcat: ${result.logcatFile}`);
      }
      process.exit(1);
    } else {
      console.error(`\nDeploy failed: ${result.error}`);
      if (result.logcatFile) {
        console.error(`Logcat: ${result.logcatFile}`);
      }
      process.exit(1);
    }
  }
);

// Stop command — shuts down daemon
cli.command(
  'stop',
  'Stop the quest-dev daemon (restores Quest settings)',
  () => {},
  async () => {
    const existing = discoverDaemon();
    if (!existing) {
      console.log('No daemon running');
      return;
    }
    try {
      await daemonFetch(existing, '/shutdown', { method: 'POST' });
      console.log('Daemon shutdown requested');
    } catch {
      console.log('Daemon is not responding (may already be stopped)');
    }
  }
);

// Config command (standalone)
cli.command(
  'config',
  'Save default settings for quest-dev commands',
  (yargs) => {
    return yargs
      .option('pin', {
        describe: 'Meta Store PIN',
        type: 'string',
      })
      .option('idle-timeout', {
        describe: 'Idle timeout in milliseconds for stay-awake',
        type: 'number',
      })
      .option('low-battery', {
        describe: 'Exit stay-awake when battery drops to this percentage',
        type: 'number',
      })
      .option('show', {
        describe: 'Show current config and exit',
        type: 'boolean',
        default: false,
      });
  },
  (argv) => {
    if (argv.show) {
      const config = loadConfig();
      if (Object.keys(config).length === 0) {
        console.log('No config found.');
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
      return;
    }

    const values: Record<string, unknown> = {};
    if (argv.pin !== undefined) values.pin = argv.pin;
    if (argv.idleTimeout !== undefined) values.idleTimeout = argv.idleTimeout;
    if (argv.lowBattery !== undefined) values.lowBattery = argv.lowBattery;

    if (Object.keys(values).length === 0) {
      console.error('No config values provided. Use --pin, --idle-timeout, or --low-battery.');
      process.exit(1);
    }

    saveConfig(values as any);
    console.log('Config saved:');
    console.log(JSON.stringify(values, null, 2));
  }
);

// Hidden daemon subcommand (spawned by client.ts)
cli.command(
  'daemon',
  false as any, // Hide from help
  (yargs) => {
    return yargs
      .option('port', {
        type: 'number',
        default: 19872,
      });
  },
  async (argv) => {
    await startDaemon(argv.port as number);
  }
);

// Stay-awake watchdog (internal subcommand, spawned by cast command)
cli.command(
  'stay-awake-watchdog',
  false as any, // Hide from help
  (yargs) => {
    return yargs
      .option('parent-pid', {
        type: 'number',
        demandOption: true,
      })
      .option('pin', {
        type: 'string',
        demandOption: true,
      });
  },
  async (argv) => {
    await stayAwakeWatchdog(argv.parentPid as number, argv.pin as string);
  }
);

// Set verbose flag before any command runs
cli.middleware((argv) => {
  if (argv.verbose) {
    setVerbose(true);
  }
});

// Parse and execute
cli.parse();
