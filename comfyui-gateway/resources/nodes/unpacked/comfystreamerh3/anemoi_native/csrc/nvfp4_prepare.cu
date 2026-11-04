/*
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
 * Project modification: bounded, preallocated chunk adaptation of
 * Anemoi 270ddf8c3f0a43be47cf586873e7758bc76b822d,
 * csrc/attention/cuda/sm120/q128_microscaling_preparation.cu.
 * The donor localizes SageAttention3 d1a57a5 scaled_fp4_quant_permute.
 * Retains its K32 permutation, E4M3 microscale and E2M1 pair conversions.
 */
#include "check.h"
#include <c10/macros/Macros.h>
#include <cuda_bf16.h>
#include <cuda_fp16.h>
#include <cuda_fp4.h>
#include <cuda_fp8.h>
#include <array>
#include <cstdint>
#include <limits>

namespace {
// Involutive mapping, applied independently inside each natural K32 group.
__host__ __device__ constexpr int nv_k_row(int row) {
  const int local = row & 31;
  return row - local + (local / 8) * 2 + ((local % 8) / 2) * 8 + local % 2;
}

template <typename T>
__device__ __forceinline__ float narrowed(const T* data, int64_t index);
template <>
__device__ __forceinline__ float narrowed<half>(const half* data, int64_t index) {
  return __half2float(data[index]);
}
template <>
__device__ __forceinline__ float narrowed<nv_bfloat16>(
    const nv_bfloat16* data, int64_t index) {
  return __half2float(__float2half_rn(__bfloat162float(data[index])));
}

__device__ __forceinline__ float max8(float value) {
#pragma unroll
  for (int delta = 4; delta > 0; delta >>= 1) {
    value = fmaxf(value, __shfl_down_sync(0xffffffffU, value, delta, 8));
  }
  return __shfl_sync(0xffffffffU, value, 0, 8);
}

__device__ __forceinline__ uint8_t scale_bits(float amax, float global) {
  return __nv_cvt_float_to_fp8(
      __fdiv_rn(__fdiv_rn(amax, 6.0f), global), __NV_SATFINITE, __NV_E4M3);
}

__device__ __forceinline__ float decode_scale(uint8_t bits) {
  __nv_fp8_e4m3 value;
  value.__x = bits;
  return static_cast<float>(value);
}

__device__ __forceinline__ uint8_t encode_pair(float low, float high, float dequant) {
  if (dequant == 0.0f) return 0U;
  return __nv_cvt_float2_to_fp4x2(
      make_float2(__fdiv_rn(low, dequant), __fdiv_rn(high, dequant)),
      __NV_E2M1, cudaRoundNearest);
}

// Caller zeros Q/K/V statistics before a calibration window and reuses them
// across chunks. Reduce existing loads locally before merging device atomics.
struct NvObservation {
  unsigned long long clipped = 0;
  float amax = 0.0f;

  __device__ __forceinline__ void observe(float value, float limit) {
    CUDA_KERNEL_ASSERT(isfinite(value));
    if (!isfinite(value)) return;
    const float magnitude = fabsf(value);
    clipped += magnitude > limit;
    amax = fmaxf(amax, magnitude);
  }

