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
  .epilog('Requires ADB to be installed and Quest connected via USB with debugging enabled.');

// Screenshot command
cli.command(
  'screenshot <output>',
  'Take a screenshot from Quest and save to local file',
  (yargs) => {
    return yargs.positional('output', {
      describe: 'Output file path (e.g., ~/screenshots/test.jpg)',
      type: 'string',
      demandOption: true
    });
  },
  async (argv) => {
    await screenshotCommand(argv.output as string);
  }
);

// Open command
cli.command(
  'open <url>',
  'Open URL in Quest browser with ADB port forwarding',
  (yargs) => {
    return yargs.positional('url', {
      describe: 'URL to open (e.g., http://localhost:9004/myapp/)',
      type: 'string',
      demandOption: true
    });
  },
  async (argv) => {
    await openCommand(argv.url as string);
  }
);

// Parse and execute
cli.parse();
