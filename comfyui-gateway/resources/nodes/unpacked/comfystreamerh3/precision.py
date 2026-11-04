"""Conservative, opt-in NVFP4 adapters for FastH3 MLP projections.

This module deliberately does not contain a weight converter or a Nunchaku
packing path.  It consumes the already-loaded, higher precision ``Linear``
weights and uses Comfy's registered ``TensorCoreNVFP4Layout`` only when the
runtime reports native NVFP4 compute support.
"""

from __future__ import annotations

import importlib
import re
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Any, TypeGuard, cast

import torch
from torch import nn

NVFP4_LAYOUT = "TensorCoreNVFP4Layout"
_H3_MLP_PROJECTION = re.compile(
    r"^diffusion_model\.blocks\.(?P<block>[0-9]+)\.mlp\.(?P<projection>fc1|fc2)$"
)
_H3_OUT_PROJ = re.compile(
    r"^diffusion_model\.blocks\.(?P<block>[0-9]+)\.attn\.out_proj$"
)
_UNSUPPORTED_TRANSFORMS = (
    "smooth", "smoothing", "smooth_scale", "smooth_shift", "rotation",
    "input_scale", "pre_quant_scale", "weight_scale", "weight_function",
    "bias_function",
)


class PrecisionError(RuntimeError):
    """Base error for an invalid or unavailable precision installation."""


class NVFP4CapabilityError(PrecisionError):
    """Raised when native NVFP4 cannot be proven for this process/device."""


class NVFP4ValidationError(PrecisionError, ValueError):
    """Raised when a requested module is outside the supported MLP contract."""


@dataclass(frozen=True)
class NVFP4Capability:
    available: bool
    reason: str
    layout: str = NVFP4_LAYOUT
    native_compute: bool = False
    gpu_tested: bool = False
    backend: str | None = None


@dataclass(frozen=True)
class NVFP4InstallReport:
    enabled: bool
    applied: tuple[str, ...]
    skipped: tuple[str, ...]
    capability: NVFP4Capability

    def to_dict(self):
        return asdict(self)


def _materialized_tensor(value: object) -> TypeGuard[torch.Tensor]:
    return isinstance(value, torch.Tensor) and not value.is_meta


def _has_unsupported_transform(module: nn.Module, attr: str) -> bool:
    value = getattr(module, attr, None)
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, set)):
        return bool(value)
    return True


def discover_mlp_projections(model: nn.Module) -> tuple[str, ...]:
    """Discover exactly the 100 trained H3 trunk MLP projections.

    This intentionally uses names and a small module protocol rather than an
    inheritance check: Comfy's ``mixed_precision_ops().Linear`` is a plain
    ``nn.Module``.  Token-refiner MLPs and every other projection are excluded.
    """
    found = {
        name: module for name, module in model.named_modules()
        if name and is_mlp_projection_name(name)
    }
    expected = tuple(
        f"diffusion_model.blocks.{block}.mlp.{projection}"
        for block in range(50)
        for projection in ("fc1", "fc2")
    )
    missing = tuple(name for name in expected if name not in found)
    if missing:
        details = ", ".join(
            f"{name}={type(module).__name__}" for name, module in sorted(found.items())
        ) or "none"
        raise NVFP4ValidationError(
            "expected exactly diffusion_model.blocks.0..49.mlp.fc1/fc2 "
            f"(100 projections); missing {len(missing)}: {', '.join(missing[:8])}"
            f"{' ...' if len(missing) > 8 else ''}; discovered: {details}"
        )
    return expected


def _model_mlp_names(model: nn.Module) -> tuple[str, ...]:
    return discover_mlp_projections(model)


