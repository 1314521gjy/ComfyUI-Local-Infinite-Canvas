"""CPU grouping/represented-P reference, not a runtime implementation."""
from __future__ import annotations

import math
import struct

from .oracle import bf16


def f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def cluster_permutation(rows, valid, protected=False):
    """Four fixed Lloyd iterations; deterministic seeds/ties; invalid rows last."""
    if len(rows) != 64 or not 1 <= valid <= 64:
        raise ValueError("requires one 64-slot cube and 1..64 live values")
    if protected:
        return list(range(64))
    width = len(rows[0])
    centers = [list(rows[g * (valid - 1) // 3]) for g in range(4)]
    labels = [4] * 64
    for _ in range(4):
        for r in range(valid):
            distances = []
            for g in range(4):
                distance = 0.0
                for d in range(width):
                    delta = f32(rows[r][d] - centers[g][d])
                    distance = f32(distance + f32(delta * delta))
                distances.append(distance)
            labels[r] = min(range(4), key=lambda g: (distances[g], g))
        for g in range(4):
            members = [r for r in range(valid) if labels[r] == g]
            if members:
                for d in range(width):
                    total = 0.0
                    for r in members:
                        total = f32(total + rows[r][d])
                    centers[g][d] = f32(total / len(members))
    return sorted(range(64), key=lambda r: (labels[r], r))


def perm_key(physical):
    return 16 * (physical >> 4) + 4 * ((physical & 7) >> 1) + 2 * ((physical >> 3) & 1) + (physical & 1)


def natural_fragment_source(half, qd, i):
    """Kitchen score tile, source quad lane, score column for NV K64 A."""
    return 4 * half + 2 * (qd // 2) + ((i >> 1) & 1), 2 * (qd & 1) + (i >> 2), i & 1


def e4(value):
    value = max(0.0, min(448.0, value))
    levels = [
        ((code & 7) * 2**-9 if code < 8
         else (1 + (code & 7) / 8) * 2**((code >> 3) - 7))
        for code in range(127)
    ]
    code = min(range(127), key=lambda c: (abs(levels[c] - value), c & 1))
    return levels[code]


def e2(value):
    levels = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)
    code = min(range(8), key=lambda c: (abs(levels[c] - abs(value)), c & 1))
    return math.copysign(levels[code], value)


def global_clipping_counts(residuals, global_scale):
    entries, groups = 0, 0
    for offset in range(0, len(residuals), 16):
        for d, scale in enumerate(global_scale):
            outside = [not math.isfinite(row[d]) or abs(row[d]) > f32(2688 * scale)
                       for row in residuals[offset:offset+16]]
            entries += sum(outside)
            groups += any(outside)
    return entries, groups


def grouped_values(rows, valid, permutation, *, fp4=False, global_scale=None, center=True):
    if sorted(permutation) != list(range(64)) or set(permutation[:valid]) != set(range(valid)):
        raise ValueError("permutation must preserve the cube's live/invalid support")
    width = len(rows[0])
    represented, means, scales = [[0.0] * width for _ in range(64)], [], []
    for group in range(4):
        count = max(0, min(16, valid - 16 * group))
        selected = [rows[permutation[group * 16 + i]] for i in range(count)]
        mu, scale = [], []
        for d in range(width):
            total = 0.0
            for row in selected:
                total = f32(total + row[d])
            mean = bf16(f32(total / count)) if center and count else 0.0
            maximum = max((abs(f32(row[d] - mean)) for row in selected), default=0.0)
            s = (e4(maximum / (6 * global_scale[d])) * global_scale[d] if fp4
                 else max(maximum / 127, 1e-8))
            mu.append(mean)
            scale.append(s)
            for i, row in enumerate(selected):
                raw = f32(row[d] - mean)
                if fp4:
                    decoded = e2(raw / s) * s if s else 0.0
                else:
                    decoded = max(-127, min(127, round(raw / s))) * s
                represented[group * 16 + i][d] = decoded + mean
        means.append(mu)
        scales.append(scale)
    return represented, means, scales


def probability_weights(scores, maximum, valid, *, fp4):
    """Return represented probabilities in a common x255 domain."""
    p = [math.exp2(s - maximum) if i < valid else 0.0 for i, s in enumerate(scores)]
    if not fp4:
        return [min(255, max(0, round(math.exp2(s - maximum + 7.99435344))))
                if i < valid else 0.0 for i, s in enumerate(scores)]
    weights = []
    for group in range(4):
        chunk = p[group * 16:(group + 1) * 16]
        scale = e4(448 * max(chunk, default=0.0))
        weights.extend([e2(2688 * x / scale) * scale * (255 / 2688) if scale else 0.0
                        for x in chunk])
    return weights


def grouped_online(blocks, scores, routes, counts, valid, permutations, *,
                   fp4=False, global_scale=None, center=True):
    width = len(blocks[0][0])
    out, denominator, running, carried = [0.0] * width, 0.0, -3e38, -3e38
    for block in routes[:counts]:
        reconstructed, _, _ = grouped_values(
            blocks[block], valid[block], permutations[block],
            fp4=fp4, global_scale=global_scale, center=center)
        ordered_scores = [scores[block][source] for source in permutations[block]]
        maximum = max(running - 20, max(ordered_scores[:valid[block]]))
        alpha = math.exp2(carried - maximum)
        weights = probability_weights(ordered_scores, maximum, valid[block], fp4=fp4)
        for d in range(width):
            out[d] = alpha * out[d] + sum(weights[i] * reconstructed[i][d] for i in range(64))
        denominator = alpha * denominator + sum(weights)
        carried, running = maximum, max(running, maximum)
    return [x / max(denominator, 1e-30) for x in out], denominator
