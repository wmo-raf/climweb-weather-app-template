# ClimWeb Weather App: country settings

This repository holds **your country's settings** for the [ClimWeb Weather App](https://github.com/wmo-raf/climweb-weather-app): its name, colours, icons, languages, alert feeds and region. There is no app code here. The app is fetched automatically at the version you choose, and your settings are applied to it.

> **Status:** the commands (`npm run …`) and the build workflow depend on tooling still being built in the main app repository. The file layout below is final; the commands will work once that tooling is released.

## Getting started

1. Click **Use this template** → **Create a new repository**, in your organisation. It can be public or private.
2. In your organisation's settings: **Actions → General → Allow GitHub Actions to create and approve pull requests.** This lets you receive template updates as pull requests.
3. Edit the files described below, starting with `country.json` and `languages/english.json`.

## What's in this repository

| File or folder | What it's for | Who edits it |
|---|---|---|
| `country.json` | Your app's settings: name, colours, region, forecast and alerts | You |
| `languages/` | One file per language. `english.json` is required, and English is the default language. | You |
| `assets/` | App icon, Android icon and splash logo | You |
| `data/cities.json` | Cities shown when a user's location isn't available | You |
| `package.json` | Commands to check, preview and build | Template |
| `.github/workflows/` | Builds on GitHub, and template updates | Template |

Files marked **Template** are kept up to date automatically. Please don't edit them; anything you need to change belongs in `country.json`.

## Common changes

**App name and identity:** edit `app` in `country.json`. `ios_bundle_id` and `android_package` must be unique to your app, e.g. `tz.go.meteo.weather`, and can't change once the app is published.

**Colours:** set `branding.primary_colour` and `branding.secondary_colour` (e.g. `"#0C447C"`). The app works out lighter, darker and dark-mode shades itself. Colours must be dark enough to read on white; the check tells you if one isn't.

**Icons:** replace the files in `assets/`:
- `icon.png`: 1024 × 1024 pixels, **no transparency**
- `adaptive-icon.png`: 1024 × 1024, transparent background, logo kept within the centre circle
- `splash.png`: your logo, transparent background

**Region:** in `region`, set your `timezone` (e.g. `"Africa/Dar_es_Salaam"`), the `bbox` around your country as `[west, south, east, north]`, and `geonames_country`, your two-letter country code (e.g. `"TZ"`), used to build the place search.

**Default cities:** list them in `data/cities.json`:
```json
[
  { "name": "Dodoma", "lat": -6.163, "lon": 35.751 },
  { "name": "Dar es Salaam", "lat": -6.792, "lon": 39.208 }
]
```

**Alerts:** in `languages/english.json`, set:
- `cap_feed_url`: your CAP warnings feed in English
- `fallback_cap_feed_url`: a backup feed, for example your WMO feed
- `cap_sender_id`: the sender address in those warnings (the `<sender>` value in a warning). Only warnings from this sender are shown, so check it carefully: a wrong value hides every warning.

The backup feed should use the same sender as the main one.

**Adding a language:** copy `languages/english.json` to a new file, e.g. `languages/swahili.json`. Set `code` (e.g. `"sw"`), `name` (`"Swahili"`), `native_name` (`"Kiswahili"`), that language's alert feeds and its `cap_sender_id` (agencies often use a different sender for each language's feed), then translate every value under `translations`. Don't change the keys on the left. The app picks the language up automatically.

## Checking, previewing and building

| Command | What it does |
|---|---|
| `npm run check` | Checks your settings and lists anything that needs fixing |
| `npm run validate` | Checks `country.json`, languages, default cities and images in this repository. Add `-- --fix` to tidy up the JSON files first |
| `npm run prep` | Downloads place names for `region.geonames_country` from GeoNames into `data/geo/`, then prepares the app in `.climweb/` with your settings, icons, places and languages. Run one part with `-- --only geonames` or `-- --only app` |
| `npm run android` | Does everything: checks your settings, prepares the app and runs it on an Android phone or emulator. Place names are only downloaded the first time |
| `npm run ios` | The same, on the iOS simulator (Mac with Xcode only) |
| `npm run runner -- --only validate,app` | Runs only some of those steps: `validate`, `geonames`, `app`, `run`. Add `geonames` to refresh place names |
| `npm run preview` | Opens the app with your settings on your phone; changes appear as you save |
| `npm run preview -- --web` | The same, in your web browser |
| `npm run apk` | Builds an Android APK you can install and share for testing (needs Docker Desktop) |

> [!IMPORTANT]
> **Downloads are cached for 5 hours.** `prep`, `android`, `ios` and `runner` reuse anything they downloaded in the last 5 hours: GeoNames place data, the app's code, and its dependencies. This makes running them again quick, but changes published in that time won't be picked up, for example a fix to the app or new GeoNames data. To download everything again, add `--no-cache`, e.g. `npm run android -- --no-cache`.
>
> The generated iOS and Android projects (including CocoaPods) are also kept between runs. They're rebuilt only when something they depend on changes, such as your app name, icons or the app version. `--no-cache` rebuilds them too.

**On GitHub:** go to **Actions → Build → Run workflow**, and choose:
- **`preview-apk`** to build a test APK, which you download from the finished run
- **`store-release`** for app store builds, which needs store credentials set up first (see below)

## Upgrading the app

Change `core_version` in `country.json` to the new version, e.g. `"v1.9.0"`, then run `npm run check`. If the new version needs changes to your settings, the check explains what to change.

## Template updates

When this template improves, a pull request titled **"Template updates from climweb-weather-app-template"** appears in your repository. Review it and merge it. It never changes your settings, languages, icons or cities.

## Store publishing and credentials

Signing keys, app store accounts and Firebase files are **never** stored in this repository. They're set up once in your organisation's EAS project and GitHub secrets (`EXPO_TOKEN`), usually by your IT team together with the ClimWeb team.

## Getting help

Open an issue in the [ClimWeb Weather App repository](https://github.com/wmo-raf/climweb-weather-app/issues).
