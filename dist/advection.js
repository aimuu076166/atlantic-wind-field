const EARTH_RADIUS = 6371000;
const RADIANS = Math.PI / 180;

const updateVertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aPosition;
uniform highp isampler2D uWindA;
uniform highp isampler2D uWindB;
uniform ivec2 uSize;
uniform vec2 uSpacing;
uniform float uSouth;
uniform float uDecode;
uniform float uMix;
uniform float uSeconds;
uniform int uTick;
uniform bool uRespawn;
out vec2 vPosition;

vec2 sampleWind(highp isampler2D field, vec2 position) {
  vec2 bounded = clamp(position, vec2(0.0), vec2(uSize - 1));
  ivec2 lo = ivec2(floor(bounded));
  ivec2 hi = min(lo + ivec2(1), uSize - 1);
  vec2 f = fract(bounded);
  vec2 a = vec2(texelFetch(field, lo, 0).rg);
  vec2 b = vec2(texelFetch(field, ivec2(hi.x, lo.y), 0).rg);
  vec2 c = vec2(texelFetch(field, ivec2(lo.x, hi.y), 0).rg);
  vec2 d = vec2(texelFetch(field, hi, 0).rg);
  return uDecode * mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float random01(uint value) {
  value ^= value >> 16;
  value *= 0x7feb352du;
  value ^= value >> 15;
  value *= 0x846ca68bu;
  value ^= value >> 16;
  return float(value & 65535u) / 65536.0;
}

void main() {
  vec2 velocity = mix(sampleWind(uWindA, aPosition), sampleWind(uWindB, aPosition), uMix);
  float latitude = radians(uSouth + aPosition.y * uSpacing.y);
  vec2 metersPerCell = 6371000.0 * radians(uSpacing) * vec2(cos(latitude), 1.0);
  vec2 next = aPosition + (velocity * uSeconds) / metersPerCell;
  vec2 limit = vec2(uSize - 1);
  bool outside = any(lessThan(next, vec2(0.0))) || any(greaterThan(next, limit));
  bool expired = (gl_VertexID + uTick) % 241 == 0;
  if (uRespawn && (outside || expired)) {
    uint seed = uint(gl_VertexID) * 747796405u + uint(uTick) * 2891336453u;
    next = vec2(random01(seed), random01(seed ^ 145397u)) * limit;
  }
  vPosition = next;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}`;

const emptyFragment = `#version 300 es
precision mediump float;
out vec4 color;
void main() { color = vec4(0.0); }`;

const drawVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 aOld;
layout(location=1) in vec2 aNew;
uniform vec2 uSpan;
uniform vec2 uSpacing;
uniform float uSouth;
uniform float uSeconds;
out vec4 vColor;
void main() {
  vec2 step = aNew - aOld;
  float latitude = radians(uSouth + aNew.y * uSpacing.y);
  vec2 metersPerCell = 6371000.0 * radians(uSpacing) * vec2(cos(latitude), 1.0);
  float speed = length(step * metersPerCell) / uSeconds;
  float colorIndex = clamp(speed / 20.0, 0.0, 1.0);
  vec3 slow = vec3(0.38, 0.74, 0.90);
  vec3 medium = vec3(0.55, 0.90, 0.75);
  vec3 fast = vec3(1.0, 0.83, 0.50);
  vec3 tint = mix(mix(slow, medium, min(2.0 * colorIndex, 1.0)),
                  fast, max(2.0 * colorIndex - 1.0, 0.0));
  float point = float(gl_VertexID);
  bool respawned = speed > 120.0;
  vec2 position = aNew - step * (1.0 - point) * 9.0;
  vColor = vec4(tint, respawned ? 0.0 : mix(0.06, 0.88, point));
  gl_Position = vec4(2.0 * position / uSpan - 1.0, 0.0, 1.0);
}`;

const drawFragment = `#version 300 es
precision mediump float;
in highp vec4 vColor;
out vec4 color;
void main() { color = vColor; }`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const details = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader compile failed: " + details);
  }
  return shader;
}

function link(gl, vertex, fragment, uniforms, feedback = []) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  if (feedback.length) gl.transformFeedbackVaryings(program, feedback, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("Program link failed: " + gl.getProgramInfoLog(program));
  }
  const locations = Object.fromEntries(uniforms.map(name => [name, gl.getUniformLocation(program, name)]));
  return {program, locations};
}

function makeStateBuffer(gl, values) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_COPY);
  return buffer;
}

function makeTexture(gl, grid, values) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16I, grid.width, grid.height, 0,
                gl.RG_INTEGER, gl.SHORT, values);
  return texture;
}

