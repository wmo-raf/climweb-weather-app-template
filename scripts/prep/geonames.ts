/**
 * Prep step: downloads the GeoNames dump for this country, plus the admin1 and
 * admin2 code files used to name regions, and converts them into data/geo with
 * lib/geo/convert-geonames.ts.
 *
 * The country code is region.geonames_country in country.json unless one is
 * passed in. Only populated places (feature class P) are kept unless other
 * classes are asked for. Downloads are retried on network errors, timeouts
 * and server errors; a 404 means the code is wrong, so it fails straight away.
 * Downloads are cached for 5 hours (see ./cache.ts) unless cache is false.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream } from 'stream/web';
import { setTimeout as sleep } from 'timers/promises';
import yauzl from 'yauzl';
import { convertGeonames } from '../../lib/geo/convert-geonames';
import { age, cachePath, isFresh } from './cache';

const DUMP_URL = 'https://download.geonames.org/export/dump';
const ADMIN_FILES = ['admin1CodesASCII.txt', 'admin2Codes.txt'] as const;

// Populated places: cities, towns and villages, which is what people search for
const DEFAULT_FEATURE_CLASSES = ['P'];

const RETRIES = 3;
const RETRY_DELAY_MS = 2_000; // doubles after each failed attempt
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export interface GeonamesOptions {
  root: string;
  country?: string;
  featureClass?: string;
  /** Reuse downloads from the last few hours; false fetches fresh copies */
  cache?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`${url} returned HTTP ${status}`);
  }
}

function countryFromSettings(root: string): string {
  const country = JSON.parse(fs.readFileSync(path.join(root, 'country.json'), 'utf8'));
  return country?.region?.geonames_country ?? '';
}

async function download(url: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) throw new HttpError(res.status, url);
      await pipeline(Readable.fromWeb(res.body as ReadableStream), fs.createWriteStream(dest));
      return;
    } catch (err) {
      const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      if (!retryable || attempt >= RETRIES) throw err;
      const delay = RETRY_DELAY_MS * 2 ** attempt;
      console.error(`Download failed (${(err as Error).message}); retry ${attempt + 1}/${RETRIES} in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/** Streams a single named entry out of a zip file to dest. */
function extractEntry(zipPath: string, entryName: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let found = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (!found) reject(new Error(`${entryName} not found in ${path.basename(zipPath)}`));
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          pipeline(stream, fs.createWriteStream(dest)).then(() => {
            zip.close();
            resolve();
          }, reject);
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * Returns a local copy of a GeoNames dump file, reusing the cached one if it
 * was downloaded within the cache period. Downloads go to a .part file first
 * so a failed download never leaves a broken file in the cache.
 */
async function cachedDownload(name: string, useCache: boolean): Promise<string> {
  const file = cachePath(`geonames/${name}`);
  if (useCache && isFresh(file)) {
    console.error(`Using ${name} downloaded ${age(file)}`);
    return file;
  }
  console.error(`Downloading ${name}...`);
  const partial = `${file}.part`;
  await download(`${DUMP_URL}/${name}`, partial);
  fs.renameSync(partial, file);
  return file;
}

async function downloadCountry(code: string, tmpDir: string, useCache: boolean): Promise<string> {
  const txtPath = path.join(tmpDir, `${code}.txt`);
  let zipPath: string;
  try {
    zipPath = await cachedDownload(`${code}.zip`, useCache);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new Error(`GeoNames has no data for "${code}"; check region.geonames_country in country.json`);
    }
    throw err;
  }
  await extractEntry(zipPath, `${code}.txt`, txtPath);
  return txtPath;
}

export async function prepGeonames({ root, country, featureClass, cache = true }: GeonamesOptions): Promise<void> {
  const code = (country ?? countryFromSettings(root)).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(`"${code}" isn't a two-letter country code; set region.geonames_country in country.json or pass --country`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geonames-'));
  try {
    console.error(`Getting GeoNames data for ${code}...`);
    const [inputFile, admin1File, admin2File] = await Promise.all([
      downloadCountry(code, tmpDir, cache),
      ...ADMIN_FILES.map(name => cachedDownload(name, cache)),
    ]);

    await convertGeonames({
      inputFile,
      admin1File,
      admin2File,
      featureClasses: featureClass ? featureClass.split(',') : DEFAULT_FEATURE_CLASSES,
      outputDir: path.join(root, 'data/geo'),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
