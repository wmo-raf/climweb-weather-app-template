#!/usr/bin/env node
/**
 * Validates this country's settings before they are handed to the app:
 *
 *   - country.json against scripts/schemas/country.schema.json, plus checks a
 *     schema can't express (files exist, timezone, bbox order, colour contrast)
 *   - every languages/*.json against scripts/schemas/language.schema.json, with
 *     translation keys and {{placeholders}} matched against english.json
 *   - the default cities file (region.default_cities) against
 *     scripts/schemas/cities.schema.json, and that each city is inside the bbox
 *   - weather symbols (assets/symbols) are no larger than 260×260
 *   - warning icons (assets/warnings) all share one size, taken to be the most
 *     common size in the folder
 *   - branding images are in assets/branding and follow the sizes and
 *     transparency rules in the README
 *
 * With --fix, the JSON files are sanitised first and written back if anything
 * changed: strings are trimmed, stray quotes around URLs removed, colours
 * upper-cased, numeric city coordinates given as strings turned into numbers,
 * and translations reordered to follow english.json with unknown keys dropped.
 * Problems that need a person (missing translations, wrong image sizes) are
 * still reported.
 *
 * Exits with code 1 if there are any errors. Warnings don't fail the run.
 *
 * Example:
 *   npx tsx scripts/validate.ts
 *   npx tsx scripts/validate.ts --fix
 */

import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addErrors from 'ajv-errors';
import addFormats from 'ajv-formats';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { styleText } from 'util';

const SCHEMA_DIR = path.join(__dirname, 'schemas');
const SYMBOLS_DIR = 'assets/symbols';
const WARNINGS_DIR = 'assets/warnings';
const BRANDING_DIR = 'assets/branding';

// Weather symbols may vary in size, but none may be larger than this
const MAX_SYMBOL_SIZE = { width: 260, height: 260 };
const LANGUAGES_DIR = 'languages';
const DEFAULT_LANGUAGE_FILE = 'english.json';

// Minimum contrast against white for brand colours (WCAG AA for body text)
const MIN_CONTRAST = 4.5;

