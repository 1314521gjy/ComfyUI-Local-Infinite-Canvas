"""Opt-in measurement artifacts. No optimization or promotion decisions."""
import json
import shutil
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import torch


def allocator_snapshot():
    if not torch.cuda.is_available():
        return {'available': False, 'reason': 'CUDA unavailable'}
    stats = torch.cuda.memory_stats()
    return {'available': True,
        'allocated_bytes': torch.cuda.memory_allocated(),
        'reserved_bytes': torch.cuda.memory_reserved(),
        'peak_bytes_cumulative': torch.cuda.max_memory_allocated(),
        'active_allocations': stats.get('active.all.current'),
        'allocation_requests_cumulative': stats.get('allocation.all.allocated'),
        'allocation_retries_cumulative': stats.get('num_alloc_retries'),
        'ooms_cumulative': stats.get('num_ooms')}


def operation_rows(profiler, limit=80):
    rows = []
    for e in profiler.key_averages(group_by_input_shape=True):
        rows.append({'operation': e.key, 'input_shapes': e.input_shapes,
            'calls': e.count, 'self_cpu_us': e.self_cpu_time_total,
            'self_device_us': getattr(e, 'self_device_time_total', None),
            'self_cpu_memory_bytes': getattr(e, 'self_cpu_memory_usage', None),
            'self_device_memory_bytes': getattr(e, 'self_device_memory_usage', None)})
    rows.sort(key=lambda r: r['self_device_us'] or r['self_cpu_us'], reverse=True)
    return {'rows': rows[:limit], 'total_groups': len(rows), 'truncated': len(rows)>limit,
            'note': 'Memory columns are net event attribution, not peak live memory; CPU calls are not GPU launch counts.'}


def boundary_error(reference, actual):
    """Compare a captured intermediate tensor without accepting nonfinite data."""
    if reference.shape != actual.shape:
        return {'shape_equal':False, 'dtype_equal': reference.dtype == actual.dtype,
                'stride_equal': False, 'bit_exact':False}
    a,b=reference.detach().float(),actual.detach().to(reference.device).float()
    finite=bool(torch.isfinite(a).all() and torch.isfinite(b).all())
    if not finite:
        return {'shape_equal':True, 'dtype_equal': reference.dtype == actual.dtype,
                'stride_equal': reference.stride() == actual.stride(),
                'finite':False,'bit_exact':False}
    diff=(a-b).abs()
    dtype_equal = reference.dtype == actual.dtype
    stride_equal = reference.stride() == actual.stride()
    return {'shape_equal':True, 'dtype_equal':dtype_equal, 'stride_equal':stride_equal,
        'finite':True,'bit_exact':bool(dtype_equal and stride_equal and torch.equal(reference,actual.to(reference.device))),
        'max_abs':float(diff.max()) if diff.numel() else 0.,
        'mean_abs':float(diff.mean()) if diff.numel() else 0.,
        'mse':float(diff.square().mean()) if diff.numel() else 0.}


@contextmanager
def trace(root, label, *, memory=False):
    """One bounded phase/forward; export timeline before dropping profiler refs."""
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    prefix = root/(label+'-'+uuid.uuid4().hex)
    result = {'schema': 'fasth3-inference-metrics/1', 'phase':label,
        'report_path':str(prefix)+'.json', 'timeline':str(prefix)+'.trace.json',
        'diagnostic_only':True, 'before':allocator_snapshot(),
        'hardware_counters': {'measured':False, 'nsys_path':shutil.which('nsys'),
            'ncu_path':shutil.which('ncu'),
            'reason':'SM utilization, bandwidth, occupancy and stalls require a separate hardware-counter profile.'}}
    result['metric_contract'] = {
        'instrumented_wall_ms': 'inclusive elapsed wall time for this trace context',
        'self_cpu_us': 'CPU operator self time; not GPU launch time',
        'self_device_us': 'device operator self time; overlapping streams may overcount elapsed time',
        'self_device_memory_bytes': 'net profiler attribution; not allocation traffic or peak live memory',
        'allocator_snapshot': 'process allocator counters; peaks and request counts are cumulative unless reset externally',
        'device_events_by_name': 'traced CUDA events; duration sums can overlap across streams',
    }
    activities=[torch.profiler.ProfilerActivity.CPU]
    if torch.cuda.is_available(): activities.append(torch.profiler.ProfilerActivity.CUDA)
    profiler=torch.profiler.profile(activities=activities,record_shapes=True,
        profile_memory=memory,with_stack=memory)
    started=time.perf_counter()
    try:
        with profiler:
            yield result
    except BaseException as exc:
        result['failure']=type(exc).__name__+': '+str(exc)
        raise
    finally:
        result['instrumented_wall_ms']=(time.perf_counter()-started)*1000
        result['after']=allocator_snapshot()
        try:
            path=str(prefix)+'.trace.json'
            profiler.export_chrome_trace(path)
            result['timeline']=path
            result['operations']=operation_rows(profiler)
            events: dict[str, dict[str, int | float]] = {}
            for event in profiler.events():
                if 'CUDA' not in str(event.device_type):
                    continue
                row=events.setdefault(event.name, {'count':0, 'device_time_us_sum':0.})
                row['count']+=1
                row['device_time_us_sum']+=event.time_range.elapsed_us()
            result['device_events_by_name']=events
            result['device_events_note']='Actual traced CUDA events, including copies; summed durations can overlap across streams. Timeline contains correlations and gaps.'
            if memory and torch.cuda.is_available():
                # Export allocator block locations and any available allocation
                # stacks. These do not identify Python retaining references.
                snapshot=str(prefix)+'.allocator.json'
                Path(snapshot).write_text(json.dumps(torch.cuda.memory_snapshot(),default=str))
                result['allocator_blocks']=snapshot
                result['retaining_python_owners']='unresolved; allocator stacks identify allocations, not referrers'
            result['report_path']=str(prefix)+'.json'
            Path(result['report_path']).write_text(json.dumps(result,indent=2,default=str))
        except Exception as exc:  # noqa: BLE001 - metric export must not mask the run
            result['export_error']=str(exc)


@contextmanager
def sampling_traces(patcher, state):
    """Trace diffusion forwards after model preparation, not prepare_sampling."""
    if not state or not state.get('trace_metrics'):
        yield
        return
    model=getattr(getattr(patcher,'model',None),'diffusion_model',None)
    if model is None or not callable(getattr(model,'_forward',None)):
        raise ValueError('sampling trace requires diffusion_model._forward')
    original=model._forward
    had='_forward' in model.__dict__
    saved=model.__dict__.get('_forward')
    reports=state.setdefault('metric_reports',[])
    calls=0
    def wrapped(*args,**kwargs):
        nonlocal calls
        index=calls; calls+=1
        if index>=4:
            state['untraced_forwards']=state.get('untraced_forwards',0)+1
            return original(*args,**kwargs)
        with trace(state['metrics_root'],f'sampling-forward-{index}',memory=state.get('trace_memory',False)) as metrics:
            reports.append(metrics)
            return original(*args,**kwargs)
    model._forward=wrapped
    try:
        yield
    finally:
        if had: model._forward=saved
        else: model.__dict__.pop('_forward',None)
