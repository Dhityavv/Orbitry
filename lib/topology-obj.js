import * as THREE from 'three';

export function exportTopologyObj(root) {
  const lines = ['# Exported by Orbitry'];
  let vertexOffset = 1;
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    const positions = mesh.geometry.getAttribute('position');
    const topology = mesh.geometry.userData.originalTopology;
    lines.push(`o ${(mesh.name || 'Mesh').replace(/[\\r\\n]/g, '_')}`);
    for (let index = 0; index < positions.count; index++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
      lines.push(`v ${point.x} ${point.y} ${point.z}`);
    }
    const faces = topology?.faces ?? (() => {
      const indices = mesh.geometry.getIndex();
      const result = [];
      if (indices) {
        for (let index = 0; index + 2 < indices.count; index += 3) result.push([indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)]);
      } else {
        for (let index = 0; index + 2 < positions.count; index += 3) result.push([index, index + 1, index + 2]);
      }
      return result;
    })();
    for (const face of faces) {
      if (face.length >= 3 && face.every((index) => Number.isInteger(index) && index >= 0 && index < positions.count)) {
        lines.push(`f ${face.map((index) => index + vertexOffset).join(' ')}`);
      }
    }
    if (topology?.edges?.length) {
      const faceEdges = new Set();
      for (const face of topology.faces ?? []) {
        for (let index = 0; index < face.length; index++) {
          const a = face[index], b = face[(index + 1) % face.length];
          faceEdges.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        }
      }
      for (const [a, b] of topology.edges) {
        if (!faceEdges.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) lines.push(`l ${a + vertexOffset} ${b + vertexOffset}`);
      }
    }
    vertexOffset += positions.count;
  });
  return lines.join('\n') + '\n';
}
