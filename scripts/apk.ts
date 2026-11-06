/**
 * Apk step: builds an APK of the app prepared in .climweb.
 *
 *   release  Signed with this country's key, ready to install and share
 *   debug    Needs no key of ours. Android requires every installed APK to be
 *            signed, so Gradle signs it with the SDK's shared debug key. It
 *            loads its code from a running Expo dev server, so it's for
 *            developers rather than testers
 *
 *   1. For release, use the key in signing/, generating one the first time.
 *      It's kept out of .climweb, which gets reset, and out of git
 *   2. Generate the android/ project if the last expo run didn't leave one
 *   3. Build with Gradle, passing the key with the Android Gradle plugin's
 *      injected signing properties, so the generated project isn't edited
 *   4. Copy the APK to the output folder (build/ unless --out says otherwise)
 *
 * Android only installs an update signed with the same key as the installed
 * app, so a lost key can't be replaced by generating a new one. That's why a
 * half-missing key stops the build here instead of being regenerated.
 */

import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { styleText } from 'util';
import { getAppDir, run } from './prep/app';

const KEY_DIR = 'signing';
const KEYSTORE = 'release.keystore';
const KEY_INFO = 'release.json';
const KEY_ALIAS = 'climweb';
const KEY_VALIDITY_DAYS = '10000';
const OUTPUT_DIR = 'build';

export const APK_VARIANTS = ['release', 'debug'] as const;
export type ApkVariant = (typeof APK_VARIANTS)[number];

export interface ApkOptions {
  root: string;
  variant?: ApkVariant;
  /** Folder for the APK, relative to the repository root unless absolute */
  out?: string;
}

interface Key {
  alias: string;
  password: string;
}

function generateKey(keystore: string, keyInfo: string, appName: string): Key {
  const key = { alias: KEY_ALIAS, password: randomBytes(24).toString('hex') };
  fs.mkdirSync(path.dirname(keystore), { recursive: true });
  try {
    // PKCS12 keystores use one password for the store and the key. It's passed
    // by environment variable to keep it out of the process list.
    execFileSync('keytool', [
      '-genkeypair', '-storetype', 'PKCS12', '-keystore', keystore, '-alias', key.alias,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', KEY_VALIDITY_DAYS,
      '-dname', `CN=${appName.replace(/[,+="<>#;\\]/g, '\\$&')}`,
      '-storepass:env', 'CLIMWEB_KEY_PASSWORD',
    ], { env: { ...process.env, CLIMWEB_KEY_PASSWORD: key.password }, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error("keytool wasn't found. It comes with Java, which Android builds also need; install a JDK and run again");
    }
    throw err;
  }
  fs.chmodSync(keystore, 0o600);
  fs.writeFileSync(keyInfo, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });

  console.error(styleText('yellow', `      Generated a new signing key in ${KEY_DIR}/`));
  console.error(styleText('yellow', '      Back up this folder somewhere safe. Without it you can\'t update the app on phones that have this APK'));
  return key;
}

function loadKey(root: string, appName: string): Key & { keystore: string } {
  const keystore = path.join(root, KEY_DIR, KEYSTORE);
  const keyInfo = path.join(root, KEY_DIR, KEY_INFO);
  const present = [keystore, keyInfo].filter(file => fs.existsSync(file));

  if (present.length === 1) {
    throw new Error(`${path.relative(root, present[0])} is there but its partner isn't. Restore the missing file from your backup, or delete ${KEY_DIR}/ to start over with a new key`);
  }
  if (present.length) {
    console.error(`      Using the signing key in ${KEY_DIR}/`);
    return { ...JSON.parse(fs.readFileSync(keyInfo, 'utf8')) as Key, keystore };
  }
  return { ...generateKey(keystore, keyInfo, appName), keystore };
}

// Environment variables rather than -P arguments, to keep the password out of
// the process list and out of the error when a build fails.
function signingEnv(key: Key & { keystore: string }): NodeJS.ProcessEnv {
  const gradleProperty = 'ORG_GRADLE_PROJECT_android.injected.signing';
  return {
    [`${gradleProperty}.store.file`]: key.keystore,
    [`${gradleProperty}.store.password`]: key.password,
    [`${gradleProperty}.key.alias`]: key.alias,
    [`${gradleProperty}.key.password`]: key.password,
  };
}

export async function buildApk({ root, variant = 'release', out = OUTPUT_DIR }: ApkOptions): Promise<void> {
  const appDir = getAppDir(root);
  if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
    throw new Error(`The app in ${appDir} isn't prepared yet; run the app step first`);
  }
  const { app } = JSON.parse(fs.readFileSync(path.join(root, 'country.json'), 'utf8')) as {
    app: { name: string; android_package: string };
  };

  const env = variant === 'release' ? signingEnv(loadKey(root, app.name)) : undefined;

  const androidDir = path.join(appDir, 'android');
  if (!fs.existsSync(androidDir)) {
    run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], appDir, { CI: '1' });
  }

  const task = variant === 'release' ? 'assembleRelease' : 'assembleDebug';
  run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [task], androidDir, env);

  const built = path.join(androidDir, `app/build/outputs/apk/${variant}/app-${variant}.apk`);
  const output = path.resolve(root, out, `${app.android_package}${variant === 'debug' ? '-debug' : ''}.apk`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(built, output);
  console.error(`      ${variant === 'release' ? 'Signed release' : 'Debug'} APK: ${output}`);
}
