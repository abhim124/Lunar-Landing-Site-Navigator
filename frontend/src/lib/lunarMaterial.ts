/**
 * Lunar surface material: MeshStandardMaterial (so it keeps PBR lighting + shadow maps)
 * patched via onBeforeCompile to texture by *selenographic direction* instead of UVs.
 *
 *  • Base colour: CGI Moon Kit equirectangular JPEG sampled at (lon, lat) per fragment,
 *    using textureGrad with seam-safe derivatives so there is no ±180° mip seam.
 *  • Overlay: south-polar raster sampled in South Polar Stereographic space
 *    (x, y) = 2R·(d.x, d.z)/(1 − d.y), uv from the overlay's metre bounds → zero polar pinching.
 */

import * as THREE from 'three';
import { MOON_RADIUS_M } from './geo';

export interface LunarUniforms {
  [key: string]: THREE.IUniform;
  uBaseMap: THREE.IUniform<THREE.Texture | null>;
  uHasBase: THREE.IUniform<number>;
  uOverlayMap: THREE.IUniform<THREE.Texture | null>;
  uOverlayMix: THREE.IUniform<number>;
  /** Overlay footprint in South Polar Stereographic metres: (xmin, ymin, xmax, ymax). */
  uSpBounds: THREE.IUniform<THREE.Vector4>;
  uOverlayMaxLat: THREE.IUniform<number>;
  uMoonRadiusM: THREE.IUniform<number>;
  uOverlayEmissive: THREE.IUniform<number>;
  /** Always-on permanently shadowed region outline (PGDA LPSR) in South Polar Stereographic space. */
  uPsrMap: THREE.IUniform<THREE.Texture | null>;
  uPsrMix: THREE.IUniform<number>;
  uPsrBounds: THREE.IUniform<THREE.Vector4>;
}

export function createLunarUniforms(): LunarUniforms {
  return {
    uBaseMap: { value: null },
    uHasBase: { value: 0 },
    uOverlayMap: { value: null },
    uOverlayMix: { value: 0 },
    uSpBounds: { value: new THREE.Vector4(-1, -1, 1, 1) },
    uOverlayMaxLat: { value: -65 },
    uMoonRadiusM: { value: MOON_RADIUS_M },
    uOverlayEmissive: { value: 0.4 },
    uPsrMap: { value: null },
    uPsrMix: { value: 0 },
    uPsrBounds: { value: new THREE.Vector4(-1, -1, 1, 1) },
  };
}

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D uBaseMap;
uniform float uHasBase;
uniform sampler2D uOverlayMap;
uniform float uOverlayMix;
uniform vec4 uSpBounds;
uniform float uOverlayMaxLat;
uniform float uMoonRadiusM;
uniform float uOverlayEmissive;
uniform sampler2D uPsrMap;
uniform float uPsrMix;
uniform vec4 uPsrBounds;
varying vec3 vSelDir;

vec4 lunarSampleEquirect(sampler2D tex, vec3 d) {
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float lon = atan(d.x, d.z);
  vec2 uvA = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
  vec2 uvB = vec2(fract(uvA.x + 0.5), uvA.y);
  vec2 dxA = dFdx(uvA); vec2 dyA = dFdy(uvA);
  vec2 dxB = dFdx(uvB); vec2 dyB = dFdy(uvB);
  bool useB = (abs(dxA.x) + abs(dyA.x)) > (abs(dxB.x) + abs(dyB.x));
  return textureGrad(tex, uvA, useB ? dxB : dxA, useB ? dyB : dyA);
}

vec4 lunarSampleStereo(sampler2D tex, vec3 d, out float inside) {
  float denom = max(1.0 - d.y, 1e-6);
  vec2 xy = 2.0 * uMoonRadiusM * vec2(d.x, d.z) / denom;
  vec2 uv = (xy - uSpBounds.xy) / (uSpBounds.zw - uSpBounds.xy);
  inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return texture(tex, clamp(uv, 0.0, 1.0));
}
`;

const MAP_FRAGMENT = /* glsl */ `
vec3 lunarDir = normalize(vSelDir);
vec4 lunarBase = uHasBase > 0.5 ? lunarSampleEquirect(uBaseMap, lunarDir) : vec4(0.42, 0.42, 0.44, 1.0);
diffuseColor.rgb *= lunarBase.rgb;
if (uOverlayMix > 0.001) {
  float latDeg = degrees(asin(clamp(lunarDir.y, -1.0, 1.0)));
  float inside = 1.0;
  vec4 ov = lunarSampleStereo(uOverlayMap, lunarDir, inside);
  inside *= 1.0 - smoothstep(uOverlayMaxLat - 1.0, uOverlayMaxLat, latDeg);
  float a = uOverlayMix * ov.a * inside;
  diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, a);
  totalEmissiveRadiance += ov.rgb * a * uOverlayEmissive;
}
if (uPsrMix > 0.001 && lunarDir.y < -0.9) {
  // PSRs are always dark, so the outline is partly self-lit to stay visible in shadow.
  float pd = max(1.0 - lunarDir.y, 1e-6);
  vec2 pxy = 2.0 * uMoonRadiusM * vec2(lunarDir.x, lunarDir.z) / pd;
  vec2 puv = (pxy - uPsrBounds.xy) / (uPsrBounds.zw - uPsrBounds.xy);
  float pin = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);
  vec4 ps = texture(uPsrMap, clamp(puv, 0.0, 1.0));
  float pa = uPsrMix * ps.a * pin;
  diffuseColor.rgb = mix(diffuseColor.rgb, ps.rgb, pa * 0.8);
  totalEmissiveRadiance += ps.rgb * pa * 0.55;
}
`;

export function createLunarMaterial(uniforms: LunarUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.97,
    metalness: 0,
    emissive: 0x000000,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms); // same uniform objects → live updates without recompiling
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSelDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSelDir = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
      .replace('#include <map_fragment>', MAP_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'lunar-surface-v2';
  return material;
}
