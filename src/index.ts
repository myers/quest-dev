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
import { stayAwakeCommand, stayAwakeWatchdog } from './commands/stay-awake.js';

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
  .demandCommand(1, 'You must provide a command')
  .strict()
  .fail((msg, err, yargs) => {
    if (msg) {
      console.error(`Error: ${msg}\n`);
    }
    if (err) {
      console.error(err.message);
    }
    console.error('Run "quest-dev --help" for usage information.');
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
  'Keep Quest screen awake (sets 24hr timeout, restores on Ctrl-C)',
  (yargs) => {
    return yargs.option('idle-timeout', {
      describe: 'Idle timeout in milliseconds (default: 300000 = 5 minutes)',
      type: 'number',
      default: 300000,
      alias: 'i'
    });
  },
  async (argv) => {
    await stayAwakeCommand(argv.idleTimeout as number);
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
        demandOption: true
      })
      .option('original-timeout', {
        type: 'number',
        demandOption: true
      });
  },
  async (argv) => {
    await stayAwakeWatchdog(argv.parentPid as number, argv.originalTimeout as number);
  }
);

// Parse and execute
cli.parse();