// Branding images, keyed by their field in country.json. Sizes are fixed by
// the app's build, so they are not inferred like the symbol folders are.
const BRANDING_IMAGES: Record<string, { width?: number; height?: number; alpha: 'none' | 'some' }> = {
  icon:                     { width: 1024, height: 1024, alpha: 'none' },
  adaptive_icon_foreground: { width: 1024, height: 1024, alpha: 'some' },
  splash_image:             { alpha: 'some' },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Issue {
  level: 'error' | 'warning';
  file: string;
  message: string;
}

export class Report {
  issues: Issue[] = [];

  error(file: string, message: string) {
    this.issues.push({ level: 'error', file, message });
  }

  warn(file: string, message: string) {
    this.issues.push({ level: 'warning', file, message });
  }

  get errorCount() {
    return this.issues.filter(i => i.level === 'error').length;
  }

  // styleText leaves text plain when stdout isn't a terminal or NO_COLOR is set
  print(fixed: string[]) {
    for (const file of fixed) console.log(`${styleText('cyan', '✎ fixed')}  ${file}`);
    if (fixed.length) console.log();

    const byFile = new Map<string, Issue[]>();
    for (const issue of this.issues) {
      byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), issue]);
    }
    for (const [file, issues] of byFile) {
      console.log(styleText(['bold', 'underline'], file));
      for (const { level, message } of issues) {
        const icon = level === 'error' ? styleText(['red', 'bold'], '✗ error  ') : styleText(['yellow', 'bold'], '⚠ warning');
        console.log(`  ${icon} ${message}`);
      }
      console.log();
    }

    const warnings = this.issues.length - this.errorCount;
    if (!this.issues.length) {
      console.log(styleText(['green', 'bold'], '✓ Everything looks good.'));
      return;
    }
    const errorText = styleText(this.errorCount ? ['red', 'bold'] : 'green', `${this.errorCount} error(s)`);
    const warningText = styleText(warnings ? ['yellow', 'bold'] : 'green', `${warnings} warning(s)`);
    console.log(`${this.errorCount ? styleText('red', '✗') : styleText('green', '✓')} ${errorText}, ${warningText}.`);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function readJson(root: string, file: string, report: Report): Json | undefined {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    report.error(file, 'file not found');
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    report.error(file, `is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

function writeJsonIfChanged(root: string, file: string, before: Json, after: Json, fixed: string[]) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  fs.writeFileSync(path.join(root, file), JSON.stringify(after, null, 2) + '\n');
  fixed.push(file);
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadSchema(ajv: Ajv, name: string): ValidateFunction {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
  return ajv.compile(schema);
}

function formatAjvError(error: ErrorObject): string {
  const where = error.instancePath
    ? error.instancePath.slice(1).replace(/\//g, '.').replace(/~1/g, '/').replace(/~0/g, '~')
    : '(top level)';
  if (error.keyword === 'additionalProperties') {
    return `${where}: unknown field "${error.params.additionalProperty}"`;
  }
  if (error.keyword === 'required') {
    return `${where}: missing field "${error.params.missingProperty}"`;
  }
  if (error.keyword === 'enum') {
    return `${where}: must be one of ${error.params.allowedValues.map((v: unknown) => JSON.stringify(v)).join(', ')}`;
  }
  return `${where}: ${error.message}`;
}

function validateSchema(validate: ValidateFunction, data: Json, file: string, report: Report): boolean {
  if (validate(data)) return true;
  for (const error of validate.errors ?? []) report.error(file, formatAjvError(error));
  return false;
}

function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]));
}

function contrastWithWhite(hex: string): number {
  const [r, g, b] = hex.slice(1).match(/../g)!.map(h => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

function readPng(root: string, file: string, report: Report): PNG | undefined {
  try {
    return PNG.sync.read(fs.readFileSync(path.join(root, file)));
  } catch (err) {
    report.error(file, `can't be read as a PNG: ${(err as Error).message}`);
    return undefined;
  }
}

function hasTransparency(png: PNG): boolean {
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] < 255) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sanitising (--fix)

function sanitiseStrings(value: Json, key = ''): Json {
  if (typeof value === 'string') {
    let text = value.trim();
    if (key.endsWith('_url')) text = text.replace(/^['"`]+|['"`]+$/g, '').trim();
    if (key.endsWith('_colour') && /^#[0-9a-f]{6}$/i.test(text)) text = text.toUpperCase();
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitiseStrings(item, key));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitiseStrings(v, k)]));
  }
  return value;
}

function sanitiseCities(cities: Json): Json {
  if (!Array.isArray(cities)) return cities;
  return cities.map(city => {
    if (!isObject(city)) return city;
    const result = { ...city };
    for (const key of ['lat', 'lon']) {
      const value = result[key];
      if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
        result[key] = Number(value);
      }
    }
    return result;
  });
}

function sanitiseTranslations(language: Json, englishKeys: string[]): Json {
  if (!isObject(language) || !isObject(language.translations)) return language;
  const translations = language.translations;
  const ordered = Object.fromEntries(
    englishKeys.filter(key => key in translations).map(key => [key, translations[key]]),
  );
  return { ...language, translations: ordered };
}

// ---------------------------------------------------------------------------
// Checks

