#!/usr/bin/env node
import fs from 'node:fs';
import { loadBlendFile } from '../lib/blend-import.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Pass one or more .blend file paths to verify their import.');
  process.exit(2);
}

for (const path of files) {
  const root = await loadBlendFile(new Uint8Array(fs.readFileSync(path)));
  const result = { file: path, objects: 0, vertices: 0, triangles: 0, storedEdges: 0, windingCorrections: 0 };
  root.traverse((object) => {
    if (object.userData.isWire) result.storedEdges += object.geometry.attributes.position.count / 2;
    if (!object.isMesh) return;
    result.objects++;
    result.vertices += object.geometry.attributes.position.count;
    result.triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    result.windingCorrections += object.geometry.userData.windingCorrections ?? 0;
  });
  if (!result.objects) throw new Error(`${path}: no meshes were imported`);
  console.log(JSON.stringify(result));
}
