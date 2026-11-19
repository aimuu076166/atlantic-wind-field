import {ParticleRenderer} from "./advection.js";

const id = name => document.getElementById(name);
const map = id("map");
const geography = id("geography");
const particleCanvas = id("particles");
const lead = id("lead");
const root = document.documentElement;
const verifyMode = new URLSearchParams(location.search).has("verify");
const preferStill = matchMedia("(prefers-reduced-motion: reduce)").matches;
const compass = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const cities = [
  ["Miami", -80.19, 25.76, 6, 12],
  ["Cape Hatteras", -75.53, 35.25, 6, 0],
  ["New York", -74.01, 40.71, -60, 1],
  ["Halifax", -63.57, 44.65, 6, 0],
  ["Bermuda", -64.78, 32.30, 6, 0],
];

let metadata;
let land;
let frames;
let renderer;
let selection;
let point = {lon: -66.7, lat: 37.1};
let paused = preferStill || verifyMode;
let lastDraw = 0;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

async function fetchAsset(path, kind) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Could not load " + path + " (" + response.status + ").");
  return kind === "binary" ? response.arrayBuffer() : response.json();
}

function unpack(buffer, cells) {
  if (buffer.byteLength !== 4 * cells) throw new Error("Unexpected wind frame size.");
  const ints = new Int16Array(cells * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < ints.length; i += 1) ints[i] = view.getInt16(i * 2, true);
  return ints;
}

