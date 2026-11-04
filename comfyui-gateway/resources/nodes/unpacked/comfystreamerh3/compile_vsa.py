"""Compiler-visible tensor launch boundaries for pinned Kitchen 0.2.34 VSA.

The chunk traversal must be Dynamo-disabled *non-recursively* by the caller.
Only these opaque launches touch streams/DLPack; projection callbacks stay
eligible for compilation. Registration is lazy and does not import Kitchen.
"""

from types import SimpleNamespace
from uuid import uuid4

_LAUNCH_CACHE: dict[tuple[int, int], tuple[object, object, SimpleNamespace]] = {}


def _register_launches(kitchen_cuda, torch):
    """Register mutation-aware launches once per loaded Kitchen/Torch pair."""
    key = (id(kitchen_cuda), id(torch))
    cached = _LAUNCH_CACHE.get(key)
    if cached is not None:
        return cached[2]
    # A reload or test import can create another module-level registration
    # cache while PyTorch keeps earlier operators alive in its dispatcher.
    namespace = f"fasth3_vsa_{uuid4().hex}"
    wrap = kitchen_cuda._wrap_for_dlpack

    def begin_impl(ws, t, h, token_aug):
        kitchen_cuda._C.sol_producer_begin(
            wrap(ws), 1, t, h, torch.cuda.current_stream(ws.device).cuda_stream,
            token_aug=token_aug,
        )

    begin = torch.library.custom_op(
        f"{namespace}::producer_begin", begin_impl, mutates_args=("ws",),
        schema="(Tensor(a!) ws, int t, int h, int token_aug) -> ()",
    )

    @begin.register_fake
    def begin_fake(ws, t, h, token_aug):
        _check_workspace(ws, torch)

    def chunk_impl(ws, chunk, fab, qw, kw, km, vsc, rope_eps, rot, t0, t, h,
                   block_len, token_aug):
        _check_statistics(km, vsc, h, torch)
        kitchen_cuda._C.sol_producer_chunk(
            wrap(ws), wrap(chunk), wrap(fab), wrap(qw), wrap(kw), wrap(km), wrap(vsc),
            rope_eps, rot, t0, chunk.shape[-2], 1, t, h,
            torch.cuda.current_stream(ws.device).cuda_stream,
            block_len=None if block_len is None else wrap(block_len), token_aug=token_aug,
        )

    chunk = torch.library.custom_op(
        f"{namespace}::producer_chunk", chunk_impl, mutates_args=("ws",),
        schema="(Tensor(a!) ws, Tensor chunk, Tensor fab, Tensor qw, Tensor kw, "
        "Tensor km, Tensor vsc, float rope_eps, int rot, int t0, int t, int h, "
        "Tensor? block_len, int token_aug) -> ()",
    )

    @chunk.register_fake
    def chunk_fake(ws, chunk, fab, qw, kw, km, vsc, rope_eps, rot, t0, t, h,
                   block_len, token_aug):
        _check_workspace(ws, torch)
        if chunk.ndim != 2 or chunk.shape[-1] != 3 * h * 128:
            raise ValueError("VSA producer chunk must be [M, 3*H*128]")
        if chunk.dtype != torch.bfloat16 or chunk.device != ws.device:
            raise ValueError("VSA producer chunk must be bfloat16 on workspace device")
        if fab.shape != (t, rot, 2) or fab.dtype != torch.float32:
            raise ValueError("VSA packed rope must be [T, rot, 2] float32")
        if km.shape != (h, 128) or vsc.numel() != h * 128:
            raise ValueError("VSA statistics must contain H*128 values; kmean must be [H, 128]")

    def core_impl(ws, out, vscale, kmean_next, vamax, t, h, tau, scale,
                  sb0, sb1, sq0, sq1, threshold, block_len, tail, token_aug):
        kitchen_cuda._C.sol_attn_core(
            wrap(ws), wrap(out), wrap(vscale), wrap(kmean_next), wrap(vamax),
            1, t, h, tau, scale, sb0, sb1, sq0, sq1,
            torch.cuda.current_stream(ws.device).cuda_stream,
            threshold=None if threshold is None else wrap(threshold),
            block_len=None if block_len is None else wrap(block_len),
            tail=tail, token_aug=token_aug,
        )

    core = torch.library.custom_op(
        f"{namespace}::attn_core", core_impl,
        mutates_args=("ws", "out", "kmean_next", "vamax"),
        schema="(Tensor(a!) ws, Tensor(b!) out, Tensor vscale, Tensor(c!) kmean_next, "
        "Tensor(d!) vamax, int t, int h, float tau, float scale, int sb0, int sb1, "
        "int sq0, int sq1, Tensor? threshold, Tensor? block_len, bool tail, "
        "int token_aug) -> ()",
    )

    @core.register_fake
    def core_fake(ws, out, vscale, kmean_next, vamax, t, h, tau, scale,
                  sb0, sb1, sq0, sq1, threshold, block_len, tail, token_aug):
        _check_workspace(ws, torch)
        if out.shape != (1, t, h, 128) or out.dtype != torch.bfloat16:
            raise ValueError("VSA output must be [1, T, H, 128] bfloat16")
        if vscale.numel() != h * 128 or vscale.dtype != torch.float32:
            raise ValueError("VSA vscale must contain H*128 float32 values")
        for stats in (kmean_next, vamax):
            if stats.shape != (h, 128) or stats.dtype != torch.float32:
                raise ValueError("VSA statistics must be [H, 128] float32")

    launches = SimpleNamespace(begin=begin, chunk=chunk, core=core)
    # Strong refs prevent object id reuse and keep registered closures valid.
    _LAUNCH_CACHE[key] = (kitchen_cuda, torch, launches)
    return launches


