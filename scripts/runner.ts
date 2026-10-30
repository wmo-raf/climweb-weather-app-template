#!/usr/bin/env node
/**
 * Takes this country's settings all the way to the app running on a phone,
 * emulator or simulator. Steps run in this order; use --only to run some.
 *
 *   validate  Check settings, languages, cities and images (scripts/validate.ts)
 *   geonames  Download and convert place names into data/geo (scripts/prep/geonames.ts)
 *   app       Prepare the app in .climweb (scripts/prep/app.ts)
 *   run       Build the app and run it on Android or iOS with expo run
 *
 * By default every step runs except geonames, which only runs when data/geo
 * has no place data yet; GeoNames changes daily, so refreshing it on every
 * run would rewrite data/geo each time. Name it with --only to refresh.
 *
 * Downloads (GeoNames files, the app source and its dependencies) are cached
 * for 5 hours, so running this again soon after is quick. Pass --no-cache to
 * fetch everything again.
 *
 * Example:
 *   npm run android                     # same as: npx tsx scripts/runner.ts android
 *   npm run ios -- --device "iPhone 16"
 *   npm run runner -- --only validate,app
 *   npm run android -- --only geonames,app,run --ref some-branch
 */

import { spawn } from 'child_process';
import { Argument, Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { styleText } from 'util';
import { PrepOptions, STEPS as PREP_STEPS } from './prep';
import { APP_DIR } from './prep/app';
import { validate } from './validate';

const PLATFORMS = ['android', 'ios'] as const;
type Platform = (typeof PLATFORMS)[number];

// The files the geonames step creates
const PLACE_DATA = ['data/geo/geonames.json', 'data/geo/dataset.json', 'data/geo/trie.json'];

interface RunnerOptions extends PrepOptions {
  platform?: Platform;
  device?: string;
}

// ---------------------------------------------------------------------------
// Steps

async function checkSettings({ root }: RunnerOptions) {
  const { report } = validate(root);
  report.print([]);
  if (report.errorCount) throw new Error('Fix the errors above, then run again');
}

/** Builds the native app in .climweb and runs it with Expo, which then serves updates while it runs. */
async function runOnDevice({ root, platform, device }: RunnerOptions) {
  if (!platform) throw new Error(`Say which platform to run on: ${PLATFORMS.join(' or ')}`);
  if (platform === 'ios' && process.platform !== 'darwin') throw new Error('iOS builds need a Mac with Xcode');

  const appDir = path.join(root, APP_DIR);
  if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
    throw new Error(`The app in ${APP_DIR} isn't prepared yet; run the app step first`);
  }

  const args = ['expo', `run:${platform}`];
  if (device) args.push('--device', device);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', args, { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`expo run:${platform} exited with code ${code}`))));
  });
}

const STEPS: Record<string, (opts: RunnerOptions) => Promise<void>> = {
  validate: checkSettings,
  geonames: PREP_STEPS.geonames,
  app: PREP_STEPS.app,
  run: runOnDevice,
};

function defaultSteps(root: string): string[] {
  const hasPlaceData = PLACE_DATA.every(file => fs.existsSync(path.join(root, file)));
  return Object.keys(STEPS).filter(step => step !== 'geonames' || !hasPlaceData);
}

// ---------------------------------------------------------------------------

async function main() {
  const program = new Command()
    .description(`Validate, prepare and run the app. Steps: ${Object.keys(STEPS).join(', ')}.`)
    .addArgument(new Argument('[platform]', 'where to run the app (needed for the run step)').choices(PLATFORMS))
    .option('--only <steps>', 'comma-separated steps to run', (value: string) => value.split(',').map(s => s.trim()))
    .option('--device <name>', 'device or simulator to run on (default: Expo asks or picks one)')
    .option('--ref <branch>', 'app branch, tag or commit to prepare (default: main)')
    .option('--skip-install', "don't install the app's dependencies")
    .option('--no-cache', 'fetch everything from the internet again instead of reusing downloads from the last 5 hours')
    .option('--country <code>', 'GeoNames country code (default: region.geonames_country in country.json)')
    .option('--feature-class <list>', 'GeoNames feature classes to keep, e.g. P,T,H (default: P, populated places)')
    .option('--root <dir>', 'repository root', path.join(__dirname, '..'))
    .parse(process.argv);

  const [platform] = program.processedArgs as [Platform | undefined];
  const opts: RunnerOptions = { ...program.opts<RunnerOptions>(), platform };
  opts.root = path.resolve(opts.root);

  const unknown = (opts.only ?? []).filter(step => !(step in STEPS));
  if (unknown.length) {
    throw new Error(`Unknown step(s): ${unknown.join(', ')}. Steps: ${Object.keys(STEPS).join(', ')}`);
  }

  const selected = opts.only ?? defaultSteps(opts.root);
  const steps = Object.keys(STEPS).filter(step => selected.includes(step));
  // Fail before the slow steps rather than after them
  if (steps.includes('run') && !platform) {
    throw new Error('Say which platform to run on, e.g. npm run android or npm run ios');
  }
  opts.validated = steps.includes('validate');

  for (const step of steps) {
    console.error(styleText('bold', `▸ ${step}`));
    await STEPS[step](opts);
    console.error(styleText('green', `✓ ${step}`));
  }
}

main().catch(err => {
  console.error(styleText('red', `✗ ${(err as Error).message}`));
  process.exit(1);
});
