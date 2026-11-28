/**
 * BEAN FX — M48-I WebGL2 grading pass for the Program Monitor.
 *
 * Applies the SAME math as src/lib/color/grade-model.ts (shader body
 * generated from that file) plus an optional user LUT as a 3D texture —
 * user LUT FIRST, then the primary grade, exactly like the export's
 * baked cube. If WebGL2 is unavailable the caller falls back to the CPU
 * model (same formulas) instead of showing an ungraded preview.
 */
"use client";
import type { GradeParams } from "@/lib/color/grade-model";
import { gradeShaderBody } from "@/lib/color/grade-model";
import { parseCube, type CubeLut } from "@/lib/color/lut3d";

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2((pos.x + 1.0) * 0.5, (pos.y + 1.0) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG_HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform bool uHasLut;
uniform bool uBypass;
uniform float uExposure, uTemperature, uTint, uContrast, uPivot, uHighlights, uShadows, uWhites, uBlacks, uSaturation, uVibrance;
uniform vec3 uLift, uGamma, uGain, uRgbGain;
`;

const FRAG_MAIN = `
void main() {
  vec3 src = texture(uSrc, vec2(uv.x, 1.0 - uv.y)).rgb;
  vec3 c;
  if (uHasLut) {
    vec3 looked = texture(uLut, clamp(src, 0.0, 1.0)).rgb;
    c = gradePixel(looked, uBypass, uExposure, uTemperature, uTint, uContrast, uPivot,
        uHighlights, uShadows, uWhites, uBlacks, uLift, uGamma, uGain, uRgbGain, uSaturation, uVibrance);
  } else {
    c = gradePixel(src, uBypass, uExposure, uTemperature, uTint, uContrast, uPivot,
        uHighlights, uShadows, uWhites, uBlacks, uLift, uGamma, uGain, uRgbGain, uSaturation, uVibrance);
  }
  outColor = vec4(c, 1.0);
}`;

export class GradeRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private srcTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutSize = 0;
  readonly available: boolean;

  readonly canvas: HTMLCanvasElement;

  constructor() {
    // Offscreen GL canvas the caller composes (monitor: ctx.filter over it).
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      this.available = false;
      return;
    }
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
      }
      return sh;
    };
    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_HEAD + gradeShaderBody() + FRAG_MAIN));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
      }
      this.program = prog;
      gl.useProgram(prog);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const name of [
        "uSrc", "uLut", "uHasLut", "uBypass", "uExposure", "uTemperature", "uTint", "uContrast", "uPivot",
        "uHighlights", "uShadows", "uWhites", "uBlacks", "uSaturation", "uVibrance",
        "uLift", "uGamma", "uGain", "uRgbGain",
      ]) {
        this.uniforms[name] = gl.getUniformLocation(prog, name);
      }
      this.srcTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(this.uniforms.uSrc, 0);
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  setGrade(p: GradeParams): void {
    const gl = this.gl;
    if (!gl || !this.available) return;
    gl.useProgram(this.program!);
    gl.uniform1i(this.uniforms.uHasLut, this.lutSize > 0 ? 1 : 0);
    gl.uniform1i(this.uniforms.uBypass, p.bypass ? 1 : 0);
    gl.uniform1f(this.uniforms.uExposure, p.exposure);
    gl.uniform1f(this.uniforms.uTemperature, p.temperature);
    gl.uniform1f(this.uniforms.uTint, p.tint);
    gl.uniform1f(this.uniforms.uContrast, p.contrast);
    gl.uniform1f(this.uniforms.uPivot, p.pivot);
    gl.uniform1f(this.uniforms.uHighlights, p.highlights);
    gl.uniform1f(this.uniforms.uShadows, p.shadows);
    gl.uniform1f(this.uniforms.uWhites, p.whites);
    gl.uniform1f(this.uniforms.uBlacks, p.blacks);
    gl.uniform1f(this.uniforms.uSaturation, p.saturation);
    gl.uniform1f(this.uniforms.uVibrance, p.vibrance);
    gl.uniform3f(this.uniforms.uLift, p.liftR, p.liftG, p.liftB);
    gl.uniform3f(this.uniforms.uGamma, p.gammaR, p.gammaG, p.gammaB);
    gl.uniform3f(this.uniforms.uGain, p.gainR, p.gainG, p.gainB);
    gl.uniform3f(this.uniforms.uRgbGain, p.red, p.green, p.blue);
  }

  /** Upload a parsed cube as a 3D texture. `setGrade` must run after this. */
  setLut(cube: CubeLut): void {
    const gl = this.gl;
    if (!gl || !this.available) return;
    if (!this.lutTex) this.lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // WebGL3D texture slices along z = blue; .cube order is b-slowest — direct.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, cube.size, cube.size, cube.size, 0, gl.RGB, gl.FLOAT, cube.table);
    gl.uniform1i(this.uniforms.uLut, 1);
    this.lutSize = cube.size;
    gl.useProgram(this.program!);
    gl.uniform1i(this.uniforms.uHasLut, 1);
  }

  clearLut(): void {
    this.lutSize = 0;
  }

  /** Draw one frame from a video/canvas source onto the grading canvas. */
  render(source: HTMLVideoElement | HTMLCanvasElement): void {
    const gl = this.gl;
    if (!gl || !this.available) return;
    const sw = (source as HTMLVideoElement).videoWidth ?? (source as HTMLCanvasElement).width;
    const sh = (source as HTMLVideoElement).videoHeight ?? (source as HTMLCanvasElement).height;
    if (sw && sh && (this.canvas.width !== sw || this.canvas.height !== sh)) {
      this.canvas.width = sw;
      this.canvas.height = sh;
    }
    const w = this.canvas.width, h = this.canvas.height;
    if (w === 0 || h === 0) return;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/** Fetch + parse a project LUT for the preview texture (cached per id). */
const lutCache = new Map<string, Promise<CubeLut | null>>();
export function fetchPreviewLut(projectId: string, lutId: string): Promise<CubeLut | null> {
  const key = `${projectId}:${lutId}`;
  let p = lutCache.get(key);
  if (!p) {
    p = fetch(`/api/editor/projects/${projectId}/luts/${lutId}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => {
        const parsed = parseCube(t);
        return parsed.kind === "3d" ? parsed : null;
      })
      .catch(() => null);
    lutCache.set(key, p);
  }
  return p;
}
