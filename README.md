# Vortex Radar

Browser based weather radar and alerts. Pulls live data from the NWS and other public sources. Radar, warnings, surface obs, lightning, and more.

> **Project rename:** This project was renamed from **StormTrack Pro** to **Vortex Radar**.

## Website

You can view the live version here: [vortexradar.snapsera.com](https://vortexradar.snapsera.com/)

## Screenshots

![Vortex Radar](images/screenshot.png)

## Features

- **NEXRAD radar** — Level 2 & Level 3 from any US NEXRAD site. Reflectivity, velocity (with dealiasing), and a bunch of other products. National composite, looping, and a data inspector.
- **Alerts** — Warnings, watches, advisories drawn on the map with polygons and full text. SPC watches, MDs, outlooks. Ticker along the bottom, plus audible/voice notifications.
- **Lightning** — Real-time strike plotting.
- **METARs** — Station models from ASOS/AWOS sites.
- **Surface fronts** — Frontal boundaries and pressure systems.
- **Hurricanes** — NHC tracks and forecast cones.
- **SPC** — Outlooks, watches, mesoscale discussions.
- **Weather stations** — Upper-air soundings and station info.
- **Radio** — NWR and scanner streams.
- **Drawing** — Freehand annotation on the map.
- **Screenshots** — Save any region of the map.
- **7-Day Forecast** — City/state/zip, current conditions, hourly out to 72h, day-by-day text forecasts.

## Project layout

```text
app/                Source, organized by feature
  alerts/           Alert fetching, parsing, rendering, polygons
  core/             App shell, map, menus, popups, clock, entry point
  devtools/         Dev/testing tools
  draw/             Drawing/annotation
  forecast/         7-day forecast modal
  hurricanes/       Tropical cyclone tracks
  lightning/        Lightning data
  metars/           METAR parsing and station models
  radar/            NEXRAD decoding, plotting, colormaps, looping, inspector
  radio/            NWR / scanner streams
  screenshot/       Map capture
  spc/              SPC outlooks, watches, MDs
  surface_fronts/   Fronts overlay
  timezones/        Timezone display
  ui/               Shared UI (ticker, audible alerts, voice, fullscreen)
  weather_station/  Station info, upper-air data
data/               Static data and palettes
dist/               Build output
images/             Icons and SVGs
lib/                Vendored libs (bzip2)
scripts/            Build scripts
styles/             CSS source (concatenated at build)
tools/              Changelog, bundle-size utils
```

## Tech

- **Mapbox GL JS** for the map
- **Browserify + brfs** for bundling
- **WebGL** with custom GLSL shaders for radar rendering
- All radar decoding happens client-side — bzip2 decompression, NEXRAD message parsing, the whole thing
- **Express** serves the app (`server.js`, port 3000)

## Getting started

```bash
npm install
npm run build
```

`npm run build` concats CSS, bundles JS with Browserify, and minifies with UglifyJS.

```bash
npm run start          # Express server on port 3000
npm run dev            # build + start
```

Then open `http://localhost:3000`.

## Credits

Built on top of [AtticRadar](https://github.com/SteepAtticStairs/AtticRadar) by [SteepAtticStairs](https://github.com/SteepAtticStairs). A lot of the core architecture, NEXRAD decoding, and WebGL rendering here started from or was heavily inspired by that project. Go check it out.

## License

Not currently published under an open-source license. All rights reserved.
