"""Scoped adapters for Kitchen 0.2.34 and the native MiniMax H3 video VAE.

Enter after ``decoder_mode`` and exit before it. No global dispatch, dtype or
accumulation flags are changed. ``executed`` counts successful Kitchen API
calls, NOT confirmed fused GPU launches: Kitchen may fall back internally.
GPU profiler evidence is required before claiming a fused-kernel speedup.
"""

from __future__ import annotations

import types
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field

import torch
from torch.nn import functional as F

_OWNER = "_fasth3_kitchen_vae_owner"
_NATIVE = "comfy.ldm.minimax.vae"
_FEATURES = ("group_norm_silu_pad3d", "int8_input_norm", "int8_input_activation",
             "int8_residual", "fp16_conv3d", "fp16_linear")


@dataclass(frozen=True)
class KitchenVAEPolicy:
    group_norm_silu_pad3d: bool = True
    int8_input_norm: bool = True
    int8_input_activation: bool = True
    int8_residual: bool = True
    fp16_conv3d: bool = False
    fp16_linear: bool = False
    cache_scale_casts: bool = True


@dataclass
class KitchenVAEReport:
    policy: KitchenVAEPolicy
    executed: Counter = field(default_factory=Counter)
    skipped: Counter = field(default_factory=Counter)
    skip_reasons: dict = field(default_factory=dict)
    patched_modules: list = field(default_factory=list)
    restored: bool = False
    work: Counter = field(default_factory=Counter)

    def skip(self, feature, reason):
        self.skipped[feature] += 1
        self.skip_reasons.setdefault(feature, Counter())[reason] += 1

    def to_dict(self):
        return {"policy": asdict(self.policy),
                "executed": {k: self.executed[k] for k in _FEATURES},
                "skipped": {k: self.skipped[k] for k in (*_FEATURES, *self.skipped)},
                "skip_reasons": {k: dict(v) for k, v in self.skip_reasons.items()},
                "patched_modules": list(self.patched_modules), "restored": self.restored,
                "work": dict(self.work),
                "work_counter_scope": "scale cast calls/hits/misses and tensor result bytes; not GPU timing",
                "counter_scope": "successful Kitchen API calls; internal fallback possible",
                "gpu_fusion_verified": False}


class _ScaleCastCache:
    """Bounded by patched block count; entries die with the VAE scope.

    Reuse requires a versioned source without a live source-gradient graph. Unversioned
    inference tensors cannot prove immutability and bypass the cache. Stream
    changes replace entries instead of reusing tensors with unsatisfied stream
    dependencies. Source replacement, in-place mutation and storage changes
    also invalidate, without synchronizing or copying source values to CPU.
    """
    def __init__(self, report):
        self.report = report
        self.entries = {}

    def cast(self, module, name, x, cast_to_input):
        source = getattr(module, name)
        slot = (id(module), name)
        signature = None
        if self.report.policy.cache_scale_casts:
            if (not isinstance(source, torch.Tensor) or source.device.type == "meta"
                    or (torch.is_grad_enabled() and source.requires_grad)):
                self.report.work["scale_cast_cache_bypassed"] += 1
            else:
                try:
                    version = source._version
                except RuntimeError:
                    self.report.work["scale_cast_cache_unversioned"] += 1
                else:
                    stream = torch.cuda.current_stream(x.device).cuda_stream if x.device.type == "cuda" else None
                    signature = (version, source.data_ptr(), tuple(source.shape), tuple(source.stride()),
                                 source.dtype, source.device, x.dtype, x.device, stream)
        old = self.entries.get(slot)
        if signature is not None and old is not None and old[0] is source and old[1] == signature:
            self.report.work["scale_cast_cache_hits"] += 1
            self.report.work["scale_cast_avoided_result_bytes"] += old[2].numel() * old[2].element_size()
            return old[2]
        if signature is not None:
            self.report.work["scale_cast_cache_misses"] += 1
        if old is not None:
            self.entries.pop(slot)
            self.report.work["scale_cast_cache_invalidations"] += 1
        value = cast_to_input(source, x)
        self.report.work["scale_cast_calls"] += 1
        self.report.work["scale_cast_result_bytes"] += value.numel() * value.element_size()
        if signature is not None:
            self.entries[slot] = (source, signature, value)
            self.report.work["scale_cast_cache_peak_entries"] = max(
                self.report.work["scale_cast_cache_peak_entries"], len(self.entries))
        return value

    def clear(self):
        self.entries.clear()
        self.report.work["scale_cast_cache_entries_after_exit"] = 0