def probe_nvfp4_capability(device=None) -> NVFP4Capability:
    """Probe the installed Comfy/kitchen native path without running a GPU job.

    ``gpu_tested`` is intentionally always false: this is a capability probe,
    not benchmark evidence.  Callers must not turn this result into a speedup
    claim.
    """
    if not torch.cuda.is_available():
        return NVFP4Capability(False, "CUDA is unavailable; native NVFP4 compute cannot be proven")
    try:
        quant_ops = importlib.import_module("comfy.quant_ops")
        if not getattr(quant_ops, "_CK_AVAILABLE", False):
            return NVFP4Capability(False, "comfy-kitchen is not installed or was disabled")
        qtensor = getattr(quant_ops, "QuantizedTensor", None)
        layout = getattr(quant_ops, "TensorCoreNVFP4Layout", None)
        if qtensor is None or layout is None:
            return NVFP4Capability(False, "Comfy NVFP4 layout or QuantizedTensor API is missing")
        management = importlib.import_module("comfy.model_management")
        supports = getattr(management, "supports_nvfp4_compute", None)
        if supports is None or not bool(supports(device)):
            return NVFP4Capability(False, "the current device/runtime does not report native NVFP4 compute")
        kitchen = importlib.import_module("comfy_kitchen")
        if not callable(getattr(kitchen, "scaled_mm_nvfp4", None)):
            return NVFP4Capability(False, "the installed Kitchen package has no scaled_mm_nvfp4 kernel API")
    except Exception as exc:  # noqa: BLE001 - capability probing must never abort import
        return NVFP4Capability(False, f"NVFP4 capability probe failed: {type(exc).__name__}: {exc}")
    return NVFP4Capability(
        True,
        "native Comfy NVFP4 compute is reported available",
        native_compute=True,
        backend="comfy_kitchen.scaled_mm_nvfp4",
    )


def is_mlp_projection_name(name: str) -> bool:
    """Return true only for the intended H3 trunk MLP projection leaves."""
    match = _H3_MLP_PROJECTION.fullmatch(name)
    return bool(match and int(match.group("block")) < 50)


def is_out_proj_name(name: str) -> bool:
    """Return true only for trunk attention output projections (quality-unsafe FP4)."""
    match = _H3_OUT_PROJ.fullmatch(name)
    return bool(match and int(match.group("block")) < 50)


def discover_out_projections(model: nn.Module) -> tuple[str, ...]:
    """Discover exactly the 50 trained H3 trunk attention out_proj leaves."""
    found = {
        name: module for name, module in model.named_modules()
        if name and is_out_proj_name(name)
    }
    expected = tuple(
        f"diffusion_model.blocks.{block}.attn.out_proj" for block in range(50)
    )
    missing = tuple(name for name in expected if name not in found)
    if missing:
        details = ", ".join(
            f"{name}={type(module).__name__}" for name, module in sorted(found.items())
        ) or "none"
        raise NVFP4ValidationError(
            "expected exactly diffusion_model.blocks.0..49.attn.out_proj "
            f"(50 projections); missing {len(missing)}: {', '.join(missing[:8])}"
            f"{' ...' if len(missing) > 8 else ''}; discovered: {details}"
        )
    return expected


def _validate_linear_geometry(module: nn.Module, name: str) -> None:
    if not isinstance(module, nn.Module):
        raise NVFP4ValidationError(f"{name}: expected an nn.Module implementing the Linear protocol")
    weight = getattr(module, "weight", None)
    if not _materialized_tensor(weight):
        raise NVFP4ValidationError(f"{name}: weight must be a materialized tensor")
    if weight.ndim != 2:
        raise NVFP4ValidationError(f"{name}: expected a 2D weight, got {weight.ndim}D")
    out_features, in_features = weight.shape
    for attr, expected in (("in_features", in_features), ("out_features", out_features)):
        actual = getattr(module, attr, expected)
        if actual != expected:
            raise NVFP4ValidationError(f"{name}: {attr}={actual} disagrees with weight shape {tuple(weight.shape)}")
    bias = getattr(module, "bias", None)
    if bias is not None and (not _materialized_tensor(bias) or bias.ndim != 1 or bias.shape[0] != out_features):
        raise NVFP4ValidationError(f"{name}: bias must be a materialized 1D tensor with {out_features} entries")
    unsupported = tuple(attr for attr in _UNSUPPORTED_TRANSFORMS if _has_unsupported_transform(module, attr))
    if unsupported:
        raise NVFP4ValidationError(f"{name}: unsupported source smoothing/scaling or weight transform: {', '.join(unsupported)}")
    # Comfy's NVFP4 tensor-core path requires the padded input dimension to be
    # 32-aligned.  Reject instead of silently padding a model's trained layout.
    if in_features % 32:
        raise NVFP4ValidationError(
            f"{name}: in_features={in_features} is not NVFP4 tensor-core aligned (32)"
        )


