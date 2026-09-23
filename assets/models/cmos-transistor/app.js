(() => {
  "use strict";

  const canvas = document.getElementById("model-canvas");
  const errorBox = document.getElementById("webgl-error");
  const labelsRoot = document.getElementById("model-labels");
  const viewTitle = document.getElementById("view-title");
  const viewDescription = document.getElementById("view-description");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    depth: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false
  });

  if (!gl) {
    errorBox.hidden = false;
    return;
  }

  const palette = {
    background: "#1b242d",
    substrate: "#45505e",
    diffusion: "#2b3848",
    oxide: "#d9e2e9",
    gate: "#5e71e3",
    dielectric: "#0e9fde",
    outline: "#a2b5d5",
    grid: "#364453",
    section: "#a0c8e8"
  };

  const vertexShaderSource = `
    attribute vec3 a_position;
    attribute vec3 a_normal;
    uniform mat4 u_viewProjection;
    varying vec3 v_worldPosition;
    varying vec3 v_normal;
    void main() {
      v_worldPosition = a_position;
      v_normal = a_normal;
      gl_Position = u_viewProjection * vec4(a_position, 1.0);
    }
  `;

  const fragmentShaderSource = `
    precision highp float;
    uniform vec3 u_color;
    uniform vec3 u_camera;
    uniform vec3 u_lightDirection;
    uniform float u_alpha;
    uniform float u_noise;
    uniform float u_specular;
    uniform float u_emissive;
    uniform float u_isLine;
    varying vec3 v_worldPosition;
    varying vec3 v_normal;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.12, 0.19, 0.27));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    void main() {
      if (u_isLine > 0.5) {
        gl_FragColor = vec4(u_color, u_alpha);
        return;
      }
      vec3 normal = normalize(v_normal);
      vec3 lightDirection = normalize(u_lightDirection);
      float diffuse = max(dot(normal, lightDirection), 0.0);
      float halfLambert = 0.34 + diffuse * 0.66;
      vec3 viewDirection = normalize(u_camera - v_worldPosition);
      vec3 halfDirection = normalize(lightDirection + viewDirection);
      float highlight = pow(max(dot(normal, halfDirection), 0.0), 34.0) * u_specular;
      float grain = (hash(floor(v_worldPosition * 31.0)) - 0.5) * u_noise;
      vec3 shaded = u_color * (halfLambert + grain + u_emissive * 0.24);
      shaded += vec3(highlight) + u_color * u_emissive * 0.12;
      gl_FragColor = vec4(shaded, u_alpha);
    }
  `;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || "Shader compilation failed");
    }
    return shader;
  }

  function createProgram() {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShaderSource));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "WebGL program link failed");
    }
    return program;
  }

  let program;
  try {
    program = createProgram();
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = "The 3D model could not start in this browser.";
    return;
  }

  const locations = {
    position: gl.getAttribLocation(program, "a_position"),
    normal: gl.getAttribLocation(program, "a_normal"),
    viewProjection: gl.getUniformLocation(program, "u_viewProjection"),
    color: gl.getUniformLocation(program, "u_color"),
    camera: gl.getUniformLocation(program, "u_camera"),
    lightDirection: gl.getUniformLocation(program, "u_lightDirection"),
    alpha: gl.getUniformLocation(program, "u_alpha"),
    noise: gl.getUniformLocation(program, "u_noise"),
    specular: gl.getUniformLocation(program, "u_specular"),
    emissive: gl.getUniformLocation(program, "u_emissive"),
    isLine: gl.getUniformLocation(program, "u_isLine")
  };

  const meshes = [];
  const visibleLayers = new Map([
    ["gate", true],
    ["dielectric", true],
    ["diffusion", true],
    ["oxide", true],
    ["substrate", true]
  ]);
  let hoverLayer = null;
  let currentView = "iso";
  let labelsVisible = true;
  let activeViewProjection = identity();

  const viewCopy = {
    iso: {
      title: "3D cutaway",
      description: "A center cutaway exposes the source, channel, drain, dielectric, and gate while preserving their depth."
    },
    cross: {
      title: "Orthographic cross-section",
      description: "The A—A′ section passes through the center of the active region, from source through channel to drain."
    },
    top: {
      title: "Orthographic top view",
      description: "The polysilicon gate crosses the active diffusion. The A—A′ line marks the exact cross-section plane."
    }
  };

  const cameraPresets = {
    iso: {
      position: [7.4, 4.15, 9.0],
      target: [0, -0.38, -0.48],
      up: [0, 1, 0],
      projection: "perspective",
      orthoScale: 3.0
    },
    cross: {
      position: [0, -0.28, 11.4],
      target: [0, -0.38, 0],
      up: [0, 1, 0],
      projection: "ortho",
      orthoScale: 2.68
    },
    top: {
      position: [0, 11.2, 0.001],
      target: [0, -0.06, 0],
      up: [0, 0, -1],
      projection: "ortho",
      orthoScale: 2.75
    }
  };

  let camera = cloneCamera(cameraPresets.iso);
  let cameraAnimation = null;

  function cloneCamera(source) {
    return {
      position: source.position.slice(),
      target: source.target.slice(),
      up: source.up.slice(),
      projection: source.projection,
      orthoScale: source.orthoScale
    };
  }

  function hexToRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [
      ((value >> 16) & 255) / 255,
      ((value >> 8) & 255) / 255,
      (value & 255) / 255
    ];
  }

  function vecAdd(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function vecSub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function vecScale(a, scale) {
    return [a[0] * scale, a[1] * scale, a[2] * scale];
  }

  function vecDot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function vecCross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function vecLength(a) {
    return Math.hypot(a[0], a[1], a[2]);
  }

  function vecNormalize(a) {
    const length = vecLength(a) || 1;
    return [a[0] / length, a[1] / length, a[2] / length];
  }

  function vecLerp(a, b, amount) {
    return [
      a[0] + (b[0] - a[0]) * amount,
      a[1] + (b[1] - a[1]) * amount,
      a[2] + (b[2] - a[2]) * amount
    ];
  }

  function identity() {
    return new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);
  }

  function matMultiply(a, b) {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[0 * 4 + row] * b[column * 4 + 0] +
          a[1 * 4 + row] * b[column * 4 + 1] +
          a[2 * 4 + row] * b[column * 4 + 2] +
          a[3 * 4 + row] * b[column * 4 + 3];
      }
    }
    return out;
  }

  function perspective(fovRadians, aspect, near, far) {
    const f = 1 / Math.tan(fovRadians / 2);
    const range = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * range, -1,
      0, 0, 2 * far * near * range, 0
    ]);
  }

  function orthographic(left, right, bottom, top, near, far) {
    return new Float32Array([
      2 / (right - left), 0, 0, 0,
      0, 2 / (top - bottom), 0, 0,
      0, 0, -2 / (far - near), 0,
      -(right + left) / (right - left),
      -(top + bottom) / (top - bottom),
      -(far + near) / (far - near),
      1
    ]);
  }

  function lookAt(eye, center, up) {
    const z = vecNormalize(vecSub(eye, center));
    let x = vecCross(up, z);
    if (vecLength(x) < 0.0001) {
      x = vecCross([0, 0, 1], z);
    }
    x = vecNormalize(x);
    const y = vecCross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -vecDot(x, eye), -vecDot(y, eye), -vecDot(z, eye), 1
    ]);
  }

  function transformPoint(matrix, point) {
    const x = point[0];
    const y = point[1];
    const z = point[2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return [
      (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
      (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
      (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
      w
    ];
  }

  function polygonArea(points) {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const next = (index + 1) % points.length;
      area += points[index][0] * points[next][1] - points[next][0] * points[index][1];
    }
    return area * 0.5;
  }

  function pointInTriangle(point, a, b, c) {
    const sign = (p1, p2, p3) =>
      (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = sign(point, a, b);
    const d2 = sign(point, b, c);
    const d3 = sign(point, c, a);
    const hasNegative = d1 < -1e-7 || d2 < -1e-7 || d3 < -1e-7;
    const hasPositive = d1 > 1e-7 || d2 > 1e-7 || d3 > 1e-7;
    return !(hasNegative && hasPositive);
  }

  function triangulate(points) {
    const indices = points.map((_, index) => index);
    const triangles = [];
    let guard = 0;
    while (indices.length > 3 && guard < 500) {
      let clipped = false;
      for (let slot = 0; slot < indices.length; slot += 1) {
        const previous = indices[(slot - 1 + indices.length) % indices.length];
        const current = indices[slot];
        const next = indices[(slot + 1) % indices.length];
        const a = points[previous];
        const b = points[current];
        const c = points[next];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (cross <= 1e-8) continue;
        let containsPoint = false;
        for (const candidate of indices) {
          if (candidate === previous || candidate === current || candidate === next) continue;
          if (pointInTriangle(points[candidate], a, b, c)) {
            containsPoint = true;
            break;
          }
        }
        if (!containsPoint) {
          triangles.push([previous, current, next]);
          indices.splice(slot, 1);
          clipped = true;
          break;
        }
      }
      if (!clipped) break;
      guard += 1;
    }
    if (indices.length === 3) triangles.push(indices.slice());
    if (!triangles.length) {
      for (let index = 1; index < points.length - 1; index += 1) {
        triangles.push([0, index, index + 1]);
      }
    }
    return triangles;
  }

  function addTriangle(data, a, b, c, normal) {
    data.positions.push(...a, ...b, ...c);
    data.normals.push(...normal, ...normal, ...normal);
  }

  function extrudePolygon(sourcePoints, zMinimum, zMaximum) {
    const points = polygonArea(sourcePoints) < 0 ? sourcePoints.slice().reverse() : sourcePoints.slice();
    const faces = triangulate(points);
    const data = { positions: [], normals: [] };
    for (const [a, b, c] of faces) {
      addTriangle(
        data,
        [points[a][0], points[a][1], zMaximum],
        [points[b][0], points[b][1], zMaximum],
        [points[c][0], points[c][1], zMaximum],
        [0, 0, 1]
      );
      addTriangle(
        data,
        [points[c][0], points[c][1], zMinimum],
        [points[b][0], points[b][1], zMinimum],
        [points[a][0], points[a][1], zMinimum],
        [0, 0, -1]
      );
    }
    for (let index = 0; index < points.length; index += 1) {
      const next = (index + 1) % points.length;
      const a = points[index];
      const b = points[next];
      const edgeX = b[0] - a[0];
      const edgeY = b[1] - a[1];
      const normal = vecNormalize([edgeY, -edgeX, 0]);
      const aBack = [a[0], a[1], zMinimum];
      const bBack = [b[0], b[1], zMinimum];
      const bFront = [b[0], b[1], zMaximum];
      const aFront = [a[0], a[1], zMaximum];
      addTriangle(data, aBack, bBack, bFront, normal);
      addTriangle(data, aBack, bFront, aFront, normal);
    }
    return data;
  }

  function box(xMinimum, xMaximum, yMinimum, yMaximum, zMinimum, zMaximum) {
    return extrudePolygon([
      [xMinimum, yMinimum],
      [xMaximum, yMinimum],
      [xMaximum, yMaximum],
      [xMinimum, yMaximum]
    ], zMinimum, zMaximum);
  }

  function outlineExtrusion(sourcePoints, zMinimum, zMaximum) {
    const points = sourcePoints.slice();
    const positions = [];
    const normals = [];
    function line(a, b) {
      positions.push(...a, ...b);
      normals.push(0, 1, 0, 0, 1, 0);
    }
    for (let index = 0; index < points.length; index += 1) {
      const next = (index + 1) % points.length;
      const frontA = [points[index][0], points[index][1], zMaximum];
      const frontB = [points[next][0], points[next][1], zMaximum];
      const backA = [points[index][0], points[index][1], zMinimum];
      const backB = [points[next][0], points[next][1], zMinimum];
      line(frontA, frontB);
      line(backA, backB);
      line(frontA, backA);
    }
    return { positions, normals };
  }

  function lineGeometry(lines) {
    const positions = [];
    const normals = [];
    for (const [a, b] of lines) {
      positions.push(...a, ...b);
      normals.push(0, 1, 0, 0, 1, 0);
    }
    return { positions, normals };
  }

  function addMesh(geometry, options) {
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.positions), gl.STATIC_DRAW);
    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geometry.normals), gl.STATIC_DRAW);
    meshes.push({
      positionBuffer,
      normalBuffer,
      count: geometry.positions.length / 3,
      primitive: options.primitive || "triangles",
      groups: options.groups || ["iso", "cross", "top"],
      layer: options.layer || "guide",
      color: hexToRgb(options.color),
      alpha: options.alpha ?? 1,
      noise: options.noise ?? 0,
      specular: options.specular ?? 0.08,
      outline: options.primitive === "lines"
    });
  }

  function addSolid(points, zMinimum, zMaximum, options) {
    addMesh(extrudePolygon(points, zMinimum, zMaximum), options);
    addMesh(outlineExtrusion(points, zMinimum, zMaximum), {
      ...options,
      primitive: "lines",
      color: options.outlineColor || palette.outline,
      alpha: options.outlineAlpha ?? 0.2,
      noise: 0,
      specular: 0
    });
  }

  function mirrorPolygon(points) {
    return points.map(([x, y]) => [-x, y]).reverse();
  }

  const shapes = {
    substrate: [
      [-4.25, -2.0],
      [4.25, -2.0],
      [4.25, 0.025],
      [-4.25, 0.025]
    ],
    source: [
      [-3.15, 0.055],
      [-1.05, 0.055],
      [-1.09, -0.18],
      [-1.25, -0.42],
      [-1.56, -0.60],
      [-2.06, -0.70],
      [-2.56, -0.66],
      [-2.90, -0.48],
      [-3.10, -0.22]
    ],
    fieldLeft: [
      [-4.25, 0.015],
      [-1.05, 0.015],
      [-1.05, 0.31],
      [-1.82, 0.31],
      [-2.08, 0.43],
      [-2.33, 0.66],
      [-2.67, 0.79],
      [-3.18, 0.82],
      [-3.68, 0.70],
      [-4.25, 0.55]
    ]
  };
  shapes.drain = mirrorPolygon(shapes.source);
  shapes.fieldRight = mirrorPolygon(shapes.fieldLeft);

  function buildStructure(group, zMinimum, zMaximum) {
    const frontOffset = group === "top" ? 0 : 0.012;
    const diffusionBack = group === "top" ? -1.58 : zMinimum + 0.025;
    const diffusionFront = group === "top" ? 1.58 : zMaximum + frontOffset;
    addSolid(shapes.substrate, zMinimum, zMaximum, {
      groups: [group], layer: "substrate", color: palette.substrate,
      noise: 0.07, specular: 0.06, outlineAlpha: 0.16
    });
    addSolid(shapes.source, diffusionBack, diffusionFront, {
      groups: [group], layer: "diffusion", color: palette.diffusion,
      noise: 0.035, specular: 0.05, outlineAlpha: 0.24
    });
    addSolid(shapes.drain, diffusionBack, diffusionFront, {
      groups: [group], layer: "diffusion", color: palette.diffusion,
      noise: 0.035, specular: 0.05, outlineAlpha: 0.24
    });
    addSolid(shapes.fieldLeft, group === "top" ? -2.06 : zMinimum + 0.03, group === "top" ? 2.06 : zMaximum + 0.022, {
      groups: [group], layer: "oxide", color: palette.oxide,
      noise: 0.045, specular: 0.32, outlineColor: "#ffffff", outlineAlpha: 0.19
    });
    addSolid(shapes.fieldRight, group === "top" ? -2.06 : zMinimum + 0.03, group === "top" ? 2.06 : zMaximum + 0.022, {
      groups: [group], layer: "oxide", color: palette.oxide,
      noise: 0.045, specular: 0.32, outlineColor: "#ffffff", outlineAlpha: 0.19
    });

    let gateBack;
    let gateFront;
    if (group === "top") {
      gateBack = -1.96;
      gateFront = 1.96;
    } else if (group === "cross") {
      gateBack = zMinimum - 0.018;
      gateFront = zMaximum + 0.048;
    } else {
      gateBack = zMinimum + 0.30;
      gateFront = zMaximum + 0.048;
    }
    addSolid([
      [-1.05, 0.035], [1.05, 0.035], [1.05, 0.155], [-1.05, 0.155]
    ], gateBack - 0.05, gateFront + 0.05, {
      groups: [group], layer: "dielectric", color: palette.dielectric,
      noise: 0.015, specular: 0.48, outlineColor: "#a0c8e8", outlineAlpha: 0.34
    });
    addSolid([
      [-0.84, 0.155], [0.84, 0.155], [0.84, 1.10], [-0.84, 1.10]
    ], gateBack, gateFront, {
      groups: [group], layer: "gate", color: palette.gate,
      noise: 0.035, specular: 0.42, outlineColor: "#a2b5d5", outlineAlpha: 0.34
    });
  }

  function buildScene() {
    buildStructure("iso", -2.08, 0.0);
    buildStructure("cross", -0.09, 0.09);
    buildStructure("top", -2.08, 2.08);

    const gridLines = [];
    for (let step = -8; step <= 8; step += 1) {
      const coordinate = step * 0.65;
      gridLines.push([[-5.2, -2.03, coordinate], [5.2, -2.03, coordinate]]);
      gridLines.push([[coordinate, -2.03, -5.2], [coordinate, -2.03, 5.2]]);
    }
    addMesh(lineGeometry(gridLines), {
      groups: ["iso"], layer: "guide", color: palette.grid,
      primitive: "lines", alpha: 0.27
    });

    addMesh(lineGeometry([
      [[-4.2, 1.19, 0], [4.2, 1.19, 0]]
    ]), {
      groups: ["top"], layer: "guide", color: palette.section,
      primitive: "lines", alpha: 0.9
    });
  }

  buildScene();

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function cameraMatrix() {
    const aspect = Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const view = lookAt(camera.position, camera.target, camera.up);
    let projection;
    if (camera.projection === "ortho") {
      const halfHeight = Math.max(camera.orthoScale, 4.6 / aspect);
      const halfWidth = halfHeight * aspect;
      projection = orthographic(-halfWidth, halfWidth, -halfHeight, halfHeight, 0.1, 60);
    } else {
      projection = perspective(38 * Math.PI / 180, aspect, 0.1, 60);
    }
    return matMultiply(projection, view);
  }

  function meshVisible(mesh) {
    if (!mesh.groups.includes(currentView)) return false;
    if (mesh.layer === "guide") return true;
    return visibleLayers.get(mesh.layer) !== false;
  }

  function drawMeshes(isLines) {
    for (const mesh of meshes) {
      if (!meshVisible(mesh) || mesh.outline !== isLines) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positionBuffer);
      gl.enableVertexAttribArray(locations.position);
      gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
      gl.enableVertexAttribArray(locations.normal);
      gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 0, 0);

      gl.uniform3fv(locations.color, mesh.color);
      gl.uniform1f(locations.alpha, mesh.alpha);
      gl.uniform1f(locations.noise, mesh.noise);
      gl.uniform1f(locations.specular, mesh.specular);
      gl.uniform1f(locations.emissive, hoverLayer === mesh.layer ? 0.7 : 0);
      gl.uniform1f(locations.isLine, isLines ? 1 : 0);
      gl.drawArrays(isLines ? gl.LINES : gl.TRIANGLES, 0, mesh.count);
    }
  }

  function updateCameraAnimation(time) {
    if (!cameraAnimation) return;
    const elapsed = time - cameraAnimation.started;
    const amount = Math.min(1, elapsed / cameraAnimation.duration);
    const eased = 1 - Math.pow(1 - amount, 3);
    camera.position = vecLerp(cameraAnimation.from.position, cameraAnimation.to.position, eased);
    camera.target = vecLerp(cameraAnimation.from.target, cameraAnimation.to.target, eased);
    camera.up = vecNormalize(vecLerp(cameraAnimation.from.up, cameraAnimation.to.up, eased));
    camera.orthoScale = cameraAnimation.from.orthoScale +
      (cameraAnimation.to.orthoScale - cameraAnimation.from.orthoScale) * eased;
    camera.projection = cameraAnimation.to.projection;
    if (amount >= 1) {
      camera = cloneCamera(cameraAnimation.to);
      cameraAnimation = null;
    }
  }

  function render(time) {
    resizeCanvas();
    updateCameraAnimation(time);
    activeViewProjection = cameraMatrix();
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    gl.uniformMatrix4fv(locations.viewProjection, false, activeViewProjection);
    gl.uniform3fv(locations.camera, camera.position);
    gl.uniform3fv(locations.lightDirection, vecNormalize([0.45, 0.82, 0.62]));
    drawMeshes(false);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.lineWidth(1);
    drawMeshes(true);
    renderLabels();
    updateOrientationWidget();
    requestAnimationFrame(render);
  }

  const labelDefinitions = {
    iso: [
      { text: "Polysilicon gate", point: [0, 1.08, 0.08], dx: 24, dy: -20, layer: "gate", color: palette.gate },
      { text: "Gate dielectric", point: [0, 0.08, 0.10], dx: 24, dy: 25, layer: "dielectric", color: palette.dielectric },
      { text: "Source (n+)", point: [-2.05, -0.28, 0.06], dx: -26, dy: -12, align: "right", layer: "diffusion", color: palette.diffusion },
      { text: "Drain (n+)", point: [2.05, -0.28, 0.06], dx: 26, dy: -12, layer: "diffusion", color: palette.diffusion },
      { text: "p-type silicon", point: [0, -1.38, 0.03], dx: 26, dy: 18, layer: "substrate", color: palette.substrate }
    ],
    cross: [
      { text: "Gate", point: [0, 0.98, 0.12], dx: 24, dy: -12, layer: "gate", color: palette.gate },
      { text: "SiO₂ gate dielectric", point: [0, 0.09, 0.13], dx: 24, dy: 27, layer: "dielectric", color: palette.dielectric },
      { text: "Source (n+)", point: [-2.08, -0.28, 0.13], dx: -26, dy: -15, align: "right", layer: "diffusion", color: palette.diffusion },
      { text: "Drain (n+)", point: [2.08, -0.28, 0.13], dx: 26, dy: -15, layer: "diffusion", color: palette.diffusion },
      { text: "p-type body", point: [0, -1.25, 0.12], dx: 25, dy: 10, layer: "substrate", color: palette.substrate },
      { text: "Field oxide", point: [3.25, 0.69, 0.13], dx: 20, dy: -13, layer: "oxide", color: palette.oxide }
    ],
    top: [
      { text: "Polysilicon gate", point: [0, 1.12, 1.02], dx: 24, dy: -6, layer: "gate", color: palette.gate },
      { text: "Source diffusion", point: [-2.08, 0.08, -0.72], dx: -25, dy: -2, align: "right", layer: "diffusion", color: palette.diffusion },
      { text: "Drain diffusion", point: [2.08, 0.08, -0.72], dx: 25, dy: -2, layer: "diffusion", color: palette.diffusion },
      { text: "A—A′ section", point: [3.50, 1.20, 0], dx: 20, dy: -14, layer: "guide", color: palette.section }
    ]
  };

  let labelElements = [];

  function rebuildLabels() {
    labelsRoot.replaceChildren();
    labelElements = labelDefinitions[currentView].map((definition) => {
      const element = document.createElement("div");
      element.className = `model-label${definition.align === "right" ? " align-right" : ""}`;
      element.textContent = definition.text;
      element.style.setProperty("--label-color", definition.color);
      labelsRoot.appendChild(element);
      return { element, definition };
    });
  }

  function renderLabels() {
    if (!labelsVisible) {
      labelsRoot.style.display = "none";
      return;
    }
    labelsRoot.style.display = "block";
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    for (const item of labelElements) {
      const { element, definition } = item;
      const layerVisible = definition.layer === "guide" || visibleLayers.get(definition.layer) !== false;
      const projected = transformPoint(activeViewProjection, definition.point);
      const inFront = projected[3] > 0 && projected[2] > -1.3 && projected[2] < 1.3;
      if (!layerVisible || !inFront) {
        element.style.opacity = "0";
        continue;
      }
      const left = (projected[0] * 0.5 + 0.5) * width + definition.dx;
      const top = (-projected[1] * 0.5 + 0.5) * height + definition.dy;
      const inside = left > -140 && left < width + 140 && top > -30 && top < height + 30;
      element.style.opacity = inside ? "1" : "0";
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    }
  }

  function applyView(view, animate = true) {
    if (!cameraPresets[view]) return;
    currentView = view;
    const targetCamera = cloneCamera(cameraPresets[view]);
    if (animate && !reduceMotion) {
      cameraAnimation = {
        from: cloneCamera(camera),
        to: targetCamera,
        started: performance.now(),
        duration: 720
      };
    } else {
      camera = targetCamera;
      cameraAnimation = null;
    }
    document.querySelectorAll(".view-button").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    viewTitle.textContent = viewCopy[view].title;
    viewDescription.textContent = viewCopy[view].description;
    rebuildLabels();
  }

  document.querySelectorAll(".view-button").forEach((button) => {
    button.addEventListener("click", () => applyView(button.dataset.view));
  });

  document.getElementById("reset-view").addEventListener("click", () => applyView(currentView));

  document.getElementById("labels-toggle").addEventListener("change", (event) => {
    labelsVisible = event.target.checked;
  });

  const layerPanel = document.querySelector(".layer-panel");
  const panelToggle = document.getElementById("toggle-panel");
  panelToggle.addEventListener("click", () => {
    const collapsed = layerPanel.classList.toggle("is-collapsed");
    panelToggle.setAttribute("aria-expanded", String(!collapsed));
    panelToggle.setAttribute("aria-label", collapsed ? "Expand layer panel" : "Collapse layer panel");
  });

  document.querySelectorAll(".layer-row").forEach((button) => {
    const layer = button.dataset.layer;
    button.addEventListener("click", () => {
      const next = !visibleLayers.get(layer);
      visibleLayers.set(layer, next);
      button.setAttribute("aria-pressed", String(next));
    });
    button.addEventListener("pointerenter", () => { hoverLayer = layer; });
    button.addEventListener("pointerleave", () => { hoverLayer = null; });
    button.addEventListener("focus", () => { hoverLayer = layer; });
    button.addEventListener("blur", () => { hoverLayer = null; });
  });

  const pointers = new Map();
  let dragState = null;
  let pinchDistance = 0;

  function cancelAnimation() {
    cameraAnimation = null;
  }

  function cameraBasis() {
    const forward = vecNormalize(vecSub(camera.target, camera.position));
    const right = vecNormalize(vecCross(forward, camera.up));
    const up = vecNormalize(vecCross(right, forward));
    return { forward, right, up };
  }

  function orbitCamera(deltaX, deltaY) {
    const offset = vecSub(camera.position, camera.target);
    const radius = Math.max(2.5, vecLength(offset));
    let yaw = Math.atan2(offset[0], offset[2]);
    let pitch = Math.asin(Math.max(-1, Math.min(1, offset[1] / radius)));
    yaw -= deltaX * 0.0075;
    pitch = Math.max(-1.30, Math.min(1.53, pitch - deltaY * 0.0075));
    const cosine = Math.cos(pitch);
    camera.position = [
      camera.target[0] + radius * Math.sin(yaw) * cosine,
      camera.target[1] + radius * Math.sin(pitch),
      camera.target[2] + radius * Math.cos(yaw) * cosine
    ];
    camera.up = Math.abs(pitch) > 1.49 ? [0, 0, pitch > 0 ? -1 : 1] : [0, 1, 0];
  }

  function panCamera(deltaX, deltaY) {
    const basis = cameraBasis();
    const distance = vecLength(vecSub(camera.position, camera.target));
    const scale = camera.projection === "ortho" ? camera.orthoScale / 260 : distance / 720;
    const movement = vecAdd(vecScale(basis.right, -deltaX * scale), vecScale(basis.up, deltaY * scale));
    camera.position = vecAdd(camera.position, movement);
    camera.target = vecAdd(camera.target, movement);
  }

  function zoomCamera(delta) {
    if (camera.projection === "ortho") {
      camera.orthoScale = Math.max(1.45, Math.min(6.2, camera.orthoScale * Math.exp(delta * 0.0011)));
      return;
    }
    const offset = vecSub(camera.position, camera.target);
    const currentDistance = vecLength(offset);
    const nextDistance = Math.max(4.2, Math.min(20, currentDistance * Math.exp(delta * 0.0011)));
    camera.position = vecAdd(camera.target, vecScale(vecNormalize(offset), nextDistance));
  }

  canvas.addEventListener("pointerdown", (event) => {
    cancelAnimation();
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      dragState = { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 1 || event.button === 2 };
      canvas.classList.add("is-dragging");
    } else if (pointers.size === 2) {
      const values = Array.from(pointers.values());
      pinchDistance = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const values = Array.from(pointers.values());
      const nextDistance = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
      if (pinchDistance > 0) zoomCamera((pinchDistance - nextDistance) * 3.2);
      pinchDistance = nextDistance;
      return;
    }
    if (!dragState) return;
    const deltaX = event.clientX - previous.x;
    const deltaY = event.clientY - previous.y;
    if (dragState.pan || event.shiftKey) panCamera(deltaX, deltaY);
    else orbitCamera(deltaX, deltaY);
    dragState.x = event.clientX;
    dragState.y = event.clientY;
  });

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (!pointers.size) {
      dragState = null;
      canvas.classList.remove("is-dragging");
    }
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("wheel", (event) => {
    cancelAnimation();
    event.preventDefault();
    zoomCamera(event.deltaY);
  }, { passive: false });
  canvas.addEventListener("dblclick", () => applyView(currentView));

  function updateOrientationWidget() {
    const svg = document.getElementById("orientation-svg");
    if (!svg) return;
    const origin = transformPoint(activeViewProjection, [0, 0, 0]);
    const axes = [
      { id: "orientation-x", label: "orientation-x-label", point: [1, 0, 0] },
      { id: "orientation-y", label: "orientation-y-label", point: [0, 1, 0] },
      { id: "orientation-z", label: "orientation-z-label", point: [0, 0, 1] }
    ];
    for (const axis of axes) {
      const projected = transformPoint(activeViewProjection, axis.point);
      let dx = projected[0] - origin[0];
      let dy = -(projected[1] - origin[1]);
      const length = Math.hypot(dx, dy) || 1;
      dx = dx / length * 22;
      dy = dy / length * 22;
      const line = document.getElementById(axis.id);
      const label = document.getElementById(axis.label);
      line.setAttribute("x2", String(34 + dx));
      line.setAttribute("y2", String(40 + dy));
      label.setAttribute("x", String(34 + dx * 1.37));
      label.setAttribute("y", String(40 + dy * 1.37 + 3));
    }
  }

  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    errorBox.hidden = false;
    errorBox.textContent = "The 3D view paused because the graphics context was lost. Reload the page to restore it.";
  });

  rebuildLabels();
  resizeCanvas();
  requestAnimationFrame(render);
  window.__CMOS_MODEL_READY__ = true;
})();
