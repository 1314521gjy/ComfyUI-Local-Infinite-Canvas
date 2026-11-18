# SPDX-License-Identifier: Apache-2.0
"""Viggle Remake on ComfyUI's built-in MiniMax H3 support.

Stock ComfyUI already runs the MiniMax-H3 transformer, both VAEs and the Qwen3-VL conditioner. These nodes add the
three things Viggle Remake does differently, each written to reproduce `inference/sample.py`:

RemakeConditioning   the source clip as <Video 1>, each image as <Picture N> and, with `pins`, also as a keyframe at
                     that real frame of the output; a text-only presentation; the source soundtrack held as the
                     clean target audio for the whole denoise
RemakeKeyframeUntil  drops the keyframes once sigma falls below `keyframe_until` (0.9 = the last two of six forwards)
RemakeNoise          draws the starting noise in the reference script's order, so a seed gives the same video
RemakePrefix         a hop: the previous take's frames open this render, held clean like the soundtrack

Load the LoRA with the stock LoraLoaderBypassModelOnly. LoraLoaderModelOnly merges it into the bf16 weights,
where rounding drops part of the update and the output comes out softer.
"""

import torch

import comfy.audio
import comfy.nested_tensor
import comfy.patcher_extension
import comfy.utils
import node_helpers

FPS, AUDIO_SR, AUDIO_LATENT_FPS = 24, 32000, 40


def lanczos(image, width, height):
    return comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)


def cover(image, width, height):
    # scale to cover the canvas, then centre-crop with (src - dst) // 2
    h, w = image.shape[1], image.shape[2]
    s = max(width / w, height / h)
    sw, sh = max(width, round(w * s)), max(height, round(h * s))
    left, top = (sw - width) // 2, (sh - height) // 2
    return lanczos(image, sw, sh)[:, top:top + height, left:left + width]


def stamps(nf):
    # the conditioner's 2 fps block labels for an nf-frame clip: every 12th frame, merged in pairs, each pair
    # labelled with its mean time ("%.1f" rounds half to even, so the first block is <0.2 seconds>)
    idx, cursor = [], 0.0
    while round(cursor) < nf:
        if not idx or round(cursor) > idx[-1]:
            idx.append(round(cursor))
        cursor += FPS / 2
    t = [i / 2 for i in range(len(idx))]
    t += t[-1:] * (len(t) % 2)
    return [(t[i] + t[i + 1]) / 2 for i in range(0, len(t), 2)]


class RemakeConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "source": ("IMAGE", {"tooltip": "The source clip's frames, at 24 fps. Supplies motion, camera, framing "
                                                "and everything the prompt does not change."}),
                "prompt": ("STRING", {"multiline": True, "tooltip": "The six-section prompt, used verbatim."}),
                "ref_1": ("IMAGE", {"tooltip": "<Picture 1>: usually a frame of the source painted in an image editor."}),
                "pins": ("STRING", {"default": "", "tooltip": "Optional: one output frame per reference image, e.g. "
                                                              "'12, 190'. Each reference is then pinned as a keyframe "
                                                              "at that frame for the first part of the denoise."}),
                "frames": ("INT", {"default": 124, "min": 90, "max": 345, "step": 17,
                                   "tooltip": "Output length at 24 fps, 17n+5."}),
                "short_edge": ("INT", {"default": 480, "min": 480, "max": 736, "step": 32,
                                       "tooltip": "480 (832x480 for 16:9) or 736 (1280x736)."}),
            },
            "optional": {
                "audio": ("AUDIO", {"tooltip": "The soundtrack kept in the output, usually the source's own. "
                                               "Silence when not connected."}),
                "ref_2": ("IMAGE",),
                "ref_3": ("IMAGE",),
                "ref_4": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "run"
    CATEGORY = "Viggle Remake"

    def run(self, clip, vae, audio_vae, source, prompt, ref_1, pins, frames, short_edge,
            audio=None, ref_2=None, ref_3=None, ref_4=None):
        nf, se = frames, short_edge
        refs = [r[:1, ..., :3] for r in (ref_1, ref_2, ref_3, ref_4) if r is not None]
        pins = [int(p) for p in pins.replace(",", " ").split()]
        assert (nf - 5) % 17 == 0, f"frames must be 17n+5, got {nf}"
        assert len(pins) in (0, len(refs)), f"give one pin per reference image or none: {len(pins)} pins, {len(refs)} refs"
        assert all(0 <= p < nf for p in pins), f"pins must be in [0, {nf})"

        # the source on its canvas: as is when its short edge is short_edge and both sides are multiples of 32,
        # otherwise cover-cropped onto the 16:9-class canvas (832x480, 1280x736)
        source = source[..., :3]
        h, w = source.shape[1], source.shape[2]
        if min(h, w) != se or h % 32 or w % 32:
            long = se * 16 // 9 // 32 * 32
            w, h = (long, se) if w >= h else (se, long)
            source = comfy.utils.common_upscale(source.movedim(-1, 1), w, h, "bicubic", "center").movedim(1, -1)
        source = source[:nf]
        assert source.shape[0] == nf, f"the source has {source.shape[0]} frames, {nf} needed"

        # text only: one label per 2 fps block of the source, one per reference, then the prompt, each tokenized on its own
        segments = ["<Video 1>: ", *["<%.1f seconds>" % s for s in stamps(nf)],
                    *["<Picture %d>: " % (i + 1) for i in range(len(refs))], prompt]
        tokens = {"qwen3vl_32b": [[t for s in segments for t in clip.tokenize(s)["qwen3vl_32b"][0]]]}
        positive = clip.encode_from_tokens_scheduled(tokens)

        # references: the source, then the images at their own short_edge (rounded to 32, no area cap)
        z = vae.encode(source)
        blocks = [{"kind": "video", "latent_t": z.shape[2], "latent_h": h // 16, "latent_w": w // 16,
                   "ref_audio_t": 0, "latent": z, "audio_latent": None}]
        for r in refs:
            rh, rw = r.shape[1], r.shape[2]
            th = max(32, round(rh * se / min(rh, rw) / 32) * 32)
            tw = max(32, round(rw * se / min(rh, rw) / 32) * 32)
            r = r if (rh, rw) == (th, tw) else lanczos(r, tw, th)
            blocks.append({"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": vae.encode(r)})

        # keyframes on the output canvas: the first stretched, the rest cover-cropped
        keyframes = []
        for i, (r, p) in enumerate(zip(refs, pins)):
            if (r.shape[1], r.shape[2]) != (h, w):
                r = lanczos(r, w, h) if i == 0 else cover(r, w, h)
            keyframes.append({"resolved_frame_index": p, "latent": vae.encode(r)})
        values = {"minimax_refs": blocks, "minimax_keyframes": keyframes} if keyframes else {"minimax_refs": blocks}
        positive = node_helpers.conditioning_set_values(positive, values)

        # the soundtrack as clean target audio: nf/24 s, padded to (nf+1)/24 s, encoded, cut to the target's length
        n = round((nf + 1) / FPS * AUDIO_SR)
        wav = torch.zeros(2, n)
        if audio is not None:
            wav, sr = audio["waveform"][0].float(), audio["sample_rate"]
            wav = wav.repeat(2, 1) if wav.shape[0] == 1 else wav[:2]
            wav = wav[:, :round(nf / FPS * sr)]
            wav = comfy.audio.resample(wav, sr, AUDIO_SR) if sr != AUDIO_SR else wav
        wav = torch.nn.functional.pad(wav, (0, max(0, n - wav.shape[1])))[:, :n]
        # zero-pad to whole 800-sample latent frames ourselves: VAE.encode would centre-crop instead, shifting the
        # track by up to 400 samples, which moves the latents as far as a different clip would
        wav = torch.nn.functional.pad(wav, (0, -n % 800))
        za = audio_vae.encode(wav[None].movedim(1, -1))[..., :round(nf / FPS * AUDIO_LATENT_FPS)]

        # the target: video to generate, audio held clean (noise_mask 0)
        video = torch.zeros(1, 24, (nf - 5) // 17 * 5 + 2, h // 16, w // 16)
        latent = {"samples": comfy.nested_tensor.NestedTensor((video, za)),
                  "noise_mask": comfy.nested_tensor.NestedTensor((torch.ones_like(video), torch.zeros_like(za)))}
        return (positive, latent)


class RemakeKeyframeUntil:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "keyframe_until": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01,
                                         "tooltip": "The keyframes condition every forward whose sigma is at least this; "
                                                    "below it they are dropped and the references alone remain."}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "run"
    CATEGORY = "Viggle Remake"

    def run(self, model, keyframe_until):
        def release(executor, x, timestep, context, transformer_options, minimax_payload=None, **kwargs):
            p = minimax_payload or {}
            if p.get("keyframes") and float(timestep.flatten()[0]) / 1000 < keyframe_until:
                refs = p.get("refs") or []
                minimax_payload = dict(p, keyframes=None, layout=None,
                                       cond_video_latents=[r["latent"] for r in refs if "latent" in r],
                                       cond_audio_latents=[r["audio_latent"] for r in refs if r.get("audio_latent") is not None])
            return executor(x, timestep, context, transformer_options, minimax_payload=minimax_payload, **kwargs)

        m = model.clone()
        m.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, "viggle_remake_keyframe_until", release)
        return (m,)