function checkCountry(root: string, country: Json, validate: ValidateFunction, report: Report) {
  const file = 'country.json';
  const valid = validateSchema(validate, country, file, report);
  if (!isObject(country)) return;

  const { app, branding, region } = country;

  if (isObject(app)) {
    for (const key of ['ios_bundle_id', 'android_package']) {
      if (typeof app[key] === 'string' && app[key].startsWith('org.example.')) {
        report.warn(file, `app.${key} is still the template default; set your own before publishing`);
      }
    }
  }

  if (isObject(branding)) {
    for (const key of ['primary_colour', 'secondary_colour']) {
      const colour = branding[key];
      if (typeof colour !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(colour)) continue;
      const ratio = contrastWithWhite(colour);
      if (ratio < MIN_CONTRAST) {
        report.error(file, `branding.${key} ${colour} is too light to read on white (contrast ${ratio.toFixed(2)}:1, needs ${MIN_CONTRAST}:1)`);
      }
    }
    for (const key of Object.keys(BRANDING_IMAGES)) {
      const target = branding[key];
      if (typeof target !== 'string') continue;
      if (!target.startsWith(`${BRANDING_DIR}/`)) {
        report.error(file, `branding.${key}: "${target}" must be in ${BRANDING_DIR}/`);
      } else if (!fs.existsSync(path.join(root, target))) {
        report.error(file, `branding.${key}: file "${target}" not found`);
      }
    }
  }

  if (isObject(region)) {
    const { timezone, bbox, default_cities } = region;
    if (typeof timezone === 'string' && timezone !== 'UTC' && !Intl.supportedValuesOf('timeZone').includes(timezone)) {
      report.error(file, `region.timezone "${timezone}" isn't a known timezone, e.g. "Africa/Dar_es_Salaam"`);
    }
    if (valid && Array.isArray(bbox)) {
      const [west, south, east, north] = bbox as number[];
      if (west >= east) report.error(file, `region.bbox: west (${west}) must be less than east (${east})`);
      if (south >= north) report.error(file, `region.bbox: south (${south}) must be less than north (${north})`);
    }
    if (typeof default_cities === 'string' && !fs.existsSync(path.join(root, default_cities))) {
      report.error(file, `region.default_cities: file "${default_cities}" not found`);
    }
  }
}

function checkLanguage(
  file: string,
  language: Json,
  english: Record<string, string> | undefined,
  validate: ValidateFunction,
  report: Report,
) {
  validateSchema(validate, language, file, report);
  if (!isObject(language) || !isObject(language.translations)) return;

  const translations = language.translations;
  for (const [key, value] of Object.entries(translations)) {
    if (typeof value === 'string' && !value.trim()) report.error(file, `translation "${key}" is empty`);
  }
  if (!english) return;

  const missing = Object.keys(english).filter(key => !(key in translations));
  const extra = Object.keys(translations).filter(key => !(key in english));
  for (const key of missing) report.error(file, `missing translation "${key}"`);
  for (const key of extra) report.error(file, `unknown translation "${key}" (not in ${DEFAULT_LANGUAGE_FILE}; --fix removes it)`);

  for (const [key, source] of Object.entries(english)) {
    const target = translations[key];
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    const expected = [...placeholders(source)].sort().join(', ');
    const actual = [...placeholders(target)].sort().join(', ');
    if (expected !== actual) {
      report.error(file, `translation "${key}" must use the placeholders {{${expected || '–'}}} exactly as in English, found {{${actual || '–'}}}`);
    }
  }
}

function checkCities(file: string, cities: Json, bbox: Json | undefined, validate: ValidateFunction, report: Report) {
  if (!validateSchema(validate, cities, file, report) || !Array.isArray(cities)) return;

  const seen = new Set<string>();
  for (const city of cities as { name: string; lat: number; lon: number }[]) {
    const name = city.name.toLowerCase();
    if (seen.has(name)) report.error(file, `"${city.name}" is listed more than once`);
    seen.add(name);

    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(n => typeof n === 'number')) {
      const [west, south, east, north] = bbox as number[];
      if (city.lon < west || city.lon > east || city.lat < south || city.lat > north) {
        report.error(file, `"${city.name}" (${city.lat}, ${city.lon}) is outside region.bbox in country.json`);
      }
    }
  }
}