  __device__ __forceinline__ void merge(
      int64_t* clipping_counts, float* observed_amax, int operand) const {
    // All 32 lanes participate, including lanes with no live observations.
    // Each warp contributes at most one count and one maximum atomic.
    unsigned long long warp_clipped = clipped;
    float warp_amax = amax;
#pragma unroll
    for (int delta = 16; delta > 0; delta >>= 1) {
      warp_clipped += __shfl_down_sync(0xffffffffU, warp_clipped, delta);
      warp_amax = fmaxf(warp_amax, __shfl_down_sync(0xffffffffU, warp_amax, delta));
    }
    if ((threadIdx.x & 31) == 0) {
      if (warp_clipped != 0) {
        atomicAdd(reinterpret_cast<unsigned long long*>(clipping_counts + operand), warp_clipped);
      }
      // Nonnegative IEEE float bits have the same ordering as their values.
      if (warp_amax > 0.0f) {
        atomicMax(reinterpret_cast<unsigned int*>(observed_amax + operand),
                  __float_as_uint(warp_amax));
      }
    }
  }
};

template <typename T>
__global__ void nv_prepare_qk(
    const T* q, const T* k, const int32_t* valid,
    uint8_t* q4, uint8_t* k4, uint8_t* qs, uint8_t* ks,
    const float* gq, const float* gk, int64_t heads,
    int64_t chunks, int64_t blocks, int64_t offset,
    int64_t* clipping_counts, float* observed_amax, int64_t input_rows) {
  const int row = blockIdx.x % 64;
  const int64_t task = blockIdx.x / 64;
  const int64_t chunk = task % chunks, bh = task / chunks;
  const int count = valid[(bh / heads) * chunks + chunk];
  const int capacity = min(64, max(0, int(input_rows - chunk * 64)));
  const float q_global = gq[0], k_global = gk[0];
  CUDA_KERNEL_ASSERT(count >= 0 && count <= capacity);
  CUDA_KERNEL_ASSERT(isfinite(q_global) && q_global > 0.0f);
  CUDA_KERNEL_ASSERT(isfinite(k_global) && k_global > 0.0f);
  if (count < 0 || count > capacity || !isfinite(q_global) || q_global <= 0.0f ||
      !isfinite(k_global) || k_global <= 0.0f) return;
  const int channel = threadIdx.x * 2;
  const int krow = nv_k_row(row);
  const int64_t input_base = (bh * input_rows + chunk * 64) * 128 + channel;
  const int64_t q_index = input_base + row * 128;
  const int64_t k_index = input_base + krow * 128;
  // Read validity in natural coordinates, before the K permutation.
  const float q0 = row < count ? narrowed(q, q_index) : 0.0f;
  const float q1 = row < count ? narrowed(q, q_index + 1) : 0.0f;
  const float k0 = krow < count ? narrowed(k, k_index) : 0.0f;
  const float k1 = krow < count ? narrowed(k, k_index + 1) : 0.0f;
  NvObservation q_observation{}, k_observation{};
  if (row < count) {
    const float limit = __fmul_rn(q_global, 2688.0f);
    q_observation.observe(q0, limit);
    q_observation.observe(q1, limit);
  }
  if (krow < count) {
    const float limit = __fmul_rn(k_global, 2688.0f);
    k_observation.observe(k0, limit);
    k_observation.observe(k1, limit);
  }
  q_observation.merge(clipping_counts, observed_amax, 0);
  k_observation.merge(clipping_counts, observed_amax, 1);
  const uint8_t sq = scale_bits(max8(fmaxf(fabsf(q0), fabsf(q1))), q_global);
  const uint8_t sk = scale_bits(max8(fmaxf(fabsf(k0), fabsf(k1))), k_global);
  const int64_t output_row = (bh * blocks + offset + chunk) * 64 + row;
  if ((threadIdx.x & 7) == 0) {
    qs[output_row * 8 + channel / 16] = sq;
    ks[output_row * 8 + channel / 16] = sk;
  }
  q4[output_row * 64 + threadIdx.x] = encode_pair(q0, q1, decode_scale(sq) * q_global);
  k4[output_row * 64 + threadIdx.x] = encode_pair(k0, k1, decode_scale(sk) * k_global);
}

template <typename T>
__global__ void nv_prepare_v(
    const T* v, const int32_t* valid, uint8_t* v4, uint8_t* vs,
    const float* gv, int64_t heads, int64_t chunks, int64_t blocks, int64_t offset,
    int64_t* clipping_counts, float* observed_amax, int64_t input_rows) {
  const int64_t chunk = blockIdx.x % chunks, bh = blockIdx.x / chunks;
  const int count = valid[(bh / heads) * chunks + chunk];
  const int capacity = min(64, max(0, int(input_rows - chunk * 64)));
  const float global = gv[0];
  CUDA_KERNEL_ASSERT(count >= 0 && count <= capacity);
  CUDA_KERNEL_ASSERT(isfinite(global) && global > 0.0f);
  if (count < 0 || count > capacity || !isfinite(global) || global <= 0.0f) return;
  const int channel = threadIdx.x;
  const int64_t input_base = (bh * input_rows + chunk * 64) * 128 + channel;
  const int64_t output_base = (bh * 128 + channel) * blocks * 32 + (offset + chunk) * 32;
  const int64_t scale_base = ((bh * blocks + offset + chunk) * 128 + channel) * 4;
  NvObservation observation{};
  const float limit = __fmul_rn(global, 2688.0f);
#pragma unroll
  for (int group = 0; group < 4; ++group) {
    float values[16];
    float amax = 0.0f;
#pragma unroll
    for (int token = 0; token < 16; ++token) {
      const int row = group * 16 + token;
      values[token] = row < count ? narrowed(v, input_base + row * 128) : 0.0f;
      if (row < count) observation.observe(values[token], limit);
      amax = fmaxf(amax, fabsf(values[token]));
    }
    const uint8_t scale = scale_bits(amax, global);
    vs[scale_base + group] = scale;
    const float dequant = decode_scale(scale) * global;
#pragma unroll
    for (int pair = 0; pair < 8; ++pair) {
      v4[output_base + group * 8 + pair] =
          encode_pair(values[2 * pair], values[2 * pair + 1], dequant);
    }
  }
  observation.merge(clipping_counts, observed_amax, 2);
}

// Combined-only V producer. Q/K reuse nv_prepare_qk unchanged; means are
// canonical BF16 metadata from the earlier INT8 preparation, never recomputed.
template <typename T>
__global__ void nv_prepare_combined_v(
    const T* v, const int32_t* valid, uint8_t* v4, uint8_t* vs,
    const float* gv, const nv_bfloat16* means, int64_t groups,
    int64_t heads, int64_t chunks, int64_t blocks, int64_t offset,
    int64_t prefix_start, int64_t prefix_end,
    int64_t* clipping_counts, float* observed_amax, int64_t input_rows) {
  const int64_t chunk = blockIdx.x % chunks, bh = blockIdx.x / chunks;
  const int64_t absolute_block = offset + chunk;
  const bool protected_block = absolute_block >= prefix_start && absolute_block < prefix_end;
  const int count = valid[(bh / heads) * chunks + chunk];
  const int capacity = min(64, max(0, int(input_rows - chunk * 64)));
  const float global = gv[0];
  CUDA_KERNEL_ASSERT(count >= 0 && count <= capacity);
  CUDA_KERNEL_ASSERT(isfinite(global) && global > 0.0f);
  if (count < 0 || count > capacity || !isfinite(global) || global <= 0.0f) return;
  const int channel = threadIdx.x;
  const int64_t input_base = (bh * input_rows + chunk * 64) * 128 + channel;
  const int64_t output_base = (bh * 128 + channel) * blocks * 32 + absolute_block * 32;
  const int64_t scale_base = ((bh * blocks + absolute_block) * 128 + channel) * 4;
  NvObservation observation{};
  const float limit = __fmul_rn(global, 2688.0f);
#pragma unroll
  for (int group = 0; group < 4; ++group) {
    float mean = 0.0f;
    // Do not read empty groups or protected-prefix metadata. In G=1 the
    // same represented mean spans K64; G=4 selects each natural K16 group.
    if (!protected_block && group * 16 < count) {
      const int64_t mean_group = groups == 1 ? 0 : group;
      mean = __bfloat162float(means[
          ((bh * blocks + absolute_block) * groups + mean_group) * 128 + channel]);
      CUDA_KERNEL_ASSERT(isfinite(mean));
      if (!isfinite(mean)) return;
    }
    float values[16];
    float amax = 0.0f;
#pragma unroll
    for (int token = 0; token < 16; ++token) {
      const int row = group * 16 + token;
      // FP32 subtraction AFTER donor half narrowing, with no half residual
      // round-trip. Mask padding after centering so it is zero, not -mean.
      values[token] = row < count
          ? __fsub_rn(narrowed(v, input_base + row * 128), mean) : 0.0f;
      if (row < count) observation.observe(values[token], limit);
      amax = fmaxf(amax, fabsf(values[token]));
    }
    const uint8_t scale = scale_bits(amax, global);
    vs[scale_base + group] = scale;
    const float dequant = decode_scale(scale) * global;
#pragma unroll
    for (int pair = 0; pair < 8; ++pair) {
      v4[output_base + group * 8 + pair] =
          encode_pair(values[2 * pair], values[2 * pair + 1], dequant);
    }
  }
  observation.merge(clipping_counts, observed_amax, 2);
}

bool overlaps(const torch::Tensor& a, const torch::Tensor& b) {
  if (a.numel() == 0 || b.numel() == 0) return false;
  const auto ap = reinterpret_cast<uintptr_t>(a.data_ptr());
  const auto bp = reinterpret_cast<uintptr_t>(b.data_ptr());
  return ap <= bp ? bp - ap < a.numel() * a.element_size()
                  : ap - bp < b.numel() * b.element_size();
}
}  // namespace

