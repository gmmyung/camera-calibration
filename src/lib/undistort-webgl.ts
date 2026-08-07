import type { CalibrationResultV1 } from "../domain/types";

const VERTEX_SHADER = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

out vec2 videoCoordinate;

void main() {
  vec2 position = POSITIONS[gl_VertexID];
  videoCoordinate = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 videoCoordinate;
out vec4 outputColor;

uniform sampler2D videoTexture;
uniform vec2 sourceSize;
uniform vec2 focalLength;
uniform vec2 principalPoint;
uniform float skew;
uniform vec4 distortion;
uniform float radialK3;
uniform int lensModel;

vec2 standardDistortion(vec2 point) {
  float radius2 = dot(point, point);
  float radius4 = radius2 * radius2;
  float radius6 = radius4 * radius2;
  float radial = 1.0
    + distortion.x * radius2
    + distortion.y * radius4
    + radialK3 * radius6;
  float xy2 = 2.0 * point.x * point.y;
  return vec2(
    point.x * radial + distortion.z * xy2 + distortion.w * (radius2 + 2.0 * point.x * point.x),
    point.y * radial + distortion.z * (radius2 + 2.0 * point.y * point.y) + distortion.w * xy2
  );
}

vec2 fisheyeDistortion(vec2 point) {
  float radius = length(point);
  if (radius < 0.0000001) return point;
  float theta = atan(radius);
  float theta2 = theta * theta;
  float theta4 = theta2 * theta2;
  float theta6 = theta4 * theta2;
  float theta8 = theta4 * theta4;
  float thetaDistorted = theta * (
    1.0
    + distortion.x * theta2
    + distortion.y * theta4
    + distortion.z * theta6
    + distortion.w * theta8
  );
  return point * (thetaDistorted / radius);
}

void main() {
  vec2 destinationPixel = vec2(
    videoCoordinate.x * sourceSize.x,
    (1.0 - videoCoordinate.y) * sourceSize.y
  ) - vec2(0.5);
  float normalizedY = (destinationPixel.y - principalPoint.y) / focalLength.y;
  float normalizedX = (
    destinationPixel.x - principalPoint.x - skew * normalizedY
  ) / focalLength.x;
  vec2 normalized = vec2(normalizedX, normalizedY);
  vec2 distorted = lensModel == 0
    ? standardDistortion(normalized)
    : fisheyeDistortion(normalized);
  vec2 sourcePixel = vec2(
    focalLength.x * distorted.x + skew * distorted.y + principalPoint.x,
    focalLength.y * distorted.y + principalPoint.y
  );
  vec2 sampleCoordinate = (sourcePixel + vec2(0.5)) / sourceSize;
  if (
    sampleCoordinate.x < 0.0 || sampleCoordinate.x > 1.0 ||
    sampleCoordinate.y < 0.0 || sampleCoordinate.y > 1.0
  ) {
    outputColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outputColor = texture(videoTexture, sampleCoordinate);
}
`;

export interface FrameCalibrationUniforms {
  focalLength: [number, number];
  principalPoint: [number, number];
  skew: number;
  distortion: [number, number, number, number];
  radialK3: number;
  lensModel: 0 | 1;
}

export function frameCalibrationUniforms(
  result: CalibrationResultV1,
  width: number,
  height: number,
): FrameCalibrationUniforms {
  if (width <= 0 || height <= 0 || result.imageSize.width <= 0 || result.imageSize.height <= 0) {
    throw new Error("The undistortion preview has invalid image dimensions.");
  }
  const scaleX = width / result.imageSize.width;
  const scaleY = height / result.imageSize.height;
  const fx = result.cameraMatrix[0];
  const matrixSkew = result.cameraMatrix[1];
  const cx = result.cameraMatrix[2];
  const fy = result.cameraMatrix[4];
  const cy = result.cameraMatrix[5];
  if (![fx, matrixSkew, cx, fy, cy, ...result.distortion].every(Number.isFinite)) {
    throw new Error("The calibration contains non-finite values.");
  }
  if (fx <= 0 || fy <= 0) throw new Error("The calibration has invalid focal lengths.");
  if (result.model === "pinhole-radtan5") {
    if (result.distortion.length !== 5) {
      throw new Error("Standard-lens preview requires five distortion coefficients.");
    }
    return {
      focalLength: [fx * scaleX, fy * scaleY],
      principalPoint: [cx * scaleX, cy * scaleY],
      skew: matrixSkew * scaleX,
      distortion: [
        result.distortion[0]!,
        result.distortion[1]!,
        result.distortion[2]!,
        result.distortion[3]!,
      ],
      radialK3: result.distortion[4]!,
      lensModel: 0,
    };
  }
  if (result.distortion.length !== 4) {
    throw new Error("Fisheye preview requires four distortion coefficients.");
  }
  return {
    focalLength: [fx * scaleX, fy * scaleY],
    principalPoint: [cx * scaleX, cy * scaleY],
    skew: matrixSkew * scaleX,
    distortion: result.distortion as [number, number, number, number],
    radialK3: 0,
    lensModel: 1,
  };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: typeof gl.VERTEX_SHADER | typeof gl.FRAGMENT_SHADER,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL could not create an undistortion shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(`WebGL could not compile the undistortion shader: ${message}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("WebGL could not create the undistortion program.");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown shader link error.";
    gl.deleteProgram(program);
    throw new Error(`WebGL could not link the undistortion program: ${message}`);
  }
  return program;
}