function timeLabel(date) {
  return new Date(date).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function coordinateLabel({lon, lat}) {
  return Math.abs(lat).toFixed(2) + "° " + (lat >= 0 ? "N" : "S")
    + " · " + Math.abs(lon).toFixed(2) + "° " + (lon >= 0 ? "E" : "W");
}

function project(lon, lat, width, height) {
  const g = metadata.grid;
  return [(lon - g.west) / (g.east - g.west) * width,
          (g.north - lat) / (g.north - g.south) * height];
}

function drawGeography() {
  const ctx = geography.getContext("2d");
  const {width, height} = geography;
  const pixelRatio = width / map.clientWidth;
  const g = metadata.grid;
  const water = ctx.createLinearGradient(0, 0, width, height);
  water.addColorStop(0, "#163641");
  water.addColorStop(1, "#112331");
  ctx.fillStyle = water;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#2e474e";
  ctx.strokeStyle = "#709895";
  ctx.lineWidth = 0.9 * pixelRatio;
  for (const feature of land.features) {
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      ctx.beginPath();
      for (const ring of polygon) {
        for (let index = 0; index < ring.length; index += 1) {
          const [x, y] = project(...ring[index], width, height);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fill("evenodd");
      ctx.stroke();
    }
  }

  ctx.strokeStyle = "#a2c5c835";
  ctx.fillStyle = "#b5ced0a8";
  ctx.lineWidth = 0.65 * pixelRatio;
  ctx.font = 12 * pixelRatio + "px system-ui";
  for (let lon = Math.ceil(g.west / 5) * 5; lon < g.east; lon += 5) {
    const [x] = project(lon, g.north, width, height);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(Math.abs(lon) + "°W", x + 4 * pixelRatio, 16 * pixelRatio);
  }
  for (let lat = Math.ceil(g.south / 5) * 5; lat < g.north; lat += 5) {
    const [, y] = project(g.west, lat, width, height);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillText(lat + "°N", 6 * pixelRatio, y + 14 * pixelRatio);
  }

  ctx.fillStyle = "#ebf1e8";
  ctx.font = "500 " + 12 * pixelRatio + "px system-ui";
  for (const [name, lon, lat, dx, dy] of cities) {
    const [x, y] = project(lon, lat, width, height);
    ctx.beginPath();
    ctx.arc(x, y, 2 * pixelRatio, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(name, x + dx * pixelRatio, y + dy * pixelRatio);
  }
}

function resizeMap() {
  if (map.clientWidth === 0 || map.clientHeight === 0) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(map.clientWidth * ratio));
  const height = Math.max(1, Math.round(map.clientHeight * ratio));
  if (geography.width === width && geography.height === height && geography.dataset.drawn) return;
  for (const canvas of [geography, particleCanvas]) {
    canvas.width = width;
    canvas.height = height;
  }
  drawGeography();
  geography.dataset.drawn = "true";
  if (renderer && selection) renderer.draw();
}

function sampleFrame(frame, x, y, component) {
  const {width, height} = metadata.grid;
  const left = Math.floor(x);
  const bottom = Math.floor(y);
  const right = Math.min(left + 1, width - 1);
  const top = Math.min(bottom + 1, height - 1);
  const at = (col, row) => frame[(row * width + col) * 2 + component];
  return mix(mix(at(left, bottom), at(right, bottom), x - left),
    mix(at(left, top), at(right, top), x - left), y - bottom);
}

function pointWind() {
  const g = metadata.grid;
  const x = clamp((point.lon - g.west) / g.dx, 0, g.width - 1);
  const y = clamp((point.lat - g.south) / g.dy, 0, g.height - 1);
  const {left, right, mix: blend} = selection;
  const scale = metadata.encoding.scaleMetersPerSecond;
  const component = index => scale * mix(
    sampleFrame(frames[left], x, y, index), sampleFrame(frames[right], x, y, index), blend);
  const u = component(0);
  const v = component(1);
  const speed = Math.hypot(u, v);
  const angle = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  const bearing = compass[Math.round(angle / 22.5) % compass.length];
  return {u, v, speed, direction: speed < 0.05
    ? "Calm" : "From " + bearing + " · " + Math.round(angle) % 360 + "°"};
}

function updatePoint() {
  const [x, y] = project(point.lon, point.lat, 100, 100);
  const marker = id("marker");
  marker.style.left = x + "%";
  marker.style.top = y + "%";
  marker.hidden = false;
  const wind = pointWind();
  id("coords").textContent = coordinateLabel(point);
  id("speed").textContent = wind.speed.toFixed(1);
  id("direction").textContent = wind.direction;
}

function updateLead() {
  const hour = Number(lead.value);
  const right = Math.max(1, metadata.frames.findIndex(frame => frame.hour >= hour));
  const left = right - 1;
  const start = metadata.frames[left].hour;
  const end = metadata.frames[right].hour;
  selection = {left, right, mix: (hour - start) / (end - start)};
  const label = "+" + (hour < 10 ? "0" : "") + hour + " h";
  const valid = new Date(Date.parse(metadata.run) + 3600000 * hour);
  id("lead-label").textContent = label;
  lead.setAttribute("aria-valuetext", label + " · " + timeLabel(valid));
  id("valid").dateTime = valid.toISOString();
  id("valid").textContent = timeLabel(valid);
  updatePoint();
  if (renderer) {
    renderer.step(selection);
    renderer.draw();
  }
}

function runParticleCheck() {
  const result = renderer.checkDisplacement();
  const state = id("check-state");
  state.textContent = "WebGL 2 check " + (result.passed ? "passed" : "failed");
  state.dataset.result = result.passed ? "passed" : "failed";
  id("measured-east").textContent = result.east.toFixed(2) + " m";
  id("measured-north").textContent = result.north.toFixed(2) + " m";
  root.dataset.east = result.east.toFixed(4);
  root.dataset.north = result.north.toFixed(4);
  return result;
}

async function makePng() {
  const output = document.createElement("canvas");
  const scale = geography.width / map.clientWidth;
  const header = Math.round(86 * scale);
  output.width = geography.width;
  output.height = geography.height + header;
  const ctx = output.getContext("2d");
  ctx.fillStyle = "#13222c";
  ctx.fillRect(0, 0, output.width, output.height);
  ctx.drawImage(geography, 0, header);
  if (renderer) {
    renderer.draw();
    ctx.drawImage(particleCanvas, 0, header);
  }
  const [x, y] = project(point.lon, point.lat, geography.width, geography.height);
  ctx.strokeStyle = "#f7f3d5";
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.arc(x, y + header, 5 * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.scale(scale, scale);
  ctx.fillStyle = "#eff7f8";
  ctx.font = "600 19px system-ui";
  ctx.fillText("Atlantic Wind Field", 14, 26);
  ctx.fillStyle = "#b4d4d8";
  ctx.font = "13px system-ui";
  ctx.fillText("NOAA GFS 10 m · " + timeLabel(id("valid").dateTime), 14, 48);
  const wind = pointWind();
  ctx.fillText(coordinateLabel(point) + " · " + wind.speed.toFixed(1) + " m/s · " + wind.direction, 14, 68);
  const boxX = output.width / scale - 143;
  const boxY = output.height / scale - 53;
  ctx.fillStyle = "#0b1723ed";
  ctx.fillRect(boxX, boxY, 132, 42);
  const ramp = ctx.createLinearGradient(boxX + 8, 0, boxX + 124, 0);
  ramp.addColorStop(0, "#61bde5");
  ramp.addColorStop(0.5, "#8de7c0");
  ramp.addColorStop(1, "#ffd581");
  ctx.fillStyle = ramp;
  ctx.fillRect(boxX + 8, boxY + 10, 116, 4);
  ctx.fillStyle = "#e0eef0";
  ctx.fillText("0", boxX + 8, boxY + 30);
  ctx.fillText("20+ m/s", boxX + 74, boxY + 30);
  return new Promise((resolve, reject) => output.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error("PNG export failed."));
  }, "image/png"));
}

function updatePlayButton() {
  id("play").textContent = paused ? "Play" : "Pause";
}

function animate(now) {
  if (!paused && renderer && now - lastDraw >= 30) {
    renderer.step(selection);
    renderer.draw();
    lastDraw = now;
  }
  requestAnimationFrame(animate);
}

