/**
 * WebXR Raw Camera Access reader.
 *
 * Inside an XR frame callback, grabs the camera image texture via
 * XRWebGLBinding.getCameraImage(view.camera), downsamples it into a small
 * RGBA framebuffer with a one-quad shader, and reads it back so the hand
 * worker can run MediaPipe on the real XR camera frame (no stale DOM video).
 * Fully synchronous and bounded; any failure just returns null.
 */
export function rawCameraApiAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const B = (window as unknown as { XRWebGLBinding?: { prototype: { getCameraImage?: unknown } } }).XRWebGLBinding;
  return !!B && typeof B.prototype?.getCameraImage === "function";
}

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
// Flip Y so readPixels rows come out top-down (image order).
const FS = `#version 300 es
precision mediump float; in vec2 uv; uniform sampler2D t; out vec4 c;
void main(){ c = texture(t, vec2(uv.x, 1.0-uv.y)); }`;

export class XRCameraReader {
  private binding: any = null;
  private session: XRSession | null = null;
  private prog: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private target: WebGLTexture | null = null;
  private w = 0;
  private h = 0;
  private failed = false;

  constructor(private gl: WebGL2RenderingContext) {}

  /** Read the current XR camera image. Must be called inside the XR frame callback. */
  read(session: XRSession, frame: XRFrame, ref: XRReferenceSpace, maxW = 384): { pixels: Uint8Array; width: number; height: number } | null {
    if (this.failed) return null;
    const gl = this.gl;
    try {
      const pose = frame.getViewerPose(ref);
      const view = pose?.views?.[0] as (XRView & { camera?: { width: number; height: number } }) | undefined;
      if (!view?.camera) return null;
      if (this.session !== session || !this.binding) {
        const B = (window as any).XRWebGLBinding;
        this.binding = new B(session, gl);
        this.session = session;
      }
      const tex: WebGLTexture | null = this.binding.getCameraImage(view.camera);
      if (!tex) return null;
      const cw = view.camera.width || 1280, ch = view.camera.height || 720;
      const width = Math.min(maxW, cw), height = Math.max(1, Math.round((width * ch) / cw));
      this.ensure(width, height);

      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevVp = gl.getParameter(gl.VIEWPORT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
      gl.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const loc = gl.getAttribLocation(this.prog!, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.prog!, "t"), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.disableVertexAttribArray(loc);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
      return { pixels, width, height };
    } catch {
      // Never let raw-camera problems affect rendering: disable for this session.
      this.failed = true;
      return null;
    }
  }

  private ensure(w: number, h: number) {
    const gl = this.gl;
    if (!this.prog) {
      const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("raw camera shader failed");
      this.prog = p;
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    }
    if (w === this.w && h === this.h && this.fbo) return;
    if (this.target) gl.deleteTexture(this.target);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    this.w = w; this.h = h;
  }

  reset() { this.binding = null; this.session = null; this.failed = false; }
}