// offset is in K64 blocks. Only this chunk's output range is written.
// No centering/combined mode; the Python API must reject combined NVFP4.
void prepare_nvfp4_chunk_impl(
    torch::Tensor q, torch::Tensor k, torch::Tensor v, torch::Tensor valid,
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, int64_t offset,
    torch::Tensor clipping_counts, torch::Tensor observed_amax) {
  TORCH_CHECK(q.defined() && q.is_cuda() && q.dim() == 4,
              "NVFP4 chunk inputs must be CUDA [B,H,C*64,128]");
  TORCH_CHECK(q.scalar_type() == at::kHalf || q.scalar_type() == at::kBFloat16,
              "NVFP4 chunk inputs must be FP16 or BF16");
  const int64_t b = q.size(0), h = q.size(1), n = q.size(2);
  TORCH_CHECK(n > 0, "NVFP4 chunks require at least one row");
  check_tensor(q, q, q.scalar_type(), {b,h,n,128});
  check_tensor(k, q, q.scalar_type(), {b,h,n,128});
  check_tensor(v, q, q.scalar_type(), {b,h,n,128});
  check_tensor(valid, q, at::kInt, {b,(n + 63) / 64});
  TORCH_CHECK(q4.defined() && q4.dim() == 4 && q4.size(2) % 64 == 0,
              "NVFP4 output must have whole K64 capacity");
  const int64_t s = q4.size(2), blocks = s / 64, chunks = (n + 63) / 64;
  check_tensor(q4, q, at::kByte, {b,h,s,64});
  check_tensor(k4, q, at::kByte, {b,h,s,64});
  check_tensor(v4, q, at::kByte, {b,h,128,s/2});
  check_tensor(qs, q, at::kByte, {b,h,s,8});
  check_tensor(ks, q, at::kByte, {b,h,s,8});
  check_tensor(vs, q, at::kByte, {b,h,blocks,128,4});
  check_tensor(gq, q, at::kFloat, {1});
  check_tensor(gk, q, at::kFloat, {1});
  check_tensor(gv, q, at::kFloat, {1});
  TORCH_CHECK(offset >= 0 && offset <= blocks && chunks <= blocks - offset,
              "NVFP4 chunk exceeds output capacity");
  check_tensor(clipping_counts, q, at::kLong, {3});
  check_tensor(observed_amax, q, at::kFloat, {3});
  const std::array<torch::Tensor, 7> inputs = {q,k,v,valid,gq,gk,gv};
  const std::array<torch::Tensor, 8> outputs = {
      q4,k4,v4,qs,ks,vs,clipping_counts,observed_amax};
  for (size_t i = 0; i < outputs.size(); ++i) {
    for (const auto& input : inputs) {
      TORCH_CHECK(!overlaps(outputs[i], input), "NVFP4 output overlaps input");
    }
    for (size_t j = 0; j < i; ++j) {
      TORCH_CHECK(!overlaps(outputs[i], outputs[j]), "NVFP4 outputs overlap");
    }
  }
  const c10::cuda::CUDAGuard guard(q.device());
  check_sm120(q);
  if (q.numel() == 0) return;
  const int64_t rows = b * h * chunks * 64;
  TORCH_CHECK(rows <= std::numeric_limits<int32_t>::max(), "NVFP4 chunk exceeds grid.x capacity");
  const auto stream = at::cuda::getCurrentCUDAStream(q.get_device());
  const auto launch = [&](auto* iq, auto* ik, auto* iv) {
    nv_prepare_qk<<<static_cast<unsigned int>(rows), 64, 0, stream>>>(
        iq, ik, valid.data_ptr<int32_t>(), q4.data_ptr<uint8_t>(), k4.data_ptr<uint8_t>(),
        qs.data_ptr<uint8_t>(), ks.data_ptr<uint8_t>(), gq.data_ptr<float>(), gk.data_ptr<float>(),
        h, chunks, blocks, offset, clipping_counts.data_ptr<int64_t>(),
        observed_amax.data_ptr<float>(), n);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
    nv_prepare_v<<<static_cast<unsigned int>(rows / 64), 128, 0, stream>>>(
        iv, valid.data_ptr<int32_t>(), v4.data_ptr<uint8_t>(), vs.data_ptr<uint8_t>(),
        gv.data_ptr<float>(), h, chunks, blocks, offset,
        clipping_counts.data_ptr<int64_t>(), observed_amax.data_ptr<float>(), n);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
  };
  if (q.scalar_type() == at::kHalf) {
    launch(reinterpret_cast<const half*>(q.data_ptr()), reinterpret_cast<const half*>(k.data_ptr()),
           reinterpret_cast<const half*>(v.data_ptr()));
  } else {
    launch(reinterpret_cast<const nv_bfloat16*>(q.data_ptr()),
           reinterpret_cast<const nv_bfloat16*>(k.data_ptr()),
           reinterpret_cast<const nv_bfloat16*>(v.data_ptr()));
  }
}

