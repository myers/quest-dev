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
import { castScreenshotCommand, type CastEyeMode } from './commands/cast-screenshot.js';
import { openCommand } from './commands/open.js';
import { tailCommand } from './commands/logcat.js';
import { batteryCommand } from './commands/battery.js';
import { stayAwakeStatus, stayAwakeOff } from './commands/stay-awake.js';
import { deviceSet, deviceRm, deviceList, deviceInfo } from './commands/device.js';
import { saveConfig, loadConfig, type QuestDevConfig } from './utils/config.js';
import { setVerbose } from './utils/verbose.js';
import { ensureDaemon, daemonRequest, discoverDaemonForDevice, sendDaemonPing, daemonFetch, daemonFetchNdjson, resolveHost } from './daemon/client.js';
import { resolveDevice } from './daemon/resolve.js';
import { setAdbDevice } from './utils/adb.js';
import type { DeployEvent, DeployResult } from './daemon/deploy.js';
import { startDaemon } from './daemon/daemon.js';
import { extractCastingApk, hasCastingApk, findInstalledMqdh } from './utils/casting-apk.js';

// Suppress adb's localhost emulator autoscan. By default adb probes
// localhost ports 5555-5585 for emulators; if any unrelated service is
// listening there (a stray emulator, a containerised Android, etc.) adb
// registers a bogus `emulator-5554 offline` transport, which then makes
// bare adb commands ambiguous ("more than one device/emulator"). quest-dev
// only ever talks to a Quest (a USB serial or a network ip:port), never a
// localhost emulator, so an empty scan range (max < 5555) is always safe.
// Children spawned via exec.ts inherit this; only applied if unset so a
// user who deliberately wants emulator scanning is not overridden.
process.env.ADB_LOCAL_TRANSPORT_MAX_PORT ??= '5554';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8')
);
const version = packageJson.version;

// `quest-dev logcat tail [tail_args...]` is a pure pass-through to
// `tail(1)` against the currently-captured log file. Short-circuit before
// yargs sees it so `-f`, `-n N`, `-F`, `--help`, etc. reach tail intact
// rather than tripping `.strict()`. Anything after `tail` is tail's; no
// quest-dev semantics in this path.
{
  const _argv = hideBin(process.argv);
  if (_argv[0] === 'logcat' && _argv[1] === 'tail') {
    tailCommand(_argv.slice(2));
    // tailCommand never returns; the spawned tail process drives our exit.
  }
}

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
  .option('port', {
    describe: 'Daemon HTTP port (or save with: quest-dev config --port)',
    type: 'number',
    global: true,
  })
  .option('device', {
    describe: 'Quest IP address (or save with: quest-dev config --device)',
    type: 'string',
    global: true,
  })
  .option('host', {
    describe: 'Daemon bind address (default: 127.0.0.1, use 0.0.0.0 for network access)',
    type: 'string',
    global: true,
  })
  .fail((msg, err, yargs) => {
    yargs.showHelp();
    if (err) console.error(err.message);
    process.exit(1);
  })
  .help()
  .alias('help', 'h')
  .epilog('Requires ADB and Quest connected via USB or Wi-Fi (adb connect).');

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
    const resolved = await resolveDevice(argv.device as string | undefined);
    setAdbDevice(resolved.address);
    await screenshotCommand(
      argv.directory as string,
      argv.caption as string | undefined
    );
  }
);

// Cast screenshot — capture a validated per-eye/stereo frame via the daemon
cli.command(
  'cast-screenshot <directory>',
  'Capture a per-eye/stereo VR frame from the cast daemon and write a validated JPEG',
  (yargs) => {
    return yargs
      .positional('directory', {
        describe: 'Output directory path',
        type: 'string',
        demandOption: true,
      })
      .option('mode', {
        describe: 'Eye mode',
        type: 'string',
        choices: ['left', 'right', 'stereo'] as const,
        default: 'stereo',
        alias: 'm',
      })
      .option('caption', {
        describe: 'Caption to embed in JPEG COM metadata (also used in filename)',
        type: 'string',
        alias: 'c',
      });
  },
  async (argv) => {
    await castScreenshotCommand({
      mode: argv.mode as CastEyeMode,
      directory: argv.directory as string,
      caption: argv.caption as string | undefined,
      port: argv.port as number | undefined,
      device: argv.device as string | undefined,
      host: argv.host as string | undefined,
    });
  },
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
    const resolved = await resolveDevice(argv.device as string | undefined);
    setAdbDevice(resolved.address);
    await openCommand(
      argv.url as string,
      argv.closeOthers as boolean,
      argv.browser as string,
      resolved.serial
    );
  }
);