def validate_mlp_linear(module: nn.Module, name: str) -> None:
    if not is_mlp_projection_name(name):
        raise NVFP4ValidationError(f"{name}: only diffusion_model.blocks.0..49.mlp.fc1/fc2 are supported")
    _validate_linear_geometry(module, name)


def validate_out_proj_linear(module: nn.Module, name: str) -> None:
    if not is_out_proj_name(name):
        raise NVFP4ValidationError(f"{name}: only diffusion_model.blocks.0..49.attn.out_proj are supported")
    _validate_linear_geometry(module, name)


class NVFP4MLPAdapter(nn.Module):
    """A Linear-compatible wrapper owning one native Comfy NVFP4 weight."""

    def __init__(self, source: nn.Module, name: str, *, capability: NVFP4Capability | None = None):
        super().__init__()
        if is_mlp_projection_name(name):
            validate_mlp_linear(source, name)
        elif is_out_proj_name(name):
            validate_out_proj_linear(source, name)
        else:
            raise NVFP4ValidationError(
                f"{name}: NVFP4 adapter allows only trunk mlp.fc1/fc2 or attn.out_proj"
            )
        conversion_device = source.weight.device
        if conversion_device.type == "cpu":
            management = importlib.import_module("comfy.model_management")
            conversion_device = torch.device(management.get_torch_device())
        if conversion_device.type != "cuda":
            raise NVFP4ValidationError(
                f"{name}: NVFP4 source conversion requires a CUDA device"
            )
        capability = capability or probe_nvfp4_capability(conversion_device)
        if not capability.available:
            raise NVFP4CapabilityError(f"{name}: {capability.reason}")
        source_precision = "original-float"
        # Comfy may load an INT8 checkpoint into a QuantizedTensor.  Dequantize
        # exactly once before requantizing, and retain provenance for reports;
        # lazy/meta tensors are rejected rather than accidentally materialized.
        source_weight = None
        try:
            # Copy only this source matrix. The original offloaded model stays
            # on CPU, and each staging allocation dies before the next adapter.
            source_weight = cast(torch.Tensor, source.weight).detach().contiguous()
            if source_weight.device != conversion_device:
                source_weight = source_weight.to(device=conversion_device)
            quant_ops = importlib.import_module("comfy.quant_ops")
            if isinstance(source_weight, quant_ops.QuantizedTensor):
                source_precision = "int8-requantized"
                source_weight = source_weight.dequantize().contiguous()
            qt = quant_ops.QuantizedTensor.from_float(source_weight, NVFP4_LAYOUT)
        except Exception as exc:
            # Backend traceback frames may retain the staged tensor even when
            # the caller holds the error. Keep the cause/message, release frames.
            exc.__traceback__ = None
            raise NVFP4CapabilityError(
                f"{name}: Comfy NVFP4 quantization from the loaded original weight failed: {exc}"
            ) from exc
        finally:
            del source_weight
        # Registering the quantized tensor as a Parameter preserves Comfy's
        # model-patcher/device lifecycle. No source-weight copy is retained.
        # Cost: torch ``Module._apply`` treats tensor subclasses as swap-only
        # (``Couldn't swap NVFP4MLPAdapter.weight``). Do not .to() this module
        # while Kineto or extra CUDA tracing is holding extra device memory.
        self.weight = nn.Parameter(qt, requires_grad=False)
        if source.bias is None:
            self.register_parameter("bias", None)
        else:
            source_bias = cast(Any, source.bias)
            self.bias = nn.Parameter(source_bias.detach().clone(), requires_grad=False)
        self.in_features: int = cast(int, source.in_features)
        self.out_features: int = cast(int, source.out_features)
        self._nvfp4_source_name = name
        self._nvfp4_source_precision = source_precision
        self._nvfp4_layout = NVFP4_LAYOUT
        # fc1/fc2 GEMMs are already bracketed by the fused MLP's mlp_fc1 /
        # mlp_fc2 ranges, so only out_proj needs its own stage range here.
        # Timing both would double-count the same kernels.
        self._nvfp4_stage = "attn_out_proj" if is_out_proj_name(name) else None

    def forward(self, x):
        if self._nvfp4_stage is None:
            return self._forward(x)
        try:
            from .nvtx import nvtx_range
        except ImportError:  # pragma: no cover - standalone test imports
            from nvtx import nvtx_range  # type: ignore[no-redef]
        with nvtx_range(self._nvfp4_stage):
            return self._forward(x)

    def _forward(self, x):
        quant_ops = importlib.import_module("comfy.quant_ops")
        original_shape: tuple[int, ...] = tuple(int(dim) for dim in x.shape)
        if x.ndim < 2:
            raise NVFP4CapabilityError(f"{self._nvfp4_source_name}: NVFP4 linear requires at least 2D activations")
        packed_input = isinstance(x, quant_ops.QuantizedTensor)
        if packed_input:
            original_shape = tuple(int(dim) for dim in x._params.orig_shape)
        output_dtype = x._params.orig_dtype if packed_input else x.dtype
        if packed_input and (x.ndim != 2 or x._layout_cls != NVFP4_LAYOUT or
                             getattr(x._params, "transposed", False)):
            raise NVFP4ValidationError("Packed FC2 input must be untransposed 2D NVFP4")
        x2 = x if packed_input else x.reshape(-1, x.shape[-1])
        if not packed_input and not x2.is_contiguous():
            x2 = x2.contiguous()
        if original_shape[-1] != self.in_features:
            raise NVFP4ValidationError("FC2 logical input width does not match its weight")
        logical_rows: int = int(original_shape[0] if packed_input else x2.shape[0])
        try:
            kitchen = importlib.import_module("comfy_kitchen")
            xq = x2 if packed_input else quant_ops.QuantizedTensor.from_float(x2, NVFP4_LAYOUT)
            input_qdata, scale_a, block_scale_a = quant_ops.TensorCoreNVFP4Layout.get_plain_tensors(xq)
            weight_qdata, scale_b, block_scale_b = quant_ops.TensorCoreNVFP4Layout.get_plain_tensors(self.weight)
            device = x2.device
            # Comfy's async offloader may keep the packed FC2 weight on CPU
            # even after the surrounding model is materialized.  Kitchen's
            # native GEMM requires every packed tensor, scale, and bias to be
            # on the activation device; make that boundary explicit.
            weight_qdata = weight_qdata.to(device=device)
            scale_b = scale_b.to(device=device)
            block_scale_b = block_scale_b.to(device=device)
            if self.bias is not None:
                bias = self.bias.to(device=device)
            else:
                bias = None
            # Use Kitchen's public native dispatcher.  Calling the private
            # backends.cuda wrapper directly passes DLPack capsules to the
            # nanobind CUDA binding and fails on the locked cp312-abi3 wheel.
            # The package-level API dispatches to the same native CUDA op and
            # does not select an eager/dequantizing fallback.
            out = kitchen.scaled_mm_nvfp4(
                input_qdata, weight_qdata,
                tensor_scale_a=scale_a, tensor_scale_b=scale_b,
                block_scale_a=block_scale_a, block_scale_b=block_scale_b,
                bias=bias, out_dtype=output_dtype,
            )
        except Exception as exc:
            raise NVFP4CapabilityError(
                f"{self._nvfp4_source_name}: native scaled_mm_nvfp4 dispatch failed; no dequantized fallback is allowed: {exc}"
            ) from exc
        # CUDA pads row/output dimensions; restore the logical linear shape.
        output = cast(torch.Tensor, out)
        return output[:logical_rows, :self.out_features].reshape(
            *original_shape[:-1], self.out_features
        )