def _native(module, name):
    return type(module).__module__ == _NATIVE and type(module).__name__ == name


def _inference(x):
    import comfy.model_management
    return (x.is_cuda and not torch.is_grad_enabled()
            and not comfy.model_management.in_training)


def _unmodified(module):
    return "forward" not in module.__dict__ and not (
        module._forward_hooks or module._forward_pre_hooks or module._backward_hooks)


@contextmanager
def _weights(module, x, *, quantized=False):
    # Match Comfy's streaming/LoRA lifetime, including exception cleanup.
    from comfy.ops import cast_bias_weight, uncast_bias_weight
    weight, bias, stream = cast_bias_weight(
        module, x, offloadable=True, compute_dtype=x.dtype, want_requant=quantized)
    try:
        yield weight, bias
    finally:
        uncast_bias_weight(module, weight, bias, stream)


def _is_int8(weight):
    from comfy.quant_ops import QuantizedTensor
    return (isinstance(weight, QuantizedTensor)
            and weight._layout_cls == "TensorWiseINT8Layout"
            and not getattr(weight._params, "transposed", False))


def _activate(x, norm=None, activation=None):
    if norm is not None:
        from comfy.rmsnorm import rms_norm
        return rms_norm(x, norm.weight, norm.eps)
    if activation == "swiglu":
        gate, up = x.chunk(2, dim=-1)
        return F.silu(gate).mul_(up)
    return x


def _linear(linear, x, original, ck, policy, report, *, norm=None,
            activation=None, residual=None, scale=None):
    """Consume each norm/activation/residual once, including every fallback."""
    requested = []
    if norm is not None:
        requested.append("int8_input_norm")
    if activation is not None:
        requested.append("int8_input_activation")
    if residual is not None:
        requested.append("int8_residual")
    enabled = [f for f in requested if getattr(policy, f)]
    for feature in set(requested) - set(enabled):
        report.skip(feature, "policy_disabled")

    def finish(out):
        return out if residual is None else torch.addcmul(residual, out, scale)

    reason = "not_cuda_inference"
    if _inference(x) and x.dtype in (torch.float16, torch.bfloat16):
        reason = "not_tensorwise_int8"
        if enabled and _is_int8(linear.weight) and callable(getattr(ck, "int8_linear", None)):
            with _weights(linear, x, quantized=True) as (weight, bias):
                if _is_int8(weight):
                    from comfy.quant_ops import TensorWiseINT8Layout
                    qdata, wscale = TensorWiseINT8Layout.get_plain_tensors(weight)
                    use_norm = (norm is not None and policy.int8_input_norm
                                and norm.weight is not None
                                and norm.weight.shape == (x.shape[-1],)
                                and norm.weight.device == x.device)
                    use_act = activation is not None and policy.int8_input_activation
                    use_res = (residual is not None and policy.int8_residual
                               and residual.shape == (*x.shape[:-1], qdata.shape[0])
                               and residual.dtype == x.dtype and residual.device == x.device
                               and scale.shape == (qdata.shape[0],)
                               and scale.dtype == x.dtype and scale.device == x.device
                               and residual.is_contiguous() and residual.data_ptr() % 16 == 0)
                    act = "rms_norm" if use_norm else activation if use_act else None
                    value = x if act else _activate(x, norm, activation)
                    out = ck.int8_linear(
                        value, qdata, wscale, bias, x.dtype,
                        convrot=getattr(weight._params, "convrot", False),
                        convrot_groupsize=getattr(weight._params, "convrot_groupsize", 256),
                        input_act=act, input_act_weight=norm.weight if use_norm else None,
                        input_act_eps=float(norm.eps) if use_norm else 0.0,
                        residual=residual if use_res else None,
                        residual_scale=scale if use_res else None)
                    for feature, used in (("int8_input_norm", use_norm),
                                          ("int8_input_activation", use_act),
                                          ("int8_residual", use_res)):
                        if feature in enabled:
                            if used:
                                report.executed[feature] += 1
                            else:
                                report.skip(feature, "operand_contract")
                    return out if use_res else finish(out)
                reason = "cast_dequantized_weight"
        elif enabled and not callable(getattr(ck, "int8_linear", None)):
            reason = "api_unavailable"
    for feature in enabled:
        report.skip(feature, reason)
    value = _activate(x, norm, activation)
    if policy.fp16_linear:
        reason = "dtype_device_or_shape"
        w = linear.weight
        if (_inference(value) and value.dtype == torch.float16
                and w.dtype == torch.float16 and w.ndim == 2
                and not _is_int8(w) and callable(getattr(ck, "fp16_linear", None))):
            m, n, k = value.numel() // value.shape[-1], w.shape[0], w.shape[1]
            tile_n = 128 if k > 4096 or 3072 < n <= 8192 else 256
            enough = ((m + 127) // 128) * ((n + tile_n - 1) // tile_n) >= (
                32 if k > 4096 else 96)
            if k > 0 and k % 8 == 0 and n % 8 == 0 and 0 < m <= 8192 and enough:
                with _weights(linear, value) as (weight, bias):
                    if (weight.dtype == value.dtype and weight.device == value.device
                            and weight.is_contiguous() and weight.data_ptr() % 16 == 0
                            and (bias is None or (bias.dtype == value.dtype
                                                 and bias.device == value.device))):
                        out = ck.fp16_linear(value.contiguous(), weight, bias)
                        report.executed["fp16_linear"] += 1
                        return finish(out)
            reason = "alignment_or_tile_gate"
        report.skip("fp16_linear", reason)
    return finish(original(value))