export class ParticleRenderer {
  constructor(canvas, grid, frames, scale, count) {
    const gl = canvas.getContext("webgl2", {alpha: true, antialias: false});
    if (!gl) throw new Error("This browser could not initialize WebGL 2.");
    this.gl = gl;
    this.grid = grid;
    this.scale = scale;
    this.count = count;
    this.tick = 0;
    this.current = 0;
    this.seconds = 150;
    this.windTextures = frames.map(frame => makeTexture(gl, grid, frame));
    this.updateProgram = link(gl, updateVertex, emptyFragment,
      ["uWindA", "uWindB", "uSize", "uSpacing", "uSouth", "uDecode",
       "uMix", "uSeconds", "uTick", "uRespawn"], ["vPosition"]);
    this.drawProgram = link(gl, drawVertex, drawFragment, ["uSpan", "uSpacing", "uSouth", "uSeconds"]);
    this.updateVAO = gl.createVertexArray();
    this.drawVAO = gl.createVertexArray();
    this.feedback = gl.createTransformFeedback();
    const seed = new Float32Array(count * 2);
    for (let i = 0; i < seed.length; i += 2) {
      seed[i] = Math.random() * (grid.width - 1);
      seed[i + 1] = Math.random() * (grid.height - 1);
    }
    this.positions = [makeStateBuffer(gl, seed), makeStateBuffer(gl, seed)];
  }

  advance(source, destination, textures, grid, mix, seconds, count, respawn) {
    const gl = this.gl;
    const {program, locations: u} = this.updateProgram;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textures[1]);
    gl.uniform1i(u.uWindA, 0);
    gl.uniform1i(u.uWindB, 1);
    gl.uniform2i(u.uSize, grid.width, grid.height);
    gl.uniform2f(u.uSpacing, grid.dx, grid.dy);
    gl.uniform1f(u.uSouth, grid.south);
    gl.uniform1f(u.uDecode, this.scale);
    gl.uniform1f(u.uMix, mix);
    gl.uniform1f(u.uSeconds, seconds);
    gl.uniform1i(u.uTick, this.tick);
    gl.uniform1i(u.uRespawn, Number(respawn));

    gl.bindVertexArray(this.updateVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, source);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, destination);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
  }

  step(selection) {
    const next = 1 - this.current;
    this.advance(this.positions[this.current], this.positions[next],
      [this.windTextures[selection.left], this.windTextures[selection.right]],
      this.grid, selection.mix, this.seconds, this.count, true);
    this.current = next;
    this.tick += 1;
  }

  draw() {
    const gl = this.gl;
    const {program, locations: u} = this.drawProgram;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.uniform2f(u.uSpan, this.grid.width - 1, this.grid.height - 1);
    gl.uniform2f(u.uSpacing, this.grid.dx, this.grid.dy);
    gl.uniform1f(u.uSouth, this.grid.south);
    gl.uniform1f(u.uSeconds, this.seconds);
    gl.bindVertexArray(this.drawVAO);
    const drawBuffers = [this.positions[1 - this.current], this.positions[this.current]];
    for (const [location, buffer] of drawBuffers.entries()) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.drawArraysInstanced(gl.LINES, 0, 2, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  checkDisplacement() {
    const gl = this.gl;
    const grid = {width: 2, height: 2, dx: 0.25, dy: 0.25, south: 30};
    const zero = new Int16Array(8);
    const east = new Int16Array([2000, 0, 2000, 0, 2000, 0, 2000, 0]);
    const seed = new Float32Array([0.25, 0.5]);
    const textures = [makeTexture(gl, grid, zero), makeTexture(gl, grid, east)];
    const buffers = [makeStateBuffer(gl, seed), makeStateBuffer(gl, seed)];
    const measured = new Float32Array(2);
    let source = 0;
    try {
      for (let second = 0; second < 60; second += 1) {
        this.advance(buffers[source], buffers[1 - source], textures, grid, 0.5, 1, 1, false);
        source = 1 - source;
      }
      gl.bindBuffer(gl.COPY_READ_BUFFER, buffers[source]);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, measured);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      const latitude = RADIANS * (grid.south + seed[1] * grid.dy);
      const north = (measured[1] - seed[1]) * EARTH_RADIUS * RADIANS * grid.dy;
      const eastward = (measured[0] - seed[0]) * EARTH_RADIUS * RADIANS * grid.dx * Math.cos(latitude);
      const glError = gl.getError();
      return {east: eastward, north, glError,
        passed: Math.abs(eastward - 600) <= 1 && Math.abs(north) <= 1 && glError === gl.NO_ERROR};
    } finally {
      for (const texture of textures) gl.deleteTexture(texture);
      for (const buffer of buffers) gl.deleteBuffer(buffer);
    }
  }
}
