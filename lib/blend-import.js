import * as THREE from 'three';
import { decompress as decompressZstd } from 'fzstd';
import {
  extractMaterials,
  extractMeshes,
  extractObjects,
  extractImages,
  parseBlend,
  readAttributeAsInt32,
} from 'jsblender';

const fail = (message) => new Error(message);
const makeText = (bytes, offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

async function unpack(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw fail('This browser cannot decompress gzip-compressed Blender files.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    bytes = decompressZstd(bytes);
  }
  return bytes;
}

function makeGeometry(positions, cornerVertices, faceOffsets, materialIndices, materials, edgePairs, uvMap) {
  const buckets = materials.length ? materials.map(() => []) : [[]];
  const vertexCount = positions.length / 3;
  let windingCorrections = 0;
  const originalFaces = [];

  // 1. Collect original polygon face loops for topology retention
  for (let face = 0; face + 1 < faceOffsets.length; face++) {
    const start = faceOffsets[face], end = faceOffsets[face + 1];
    const vertices = [];
    for (let i = start; i < end; i++) {
      const idx = cornerVertices[i];
      if (idx >= 0 && idx < vertexCount) vertices.push(idx);
    }
    if (vertices.length >= 3) {
      originalFaces.push(vertices);
    }
  }

  // 2. Vertex deduplication with UV seam handling:
  // If UV coordinates are provided, vertices with different UVs at the same 3D position
  // (e.g. at UV seams/texture cuts) are properly separated to prevent UV stretching/overlap.
  const hasUV = Boolean(uvMap && uvMap.length >= cornerVertices.length * 2);
  const vertexMap = new Map();
  const outPositions = [];
  const outUVs = hasUV ? [] : null;
  const originalVertexMap = [];

  function getOrCreateVertex(cornerIdx) {
    const posIdx = cornerVertices[cornerIdx];
    const u = hasUV ? uvMap[cornerIdx * 2] : 0;
    const v = hasUV ? uvMap[cornerIdx * 2 + 1] : 0;
    // Quantize UV to 5 decimal places to avoid floating-point jitter across adjacent faces
    const key = hasUV
      ? (posIdx + '_' + Math.round(u * 100000) + '_' + Math.round(v * 100000))
      : ('' + posIdx);

    let idx = vertexMap.get(key);
    if (idx === undefined) {
      idx = outPositions.length / 3;
      vertexMap.set(key, idx);
      outPositions.push(
        positions[posIdx * 3],
        positions[posIdx * 3 + 1],
        positions[posIdx * 3 + 2]
      );
      if (hasUV) {
        outUVs.push(u, v);
      }
      originalVertexMap.push(posIdx);
    }
    return idx;
  }

  // 3. Triangulate faces cleanly preserving polygon winding order
  for (let face = 0; face + 1 < faceOffsets.length; face++) {
    const start = faceOffsets[face], end = faceOffsets[face + 1];
    const count = end - start;
    if (count < 3) continue;

    // Check validity of corner vertices in this face
    let valid = true;
    for (let i = start; i < end; i++) {
      const idx = cornerVertices[i];
      if (idx === undefined || idx < 0 || idx >= vertexCount) { valid = false; break; }
    }
    if (!valid) continue;

    const slot = Math.min(Math.max(materialIndices?.[face] ?? 0, 0), buckets.length - 1);

    for (let i = 1; i + 1 < count; i++) {
      const cornerA = start;
      const cornerB = start + i;
      const cornerC = start + i + 1;

      const idxA = getOrCreateVertex(cornerA);
      const idxB = getOrCreateVertex(cornerB);
      const idxC = getOrCreateVertex(cornerC);

      // Skip degenerate triangles where corners point to the same deduplicated vertex
      if (idxA === idxB || idxB === idxC || idxA === idxC) continue;

      buckets[slot].push(idxA, idxB, idxC);
    }
  }

  const geometry = new THREE.BufferGeometry();
  const posArray = new Float32Array(outPositions);
  geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

  if (outUVs) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUVs), 2));
  }

  const total = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
  const indices = new Uint32Array(total);
  let index = 0;
  buckets.forEach((bucket, group) => {
    if (bucket.length > 0) {
      geometry.addGroup(index, bucket.length, group);
      indices.set(bucket, index);
      index += bucket.length;
    }
  });
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // 4. Smooth vertex normals calculation
  // Accumulate face normals into the original 3D position so that UV splits
  // share identical vertex normals, preserving smooth shading across UV seams.
  const normalAccum = new Float32Array(vertexCount * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const iA = indices[i], iB = indices[i + 1], iC = indices[i + 2];
    const ax = posArray[iA * 3], ay = posArray[iA * 3 + 1], az = posArray[iA * 3 + 2];
    const bx = posArray[iB * 3], by = posArray[iB * 3 + 1], bz = posArray[iB * 3 + 2];
    const cx = posArray[iC * 3], cy = posArray[iC * 3 + 1], cz = posArray[iC * 3 + 2];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const fnx = e1y * e2z - e1z * e2y;
    const fny = e1z * e2x - e1x * e2z;
    const fnz = e1x * e2y - e1y * e2x;

    const origA = originalVertexMap[iA];
    const origB = originalVertexMap[iB];
    const origC = originalVertexMap[iC];

    normalAccum[origA * 3] += fnx;
    normalAccum[origA * 3 + 1] += fny;
    normalAccum[origA * 3 + 2] += fnz;

    normalAccum[origB * 3] += fnx;
    normalAccum[origB * 3 + 1] += fny;
    normalAccum[origB * 3 + 2] += fnz;

    normalAccum[origC * 3] += fnx;
    normalAccum[origC * 3 + 1] += fny;
    normalAccum[origC * 3 + 2] += fnz;
  }

  for (let i = 0; i < vertexCount; i++) {
    const nx = normalAccum[i * 3], ny = normalAccum[i * 3 + 1], nz = normalAccum[i * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-6) {
      normalAccum[i * 3] = nx / len;
      normalAccum[i * 3 + 1] = ny / len;
      normalAccum[i * 3 + 2] = nz / len;
    } else {
      normalAccum[i * 3] = 0;
      normalAccum[i * 3 + 1] = 1;
      normalAccum[i * 3 + 2] = 0;
    }
  }

  const outNormals = new Float32Array(outPositions.length);
  const outVertexCount = outPositions.length / 3;
  for (let i = 0; i < outVertexCount; i++) {
    const orig = originalVertexMap[i];
    outNormals[i * 3] = normalAccum[orig * 3];
    outNormals[i * 3 + 1] = normalAccum[orig * 3 + 1];
    outNormals[i * 3 + 2] = normalAccum[orig * 3 + 2];
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(outNormals, 3));
  geometry.userData.windingCorrections = windingCorrections;

  // 5. Topology edges and wireframe
  const originalEdges = [];
  if (edgePairs) {
    for (let index = 0; index + 1 < edgePairs.length; index += 2) {
      const a = edgePairs[index], b = edgePairs[index + 1];
      if (a >= 0 && b >= 0 && a < vertexCount && b < vertexCount) originalEdges.push([a, b]);
    }
  }
  geometry.userData.originalTopology = { faces: originalFaces, edges: originalEdges };

  const lines = [];
  if (edgePairs?.length) {
    for (let i = 0; i + 1 < edgePairs.length; i += 2) {
      const a = edgePairs[i], b = edgePairs[i + 1];
      if (a >= 0 && b >= 0 && a < vertexCount && b < vertexCount) {
        lines.push(
          positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
          positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]
        );
      }
    }
  } else {
    const seen = new Set();
    for (let face = 0; face + 1 < faceOffsets.length; face++) {
      const start = faceOffsets[face], end = faceOffsets[face + 1];
      for (let i = start; i < end; i++) {
        const a = cornerVertices[i], b = cornerVertices[i + 1 === end ? start : i + 1];
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
        if (!seen.has(key) && a >= 0 && b >= 0 && a < vertexCount && b < vertexCount) {
          seen.add(key);
          lines.push(
            positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
            positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]
          );
        }
      }
    }
  }
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const wire = new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({ color: 0x292d38 }));
  wire.userData.isWire = true;
  wire.visible = false;
  return { geometry, wire };
}

