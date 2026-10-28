#!/usr/bin/env node
/**
 * Mock ComfyUI server — protocol-compatible fake for gateway dev/tests.
 * Zero GPU, zero third-party deps (node:http only).
 *
 *   node comfyui-mock.mjs --port 18188 [--delay 300]
 *
 * Assets (generated once with ffmpeg, see README-ish header below):
 *   assets/mock.png  512x512 blue PNG
 *   assets/mock.mp4  1s 512x512 H.264 MP4
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, 'assets');

const DEFAULT_PORT = 18188;
const DEFAULT_DELAY_MS = 300;

const ASSET_FILES = {
  'mock.png': { file: 'mock.png', contentType: 'image/png' },
  'mock.mp4': { file: 'mock.mp4', contentType: 'video/mp4' },
};

const VIDEO_NODE_TYPES = new Set([
  'SaveVideo',
  'VHS_VideoCombine',
  'SaveWebM',
  'SaveAnimatedWEBP',
  'VHS_VideoInfo',
]);

/* -------------------------------------------------------------------------- */
/* /object_info payload — shaped like real ComfyUI node definitions            */
/* -------------------------------------------------------------------------- */

const CHECKPOINTS = [
  'v1-5-pruned-emaonly.safetensors',
  'sd_xl_base_1.0.safetensors',
  'mock.safetensors',
];

const SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpm_2',
  'dpm_2_ancestral',
  'lms',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'ddim',
  'uni_pc',
  'lcm',
];

const SCHEDULERS = [
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'simple',
  'ddim_uniform',
  'beta',
];

const VIDEO_FORMATS = [
  'video/h264-mp4',
  'video/h265-mp4',
  'video/webm',
  'image/gif',
  'image/webp',
];

function nodeDef({ name, displayName, category, description, input, output, outputName, outputNode = false, outputIsList }) {
  const required = Object.keys(input.required || {});
  const optional = Object.keys(input.optional || {});
  return {
    name,
    display_name: displayName || name,
    description: description || '',
    category: category || 'mock',
    input,
    input_order: { required, optional },
    output: output || [],
    output_is_list: outputIsList || (output || []).map(() => false),
    output_name: outputName || output || [],
    output_node: outputNode,
    output_tooltips: (output || []).map(() => null),
    python_module: 'nodes',
  };
}