function setupControls() {
  map.addEventListener("click", event => {
    const rect = map.getBoundingClientRect();
    const g = metadata.grid;
    point = {
      lon: mix(g.west, g.east, clamp((event.clientX - rect.left) / rect.width, 0, 1)),
      lat: mix(g.north, g.south, clamp((event.clientY - rect.top) / rect.height, 0, 1)),
    };
    updatePoint();
  });
  map.addEventListener("keydown", event => {
    const movement = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1]}[event.key];
    if (!movement) return;
    event.preventDefault();
    const g = metadata.grid;
    point.lon = clamp(point.lon + g.dx * movement[0], g.west, g.east);
    point.lat = clamp(point.lat + g.dy * movement[1], g.south, g.north);
    updatePoint();
  });
  lead.addEventListener("input", updateLead);
  lead.disabled = false;
  id("play").addEventListener("click", () => {
    paused = !paused;
    updatePlayButton();
  });
  updatePlayButton();
  id("play").disabled = !renderer;
  id("check-again").addEventListener("click", runParticleCheck);
  id("check-again").disabled = !renderer;
  id("export").addEventListener("click", async () => {
    try {
      const image = await makePng();
      const url = URL.createObjectURL(image);
      const download = document.createElement("a");
      download.href = url;
      download.download = "atlantic-wind-" + id("valid").dateTime.slice(0, 16).replace(":", "") + "Z.png";
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      showError(error.message);
    }
  });
  id("export").disabled = false;
}

function showError(message) {
  id("error").textContent = message;
  id("error").hidden = false;
}

async function verifyInBrowser(particleCheck) {
  if (!particleCheck?.passed) throw new Error("Particle displacement check failed.");
  const gl = renderer.gl;
  const details = gl.getExtension("WEBGL_debug_renderer_info");
  root.dataset.backend = details ? gl.getParameter(details.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  root.dataset.viewport = String(window.innerWidth);
  if (root.scrollWidth > window.innerWidth + 1) throw new Error("Layout overflows the viewport.");
  renderer.draw();
  const pixels = new Uint8Array(4 * gl.drawingBufferWidth * gl.drawingBufferHeight);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let drawn = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn += 1;
  if (drawn < 300 || gl.getError() !== gl.NO_ERROR) throw new Error("Wind particles were not rendered.");
  root.dataset.pixels = String(drawn);

  const firstWind = pointWind();
  const lastFrame = metadata.frames.at(-1);
  lead.value = lastFrame.hour;
  lead.dispatchEvent(new Event("input", {bubbles: true}));
  const lastWind = pointWind();
  if (Date.parse(id("valid").dateTime) !== Date.parse(lastFrame.valid)
      || Math.hypot(firstWind.u - lastWind.u, firstWind.v - lastWind.v) < 0.01) {
    throw new Error("Forecast selection did not update the valid time and wind.");
  }
  const rect = map.getBoundingClientRect();
  const initialPoint = id("coords").textContent;
  map.dispatchEvent(new MouseEvent("click", {
    clientX: rect.left + rect.width * 0.35,
    clientY: rect.top + rect.height * 0.4,
    bubbles: true,
  }));
  if (initialPoint === id("coords").textContent) throw new Error("Map click did not move the point forecast.");
  const before = id("coords").textContent;
  map.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true, cancelable: true}));
  if (before === id("coords").textContent) throw new Error("Point inspection did not move.");

  const image = await makePng();
  const magic = new Uint8Array(await image.slice(0, 8).arrayBuffer());
  if (image.type !== "image/png" || image.size < 1000 || magic.join(",") !== "137,80,78,71,13,10,26,10") {
    throw new Error("PNG export did not produce a valid image.");
  }
  root.dataset.pngBytes = String(image.size);
  root.dataset.verification = "passed";
}

async function initialize() {
  [metadata, land] = await Promise.all([
    fetchAsset("./data/manifest.json"), fetchAsset("./data/land.geojson"),
  ]);
  const {grid} = metadata;
  const data = await Promise.all(metadata.frames.map(frame => fetchAsset("./data/" + frame.file, "binary")));
  frames = data.map(buffer => unpack(buffer, grid.width * grid.height));
  id("run").textContent = "GFS cycle " + timeLabel(metadata.run) + " · 0.25° grid";
  lead.min = metadata.frames[0].hour;
  lead.max = metadata.frames.at(-1).hour;
  lead.value = lead.min;
  resizeMap();
  let check;
  try {
    const count = matchMedia("(max-width: 600px)").matches ? 4200 : 9000;
    renderer = new ParticleRenderer(particleCanvas, grid, frames, metadata.encoding.scaleMetersPerSecond, count);
    root.dataset.renderer = "webgl2";
    check = runParticleCheck();
  } catch (error) {
    renderer = null;
    id("check-state").textContent = "WebGL 2 unavailable";
    id("check-state").dataset.result = "failed";
    showError(error.message);
  }
  updateLead();
  setupControls();
  new ResizeObserver(resizeMap).observe(map);
  root.dataset.state = "ready";
  if (verifyMode) await verifyInBrowser(check);
  else requestAnimationFrame(animate);
}

initialize().catch(error => {
  root.dataset.state = "failed";
  root.dataset.verification = "failed";
  showError(error.message);
  console.error(error);
});