void prepare_nvfp4_chunk(
    torch::Tensor q, torch::Tensor k, torch::Tensor v, torch::Tensor valid,
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, int64_t offset,
    torch::Tensor clipping_counts, torch::Tensor observed_amax) {
  TORCH_CHECK(q.size(2) % 64 == 0, "legacy NVFP4 preparation requires whole K64 chunks");
  prepare_nvfp4_chunk_impl(q, k, v, valid, q4, k4, v4, qs, ks, vs,
      gq, gk, gv, offset, clipping_counts, observed_amax);
}

void prepare_nvfp4_chunk_ragged(
    torch::Tensor q, torch::Tensor k, torch::Tensor v, torch::Tensor valid,
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, int64_t offset,
    torch::Tensor clipping_counts, torch::Tensor observed_amax) {
  prepare_nvfp4_chunk_impl(q, k, v, valid, q4, k4, v4, qs, ks, vs,
      gq, gk, gv, offset, clipping_counts, observed_amax);
}

// All interval/offset arguments are absolute K64 block indices. Means span
// the full preallocated output capacity, not merely this chunk. Prefix means
// are ignored here; the caller must keep correction metadata consistent.
void prepare_combined_nvfp4_chunk_impl(
    torch::Tensor q, torch::Tensor k, torch::Tensor v, torch::Tensor valid,
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, torch::Tensor means,
    int64_t offset, int64_t prefix_start, int64_t prefix_end,
    torch::Tensor clipping_counts, torch::Tensor observed_amax) {
  TORCH_CHECK(q.defined() && q.is_cuda() && q.dim() == 4,
              "combined NVFP4 chunk inputs must be CUDA [B,H,C*64,128]");
  TORCH_CHECK(q.scalar_type() == at::kHalf || q.scalar_type() == at::kBFloat16,
              "combined NVFP4 chunk inputs must be FP16 or BF16");
  const int64_t b = q.size(0), h = q.size(1), n = q.size(2);
  TORCH_CHECK(n > 0, "combined NVFP4 chunks require at least one row");
  check_tensor(q, q, q.scalar_type(), {b,h,n,128});
  check_tensor(k, q, q.scalar_type(), {b,h,n,128});
  check_tensor(v, q, q.scalar_type(), {b,h,n,128});
  check_tensor(valid, q, at::kInt, {b,(n + 63) / 64});
  TORCH_CHECK(q4.defined() && q4.dim() == 4 && q4.size(2) % 64 == 0,
              "combined NVFP4 output must have whole K64 capacity");
  const int64_t s = q4.size(2), blocks = s / 64, chunks = (n + 63) / 64;
  check_tensor(q4, q, at::kByte, {b,h,s,64});
  check_tensor(k4, q, at::kByte, {b,h,s,64});
  check_tensor(v4, q, at::kByte, {b,h,128,s/2});
  check_tensor(qs, q, at::kByte, {b,h,s,8});
  check_tensor(ks, q, at::kByte, {b,h,s,8});
  check_tensor(vs, q, at::kByte, {b,h,blocks,128,4});
  check_tensor(gq, q, at::kFloat, {1});
  check_tensor(gk, q, at::kFloat, {1});
  check_tensor(gv, q, at::kFloat, {1});
  TORCH_CHECK(means.defined() && means.dim() == 5,
              "combined NVFP4 means must be BF16 [B,H,Kblocks,G,128]");
  const int64_t groups = means.size(3);
  TORCH_CHECK(groups == 1 || groups == 4, "combined NVFP4 means require G=1 or G=4");
  check_tensor(means, q, at::kBFloat16, {b,h,blocks,groups,128});
  TORCH_CHECK(offset >= 0 && offset <= blocks && chunks <= blocks - offset,
              "combined NVFP4 chunk exceeds output capacity");
  TORCH_CHECK(prefix_start >= 0 && prefix_start <= prefix_end && prefix_end <= blocks,
              "combined NVFP4 prefix interval must lie within output capacity");
  check_tensor(clipping_counts, q, at::kLong, {3});
  check_tensor(observed_amax, q, at::kFloat, {3});
  const std::array<torch::Tensor, 8> inputs = {q,k,v,valid,gq,gk,gv,means};
  const std::array<torch::Tensor, 8> outputs = {
      q4,k4,v4,qs,ks,vs,clipping_counts,observed_amax};
  for (size_t i = 0; i < outputs.size(); ++i) {
    for (const auto& input : inputs) {
      TORCH_CHECK(!overlaps(outputs[i], input), "combined NVFP4 output overlaps input");
    }
    for (size_t j = 0; j < i; ++j) {
      TORCH_CHECK(!overlaps(outputs[i], outputs[j]), "combined NVFP4 outputs overlap");
    }
  }
  const c10::cuda::CUDAGuard guard(q.device());
  check_sm120(q);
  if (q.numel() == 0) return;
  const int64_t rows = b * h * chunks * 64;
  TORCH_CHECK(rows <= std::numeric_limits<int32_t>::max(),
              "combined NVFP4 chunk exceeds grid.x capacity");
  const auto stream = at::cuda::getCurrentCUDAStream(q.get_device());
  const auto launch = [&](auto* iq, auto* ik, auto* iv) {
    nv_prepare_qk<<<static_cast<unsigned int>(rows), 64, 0, stream>>>(
        iq, ik, valid.data_ptr<int32_t>(), q4.data_ptr<uint8_t>(), k4.data_ptr<uint8_t>(),
        qs.data_ptr<uint8_t>(), ks.data_ptr<uint8_t>(), gq.data_ptr<float>(), gk.data_ptr<float>(),
        h, chunks, blocks, offset, clipping_counts.data_ptr<int64_t>(),
        observed_amax.data_ptr<float>(), n);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
    nv_prepare_combined_v<<<static_cast<unsigned int>(rows / 64), 128, 0, stream>>>(
        iv, valid.data_ptr<int32_t>(), v4.data_ptr<uint8_t>(), vs.data_ptr<uint8_t>(),
        gv.data_ptr<float>(), reinterpret_cast<const nv_bfloat16*>(means.data_ptr()),
        groups, h, chunks, blocks, offset, prefix_start, prefix_end,
        clipping_counts.data_ptr<int64_t>(), observed_amax.data_ptr<float>(), n);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
  };
  if (q.scalar_type() == at::kHalf) {
    launch(reinterpret_cast<const half*>(q.data_ptr()), reinterpret_cast<const half*>(k.data_ptr()),
           reinterpret_cast<const half*>(v.data_ptr()));
  } else {
    launch(reinterpret_cast<const nv_bfloat16*>(q.data_ptr()),
           reinterpret_cast<const nv_bfloat16*>(k.data_ptr()),
           reinterpret_cast<const nv_bfloat16*>(v.data_ptr()));
  }
}

