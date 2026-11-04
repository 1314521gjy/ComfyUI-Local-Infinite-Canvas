"""Opt-in tiny CUDA diagnostic. Import/report do not launch or compile anything."""
from __future__ import annotations


def tiny_check(device="cuda", *, grouping_policy="none", pv_precision="int8"):
    """Explicit GPU action for a separately authorized validation worker.

    No model loading. Checks native execution, 1/63/64 live rows, zero residual
    channels, original prefix output and next statistics against stock Kitchen.
    Not a performance, source-pair, mixed-means, or full numerical qualification.
    """
    import torch

    from .runtime import _dependencies, sol_attn_chunked

    _, kitchen = _dependencies()
    dev = torch.device(device)
    t, h = 192, 1
    with torch.cuda.device(dev):
        gen = torch.Generator(device=dev).manual_seed(73)
        projection = torch.randn((t, 3 * 128), device=dev, dtype=torch.bfloat16, generator=gen)
        constants = torch.tensor([2.0, -4.0, 0.0, 0.5], device=dev,
                                 dtype=torch.bfloat16).repeat(32)
        projection[:, 256:] = constants
        freqs = torch.eye(2, device=dev).reshape(1, 1, 1, 2, 2).expand(t, 1, 64, 2, 2)
        weights = (torch.ones(128, device=dev, dtype=torch.bfloat16),) * 2
        lengths = torch.tensor([1, 63, 64], device=dev, dtype=torch.int32)

        def chunks():
            for start in range(0, t, 64):
                yield projection[start:start+64]

        common = {"topk_ratio": 0.2, "sink_q": [0, 1], "block_len": lengths,
                  "tail": False, "token_aug": 0}
        diagnostics: dict = {}
        actual, km, vs = sol_attn_chunked(
            chunks, t, h, freqs, weights, diagnostics=diagnostics,
            grouping_policy=grouping_policy, pv_precision=pv_precision, **common)
        stock, stock_km, stock_vs = kitchen.sol_attn_chunked(chunks, t, h, freqs, weights, **common)
        torch.cuda.synchronize(dev)
        torch.testing.assert_close(actual[:, :64], stock[:, :64], rtol=0, atol=0)
        torch.testing.assert_close(km, stock_km, rtol=0, atol=0)
        torch.testing.assert_close(vs, stock_vs, rtol=0, atol=0)
        torch.testing.assert_close(actual[0, 64:, 0], constants.expand(t-64, 128),
                                   rtol=0, atol=0.03125)
        if not bool(torch.isfinite(actual).all()):
            raise AssertionError("native tiny diagnostic produced nonfinite output")
        diagnostics.update(tiny_passed=True, tested_live_counts=[1, 63, 64],
                           max_constant_error=float((actual[0, 64:, 0] - constants).abs().max()))
        return diagnostics