function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`WebGL did not expose the ${name} uniform.`);
  return location;
}

interface UniformLocations {
  videoTexture: WebGLUniformLocation;
  sourceSize: WebGLUniformLocation;
  focalLength: WebGLUniformLocation;
  principalPoint: WebGLUniformLocation;
  skew: WebGLUniformLocation;
  distortion: WebGLUniformLocation;
  radialK3: WebGLUniformLocation;
  lensModel: WebGLUniformLocation;
}

function previewCanvasSize(
  canvas: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
): [number, number] {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const availableWidth = Math.max(1, canvas.clientWidth * pixelRatio);
  const availableHeight = Math.max(1, canvas.clientHeight * pixelRatio);
  const scale = Math.min(1, availableWidth / sourceWidth, availableHeight / sourceHeight);
  return [
    Math.max(1, Math.round(sourceWidth * scale)),
    Math.max(1, Math.round(sourceHeight * scale)),
  ];
}

export class WebGlUndistortRenderer {
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly uniforms: UniformLocations;
  private textureWidth = 0;
  private textureHeight = 0;
  private disposed = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
  ) {
    const program = createProgram(gl);
    const texture = gl.createTexture();
    const vertexArray = gl.createVertexArray();
    try {
      if (!texture || !vertexArray) {
        throw new Error("WebGL could not allocate preview resources.");
      }
      this.uniforms = {
        videoTexture: requireUniform(gl, program, "videoTexture"),
        sourceSize: requireUniform(gl, program, "sourceSize"),
        focalLength: requireUniform(gl, program, "focalLength"),
        principalPoint: requireUniform(gl, program, "principalPoint"),
        skew: requireUniform(gl, program, "skew"),
        distortion: requireUniform(gl, program, "distortion"),
        radialK3: requireUniform(gl, program, "radialK3"),
        lensModel: requireUniform(gl, program, "lensModel"),
      };
    } catch (error) {
      gl.deleteProgram(program);
      if (texture) gl.deleteTexture(texture);
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      throw error;
    }
    this.program = program;
    this.texture = texture;
    this.vertexArray = vertexArray;

    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.videoTexture, 0);
    gl.bindVertexArray(vertexArray);
  }

  static create(canvas: HTMLCanvasElement): WebGlUndistortRenderer | undefined {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    return gl ? new WebGlUndistortRenderer(canvas, gl) : undefined;
  }

  render(video: HTMLVideoElement, result: CalibrationResultV1): void {
    if (this.disposed) throw new Error("The WebGL preview renderer was disposed.");
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;
    if (this.gl.isContextLost()) throw new Error("The WebGL preview context was lost.");

    const [canvasWidth, canvasHeight] = previewCanvasSize(
      this.canvas,
      sourceWidth,
      sourceHeight,
    );
    if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
    }

    const calibration = frameCalibrationUniforms(result, sourceWidth, sourceHeight);
    const gl = this.gl;
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureWidth !== sourceWidth || this.textureHeight !== sourceHeight) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video,
      );
      this.textureWidth = sourceWidth;
      this.textureHeight = sourceHeight;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }
    gl.uniform2f(this.uniforms.sourceSize, sourceWidth, sourceHeight);
    gl.uniform2f(this.uniforms.focalLength, ...calibration.focalLength);
    gl.uniform2f(this.uniforms.principalPoint, ...calibration.principalPoint);
    gl.uniform1f(this.uniforms.skew, calibration.skew);
    gl.uniform4f(this.uniforms.distortion, ...calibration.distortion);
    gl.uniform1f(this.uniforms.radialK3, calibration.radialK3);
    gl.uniform1i(this.uniforms.lensModel, calibration.lensModel);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteProgram(this.program);
  }
}
