"""CPU oracle for route compaction; no production CUDA implementation exists.

No sorting, deduplication, route selection or route-to-fine fusion is performed.
The former serial CUDA scan was deliberately removed: it was not a safe speed
path. Production remains fail-closed until a parallel device scan is added.
"""

COMPACTION_PRODUCTION_ENABLED = False


def require_production_compaction():
    raise RuntimeError(
        "stable route compaction is oracle-only; a parallel device scan is required"
    )


def compact_routes(ids, counts):
    if len(ids) != len(counts):
        raise ValueError("one count is required per route row")
    offsets, packed = [0], []
    for row, count in zip(ids, counts):
        if type(count) is not int or not 0 <= count <= len(row):
            raise ValueError("route count exceeds capacity")
        live = row[:count]
        if any(type(value) is not int or value < 0 for value in live):
            raise ValueError("live routes must be nonnegative integers")
        packed.extend(live)
        offsets.append(len(packed))
    return offsets, packed


def compaction_diagnostics(ids, counts):
    """Return exact CPU-oracle work counters without implying GPU execution."""
    offsets, packed = compact_routes(ids, counts)
    return {
        "production_enabled": COMPACTION_PRODUCTION_ENABLED,
        "parallel_scan": False,
        "oracle_rows": len(counts),
        "oracle_live_ids": len(packed),
        "oracle_capacity_ids": sum(len(row) for row in ids),
        "cuda_launches": 0,
        "host_syncs": 0,
        "host_copies": 0,
        "speed_claim": False,
        "offsets_final": offsets[-1],
    }


def emit_routes(scores, thresholds, *, sink_keys=(0, 0), sink_queries=(0, 0)):
    """Selection/metadata oracle on already computed log2 routing scores.

    Matches native >= ties, forced +/-1 neighbors, protected rows and sink-first
    order. Does not model floating point score construction or coarse arithmetic.
    """
    rows = len(scores)
    if rows != len(thresholds) or any(len(row) != rows for row in scores):
        raise ValueError("square routing scores and one threshold per row required")
    for start, stop in (sink_keys, sink_queries):
        if not 0 <= start <= stop <= rows:
            raise ValueError("protected interval outside geometry")
    ids, counts = [], []
    for query, row in enumerate(scores):
        chosen = list(range(*sink_keys))
        protected_query = sink_queries[0] <= query < sink_queries[1]
        chosen.extend(
            key
            for key, score in enumerate(row)
            if not sink_keys[0] <= key < sink_keys[1]
            and (protected_query or score >= thresholds[query] or abs(query - key) <= 1)
        )
        counts.append(len(chosen))
        ids.append(chosen + [-1] * (rows - len(chosen)))
    return ids, counts
