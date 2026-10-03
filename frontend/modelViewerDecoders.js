import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * The Draco and KTX2 decoders <model-viewer> fetches when it opens a compressed model, served by
 * the dashboard itself. Its default fetches them from www.gstatic.com. three.js's loaders request
 * each file by a fixed name under one directory, so they keep their names here; Model3DViewer.jsx
 * points the viewer at these directories. Read from the `three` that @google/model-viewer
 * resolves, so the decoders match the loaders that run them.
 *
 * The asm.js Draco decoder (draco_decoder.js) is left out: three.js uses it only in a browser
 * without WebAssembly.
 */
export const DECODER_FILES = {
  'decoders/draco/draco_wasm_wrapper.js': 'three/examples/jsm/libs/draco/draco_wasm_wrapper.js',
  'decoders/draco/draco_decoder.wasm': 'three/examples/jsm/libs/draco/draco_decoder.wasm',
  'decoders/basis/basis_transcoder.js': 'three/examples/jsm/libs/basis/basis_transcoder.js',
  'decoders/basis/basis_transcoder.wasm': 'three/examples/jsm/libs/basis/basis_transcoder.wasm',
}

const require = createRequire(import.meta.url)
const fromModelViewer = createRequire(require.resolve('@google/model-viewer/package.json'))

/** The file on disk a served path is copied from. */
export function decoderSource(fileName) {
  return fromModelViewer.resolve(DECODER_FILES[fileName])
}

/** Vite plugin: emits the decoders into the build, and serves them under `npm run dev`. */
export function modelViewerDecoders() {
  let base = '/'
  return {
    name: 'model-viewer-decoders',
    configResolved(config) {
      base = config.base
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0]
        const fileName = path.startsWith(base) ? path.slice(base.length) : null
        if (!fileName || !(fileName in DECODER_FILES)) return next()
        res.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.end(readFileSync(decoderSource(fileName)))
      })
    },
    generateBundle() {
      for (const fileName of Object.keys(DECODER_FILES)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(decoderSource(fileName)) })
      }
    },
  }
}
