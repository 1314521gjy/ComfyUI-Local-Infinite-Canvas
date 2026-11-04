"""Strict, opt-in bridge for the H3 fused NVFP4 SwiGLU preprocessing path.

The bridge deliberately patches only ``mlp.forward`` through Comfy's object
patch API.  It does not monkey-patch classes or install a process-global hook.
Unsupported models, devices, kernels, and dynamic weight transforms are hard
errors: a request for fused FP4 must never silently turn into an eager path.
"""

from __future__ import annotations

import importlib
import logging
import types
from dataclasses import dataclass
from typing import Any, cast

import torch
from torch import nn

try:  # Supports both Comfy package imports and standalone contract tests.
    from .precision import (
        NVFP4Capability,
        NVFP4CapabilityError,
        NVFP4MLPAdapter,
        NVFP4ValidationError,
        apply_mlp_fp4,
        discover_mlp_projections,
    )
except ImportError:  # pragma: no cover - exercised by direct test imports
    from precision import (  # type: ignore[import-not-found, no-redef]
        NVFP4Capability,
        NVFP4CapabilityError,
        NVFP4MLPAdapter,
        NVFP4ValidationError,
        apply_mlp_fp4,
        discover_mlp_projections,
    )

LOG = logging.getLogger(__name__)
CONFIG_KEY = "fasth3_fused_nvfp4_mlp"


@dataclass(frozen=True)
class FusedMLPReport:
    enabled: bool
    applied: tuple[str, ...]
    skipped: tuple[str, ...]
    capability: NVFP4Capability

    def to_dict(self):
        return {
            "enabled": self.enabled,
            "applied": self.applied,
            "skipped": self.skipped,
            "capability": self.capability.__dict__,
        }


def _vendor_kernel():
    return importlib.import_module(".vendor.fused_mlp.kernel", __package__)


def _require_triton():
    from .compiler import ensure_triton_compiler
    ensure_triton_compiler()
    kernel = _vendor_kernel()
    if not kernel.TRITON_AVAILABLE:
        raise NVFP4CapabilityError(kernel.runtime_description())
    return kernel


def _validate_fc2(fc2, name: str):
    try:
        quant_ops = importlib.import_module("comfy.quant_ops")
        qt = quant_ops.QuantizedTensor
    except Exception as exc:
        raise NVFP4CapabilityError(f"{name}: Comfy QuantizedTensor API is unavailable: {exc}") from exc
    weight = getattr(fc2, "weight", None)
    # Before apply_mlp_fp4 the source is an ordinary loaded Linear.  Existing
    # native FP4 weights are accepted only when they advertise the exact layout;
    # ordinary sources are converted atomically by apply_mlp_fp4 below.
    if isinstance(weight, qt) and getattr(weight, "_layout_cls", None) != "TensorCoreNVFP4Layout":
        raise NVFP4ValidationError(f"{name}: FC2 layout must be TensorCoreNVFP4Layout")
    if isinstance(weight, qt) and getattr(getattr(weight, "_params", None), "transposed", False):
        raise NVFP4ValidationError(f"{name}: transposed NVFP4 FC2 weights are unsupported")
    for attr in ("pre_quant_scale", "input_scale"):
        if getattr(fc2, attr, None) is not None:
            raise NVFP4ValidationError(f"{name}: FC2 {attr} is unsupported")
    for attr in ("weight_function", "bias_function"):
        if getattr(fc2, attr, ()):
            raise NVFP4ValidationError(f"{name}: FC2 dynamic transforms/LoRA are unsupported ({attr})")


def _make_forward(mlp, block_name: str, kernel):
    try:
        from .fp4_kernel_config import fp4_kernel_options
        from .nvtx import nvtx_range
    except ImportError:  # pragma: no cover - standalone tests
        from fp4_kernel_config import fp4_kernel_options  # type: ignore[import-not-found, no-redef]
        from nvtx import nvtx_range  # type: ignore[import-not-found, no-redef]
    quant_ops = importlib.import_module("comfy.quant_ops")

    def forward(self, x):
        if not isinstance(self.fc1, NVFP4MLPAdapter) or not isinstance(self.fc2, NVFP4MLPAdapter):
            raise NVFP4ValidationError(f"{block_name}: FP4 child patches are not active")
        if not x.is_cuda or x.dtype not in (torch.float16, torch.bfloat16):
            raise NVFP4CapabilityError(
                f"{block_name}: fused NVFP4 requires CUDA BF16/FP16 activations, got {x.device}/{x.dtype}"
            )
        with nvtx_range("mlp_fc1"):
            fc1_output = self.fc1(x)
        if fc1_output.ndim != 2:
            fc1_output = fc1_output.reshape(-1, fc1_output.shape[-1])
        if fc1_output.shape[-1] % 2:
            raise NVFP4ValidationError(f"{block_name}: FC1 output width must be even")
        try:
            options = fp4_kernel_options()
            packed, tensor_scale, block_scales, orig_shape = kernel.fused_swiglu_quantize_nvfp4(
                fc1_output,
                precision="native_rounding",
                blocks_per_program=options["blocks_per_program"] or None,
            )
            params = quant_ops.TensorCoreNVFP4Layout.Params(
                scale=tensor_scale,
                orig_dtype=fc1_output.dtype,
                orig_shape=orig_shape,
                block_scale=block_scales,
            )
            qinput = quant_ops.QuantizedTensor(packed, "TensorCoreNVFP4Layout", params)
            with nvtx_range("mlp_fc2"):
                return self.fc2(qinput).reshape(*x.shape[:-1], self.fc2.out_features)
        except (NVFP4CapabilityError, NVFP4ValidationError):
            raise
        except Exception as exc:
            raise NVFP4CapabilityError(f"{block_name}: fused NVFP4 dispatch failed: {exc}") from exc

    return types.MethodType(forward, mlp)


def apply_fused_mlp(model_patcher):
    """Clone *model_patcher*, install native FP4 adapters, then patch MLP forwards.

    Returns ``(patched_model_patcher, report)``.  The input patcher is never
    mutated.  This is intentionally an explicit opt-in API and has no fallback.
    """
    model = getattr(model_patcher, "model", None)
    if not isinstance(model, nn.Module):
        raise NVFP4ValidationError("apply_fused_mlp requires a ModelPatcher with a torch module")
    if not torch.cuda.is_available():
        raise NVFP4CapabilityError("fused NVFP4 requires CUDA")
    kernel = _require_triton()
    names = discover_mlp_projections(model)
    # Precision adapter installation performs the native capability probe and
    # atomically prepares all 100 FC1/FC2 leaves before object patches land.
    patched, precision_report = apply_mlp_fp4(model_patcher, names, enabled=True)
    diffusion = cast(Any, model.get_submodule("diffusion_model"))
    applied = []
    for block in range(50):
        mlp_name = f"diffusion_model.blocks.{block}.mlp"
        mlp = diffusion.blocks[block].mlp
        _validate_fc2(patched.get_model_object(f"{mlp_name}.fc2"), f"{mlp_name}.fc2")
        patched.add_object_patch(f"{mlp_name}.forward", _make_forward(mlp, mlp_name, kernel))
        applied.append(mlp_name)
    report = FusedMLPReport(True, tuple(applied), precision_report.skipped, precision_report.capability)
    return patched, report


__all__ = ["CONFIG_KEY", "FusedMLPReport", "apply_fused_mlp"]
