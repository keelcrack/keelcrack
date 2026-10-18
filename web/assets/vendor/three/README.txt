three.js r186 (0.186.1, MIT) from ../147 Velumtools node_modules/three, vendored by agent LANDING 14-10-2026 on the lead's
instruction (one source, so core and addons match):
  three.core.min.js / three.module.min.js  = build/three.core.js + build/three.module.js minified with esbuild 0.28.1
                                             (--minify --format=esm); the module's import rewritten to ./three.core.min.js
  addons/loaders/GLTFLoader.js, addons/utils/SkeletonUtils.js, addons/utils/BufferGeometryUtils.js, addons/controls/OrbitControls.js
                                             = examples/jsm/* from the same package, unmodified.
Models (web/assets/models/*.glb) are plain GLB with embedded textures: no Draco / meshopt decoders are vendored.
Importmap: {"three":"/assets/vendor/three/three.module.min.js","three/addons/":"/assets/vendor/three/addons/"}
