#!/usr/bin/env python3
"""Build a regional 10 m wind sample from NOAA GFS GRIB2 messages."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from time import sleep
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from eccodes import codes_get, codes_get_array, codes_grib_new_from_file, codes_release
import numpy as np


BOUNDS = (-84, -48, 21, 49)
SPACING = 0.25
SCALE = 0.01
FORECAST_HOURS = (3, 6, 9)
FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"


def forecast_url(cycle, hour):
    west, east, south, north = BOUNDS
    params = {
        "file": f"gfs.t{cycle:%H}z.pgrb2.0p25.f{hour:03d}",
        "lev_10_m_above_ground": "on",
        "var_UGRD": "on",
        "var_VGRD": "on",
        "subregion": "",
        "leftlon": west % 360,
        "rightlon": east % 360,
        "bottomlat": south,
        "toplat": north,
        "dir": f"/gfs.{cycle:%Y%m%d}/{cycle:%H}/atmos",
    }
    return f"{FILTER}?{urlencode(params)}"


def read_vectors(path, valid):
    west, east, south, north = BOUNDS
    nx = round((east - west) / SPACING) + 1
    ny = round((north - south) / SPACING) + 1
    vectors = {}
    with path.open("rb") as data:
        while (message := codes_grib_new_from_file(data)) is not None:
            try:
                component = codes_get(message, "parameterNumber")
                if (
                    codes_get(message, "discipline") != 0
                    or codes_get(message, "parameterCategory") != 2
                    or codes_get(message, "typeOfLevel") != "heightAboveGround"
                    or codes_get(message, "level") != 10
                    or component not in (2, 3)
                ):
                    continue
                if component in vectors:
                    raise ValueError(f"Duplicate wind component {component} in {path.name}")
                if (
                    codes_get(message, "validityDate") != int(valid.strftime("%Y%m%d"))
                    or codes_get(message, "validityTime") != int(valid.strftime("%H%M"))
                ):
                    raise ValueError(f"Unexpected GRIB2 valid time in {path.name}")

                lon = (codes_get_array(message, "longitudes") + 180) % 360 - 180
                lat = codes_get_array(message, "latitudes")
                values = codes_get_array(message, "values")
                inside = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
                x = np.rint((lon[inside] - west) / SPACING).astype(int)
                y = np.rint((lat[inside] - south) / SPACING).astype(int)
                if len(x) != nx * ny or len(np.unique(y * nx + x)) != nx * ny:
                    raise ValueError(f"Unexpected regional grid in {path.name}")
                if not (
                    np.allclose(lon[inside], west + x * SPACING, atol=1e-7, rtol=0)
                    and np.allclose(lat[inside], south + y * SPACING, atol=1e-7, rtol=0)
                ):
                    raise ValueError(f"Noncanonical grid coordinates in {path.name}")

                packed = np.rint(values[inside] / SCALE)
                if not np.all(np.isfinite(packed) & (np.abs(packed) <= 32767)):
                    raise ValueError(f"Invalid or out-of-range wind samples in {path.name}")
                field = np.empty((ny, nx), dtype="<i2")
                field[y, x] = packed.astype("<i2")
                vectors[component] = field
            finally:
                codes_release(message)
    if set(vectors) != {2, 3}:
        raise ValueError(f"Could not find the 10 m U and V components in {path.name}")
    return np.stack((vectors[2], vectors[3]), axis=-1).astype("<i2")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cycle", required=True, help="UTC cycle as YYYYMMDDHH")
    parser.add_argument("--cache", required=True, type=Path, help="Scratch GRIB2 cache")
    parser.add_argument("--output", type=Path, default=Path("dist/data"))
    args = parser.parse_args()
    cycle = datetime.strptime(args.cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)

    frames = []
    downloaded = False
    for hour in FORECAST_HOURS:
        url = forecast_url(cycle, hour)
        grib = args.cache / f"gfs-{args.cycle}-f{hour:03d}.grib2"
        if not grib.is_file():
            if downloaded:
                sleep(10)
            request = Request(url, headers={"User-Agent": "AtlanticWindFieldDemo/1.0"})
            with urlopen(request, timeout=30) as response:
                raw = response.read()
            if not raw.startswith(b"GRIB"):
                raise ValueError(f"NOAA did not return GRIB2 for forecast hour {hour}")
            grib.write_bytes(raw)
            downloaded = True

        valid_time = cycle + timedelta(hours=hour)
        wind = read_vectors(grib, valid_time)
        height, width, _ = wind.shape
        file = f"wind-f{hour:03d}.i16le"
        (args.output / file).write_bytes(wind.tobytes())
        frames.append({
            "hour": hour,
            "valid": valid_time.isoformat(),
            "file": file,
            "grib2": url,
            "grib2Sha256": hashlib.sha256(grib.read_bytes()).hexdigest(),
        })
        print(f"+{hour:02d}h  {valid_time:%Y-%m-%d %H:%M UTC}  {width}×{height}  {wind.nbytes} bytes", flush=True)

    west, east, south, north = BOUNDS
    manifest = {
        "source": "NOAA / NCEP GFS 0.25°",
        "run": cycle.isoformat(),
        "heightAboveGroundMeters": 10,
        "grid": {"west": west, "east": east, "south": south, "north": north,
                 "dx": SPACING, "dy": SPACING, "width": width, "height": height},
        "encoding": {"format": "RG16I", "layout": "interleaved little-endian signed U,V; south to north",
                     "scaleMetersPerSecond": SCALE},
        "frames": frames,
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