function buildObjectInfo() {
  return {
    CheckpointLoaderSimple: nodeDef({
      name: 'CheckpointLoaderSimple',
      displayName: 'Load Checkpoint',
      category: 'loaders',
      description: 'Loads a diffusion model checkpoint.',
      input: {
        required: {
          ckpt_name: [CHECKPOINTS, { default: CHECKPOINTS[0], tooltip: 'The name of the checkpoint file.' }],
        },
      },
      output: ['MODEL', 'CLIP', 'VAE'],
      outputName: ['MODEL', 'CLIP', 'VAE'],
    }),

    CheckpointLoader: nodeDef({
      name: 'CheckpointLoader',
      displayName: 'Load Checkpoint With Config',
      category: 'advanced/loaders',
      input: {
        required: {
          config_name: [['v1-inference.yaml'], {}],
          ckpt_name: [CHECKPOINTS, { default: CHECKPOINTS[0] }],
        },
      },
      output: ['MODEL', 'CLIP', 'VAE'],
    }),

    CLIPTextEncode: nodeDef({
      name: 'CLIPTextEncode',
      displayName: 'CLIP Text Encode (Prompt)',
      category: 'conditioning',
      description: 'Encodes text into conditioning for sampling.',
      input: {
        required: {
          text: ['STRING', { multiline: true, default: '', dynamicPrompts: true }],
          clip: ['CLIP'],
        },
      },
      output: ['CONDITIONING'],
      outputName: ['CONDITIONING'],
    }),

    EmptyLatentImage: nodeDef({
      name: 'EmptyLatentImage',
      displayName: 'Empty Latent Image',
      category: 'latent',
      input: {
        required: {
          width: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
          height: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
          batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
        },
      },
      output: ['LATENT'],
    }),

    KSampler: nodeDef({
      name: 'KSampler',
      displayName: 'KSampler',
      category: 'sampling',
      description: 'Uses the provided model, conditioning and latent to denoise.',
      input: {
        required: {
          model: ['MODEL'],
          seed: ['INT', { default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, control_after_generate: true }],
          steps: ['INT', { default: 20, min: 1, max: 10000 }],
          cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1, round: 0.01 }],
          sampler_name: [SAMPLERS, { default: 'euler' }],
          scheduler: [SCHEDULERS, { default: 'normal' }],
          positive: ['CONDITIONING'],
          negative: ['CONDITIONING'],
          latent_image: ['LATENT'],
          denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
        },
      },
      output: ['LATENT'],
    }),

    VAEDecode: nodeDef({
      name: 'VAEDecode',
      displayName: 'VAE Decode',
      category: 'latent',
      input: {
        required: {
          samples: ['LATENT'],
          vae: ['VAE'],
        },
      },
      output: ['IMAGE'],
    }),

    SaveImage: nodeDef({
      name: 'SaveImage',
      displayName: 'Save Image',
      category: 'image',
      input: {
        required: {
          images: ['IMAGE'],
          filename_prefix: ['STRING', { default: 'ComfyUI' }],
        },
      },
      output: [],
      outputNode: true,
    }),

    PreviewImage: nodeDef({
      name: 'PreviewImage',
      displayName: 'Preview Image',
      category: 'image',
      input: {
        required: {
          images: ['IMAGE'],
        },
      },
      output: [],
      outputNode: true,
    }),

    LoadImage: nodeDef({
      name: 'LoadImage',
      displayName: 'Load Image',
      category: 'image',
      input: {
        required: {
          image: [['example.png', 'mock-input.png'], { image_upload: true, tooltip: 'Input image file.' }],
        },
      },
      output: ['IMAGE', 'MASK'],
      outputName: ['IMAGE', 'MASK'],
    }),

    SaveVideo: nodeDef({
      name: 'SaveVideo',
      displayName: 'Save Video',
      category: 'image/video',
      description: 'Saves an input video to the output directory.',
      input: {
        required: {
          video: ['VIDEO'],
          filename_prefix: ['STRING', { default: 'video/ComfyUI' }],
          format: [['auto', 'mp4', 'webm'], { default: 'auto' }],
          codec: [['auto', 'h264', 'h265', 'vp9', 'av1'], { default: 'auto' }],
        },
      },
      output: [],
      outputNode: true,
    }),

    VHS_VideoCombine: nodeDef({
      name: 'VHS_VideoCombine',
      displayName: 'Video Combine 🎥🅥🅗🅢',
      category: 'Video Helper Suite 🎥🅥🅗🅢/output',
      description: 'Combines a sequence of images into an animated video/gif.',
      input: {
        required: {
          images: ['IMAGE'],
          frame_rate: ['FLOAT', { default: 8, min: 1, max: 120, step: 1 }],
          loop_count: ['INT', { default: 0, min: 0, max: 100 }],
          filename_prefix: ['STRING', { default: 'AnimateDiff' }],
          format: [VIDEO_FORMATS, { default: 'video/h264-mp4' }],
          pingpong: ['BOOLEAN', { default: false }],
          save_output: ['BOOLEAN', { default: true }],
        },
        optional: {
          audio: ['AUDIO'],
          meta_batch: ['VHS_BatchManager'],
          vae: ['VAE'],
        },
      },
      output: ['VHS_FILENAMES'],
      outputNode: true,
    }),

    SaveWebM: nodeDef({
      name: 'SaveWebM',
      displayName: 'SaveWEBM',
      category: 'image/video',
      input: {
        required: {
          images: ['IMAGE'],
          filename_prefix: ['STRING', { default: 'ComfyUI' }],
          codec: [['vp9', 'vp8'], { default: 'vp9' }],
          fps: ['FLOAT', { default: 24.0, min: 0.01, max: 1000.0 }],
          crf: ['FLOAT', { default: 32.0, min: 0, max: 63 }],
        },
      },
      output: [],
      outputNode: true,
    }),
  };
}

const OBJECT_INFO = buildObjectInfo();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

/** The API prompt graph, tolerating {prompt:{...}} wrapping. */
function extractGraph(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.prompt && typeof body.prompt === 'object') return body.prompt;
  if (body.workflow && typeof body.workflow === 'object') return body.workflow;
  return body;
}

/** All class_type values found anywhere in the graph. */
function collectClassTypes(graph, out = new Set()) {
  if (!graph || typeof graph !== 'object') return out;
  if (Array.isArray(graph)) {
    for (const item of graph) collectClassTypes(item, out);
    return out;
  }
  if (typeof graph.class_type === 'string') out.add(graph.class_type);
  if (typeof graph.type === 'string') out.add(graph.type);
  for (const value of Object.values(graph)) {
    if (value && typeof value === 'object') collectClassTypes(value, out);
  }
  return out;
}

