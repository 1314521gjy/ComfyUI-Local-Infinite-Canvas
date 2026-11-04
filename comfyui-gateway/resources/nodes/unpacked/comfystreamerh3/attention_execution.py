"""Request-local evidence for attention dispatch, separate from loader intent."""
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

_execution: ContextVar[dict[str, Any] | None] = ContextVar('fasth3_attention_execution', default=None)
_states: ContextVar[dict | None] = ContextVar('fasth3_native_states', default=None)
_evaluation: ContextVar[int | None] = ContextVar('fasth3_evaluation', default=None)


@contextmanager
def capture_attention_execution():
    report = {"calls": 0, "backends": {}, "options": {}, "producer_chunks": 0}
    token = _execution.set(report)
    states: dict[Any, Any] = {}
    states_token = _states.set(states)
    evaluation_token = _evaluation.set(0)
    try:
        yield report
    finally:
        states.clear()
        _states.reset(states_token)
        _evaluation.reset(evaluation_token)
        _execution.reset(token)


def native_layer_state(key):
    states = _states.get()
    # Calls outside the request-aware sampler get no cross-call state reuse.
    return {} if states is None else states.setdefault(key, {})


def current_evaluation():
    return _evaluation.get()


def set_evaluation(index):
    if _states.get() is not None:
        _evaluation.set(index)


def record_attention(backend, option, diagnostics=None):
    report = _execution.get()
    if report is not None:
        report["calls"] += 1
        for name, value in (("backends", backend), ("options", option)):
            report[name][value] = report[name].get(value, 0) + 1
        if diagnostics:
            omega = diagnostics.get("omega_config")
            if omega is not None:
                identity = omega.get("identity")
                previous = report.get("omega_identity")
                if previous is None:
                    report["omega_identity"] = identity
                elif previous != identity:
                    identities = report.setdefault("omega_identities", [previous])
                    if identity not in identities:
                        identities.append(identity)
                report["omega_config"] = omega
            details = report.setdefault("native_details", {})
            entry = details.setdefault(backend, {"calls": 0})
            entry["calls"] += 1
            current = {key: diagnostics[key] for key in (
                "executed_backend", "policy", "groups", "token_aug", "calibration_measured",
                "direct_prefix_output_requested", "output_savings", "workspace_accounting",
                "omega_config",
            ) if key in diagnostics}
            # Preserve the first value and retain every later change.  Native
            # diagnostics are cumulative request evidence; a last-layer
            # overwrite hides whether a flag ran consistently across calls.
            observed = entry.setdefault("observed_values", {})
            for key, value in current.items():
                if key not in entry:
                    entry[key] = value
                    continue
                if entry[key] != value:
                    values = observed.setdefault(key, [entry[key]])
                    if value not in values:
                        values.append(value)
            workspace = diagnostics.get("workspace_bytes", 0)
            report["max_workspace_bytes"] = max(report.get("max_workspace_bytes", 0), workspace)
            counters = report.setdefault("native_stage_calls", {})
            for name, count in (diagnostics.get("counters") or
                                diagnostics.get("kitchen_counters") or {}).items():
                counters[name] = counters.get(name, 0) + count
            device = {key: diagnostics[key] for key in (
                "phase_calls", "phase_pairs", "nvfp4_clipping_counts_q_k_v", "vc_nvfp4_clipping_counts",
            ) if key in diagnostics}
            if device:
                report.setdefault("_device_evidence", []).append(device)
            stage_timings = diagnostics.get("stage_timings_ms")
            if isinstance(stage_timings, dict):
                totals = report.setdefault("stage_timings_ms", {})
                for name, value in stage_timings.items():
                    totals[name] = totals.get(name, 0.0) + float(value)


def finalize_attention_execution(report):
    """Read tiny device counters after sampling synchronization, never per layer."""
    def host(value):
        if isinstance(value, dict):
            return {key: host(item) for key, item in value.items()}
        return value.detach().cpu().tolist() if hasattr(value, "detach") else value

    evidence = report.pop("_device_evidence", [])
    for entry in evidence:
        data = host(entry)
        for key in ("phase_calls", "phase_pairs"):
            if isinstance(data.get(key), dict):
                total = report.setdefault(key, {})
                for phase, value in data[key].items():
                    total[phase] = total.get(phase, 0) + value
        clipped = data.get("nvfp4_clipping_counts_q_k_v")
        if clipped is not None:
            totals = report.setdefault("nvfp4_clipping_counts_q_k_v", [0, 0, 0])
            for i, count in enumerate(clipped):
                totals[i] += count
        vc_clipped = data.get("vc_nvfp4_clipping_counts")
        if vc_clipped is not None:
            totals = report.setdefault("vc_nvfp4_clipping_counts", [0, 0])
            for i, count in enumerate(vc_clipped):
                totals[i] += count
    report["calibration_clipped"] = (any(report.get("nvfp4_clipping_counts_q_k_v", []))
                                     or any(report.get("vc_nvfp4_clipping_counts", [])))
    return report


def record_producer_chunk():
    report = _execution.get()
    if report is not None:
        report["producer_chunks"] += 1
