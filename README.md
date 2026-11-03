# Orbitry

Orbitry is a browser-based 3D asset previewer built with Next.js, React, and Three.js. It supports `.blend`, `.glb`, `.gltf`, and `.obj` files.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Next.js. Selected model files are read in your browser, stay on your device, and are not uploaded to the website.

## Blender file support

- Blender 3.x and 4.x: Orbitry reads legacy SDNA mesh data, including stored edges and polygon boundaries.
- Blender 5.2.x, including 5.2.3: Orbitry reads Blender 5 `AttributeStorage` mesh data through `jsblender`.
- Zstandard-compressed Blender files are decompressed before parsing.
- Concave polygons are triangulated for display while stored mesh edges are used for Wireframe mode.

The parser has been verified with real files saved by Blender 3.6, 4.4, and 5.2, including a Zstandard-compressed 5.2 file and a concave-face topology fixture. Those checks do not guarantee every historical or future Blender file layout. Blender's `.blend` format changes over time, and `jsblender`'s Blender 5 reader is still a work in progress. If a file fails to load, export it from Blender as glTF 2.0 (`.glb`).

Direct `.blend` preview reads mesh data only. It does not evaluate modifiers, shape keys, geometry nodes, or Blender shader nodes/material graphs. The preview uses basic material color and roughness data when available.

## Verify a Blender file

```bash
npm run test:blend -- "C:/path/to/model.blend"
```

The check prints the imported mesh, vertex, triangle, and stored-edge counts. It requires Node.js and the project dependencies installed by `npm install`.

## Controls

- Hold `Z`: top Render, right Solid, bottom Material Preview, left Wireframe.
- Hold `X`: Grid, Auto-Rotate, Default View, and Track to Object.
- `1`–`4`: switch shading modes; `G`: toggle grid; `R`: toggle auto-rotation; `F`: frame the scene.
- `H`: hide the selected mesh; `Alt+H`: show all meshes; `Ctrl+Z`: undo visibility; `Ctrl+Shift+Z`: redo visibility.
- Click a mesh to select it, or click empty viewport space to deselect. The view dial offers Default, Front, Back, Left, Right, and Top views.
- Use Templates to choose a viewport background or add `.blend` files to three Example Model slots. Slots remain available for the current browser session.
- Open Objects or click a mesh in the viewport to select it. Use the eye button to hide or show an object, or Show All to unhide every mesh.
- The default background template is Dark. Studio and Light remain available in Templates.
- Use Help & Feedback in About to open the project's bug and suggestion form.
- Use Convert to export the current visible model as GLB, glTF, OBJ, STL, or PLY. OBJ preserves original polygon faces for directly imported `.blend` files; GLB, glTF, STL, and PLY use triangles, as required by these exporters. Exports are created in the browser and are not uploaded.
- OBJ can preserve the original face loops only when the imported source contains them. Files already limited to triangles cannot recover their earlier polygon topology. OBJ export includes mesh geometry and faces, but does not create a companion material file.

The Objects panel lists mesh objects only. Non-mesh Blender objects such as cameras, lights, and empties are not imported into the preview.
