"""Idol (speridlabs/idol) runs on ComfyUI's native TripoSplat nodes: same denoiser, decoders and image encoders.
This pack adds what those nodes leave out: Idol's crop for real photos, its predicted input camera, and a choice of
denoiser precision up to full fp32."""
import functools
import math

import torch
import torch.nn.functional as F
from typing_extensions import override

import comfy.ldm.modules.attention
import comfy.utils
from comfy_api.latest import ComfyExtension, IO
from comfy_extras.nodes_gaussian_splat import _lookat_camera_info

# square crop side = object bounding box x margin (idol/preprocess.py CROP_MARGIN)
CROP_MARGIN = {"synthetic": 1.2, "real": 1.7}


def preprocess(image, mask, crop_margin, size=1024):
    """idol/preprocess.py on tensors: short side to `size`, erode the alpha by 1 px, square crop of side
    crop_margin x the object's bounding box (outside the image stays empty), resize to `size`, composite on black."""
    rgba = torch.cat([image[..., :3].movedim(-1, 0), mask[None]], 0)[None].clamp(0, 1)
    h, w = rgba.shape[-2:]
    scale = size / min(w, h)
    rgba = comfy.utils.common_upscale(rgba, max(1, round(w * scale)), max(1, round(h * scale)), "lanczos", "disabled").clamp(0, 1)
    alpha = -F.max_pool2d(-rgba[:, 3:], 3, stride=1, padding=1)
    rgba = torch.cat([rgba[:, :3], alpha], 1)

    ys, xs = torch.nonzero(alpha[0, 0] > 0, as_tuple=True)
    if xs.numel() == 0:
        raise ValueError("Idol Preprocess Image: the mask is empty (no object found).")
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    half = max(x1 - x0, y1 - y0) / 2 * crop_margin
    left, top = int((x0 + x1) / 2 - half), int((y0 + y1) / 2 - half)
    right, bottom = int((x0 + x1) / 2 + half), int((y0 + y1) / 2 + half)
    H, W = rgba.shape[-2:]
    crop = rgba.new_zeros((1, 4, bottom - top, right - left))
    sx0, sy0, sx1, sy1 = max(left, 0), max(top, 0), min(right, W), min(bottom, H)
    crop[:, :, sy0 - top:sy1 - top, sx0 - left:sx1 - left] = rgba[:, :, sy0:sy1, sx0:sx1]
    crop = comfy.utils.common_upscale(crop, size, size, "lanczos", "disabled").clamp(0, 1)
    return (crop[:, :3] * crop[:, 3:])[0].movedim(0, -1)


class IdolPreprocessImage(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="IdolPreprocessImage",
            display_name="Idol Preprocess Image",
            category="model/conditioning/triposplat",
            description="Frame the object as Idol expects: a 1024 x 1024 square around the mask's bounding box, "
                        "background black. Feeds TripoSplat Conditioning.",
            inputs=[
                IO.Image.Input("image"),
                IO.Mask.Input("mask", tooltip="Foreground mask (1 = object), e.g. from Remove Background."),
                IO.Combo.Input("mode", options=list(CROP_MARGIN),
                               tooltip="synthetic: renders and generated images (crop 1.2 x the object); "
                                       "real: photographs (crop 1.7 x the object)."),
            ],
            outputs=[IO.Image.Output(display_name="image")],
        )

    @classmethod
    def execute(cls, image, mask, mode) -> IO.NodeOutput:
        mask = comfy.utils.repeat_to_batch_size(mask, image.shape[0])
        if mask.shape[1:] != image.shape[1:3]:
            mask = F.interpolate(mask[:, None], size=image.shape[1:3], mode="bilinear")[:, 0]
        return IO.NodeOutput(torch.stack([preprocess(image[i], mask[i], CROP_MARGIN[mode]) for i in range(image.shape[0])]))


