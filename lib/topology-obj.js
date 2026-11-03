import * as THREE from 'three';

export function exportTopologyObj(root) {
  const lines = ['# Exported by Orbitry'];
  let vertexOffset = 1;
  let uvOffset = 1;
  let normalOffset = 1;

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return;

    const positions = mesh.geometry.getAttribute('position');
    const uvs = mesh.geometry.getAttribute('uv');
    const normals = mesh.geometry.getAttribute('normal');
    const topology = mesh.geometry.userData.originalTopology;

    lines.push(`o ${(mesh.name || 'Mesh').replace(/[\r\n]/g, '_')}`);

    // 1. Write vertex positions
    for (let index = 0; index < positions.count; index++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
      lines.push(`v ${point.x.toFixed(6)} ${point.y.toFixed(6)} ${point.z.toFixed(6)}`);
    }

    // 2. Write UV texture coordinates
    if (uvs) {
      for (let index = 0; index < uvs.count; index++) {
        const u = uvs.getX(index);
        const v = uvs.getY(index);
        lines.push(`vt ${u.toFixed(6)} ${v.toFixed(6)}`);
      }
    }

    // 3. Write vertex normals
    if (normals) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      for (let index = 0; index < normals.count; index++) {
        const norm = new THREE.Vector3().fromBufferAttribute(normals, index).applyMatrix3(normalMatrix).normalize();
        lines.push(`vn ${norm.x.toFixed(4)} ${norm.y.toFixed(4)} ${norm.z.toFixed(4)}`);
      }
    }

    // 4. Determine faces (preserve quads/n-gons when topology faces are present, or use triangulated indices)
    const canUseTopologyFaces = Boolean(topology?.faces?.length);
    const faces = canUseTopologyFaces ? topology.faces : (() => {
      const indices = mesh.geometry.getIndex();
      const result = [];
      if (indices) {
        for (let index = 0; index + 2 < indices.count; index += 3) {
          result.push([indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)]);
        }
      } else {
        for (let index = 0; index + 2 < positions.count; index += 3) {
          result.push([index, index + 1, index + 2]);
        }
      }
      return result;
    })();

    const hasUV = Boolean(uvs);
    const hasNorm = Boolean(normals);
    const pCount = positions.count;

    for (let fIdx = 0; fIdx < faces.length; fIdx++) {
      const face = faces[fIdx];
      if (!face || face.length < 3) continue;
      let valid = true;
      for (let i = 0; i < face.length; i++) {
        const v = face[i];
        if (v < 0 || v >= pCount) { valid = false; break; }
      }
      if (!valid) continue;

      if (hasUV && hasNorm) {
        lines.push(`f ${face.map((idx) => `${idx + vertexOffset}/${idx + uvOffset}/${idx + normalOffset}`).join(' ')}`);
      } else if (hasUV) {
        lines.push(`f ${face.map((idx) => `${idx + vertexOffset}/${idx + uvOffset}`).join(' ')}`);
      } else if (hasNorm) {
        lines.push(`f ${face.map((idx) => `${idx + vertexOffset}//${idx + normalOffset}`).join(' ')}`);
      } else {
        lines.push(`f ${face.map((idx) => `${idx + vertexOffset}`).join(' ')}`);
      }
    }

    // 5. Lines for standalone topology edges
    if (topology?.edges?.length) {
      const faceEdges = new Set();
      for (const face of topology.faces ?? []) {
        for (let index = 0; index < face.length; index++) {
          const a = face[index], b = face[(index + 1) % face.length];
          faceEdges.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        }
      }
      for (const [a, b] of topology.edges) {
        if (a < positions.count && b < positions.count && !faceEdges.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) {
          lines.push(`l ${a + vertexOffset} ${b + vertexOffset}`);
        }
      }
    }

    vertexOffset += positions.count;
    if (uvs) uvOffset += uvs.count;
    if (normals) normalOffset += normals.count;
  });

  return lines.join('\n') + '\n';
}