def _check_workspace(ws, torch):
    if ws.ndim != 1 or ws.dtype != torch.uint8:
        raise ValueError("VSA workspace must be a flat uint8 tensor")


def _check_statistics(kmean, vscale, h, torch):
    if (kmean.shape != (h, 128) or kmean.numel() != h * 128
            or kmean.dtype != torch.float32 or vscale.numel() != h * 128
            or vscale.dtype != torch.float32):
        raise RuntimeError(
            f"sol_attn_chunked: invalid statistics for H={h}, D=128: "
            f"kmean shape={tuple(kmean.shape)} dtype={kmean.dtype} numel={kmean.numel()} "
            f"stride={kmean.stride()} device={kmean.device}, "
            f"vscale shape={tuple(vscale.shape)} dtype={vscale.dtype} numel={vscale.numel()} "
            f"stride={vscale.stride()} device={vscale.device}"
        )


def compile_safe_sol_attn_chunked(kitchen_cuda, torch_module):
    """Return Kitchen 0.2.34's chunked algorithm with opaque tensor launches.

    No all-QKV buffer is introduced. Bootstrap needs a replayable iterable or
    a factory; a consumed one-shot generator cannot supply the second pass.
    The factory's ``_fasth3_vsa_launches`` exposes the registered ops for smoke
    tests without requiring a Kitchen CUDA extension.
    """
    torch = torch_module
    if kitchen_cuda._SOL_HD != 128 or kitchen_cuda._SOL_VSCALE_MARGIN != 1.1:
        raise RuntimeError("compile VSA adapter requires pinned Kitchen 0.2.34 constants")
    launches = _register_launches(kitchen_cuda, torch)

    def sol_attn_chunked(
        qkv_chunks, t: int, h: int, rope_freqs,
        qk_norm_weights, kmean=None, vscale=None, tau: float = 1.0,
        topk_ratio: float = 0.0, scale=None, sink_blocks=None, sink_q=None,
        rope_eps: float = 1e-6, tail: bool = True, block_len=None,
        coarse_gate=None, token_aug: int = 0,
    ):
        d = kitchen_cuda._SOL_HD
        rot = rope_freqs.shape[-3] * 2
        if rot % 8 or not 0 < rot <= d:
            raise ValueError(
                f"sol_attn_chunked: rot_dim must be a multiple of 8 in (0, {d}], got {rot}"
            )
        fab = kitchen_cuda._packed_rope_fab(rope_freqs, t, rot)
        dev = fab.device
        kitchen_cuda._check_sol_args(dev, sink_blocks, sink_q, topk_ratio)
        if scale is None:
            scale = d ** -0.5
        if block_len is not None:
            block_len = kitchen_cuda._check_block_len(block_len, t, dev)
        if coarse_gate is not None:
            coarse_gate = kitchen_cuda._check_coarse_gate(coarse_gate, (1, t, h, d), dev)
        lengths = kitchen_cuda._block_lengths(t, (t + 63) // 64, dev, block_len)
        qw, kw = (w.to(device=dev, dtype=torch.bfloat16).contiguous() for w in qk_norm_weights)
        factory = qkv_chunks if callable(qkv_chunks) else None
        if factory is None and (kmean is None or vscale is None):
            if iter(qkv_chunks) is qkv_chunks:
                raise ValueError("sol_attn_chunked: bootstrap requires a replayable chunk factory")
            factory = lambda: iter(qkv_chunks)
        # Planning inspects only integer metadata and stays outside Dynamo.
        p = kitchen_cuda._C.sol_attn_plan(1, t, h, token_aug=int(token_aug))
        ws = torch.empty(p["total"], dtype=torch.uint8, device=dev)
        width = 3 * h * d

        def produce(km, vsc):
            launches.begin(ws, t, h, int(token_aug))
            t0 = 0
            for chunk in (factory() if factory is not None else qkv_chunks):
                m = chunk.shape[-2]
                if t0 % 64 and m:
                    raise ValueError("sol_attn_chunked: chunk starts must be 64-aligned")
                if chunk.shape[-1] != width or chunk.dtype != torch.bfloat16 or chunk.device != dev:
                    raise ValueError(
                        f"sol_attn_chunked: chunks must be [M, {width}] bfloat16 on {dev}, "
                        f"got {tuple(chunk.shape)} {chunk.dtype} on {chunk.device}"
                    )
                launches.chunk(ws, chunk.contiguous(), fab, qw, kw, km, vsc,
                               float(rope_eps), rot, t0, t, h, block_len, int(token_aug))
                t0 += m
            if t0 != t:
                raise ValueError(f"sol_attn_chunked: chunks cover {t0} tokens, T={t}")

        # Control the streaming loop eagerly: functionalizing its mutation
        # operators in a compiled loop could clone the large workspace per
        # chunk. Explicitly compiled projection callbacks still execute under
        # this nonrecursive boundary.
        produce = torch.compiler.disable(produce, recursive=False)

        def vscale_of(vamax):
            return (vamax / 127.0 * kitchen_cuda._SOL_VSCALE_MARGIN).clamp_min(1e-8)

        def bootstrap_statistics():
            # Interpret the kernel-owned byte workspace eagerly. These dtype
            # views and reductions must retain stock buffer metadata; no QKV
            # callback or producer traversal occurs inside this boundary.
            mean = kitchen_cuda._ws_ksums(ws, p, h).sum(1) / lengths.sum()
            next_scale = vscale_of(
                ws[p["statsV"]:p["statsV"] + h * d * 4].view(torch.float32)
            )
            return mean, next_scale

        bootstrap_statistics = torch.compiler.disable(bootstrap_statistics, recursive=True)
        if kmean is None or vscale is None:
            produce(torch.zeros(h, d, device=dev), torch.ones(h, d, device=dev))
            kmean, vscale = bootstrap_statistics()
        kmean = kmean.to(device=dev, dtype=torch.float32).contiguous()
        vscale = vscale.to(device=dev, dtype=torch.float32).clamp_min(1e-8).contiguous()
        _check_statistics(kmean, vscale, h, torch)
        produce(kmean, vscale)
        sb, sq = kitchen_cuda._sink_pair(sink_blocks), kitchen_cuda._sink_pair(sink_q)
        threshold = (
            kitchen_cuda._topk_threshold_from_workspace(ws, p, h, topk_ratio, scale, lengths, sb)
            if topk_ratio else None
        )
        out = torch.empty(1, t, h, d, dtype=torch.bfloat16, device=dev)
        kmean_next = torch.empty(h, d, device=dev, dtype=torch.float32)
        vamax = torch.empty(h, d, device=dev, dtype=torch.float32)
        launches.core(ws, out, vscale, kmean_next, vamax, t, h, float(tau), float(scale),
                      sb[0], sb[1], sq[0], sq[1], threshold, block_len, bool(tail), int(token_aug))
        if coarse_gate is not None:
            # Pinned Kitchen imports this helper from eager.sol_attn: it is
            # pure PyTorch view/addcmul_ arithmetic, with no raw CUDA handles.
            kitchen_cuda.add_coarse_(
                out, kitchen_cuda.coarse_output(
                    *kitchen_cuda._ws_block_means(ws, p, h, lengths), scale
                ), coarse_gate,
            )
        return out, kmean_next, vscale_of(vamax)

    sol_attn_chunked._fasth3_vsa_launches = launches  # type: ignore[attr-defined]
    return sol_attn_chunked
