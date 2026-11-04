"""Independent CPU algebra oracle. Never used as a runtime fallback.

Pure stdlib so tests run without PyTorch/CUDA. Float64 arithmetic after BF16
mean representation; does not model GPU exp2 approximation, FP32 FMA, or MMA
accumulator layout. Inputs are original BF16 values represented as Python floats.
"""
from __future__ import annotations

import math
import struct


def bf16(value):
    bits = struct.unpack("<I", struct.pack("<f", value))[0]
    rounded = (bits + 0x7FFF + ((bits >> 16) & 1)) & 0xFFFF0000
    return struct.unpack("<f", struct.pack("<I", rounded))[0]


def center_block(rows, valid):
    if not rows or not 0 < valid <= len(rows) <= 64:
        raise ValueError("block requires 1..64 live rows")
    width = len(rows[0])
    if not width or any(len(row) != width for row in rows):
        raise ValueError("ragged value channels")
    mean = [bf16(sum(row[d] for row in rows[:valid]) / valid) for d in range(width)]
    scale = [max(max(abs(row[d] - mean[d]) for row in rows[:valid]) / 127, 1e-8)
             for d in range(width)]
    codes = [
        [max(-127, min(127, round((row[d] - mean[d]) / scale[d])))
         if t < valid else 0 for d in range(width)]
        for t, row in enumerate(rows)
    ]
    return codes, mean, scale


def sparse_online(blocks, scores, route_ids, counts, valid_counts, *, original_scales,
                  protected_keys=(), protected_query=False):
    """Kitchen packed-P online loop with original or residual V, single query.

    Empty route slots are ignored. Return numerator/denominator diagnostics in
    packed U8 units. Scores are already base-2 QK results; routing is an input.
    """
    if not 0 <= counts <= len(route_ids):
        raise ValueError("route count exceeds capacity")
    width = len(original_scales)
    if any(s <= 0 or not math.isfinite(s) for s in original_scales):
        raise ValueError("original scales must be positive and finite")
    numerator, denominator, running_max, carried_max = [0.0] * width, 0.0, -3e38, -3e38
    for block in route_ids[:counts]:
        if not 0 <= block < len(blocks):
            raise ValueError("live route ID out of range")
        rows, valid = blocks[block], valid_counts[block]
        codes, mean, scales = center_block(rows, valid)
        if protected_query or block in protected_keys:
            scales, mean = original_scales, [0.0] * width
            codes = [[max(-127, min(127, round(row[d] / scales[d])))
                      for d in range(width)] for row in rows]
        # Match Kitchen's block-local max with running_max-20 floor, rather
        # than replacing its numerical policy with a monotone softmax max.
        block_max = max(running_max - 20, max(scores[block][:valid]))
        alpha = math.exp2(carried_max - block_max)
        weights = [min(255, max(0, round(math.exp2(s - block_max + 7.99435344))))
                   for s in scores[block][:valid]]
        mass = sum(weights)
        for d in range(width):
            dot = sum(weights[t] * codes[t][d] for t in range(valid))
            if protected_query:
                numerator[d] = alpha * numerator[d] + dot
            else:
                numerator[d] = alpha * numerator[d] + dot * scales[d] + mass * mean[d]
        denominator = alpha * denominator + mass
        carried_max = block_max
        running_max = max(running_max, block_max)
    out = [n / max(denominator, 1e-30) *
           (original_scales[d] if protected_query else 1.0) for d, n in enumerate(numerator)]
    return out, numerator, denominator
