/*
 * Copyright (c) 2025 by SpargeAttn team.
 * Copyright (c) 2026 mixed-attention project contributors.
 * Copyright 2026 Anemoi Project Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Project modification: standalone Torch NVFP4 control over Anemoi
 * 270ddf8c3f0a43be47cf586873e7758bc76b822d's SM120 Q64 launcher. The
 * retained vendor implementation attributes SpargeAttention ae5b629ebb41e41f86b3ea2ab5a3283f13ac151a.
 */
#include "check.h"
#include <cstdint>
#include <limits>
#include <tuple>
#include <vector>

// NVFP4 is an independent control: no centered/block-value INT8 variant.
#ifdef MPA_BLOCK_VALUE_SCALE
#undef MPA_BLOCK_VALUE_SCALE
#endif
#define MPA_CTA_Q 64
#define MPA_WARP_Q 16
#define MPA_K64_BLOCK_MODE 1
#define MPA_LOW4_NVFP4 1
#define MPA_MIDDLE_INT8 0
#define MPA_MIDDLE_MXFP8 0
#define MPA_ATTENTION_KERNEL_ENTRY fasth3_anemoi_nvfp4_kernel
#define MPA_ATTENTION_LAUNCH_ENTRY fasth3_anemoi_nvfp4_launch
#include "../vendor/csrc/attention/cuda/sm120/q64_attention.cuh"

std::tuple<torch::Tensor, torch::Tensor> nvfp4_attention(
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor ids, torch::Tensor counts, torch::Tensor valid,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, double scale, bool trusted) {
  TORCH_CHECK(q4.defined() && k4.defined() && q4.dim() == 4 && k4.dim() == 4,
              "NVFP4 Q/K must be [B,H,S,64]");
  const int64_t b = q4.size(0), h = q4.size(1);
  const int64_t nq = q4.size(2), nk = k4.size(2);
  TORCH_CHECK(b > 0 && h > 0 && nq > 0 && nk > 0 && nq % 64 == 0 && nk % 64 == 0,
              "positive Q64/K64 physical storage required");
  check_tensor(q4, q4, at::kByte, {b,h,nq,64});
  check_tensor(k4, q4, at::kByte, {b,h,nk,64});
  check_tensor(v4, q4, at::kByte, {b,h,128,nk/2});
  check_tensor(qs, q4, at::kByte, {b,h,nq,8});
  check_tensor(ks, q4, at::kByte, {b,h,nk,8});
  check_tensor(vs, q4, at::kByte, {b,h,nk/64,128,4});
  check_tensor(gq, q4, at::kFloat, {1});
  check_tensor(gk, q4, at::kFloat, {1});
  check_tensor(gv, q4, at::kFloat, {1});
  TORCH_CHECK(ids.device() == q4.device(), "route device mismatch");
  const float fscale = static_cast<float>(scale);
  TORCH_CHECK(std::isfinite(scale) && std::isfinite(fscale) && fscale > 0.0f,
              "softmax scale must be finite and positive in FP32");
  // The donor uses uint32_t address arithmetic, and grid.y/z are 16-bit.
  TORCH_CHECK(b <= 65535 && h <= 65535, "NVFP4 CUDA grid capacity exceeded");
  const int64_t max_index = std::numeric_limits<uint32_t>::max();
  TORCH_CHECK(nq <= max_index / b / h / 128 && nk <= max_index / b / h / 128,
              "NVFP4 operand exceeds donor 32-bit indexing capacity");
  TORCH_CHECK(ids.numel() <= max_index, "NVFP4 routes exceed 32-bit indexing capacity");
  const c10::cuda::CUDAGuard guard(q4.device());
  check_sm120(q4);
  if (!trusted) for (const auto& global : {gq, gk, gv}) {
    const float value = global.item<float>();
    TORCH_CHECK(std::isfinite(value) && value > 0.0f,
                "NVFP4 global scales must be finite and positive");
  }
  check_routes(ids, counts, valid, b, h, nq/64, nk/64, trusted);
  auto out = torch::zeros({b,h,nq,128}, q4.options().dtype(at::kHalf));
  auto lse = torch::full({b,h,nq}, -INFINITY, q4.options().dtype(at::kFloat));
  const auto stream = at::cuda::getCurrentCUDAStream(q4.get_device());
  fasth3_anemoi_nvfp4_launch<128,true,false,false>(
      reinterpret_cast<int8_t*>(q4.data_ptr<uint8_t>()),
      reinterpret_cast<int8_t*>(k4.data_ptr<uint8_t>()),
      reinterpret_cast<__nv_fp8_e4m3*>(v4.data_ptr<uint8_t>()),
      nullptr, nullptr, nullptr, nullptr,
      reinterpret_cast<half*>(out.data_ptr<at::Half>()),
      ids.data_ptr<int32_t>(), counts.data_ptr<int32_t>(), nullptr, nullptr,
      qs.data_ptr<uint8_t>(), ks.data_ptr<uint8_t>(), vs.data_ptr<uint8_t>(),
      gq.data_ptr<float>(), gk.data_ptr<float>(), gv.data_ptr<float>(),
      valid.data_ptr<int32_t>(), lse.data_ptr<float>(), 0,
      b, nq, nk, nk, h, h, fscale, stream);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  return {out, lse};
}

// Same metadata ABI as int8_resources: registers, static shared bytes,
// dynamic shared bytes, resident CTAs/SM on the caller's current device.
std::vector<int64_t> nvfp4_resources() {
  constexpr int bytes = (64 + 2 * 64) * 128 + 64 * (128 / 32) + 128 * 2;
  auto kernel = mpa::attention::fasth3_anemoi_nvfp4_kernel<128,true,false,false>;
  cudaFuncAttributes attributes{};
  C10_CUDA_CHECK(cudaFuncGetAttributes(&attributes, kernel));
  int active = 0;
  C10_CUDA_CHECK(cudaOccupancyMaxActiveBlocksPerMultiprocessor(
      &active, kernel, 128, bytes));
  return {attributes.numRegs, static_cast<int64_t>(attributes.sharedSizeBytes), bytes, active};
}