/** Reads the size of every PNG in a folder, reporting files that aren't PNGs. */
function readImageSizes(root: string, dir: string, label: string, report: Report): Map<string, { width: number; height: number }> {
  const sizes = new Map<string, { width: number; height: number }>();
  const fullDir = path.join(root, dir);
  if (!fs.existsSync(fullDir)) {
    report.error(dir, 'folder not found');
    return sizes;
  }

  const entries = fs.readdirSync(fullDir).filter(name => !name.startsWith('.')).sort();
  for (const name of entries) {
    const file = `${dir}/${name}`;
    if (path.extname(name).toLowerCase() !== '.png') {
      report.error(file, `${label} must be PNG files`);
      continue;
    }
    const png = readPng(root, file, report);
    if (png) sizes.set(name, { width: png.width, height: png.height });
  }

  if (!sizes.size) report.error(dir, `no ${label} found`);
  return sizes;
}

/** Checks no image in a folder is larger than the given size. */
function checkMaxImageSize(root: string, dir: string, label: string, max: { width: number; height: number }, report: Report): string[] {
  const sizes = readImageSizes(root, dir, label, report);
  for (const [name, { width, height }] of sizes) {
    if (width > max.width || height > max.height) {
      report.error(`${dir}/${name}`, `is ${width}×${height}; ${label} must be at most ${max.width}×${max.height}`);
    }
  }
  return [...sizes.keys()];
}

/**
 * Checks every PNG in a folder has the same dimensions. The expected size is
 * the most common one among the files, so a single odd file is the one flagged.
 */
function checkUniformImages(root: string, dir: string, label: string, report: Report): string[] {
  const sizes = new Map([...readImageSizes(root, dir, label, report)].map(([name, s]) => [name, `${s.width}×${s.height}`]));
  if (!sizes.size) return [];

  const counts = new Map<string, number>();
  for (const size of sizes.values()) counts.set(size, (counts.get(size) ?? 0) + 1);
  const [expected, count] = [...counts].sort((a, b) => b[1] - a[1])[0];

  for (const [name, size] of sizes) {
    if (size !== expected) {
      report.error(`${dir}/${name}`, `is ${size}; ${label} should be ${expected} (the size of ${count} of the ${sizes.size} files here)`);
    }
  }
  return [...sizes.keys()];
}

