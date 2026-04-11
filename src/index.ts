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
import { stayAwakeStatus, stayAwakeDisable } from './commands/stay-awake.js';
import { saveConfig, loadConfig, type QuestDevConfig } from './utils/config.js';
import { setVerbose } from './utils/verbose.js';
import { ensureDaemon, daemonRequest, discoverDaemon, daemonFetch, resolvePort } from './daemon/client.js';
import { startDaemon } from './daemon/daemon.js';
import { extractCastingApk, hasCastingApk, findInstalledMqdh } from './utils/casting-apk.js';

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
    const info = await ensureDaemon(argv.port as number | undefined, argv.device as string | undefined);
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
    const info = await ensureDaemon(argv.port as number | undefined, argv.device as string | undefined);

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
    const info = await ensureDaemon(argv.port as number | undefined, argv.device as string | undefined);
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
    const info = await ensureDaemon(argv.port as number | undefined, argv.device as string | undefined);

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
      install?: {
        incremental: boolean;
        blocksTransferred?: number;
        totalBlocks?: number;
        bytesTransferred?: number;
        installSecs: number;
        apkSizeMB: number;
      };
    };

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

    const values: QuestDevConfig = {};
    if (argv.pin !== undefined) values.pin = argv.pin as string;
    if (argv.port !== undefined) values.port = argv.port as number;
    if (argv.device !== undefined) values.device = argv.device as string;
    if (argv.idleTimeout !== undefined) values.idleTimeout = argv.idleTimeout as number;
    if (argv.lowBattery !== undefined) values.lowBattery = argv.lowBattery as number;

    if (Object.keys(values).length === 0) {
      console.error('No config values provided. Use --pin, --port, --device, --idle-timeout, or --low-battery.');
      process.exit(1);
    }

    saveConfig(values);
    console.log('Config saved:');
    console.log(JSON.stringify(values, null, 2));

    // Warn if device changed while daemon is running
    if (values.device !== undefined && discoverDaemon()) {
      console.log('\nNote: daemon is running. Restart it to use the new device:');
      console.log('  quest-dev stop && quest-dev start');
    }
  }
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
  () => {},
  async (argv) => {
    await startDaemon(resolvePort(argv.port as number | undefined), argv.device as string | undefined);
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