// Logcat command — delegates to daemon for start/stop/status.
// `tail` is handled by a pre-yargs short-circuit at the top of this file
// because it forwards arbitrary `tail(1)` flags that would otherwise
// trip `.strict()`. Help text below still lists `tail` so users discover it.
cli.command(
  'logcat <action>',
  'Capture Android logcat to files (CRITICAL: always start before testing to avoid losing crash logs). For `tail [tail_args...]`, see `quest-dev logcat tail --help`.',
  (yargs) => {
    return yargs
      .positional('action', {
        describe: 'Action to perform',
        type: 'string',
        choices: ['start', 'stop', 'status'],
        demandOption: true
      })
      .option('filter', {
        describe: 'Logcat filter expression (e.g., "*:W" for warnings+, "chromium:V *:S" for chromium only)',
        type: 'string'
      });
  },
  async (argv) => {
    const action = argv.action as string;

    // Delegate to daemon
    const info = await ensureDaemon({ port: argv.port as number | undefined, device: argv.device as string | undefined, host: argv.host as string | undefined });
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
        } else {
          console.error('Failed to start logcat capture');
          console.error(JSON.stringify(result, null, 2));
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
            if (status.size) console.log(`Size: ${status.size}`);
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
            if (result.size) console.log(`Size: ${result.size}`);
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
  async (argv) => {
    const resolved = await resolveDevice(argv.device as string | undefined);
    setAdbDevice(resolved.address);
    await batteryCommand();
  }
);

// Start command — starts daemon with stay-awake for web content workflows
cli.command(
  'start',
  'Start quest-dev daemon (enables stay-awake, serves dashboard for casting)',
  (yargs) => {
    return yargs
      .option('pin', {
        describe: 'Meta Store PIN for stay-awake (or save with: quest-dev config --pin)',
        type: 'string',
      });
  },
  async (argv) => {
    const info = await ensureDaemon({ port: argv.port as number | undefined, device: argv.device as string | undefined, host: argv.host as string | undefined });

    // Enable stay-awake
    const result = await daemonFetch(info, '/stay-awake/enable', {
      body: { pin: argv.pin },
    }) as { ok: boolean; error?: string };
    if (result.ok) {
      console.log('Stay-awake enabled');
    } else if (result.error !== 'PIN required') {
      console.warn('Stay-awake:', result.error);
    }

    const url = `http://localhost:${info.port}/`;
    console.log(`\nDaemon running (PID: ${info.pid}, port: ${info.port})`);
    console.log(`Dashboard: ${url}`);
    console.log(`\nStart casting: curl -X POST ${url}cast/start`);
    console.log(`Stop daemon:   quest-dev stop`);
  }
);

// Stay-awake command — delegates to daemon
cli.command(
  'stay-awake',
  'Keep Quest awake (turns off autosleep, guardian, dialogs) via daemon',
  (yargs) => {
    return yargs
      .option('pin', {
        describe: 'Meta Store PIN (or save with: quest-dev config --pin)',
        type: 'string',
      })
      .option('idle-timeout', {
        describe: 'Idle timeout in milliseconds (default: 300000 = 5 minutes, or save with: quest-dev config)',
        type: 'number',
        alias: 'i',
      })
      .option('low-battery', {
        describe: 'Exit when battery drops to this percentage (default: 10, or save with: quest-dev config)',
        type: 'number',
      })
      .option('unplugged-timeout', {
        describe: 'Exit after this many ms unplugged (default: 300000 = 5 min; 0 disables). Forgives brief unplugs.',
        type: 'number',
      })
      .option('off', {
        describe: 'Turn stay-awake off (restore Quest protections) and exit',
        type: 'boolean',
        default: false,
      })
      .option('status', {
        describe: 'Show current property values and exit',
        type: 'boolean',
        default: false,
      })
;
  },
  async (argv) => {
    if (argv.status) {
      await stayAwakeStatus();
      return;
    }
    if (argv.off) {
      // Try daemon first, fall back to direct
      const existing = await discoverDaemonForDevice(argv.device as string | undefined);
      if (existing) {
        await daemonFetch(existing, '/stay-awake/disable', { method: 'POST' });
        console.log('Stay-awake off via daemon');
      } else {
        await stayAwakeOff(argv.pin as string | undefined);
      }
      return;
    }

    // Enable via daemon
    const info = await ensureDaemon({
      port: argv.port as number | undefined,
      device: argv.device as string | undefined,
      host: argv.host as string | undefined,
      idleTimeout: argv.idleTimeout as number | undefined,
      lowBattery: argv.lowBattery as number | undefined,
      unpluggedTimeout: argv.unpluggedTimeout as number | undefined,
    });
    const result = await daemonFetch(info, '/stay-awake/enable', {
      body: { pin: argv.pin },
    }) as { ok: boolean; error?: string };
    if (result.ok) {
      console.log('Stay-awake on via daemon');
      console.log(`Daemon PID: ${info.pid}, port: ${info.port}`);
    } else {
      console.error('Failed to turn stay-awake on:', result.error);
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
      })
      .option('debugging-port', {
        describe:
          'TCP port to scan for orphan apps before install (default 15702 / Bevy BRP; e.g. 8081 React Native Metro). Overrides config.',
        type: 'number',
      });
  },
  async (argv) => {
    const apkPath = resolve(argv.apk as string);
    const debuggingPort =
      (argv.debuggingPort as number | undefined) ?? loadConfig().debuggingPort;
    const info = await ensureDaemon({
      port: argv.port as number | undefined,
      device: argv.device as string | undefined,
      host: argv.host as string | undefined,
    });

    console.log(`Deploying: ${apkPath}`);

    let sawDone = false;
    let lastSeenPackage = '';
    let finalEvent: (DeployResult & { type: 'done' }) | undefined;
    let validationError: { ok: false; error: string } | undefined;

    for await (const event of daemonFetchNdjson<DeployEvent | { ok: false; error: string }>(
      info,
      '/deploy',
      {
        apk_path: apkPath,
        crash_wait_ms: argv.crashWait,
        ...(debuggingPort !== undefined ? { debugging_port: debuggingPort } : {}),
      },
    )) {
      // Validation-error fallback: response was plain JSON, so we got one
      // object that doesn't have a `type` field.
      if (!('type' in event)) {
        validationError = event;
        break;
      }

      switch (event.type) {
        case 'adb_health':
          switch (event.status) {
            case 'connecting':
              console.log('ADB: connecting...');
              break;
            case 'reconnecting':
              console.log('ADB: reconnecting...');
              break;
            case 'restarting_server':
              console.log('ADB: restarting server...');
              break;
            case 'recovered': {
              const label =
                event.via === 'connect' ? 'connected' :
                event.via === 'reconnect' ? 'reconnected' :
                'server restarted';
              console.log(`ADB: recovered (${label})`);
              break;
            }
            case 'failed':
              console.error(`ADB: FAILED — ${event.error}`);
              break;
          }
          break;
        case 'stay_awake':
          switch (event.status) {
            case 'already_enabled':
              console.log('Stay-awake: already enabled');
              break;
            case 'enabling':
              console.log('Stay-awake: enabling...');
              break;
            case 'enabled':
              console.log('Stay-awake: enabled');
              break;
            case 'failed':
              console.error(`Stay-awake: FAILED — ${event.error ?? 'unknown error'}`);
              break;
          }
          break;
        case 'started':
          lastSeenPackage = event.package;
          console.log(`Package: ${event.package}`);
          console.log(`Installing APK (${event.apkSizeMB} MB)${event.incremental ? ' [incremental]' : ''}...`);
          break;
        case 'port_conflict_resolved':
          for (const s of event.stopped) {
            console.log(
              `Port ${event.port} was held by ${s.packageName} (uid ${s.uid}); force-stopped it.`,
            );
          }
          for (const s of event.skipped) {
            console.warn(
              `Port ${event.port} is held by uid ${s.uid} (unknown package); deploy may collide.`,
            );
          }
          break;
        case 'install_progress':
          process.stdout.write(`\r  Streaming: ${event.blocks}/${event.totalBlocks} blocks (${event.pct}%)`);
          break;
        case 'installed':
          if (event.totalBlocks) {
            const kb = Math.round((event.bytesTransferred ?? 0) / 1024);
            process.stdout.write(`\r  Transferred: ${event.blocksTransferred}/${event.totalBlocks} blocks (~${kb}KB)\n`);
          }
          console.log(`APK installed (${event.installSecs}s)`);
          break;
        case 'launching':
          console.log('Launching app...');
          break;
        case 'crash_check':
          console.log(`Waiting ${event.waitMs}ms for crash check...`);
          break;
        case 'done':
          sawDone = true;
          finalEvent = event;
          break;
      }
    }

    if (validationError) {
      console.error(`\nDeploy failed: ${validationError.error}`);
      process.exit(1);
    }

    if (!sawDone) {
      console.error(
        `\nConnection to daemon dropped before deploy completed.` +
        (lastSeenPackage ? ` Last known package: ${lastSeenPackage}.` : '') +
        `\n  Check status: quest-dev logcat` +
        (lastSeenPackage ? `\n  Verify install: adb shell pidof ${lastSeenPackage}` : ''),
      );
      process.exit(1);
    }

    const result = finalEvent!;
    if (result.ok) {
      const inst = result.install;
      if (inst) {
        const mode = inst.incremental ? 'incremental' : 'full';
        if (inst.blocksTransferred !== undefined && inst.totalBlocks) {
          const kb = Math.round((inst.bytesTransferred ?? 0) / 1024);
          console.log(`\nInstalled (${mode}, ${inst.installSecs}s): ${inst.blocksTransferred}/${inst.totalBlocks} blocks (~${kb}KB of ${inst.apkSizeMB}MB)`);
        } else {
          console.log(`\nInstalled (${mode}, ${inst.installSecs}s)`);
        }
      }
      console.log(`Deploy successful: ${result.package} is running`);
      console.log(`Logcat: ${result.logcatFile}`);
      console.log(`Daemon API: http://127.0.0.1:${info.port}/help`);
    } else if (result.crashed) {
      console.error(`\nCRASH DETECTED: ${result.package}`);
      if (result.logcatLines && result.logcatLines.length > 0) {
        console.error(`\n--- ${result.logcatFile} ---`);
        for (const line of result.logcatLines) {
          console.error(line);
        }
        console.error(`--- End ${result.logcatFile} ---\n`);
      }
      if (result.error) {
        console.error(result.error);
      }
      console.error(`Logcat: ${result.logcatFile}`);
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
  async (argv) => {
    const existing = await discoverDaemonForDevice(argv.device as string | undefined);
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

// Ping command — marks a session active so the daemon doesn't idle out
cli.command(
  'ping',
  "Reset the daemon's idle timer (keeps it alive during a long session)",
  () => {},
  async (argv) => {
    const info = await discoverDaemonForDevice(argv.device as string | undefined);
    if (!info) {
      console.error('No quest-dev daemon is running — nothing to ping.');
      process.exitCode = 1;
      return;
    }
    sendDaemonPing(info);
    console.log(`Pinged daemon (PID ${info.pid}) — idle timer reset.`);
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
      .option('unplugged-timeout', {
        describe: 'Exit stay-awake after this many ms unplugged (0 disables)',
        type: 'number',
      })
      .option('debugging-port', {
        describe:
          'Default TCP port to scan for orphan apps before deploy (Bevy BRP 15702, RN Metro 8081, etc.)',
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

    const values: QuestDevConfig = {};
    if (argv.pin !== undefined) values.pin = argv.pin as string;
    if (argv.port !== undefined) values.port = argv.port as number;
    if (argv.device !== undefined) values.device = argv.device as string;
    if (argv.idleTimeout !== undefined) values.idleTimeout = argv.idleTimeout as number;
    if (argv.lowBattery !== undefined) values.lowBattery = argv.lowBattery as number;
    if (argv.unpluggedTimeout !== undefined) values.unpluggedTimeout = argv.unpluggedTimeout as number;
    if (argv.debuggingPort !== undefined) values.debuggingPort = argv.debuggingPort as number;

    if (Object.keys(values).length === 0) {
      console.error('No config values provided. Use --pin, --port, --device, --idle-timeout, --low-battery, --unplugged-timeout, or --debugging-port.');
      process.exit(1);
    }

    saveConfig(values);
    console.log('Config saved:');
    console.log(JSON.stringify(values, null, 2));
  }
);

cli.command(
  'device <action> [arg1] [arg2]',
  'Manage device aliases and inspect device ports',
  (yargs) =>
    yargs
      .positional('action', { describe: 'set | list | rm | info', type: 'string', choices: ['set', 'list', 'rm', 'info'], demandOption: true })
      .positional('arg1', { type: 'string' })
      .positional('arg2', { type: 'string' })
      .option('json', { type: 'boolean', default: false }),
  async (argv) => {
    const action = argv.action as string;
    if (action === 'set') {
      if (!argv.arg1 || !argv.arg2) { console.error('Usage: quest-dev device set <alias> <address>'); process.exit(1); }
      await deviceSet(argv.arg1 as string, argv.arg2 as string);
    } else if (action === 'rm') {
      if (!argv.arg1) { console.error('Usage: quest-dev device rm <alias>'); process.exit(1); }
      deviceRm(argv.arg1 as string);
    } else if (action === 'list') {
      await deviceList(argv.json as boolean);
    } else {
      await deviceInfo(argv.arg1 as string | undefined, argv.json as boolean);
    }
  },
);

// Setup cast — extract casting APK from MQDH
cli.command(
  'setup-cast [source]',
  'Extract casting APK from Meta Quest Developer Hub',
  (yargs) => {
    return yargs
      .positional('source', {
        describe: 'Path to MQDH (.app, .dmg, .exe.zip, .exe, or directory). Omit to auto-detect.',
        type: 'string',
      })
      .example('$0 setup-cast', 'Auto-detect MQDH installation')
      .example('$0 setup-cast "/Applications/Meta Quest Developer Hub.app"', 'macOS .app')
      .example('$0 setup-cast ~/Downloads/MetaQuestDeveloperHub.dmg', 'macOS .dmg')
      .example('$0 setup-cast ~/Downloads/Meta-Quest-Developer-Hub.exe.zip', 'Windows installer');
  },
  async (argv) => {
    // If APKs already extracted, just confirm
    if (!argv.source && hasCastingApk()) {
      console.log('Casting APKs already extracted. Ready to cast.');
      console.log('(Run with a path argument to re-extract from a newer MQDH version.)');
      return;
    }

    let source = argv.source as string | undefined;

    // Auto-detect if no source provided
    if (!source) {
      const found = findInstalledMqdh();
      if (found) {
        console.log(`Found MQDH: ${found}`);
        source = found;
      } else {
        console.log('Could not find Meta Quest Developer Hub on this machine.\n');
        console.log('Download it from:');
        console.log('  https://developer.oculus.com/meta-quest-developer-hub\n');
        console.log('Then run:');
        console.log('  quest-dev setup-cast /path/to/Meta\\ Quest\\ Developer\\ Hub.app   (macOS)');
        console.log('  quest-dev setup-cast /path/to/MetaQuestDeveloperHub.dmg           (macOS)');
        console.log('  quest-dev setup-cast /path/to/Meta-Quest-Developer-Hub.exe.zip    (Windows)');
        process.exit(1);
      }
    }

    console.log('Extracting casting APKs...');
    await extractCastingApk(resolve(source));
    console.log('\nDone. The APK will be auto-installed on your Quest when you start casting.');
  }
);

// Hidden daemon subcommand (spawned by client.ts)
cli.command(
  'daemon',
  false as any, // Hide from help
  (yargs) => {
    return yargs
      .option('serial', { type: 'string', demandOption: true })
      .option('address', { type: 'string', demandOption: true })
      .option('idle-timeout', { type: 'number' })
      .option('low-battery', { type: 'number' })
      .option('unplugged-timeout', { type: 'number' });
  },
  async (argv) => {
    await startDaemon({
      serial: argv.serial as string,
      address: argv.address as string,
      // Pass --port only when explicitly set; otherwise the daemon binds :0.
      port: argv.port as number | undefined,
      host: argv.host as string | undefined,
      idleTimeout: argv.idleTimeout as number | undefined,
      lowBattery: argv.lowBattery as number | undefined,
      unpluggedTimeout: argv.unpluggedTimeout as number | undefined,
    });
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