void prepare_combined_nvfp4_chunk(
    torch::Tensor q, torch::Tensor k, torch::Tensor v, torch::Tensor valid,
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, torch::Tensor means,
    int64_t offset, int64_t prefix_start, int64_t prefix_end,
    torch::Tensor clipping_counts, torch::Tensor observed_amax) {
  TORCH_CHECK(q.size(2) % 64 == 0, "legacy combined NVFP4 preparation requires whole K64 chunks");
  prepare_combined_nvfp4_chunk_impl(q, k, v, valid, q4, k4, v4, qs, ks, vs,
      gq, gk, gv, means, offset, prefix_start, prefix_end, clipping_counts, observed_amax);
}

void prepare_combined_nvfp4_chunk_ragged(
    torch::Tensor q, torch::Tensor k, torch::Tensor v, torch::Tensor valid,
    torch::Tensor q4, torch::Tensor k4, torch::Tensor v4,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor gq, torch::Tensor gk, torch::Tensor gv, torch::Tensor means,
    int64_t offset, int64_t prefix_start, int64_t prefix_end,
    torch::Tensor clipping_counts, torch::Tensor observed_amax) {
  prepare_combined_nvfp4_chunk_impl(q, k, v, valid, q4, k4, v4, qs, ks, vs,
      gq, gk, gv, means, offset, prefix_start, prefix_end, clipping_counts, observed_amax);
}