def _can_bypass_conv(conv, owner):
    """Only bypass an untouched conv or the current scope's own forward."""
    if conv._forward_hooks or conv._forward_pre_hooks or conv._backward_hooks:
        return False
    if hasattr(conv, _OWNER):
        return (getattr(conv, _OWNER) is owner
                and getattr(conv.forward, _OWNER, None) is owner)
    return _unmodified(conv)


def _conv(conv, x, ck, policy, report, owner):
    """Input is already padded; never call CausalConv3d.forward again here."""
    if not _can_bypass_conv(conv, owner):
        # Padding is already consumed, so replaying a foreign forward here
        # would double-pad. _pair normally declines before reaching this point.
        raise RuntimeError("convolution ownership changed during Kitchen VAE fusion")
    if policy.fp16_conv3d:
        reason = "dtype_device_or_shape"
        if (_inference(x) and x.dtype == torch.float16
                and conv.weight.dtype == torch.float16 and conv.groups == 1
                and tuple(conv.dilation) == (1, 1, 1) and not any(conv.padding)
                and callable(getattr(ck, "fp16_conv3d", None))):
            with _weights(conv, x) as (weight, bias):
                c, n = x.shape[1], weight.shape[0]
                if ((c < 8 or c % 8 == 0) and n % 8 == 0
                        and weight.device == x.device and weight.dtype == x.dtype
                        and all(a >= b for a, b in zip(x.shape[2:], weight.shape[2:]))
                        and (bias is None or (bias.dtype == x.dtype and bias.device == x.device))):
                    out = ck.fp16_conv3d(x, weight, bias, stride=conv.stride)
                    report.executed["fp16_conv3d"] += 1
                    return out
        report.skip("fp16_conv3d", reason)
    return super(type(conv), conv).forward(x)