def grouped_check(device="cuda", *, pv_precision="int8"):
    """Explicit GPU diagnostic: mixed values, routes, G4 layout and sparse oracle.

    Compares native output against actual decoded native operands, plus the
    independently implemented deterministic permutation. Caller authorizes GPU.
    """
    import math

    import torch

    from . import grouped_oracle as ref
    from .runtime import _dependencies, fine, original_route_scores, prepare_chunked, route

    _, kitchen = _dependencies()
    dev = torch.device(device)
    with torch.cuda.device(dev):
        gen = torch.Generator(device=dev).manual_seed(91)
        t, h = 192, 1
        qkv = torch.randn((t, 384), dtype=torch.bfloat16, device=dev, generator=gen)
        qkv[:, 256:] += torch.arange(t, device=dev).div(16, rounding_mode="floor")[:, None] * 0.25
        qkv[:, 256] = 0  # all-zero channel
        qkv[130, 260] = 8  # outlier in a different group/channel
        freqs = torch.eye(2, device=dev).reshape(1, 1, 1, 2, 2).expand(t, 1, 64, 2, 2)
        weights = (torch.ones(128, dtype=torch.bfloat16, device=dev),) * 2
        valid = torch.tensor([1, 63, 64], dtype=torch.int32, device=dev)

        def chunks():
            for start in range(0, t, 64):
                yield qkv[start:start+64]

        common = {"topk_ratio": .2, "tail": False, "sink_blocks": [0, 1],
                  "sink_q": [0, 1], "block_len": valid}
        x = prepare_chunked(chunks, t, h, freqs, weights,
                            grouping_policy="g4", pv_precision=pv_precision, **common)
        try:
            ids, counts = route(x)
            out = fine(x)
            score_export = original_route_scores(x)
            stock, stock_km, stock_vs = kitchen.sol_attn_chunked(
                chunks, t, h, freqs, weights, **common)
            torch.testing.assert_close(out[:, :64], stock[:, :64], rtol=0, atol=0)
            torch.testing.assert_close(x.kmean_next, stock_km, rtol=0, atol=0)
            torch.testing.assert_close((x.vamax_next / 127 * 1.1).clamp_min(1e-8),
                                       stock_vs, rtol=0, atol=0)
            qi = x.view("qiP", torch.int8, (t, h, 128)).cpu()
            qs = x.view("qs", torch.float32, (t, h)).cpu()
            keys = x.grouped.keys.cpu()
            ksb = x.grouped.key_scale_bias.cpu()
            original_v = x.view("vTi", torch.int8, (h, 128, t)).cpu()
            original_scale = x.original_vscale.cpu()
            residual = x.grouped.residual.cpu()
            means, scales = (v.cpu() for v in x.residual_metadata())
            perm = x.grouped.permutation.cpu()
            source_v = qkv[:, 256:].float().cpu()
            lengths = valid.cpu().tolist()
            ids, counts, result = ids.cpu(), counts.cpu(), out.float().cpu()
            for block, live in enumerate(lengths):
                expected = ref.cluster_permutation(
                    source_v[block*64:(block+1)*64].tolist(), live, protected=block == 0)
                if perm[0, 0, block].tolist() != expected:
                    raise AssertionError(f"group permutation mismatch in block {block}")
            # Verify score export from original carriers, not from grouped fine keys.
            cen = x.view("cen8", torch.int8, (1, 3, 128)).float().cpu()
            cens = x.view("cens", torch.float32, (1, 3)).cpu()
            kc = x.view("kciP", torch.int8, (1, x.plan["NPAD"], 128))[:, :3].float().cpu()
            kcs = x.view("kcs", torch.float32, (1, x.plan["NPAD"]))[:, :3].cpu()
            log2s = ref.f32(ref.f32(x.scale) * ref.f32(math.log2(math.e)))
            expected_scores = (cen @ kc.transpose(-1, -2)) * (cens * log2s)[:, :, None] * kcs[:, None]
            torch.testing.assert_close(score_export.cpu()[0], expected_scores, rtol=0, atol=0)

            def pd(row):
                return (row // 32) * 32 + 8 * ((row % 16) // 4) + 4 * ((row % 32) // 16) + row % 4

            physical = [0] * 64
            for p in range(64):
                physical[ref.perm_key(p)] = p
            worst = 0.0
            for query in (64, 71, 128, 143, 190):
                numerator = [0.0] * 128
                denominator, carried, running = 0.0, -3e38, -3e38
                qb = query // 64
                for block in ids[0, 0, qb, :int(counts[0, 0, qb])].tolist():
                    scores = []
                    for key in range(64):
                        row = block * 64 + physical[key]
                        dot = int((qi[query, 0].int() * keys[0, row].int()).sum())
                        multiplier = ref.f32(ref.f32(float(qs[query, 0]) * log2s) * float(ksb[0, row, 0]))
                        scores.append(ref.f32(dot * multiplier + float(ksb[0, row, 1])))
                    maximum = max(running - 20, max(scores[:lengths[block]]))
                    alpha = math.exp2(carried - maximum)
                    probability = ref.probability_weights(
                        scores, maximum, lengths[block],
                        fp4=pv_precision == "nvfp4" and block != 0)
                    for d in range(128):
                        contribution = 0.0
                        for key in range(lengths[block]):
                            if block == 0:
                                value = float(original_v[0, d, block*64+pd(key)]) * float(original_scale[0, d])
                            else:
                                if pv_precision == "nvfp4":
                                    byte = int(residual[0, d, block*32+key//2])
                                    code = (byte >> ((key % 2)*4)) & 15
                                    levels = (0., .5, 1., 1.5, 2., 3., 4., 6.)
                                    code_value = levels[code & 7] * (-1 if code & 8 else 1)
                                else:
                                    code = int(residual[0, d, block*64+pd(key)])
                                    code_value = code if code < 128 else code - 256
                                value = (code_value * float(scales[0, 0, block, key//16, d]) +
                                         float(means[0, 0, block, key//16, d]))
                            contribution += probability[key] * value
                        numerator[d] = alpha * numerator[d] + contribution
                    denominator = alpha * denominator + sum(probability)
                    carried, running = maximum, max(running, maximum)
                expected = torch.tensor(numerator) / denominator
                worst = max(worst, float((result[0, query, 0] - expected).abs().max()))
                # BF16 cast + native FP32 exp/FMA can differ from this CPU oracle.
                torch.testing.assert_close(result[0, query, 0], expected, rtol=.02, atol=.025)
            return {"grouped_tiny_passed": True, "pv_precision": pv_precision,
                    "max_oracle_error": worst, "kernel_resources": x.kernel_resources,
                    "build_report": x.native.report, "gpu_validated": False}
        finally:
            x.close()