// Asynchronously decode packed image bytes to HTMLImageElement / THREE.Texture
async function loadPackedTexture(bytes) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return undefined;
  return new Promise((resolve) => {
    try {
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        URL.revokeObjectURL(url);
        const texture = new THREE.Texture(img);
        texture.colorSpace = THREE.SRGBColorSpace;
        // CRITICAL FIX FOR TEXTURE ORIENTATION:
        // Set flipY = true so that WebGL uploads the image with row 0 mapped to V=1,
        // perfectly aligning with Blender's standard UV coordinate space (V=0 at bottom, V=1 at top).
        // When GLTFExporter processes this, it flips the texture for glTF 2.0 compliance,
        // ensuring textures are never upside-down across all viewing and export modes.
        texture.flipY = true;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        resolve(texture);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(undefined);
      };
      img.src = url;
    } catch {
      resolve(undefined);
    }
  });
}

async function buildModernScene(bytes) {
  const file = parseBlend(bytes);
  const meshes = extractMeshes(file);
  const objects = extractObjects(file);
  const materialInfo = new Map(extractMaterials(file).map((material) => [material.name, material]));
  const packedImages = new Map(extractImages(file).filter((image) => image.packed?.length).map((image) => [image.name, image.packed]));

  // Asynchronously preload all packed textures in parallel
  const textures = new Map();
  if (packedImages.size > 0 && typeof document !== 'undefined') {
    const entries = Array.from(packedImages.entries());
    const loadedTextures = await Promise.all(
      entries.map(async ([name, imageBytes]) => {
        const texture = await loadPackedTexture(imageBytes);
        return [name, texture];
      })
    );
    for (const [name, texture] of loadedTextures) {
      if (texture) textures.set(name, texture);
    }
  }

  const textureFor = (name) => {
    if (!name) return undefined;
    return textures.get(name);
  };

  const meshByName = new Map(meshes.map((mesh) => [mesh.name, mesh]));
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;

  for (const object of objects) {
    if (object.type !== 1 || !object.dataName) continue;
    const source = meshByName.get(object.dataName);
    if (!source) continue;
    const slots = source.materialSlotNames.map((name) => {
      const info = materialInfo.get(name);
      const principled = info?.shader?.principled;
      const color = principled?.baseColor ?? info?.diffuse;
      const emission = principled?.emissionColor;

      // Find texture image name from Principled BSDF or connected Image Texture node
      let imageName = principled?.baseColorImage;
      if (!imageName && info?.shader?.nodes) {
        const texNode = info.shader.nodes.find(
          (n) => (n.idname === 'ShaderNodeTexImage' || n.type === 143) && n.linkedDataName
        );
        if (texNode) imageName = texNode.linkedDataName;
      }

      const map = textureFor(imageName);
      const material = new THREE.MeshStandardMaterial({
        color: color ? new THREE.Color(color[0], color[1], color[2]) : 0xb9bdca,
        roughness: principled?.roughness ?? info?.roughness ?? 0.65,
        metalness: principled?.metallic ?? info?.metallic ?? 0,
        transparent: (principled?.alpha ?? color?.[3] ?? 1) < 1,
        opacity: principled?.alpha ?? color?.[3] ?? 1,
        emissive: emission ? new THREE.Color(emission[0], emission[1], emission[2]) : 0x000000,
        emissiveIntensity: principled?.emissionStrength ?? 0,
        side: THREE.DoubleSide,
      });
      if (map) material.map = map;
      return material;
    });
    if (!slots.length) slots.push(new THREE.MeshStandardMaterial({ color: 0xb9bdca, roughness: 0.65, side: THREE.DoubleSide }));
    const edgeAttribute = source.attributes?.['.edge_verts'];
    const edgePairs = edgeAttribute ? readAttributeAsInt32(file.reader, edgeAttribute) : undefined;
    const uvMap = Object.values(source.uvMaps || {})[0];
    const { geometry, wire } = makeGeometry(source.vertices, source.cornerVertices, source.faceOffsets, source.materialIndices, slots, edgePairs, uvMap);
    const mesh = new THREE.Mesh(geometry, slots);
    mesh.name = object.name;
    mesh.add(wire);
    if (object.worldMatrix?.length === 16) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(object.worldMatrix);
      if (mesh.matrix.determinant() < 0) {
        // When worldMatrix contains a reflection / negative scale (det < 0),
        // triangle winding is flipped in world space.
        // We invert the triangle index winding so faces remain CCW and outward-facing.
        const indexAttr = geometry.getIndex();
        if (indexAttr) {
          const arr = indexAttr.array;
          for (let i = 0; i < arr.length; i += 3) {
            const tmp = arr[i + 1];
            arr[i + 1] = arr[i + 2];
            arr[i + 2] = tmp;
          }
          indexAttr.needsUpdate = true;
        }
        if (geometry.userData?.originalTopology?.faces) {
          for (const f of geometry.userData.originalTopology.faces) {
            f.reverse();
          }
        }
      }
    }
    root.add(mesh);
  }
  if (!root.children.length) throw fail('No mesh objects were found in this Blender file.');
  root.updateMatrixWorld(true);
  return root;
}