def _pair(norm, conv, x, ck, policy, report, owner):
    reason = "policy_disabled"
    if policy.group_norm_silu_pad3d:
        if (hasattr(norm, _OWNER) or not _unmodified(norm)
                or not _can_bypass_conv(conv, owner)):
            report.skip("group_norm_silu_pad3d", "ownership")
            return conv(F.silu(norm(x)))
        reason = "dtype_device_or_shape"
        if (_inference(x) and x.ndim == 5 and x.dtype in (torch.float16, torch.bfloat16)
                and _native(norm, "TemporalIsolatedGroupNorm")
                and _native(conv, "CausalConv3d") and _unmodified(norm)
                and norm.weight is not None and callable(getattr(ck, "group_norm_silu_pad3d", None))):
            b, c, t, h, w = x.shape
            pt, ph, pw = conv.causal_padding
            if (c >= 8 and c % 8 == 0 and 256 % (c // 8) == 0
                    and c % norm.num_groups == 0 and norm.num_groups <= 1024
                    and min(pt, ph, pw) >= 0 and ph < h and pw < w
                    and b * (t + 2 * pt) <= 65535):
                with _weights(norm, x) as (weight, bias):
                    padded = ck.group_norm_silu_pad3d(
                        x, weight, bias, norm.num_groups, norm.eps,
                        (pw, pw, ph, ph, 2 * pt), True)
                report.executed["group_norm_silu_pad3d"] += 1
                return _conv(conv, padded, ck, policy, report, owner)
    report.skip("group_norm_silu_pad3d", reason)
    return conv(F.silu(norm(x)))


@contextmanager
def kitchen_vae(vae, policy=None, *, kitchen=None):
    """Yield a live :class:`KitchenVAEReport`; restore on success or exception.

    Accepts the native video VAE or Comfy's wrapper with ``first_stage_model``.
    Enter inside decoder_mode. Overlapping scopes on the same model are rejected.
    ``kitchen`` is an injectable API for CPU mocks; production defaults to Comfy's
    Kitchen instance. The model must not be used concurrently during this scope.
    """
    policy = policy or KitchenVAEPolicy()
    report = KitchenVAEReport(policy)
    model = getattr(vae, "first_stage_model", vae)
    if not _native(model, "MiniMaxH3VideoVAE"):
        for feature in _FEATURES:
            report.skip(feature, "not_native_h3_video_vae")
        report.restored = True
        yield report
        return
    if hasattr(model, _OWNER):
        raise RuntimeError("Kitchen VAE scope already owns this model")
    if kitchen is None:
        import comfy.quant_ops
        kitchen = comfy.quant_ops.ck
    ck = kitchen
    token = object()
    patches = []
    setattr(model, _OWNER, token)

    def patch(module, name, forward, *, decoder_block=False):
        old = module.__dict__.get("forward")
        known = (decoder_block and getattr(old, "_fasth3_decoder_block", False)
                 and not (module._forward_hooks or module._forward_pre_hooks
                          or module._backward_hooks))
        if hasattr(module, _OWNER) or (not _unmodified(module) and not known):
            report.skip("ownership", name)
            return False
        bound = types.MethodType(forward, module)
        setattr(forward, _OWNER, token)
        patches.append((module, old, bound))
        setattr(module, _OWNER, token)
        module.forward = bound
        report.patched_modules.append(name)
        return True

    def resnet(self, x):
        h = _pair(self.norm1, self.conv1, x, ck, policy, report, token)
        h = _pair(self.norm2, self.conv2, h, ck, policy, report, token)
        if self.in_channels != self.out_channels:
            x = self.nin_shortcut(x)
        return h.add_(x)

    def encoder(self, x):
        h = self.conv_in(x)
        for level in self.down:
            for block in level.block:
                h = block(h)
            if hasattr(level, "downsample"):
                h = level.downsample(h)
        return _pair(self.norm_out, self.conv_out, h, ck, policy, report, token)

    # Decoder blocks reuse their AdaLN modulation tensors for every sampled
    # frame/evaluation. Keep the cast in this scope so we avoid recasting the
    # same two vectors on every block call, while still invalidating if a
    # patcher replaces either source tensor or the input dtype/device changes.
    scale_cache = _ScaleCastCache(report)

    def block(self, x, rotary_pos_emb=None):
        from comfy.ops import cast_to_input
        # Attention (including the installed QK/RoPE wrapper) remains intact.
        scale1 = scale_cache.cast(self, "scale1", x, cast_to_input)
        scale2 = scale_cache.cast(self, "scale2", x, cast_to_input)
        x = x.addcmul_(self.attn(_activate(x, self.norm1), rotary_pos_emb),
                      scale1)
        hidden = _linear(self.ff.w1, x, self.ff.w1.forward, ck, policy, report,
                         norm=self.norm2)
        return _linear(self.ff.w2, hidden, self.ff.w2.forward, ck, policy, report,
                       activation="swiglu", residual=x, scale=scale2)

    def causal_forward(original):
        def causal(self, x):
            if not (_inference(x) and x.dtype == torch.float16
                    and self.weight.dtype == torch.float16):
                report.skip("fp16_conv3d", "dtype_or_device")
                return original(x)
            pt, ph, pw = self.causal_padding
            x = F.pad(x, (pw, pw, ph, ph, 0, 0), mode="reflect")
            x = F.pad(x, (0, 0, 0, 0, 2 * pt, 0))
            return _conv(self, x, ck, policy, report, token)
        return causal

    try:
        # Snapshot before mutation. Only the encoder and video decoder are visited.
        for root_name in ("encoder", "decoder"):
            root = getattr(model, root_name, None)
            if root is None:
                continue
            excluded: set[int] = set()
            for name, module in tuple(root.named_modules()):
                path = f"{root_name}.{name}".rstrip(".")
                if _native(module, "TransformerBlock"):
                    ff = module.ff
                    ff_known = (_native(ff, "FeedForward")
                                and not (ff._forward_hooks or ff._forward_pre_hooks)
                                and (_unmodified(ff) or getattr(
                                    ff.forward, "_fasth3_stage_name", None) == "decode_ff"))
                    if (ff_known and _unmodified(ff.w1) and _unmodified(ff.w2)
                            and any((policy.int8_input_norm, policy.int8_input_activation,
                                     policy.int8_residual))):
                        if patch(module, path, block, decoder_block=True):
                            excluded.update((id(ff.w1), id(ff.w2)))
                    else:
                        report.skip("ownership", path)
                elif _native(module, "ResnetBlock3D") and policy.group_norm_silu_pad3d:
                    patch(module, path, resnet)
                elif _native(module, "EncoderFCN3D") and policy.group_norm_silu_pad3d:
                    patch(module, path, encoder)
                elif _native(module, "CausalConv3d") and policy.fp16_conv3d:
                    patch(module, path, causal_forward(module.forward))
                elif (isinstance(module, torch.nn.Linear) and policy.fp16_linear
                      and id(module) not in excluded):
                    original = module.forward

                    def linear(self, x, _original=original):
                        return _linear(self, x, _original, ck, policy, report)

                    patch(module, path, linear)
        yield report
    finally:
        scale_cache.clear()
        for module, old, installed in reversed(patches):
            if module.__dict__.get("forward") is installed:
                if old is None:
                    del module.forward
                else:
                    module.forward = old
            else:
                report.skip("ownership", "forward_changed_during_scope")
            if getattr(module, _OWNER, None) is token:
                delattr(module, _OWNER)
        if getattr(model, _OWNER, None) is token:
            delattr(model, _OWNER)
        report.restored = True


@contextmanager
def kitchen_vae_mode(vae, precision_policy="established", enabled=True, *, kitchen=None,
                     cache_scale_casts=True):
    """Benchmark-facing API yielding a JSON-safe report, refreshed on exit.

    ``established`` enables the eligible norm/activation/residual adapters;
    ``fp16_accum`` additionally permits approximate FP16 accumulation. Disabled
    is a strict no-op (including no Kitchen import). Use separate scopes and
    reports for image-conditioning encode and benchmark decode.
    """
    if precision_policy not in ("established", "fp16_accum"):
        raise ValueError(f"unknown VAE precision policy: {precision_policy!r}")
    fp16 = precision_policy == "fp16_accum"
    policy = KitchenVAEPolicy(fp16_conv3d=fp16, fp16_linear=fp16,
                             cache_scale_casts=cache_scale_casts)
    if not enabled:
        disabled_report = KitchenVAEReport(policy, restored=True)
        for feature in _FEATURES:
            disabled_report.skip(feature, "disabled")
        yield dict(disabled_report.to_dict(), enabled=False, precision_policy=precision_policy)
        return
    report: KitchenVAEReport | None = None
    try:
        with kitchen_vae(vae, policy, kitchen=kitchen) as report:
            result = dict(report.to_dict(), enabled=True, precision_policy=precision_policy)
            yield result
    finally:
        if report is not None:
            result.update(report.to_dict())


__all__ = ["KitchenVAEPolicy", "KitchenVAEReport", "kitchen_vae", "kitchen_vae_mode"]
