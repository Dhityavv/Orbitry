# Orbitry

Orbitry is a modern, high-performance browser-based 3D asset previewer and converter built with Next.js, React, and Three.js. It supports `.blend`, `.glb`, `.gltf`, and `.obj` files with client-side automated conversion, clean polygon topology handling, and accurate upright texture rendering.

## Automated Conversion Mechanism

When you import a `.blend` file (via drag-and-drop, file selector, or example templates):
1. **Automatic Conversion**: Orbitry automatically converts the `.blend` file into **GLB (glTF 2.0 Binary)**—the optimal web 3D standard supporting complete PBR materials, roughness, metalness, and embedded textures.
2. **Topology-Preserving OBJ**: Orbitry simultaneously prepares a clean **Wavefront OBJ** export that preserves original quad and n-gon polygon face loops.
3. **Instant Preview & Format Toggling**: The viewport renders the verified converted model. A sleek conversion action bar lets you toggle between the textured GLB preview and the OBJ topology preview with one click.
4. **1-Click Downloads**: Download the converted `.glb` or `.obj` file immediately without waiting for secondary conversions.

## Texture & Topology Fixes

- **Upright Texture Alignment**: Fixed vertical texture inversion (`flipY = true` in Three.js and proper glTF canvas flipping). Textures from Blender models render right-side up without vertical flipping.
- **UV Seam Splitting**: UV coordinates are mapped per corner loop, and vertices on UV seams are cleanly separated. This eliminates seam stretching, texture bleeding, and overlapping distortion.
- **Smooth Normal Accumulation**: Vertex normals are calculated per 3D position across UV splits, guaranteeing seamless, neat lighting across the entire mesh.
- **Winding Order Consistency**: Newell's method checks polygon face normals and corrects triangle windings, preventing inverted or overlapping faces.

## Documentation

- [`architecture.md`](./architecture.md): In-depth system architecture, pipeline flow, UV seam splitting algorithms, and conversion engine specifications.
- [`design.md`](./design.md): UI/UX design specifications, shading modes, fast pie menus, color system, and interaction ergonomics.

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
