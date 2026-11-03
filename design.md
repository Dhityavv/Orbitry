# Orbitry Design Documentation

## 1. Design Vision & Philosophy

Orbitry is designed as a focused, lightweight, and friction-free 3D asset inspection and conversion workstation. It bridges the gap between complex desktop Digital Content Creation (DCC) software (like Blender) and web-based asset distribution.

### Core Principles
- **Instant Gratification**: Zero server round-trips, zero file uploads, zero login barriers. Drop a file, view it immediately.
- **Automated Intelligence**: Automatically convert `.blend` files into the optimal web-ready standard (`GLB` / `glTF 2.0`) while preserving polygon topology (`OBJ`).
- **Visual Accuracy**: PBR materials, faithful color representation (sRGB), physically based lighting, and guaranteed upright texture mapping.
- **Professional Ergonomics**: Blender-inspired workflow shortcuts (`Z`, `X`, `1–4`, `H`, `G`, `R`, `F`) combined with modern web UI patterns.

---

## 2. Automatic Conversion UX Workflow

```
+-------------------------------------------------------------------------------------------------+
|                                VIEWPORT USER INTERFACE                                          |
|                                                                                                 |
|  [Brand] Orbitry           [Solid | Material | Render | Wire]       [Templates | Objects | Convert] |
|                                                                                                 |
|                                                                                                 |
|                                                                                                 |
|                                        [ 3D MODEL ]                                             |
|                                                                                                 |
|                                                                                                 |
|  [Tools Menu]                                                                       [View Dial] |
|  - Grid                                                                             - 142 deg   |
|  - Auto-Rotate                                                                      - Presets   |
|  - Track Object                                                                                 |
|                                                                                                 |
|  [Stats: model.blend | 14 Objects | 923,976 Tris]                                               |
+-------------------------------------------------------------------------------------------------+
```

### 2.1 The Conversion Experience
1. **Drop & Detect**: The user drags and drops a `.blend` file into Orbitry.
2. **Immediate Feedback**: A toast and loading indicator inform the user that the file is being parsed and automatically converted into standard web formats (`GLTF/GLB` and `OBJ`).
3. **Clean Automatic Presentation**:
   - Orbitry automatically converts and loads the converted **GLB (glTF 2.0 Binary)** model, showcasing accurate PBR materials, roughness, metalness, and upright textures.
   - The viewport remains completely clean and unobstructed, without floating banners or popups overlaying the 3D model.
4. **Organized Convert Menu Integration**:
   - When the user clicks the **Convert** panel, an **Auto-Converted Files Ready** section is available:
     - `View GLB` / `View OBJ`: Seamlessly toggle the viewport representation.
     - `Download Converted GLB`: One-click download of the converted `.glb` file.
     - `Download Converted OBJ`: One-click download of the converted `.obj` file.

---

## 3. Shading Modes

Orbitry provides four specialized shading modes to accommodate distinct asset inspection needs:

| Mode | Shortcut | Primary Purpose | Lighting & Shading Model |
| :--- | :--- | :--- | :--- |
| **Solid** | `1` | Form, silhouette, and geometry inspection | Neutral clay material (`0xb9bdca`), ambient + directional key lighting, no textures. |
| **Material Preview** | `2` | Texture placement, roughness, and color verification | Full PBR material evaluation, sRGB color space, HDRI studio environment reflections. |
| **Render** | `3` | Presentation renders and lighting fidelity | ACESFilmic tone mapping, directional key shadow mapping with PCF soft filtering, shadow receiver ground plane, high pixel ratio (up to 3x). |
| **Wireframe** | `4` | Topology flow and polygon edge inspection | Transparent base mesh with high-contrast edge overlays (`0x292d38`), highlighting quad loops and stored mesh edges. |

---

## 4. Interaction Architecture & Ergonomics

