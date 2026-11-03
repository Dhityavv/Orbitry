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
  const buckets = materials.map(() => []);
  const vertexCount = positions.length / 3;
  let windingCorrections = 0;
  const originalFaces = [];
  for (let face = 0; face + 1 < faceOffsets.length; face++) {
    const start = faceOffsets[face], end = faceOffsets[face + 1];
    const vertices = Array.from(cornerVertices.slice(start, end)).filter((index) => index >= 0 && index < vertexCount);
    if (vertices.length < 3) continue;
    originalFaces.push(vertices);
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i] * 3, b = vertices[(i + 1) % vertices.length] * 3;
      nx += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
      ny += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
      nz += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
    }
    const triangles = [];
    for (let index = 1; index + 1 < vertices.length; index++) triangles.push([0, index, index + 1]);
    const slot = Math.min(Math.max(materialIndices?.[face] ?? 0, 0), buckets.length - 1);
    for (const triangle of triangles) {
      let [a, b, c] = triangle.map((index) => vertices[index]);
      const aOffset = a * 3, bOffset = b * 3, cOffset = c * 3;
      const ab = new THREE.Vector3(positions[bOffset] - positions[aOffset], positions[bOffset + 1] - positions[aOffset + 1], positions[bOffset + 2] - positions[aOffset + 2]);
      const ac = new THREE.Vector3(positions[cOffset] - positions[aOffset], positions[cOffset + 1] - positions[aOffset + 1], positions[cOffset + 2] - positions[aOffset + 2]);
      if (ab.cross(ac).dot(new THREE.Vector3(nx, ny, nz)) < 0) {
        [b, c] = [c, b];
        windingCorrections++;
      }
      buckets[slot].push(a, b, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const total = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
  const indices = new Uint32Array(total);
  let index = 0;
  buckets.forEach((bucket, group) => {
    geometry.addGroup(index, bucket.length, group);
    indices.set(bucket, index);
    index += bucket.length;
  });
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (uvMap?.length >= cornerVertices.length * 2) {
    const uvs = new Float32Array(vertexCount * 2);
    const assigned = new Uint8Array(vertexCount);
    for (let corner = 0; corner < cornerVertices.length; corner++) {
      const vertex = cornerVertices[corner];
      if (vertex < 0 || vertex >= vertexCount || assigned[vertex]) continue;
      uvs[vertex * 2] = uvMap[corner * 2];
      uvs[vertex * 2 + 1] = uvMap[corner * 2 + 1];
      assigned[vertex] = 1;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  geometry.computeVertexNormals();
  geometry.userData.windingCorrections = windingCorrections;
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
      if (a >= 0 && b >= 0 && a < vertexCount && b < vertexCount) lines.push(...positions.slice(a * 3, a * 3 + 3), ...positions.slice(b * 3, b * 3 + 3));
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
          lines.push(...positions.slice(a * 3, a * 3 + 3), ...positions.slice(b * 3, b * 3 + 3));
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

function buildModernScene(bytes) {
  const file = parseBlend(bytes);
  const meshes = extractMeshes(file);
  const objects = extractObjects(file);
  const materialInfo = new Map(extractMaterials(file).map((material) => [material.name, material]));
  const packedImages = new Map(extractImages(file).filter((image) => image.packed?.length).map((image) => [image.name, image.packed]));
  const textures = new Map();
  const textureFor = (name) => {
    if (!name || textures.has(name) || typeof document === 'undefined') return textures.get(name);
    const bytes = packedImages.get(name);
    if (!bytes) return undefined;
    const url = URL.createObjectURL(new Blob([bytes]));
    const texture = new THREE.TextureLoader().load(url, () => URL.revokeObjectURL(url));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    textures.set(name, texture);
    return texture;
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
      const map = textureFor(principled?.baseColorImage);
      const material = new THREE.MeshStandardMaterial({
        color: color ? new THREE.Color(color[0], color[1], color[2]) : 0xb9bdca,
        roughness: principled?.roughness ?? info?.roughness ?? 0.65,
        metalness: principled?.metallic ?? info?.metallic ?? 0,
        transparent: (principled?.alpha ?? color?.[3] ?? 1) < 1,
        opacity: principled?.alpha ?? color?.[3] ?? 1,
        emissive: emission ? new THREE.Color(emission[0], emission[1], emission[2]) : 0x000000,
        emissiveIntensity: principled?.emissionStrength ?? 0,
      });
      if (map) material.map = map;
      return material;
    });
    if (!slots.length) slots.push(new THREE.MeshStandardMaterial({ color: 0xb9bdca, roughness: 0.65 }));
    const edgeAttribute = source.attributes['.edge_verts'];
    const edgePairs = edgeAttribute ? readAttributeAsInt32(file.reader, edgeAttribute) : undefined;
    const uvMap = Object.values(source.uvMaps)[0];
    const { geometry, wire } = makeGeometry(source.vertices, source.cornerVertices, source.faceOffsets, source.materialIndices, slots, edgePairs, uvMap);
    const mesh = new THREE.Mesh(geometry, slots);
    mesh.name = object.name;
    mesh.add(wire);
    if (object.worldMatrix?.length === 16) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(object.worldMatrix);
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
      const material = new THREE.MeshStandardMaterial({ color: 0xb9bdca, roughness: 0.65 });
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
  const majorVersion = modernHeader ? Math.floor(versionCode / 100) : Math.floor(versionCode / 100);
  if (majorVersion < 3) throw fail('Orbitry supports Blender 3.0 and newer.');
  if (modernHeader || versionCode >= 500) return buildModernScene(bytes);
  return buildLegacyScene(bytes, versionCode);
}
