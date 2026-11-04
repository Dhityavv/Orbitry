'use client';

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadBlendFile } from '../lib/blend-import.js';
import { exportTopologyObj } from '../lib/topology-obj.js';

type ViewMode = 'solid' | 'material' | 'render' | 'wire';
type FastMenu = { key: 'z' | 'x'; x: number; y: number; hover: number };
type SceneObject = { id: string; name: string; visible: boolean; object: THREE.Mesh };
type TemplateModelSlot = { name: string; file: File | null; url?: string };
type ExportFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply';
type ConvertedModel = {
  sourceName: string;
  baseName: string;
  activeFormat: 'glb' | 'obj';
  glbBuffer?: ArrayBuffer;
  objData?: string;
  gltfScene?: THREE.Group;
  objScene?: THREE.Group;
  convertedAt: string;
};
type Engine = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  grid: THREE.GridHelper;
  floor: THREE.Mesh;
  hemisphere: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  environment: THREE.Texture;
  model: THREE.Group | null;
  solidMaterial: THREE.MeshStandardMaterial;
  hiddenMaterial: THREE.MeshBasicMaterial;
  selectionBox: THREE.BoxHelper;
};

const modes: { id: ViewMode; label: string; shortcut: string }[] = [
  { id: 'solid', label: 'Solid', shortcut: '1' },
  { id: 'material', label: 'Material Preview', shortcut: '2' },
  { id: 'wire', label: 'Wireframe', shortcut: '4' },
  { id: 'render', label: 'Render', shortcut: '3' },
];
const zMenu: { label: string; action: ViewMode }[] = [
  { label: 'Render', action: 'render' },
  { label: 'Solid', action: 'solid' },
  { label: 'Material Preview', action: 'material' },
  { label: 'Wireframe', action: 'wire' },
];
const xMenu = ['Grid', 'Auto-Rotate', 'Default View', 'Track to Object'];

function disposeTree(root: THREE.Object3D, sharedMaterials: THREE.Material[] = []) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => { if (!sharedMaterials.includes(material)) material.dispose(); });
    }
  });
}

function addDerivedEdges(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.children.some((child) => child.userData.isWire)) return;
    const edges = new THREE.EdgesGeometry(mesh.geometry, 1);
    const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x292d38 }));
    lines.userData.isWire = true;
    lines.visible = false;
    mesh.add(lines);
  });
}

function createDemo() {
  const group = new THREE.Group();
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.7, 0.24, 200, 32),
    new THREE.MeshStandardMaterial({ color: 0x4f46ff, metalness: 0.6, roughness: 0.25 }),
  );
  knot.position.y = 1.3;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.5, 0.25, 64),
    new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.5 }),
  );
  base.position.y = 0.12;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xff6a3d, roughness: 0.3 }),
  );
  sphere.position.set(0.95, 0.5, 0.2);
  group.add(knot, base, sphere);
  return group;
}