class Noise:
    def __init__(self, seed, skip):
        self.seed, self.skip = seed, skip

    def generate_noise(self, input_latent):
        g = torch.Generator().manual_seed(self.seed)
        for shape in self.skip:
            torch.randn(shape, generator=g)
        return comfy.nested_tensor.NestedTensor([torch.randn(t.shape, generator=g) for t in input_latent["samples"].unbind()])


class RemakeNoise:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "positive": ("CONDITIONING",),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
        }}

    RETURN_TYPES = ("NOISE",)
    FUNCTION = "run"
    CATEGORY = "Viggle Remake"

    def run(self, positive, seed):
        # one CPU generator, drawn once per reference and keyframe latent before the target's noise
        c = positive[0][1]
        skip = [b["latent"].shape for b in c.get("minimax_refs", []) + c.get("minimax_keyframes", []) if "latent" in b]
        return (Noise(seed, skip),)


class RemakePrefix:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "vae": ("VAE",),
            "latent": ("LATENT",),
            "prefix_frames": ("INT", {"default": 17, "min": 17, "max": 323, "step": 17,
                                      "tooltip": "How many of its frames open this render, a multiple of 17."}),
            "prefix_at": ("INT", {"default": -1, "min": -1, "max": 100000,
                                  "tooltip": "The previous take's frame they start at; -1: its last prefix_frames."}),
        }, "optional": {
            "prefix": ("IMAGE", {"tooltip": "The previous take's frames, on this render's canvas."}),
            "prefix_latent": ("LATENT", {"tooltip": "Optional: carry the previous sampler AV latent directly; skips the pixel VAE decode/re-encode."}),
        }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "run"
    CATEGORY = "Viggle Remake"

    def run(self, vae, latent, prefix_frames, prefix_at, prefix=None, prefix_latent=None):
        # frames [at, at + k) of the previous take are this render's first k frames: their latents go in clean with
        # noise_mask 0, so like the held soundtrack they enter at the condition timestep, are never stepped and come
        # out unchanged (the reference worker's prefix rows)
        k = prefix_frames
        video, audio = latent["samples"].unbind()
        vmask, amask = latent["noise_mask"].unbind()
        n = k // 17 * 5
        assert k % 17 == 0 and n < video.shape[2], f"prefix_frames must be 17m and shorter than the render, got {k}"
        video, vmask = video.clone(), vmask.clone()
        if prefix_latent is not None:
            pvideo, _ = prefix_latent["samples"].unbind()
            assert pvideo.shape[2] >= n, "prefix latent is shorter than the requested prefix"
            assert tuple(pvideo.shape[3:]) == tuple(video.shape[3:]), "prefix latent canvas must match the render"
            video[:, :, :n] = pvideo[:, :, -n:].to(video)
            vmask[:, :, :n] = 0
        else:
            assert prefix is not None, "RemakePrefix needs prefix pixels or prefix_latent"
            at = len(prefix) - k if prefix_at < 0 else prefix_at
            px = prefix[at:at + k, ..., :3]
            assert tuple(px.shape[:3]) == (k, video.shape[3] * 16, video.shape[4] * 16), \
                f"the prefix must be {k} frames on the {video.shape[4] * 16}x{video.shape[3] * 16} canvas, got {tuple(px.shape)}"
            # the VAE encodes 17-frame clips and drops the last 3 latents: pad to 17m + 5, keep the first 5m
            clean = vae.encode(torch.cat([px, px[-1:].repeat(5, 1, 1, 1)]))[:, :, :n]
            video[:, :, :n] = clean.to(video)
            vmask[:, :, :n] = 0
        return ({**latent, "samples": comfy.nested_tensor.NestedTensor((video, audio)),
                 "noise_mask": comfy.nested_tensor.NestedTensor((vmask, amask))},)


NODE_CLASS_MAPPINGS = {"RemakeConditioning": RemakeConditioning, "RemakeKeyframeUntil": RemakeKeyframeUntil,
                       "RemakeNoise": RemakeNoise, "RemakePrefix": RemakePrefix}
NODE_DISPLAY_NAME_MAPPINGS = {"RemakeConditioning": "Viggle Remake Conditioning",
                              "RemakeKeyframeUntil": "Viggle Remake Keyframe Until",
                              "RemakeNoise": "Viggle Remake Noise",
                              "RemakePrefix": "Viggle Remake Prefix"}
