"""Request-scoped, independently switchable memory experiments."""
import weakref
from collections.abc import Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

FLAGS = ('release_fc1_early', 'release_vsa_staging', 'rgb_inplace_clamp',
         'retain_d2h_source', 'weak_layout_registry', 'strided_decode_pixels',
         'release_decode_qkv', 'release_decode_attn', 'trim_decode_tail',
         'share_timestep_silu', 'cache_inference_rope', 'cache_text_tag_runs',
         'cache_reference_rows', 'release_dit_attention_input',
         'stream_without_canvas', 'vsa_zero_pad_gather', 'pinned_transfer_pool',
         'first_hit_counters', 'staging_without_clone', 'temporal_padding_staging',
         'persistent_decoder_canvas', 'profile_modulation', 'fuse_modulation_segments',
         'cache_fixed_adaln', 'phase_resident_video_vae', 'fuse_modulation_kernel',
         'rounded_modulation_scale_shift')
_state: ContextVar[dict[str, Any] | None] = ContextVar('fasth3_memory_features', default=None)


@contextmanager
def feature_scope(flags=None, *, memory_diagnostic=False, trace_metrics=False):
    """Bind validated request-scoped memory/inference feature flags."""
    if flags is None:
        flags = {}
    if not isinstance(flags, Mapping):
        raise TypeError("memory feature flags must be a mapping")
    unknown = set(flags) - set(FLAGS)
    if unknown:
        raise ValueError(f"unknown memory feature flags: {sorted(unknown)}")
    if any(type(value) is not bool for value in flags.values()):
        raise TypeError("memory feature flags must be booleans")
    resolved = {name: bool(flags.get(name, False)) for name in FLAGS}
    if resolved["fuse_modulation_kernel"]:
        raise ValueError("fuse_modulation_kernel is a killed experiment and remains unavailable")
    if resolved["rounded_modulation_scale_shift"]:
        raise ValueError("rounded_modulation_scale_shift changes DMAD transformer math and requires a separate model-quality arm")
    state: dict[str, Any] = {
        "flags": resolved,
        "calls": {},
        "memory_diagnostic": bool(memory_diagnostic),
        "trace_metrics": bool(trace_metrics),
        "mechanism_metrics": {},
    }
    token = _state.set(state)
    try:
        yield state
    finally:
        _state.reset(token)


def enabled(name):
    state = _state.get()
    return bool(state and state['flags'].get(name))


def hit(name):
    state = _state.get()
    if state is not None:
        if state['flags'].get('first_hit_counters'):
            state['calls']['first_hit_counters'] = 1
            if name in state['calls']:
                return
        state['calls'][name] = state['calls'].get(name, 0) + 1
        memory_boundary(name + ':after')


def metric(name, value):
    """Accumulate a bounded request-scoped mechanism metric."""
    state = _state.get()
    if state is None or type(value) not in (int, float):
        return
    metrics = state.setdefault('mechanism_metrics', {})
    entry = metrics.setdefault(name, {'calls': 0, 'sum': 0})
    entry['calls'] += 1
    entry['sum'] += value


def memory_boundary(name):
    """Unsynchronized allocator snapshot; diagnostic only, bounded per request."""
    state = _state.get()
    if state is None or not state.get('memory_diagnostic'):
        return
    import torch
    snapshots = state.setdefault('memory_boundaries', {})
    # First occurrence per boundary keeps logs compact and avoids hot-loop queries.
    if name in snapshots or len(snapshots) >= 64 or not torch.cuda.is_available():
        return
    snapshots[name] = {
        'allocated_bytes': torch.cuda.memory_allocated(),
        'reserved_bytes': torch.cuda.memory_reserved(),
        'peak_allocated_bytes': torch.cuda.max_memory_allocated(),
        'synchronized': False,
    }


def annotate(report):
    state = _state.get()
    if state is None:
        return report
    if state.get('trace_metrics'):
        merged = {r['report_path']:r for r in report.get('inference_metrics', [])}
        merged.update({r['report_path']:r for r in state.get('metric_reports', [])})
        report['inference_metrics'] = list(merged.values())
        report['diagnostic_only'] = True
        report['untraced_forwards'] = state.get('untraced_forwards', 0)
    report['run_knobs'] = dict(report.get('run_knobs') or {}, **state['flags'])
    counts = dict(report.get('memory_feature_calls') or {})
    # Each phase's state starts fresh. Use the incoming report as the base;
    # repeated serialization within a phase must not add the same calls twice.
    for flag, count in state['calls'].items():
        counts[flag] = max(counts.get(flag, 0), count)
    report['memory_feature_calls'] = counts
    if state.get('mechanism_metrics'):
        report['mechanism_metrics'] = dict(state['mechanism_metrics'])
    report['memory_counter_mode'] = ('first_hit' if state['flags'].get('first_hit_counters') else 'count')
    if state.get('memory_diagnostic'):
        report['memory_boundaries'] = dict(report.get('memory_boundaries') or {}, **state.get('memory_boundaries', {}))
        report['memory_diagnostic'] = True
    return report


def register_layout(registry, layout, video, audio):
    key = id(layout.position_ids)
    if not enabled('weak_layout_registry'):
        registry[key] = (layout, video, audio)
        return
    def expired(ref):
        entry = registry.get(key)
        if entry is not None and entry[0] is ref:
            registry.pop(key, None)
    try:
        ref = weakref.ref(layout, expired)
    except TypeError:
        # Unsupported layouts retain the original correctness behavior.
        registry[key] = (layout, video, audio)
        return
    registry[key] = (ref, video, audio)
    hit('weak_layout_registry')


def resolve_layout(entry):
    if entry is None:
        return None
    layout, video, audio = entry
    if isinstance(layout, weakref.ReferenceType):
        layout = layout()
    return None if layout is None else (layout, video, audio)