### 4.1 Radial Fast Menus (Pie Menus)
Orbitry incorporates gesture-driven pie menus designed for rapid switching without cursor repositioning:
- **Shading Pie Menu (`Hold Z`)**:
  - **Top**: Render Mode
  - **Right**: Solid Mode
  - **Bottom**: Material Preview Mode
  - **Left**: Wireframe Mode
- **Tools Pie Menu (`Hold X`)**:
  - **Top**: Grid Toggle
  - **Right**: Auto-Rotate Toggle
  - **Bottom**: Default View (Frame Scene)
  - **Left**: Track to Object

### 4.2 Spatial View Dial & Camera Controls
- **360° Orientation Ring**: A minimalist circular compass positioned in the bottom-right corner displays real-time camera azimuthal rotation in degrees.
- **Quick Preset Views**: Six instant camera orientations:
  - `Default` (Isometric Perspective)
  - `Front` $(+Z)$
  - `Back` $(-Z)$
  - `Left` $(-X)$
  - `Right` $(+X)$
  - `Top` $(+Y)$
- **OrbitControls Tuning**: Smooth damping factor of `0.08` for tactile camera panning, rotation, and zooming.
- **Track to Object**: Focuses the camera center directly on the bounding box center of any selected mesh with smooth distance scaling.

### 4.3 Scene Outliner & Object Isolation
- **Raycast Selection**: Click directly on any visible mesh in the viewport to select it with a high-visibility accent bounding box (`0x4f46ff`).
- **Object Row Visibility**: The Objects panel allows individual mesh toggling (`◉` visible / `○` hidden).
- **Hide / Unhide Shortcuts**:
  - `H`: Hide the currently selected mesh.
  - `Alt + H`: Unhide all meshes simultaneously.
  - `Ctrl + Z`: Undo visibility changes (up to 100 history steps).
  - `Ctrl + Shift + Z`: Redo visibility changes.

---

## 5. Visual Design System

### 5.1 Color Palette & Themes
Orbitry offers three themes adapted to different ambient working conditions:

```
+---------------------------------------------------------------------------------+
| THEME TOKENS        | DARK (Default)       | STUDIO              | LIGHT        |
+---------------------+----------------------+---------------------+--------------+
| --viewport          | #181b23 (Deep Slate) | #dfe2ea (Cool Gray) | #f3eee7 (Warm)
| --panel             | rgba(30,34,44, 0.86) | rgba(255,255,255,.8)| rgba(255,...)
| --text              | #eceef4 (Off-White)  | #1a1d26 (Charcoal)  | #1a1d26      |
| --mute              | #9aa0b2 (Muted Gray) | #6b7080             | #6b7080      |
| --accent            | #8b86ff (Lavender)   | #4f46ff (Indigo)    | #4f46ff      |
| --line              | rgba(255,255,255,.12)| rgba(26,29,38,.12)  | rgba(26,...) |
+---------------------------------------------------------------------------------+
```

### 5.2 Typography
- **Primary Typeface**: `Bricolage Grotesque`, system-ui fallback.
- **Body & Controls**: 13–14px with 1.4 line-height for crisp legibility in dark mode.
- **Numerical Indicators**: `tabular-nums` formatting across rotation degrees, triangle counts, and vertex statistics to prevent visual jitter during camera motion.

### 5.3 Surface & Glassmorphism
- Panels utilize backdrop blur (`backdrop-filter: blur(14px)`) with subtle hairline borders (`1px solid var(--line)`) and soft ambient elevation shadows (`box-shadow: 0 8px 28px rgba(18,20,30,0.06)`).

---

## 6. Feedback & Accessibility

- **Non-blocking Toast System**: Status notifications appear at the top center with automatic 3.5–5 second expiration, keeping the viewport clutter-free.
- **Reduced Motion Support**: `@media (prefers-reduced-motion: reduce)` disables animations and smooth transitions for sensitive users.
- **Keyboard Navigation**: Comprehensive hotkeys for all core functions; accessible keyboard shortcuts modal (`?` / `Keyboard Shortcuts` button) for easy reference.
