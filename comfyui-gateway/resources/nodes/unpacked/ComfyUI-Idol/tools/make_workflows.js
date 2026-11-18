// Build the example workflow in the ComfyUI frontend itself and save it to the user's workflow folder.
//
// The frontend's own graph API makes the nodes, so every widget and link is what the frontend would save.
// Run it in the browser console of a ComfyUI that has this pack loaded; the file lands in
// <user directory>/default/workflows/, from where it is copied into the pack's example_workflows/.

(async () => {
  const app = window.app;
  const LG = window.LiteGraph;

  const README =
    "## Idol · one image to a 3D Gaussian splat\n\n" +
    "[Idol](https://github.com/speridlabs/idol-sdk) by speridlabs turns one picture of an object into up to a million " +
    "3D Gaussians, including the sides the picture never showed. It is TripoSplat's architecture with its own " +
    "weights, so it runs on ComfyUI's native TripoSplat nodes; the [ComfyUI-Idol](https://github.com/PedroMarinhoDev/ComfyUI-Idol) " +
    "pack adds **Idol Preprocess Image** (Idol's crop, with its mode for photos), **Idol Input Camera** (the input's " +
    "viewpoint, which Idol predicts) and **Idol Precision**.\n\n" +
    "**Model files** (each loader links its file, so ComfyUI offers to download what's missing)\n\n" +
    "| File | Folder |\n|---|---|\n" +
    "| [idol_fp32.safetensors](https://huggingface.co/PedroMarinhoDev/Idol-ComfyUI/blob/main/diffusion_models/idol_fp32.safetensors) | `models/diffusion_models` |\n" +
    "| [idol_vae_decoder_fp32.safetensors](https://huggingface.co/PedroMarinhoDev/Idol-ComfyUI/blob/main/vae/idol_vae_decoder_fp32.safetensors) | `models/vae` |\n" +
    "| [dino_v3_vit_h.safetensors](https://huggingface.co/VAST-AI/TripoSplat/blob/main/clip_vision/dino_v3_vit_h.safetensors) | `models/clip_vision` |\n" +
    "| [flux2-vae.safetensors](https://huggingface.co/VAST-AI/TripoSplat/blob/main/vae/flux2-vae.safetensors) | `models/vae` |\n" +
    "| [birefnet.safetensors](https://huggingface.co/Comfy-Org/BiRefNet/blob/main/background_removal/birefnet.safetensors) | `models/background_removal` |\n\n" +
    "**Settings are Idol's:** euler, scheduler simple, 50 steps, **cfg 4** (Idol's guidance 3 in ComfyUI's " +
    "convention); the time shift 3 is built into the model. Use the same **mode** on both Idol nodes: synthetic " +
    "for renders and generated images, real for photos.\n\n" +
    "**Background:** an image with transparency can skip Remove Background: connect Load Image's MASK through " +
    "an Invert Mask node instead.\n\n" +
    "**Precision (Idol Precision):** default is fp16 on most GPUs, the precision the Idol SDK itself runs in: 24 s of " +
    "sampling on an RTX 4090. **fp32** reproduces the full-precision model (colours within 0.01/255 of it, against " +
    "0.4/255 on average and 4/255 at worst for fp16), 112 s. **fp32, fp16 attention** is the middle: 0.05/255, 42 s. " +
    "fp32 needs the fp32 file. Keep Idol Precision in the graph even at default: it patches ComfyUI's TripoSplat code, " +
    "which otherwise runs an fp32 file in fp32 whatever you choose. The decoder computes in its file's dtype.\n\n" +
    "**Outputs:** the .ply in output/3d, a render from the input's viewpoint, and a turntable video that starts there.";

  const IDOL = "https://huggingface.co/PedroMarinhoDev/Idol-ComfyUI/resolve/main/";
  const VAST = "https://huggingface.co/VAST-AI/TripoSplat/resolve/main/";
  const model = (name, url, directory) => [{ name, url, directory }];

  const workflow = {
    file: "idol_image_to_splat.json",
    nodes: {
      readme: { type: "MarkdownNote", title: "Read me", size: [620, 900], widgets: { text: README } },
      load: { type: "LoadImage", widgets: { image: "fennec-figure.png" }, size: [320, 380] },
      bg_model: { type: "LoadBackgroundRemovalModel", widgets: { bg_removal_name: "birefnet.safetensors" },
                  models: model("birefnet.safetensors", "https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors", "background_removal") },
      remove_bg: { type: "RemoveBackground" },
      preprocess: { type: "IdolPreprocessImage", widgets: { mode: "synthetic" } },
      preview_input: { type: "PreviewImage", title: "What the model sees", size: [320, 360] },
      clip_vision: { type: "CLIPVisionLoader", widgets: { clip_name: "dino_v3_vit_h.safetensors" },
                     models: model("dino_v3_vit_h.safetensors", VAST + "clip_vision/dino_v3_vit_h.safetensors", "clip_vision") },
      flux2_vae: { type: "VAELoader", title: "Load VAE (FLUX.2)", widgets: { vae_name: "flux2-vae.safetensors" },
                   models: model("flux2-vae.safetensors", VAST + "vae/flux2-vae.safetensors", "vae") },
      conditioning: { type: "TripoSplatConditioning" },
      unet: { type: "UNETLoader", title: "Load Idol", widgets: { unet_name: "idol_fp32.safetensors", weight_dtype: "default" },
              models: model("idol_fp32.safetensors", IDOL + "diffusion_models/idol_fp32.safetensors", "diffusion_models") },
      precision: { type: "IdolPrecision", widgets: { precision: "default" } },
      sampler: { type: "KSampler", widgets: { seed: 42, control_after_generate: "randomize", steps: 50, cfg: 4.0,
                                              sampler_name: "euler", scheduler: "simple", denoise: 1.0 } },
      decoder: { type: "VAELoader", title: "Load VAE (Idol decoder)", widgets: { vae_name: "idol_vae_decoder_fp32.safetensors" },
                 models: model("idol_vae_decoder_fp32.safetensors", IDOL + "vae/idol_vae_decoder_fp32.safetensors", "vae") },
      decode: { type: "VAEDecodeTripoSplat", widgets: { num_gaussians: 262144, seed: 42, control_after_generate: "fixed" } },
      to_file: { type: "SplatToFile3D", widgets: { format: "ply" } },
      save: { type: "SaveGaussianSplat", widgets: { filename_prefix: "3d/idol" }, size: [420, 520] },
      camera: { type: "IdolInputCamera", widgets: { mode: "synthetic" } },
      render: { type: "RenderSplat", title: "Render Splat (input view)",
                widgets: { width: 1024, height: 1024, frames: 1, background: "#000000" } },
      preview_render: { type: "PreviewImage", title: "Input view", size: [320, 360] },
      turntable: { type: "RenderSplat", title: "Render Splat (turntable)",
                   widgets: { width: 768, height: 768, frames: 72, background: "#ffffff" } },
      video: { type: "CreateVideo", widgets: { fps: 24 } },
      save_video: { type: "SaveVideo", widgets: { filename_prefix: "video/idol" }, size: [420, 520] },
    },
    links: [
      ["bg_model", 0, "remove_bg", "bg_removal_model"], ["load", "IMAGE", "remove_bg", "image"],
      ["load", "IMAGE", "preprocess", "image"], ["remove_bg", "MASK", "preprocess", "mask"],
      ["preprocess", "IMAGE", "preview_input", "images"],
      ["clip_vision", "CLIP_VISION", "conditioning", "clip_vision"], ["flux2_vae", "VAE", "conditioning", "vae"],
      ["preprocess", "IMAGE", "conditioning", "image"],
      ["unet", "MODEL", "precision", "model"], ["precision", "MODEL", "sampler", "model"], ["conditioning", 0, "sampler", "positive"],
      ["conditioning", 1, "sampler", "negative"], ["conditioning", 2, "sampler", "latent_image"],
      ["sampler", "LATENT", "decode", "samples"], ["decoder", "VAE", "decode", "vae"],
      ["decode", "SPLAT", "to_file", "splat"], ["to_file", 0, "save", "model_3d"],
      ["sampler", "LATENT", "camera", "samples"], ["decode", "SPLAT", "camera", "splat"],
      ["decode", "SPLAT", "render", "splat"], ["camera", 0, "render", "camera_info"],
      ["render", "IMAGE", "preview_render", "images"],
      ["decode", "SPLAT", "turntable", "splat"], ["camera", 0, "turntable", "camera_info"],
      ["turntable", "IMAGE", "video", "images"], ["video", "VIDEO", "save_video", "video"],
    ],
    columns: [["readme"], ["load", "bg_model", "remove_bg"], ["preprocess", "preview_input"],
              ["clip_vision", "flux2_vae", "conditioning", "unet", "precision"], ["sampler", "decoder", "decode"],
              ["to_file", "save"], ["camera", "render", "preview_render"], ["turntable", "video", "save_video"]],
  };

  app.graph.clear();
  const made = {};
  for (const [key, def] of Object.entries(workflow.nodes)) {
    const node = LG.createNode(def.type);
    if (!node) throw new Error(`unknown node type ${def.type}`);
    app.graph.add(node);
    if (def.title) node.title = def.title;
    if (def.models) node.properties.models = def.models;
    for (const [name, value] of Object.entries(def.widgets || {})) {
      const widget = node.widgets.find(w => w.name === name);
      if (!widget) throw new Error(`${key} has no widget ${name} (has ${node.widgets.map(w => w.name)})`);
      widget.value = value;
    }
    made[key] = node;
  }
  for (const [source, output, target, input] of workflow.links) {
    const from = made[source], to = made[target];
    const outputSlot = typeof output === "number" ? output : from.outputs.findIndex(o => o.name === output || o.type === output);
    const inputSlot = to.inputs.findIndex(i => i.name === input);
    if (outputSlot < 0 || inputSlot < 0) {
      throw new Error(`cannot link ${source}.${output} -> ${target}.${input} ` +
                      `(outputs ${from.outputs.map(o => o.name)}, inputs ${to.inputs.map(i => i.name)})`);
    }
    from.connect(outputSlot, to, inputSlot);
  }
  for (const [key, def] of Object.entries(workflow.nodes)) {
    const node = made[key];
    const minimum = node.computeSize();
    const [width, height] = def.size || [0, 0];
    node.size = [Math.max(minimum[0], width), Math.max(minimum[1], height)];
  }
  const TITLE = LG.NODE_TITLE_HEIGHT || 30, GAP_X = 60, GAP_Y = 36;
  let x = 0;
  for (const column of workflow.columns) {
    const width = Math.max(...column.map(key => made[key].size[0]));
    let y = 0;
    for (const key of column) {
      made[key].pos = [x, y + TITLE];
      y += made[key].size[1] + TITLE + GAP_Y;
    }
    x += width + GAP_X;
  }
  const placed = Object.values(made);
  const overlaps = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].getBounding(), b = placed[j].getBounding();
      if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) {
        overlaps.push(`${placed[i].title}/${placed[j].title}`);
      }
    }
  }
  app.graph.setDirtyCanvas(true, true);
  const saved = app.graph.serialize();
  saved.extra = { ...(saved.extra || {}), ds: { scale: 0.55, offset: [60, 60] } };
  const response = await fetch(`/api/userdata/${encodeURIComponent("workflows/" + workflow.file)}?overwrite=true`,
                               { method: "POST", body: JSON.stringify(saved, null, 1) });
  const prompt = await app.graphToPrompt();
  return `${workflow.file}: ${response.status}, ${saved.nodes.length} nodes, ${saved.links.length} links, ` +
         `${Object.keys(prompt.output).length} nodes in the API prompt, overlaps [${overlaps}]`;
})();