def _replace_child(root: nn.Module, qualified_name: str, replacement: nn.Module) -> None:
    parent_name, _, child_name = qualified_name.rpartition(".")
    parent = root.get_submodule(parent_name) if parent_name else root
    setattr(parent, child_name, replacement)


def install_selective_nvfp4(
    model: nn.Module,
    layer_names: Iterable[str],
    *,
    enabled: bool = False,
    device=None,
) -> NVFP4InstallReport:
    """Install explicitly requested MLP adapters; disabled mode is a no-op.

    The function quantizes each original loaded weight exactly once.  It never
    wraps attention, gate, norm, modulation, embedding, or output layers.
    """
    names = tuple(layer_names)
    capability = probe_nvfp4_capability(device)
    if not enabled:
        return NVFP4InstallReport(False, (), names, capability)
    if not names:
        raise NVFP4ValidationError("selective NVFP4 is enabled but no MLP layer names were supplied")
    if not capability.available:
        raise NVFP4CapabilityError(f"selective NVFP4 is enabled but blocked: {capability.reason}")
    # Construct every adapter before changing the module tree.  A failed
    # quantization therefore leaves the caller's source model untouched.
    adapters = []
    for name in names:
        adapters.append((name, NVFP4MLPAdapter(model.get_submodule(name), name, capability=capability)))
    for name, adapter in adapters:
        _replace_child(model, name, adapter)
    applied = [name for name, _ in adapters]
    return NVFP4InstallReport(True, tuple(applied), (), capability)


