"""Packaged native attention smoke that does not load model weights."""
import json
import logging
import time
from typing import Any


def native_smoke(option, *, seed=42, attention_policy="control"):
    import comfy_kitchen as kitchen
    import torch

    from .attention_execution import capture_attention_execution, finalize_attention_execution
    from .attention_policy import attention_policy as resolve_policy
    from .build_identity import node_fingerprint, node_source_fingerprint
    from .kitchen_baseline import KITCHEN_VERSION
    from .vsa_sm120.config import kitchen_version
    from .vsa_sm120.dispatch import run_vsa_chunked

    if not torch.cuda.is_available() or torch.cuda.get_device_capability() != (12, 0):
        raise RuntimeError("native diagnostics require CUDA SM120")
    if kitchen_version() != KITCHEN_VERSION:
        raise RuntimeError(f"native diagnostics require Kitchen {KITCHEN_VERSION}")
    if option not in ("vsa", "vc", "anemoi", "combined", "cute_sol"):
        raise ValueError("unknown diagnostic option")
    if option == "cute_sol":
        from .cute_sol import attention as cute_attention
        from .cute_sol import require as require_cute
        from .cute_sol import runtime_identity

        device = torch.device("cuda")
        capability = require_cute(device)
        generator = torch.Generator(device=device).manual_seed(seed)
        q = torch.randn((1, 192, 2, 128), device=device, dtype=torch.bfloat16, generator=generator).contiguous()
        k = torch.randn_like(q).contiguous()
        v = torch.randn_like(q).contiguous()
        started = time.perf_counter()
        actual = cute_attention(q, k, v, tau=1.3, scale=128 ** -0.5,
                                sink_blocks=(0, 1), heads=2, capability=capability)
        torch.cuda.synchronize(device)
        cold_ms = (time.perf_counter() - started) * 1000
        start_event = torch.cuda.Event(enable_timing=True)
        end_event = torch.cuda.Event(enable_timing=True)
        start_event.record()
        warm = cute_attention(q, k, v, tau=1.3, scale=128 ** -0.5,
                              sink_blocks=(0, 1), heads=2, capability=capability)
        end_event.record()
        end_event.synchronize()
        if actual.shape != q.shape or not torch.isfinite(actual).all() or not torch.isfinite(warm).all():
            raise RuntimeError("CuTe SM120 diagnostic returned invalid output")
        return {
            "schema": "fasth3-native-smoke/1", "status": "passed", "option": option,
            "node_fingerprint": node_fingerprint(), "source_fingerprint": node_source_fingerprint(),
            "execution": {"calls": 1, "backends": {capability.backend: 1}, "options": {option: 1}},
            "warm_execution": {"calls": 1, "backends": {capability.backend: 1}, "options": {option: 1}},
            "native_libraries": {"cute_runtime": runtime_identity()},
            "attention_candidate_runtime": {"backend": capability.backend, "architecture": capability.architecture,
                                             "available": capability.available},
            "kitchen": kitchen_version(), "cold_ms": cold_ms,
            "warm_gpu_ms": start_event.elapsed_time(end_event), "quality_certified": False,
        }
    device = torch.device("cuda")
    generator = torch.Generator(device=device).manual_seed(seed)
    lengths = torch.tensor([63, 64, 1], device=device, dtype=torch.int32)
    live = (torch.arange(64, device=device)[None, :] < lengths[:, None]).flatten()
    qkv = torch.randn((192, 3 * 2 * 128), device=device, dtype=torch.bfloat16,
                      generator=generator)
    qkv[~live] = 0
    table = torch.eye(2, device=device, dtype=torch.bfloat16).expand(1, 192, 1, 64, 2, 2).contiguous()
    weights = (torch.ones(128, dtype=torch.bfloat16, device=device),) * 2
    gate = torch.zeros((1, 192, 2, 128), dtype=torch.bfloat16, device=device)

    def chunks():
        for start in range(0, 192, 64):
            yield qkv[start:start + 64]

    kwargs: dict[str, Any] = {"tau": 1.3, "topk_ratio": 0.2, "sink_blocks": [0, 1], "sink_q": [0, 1],
              "rope_eps": 1e-6, "extra": {"block_len": lengths, "coarse_gate": gate,
                                         "n_prefix": 1, "tail": False}, "token_aug": 0}
    policy = resolve_policy(option, attention_policy)
    kwargs.update(attention_policy=policy, native_state={})
    torch.cuda.synchronize()
    started = time.perf_counter()
    with capture_attention_execution() as execution:
        actual, next_k, next_v = run_vsa_chunked(
            chunks, 192, 2, table, weights, attention_option=option,
            backend="kitchen" if option == "vsa" else "native", **kwargs,
            evaluation_index=0,
        )
    torch.cuda.synchronize()
    cold_ms = (time.perf_counter() - started) * 1000
    if not torch.isfinite(actual.reshape(192, 2, 128)[live]).all():
        raise RuntimeError("nonfinite native smoke output")
    if next_k is None or next_v is None:
        raise RuntimeError("native producer failed to return next-call statistics")
    reference, reference_k, reference_v = kitchen.sol_attn_chunked(
        chunks, 192, 2, table, weights, tau=1.3, topk_ratio=0.2,
        sink_blocks=[0, 1], sink_q=[0, 1], rope_eps=1e-6, tail=False,
        block_len=lengths, coarse_gate=gate, token_aug=0,
    )
    actual_live = actual.reshape(192, 2, 128)[live].float()
    reference_live = reference.reshape(192, 2, 128)[live].float()
    error = (actual_live - reference_live).abs()
    # A loose bring-up gate catches scale/normalization corruption. Full
    # quality qualification uses frozen real H3 captures, not this threshold.
    torch.testing.assert_close(actual_live, reference_live, atol=0.12, rtol=0.12)
    start_event, end_event = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
    start_event.record()
    with capture_attention_execution() as warm_execution:
        warm, warm_k, warm_v = run_vsa_chunked(
            chunks, 192, 2, table, weights,
            attention_option=option, backend="kitchen" if option == "vsa" else "native",
            kmean=next_k, vscale=next_v, evaluation_index=1, **kwargs)
    end_event.record()
    end_event.synchronize()
    finalize_attention_execution(execution)
    finalize_attention_execution(warm_execution)
    if execution["calibration_clipped"] or warm_execution["calibration_clipped"]:
        raise RuntimeError("native diagnostic calibration clipped operands")
    warm_reference, stock_k, stock_v = kitchen.sol_attn_chunked(
        chunks, 192, 2, table, weights, kmean=reference_k, vscale=reference_v,
        tau=1.3, topk_ratio=0.2, sink_blocks=[0, 1], sink_q=[0, 1],
        rope_eps=1e-6, tail=False, block_len=lengths, coarse_gate=gate, token_aug=0,
    )
    torch.testing.assert_close(warm.reshape(192, 2, 128)[live].float(),
                               warm_reference.reshape(192, 2, 128)[live].float(),
                               atol=0.12, rtol=0.12)
    for actual_stat, stock_stat in ((next_k, reference_k), (next_v, reference_v),
                                    (warm_k, stock_k), (warm_v, stock_v)):
        torch.testing.assert_close(actual_stat, stock_stat, atol=1e-5, rtol=1e-5)
    artifacts = {}
    if option != "vsa":
        from .native_attention._abi import artifact_report
        artifacts["kitchen_native"] = artifact_report()[1]["library_sha256"]
        if option in ("anemoi", "combined"):
            from .anemoi_native.artifact import artifact_report as anemoi_artifact
            artifacts["anemoi_native"] = anemoi_artifact()["library_sha256"]
    return {"schema": "fasth3-native-smoke/1", "status": "passed", "option": option,
            "node_fingerprint": node_fingerprint(), "execution": execution,
            "warm_execution": warm_execution,
            "source_fingerprint": node_source_fingerprint(), "native_libraries": artifacts,
            "kitchen": kitchen_version(), "cold_ms": cold_ms,
            "warm_gpu_ms": start_event.elapsed_time(end_event),
            "max_abs_error_vs_kitchen": error.max().item(),
            "quality_certified": False}


class ComfyStreamerH3NativeAttentionDiagnostic:
    RETURN_TYPES = ("STRING",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "ComfyStreamerH3/Diagnostics"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "option": (["vsa", "vc", "anemoi", "combined", "cute_sol"],),
            "run_nonce": ("STRING", {"default": ""}),
        }, "optional": {"attention_policy": (["control", "optimized", "early_grouping"],
                                              {"default": "control"})}}

    def run(self, option, run_nonce, attention_policy="control"):
        if not run_nonce:
            raise ValueError("a fresh run_nonce is required")
        report = native_smoke(option, attention_policy=attention_policy)
        report["attention_policy"] = attention_policy
        report["run_nonce"] = run_nonce
        text = json.dumps(report, sort_keys=True)
        logging.getLogger(__name__).info("FASTH3_NATIVE_DIAGNOSTIC %s", text)
        return {"ui": {"text": [text]}, "result": (text,)}
