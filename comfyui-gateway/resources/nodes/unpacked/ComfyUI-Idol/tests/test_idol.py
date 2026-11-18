import math
import os
import sys

import numpy as np
import pytest
import torch
from PIL import Image
from safetensors import safe_open

from comfyui_idol.nodes import CROP_MARGIN, IdolPreprocessImage, input_camera

PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(os.environ.get("COMFYUI_PATH", os.path.expanduser("~/AI/ComfyUI")), "models")


def object_image():
    """A 600 x 400 picture of an off-centre ellipse with a soft edge, and its alpha."""
    y, x = np.mgrid[0:400, 0:600].astype(np.float32)
    alpha = np.clip(1.5 - np.hypot((x - 380) / 150, (y - 170) / 90) * 1.5, 0, 1)
    rgb = np.stack([x / 600, y / 400, np.full_like(x, 0.5)], -1)
    return rgb, alpha


@pytest.mark.parametrize("mode", list(CROP_MARGIN))
def test_preprocess_matches_reference(mode):
    sys.path[:0] = [os.path.join(PACK, "dev", "reference_idol"), os.path.join(PACK, "dev", "pydeps")]
    preprocess_image = pytest.importorskip("idol.preprocess").preprocess_image
    rgb, alpha = object_image()
    rgba = Image.fromarray((np.concatenate([rgb, alpha[..., None]], -1) * 255).round().astype(np.uint8), "RGBA")
    theirs = torch.from_numpy(np.array(preprocess_image(rgba, None, crop_margin=CROP_MARGIN[mode])) / 255.0).float()
    image = torch.from_numpy(np.array(rgba)[..., :3] / 255.0).float()[None]
    mask = torch.from_numpy(np.array(rgba)[..., 3] / 255.0).float()[None]
    ours = IdolPreprocessImage.execute(image, mask, mode).args[0][0]
    assert ours.shape == theirs.shape == (1024, 1024, 3)
    assert 10 * math.log10(1 / ((ours - theirs) ** 2).mean().item()) > 40


@pytest.mark.parametrize("token", [[0.3, -0.8, 0.5, 0.08, 0.9], [-0.6, 0.2, 0.1, 0.0, 0.7]], ids=["perspective", "orthographic"])
def test_input_camera_frames_the_object_like_the_crop(token):
    points = (torch.rand(20000, 3, generator=torch.Generator().manual_seed(0)) - 0.5) * torch.tensor([0.9, 0.5, 0.7]) + 0.05
    eye, target, fov, camera_type = input_camera(torch.tensor(token), points, CROP_MARGIN["synthetic"])
    assert camera_type == ("orthographic" if token[3] == 0 else "perspective")
    world = points * torch.tensor([1.0, -1.0, -1.0])
    forward = torch.nn.functional.normalize(target - eye, dim=0)
    right = torch.nn.functional.normalize(torch.linalg.cross(forward, torch.tensor([0.0, 1.0, 0.0])), dim=0)
    up = torch.linalg.cross(right, forward)
    relative = world - eye
    depth = (target - eye).norm() if camera_type == "orthographic" else relative @ forward
    uv = torch.stack([relative @ right, relative @ up]) / (depth * math.tan(math.radians(fov) / 2))
    low, high = torch.quantile(uv, torch.tensor([0.001, 0.999]), dim=1)
    assert abs(float((high - low).max()) - 2 / CROP_MARGIN["synthetic"]) < 0.01
    assert float((low + high).abs().max()) / 2 < 0.01
    direction = torch.nn.functional.normalize(torch.tensor(token[:3]), dim=0)
    assert torch.allclose(-forward, torch.stack([direction[0], direction[2], -direction[1]]), atol=1e-5)


def test_converted_files_match_native_classes():
    import comfy.ops
    from comfy.ldm.triposplat.model import LatentSeqMMFlowModel
    from comfy.ldm.triposplat.vae import OctreeGaussianDecoder

    files = {"diffusion_models/idol/idol_fp16.safetensors": LatentSeqMMFlowModel, "vae/idol_vae_decoder_fp16.safetensors": OctreeGaussianDecoder}
    for name, cls in files.items():
        path = os.path.join(MODELS, name)
        if not os.path.exists(path):
            pytest.skip(f"{name} not converted")
        with torch.device("meta"):
            expected = {k: tuple(v.shape) for k, v in cls(operations=comfy.ops.disable_weight_init).state_dict().items()}
        with safe_open(path, "pt") as f:
            found = {k: tuple(f.get_slice(k).get_shape()) for k in f.keys()}
            assert {f.get_slice(k).get_dtype() for k in f.keys()} == {"F16"}
        assert found == expected


def test_precision_presets():
    import comfy.model_patcher
    import comfy.ops
    from comfy.ldm.triposplat.model import TimestepEmbedder
    from comfyui_idol.nodes import IdolPrecision, half_precision_attention

    class Model(torch.nn.Module):  # the attributes Idol Precision touches on a TripoSplat BaseModel
        manual_cast_dtype = None

        def __init__(self):
            super().__init__()
            self.diffusion_model = torch.nn.Module()
            self.diffusion_model.t_embedder = TimestepEmbedder(8, frequency_embedding_size=16, operations=comfy.ops.manual_cast)
            for p in self.parameters():
                torch.nn.init.normal_(p)  # stored in fp32, like idol_fp32.safetensors under dynamic VRAM

        def get_dtype_inference(self):
            return self.manual_cast_dtype or torch.float16

    cpu = torch.device("cpu")
    model = comfy.model_patcher.ModelPatcher(Model(), load_device=cpu, offload_device=cpu)
    t = torch.tensor([700.0])
    assert model.model.diffusion_model.t_embedder(t).dtype == torch.float32  # the stock embedder follows its weights
    for preset, dtype, attention in (("default", torch.float16, False), ("fp32, fp16 attention", torch.float32, True), ("fp32", torch.float32, False)):
        patched = IdolPrecision.execute(model, preset).args[0]
        assert ("optimized_attention_override" in patched.model_options["transformer_options"]) == attention
        patched.patch_model()
        assert patched.model.diffusion_model.t_embedder(t).dtype == dtype
        patched.unpatch_model()

    q, k, v = torch.randn(3, 1, 64, 32, generator=torch.Generator().manual_seed(0)).unbind()
    out = half_precision_attention(q, k, v, 2)
    expected = torch.nn.functional.scaled_dot_product_attention(*(t.view(1, 64, 2, 16).transpose(1, 2) for t in (q, k, v)))
    assert out.dtype == torch.float32
    assert torch.allclose(out, expected.transpose(1, 2).reshape(1, 64, 32), atol=2e-3)