def input_camera(camera, positions, crop_margin):
    """Render Splat's camera for the input view: world-space eye, target, vertical fov (degrees) and camera type.

    The direction and the projection come from Idol's camera token (idol/camera.py: a unit direction in the
    object's z-up frame, the inverse distance, below 1e-3 meaning orthographic, and the half width of the view).
    Its scale does not match the decoded object's (on three test objects the distance needed factors from 0.55
    to more than 0.6), so the framing is fitted the way the input was cropped: seen from that direction, the object's
    bounding box spans 1 / crop_margin of the frame and sits in its centre. A perspective view keeps the token's
    fov and moves the eye; an orthographic one keeps the eye 3 units from the target and fits the view's size."""
    direction = F.normalize(camera[:3], dim=0) if camera[:3].norm() > 1e-6 else camera.new_tensor([0.0, 0.0, 1.0])
    ortho = float(camera[3]) < 1e-3
    tan, distance = (1 / 3, 3.0) if ortho else (float(camera[4] * camera[3]), 1 / float(camera[3]))
    # object (x, y, z) -> Render Splat world (Y-up): (x, z, -y); positions arrive in its splat frame (x, -y, -z)
    away = torch.stack([direction[0], direction[2], -direction[1]])
    points = positions * positions.new_tensor([1.0, -1.0, -1.0])
    right = F.normalize(torch.linalg.cross(-away, away.new_tensor([0.0, 1.0, 0.0])), dim=0)
    up = torch.linalg.cross(right, -away)
    target = points.new_zeros(3)
    for _ in range(4):
        relative = points - (target + away * distance)
        depth = distance if ortho else -(relative @ away)
        uv = torch.stack([relative @ right, relative @ up]) / (depth * tan)
        low, high = torch.quantile(uv, uv.new_tensor([0.001, 0.999]), dim=1)
        target = target + ((low + high) / 2 * distance * tan) @ torch.stack([right, up])
        fit = float((high - low).max()) * crop_margin / 2
        if ortho:
            tan *= fit
        else:
            distance *= fit
    return target + away * distance, target, math.degrees(2 * math.atan(tan)), "orthographic" if ortho else "perspective"


class IdolInputCamera(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="IdolInputCamera",
            display_name="Idol Input Camera",
            category="model/latent/triposplat",
            description="The viewpoint of the input image, which Idol predicts with the object, framed like the "
                        "preprocessed input. Connect it to Render Splat to see the object as the input showed it "
                        "(with frames > 1, a turntable that starts there).",
            inputs=[
                IO.Latent.Input("samples", tooltip="The sampled latent (KSampler output); the first item is used."),
                IO.Splat.Input("splat", tooltip="The decoded object (TripoSplat Decode), for the framing."),
                IO.Combo.Input("mode", options=list(CROP_MARGIN), tooltip="The mode the input was preprocessed with."),
            ],
            outputs=[IO.Load3DCamera.Output(display_name="camera_info")],
        )

    @classmethod
    def execute(cls, samples, splat, mode) -> IO.NodeOutput:
        positions = splat.positions[0][(splat.opacities[0, :, 0] > 0.1)].float()
        camera = samples["samples"].unbind()[1][0, 0].float().to(positions.device)
        eye, target, fov, camera_type = input_camera(camera, positions, CROP_MARGIN[mode])
        return IO.NodeOutput(_lookat_camera_info(eye, target, fov, positions.device, camera_type=camera_type))


def timestep_forward(embedder, model, t):
    # The stock TripoSplat TimestepEmbedder casts to its stored weight's dtype. With dynamic VRAM an fp32 file keeps
    # fp32 weights, so that cast turned the whole denoiser to fp32 (4.6x slower). Cast to the dtype the model runs in.
    emb = embedder.timestep_embedding(t, embedder.frequency_embedding_size)
    return embedder.mlp(emb.to(model.get_dtype_inference()))


def half_precision_attention(q, k, v, heads, *args, **kwargs):
    return comfy.ldm.modules.attention.optimized_attention(q.half(), k.half(), v.half(), heads, *args, **kwargs).to(q.dtype)


# preset -> (compute dtype, attention in fp16); timings: 50 steps of Idol on an RTX 4090
PRECISIONS = {"default": (None, False), "fp32, fp16 attention": (torch.float32, True), "fp32": (torch.float32, False)}


class IdolPrecision(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="IdolPrecision",
            display_name="Idol Precision",
            category="model/patch",
            description="How precisely the denoiser computes. Keep it in the graph at default too: it also makes "
                        "idol_fp32.safetensors compute in the dtype chosen here instead of always in fp32. "
                        "fp32 needs idol_fp32.safetensors to gain anything.",
            inputs=[
                IO.Model.Input("model"),
                IO.Combo.Input("precision", options=list(PRECISIONS),
                               tooltip="default: ComfyUI's choice (fp16 on most GPUs, the precision the Idol SDK runs "
                                       "in), 24 s on an RTX 4090. fp32, fp16 attention: everything in fp32 except "
                                       "attention, 42 s, about 7x closer to the fp32 result than fp16. fp32: the "
                                       "full-precision result, 112 s."),
            ],
            outputs=[IO.Model.Output()],
        )

    @classmethod
    def execute(cls, model, precision) -> IO.NodeOutput:
        dtype, half_attention = PRECISIONS[precision]
        m = model.clone()
        m.add_object_patch("diffusion_model.t_embedder.forward",
                           functools.partial(timestep_forward, m.get_model_object("diffusion_model.t_embedder"), m.model))
        if dtype is not None:
            m.set_model_compute_dtype(dtype)
        if half_attention:
            m.set_model_optimized_attention(half_precision_attention)
        return IO.NodeOutput(m)


class IdolExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [IdolPreprocessImage, IdolInputCamera, IdolPrecision]


async def comfy_entrypoint() -> IdolExtension:
    return IdolExtension()