export default function OrbitryViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const modeRef = useRef<ViewMode>('material');
  const pieRef = useRef<FastMenu | null>(null);
  const mouseRef = useRef({ x: typeof window === 'undefined' ? 640 : window.innerWidth / 2, y: typeof window === 'undefined' ? 360 : window.innerHeight / 2 });
  const [mode, setMode] = useState<ViewMode>('material');
  const [theme, setTheme] = useState('dark');
  const [gridOn, setGridOn] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [degree, setDegree] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [templateModels, setTemplateModels] = useState<TemplateModelSlot[]>([
    { name: 'sushi-sashimi.blend', file: null, url: '/templates/sushi-sashimi.blend' },
    { name: 'tedung-keraton.blend', file: null, url: '/templates/tedung-keraton.blend' },
    { name: 'fantasy-fish.blend', file: null, url: '/templates/fantasy-fish.blend' },
  ]);
  const [convertedModel, setConvertedModel] = useState<ConvertedModel | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [sceneObjects, setSceneObjects] = useState<SceneObject[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [dropOpen, setDropOpen] = useState(false);
  const [pie, setPie] = useState<FastMenu | null>(null);
  const [message, setMessage] = useState('');
  const [modelInfo, setModelInfo] = useState({ name: 'Preview Models', objects: 3, triangles: 0 });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sceneObjectsRef = useRef<SceneObject[]>([]);
  const visibilityHistory = useRef<{ past: Array<Record<string, boolean>>; future: Array<Record<string, boolean>> }>({ past: [], future: [] });

  const toast = useCallback((text: string, duration = 5000) => {
    setMessage(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(''), duration);
  }, []);
  const selectMode = useCallback((next: ViewMode) => setMode(next), []);

  const frameModel = useCallback(() => {
    const engine = engineRef.current;
    if (!engine?.model) return;
    const bounds = new THREE.Box3();
    engine.model.traverse((object) => {
      if (!object.visible || object.userData.isWire || (!(object as THREE.Mesh).isMesh)) return;
      bounds.expandByObject(object);
    });
    if (bounds.isEmpty()) bounds.setFromObject(engine.model);
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2 || 1;
    engine.floor.position.y = bounds.min.y - 0.001;
    engine.controls.target.copy(center);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(engine.camera.fov / 2)) * 0.9;
    engine.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.55, 1).normalize().multiplyScalar(distance));
    engine.camera.near = distance / 200;
    engine.camera.far = distance * 50;
    engine.camera.updateProjectionMatrix();
    engine.controls.update();
  }, []);

  const trackSelectedObject = useCallback(() => {
    const engine = engineRef.current;
    const selected = sceneObjects.find((item) => item.id === selectedObjectId && item.visible);
    if (!engine || !selected) {
      toast('Select a visible object first.');
      return;
    }
    const bounds = new THREE.Box3().setFromObject(selected.object);
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    const direction = engine.camera.position.clone().sub(engine.controls.target).normalize();
    if (direction.lengthSq() === 0) direction.set(0.8, 0.55, 1).normalize();
    const distance = Math.max(radius / Math.sin(THREE.MathUtils.degToRad(engine.camera.fov / 2)) * 1.35, 0.75);
    engine.controls.target.copy(center);
    engine.camera.position.copy(center).add(direction.multiplyScalar(distance));
    engine.camera.near = Math.max(distance / 200, 0.001);
    engine.camera.far = Math.max(distance * 50, 100);
    engine.camera.updateProjectionMatrix();
    engine.controls.update();
    engine.selectionBox.setFromObject(selected.object);
  }, [sceneObjects, selectedObjectId, toast]);

  const toggleGrid = useCallback(() => {
    const next = !engineRef.current?.grid.visible;
    if (engineRef.current) engineRef.current.grid.visible = next;
    setGridOn(next);
  }, []);
  const toggleSpin = useCallback(() => {
    const next = !engineRef.current?.controls.autoRotate;
    if (engineRef.current) engineRef.current.controls.autoRotate = next;
    setSpinning(next);
  }, []);

  const applyVisibilitySnapshot = (snapshot: Record<string, boolean>) => {
    const next = sceneObjectsRef.current.map((item) => {
      const visible = snapshot[item.id] ?? item.visible;
      item.object.visible = visible;
      return { ...item, visible };
    });
    sceneObjectsRef.current = next;
    setSceneObjects(next);
    if (selectedObjectId && !next.find((item) => item.id === selectedObjectId)?.visible) setSelectedObjectId(null);
  };
  const commitVisibility = (getVisible: (item: SceneObject) => boolean) => {
    const current = sceneObjectsRef.current;
    const next = current.map((item) => ({ ...item, visible: getVisible(item) }));
    if (!next.some((item, index) => item.visible !== current[index].visible)) return;
    visibilityHistory.current.past.push(Object.fromEntries(current.map((item) => [item.id, item.visible])));
    if (visibilityHistory.current.past.length > 100) visibilityHistory.current.past.shift();
    visibilityHistory.current.future = [];
    next.forEach((item) => { item.object.visible = item.visible; });
    sceneObjectsRef.current = next;
    setSceneObjects(next);
    if (selectedObjectId && !next.find((item) => item.id === selectedObjectId)?.visible) setSelectedObjectId(null);
  };
  const undoVisibility = () => {
    const previous = visibilityHistory.current.past.pop();
    if (!previous) return;
    visibilityHistory.current.future.push(Object.fromEntries(sceneObjectsRef.current.map((item) => [item.id, item.visible])));
    applyVisibilitySnapshot(previous);
  };
  const redoVisibility = () => {
    const next = visibilityHistory.current.future.pop();
    if (!next) return;
    visibilityHistory.current.past.push(Object.fromEntries(sceneObjectsRef.current.map((item) => [item.id, item.visible])));
    applyVisibilitySnapshot(next);
  };

  const setLoadedModel = useCallback((root: THREE.Group | THREE.Object3D, name: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.model) {
      engine.scene.remove(engine.model);
      disposeTree(engine.model, [engine.solidMaterial, engine.hiddenMaterial]);
    }
    const group = root as THREE.Group;
    addDerivedEdges(group);
    group.updateMatrixWorld(true);
    engine.model = group;
    group.userData.name = name;
    const objects: SceneObject[] = [];
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.name) mesh.name = `Mesh ${objects.length + 1}`;
      mesh.userData.originalMaterial ??= mesh.material;
      const origMats = Array.isArray(mesh.userData.originalMaterial) ? mesh.userData.originalMaterial : [mesh.userData.originalMaterial];
      origMats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
      mesh.material = modeRef.current === 'wire' ? engine.hiddenMaterial : modeRef.current === 'solid' ? engine.solidMaterial : mesh.userData.originalMaterial;
      const activeMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      activeMats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
      mesh.castShadow = modeRef.current === 'render';
      mesh.receiveShadow = modeRef.current === 'render';
      objects.push({ id: mesh.uuid, name: mesh.name, visible: mesh.visible, object: mesh });
    });
    setSceneObjects(objects);
    sceneObjectsRef.current = objects;
    visibilityHistory.current = { past: [], future: [] };
    setSelectedObjectId(null);
    engine.scene.add(group);
    const metrics = { objects: 0, triangles: 0 };
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      metrics.objects++;
      const geometry = mesh.geometry;
      metrics.triangles += (geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3;
    });
    setModelInfo({ name, objects: metrics.objects, triangles: Math.round(metrics.triangles) });
    frameModel();
    toast(`Loaded ${name}.`, 3500);
  }, [frameModel, toast]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x555a66, 0.9);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(4, 8, 5);
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    const grid = new THREE.GridHelper(20, 40, 0x868b9a, 0xb9bdca);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.28 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.visible = false;
    scene.add(hemisphere, key, grid, floor);
    const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x4f46ff);
    selectionBox.visible = false;
    scene.add(selectionBox);

    const environmentCanvas = document.createElement('canvas');
    environmentCanvas.width = 512;
    environmentCanvas.height = 256;
    const context = environmentCanvas.getContext('2d');
    const gradient = context?.createLinearGradient(0, 0, 0, 256);
    if (context && gradient) {
      gradient.addColorStop(0, '#cfd8ff');
      gradient.addColorStop(0.5, '#ffffff');
      gradient.addColorStop(0.55, '#8d92a3');
      gradient.addColorStop(1, '#2b2e38');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 256);
      context.fillStyle = '#fff';
      context.fillRect(90, 50, 70, 40);
    }
    const environmentSource = new THREE.CanvasTexture(environmentCanvas);
    environmentSource.mapping = THREE.EquirectangularReflectionMapping;
    environmentSource.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromEquirectangular(environmentSource).texture;
    environmentSource.dispose();
    pmrem.dispose();

    const engine: Engine = {
      renderer, scene, camera, controls, grid, floor, hemisphere, key, environment,
      model: null,
      solidMaterial: new THREE.MeshStandardMaterial({ color: 0xb9bdca, roughness: 0.65, side: THREE.DoubleSide }),
      hiddenMaterial: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      selectionBox,
    };
    scene.environment = environment;
    hemisphere.intensity = 0.15;
    key.intensity = 0.5;
    engineRef.current = engine;
    const demo = createDemo();
    demo.children.forEach((object, index) => { object.name = ['Torus Knot', 'Cylinder', 'Sphere'][index]; });
    scene.add(demo);
    engine.model = demo;
    const demoObjects = demo.children.filter((object) => (object as THREE.Mesh).isMesh).map((object) => ({ id: object.uuid, name: object.name, visible: object.visible, object: object as THREE.Mesh }));
    sceneObjectsRef.current = demoObjects;
    setSceneObjects(demoObjects);
    visibilityHistory.current = { past: [], future: [] };
    addDerivedEdges(engine.model);
    engine.model.userData.name = 'Preview Models';
    frameModel();

    const resize = () => {
      const width = window.innerWidth, height = window.innerHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    let frame = 0, lastDegreeUpdate = 0;
    const animate = (now: number) => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      if (now - lastDegreeUpdate > 120) {
        const dx = camera.position.x - controls.target.x;
        const dz = camera.position.z - controls.target.z;
        setDegree(Math.round((Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360));
        lastDegreeUpdate = now;
      }
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      controls.dispose();
      environment.dispose();
      if (engine.model) disposeTree(engine.model, [engine.solidMaterial, engine.hiddenMaterial]);
      engine.solidMaterial.dispose();
      engine.hiddenMaterial.dispose();
      renderer.dispose();
      engineRef.current = null;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [frameModel]);

  useEffect(() => {
    const engine = engineRef.current;
    const selected = sceneObjects.find((item) => item.id === selectedObjectId && item.visible);
    if (!engine || !selected) {
      if (engine) engine.selectionBox.visible = false;
      return;
    }
    engine.selectionBox.setFromObject(selected.object);
    engine.selectionBox.visible = true;
  }, [sceneObjects, selectedObjectId]);

  useEffect(() => {
    modeRef.current = mode;
    const engine = engineRef.current;
    if (!engine) return;
    engine.model?.traverse((object) => {
      if (object.userData.isWire) { object.visible = mode === 'wire'; return; }
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.userData.originalMaterial) mesh.userData.originalMaterial = mesh.material;
      const origList = (Array.isArray(mesh.userData.originalMaterial) ? mesh.userData.originalMaterial : [mesh.userData.originalMaterial]) as (THREE.Material & { alphaTest?: number; map?: THREE.Texture | null })[];
      const hasCutout = origList.some((m) => (m?.alphaTest ?? 0) > 0 && m?.map);
      if (mode === 'wire') {
        mesh.material = engine.hiddenMaterial;
      } else if (mode === 'solid') {
        if (hasCutout) {
          const solidList = origList.map((m) => {
            if ((m?.alphaTest ?? 0) > 0 && m?.map) {
              const clay = engine.solidMaterial.clone();
              clay.map = m.map;
              clay.alphaTest = m.alphaTest ?? 0.3;
              clay.transparent = true;
              clay.side = THREE.DoubleSide;
              return clay;
            }
            return engine.solidMaterial;
          });
          mesh.material = Array.isArray(mesh.userData.originalMaterial) ? solidList : solidList[0];
        } else {
          mesh.material = engine.solidMaterial;
        }
      } else {
        mesh.material = mesh.userData.originalMaterial;
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      list.forEach((material) => {
        (material as THREE.Material & { wireframe?: boolean }).wireframe = false;
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      });
      mesh.castShadow = mode === 'render';
      mesh.receiveShadow = mode === 'render' && !hasCutout;
      if (hasCutout) {
        const mat = (origList.find((m) => (m?.alphaTest ?? 0) > 0 && m?.map) || origList[0]) as THREE.MeshStandardMaterial;
        if (mat?.map) {
          mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            map: mat.map,
            alphaTest: mat.alphaTest || 0.3,
          });
        }
      }
    });
    engine.scene.environment = mode === 'solid' || mode === 'wire' ? null : engine.environment;
    engine.hemisphere.intensity = mode === 'solid' || mode === 'wire' ? 0.9 : 0.15;
    engine.key.intensity = mode === 'solid' || mode === 'wire' ? 0.9 : mode === 'render' ? 1.4 : 0.5;
    engine.key.castShadow = mode === 'render';
    engine.floor.visible = mode === 'render';
    engine.renderer.toneMapping = mode === 'render' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    engine.renderer.toneMappingExposure = 1;
    engine.renderer.setPixelRatio(mode === 'render' ? Math.min(window.devicePixelRatio * 1.5, 3) : Math.min(window.devicePixelRatio, 2));
    engine.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }, [mode]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const engine = engineRef.current;
    if (engine) {
      const values = getComputedStyle(document.documentElement);
      engine.scene.background = new THREE.Color(values.getPropertyValue('--viewport').trim());
      (engine.grid.material as THREE.LineBasicMaterial).color.set(values.getPropertyValue('--grid').trim());
    }
  }, [theme]);

  useEffect(() => {
    const openPie = (key: 'z' | 'x') => {
      const x = Math.min(Math.max(mouseRef.current.x, 130), window.innerWidth - 130);
      const y = Math.min(Math.max(mouseRef.current.y, 130), window.innerHeight - 130);
      const next = { key, x, y, hover: -1 };
      pieRef.current = next;
      setPie(next);
    };
    const closePie = (apply: boolean) => {
      const current = pieRef.current;
      if (!current) return;
      if (apply && current.hover >= 0) {
        if (current.key === 'z') selectMode(zMenu[current.hover].action);
        else if (current.hover === 0) toggleGrid();
        else if (current.hover === 1) toggleSpin();
        else if (current.hover === 2) frameModel();
        else if (current.hover === 3) trackSelectedObject();
      }
      pieRef.current = null;
      setPie(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      mouseRef.current = { x: event.clientX, y: event.clientY };
      const current = pieRef.current;
      if (!current) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      const count = current.key === 'z' ? zMenu.length : xMenu.length;
      const hover = Math.hypot(dx, dy) < 28 ? -1 : Math.round(((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2 / count)) % count;
      const updated = { ...current, hover };
      pieRef.current = updated;
      setPie(updated);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (/INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName ?? '') || (event.target as HTMLElement)?.isContentEditable) return;
      if (event.key === 'Escape') {
        setAboutOpen(false);
        setShortcutsOpen(false);
        setTemplatesOpen(false);
        setObjectsOpen(false);
        setConvertOpen(false);
        if (pieRef.current) closePie(false);
        return;
      }
      if (aboutOpen || shortcutsOpen || event.repeat) return;
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoVisibility();
        else undoVisibility();
        return;
      }
      if (event.altKey && key === 'h') {
        event.preventDefault();
        commitVisibility(() => true);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if ((key === 'z' || key === 'x') && !pieRef.current) { openPie(key); return; }
      if (pieRef.current) return;
      if (key === 'h' && selectedObjectId) commitVisibility((item) => item.id === selectedObjectId ? false : item.visible);
      else if (key === '1') selectMode('solid');
      else if (key === '2') selectMode('material');
      else if (key === '3') selectMode('render');
      else if (key === '4') selectMode('wire');
      else if (key === 'g') toggleGrid();
      else if (key === 'r') toggleSpin();
      else if (key === 'f') frameModel();
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key.toLowerCase() === pieRef.current?.key) closePie(true); };
    const onBlur = () => closePie(false);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [aboutOpen, shortcutsOpen, selectedObjectId, frameModel, selectMode, toggleGrid, toggleSpin, trackSelectedObject]);

  const switchToObjView = useCallback(() => {
    if (!convertedModel?.objData) return;
    try {
      const loader = new OBJLoader();
      const objGroup = loader.parse(convertedModel.objData);
      setLoadedModel(objGroup, `${convertedModel.sourceName} (OBJ View)`);
      setConvertedModel((prev) => prev ? { ...prev, activeFormat: 'obj', objScene: objGroup } : null);
      toast('Switched viewport to converted OBJ model.', 3000);
    } catch (e) {
      toast('Could not render OBJ view: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  }, [convertedModel, setLoadedModel, toast]);

  const switchToGlbView = useCallback(async () => {
    if (!convertedModel?.glbBuffer) return;
    try {
      const loader = new GLTFLoader();
      const gltf = await new Promise<THREE.Group>((resolve, reject) => {
        loader.parse(convertedModel.glbBuffer!, '', (res) => resolve(res.scene), reject);
      });
      setLoadedModel(gltf, `${convertedModel.sourceName} (GLB View)`);
      setConvertedModel((prev) => prev ? { ...prev, activeFormat: 'glb', gltfScene: gltf } : null);
      toast('Switched viewport to converted GLB model.', 3000);
    } catch (e) {
      toast('Could not render GLB view: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  }, [convertedModel, setLoadedModel, toast]);

  const downloadConvertedGlb = useCallback(() => {
    if (!convertedModel?.glbBuffer) return;
    const blob = new Blob([convertedModel.glbBuffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${convertedModel.baseName}.glb`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${convertedModel.baseName}.glb!`, 3500);
  }, [convertedModel, toast]);

  const downloadConvertedObj = useCallback(() => {
    if (!convertedModel?.objData) return;
    const blob = new Blob([convertedModel.objData], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${convertedModel.baseName}.obj`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${convertedModel.baseName}.obj!`, 3500);
  }, [convertedModel, toast]);

  const loadFile = useCallback(async (file: File): Promise<boolean> => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    try {
      if (extension === 'blend') {
        setIsConverting(true);
        toast(`Auto-converting ${file.name} to GLTF/GLB (best option for web preview)...`, 30000);

        // 1. Parse .blend file into intermediate representation with upright textures and seam-split UVs
        const bytes = new Uint8Array(await file.arrayBuffer());
        const intermediateRoot = await loadBlendFile(bytes);

        // Ensure double-sided rendering on intermediate root so no faces are culled
        intermediateRoot.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh && mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
          }
        });

        // 2. Prepare clean export group (strip wireframes)
        const exportRoot = intermediateRoot.clone(true);
        const wires: THREE.Object3D[] = [];
        exportRoot.traverse((obj) => {
          if (obj.userData?.isWire) wires.push(obj);
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh && mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
          }
        });
        wires.forEach((w) => w.removeFromParent());
        exportRoot.updateMatrixWorld(true);

        const baseName = file.name.replace(/\.[^.]+$/, '') || 'orbitry-model';

        // 3. Defensively convert to standard GLB and OBJ
        let glbBuffer: ArrayBuffer | null = null;
        let gltfScene: THREE.Group | null = null;
        let objData: string | null = null;

        try {
          const gltfExporter = new GLTFExporter();
          glbBuffer = (await gltfExporter.parseAsync(exportRoot, {
            binary: true,
            embedImages: true,
          })) as ArrayBuffer;

          const gltfLoader = new GLTFLoader();
          gltfScene = await new Promise<THREE.Group>((resolve, reject) => {
            gltfLoader.parse(glbBuffer!, '', (result) => resolve(result.scene), reject);
          });

          gltfScene.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.isMesh && mesh.material) {
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
            }
          });

          // Preserve original topology data for future OBJ export
          const origMeshes: THREE.Mesh[] = [];
          exportRoot.traverse((o) => { if ((o as THREE.Mesh).isMesh) origMeshes.push(o as THREE.Mesh); });
          const gltfMeshes: THREE.Mesh[] = [];
          gltfScene.traverse((o) => { if ((o as THREE.Mesh).isMesh) gltfMeshes.push(o as THREE.Mesh); });
          gltfMeshes.forEach((mesh, idx) => {
            if (origMeshes[idx]?.geometry?.userData?.originalTopology) {
              mesh.geometry.userData.originalTopology = origMeshes[idx].geometry.userData.originalTopology;
            }
          });
        } catch (convErr) {
          console.warn('GLB auto-conversion encountered warning:', convErr);
        }

        try {
          objData = exportTopologyObj(exportRoot);
        } catch (objErr) {
          console.warn('OBJ topology export encountered warning:', objErr);
        }

        setConvertedModel({
          sourceName: file.name,
          baseName,
          activeFormat: 'glb',
          glbBuffer: glbBuffer ?? undefined,
          objData: objData ?? undefined,
          gltfScene: gltfScene ?? undefined,
          convertedAt: new Date().toLocaleTimeString(),
        });

        const displayModel = intermediateRoot;
        setLoadedModel(displayModel, file.name);
        setIsConverting(false);
        toast(`✨ Successfully auto-converted ${file.name}. Previewing model.`, 4000);
        return true;
      } else if (extension === 'obj') {
        setConvertedModel(null);
        const root = new OBJLoader().parse(await file.text());
        setLoadedModel(root, file.name);
        return true;
      } else if (extension === 'glb' || extension === 'gltf') {
        setConvertedModel(null);
        const data = await file.arrayBuffer();
        const loader = new GLTFLoader();
        const gltf = await new Promise<THREE.Group>((resolve, reject) => loader.parse(data, '', (result) => resolve(result.scene), reject));
        setLoadedModel(gltf, file.name);
        return true;
      } else {
        toast(`The .${extension ?? 'unknown'} format is not supported. Use .blend, .glb, .gltf, or .obj.`);
        return false;
      }
    } catch (error) {
      setIsConverting(false);
      const reason = error instanceof Error ? error.message : 'The file could not be parsed.';
      toast(`${reason} For best compatibility, export from Blender as glTF 2.0 (.glb).`, 10000);
      return false;
    }
  }, [setLoadedModel, toast]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadFile(file);
    event.target.value = '';
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDropOpen(false);
    const file = event.dataTransfer.files[0];
    if (file) void loadFile(file);
  };
  const selectView = (view: 'persp' | 'front' | 'right' | 'left' | 'back' | 'top') => {
    const engine = engineRef.current;
    if (!engine) return;
    const distance = engine.camera.position.distanceTo(engine.controls.target);
    const target = engine.controls.target;
    const direction: Record<typeof view, THREE.Vector3> = {
      persp: new THREE.Vector3(0.8, 0.55, 1),
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(-1, 0, 0),
      top: new THREE.Vector3(0, 1, 0.0001),
    };
    engine.camera.position.copy(target).add(direction[view].normalize().multiplyScalar(distance));
    engine.controls.update();
  };
  const toggleObjectVisibility = (item: SceneObject) => {
    commitVisibility((entry) => entry.id === item.id ? !entry.visible : entry.visible);
  };
  const showAllObjects = () => {
    commitVisibility(() => true);
  };
  const selectObjectAtPointer = (event: React.MouseEvent<HTMLCanvasElement>) => {
    setTemplatesOpen(false);
    setObjectsOpen(false);
    setConvertOpen(false);
    const engine = engineRef.current;
    if (!engine) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, engine.camera);
    const hits = raycaster.intersectObjects(sceneObjects.filter((item) => item.visible).map((item) => item.object), false);
    if (hits.length) {
      setSelectedObjectId(hits[0].object.uuid);
    } else setSelectedObjectId(null);
  };
  const loadTemplateSlot = async (slot: TemplateModelSlot) => {
    if (slot.file && await loadFile(slot.file)) {
      setTemplatesOpen(false);
      return;
    }
    if (slot.url) {
      try {
        const response = await fetch(slot.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const file = new File([await response.blob()], slot.name, { type: 'application/octet-stream' });
        if (await loadFile(file)) setTemplatesOpen(false);
      } catch (error) {
        toast(`Could not load ${slot.name}. Check that it exists in public/templates.`);
      }
    }
  };
  const toggleTemplates = () => {
    setTemplatesOpen((open) => !open);
    setObjectsOpen(false);
    setConvertOpen(false);
  };
  const toggleObjects = () => {
    setObjectsOpen((open) => !open);
    setTemplatesOpen(false);
    setConvertOpen(false);
  };
  const toggleConvert = () => {
    setConvertOpen((open) => !open);
    setTemplatesOpen(false);
    setObjectsOpen(false);
  };
  const exportModel = async (format: ExportFormat) => {
    if (format === 'glb' && convertedModel?.glbBuffer) {
      downloadConvertedGlb();
      setConvertOpen(false);
      return;
    }
    if (format === 'obj' && convertedModel?.objData) {
      downloadConvertedObj();
      setConvertOpen(false);
      return;
    }

    const engine = engineRef.current;
    if (!engine?.model) {
      toast('Load a model before converting it.');
      return;
    }
    toast(`Preparing ${format.toUpperCase()} export…`, 30000);
    const exportRoot = engine.model.clone(true);
    const sourceMeshes: THREE.Mesh[] = [];
    const exportMeshes: THREE.Mesh[] = [];
    engine.model.traverse((object) => { if ((object as THREE.Mesh).isMesh) sourceMeshes.push(object as THREE.Mesh); });
    exportRoot.traverse((object) => { if ((object as THREE.Mesh).isMesh) exportMeshes.push(object as THREE.Mesh); });
    exportMeshes.forEach((mesh, index) => {
      const source = sourceMeshes[index];
      mesh.material = source.userData.originalMaterial ?? source.material;
      let ancestor: THREE.Object3D | null = source;
      let visible = true;
      while (ancestor && ancestor !== engine.model) { visible &&= ancestor.visible; ancestor = ancestor.parent; }
      if (!visible) mesh.removeFromParent();
    });
    const wireObjects: THREE.Object3D[] = [];
    exportRoot.traverse((object) => { if (object.userData.isWire) wireObjects.push(object); });
    wireObjects.forEach((object) => object.removeFromParent());
    exportRoot.updateMatrixWorld(true);
    try {
      let data: string | ArrayBuffer;
      let mime: string;
      if (format === 'glb' || format === 'gltf') {
        const output = await new GLTFExporter().parseAsync(exportRoot, { binary: format === 'glb' });
        data = output instanceof ArrayBuffer ? output : JSON.stringify(output);
        mime = format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json';
      } else if (format === 'obj') {
        data = exportTopologyObj(exportRoot);
        mime = 'text/plain';
      } else if (format === 'stl') {
        const output = new STLExporter().parse(exportRoot, { binary: true });
        data = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
        mime = 'model/stl';
      } else {
        data = await new Promise<string | ArrayBuffer>((resolve) => new PLYExporter().parse(exportRoot, resolve, { binary: true }));
        mime = 'application/octet-stream';
      }
      const baseName = modelInfo.name.replace(/\.[^.]+$/, '') || 'orbitry-model';
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${baseName}.${format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setConvertOpen(false);
      toast(`Exported ${baseName}.${format}.`, 3500);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The model could not be converted.';
      toast(`Export failed: ${reason}`, 10000);
    }
  };
  const savePng = () => {
    const renderer = engineRef.current?.renderer;
    if (!renderer) return;
    renderer.render(engineRef.current!.scene, engineRef.current!.camera);
    const link = document.createElement('a');
    link.download = 'orbitry-render.png';
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();
  };
  const background = (next: string) => {
    setTheme(next);
    setTemplatesOpen(false);
  };
  const fastItems = pie?.key === 'z' ? zMenu.map((item) => item.label) : xMenu;

  return (
    <main className="viewer" onDragEnter={(event) => { event.preventDefault(); setDropOpen(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDropOpen(false); }} onDrop={onDrop}>
      <div className="viewport"><canvas ref={canvasRef} tabIndex={0} aria-label="Interactive 3D viewport" onClick={selectObjectAtPointer} /></div>
      <div className="panel brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-24 12 12)" stroke="var(--accent)"/><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/></svg>Orbitry</div>
      <div className="panel modes" role="group" aria-label="Viewport shading">
        {modes.map((item) => <button key={item.id} className={mode === item.id ? 'on' : ''} title={item.shortcut} onClick={() => selectMode(item.id)}>{item.label}</button>)}
      </div>
      <div className="panel open">
        <button aria-expanded={templatesOpen} onClick={toggleTemplates}>Templates</button>
        <button aria-expanded={objectsOpen} onClick={toggleObjects}>Objects</button>
        <button aria-expanded={convertOpen} onClick={toggleConvert}>Convert</button>
        <button onClick={() => { setAboutOpen(true); setTemplatesOpen(false); setObjectsOpen(false); setConvertOpen(false); }}>About</button>
        <button className="primary" onClick={() => inputRef.current?.click()}>Select Files</button>
        <input ref={inputRef} type="file" accept=".blend,.glb,.gltf,.obj" hidden onChange={onFileChange}/>
      </div>
      {templatesOpen && <div className="panel template-menu"><div className="hint">Background</div><div className="template-backgrounds"><button onClick={() => background('studio')}>Studio</button><button onClick={() => background('light')}>Light</button><button onClick={() => background('dark')}>Dark</button></div><div className="template-section-title">Example Models</div><div className="template-slots">{templateModels.map((slot, index) => <div className="template-slot" key={index}><button className="template-load" title={`Load ${slot.name}`} onClick={() => void loadTemplateSlot(slot)}>{slot.name}</button></div>)}</div></div>}
      {objectsOpen && <div className="panel objects-menu"><div className="object-list-heading"><span>Scene Objects</span><button onClick={showAllObjects}>Show All</button></div>{sceneObjects.length ? sceneObjects.map((item) => <div className={`object-row${selectedObjectId === item.id ? ' selected' : ''}`} key={item.id}><button className="object-name" title={item.name} onClick={() => setSelectedObjectId(item.id)}>{item.name}</button><button className="object-visibility" aria-label={`${item.visible ? 'Hide' : 'Show'} ${item.name}`} title={item.visible ? 'Hide object' : 'Show object'} onClick={() => toggleObjectVisibility(item)}>{item.visible ? '◉' : '○'}</button></div>) : <div className="hint">No mesh objects</div>}</div>}
      {convertOpen && (
        <div className="panel convert-menu">
          {convertedModel && (
            <div className="converted-section">
              <div className="convert-heading">
                <strong>Auto-Converted Files Ready</strong>
                <span>Derived from {convertedModel.sourceName}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px', margin: '4px 0 8px' }}>
                <button
                  className={`convert-option ${convertedModel.activeFormat === 'glb' ? 'on' : ''}`}
                  style={{ flex: 1, padding: '7px', justifyContent: 'center', margin: 0 }}
                  onClick={() => void switchToGlbView()}
                >
                  View GLB
                </button>
                <button
                  className={`convert-option ${convertedModel.activeFormat === 'obj' ? 'on' : ''}`}
                  style={{ flex: 1, padding: '7px', justifyContent: 'center', margin: 0 }}
                  onClick={switchToObjView}
                >
                  View OBJ
                </button>
              </div>
              <button className="convert-option" onClick={downloadConvertedGlb}>
                <span className="format-badge">GLB</span>
                <div className="format-detail">
                  <b>Download Converted GLB</b>
                  <span>glTF 2.0 Binary · Embedded textures & PBR materials (Best Option)</span>
                </div>
                <span className="format-arrow">⬇</span>
              </button>
              <button className="convert-option" onClick={downloadConvertedObj}>
                <span className="format-badge">OBJ</span>
                <div className="format-detail">
                  <b>Download Converted OBJ</b>
                  <span>Clean polygon topology · Quads/N-gons preserved</span>
                </div>
                <span className="format-arrow">⬇</span>
              </button>
            </div>
          )}
          <div className="convert-heading">
            <strong>Convert to</strong>
            <span>Export the current model locally</span>
          </div>
          {([['obj', 'OBJ', 'Best choice for clean topology'], ['glb', 'GLB', 'Triangle-based glTF 2.0'], ['gltf', 'glTF', 'Triangle-based glTF 2.0'], ['stl', 'STL', 'Triangles only · no materials'], ['ply', 'PLY', 'Triangle-based geometry']] as const).map(([format, label, detail]) => (
            <button className="convert-option" key={format} onClick={() => void exportModel(format)}>
              <span className="format-badge">{label}</span>
              <div className="format-detail"><b>{label}</b><span>{detail}</span></div>
              <span className="format-arrow">›</span>
            </button>
          ))}
          <div className="convert-note">
            Orbitry automatically converts .blend files to GLB (glTF 2.0) upon import. For 3D web preview and textures, GLB is the best format. If clean polygon topology matters, OBJ is available to preserve original Blender face loops. Files stay on this device.
          </div>
        </div>
      )}
      <div className="panel tools">
        <button className={gridOn ? 'on' : ''} title="G" onClick={toggleGrid}>Grid</button>
        <button className={spinning ? 'on' : ''} title="R" onClick={toggleSpin}>Auto-Rotate</button>
        <button title="F" onClick={frameModel}>Default View</button>
        <button title="Track selected object" disabled={!selectedObjectId} onClick={trackSelectedObject}>Track to Object</button>
        <button onClick={() => { setShortcutsOpen(true); setAboutOpen(false); setTemplatesOpen(false); setObjectsOpen(false); setConvertOpen(false); }}>Keyboard Shortcuts</button>
      </div>
      <div className="panel stats"><strong>{modelInfo.name}</strong><br/>{modelInfo.objects} Object · {modelInfo.triangles.toLocaleString('en-US')} Tris</div>
      <div className="panel dial">
        <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="none" stroke="var(--line)" strokeWidth="3"/><g transform={`rotate(${-degree} 32 32)`}><circle cx="32" cy="4" r="5" fill="var(--accent)"/></g><circle cx="32" cy="32" r="3" fill="var(--text)"/></svg>
        <div><div className="degree">{degree}°</div><div className="views"><button onClick={() => selectView('persp')}>Default</button><button onClick={() => selectView('front')}>Front</button><button onClick={() => selectView('back')}>Back</button><button onClick={() => selectView('left')}>Left</button><button onClick={() => selectView('right')}>Right</button><button onClick={() => selectView('top')}>Top</button></div></div>
      </div>
      <div className={`panel save ${mode === 'render' ? 'show' : ''}`}><button onClick={savePng}>Save PNG Render</button></div>
      <div className={`panel toast ${message ? 'show' : ''}`} role="status">{message}</div>
      <div className={`drop ${dropOpen ? 'show' : ''}`}>Drop a 3D file here</div>
      <div className={`pie ${pie ? 'show' : ''}`} style={{ left: pie?.x ?? 0, top: pie?.y ?? 0 }}>
        {pie && <><div className="pie-core">{pie.key.toUpperCase()}</div>{fastItems.map((label, index) => {const angle = index * 2 * Math.PI / fastItems.length - Math.PI / 2;const active = pie.key === 'z' ? mode === zMenu[index].action : index === 0 ? gridOn : index === 1 ? spinning : false;return <div key={label} className={`pie-item${active ? ' active' : ''}${pie.hover === index ? ' hover' : ''}`} style={{left:Math.cos(angle)*92,top:Math.sin(angle)*92}}>{label}</div>})}</>}
      </div>
      <div className={`about ${aboutOpen ? 'show' : ''}`} role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}>
        <div className="panel about-card" role="dialog" aria-modal="true" aria-label="About Orbitry">
          <div className="dialog-heading"><div><h2>Orbitry</h2><span>3D ASSET PREVIEWER</span></div><button className="dialog-close" aria-label="Close About" onClick={() => setAboutOpen(false)}>×</button></div>
          <section className="about-section"><h3>About</h3><p>Orbitry is still under development, so please expect bugs while the viewer and converters continue to improve. If you find a problem, send a report or suggestion through Help &amp; Feedback.</p><p>Preview and inspect .blend, .glb, .gltf, and .obj files in your browser. Your files stay on this device; Orbitry reads them in your browser and does not upload them to the website.</p><p>Direct .blend preview does not evaluate modifiers, geometry nodes, or Blender shader graphs.</p></section>
          <div className="about-links">
            <a href="https://dhitya-space.vercel.app" target="_blank" rel="noreferrer">Developer Website ↗</a>
            <a href="https://saweria.co/dhityavv" target="_blank" rel="noreferrer">Support Orbitry ↗</a>
          </div>
          <section className="help-card">
            <h3>Help &amp; Feedback</h3>
            <p>Found a bug, have a suggestion, or need help? Send a message to the developer through the project issue form.</p>
            <a className="primary" href="https://github.com/Dhityavv/Orbitry/issues/new" target="_blank" rel="noreferrer">Report a Bug or Suggest a Feature ↗</a>
          </section>
          <div className="about-footer">
            <span>Developed by Dhitya Nurhadi</span>
          </div>
        </div>
      </div>
      <div className={`about ${shortcutsOpen ? 'show' : ''}`} role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setShortcutsOpen(false); }}>
        <div className="panel about-card shortcuts-card" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
          <div className="dialog-heading"><div><h2>Keyboard Shortcuts</h2><span>VIEWPORT CONTROLS</span></div><button className="dialog-close" aria-label="Close shortcuts" onClick={() => setShortcutsOpen(false)}>×</button></div>
          <div className="shortcut-list">
            <div><kbd>Hold Z</kbd><span>Open the shading pie menu: Render top, Solid right, Material Preview bottom, Wireframe left.</span></div>
            <div><kbd>Hold X</kbd><span>Open the viewport tools pie menu, including Track to Object.</span></div>
            <div><kbd>1 / 2 / 3 / 4</kbd><span>Switch to Solid, Material Preview, Render, or Wireframe.</span></div>
            <div><kbd>Click a mesh</kbd><span>Select an object. Click empty viewport space to deselect it.</span></div>
            <div><kbd>H</kbd><span>Hide the selected object.</span></div>
            <div><kbd>Alt + H</kbd><span>Show every hidden object.</span></div>
            <div><kbd>Ctrl + Z</kbd><span>Undo the last object visibility change.</span></div>
            <div><kbd>Ctrl + Shift + Z</kbd><span>Redo an undone visibility change.</span></div>
            <div><kbd>G / R / F</kbd><span>Toggle the grid, toggle auto-rotate, or frame the full scene.</span></div>
            <div><kbd>Esc</kbd><span>Close the open menu or dialog.</span></div>
          </div>
        </div>
      </div>
    </main>
  );
}