def apply_mlp_fp4(model_patcher, layer_names: Iterable[str] | None = None, *, enabled: bool = True, device=None):
    """Return a clone with reversible MLP adapters installed as object patches.

    ``enabled`` defaults to true because this is the explicit fp4-mlp
    integration entry point; callers selecting a reference path should pass
    ``enabled=False`` and inspect the returned report.  ``model_patcher`` is
    intentionally not mutated.  The clone shares Comfy's
    normal model-patcher lifecycle; adapters are attached under their qualified
    module names and become active when that clone is loaded.  No Nunchaku or
    INT8-to-FP4 packed checkpoint is accepted here.
    """
    model = getattr(model_patcher, "model", None)
    if not isinstance(model, nn.Module):
        raise NVFP4ValidationError("apply_mlp_fp4 requires a Comfy ModelPatcher with a torch module")
    names = tuple(layer_names) if layer_names is not None else _model_mlp_names(model)
    capability = probe_nvfp4_capability(device)
    clone = model_patcher.clone()
    if not enabled:
        return clone, NVFP4InstallReport(False, (), names, capability)
    if not names:
        raise NVFP4ValidationError("fp4-mlp is enabled but no supported MLP projections were found")
    if not capability.available:
        raise NVFP4CapabilityError(f"fp4-mlp is enabled but blocked: {capability.reason}")
    # Quantize all sources before installing any object patch.  This keeps
    # installation atomic when one layer is unsupported or the wheel rejects
    # its shape/layout.
    adapters = [
        (name, NVFP4MLPAdapter(model.get_submodule(name), name, capability=capability))
        for name in names
    ]
    for name, adapter in adapters:
        clone.add_object_patch(name, adapter)
    applied = [name for name, _ in adapters]
    return clone, NVFP4InstallReport(True, tuple(applied), (), capability)


def apply_out_proj_fp4(model_patcher, *, enabled: bool = True, device=None):
    """QUALITY-UNSAFE: requantize the 50 trunk attention out_proj layers to NVFP4.

    This is approximate INT8/BF16→NVFP4 requantization, not a lossless change.
    Default loaders keep it off. Pair any clip A/B with ``quality_compare`` and
    a visual screen; tensor similarity is not T14 approval.
    """
    model = getattr(model_patcher, "model", None)
    if not isinstance(model, nn.Module):
        raise NVFP4ValidationError("apply_out_proj_fp4 requires a Comfy ModelPatcher with a torch module")
    return apply_mlp_fp4(
        model_patcher, discover_out_projections(model), enabled=enabled, device=device
    )


# Integration aliases kept explicit and discoverable for loader/patcher code.
install_nvfp4_mlp_adapters = install_selective_nvfp4


__all__ = [
    "NVFP4Capability",
    "NVFP4CapabilityError",
    "NVFP4InstallReport",
    "NVFP4MLPAdapter",
    "NVFP4ValidationError",
    "PrecisionError",
    "apply_mlp_fp4",
    "apply_out_proj_fp4",
    "discover_mlp_projections",
    "discover_out_projections",
    "install_nvfp4_mlp_adapters",
    "install_selective_nvfp4",
    "is_mlp_projection_name",
    "is_out_proj_name",
    "probe_nvfp4_capability",
    "validate_mlp_linear",
    "validate_out_proj_linear",
]