function checkBranding(root: string, branding: Json | undefined, report: Report) {
  if (!isObject(branding)) return;
  for (const [key, spec] of Object.entries(BRANDING_IMAGES)) {
    const file = branding[key];
    // Wrong folder or missing file is reported by checkCountry
    if (typeof file !== 'string' || !file.startsWith(`${BRANDING_DIR}/`) || !fs.existsSync(path.join(root, file))) continue;

    const png = readPng(root, file, report);
    if (!png) continue;

    if (spec.width && spec.height && (png.width !== spec.width || png.height !== spec.height)) {
      report.error(file, `is ${png.width}×${png.height}; branding.${key} must be ${spec.width}×${spec.height}`);
    }
    const transparent = hasTransparency(png);
    if (spec.alpha === 'none' && transparent) {
      report.error(file, `branding.${key} must not have any transparency`);
    }
    if (spec.alpha === 'some' && !transparent) {
      report.warn(file, `branding.${key} should have a transparent background`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main

/**
 * Runs every check against the repository at root. With fix, the JSON files
 * are sanitised and written back first; fixed lists the files that changed.
 */
export function validate(root: string, fix = false): { report: Report; fixed: string[] } {
  const opts = { fix };
  const report = new Report();
  const fixed: string[] = [];

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  addErrors(ajv);
  const validateCountry = loadSchema(ajv, 'country.schema.json');
  const validateLanguage = loadSchema(ajv, 'language.schema.json');
  const validateCities = loadSchema(ajv, 'cities.schema.json');

  // country.json
  let country = readJson(root, 'country.json', report);
  if (country !== undefined && opts.fix) {
    const sanitised = sanitiseStrings(country);
    writeJsonIfChanged(root, 'country.json', country, sanitised, fixed);
    country = sanitised;
  }
  if (country !== undefined) checkCountry(root, country, validateCountry, report);
  const region = isObject(country) && isObject(country.region) ? country.region : undefined;
  const branding = isObject(country) ? country.branding : undefined;

  // Languages, with english.json first so the others can be compared to it
  const languageFiles = fs.existsSync(path.join(root, LANGUAGES_DIR))
    ? fs.readdirSync(path.join(root, LANGUAGES_DIR)).filter(name => name.endsWith('.json')).sort()
    : [];
  if (!languageFiles.includes(DEFAULT_LANGUAGE_FILE)) {
    report.error(LANGUAGES_DIR, `${DEFAULT_LANGUAGE_FILE} is required`);
  }
  languageFiles.sort((a, b) => Number(b === DEFAULT_LANGUAGE_FILE) - Number(a === DEFAULT_LANGUAGE_FILE));

  let english: Record<string, string> | undefined;
  const codes = new Map<string, string>();
  for (const name of languageFiles) {
    const file = `${LANGUAGES_DIR}/${name}`;
    let language = readJson(root, file, report);
    if (language === undefined) continue;

    if (opts.fix) {
      let sanitised = sanitiseStrings(language);
      if (english && name !== DEFAULT_LANGUAGE_FILE) sanitised = sanitiseTranslations(sanitised, Object.keys(english));
      writeJsonIfChanged(root, file, language, sanitised, fixed);
      language = sanitised;
    }

    if (name === DEFAULT_LANGUAGE_FILE) {
      checkLanguage(file, language, undefined, validateLanguage, report);
      if (isObject(language) && isObject(language.translations)) {
        english = language.translations as Record<string, string>;
      }
      if (isObject(language) && language.code !== 'en') report.error(file, 'code must be "en"');
    } else {
      checkLanguage(file, language, english, validateLanguage, report);
    }

    if (isObject(language) && typeof language.code === 'string') {
      const other = codes.get(language.code);
      if (other) report.error(file, `code "${language.code}" is already used by ${other}`);
      else codes.set(language.code, file);
    }
  }

  // Default cities
  if (region && typeof region.default_cities === 'string' && fs.existsSync(path.join(root, region.default_cities))) {
    const file = region.default_cities;
    let cities = readJson(root, file, report);
    if (cities !== undefined && opts.fix) {
      const sanitised = sanitiseCities(sanitiseStrings(cities));
      writeJsonIfChanged(root, file, cities, sanitised, fixed);
      cities = sanitised;
    }
    if (cities !== undefined) checkCities(file, cities, region.bbox, validateCities, report);
  }

  // Images
  const symbols = checkMaxImageSize(root, SYMBOLS_DIR, 'weather symbols', MAX_SYMBOL_SIZE, report);
  if (english) {
    for (const name of symbols) {
      const code = path.basename(name, path.extname(name));
      // The app keeps its wind warning icons alongside the symbols
      if (!(code in english) && !code.startsWith('icon-warning-')) {
        report.warn(`${SYMBOLS_DIR}/${name}`, `has no translation "${code}" in ${DEFAULT_LANGUAGE_FILE}; is it in the right folder?`);
      }
    }
  }
  checkUniformImages(root, WARNINGS_DIR, 'warning icons', report);
  checkBranding(root, branding, report);

  return { report, fixed };
}

function main() {
  const program = new Command()
    .description('Validate (and optionally sanitise) country.json, languages, default cities and image assets.')
    .option('--fix', 'sanitise the JSON files and write them back before validating')
    .option('--root <dir>', 'repository root', path.join(__dirname, '..'))
    .parse(process.argv);

  const opts = program.opts<{ fix?: boolean; root: string }>();
  const { report, fixed } = validate(path.resolve(opts.root), opts.fix);
  report.print(fixed);
  process.exitCode = report.errorCount ? 1 : 0;
}

if (require.main === module) main();
