import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const url = new URL(process.argv[2] ?? "http://127.0.0.1:8765/");
url.searchParams.set("verify", "1");
const chrome = process.env.CHROME_BIN
  ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "chromium");
const profile = mkdtempSync(join(tmpdir(), "atlantic-wind-headless-"));
try {
  const result = spawnSync(chrome, [
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--user-data-dir=" + profile,
    "--window-size=" + (process.env.WIND_TEST_SIZE ?? "1280,900"),
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--virtual-time-budget=12000",
    "--dump-dom",
    url.href,
  ], {encoding: "utf8", timeout: 35000, maxBuffer: 2 * 1024 * 1024});
  if (result.error) throw result.error;
  const html = result.stdout.match(/<html\b[^>]*>/i)?.[0] ?? "";
  if (result.status !== 0 || !html.includes('data-verification="passed"')) {
    const alert = result.stdout.match(/<p id="error"[^>]*>([^<]*)<\/p>/i)?.[1] ?? "";
    throw new Error("Headless check failed " + html + " " + alert
      + "\n" + result.stderr.split("\n").filter(Boolean).slice(-10).join("\n"));
  }
  const metrics = Object.fromEntries(
    [...html.matchAll(/data-(east|north|pixels|png-bytes|viewport)="([^"]+)"/g)]
      .map(match => [match[1], Number(match[2])]),
  );
  const backend = html.match(/data-backend="([^"]+)"/)?.[1] ?? "";
  if (!backend.includes("SwiftShader")) throw new Error("Expected the SwiftShader renderer, got " + backend);
  console.log(JSON.stringify({
    result: "passed",
    renderer: backend,
    viewportWidth: metrics.viewport,
    displacementMeters: {east: metrics.east, north: metrics.north},
    particlePixels: metrics.pixels,
    forecastTimeline: "passed",
    mouseAndKeyboardPointSelection: "passed",
    pngBytes: metrics["png-bytes"],
  }, null, 2));
} finally {
  rmSync(profile, {recursive: true, force: true});
}
