# Vortex Radar

![Vortex Radar](images/readmelogo.png)

Vortex Radar is a browser-based weather radar built for watching live conditions across the United States. It combines NEXRAD radar, National Weather Service alerts, SPC outlooks, surface observations, storm reports, forecasts, and other weather layers in one map.

The project was previously called StormTrack Pro.

## Hosted preview

I discontinued the hosted preview. To use Vortex Radar, you'll need to download the project and run `start-local-server.bat` on your Windows computer.

The launcher starts Vortex Radar locally at [http://localhost:9191](http://localhost:9191). Keep its Command Prompt window open while you're using the app. Closing that window stops the local server.

## Running Vortex Radar on Windows

You'll need [Node.js](https://nodejs.org/) 18 or newer.

1. Download or clone this repository.
2. Open the project folder.
3. Double-click `start-local-server.bat`.
4. Open [http://localhost:9191](http://localhost:9191) in your browser.

The launcher installs the required packages automatically the first time you run it. Later launches go straight to starting the server.

Vortex Radar still needs an internet connection. The app runs on your computer, but its maps, radar scans, alerts, forecasts, and other live weather data come from online services.

## What it includes

- **NEXRAD radar:** View Level 2 and Level 3 products from U.S. radar sites, including reflectivity and velocity. Radar decoding and rendering happen in the browser.
- **National radar:** Follow a looping CONUS base-reflectivity mosaic when you want the wider picture.
- **Weather alerts:** See NWS warnings, watches, and advisories on the map with polygons, alert details, a ticker, and optional audible or spoken notifications.
- **SPC weather:** Check convective outlooks, watches, and mesoscale discussions, including location-based risk information.
- **24/7 Live Mode:** Let the app rotate through active warnings, outlooks, radar, storm reports, recent earthquakes, commentary, and background music.
- **Observations and overlays:** Add METAR station plots, lightning, fronts, hurricanes, time zones, weather radio streams, and storm reports.
- **Forecasts:** Search by city, state, or ZIP code for current conditions, hourly details, and a seven-day NWS forecast.
- **Map tools:** Inspect radar values, measure distance, draw on the map, and save screenshots.

## Screenshots

![Vortex Radar national map](images/readme-screenshot-1.png)

![Vortex Radar alerts](images/readme-screenshot-2.png)

![Vortex Radar focused alert](images/readme-screenshot-3.png)

![Vortex Radar MyCast forecast](images/readme-screenshot-4.gif)

![Vortex Radar Live Mode](images/readme-screenshot-5-live-mode.gif)

## Maps and data

The main map uses MapLibre GL JS with OpenFreeMap, so a Mapbox account or access token isn't required. Satellite mode uses EOxCloudless Sentinel imagery. Check the [EOX license terms](https://cloudless.eox.at/documentation/license) before using that imagery commercially.

Live weather information comes from public sources including the National Weather Service, NOAA, the Storm Prediction Center, the National Hurricane Center, Iowa Environmental Mesonet, and the U.S. Geological Survey. Each service can occasionally be delayed or unavailable.

## Development

Install the packages and build the browser assets:

```bash
npm install
npm run build
```

Start the Express server:

```bash
npm start
```

The server listens on port `9191` unless you provide a different `PORT` environment variable.

For the local development command:

```bash
npm run dev
```

The build process combines the files in `styles/` into `index.css`, bundles the browser code into `dist/bundle.js`, and minifies the result.

## Windows desktop build

Run the Electron version locally:

```bash
npm run desktop:dev
```

Build a Windows installer without publishing it:

```bash
npm run desktop:dist
```

Build output is written to `release-build/`.

## Project structure

```text
app/        Application source organized by feature
data/       Static radar samples, palettes, and supporting data
devtools/   Local alert polygon editor
dist/       Built browser bundle
electron/   Windows desktop wrapper
images/     Logos, icons, and screenshots
scripts/    Build and release helpers
styles/     Source stylesheets
server.js   Express server and local API proxies
```

## Weather safety

Vortex Radar is a personal weather-viewing project, not an official warning service. Don't rely on it as your only source of severe-weather information. Keep Wireless Emergency Alerts enabled and follow guidance from the National Weather Service and local emergency officials.

## Credits

Vortex Radar builds on work from [AtticRadar](https://github.com/SteepAtticStairs/AtticRadar) by [SteepAtticStairs](https://github.com/SteepAtticStairs). Its original radar architecture, decoding work, and WebGL approach provided an important starting point for this project.

Map data is provided by [OpenStreetMap](https://www.openstreetmap.org/copyright) through [OpenFreeMap](https://openfreemap.org/).

## License

No open-source license has been published for this repository. All rights are reserved.
