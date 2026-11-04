"""Optional sampled driver memory evidence, outside timed promotion runs.

Driver usage includes context/native allocations as well as PyTorch reservations;
never add those overlapping quantities. A sampled peak can miss shorter spikes.
"""
import threading
from contextlib import contextmanager


@contextmanager
def memory_evidence(enabled=False, interval=0.05):
    if not enabled:
        yield None
        return
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("device memory evidence requires CUDA")
    device = torch.cuda.current_device()
    stop = threading.Event()
    report = {"schema": "fasth3-memory/1", "samples": 0, "interval_seconds": interval,
              "peak_device_used_bytes_sampled": 0, "peak_reserved_bytes_sampled": 0,
              "peak_allocated_bytes_sampled": 0, "errors": [],
              "scope": "whole isolated device; sampled peak is a lower bound"}

    def sample():
        try:
            free, total = torch.cuda.mem_get_info(device)
            values = {"device_used_bytes": total - free,
                      "reserved_bytes": torch.cuda.memory_reserved(device),
                      "allocated_bytes": torch.cuda.memory_allocated(device)}
            if report["samples"] == 0:
                report["begin"] = values
            report["end"] = values
            report["samples"] += 1
            for name, value in values.items():
                key = f"peak_{name}_sampled"
                report[key] = max(report[key], value)
        except (RuntimeError, ValueError) as error:
            if not report["errors"]:
                report["errors"].append(str(error))

    def poll():
        while not stop.wait(interval):
            sample()

    sample()
    thread = threading.Thread(target=poll, daemon=True, name="fasth3-memory-sampler")
    thread.start()
    try:
        yield report
    finally:
        stop.set()
        thread.join()
        sample()