function buildLegacyScene(bytes, versionCode) {
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => makeText(bytes, offset, length);
  if (text(0, 7) !== 'BLENDER') throw fail('This is not a Blender file.');
  const pointerSize = bytes[7] === 0x5f ? 4 : bytes[7] === 0x2d ? 8 : 0;
  const little = bytes[8] === 0x76;
  if (!pointerSize || !(bytes[8] === 0x76 || bytes[8] === 0x56) || !/^\d{3}$/.test(text(9, 3))) throw fail('This Blender file uses an unsupported file header.');
  const pointer = (offset) => pointerSize === 8 ? dataView.getBigUint64(offset, little) : BigInt(dataView.getUint32(offset, little));
  const blocks = [];
  const blocksByPointer = new Map();
  let offset = 12;
  while (offset < bytes.length) {
    const headerSize = pointerSize === 8 ? 24 : 20;
    const block = { code: text(offset, 4).replace(/\0/g, ''), length: dataView.getUint32(offset + 4, little), pointer: pointer(offset + 8), data: offset + headerSize };
    offset = block.data + block.length;
    if (block.code === 'ENDB') break;
    blocks.push(block);
    const pointerBlocks = blocksByPointer.get(block.pointer) ?? [];
    pointerBlocks.push(block);
    blocksByPointer.set(block.pointer, pointerBlocks);
  }
  const dna = blocks.find((block) => block.code === 'DNA1');
  if (!dna) throw fail('No Blender schema block was found.');
  let cursor = dna.data + 8;
  const align = () => { cursor = dna.data + ((cursor - dna.data + 3) & ~3); };
  const strings = (count) => {
    const values = [];
    for (let i = 0; i < count; i++) {
      let end = cursor;
      while (bytes[end]) end++;
      values.push(text(cursor, end - cursor));
      cursor = end + 1;
    }
    align();
    return values;
  };
  let count = dataView.getInt32(cursor, little); cursor += 4;
  const names = strings(count);
  cursor += 4; count = dataView.getInt32(cursor, little); cursor += 4;
  const types = strings(count);
  cursor += 4;
  const typeLengths = [];
  for (let i = 0; i < types.length; i++) { typeLengths.push(dataView.getInt16(cursor, little)); cursor += 2; }
  align();
  cursor += 4; const structureCount = dataView.getInt32(cursor, little); cursor += 4;
  const rawStructures = {};
  for (let i = 0; i < structureCount; i++) {
    const typeIndex = dataView.getInt16(cursor, little), fieldCount = dataView.getInt16(cursor + 2, little); cursor += 4;
    const fields = [];
    for (let k = 0; k < fieldCount; k++) {
      const fieldType = dataView.getInt16(cursor, little), fieldName = names[dataView.getInt16(cursor + 2, little)]; cursor += 4;
      let elements = 1;
      for (const match of fieldName.matchAll(/\[(\d+)\]/g)) elements *= Number(match[1]);
      fields.push({ fieldType, fieldName, elements });
    }
    rawStructures[types[typeIndex]] = { typeIndex, fields };
  }
  const typeAlignment = (typeIndex, seen = new Set()) => {
    const typeName = types[typeIndex], structure = rawStructures[typeName];
    if (!structure || seen.has(typeName)) return Math.min(typeLengths[typeIndex] || 1, pointerSize);
    seen.add(typeName);
    return Math.max(1, ...structure.fields.map((field) => /^\(?\*/.test(field.fieldName) ? pointerSize : typeAlignment(field.fieldType, new Set(seen))));
  };
  const structures = {};
  for (const [name, structure] of Object.entries(rawStructures)) {
    let memberOffset = 0;
    const fields = {};
    for (const field of structure.fields) {
      const isPointer = /^\(?\*/.test(field.fieldName);
      const size = (isPointer ? pointerSize : typeLengths[field.fieldType]) * field.elements;
      const alignment = isPointer ? pointerSize : typeAlignment(field.fieldType);
      memberOffset = Math.ceil(memberOffset / alignment) * alignment;
      const key = field.fieldName.replace(/^\(?\**/, '').replace(/[\[\)].*$/, '');
      fields[key] = { offset: memberOffset, size };
      memberOffset += size;
    }
    structures[name] = { size: typeLengths[structure.typeIndex], fields };
  }
  const fieldOffset = (structure, base, ...choices) => {
    for (const name of choices) {
      const field = structures[structure]?.fields[name];
      if (field) return base + field.offset;
    }
    throw fail(`Unsupported Blender mesh layout: missing ${structure}.${choices.join('/')}.`);
  };
  const blockAt = (at, expectedLength = 0, expectedCode = null) => {
    const address = pointer(at);
    if (address === 0n) return undefined;
    const matches = blocksByPointer.get(address) ?? [];
    const typed = expectedCode ? matches.filter((block) => block.code === expectedCode) : matches;
    const candidates = typed.length ? typed : matches;
    if (expectedLength) {
      const exact = candidates.find((block) => block.length === expectedLength);
      if (exact) return exact;
      const largeEnough = candidates.filter((block) => block.length >= expectedLength).sort((a, b) => a.length - b.length);
      if (largeEnough.length) return largeEnough[0];
    }
    return candidates.at(-1);
  };
  const readFloatArray = (block, length) => { const result = new Float32Array(length); for (let i = 0; i < length; i++) result[i] = dataView.getFloat32(block.data + i * 4, little); return result; };
  const readIntArray = (block, length) => { const result = new Int32Array(length); for (let i = 0; i < length; i++) result[i] = dataView.getInt32(block.data + i * 4, little); return result; };
  const customData = (mesh, expectedDataLengths, ...fieldNames) => {
    const base = fieldOffset('Mesh', mesh.data, ...fieldNames);
    const layerCount = dataView.getInt32(fieldOffset('CustomData', base, 'totlayer'), little);
    const layersBlock = blockAt(fieldOffset('CustomData', base, 'layers'), layerCount * structures.CustomDataLayer.size);
    const result = {};
    if (!layersBlock) return result;
    for (let i = 0; i < layerCount; i++) {
      const layer = layersBlock.data + i * structures.CustomDataLayer.size;
      const name = text(fieldOffset('CustomDataLayer', layer, 'name'), 68).split('\0')[0];
      result[name] = blockAt(fieldOffset('CustomDataLayer', layer, 'data'), expectedDataLengths[name] ?? 0);
    }
    return result;
  };
  const meshes = new Map();
  const buildMesh = (mesh) => {
    if (meshes.has(mesh)) return meshes.get(mesh);
    const base = mesh.data;
    const vertexCount = dataView.getInt32(fieldOffset('Mesh', base, 'verts_num', 'totvert'), little);
    const faceCount = dataView.getInt32(fieldOffset('Mesh', base, 'faces_num', 'totpoly'), little);
    const cornerCount = dataView.getInt32(fieldOffset('Mesh', base, 'corners_num', 'totloop'), little);
    const edgeCount = dataView.getInt32(fieldOffset('Mesh', base, 'edges_num', 'totedge'), little);
    const vertexData = versionCode >= 400 ? customData(mesh, { position: vertexCount * 12 }, 'vert_data', 'vdata') : {};
    const cornerData = versionCode >= 400 ? customData(mesh, { '.corner_vert': cornerCount * 4 }, 'corner_data', 'ldata') : {};
    const faceData = versionCode >= 400 ? customData(mesh, { material_index: faceCount * 4 }, 'face_data', 'pdata') : {};
    const faceOffsetsBlock = blockAt(fieldOffset('Mesh', base, 'face_offset_indices', 'poly_offset_indices'), (faceCount + 1) * 4);
    let positions, cornerVertices, faceOffsets, materialIndices, edgePairs;

    if (versionCode >= 400 && vertexData.position && cornerData['.corner_vert'] && faceOffsetsBlock) {
      positions = readFloatArray(vertexData.position, vertexCount * 3);
      cornerVertices = readIntArray(cornerData['.corner_vert'], cornerCount);
      faceOffsets = readIntArray(faceOffsetsBlock, faceCount + 1);
      materialIndices = faceData.material_index ? readIntArray(faceData.material_index, faceCount) : null;
      const edgeData = customData(mesh, { '.edge_verts': edgeCount * 8 }, 'edge_data', 'edata')['.edge_verts'];
      if (edgeData) edgePairs = readIntArray(edgeData, edgeCount * 2);
    } else {
      const vertexBlock = blockAt(fieldOffset('Mesh', base, 'mvert'), vertexCount * structures.MVert.size);
      const loopBlock = blockAt(fieldOffset('Mesh', base, 'mloop'), cornerCount * structures.MLoop.size);
      const polygonBlock = blockAt(fieldOffset('Mesh', base, 'mpoly'), faceCount * structures.MPoly.size);
      const edgeBlock = blockAt(fieldOffset('Mesh', base, 'medge'), edgeCount * structures.MEdge.size);
      if (!vertexBlock || !loopBlock || !polygonBlock) throw fail('This Blender 3.x–4.x mesh uses an unsupported layout.');
      positions = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        const at = vertexBlock.data + i * structures.MVert.size + fieldOffset('MVert', 0, 'co');
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = dataView.getFloat32(at + k * 4, little);
      }
      cornerVertices = new Int32Array(cornerCount);
      for (let i = 0; i < cornerCount; i++) cornerVertices[i] = dataView.getInt32(loopBlock.data + i * structures.MLoop.size + fieldOffset('MLoop', 0, 'v'), little);
      faceOffsets = new Int32Array(faceCount + 1);
      materialIndices = new Int32Array(faceCount);
      for (let i = 0; i < faceCount; i++) {
        const at = polygonBlock.data + i * structures.MPoly.size;
        faceOffsets[i] = dataView.getInt32(at + fieldOffset('MPoly', 0, 'loopstart'), little);
        faceOffsets[i + 1] = faceOffsets[i] + dataView.getInt16(at + fieldOffset('MPoly', 0, 'totloop'), little);
        materialIndices[i] = dataView.getInt16(at + fieldOffset('MPoly', 0, 'mat_nr'), little);
      }
      if (edgeBlock) {
        edgePairs = new Int32Array(edgeCount * 2);
        for (let i = 0; i < edgeCount; i++) {
          const at = edgeBlock.data + i * structures.MEdge.size;
          edgePairs[i * 2] = dataView.getInt32(at + fieldOffset('MEdge', 0, 'v1'), little);
          edgePairs[i * 2 + 1] = dataView.getInt32(at + fieldOffset('MEdge', 0, 'v2'), little);
        }
      }
    }

    const slotCount = Math.max(dataView.getInt16(fieldOffset('Mesh', base, 'totcol'), little), 1);
    const materialsBlock = blockAt(fieldOffset('Mesh', base, 'mat'));
    const materials = [];
    for (let i = 0; i < slotCount; i++) {
      const materialBlock = materialsBlock ? blockAt(materialsBlock.data + i * pointerSize) : null;
      const material = new THREE.MeshStandardMaterial({ color: 0xb9bdca, roughness: 0.65, side: THREE.DoubleSide });
      if (materialBlock) {
        const materialBase = materialBlock.data;
        try {
          material.color.setRGB(
            dataView.getFloat32(fieldOffset('Material', materialBase, 'r'), little),
            dataView.getFloat32(fieldOffset('Material', materialBase, 'g'), little),
            dataView.getFloat32(fieldOffset('Material', materialBase, 'b'), little),
          );
          material.roughness = dataView.getFloat32(fieldOffset('Material', materialBase, 'roughness'), little);
          material.metalness = dataView.getFloat32(fieldOffset('Material', materialBase, 'metallic'), little);
        } catch {}
      }
      materials.push(material);
    }
    const result = { ...makeGeometry(positions, cornerVertices, faceOffsets, materialIndices, materials, edgePairs), materials };
    meshes.set(mesh, result);
    return result;
  };

  const transforms = new Map();
  const vector3 = (at) => [0, 1, 2].map((i) => dataView.getFloat32(at + 4 * i, little));
  const objectMatrix = (object) => {
    if (transforms.has(object)) return transforms.get(object);
    const base = object.data;
    const rotationMode = dataView.getInt16(fieldOffset('Object', base, 'rotmode'), little);
    const quaternion = new THREE.Quaternion();
    if (rotationMode > 0) {
      const euler = vector3(fieldOffset('Object', base, 'rot'));
      const order = ['', 'XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'][rotationMode].split('').reverse().join('');
      quaternion.setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2], order));
    } else if (rotationMode === 0) {
      const values = [0, 1, 2, 3].map((i) => dataView.getFloat32(fieldOffset('Object', base, 'quat') + 4 * i, little));
      quaternion.set(values[1], values[2], values[3], values[0]);
    }
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...vector3(fieldOffset('Object', base, 'loc'))),
      quaternion,
      new THREE.Vector3(...vector3(fieldOffset('Object', base, 'scale', 'size'))),
    );
    const parent = blockAt(fieldOffset('Object', base, 'parent'));
    if (parent) {
      const inverse = new THREE.Matrix4().fromArray(Array.from({ length: 16 }, (_, i) => dataView.getFloat32(fieldOffset('Object', base, 'parentinv') + i * 4, little)));
      matrix.premultiply(inverse).premultiply(objectMatrix(parent));
    }
    transforms.set(object, matrix);
    return matrix;
  };

  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  const objectName = (object) => text(fieldOffset('ID', fieldOffset('Object', object.data, 'id'), 'name'), 66).split('\0')[0].replace(/^[A-Z]{2}/, '');
  for (const object of blocks.filter((block) => block.code === 'OB')) {
    if (dataView.getInt16(fieldOffset('Object', object.data, 'type'), little) !== 1) continue;
    const meshBlock = blockAt(fieldOffset('Object', object.data, 'data'));
    if (!meshBlock || meshBlock.code !== 'ME') continue;
    const { geometry, wire, materials } = buildMesh(meshBlock);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = objectName(object);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(objectMatrix(object));
    if (mesh.matrix.determinant() < 0) {
      const indexAttr = geometry.getIndex();
      if (indexAttr) {
        const arr = indexAttr.array;
        for (let i = 0; i < arr.length; i += 3) {
          const tmp = arr[i + 1];
          arr[i + 1] = arr[i + 2];
          arr[i + 2] = tmp;
        }
        indexAttr.needsUpdate = true;
      }
      if (geometry.userData?.originalTopology?.faces) {
        for (const f of geometry.userData.originalTopology.faces) {
          f.reverse();
        }
      }
    }
    mesh.add(wire);
    root.add(mesh);
  }
  if (!root.children.length) throw fail('No mesh objects were found in this Blender file.');
  root.updateMatrixWorld(true);
  return root;
}

export async function loadBlendFile(input) {
  const bytes = await unpack(input);
  if (makeText(bytes, 0, 7) !== 'BLENDER') throw fail('This is not a Blender file.');
  const modernHeader = makeText(bytes, 7, 2) === '17' && makeText(bytes, 9, 3) === '-01';
  const versionCode = modernHeader ? Number(makeText(bytes, 13, 4)) : Number(makeText(bytes, 9, 3));

  // 1. Try modern jsblender parser first (handles Blender 4.x and 5.x with PBR materials and textures)
  try {
    const scene = await buildModernScene(bytes);
    if (scene && scene.children.length > 0) return scene;
  } catch (modernErr) {
    // If modern parser throws or finds no meshes, fall back to legacy parser
  }

  // 2. Fall back to legacy parser for Blender 3.x and older DNA layouts
  return buildLegacyScene(bytes, versionCode);
}
