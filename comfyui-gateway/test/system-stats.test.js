import assert from "node:assert/strict";
import test from "node:test";

import { mergeGpuSnapshot } from "../src/system-stats.js";

const gpu = [{ index: 0, name: "NVIDIA GeForce RTX 4080 SUPER", memoryUsedMb: 18900, memoryTotalMb: 32768, utilization: 99, temperature: 78 }];

test("keeps the last GPU reading when nvidia-smi fails under load", () => {
  const first = mergeGpuSnapshot(null, { gpu, gpuError: null });
  assert.equal(first.gpuStale, false);
  assert.deepEqual(first.gpu, gpu);

  const next = mergeGpuSnapshot(gpu, { gpu: [], gpuError: "timeout" });
  assert.equal(next.gpuStale, true);
  assert.deepEqual(next.gpu, gpu);
  assert.equal(next.gpuError, "timeout");

  const recovered = mergeGpuSnapshot(gpu, { gpu, gpuError: null });
  assert.equal(recovered.gpuStale, false);
});

test("reports an empty GPU list when nothing has ever been read", () => {
  const empty = mergeGpuSnapshot(null, { gpu: [], gpuError: "nvidia-smi not found" });
  assert.equal(empty.gpuStale, false);
  assert.deepEqual(empty.gpu, []);
  assert.match(empty.gpuError, /nvidia-smi/);
});
