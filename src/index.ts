#!/usr/bin/env node

/**
 * Quest Dev CLI
 * Command-line tools for Meta Quest Browser development
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { screenshotCommand } from './commands/screenshot.js';
import { openCommand } from './commands/open.js';
import { startCommand, stopCommand, statusCommand, tailCommand } from './commands/logcat.js';
import { batteryCommand } from './commands/battery.js';
import { stayAwakeCommand, stayAwakeWatchdog, stayAwakeStatus, stayAwakeDisable } from './commands/stay-awake.js';
import { saveConfig, loadConfig } from './utils/config.js';

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
  .fail((msg, err, yargs) => {
    yargs.showHelp();
    if (err) console.error(err.message);
    process.exit(1);
  })
  .help()
  .alias('help', 'h')
  .epilog('Requires ADB and Quest connected via USB. Sets up CDP on port 9223 for cdp-cli.');

// Screenshot command
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

// Open command
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

// Logcat command
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
    const filter = argv.filter as string | undefined;

    switch (action) {
      case 'start':
        await startCommand(filter);
        break;
      case 'stop':
        await stopCommand();
        break;
      case 'status':
        await statusCommand();
        break;
      case 'tail':
        await tailCommand();
        break;
      default:
        console.error(`Unknown action: ${action}`);
        process.exit(1);
    }
  }
);

// Battery command
cli.command(
  'battery',
  'Show Quest battery percentage and charging status',
  () => {},
  async () => {
    await batteryCommand();
  }
);

// Stay-awake command
cli.command(
  'stay-awake',
  'Keep Quest awake (disables autosleep, guardian, dialogs)',
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
      .option('disable', {
        describe: 'Manually restore all test properties and exit',
        type: 'boolean',
        default: false,
      })
      .option('status', {
        describe: 'Show current property values and exit',
        type: 'boolean',
        default: false,
      })
      .option('verbose', {
        describe: 'Print battery level on every check (every 60s)',
        type: 'boolean',
        default: false,
        alias: 'v',
      });
  },
  async (argv) => {
    if (argv.status) {
      await stayAwakeStatus();
    } else if (argv.disable) {
      await stayAwakeDisable(argv.pin as string | undefined);
    } else {
      await stayAwakeCommand(
        argv.pin as string | undefined,
        argv.idleTimeout as number | undefined,
        argv.lowBattery as number | undefined,
        argv.verbose as boolean,
      );
    }
  }
);

// Config command
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

// Stay-awake watchdog (internal subcommand, spawned by stay-awake parent)
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

// Parse and execute
cli.parse();
