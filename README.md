# Atlantic Wind Field

A short regional wind briefing demo. Select a forecast time, inspect wind at a point, and export the map as a timestamped PNG.

## Run

Serve the static directory over HTTP.

    python3 -m http.server 8765 --bind 127.0.0.1 --directory dist

Open `http://127.0.0.1:8765/`. The site loads the bundled NOAA GFS cycle from November 19, 2026 at 12:00 UTC.

## Inspect the data

`dist/data/manifest.json` records the source requests, GRIB2 checksums, region, valid times, and encoding. Each sample contains two signed 16-bit components with a scale of 0.01 m/s. The runtime uploads frames as WebGL 2 `RG16I` textures. A high-precision vertex shader writes particle positions into alternating Float32 buffers via transform feedback.

To build the sample while the model cycle is available from NOMADS, use Python with `eccodes==2.50.1` and NumPy, then run the following command. Point the cache at a scratch directory.

    python3 scripts/prepare_wind.py --cycle 2026111912 --cache /tmp/atlantic-gfs

The sample contains the western Atlantic at 0.25° resolution and forecast hours +03, +06, and +09. Land geometry is public-domain [Natural Earth](https://www.naturalearthdata.com/) data.

## Verify in a headless browser

With the server running, use Node and Chromium or Chrome.

    node tests/check-headless.mjs

Set `CHROME_BIN` to the executable if needed. The test uses ANGLE with SwiftShader. It checks actual particle pixels, reads back a transform-feedback buffer to validate displacement, then exercises the forecast slider, point selection, and PNG encoding.
