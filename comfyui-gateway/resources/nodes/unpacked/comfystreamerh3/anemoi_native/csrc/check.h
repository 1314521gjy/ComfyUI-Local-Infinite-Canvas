#pragma once
#include <torch/extension.h>
#include <ATen/cuda/CUDAContext.h>
#include <c10/cuda/CUDAGuard.h>
#include <c10/cuda/CUDAException.h>
#include <cmath>

inline void check_tensor(const torch::Tensor& t, const torch::Tensor& ref,
                         at::ScalarType dtype, at::IntArrayRef shape) {
  TORCH_CHECK(t.is_cuda() && t.device() == ref.device(), "CUDA device mismatch");
  TORCH_CHECK(t.is_contiguous() && t.scalar_type() == dtype && t.sizes() == shape,
              "native Anemoi tensor dtype/layout/shape mismatch");
}

inline void check_routes(torch::Tensor ids, torch::Tensor counts,
                         torch::Tensor valid, int64_t b, int64_t h,
                         int64_t qb, int64_t kb, bool trusted=false) {
  check_tensor(ids, ids, at::kInt, {b,h,qb,kb});
  check_tensor(counts, ids, at::kInt, {b,h,qb});
  check_tensor(valid, ids, at::kInt, {b,kb});
  if (trusted) return;  // Kitchen's producer owns data validity; kernel checks bounds.
  TORCH_CHECK(((counts >= 0) & (counts <= kb)).all().item<bool>(), "invalid route counts");
  TORCH_CHECK(((valid >= 0) & (valid <= 64)).all().item<bool>(), "invalid valid lengths");
  auto active = torch::arange(kb, counts.options()).view({1,1,1,kb}) < counts.unsqueeze(-1);
  auto safe = torch::where(active, ids, torch::zeros_like(ids));
  TORCH_CHECK(((safe >= 0) & (safe < kb)).all().item<bool>(), "invalid active route ID");
  auto selected_valid = valid.gather(1, safe.reshape({b,-1}).to(at::kLong)).reshape_as(ids);
  TORCH_CHECK((~active | (selected_valid > 0)).all().item<bool>(),
              "active route references an empty key block; remove it from the route");
}

inline void check_sm120(const torch::Tensor& tensor) {
  auto prop = at::cuda::getDeviceProperties(tensor.get_device());
  TORCH_CHECK(prop->major == 12 && prop->minor == 0, "requires SM120");
}