function isVideoGraph(graph) {
  for (const classType of collectClassTypes(graph)) {
    if (VIDEO_NODE_TYPES.has(classType)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ port?: number, delayMs?: number, assetsDir?: string, quiet?: boolean }} [options]
 * @returns {{ server: http.Server, port: number, start: (port?: number) => Promise<number>, stop: () => Promise<void> }}
 */
export function createMockComfyServer(options = {}) {
  const {
    port = DEFAULT_PORT,
    delayMs = DEFAULT_DELAY_MS,
    assetsDir = ASSETS_DIR,
    quiet = true,
  } = options;

  /** prompt_id -> { prompt, graph, isVideo, number, createdAt, completeAt, completed } */
  const runs = new Map();
  let promptCounter = 0;

  function isComplete(run) {
    return run.completed || Date.now() >= run.completeAt;
  }

  function historyEntry(id, run) {
    const video = run.isVideo;
    const outputNodeId = video ? '12' : '9';
    const outputs = video
      ? {
          [outputNodeId]: {
            images: [
              { filename: 'mock.mp4', subfolder: '', type: 'output', animated: true },
            ],
            gifs: [
              { filename: 'mock.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4' },
            ],
          },
        }
      : {
          [outputNodeId]: {
            images: [{ filename: 'mock.png', subfolder: '', type: 'output' }],
          },
        };

    return {
      prompt: [
        run.number,
        id,
        run.graph,
        { client_id: run.clientId ?? 'mock-client' },
        Object.keys(outputs),
      ],
      outputs,
      status: {
        status_str: 'success',
        completed: true,
        messages: [
          ['execution_start', { prompt_id: id }],
          ['execution_success', { prompt_id: id }],
        ],
      },
      meta: { mock: true, is_video: video },
    };
  }

  function handlePrompt(req, res) {
    return (async () => {
      const body = await readJsonBody(req);
      const graph = extractGraph(body);

      const promptId = crypto.randomUUID();
      promptCounter += 1;
      const now = Date.now();

      const run = {
        number: promptCounter,
        graph,
        clientId: body?.client_id,
        isVideo: isVideoGraph(graph),
        createdAt: now,
        completeAt: now + Math.max(0, Number(delayMs) || 0),
        completed: false,
      };

      const timer = setTimeout(() => {
        run.completed = true;
      }, Math.max(0, Number(delayMs) || 0));
      if (typeof timer.unref === 'function') timer.unref();

      runs.set(promptId, run);
      if (!quiet) {
        console.log(`[comfyui-mock] queued ${promptId} (video=${run.isVideo}, nodes=${Object.keys(graph).length})`);
      }

      json(res, 200, { prompt_id: promptId, number: promptCounter, node_errors: {} });
    })();
  }

  function handleHistory(res, promptId) {
    const run = runs.get(promptId);
    if (!run || !isComplete(run)) {
      json(res, 200, {});
      return;
    }
    json(res, 200, { [promptId]: historyEntry(promptId, run) });
  }

  function handleView(res, url) {
    const filename = path.basename(url.searchParams.get('filename') || '');
    const asset = ASSET_FILES[filename];
    if (!asset) {
      json(res, 404, { error: 'not found', filename });
      return;
    }
    const filePath = path.join(assetsDir, asset.file);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        json(res, 404, { error: 'asset missing', filename, detail: err.message });
        return;
      }
      res.writeHead(200, {
        'content-type': asset.contentType,
        'content-length': data.length,
        'accept-ranges': 'none',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  async function handleUploadImage(req, res) {
    // Drain (and ignore) the multipart/raw body so the client never stalls.
    await readBody(req).catch(() => Buffer.alloc(0));
    json(res, 200, { name: 'mock-input.png', subfolder: '', type: 'input' });
  }

  const routes = {
    async handle(req, res) {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const method = (req.method || 'GET').toUpperCase();

      // Liveness / stats
      if (method === 'GET' && pathname === '/system_stats') {
        json(res, 200, {
          system: {
            os: process.platform === 'win32' ? 'nt' : 'posix',
            ram_total: 34359738368,
            ram_free: 17179869184,
            comfyui_version: 'mock',
            python_version: '3.12.0 (mock)',
            pytorch_version: '2.5.0+cu124 (mock)',
            embedded_python: false,
            argv: ['comfyui-mock.mjs'],
          },
          devices: [
            { name: 'cpu (mock)', type: 'cpu', index: 0, vram_total: 0, vram_free: 0, torch_vram_total: 0, torch_vram_free: 0 },
          ],
        });
        return;
      }

      if (method === 'GET' && pathname === '/object_info') {
        json(res, 200, OBJECT_INFO);
        return;
      }

      if (method === 'GET' && pathname === '/internal/folder_paths') {
        json(res, 200, {});
        return;
      }

      if (method === 'POST' && pathname === '/prompt') {
        await handlePrompt(req, res);
        return;
      }

      const historyMatch = pathname.match(/^\/history(?:\/([^/]+))?$/);
      if (method === 'GET' && historyMatch) {
        const id = historyMatch[1];
        if (!id) {
          // Full history dump: only finished runs.
          const all = {};
          for (const [runId, run] of runs) {
            if (isComplete(run)) all[runId] = historyEntry(runId, run);
          }
          json(res, 200, all);
          return;
        }
        handleHistory(res, decodeURIComponent(id));
        return;
      }

      if (method === 'GET' && pathname === '/view') {
        handleView(res, url);
        return;
      }

      if (method === 'POST' && (pathname === '/upload/image' || pathname === '/upload/mask')) {
        await handleUploadImage(req, res);
        return;
      }

      if (method === 'POST' && pathname === '/interrupt') {
        await readBody(req).catch(() => Buffer.alloc(0));
        json(res, 200, {});
        return;
      }

      if (pathname === '/queue') {
        if (method === 'GET') {
          json(res, 200, { queue_running: [], queue_pending: [] });
          return;
        }
        if (method === 'POST') {
          await readBody(req).catch(() => Buffer.alloc(0));
          json(res, 200, {});
          return;
        }
      }

      const queueMatch = pathname.match(/^\/queue\/(\d+)$/);
      if (queueMatch && (method === 'GET' || method === 'POST')) {
        if (method === 'POST') await readBody(req).catch(() => Buffer.alloc(0));
        json(res, 200, {});
        return;
      }

      if (method === 'GET' && pathname === '/') {
        json(res, 200, { mock: true, comfyui_version: 'mock', prompt_delay_ms: delayMs });
        return;
      }

      json(res, 404, { error: 'not found', method, path: pathname });
    },
  };

  const server = http.createServer((req, res) => {
    routes.handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, err?.statusCode || 500, { error: err?.message || 'internal error' });
    });
  });

  let listenPort = port;

  function start(overridePort) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(overridePort ?? port, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        listenPort = typeof addr === 'object' && addr ? addr.port : (overridePort ?? port);
        if (!quiet) {
          console.log(`[comfyui-mock] listening on http://127.0.0.1:${listenPort} (delayMs=${delayMs})`);
        }
        resolve(listenPort);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const run of runs.values()) run.completed = true;
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    server,
    get port() {
      return listenPort;
    },
    get url() {
      return `http://127.0.0.1:${listenPort}`;
    },
    start,
    stop,
    delayMs,
    // test escape hatches
    runs,
    objectInfo: OBJECT_INFO,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI entry point                                                            */
/* -------------------------------------------------------------------------- */

function parseCliArgs(argv) {
  const out = { port: DEFAULT_PORT, delayMs: DEFAULT_DELAY_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [, flag, inlineValue] = arg.match(/^(--[^=]+)=?(.*)$/) || [];
    if (!flag) continue;
    const value = inlineValue || argv[i + 1];
    const consume = !inlineValue && argv[i + 1] && !argv[i + 1].startsWith('--') ? 1 : 0;

    if (flag === '--port' || flag === '-p') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        out.port = parsed;
        i += consume;
      }
    } else if (flag === '--delay' || flag === '--delay-ms') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        out.delayMs = parsed;
        i += consume;
      }
    } else if (flag === '--help' || flag === '-h') {
      out.help = true;
      i += 0;
    }
  }
  return out;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node comfyui-mock.mjs [--port 18188] [--delay 300]');
    process.exit(0);
  }
  const mock = createMockComfyServer({ port: args.port, delayMs: args.delayMs, quiet: false });
  mock.start().catch((err) => {
    console.error(`[comfyui-mock] failed to listen on ${args.port}: ${err.message}`);
    process.exitCode = 1;
  });
  const shutdown = () => {
    mock.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default createMockComfyServer;
