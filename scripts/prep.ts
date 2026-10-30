#!/usr/bin/env node
/**
 * Prepares the generated data and the app build folder from this country's
 * settings. Steps run in the order listed; use --only to run some of them.
 *
 * Steps:
 *   geonames  Downloads the GeoNames dump for region.geonames_country and
 *             converts it into data/geo (geonames.json, dataset.json, trie.json)
 *   app       Fetches the ClimWeb Weather App into .climweb and applies this
 *             country's settings, assets, place data and languages to it
 *
 * Downloads (GeoNames files, the app source and its dependencies) are cached
 * for 5 hours, so running this again soon after is quick. Pass --no-cache to
 * fetch everything again.
 *
 * Example:
 *   npx tsx scripts/prep.ts
 *   npx tsx scripts/prep.ts --only geonames --country TZ --feature-class P
 *   npx tsx scripts/prep.ts --only app --ref some-branch --skip-install
 */

import { Command } from 'commander';
import path from 'path';
import { styleText } from 'util';
import { prepApp } from './prep/app';
import { prepGeonames } from './prep/geonames';

export interface PrepOptions {
  root: string;
  only?: string[];
  country?: string;
  featureClass?: string;
  ref?: string;
  skipInstall?: boolean;
  /** Reuse internet downloads from the last 5 hours (--no-cache sets this to false) */
  cache?: boolean;
  /** Settings were already validated by the caller, e.g. scripts/runner.ts */
  validated?: boolean;
}

export const STEPS: Record<string, (opts: PrepOptions) => Promise<void>> = {
  geonames: prepGeonames,
  app: prepApp,
};

async function main() {
  const program = new Command()
    .description(`Prepare generated data and the app. Steps: ${Object.keys(STEPS).join(', ')}.`)
    .option('--only <steps>', 'comma-separated steps to run', (value: string) => value.split(',').map(s => s.trim()))
    .option('--country <code>', 'GeoNames country code (default: region.geonames_country in country.json)')
    .option('--feature-class <list>', 'GeoNames feature classes to keep, e.g. P,T,H (default: P, populated places)')
    .option('--ref <branch>', 'app branch or tag to prepare (default: main)')
    .option('--skip-install', "don't install the app's dependencies")
    .option('--no-cache', 'fetch everything from the internet again instead of reusing downloads from the last 5 hours')
    .option('--root <dir>', 'repository root', path.join(__dirname, '..'))
    .parse(process.argv);

  const opts = program.opts<PrepOptions>();
  opts.root = path.resolve(opts.root);

  const unknown = (opts.only ?? []).filter(step => !(step in STEPS));
  if (unknown.length) {
    throw new Error(`Unknown step(s): ${unknown.join(', ')}. Steps: ${Object.keys(STEPS).join(', ')}`);
  }

  const steps = Object.keys(STEPS).filter(step => !opts.only || opts.only.includes(step));
  for (const step of steps) {
    console.error(styleText('bold', `▸ ${step}`));
    await STEPS[step](opts);
    console.error(styleText('green', `✓ ${step}`));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(styleText('red', `✗ ${(err as Error).message}`));
    process.exit(1);
  });
}
