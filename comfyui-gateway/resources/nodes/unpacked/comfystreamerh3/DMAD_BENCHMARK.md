# DMAD benchmark: summary

This is an opt-in experiment for comparing DMAD H3 checkpoints with the FastH3 B1 baseline. It does not change the default profile. This repository contains the DMAD custom nodes, but not the conversion scripts, benchmark fixtures, or result reports needed to reproduce the experiment. The commands below require those tools and data to be available in the environment where they are run.

## Before running

- Use Linux with the compatible ComfyUI Torch, Safetensors, CUDA, and pinned Comfy Kitchen environment.
- Obtain the MiniMax-H3 base checkpoint and DMAD adapter at the revisions specified by the conversion scripts; accept their licenses. The conversion scripts do not download large weights or install packages.
- Convert the adapter to a statically merged H3 checkpoint. The loader requires the matching base revision/variant, complete modules, expected activation layout, checkpoint hash receipt, and compatible ComfyUI Core commit. Dynamic LoRAs and FastH3 attention gates are not accepted.
- Keep the generated checkpoint beside its `.safetensors.dmad.json` receipt. Conversion creates a large single Safetensors file; allow enough disk and host memory.

## Compare checkpoints

From an environment containing the DMAD benchmark scripts, a small integration smoke test is:

```bash
python3 scripts/benchmark_dmad_h3.py \
  --base-url http://127.0.0.1:8188 \
  --output-dir /workspace/benchmark-results/dmad-h3 \
  --checkpoint-lora-critic dmad_h3_lora_critic.safetensors \
  --limit 2
```

This runs B1 and dense BF16 DMAD on matched requests. Two clips are only a functional check; they do not support a quality or speed claim. Use the benchmark and held-out evaluation fixtures available in that environment for larger comparisons. Check that the named scripts and fixtures are present before running them: this node repository does not contain them.

The benchmark can select BF16, FP8 E4M3FN storage, fused NVFP4 MLP, INT8 ConvRot, and VSA attention routes. These labels describe different parts of the model:

- FP8 stores 260 matrix weights in FP8; computation remains BF16.
- NVFP4 covers 100 trunk MLP projections, not the whole model.
- INT8 ConvRot covers 208 shared QKV/output/MLP matrices; DMAD AdaLN remains BF16.
- Combined INT8 + NVFP4 and attention variants are experimental. Treat them as separate profiles and require the same quality review as other model changes.

Use a matching checkpoint for each precision mode. Compare one change at a time before testing a combined profile. Record the resolved hardware, runtime, checkpoint/component hashes, decoder/streaming settings, and requested features in each run manifest. A requested cache or optimization counts only if its receipt confirms it engaged.

## Workload and interpretation

Use matched hardware, prompt, seed, resolution, frame count, audio, warmups, and repeats. The documented performance workload is 512×320 at 362 frames and 24 fps (about 15 seconds). DMAD was trained at 124 frames, so retain the separate 124-frame held-out set for trained-length quality review; 362-frame quality is extrapolation. Do not project short-clip timing linearly to 15 seconds.

Run unprofiled timing separately from diagnostic captures. Review paired MP4s and listen to audio before making quality claims. Completed jobs should include the media, hash-bound receipt, and per-run report; failed or skipped jobs remain visible in the result matrix. A functional load or media-integrity check is not evidence of noninferior quality.

For memory comparisons, keep precision and attention selection explicit. For composed profiles, compare against a fresh plain run at the same precision, device, model variant, and media contract. Run each checkpoint/precision group in a fresh ComfyUI process to avoid node caches retaining the prior large model and distorting host-memory results. Never pool asynchronous and synchronous offload policies in one timing group.

## Status

Earlier benchmark notes reported load and timing checks for INT8 ConvRot + NVFP4 MLP on an RTX 5090. Human quality review and comparison of DMAD's gate-quality behavior with B1 remain open. The report and receipts are not included here; inspect them before relying on those results. No speed or quality qualification is claimed here.
