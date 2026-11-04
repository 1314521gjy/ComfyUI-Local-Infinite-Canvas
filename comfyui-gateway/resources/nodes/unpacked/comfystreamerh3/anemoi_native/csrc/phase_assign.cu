#include <torch/extension.h>
#include <ATen/cuda/CUDAContext.h>
#include <c10/cuda/CUDAGuard.h>
#include <c10/cuda/CUDAException.h>
#include <cub/cub.cuh>

#include <cmath>
#include <cstdint>
#include <vector>

using PhaseTensor = torch::Tensor;
using PhaseTensorList = std::vector<PhaseTensor>;
using MixedAttentionOutput = std::tuple<PhaseTensor, PhaseTensor>;
MixedAttentionOutput mixed_attention(
    PhaseTensorList, PhaseTensorList, PhaseTensorList, PhaseTensor, PhaseTensor,
    PhaseTensor, PhaseTensor, PhaseTensor, PhaseTensor,
    PhaseTensorList, double, bool, PhaseTensor, PhaseTensor);
MixedAttentionOutput combined_mixed_attention(
    PhaseTensorList, PhaseTensorList, PhaseTensorList, PhaseTensor, PhaseTensor,
    PhaseTensor, PhaseTensor, PhaseTensor, PhaseTensor,
    PhaseTensorList, double, bool, PhaseTensor, PhaseTensor);
MixedAttentionOutput combined_mixed_g4_attention(
    PhaseTensorList, PhaseTensorList, PhaseTensorList, PhaseTensor, PhaseTensor,
    PhaseTensor, PhaseTensor, PhaseTensor, PhaseTensor,
    PhaseTensorList, double, bool, PhaseTensor, PhaseTensor);

namespace {

__device__ __forceinline__ int64_t phase_count_slot(
    int64_t row, int phase, int64_t rows, bool planar) {
  return planar ? phase * rows + row : row * 3 + phase;
}

__device__ __forceinline__ uint32_t ordered_float(float value) {
  const uint32_t bits = __float_as_uint(value);
  return (bits & 0x80000000u) ? ~bits : (bits ^ 0x80000000u);
}

__global__ void build_sort_pairs(
    const int32_t* ids, const int32_t* counts, const float* scores,
    uint64_t* keys, int32_t* values, int64_t bh, int64_t q, int64_t cap,
    int64_t score_width) {
  const int64_t flat = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t total = bh * q * cap;
  if (flat >= total) return;
  const int64_t slot = flat % cap;
  const int64_t row = flat / cap;
  const int64_t query = row % q;
  const int32_t count = counts[row];
  const int32_t key_id = ids[flat];
  const bool active = slot < count && key_id >= 0 && key_id < score_width;
  const float score = active ? scores[row * score_width + key_id] : -INFINITY;
  // IEEE ordered-float keys sort by numeric value. The low word reverses the
  // tie key so descending radix sort keeps query-major, key-ID order.
  const uint32_t score_key = active ? ordered_float(score) : 0u;
  const uint32_t tie = static_cast<uint32_t>(query * cap + (active ? key_id : cap));
  keys[flat] = (static_cast<uint64_t>(score_key) << 32) | (0xffffffffu - tie);
  values[flat] = static_cast<int32_t>(query * cap + slot);
}

__global__ void make_quotas(
    const int32_t* counts, int32_t* quotas, int64_t bh, int64_t q,
    double fp16_ratio, double int8_ratio, double nv_ratio,
    int32_t* begin, int32_t* end, int64_t cap) {
  const int64_t head = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (head >= bh) return;
  if (begin) {
    begin[head] = static_cast<int32_t>(head * q * cap);
    end[head] = static_cast<int32_t>((head + 1) * q * cap);
  }
  int64_t total = 0;
  for (int64_t query = 0; query < q; ++query) total += counts[head * q + query];
  const double ratios[3] = {fp16_ratio, int8_ratio, nv_ratio};
  int64_t base[3];
  double fraction[3];
  int64_t used = 0;
  for (int i = 0; i < 3; ++i) {
    const double exact = static_cast<double>(total) * ratios[i];
    base[i] = static_cast<int64_t>(floor(exact));
    fraction[i] = exact - static_cast<double>(base[i]);
    used += base[i];
  }
  const int64_t remainder = total - used;
  for (int i = 0; i < 3; ++i) {
    int64_t extra = 0;
    for (int j = 0; j < 3; ++j) {
      if (j == i) continue;
      // Earlier phase index wins exact remainder ties: FP16, INT8, NVFP4.
      const bool ahead = fraction[j] > fraction[i] ||
          (fraction[j] == fraction[i] && j < i);
      if (ahead) ++extra;
    }
    quotas[head * 3 + i] = static_cast<int32_t>(base[i] + (extra < remainder));
  }
}

__global__ void assign_phase_flags(
    const int32_t* counts, const int32_t* sorted_slots, const int32_t* quotas,
    int8_t* labels, int32_t* phase_flags, int32_t* phase_counts,
    int64_t bh, int64_t q, int64_t cap, bool planar) {
  const int64_t sorted = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t items = bh * q * cap;
  if (sorted >= items) return;
  const int64_t head = sorted / (q * cap);
  const int64_t rank = sorted % (q * cap);
  const int64_t source_flat = head * q * cap + sorted_slots[sorted];
  const int64_t query = sorted_slots[sorted] / cap;
  const int64_t source_slot = sorted_slots[sorted] % cap;
  const int32_t count = counts[head * q + query];
  if (source_slot < 0 || source_slot >= count) return;
  const int32_t fp16_quota = quotas[head * 3];
  const int32_t int8_quota = quotas[head * 3 + 1];
  const int phase = rank < fp16_quota ? 0 :
      (rank < fp16_quota + int8_quota ? 1 : 2);
  labels[source_flat] = static_cast<int8_t>(phase);
  phase_flags[phase * items + source_flat] = 1;
  atomicAdd(&phase_counts[phase_count_slot(head * q + query, phase, bh * q, planar)], 1);
}

__global__ void scatter_phases(
    const int32_t* ids, const int32_t* counts, const int8_t* labels,
    const int32_t* phase_positions, int32_t* compact,
    const int32_t* phase_counts, int64_t bh, int64_t q, int64_t cap, bool planar) {
  const int64_t source = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const int64_t items = bh * q * cap;
  if (source >= items) return;
  const int64_t row = source / cap;
  const int64_t slot = source % cap;
  if (slot >= counts[row]) return;
  const int phase = labels[source];
  if (phase >= 3) return;
  const int32_t position = phase_positions[phase * items + source];
  const int32_t phase_offset = phase == 0
      ? phase_counts[phase_count_slot(row, 1, bh*q, planar)] +
          phase_counts[phase_count_slot(row, 2, bh*q, planar)]
      : (phase == 1 ? phase_counts[phase_count_slot(row, 2, bh*q, planar)] : 0);
  compact[row * cap + phase_offset + position] = ids[source];
}

// The H3 workload normally has only a few query/key blocks per head.  CUB's
// segmented radix sort is excellent for large geometry, but its temporary
// storage and multi-launch scan chain dominate this small case.  Keep the
// exact same ordered-float/key-ID ranking and stable per-query phase order in a
// single bounded shared-memory block instead.
__global__ void phase_assign_small(
    const int32_t* ids, const int32_t* counts, const float* scores,
    int32_t* compact, int32_t* phase_counts, int64_t bh, int64_t q,
    int64_t cap, int64_t score_width, double fp16_ratio, double int8_ratio,
    double nv_ratio, int32_t padded, bool planar) {
  constexpr int kMaxItems = 256;
  __shared__ uint64_t keys[kMaxItems];
  __shared__ int32_t values[kMaxItems];
  __shared__ int8_t labels[kMaxItems];
  const int tid = threadIdx.x;
  const int64_t items = q * cap;
  const int64_t head = blockIdx.x;
  if (tid < padded) {
    if (tid < items) {
      const int64_t query = tid / cap;
      const int64_t slot = tid % cap;
      const int32_t key_id = ids[head * items + tid];
      const int32_t count = counts[head * q + query];
      const bool active = slot < count && key_id >= 0 && key_id < score_width;
      const float score = active ? scores[(head * q + query) * score_width + key_id] : -INFINITY;
      const uint32_t score_key = active ? ordered_float(score) : 0u;
      const uint32_t tie = static_cast<uint32_t>(query * cap + (active ? key_id : cap));
      keys[tid] = (static_cast<uint64_t>(score_key) << 32) | (0xffffffffu - tie);
      values[tid] = static_cast<int32_t>(tid);
    } else {
      keys[tid] = 0;
      values[tid] = -1;
    }
  }
  if (tid < kMaxItems) labels[tid] = -1;
  __syncthreads();

  for (int k = 2; k <= padded; k <<= 1) {
    for (int j = k >> 1; j > 0; j >>= 1) {
      if (tid < padded) {
        const int other = tid ^ j;
        if (other > tid && other < padded) {
          // Standard bitonic sort with the final direction reversed so the
          // block is globally descending, matching SortPairsDescending.
          const bool ascending = (tid & k) != 0;
          const bool swap = ascending ? keys[tid] > keys[other] : keys[tid] < keys[other];
          if (swap) {
            const uint64_t key = keys[tid];
            keys[tid] = keys[other];
            keys[other] = key;
            const int32_t value = values[tid];
            values[tid] = values[other];
            values[other] = value;
          }
        }
      }
      __syncthreads();
    }
  }

  if (tid == 0) {
    int64_t total = 0;
    for (int64_t query = 0; query < q; ++query) total += counts[head * q + query];
    const double ratios[3] = {fp16_ratio, int8_ratio, nv_ratio};
    int64_t base[3];
    double fraction[3];
    int64_t used = 0;
    for (int phase = 0; phase < 3; ++phase) {
      const double exact = static_cast<double>(total) * ratios[phase];
      base[phase] = static_cast<int64_t>(floor(exact));
      fraction[phase] = exact - static_cast<double>(base[phase]);
      used += base[phase];
    }
    const int64_t remainder = total - used;
    int64_t quota[3];
    for (int phase = 0; phase < 3; ++phase) {
      int64_t ahead_count = 0;
      for (int other = 0; other < 3; ++other) {
        if (other == phase) continue;
        if (fraction[other] > fraction[phase] ||
            (fraction[other] == fraction[phase] && other < phase)) ++ahead_count;
      }
      quota[phase] = base[phase] + (ahead_count < remainder);
    }
    for (int64_t rank = 0; rank < items; ++rank) {
      const int32_t source = values[rank];
      if (source < 0) continue;
      const int64_t query = source / cap;
      const int64_t slot = source % cap;
      if (slot >= counts[head * q + query]) continue;
      const int phase = rank < quota[0] ? 0 :
          (rank < quota[0] + quota[1] ? 1 : 2);
      labels[source] = static_cast<int8_t>(phase);
      ++phase_counts[phase_count_slot(head*q+query, phase, bh*q, planar)];
    }
    for (int64_t query = 0; query < q; ++query) {
      int32_t position[3] = {0, 0, 0};
      const int32_t offset[3] = {
          phase_counts[phase_count_slot(head*q+query, 1, bh*q, planar)] +
              phase_counts[phase_count_slot(head*q+query, 2, bh*q, planar)],
          phase_counts[phase_count_slot(head*q+query, 2, bh*q, planar)], 0};
      const int32_t count = counts[head * q + query];
      for (int32_t slot = 0; slot < count; ++slot) {
        const int phase = labels[query * cap + slot];
        if (phase >= 0 && phase < 3) {
          compact[head * items + query * cap + offset[phase] + position[phase]++] =
              ids[head * items + query * cap + slot];
        }
      }
    }
  }
}

template <int Threads>
__global__ void segmented_exclusive_scan(
    const int32_t* flags, int32_t* positions, int64_t rows, int64_t cap) {
  const int64_t row = static_cast<int64_t>(blockIdx.x);
  if (row >= rows) return;
  using BlockScan = cub::BlockScan<int32_t, Threads>;
  __shared__ typename BlockScan::TempStorage scan_storage;
  __shared__ int32_t carry;
  if (threadIdx.x == 0) carry = 0;
  __syncthreads();
  for (int64_t base = 0; base < cap; base += Threads) {
    const int64_t index = base + threadIdx.x;
    const int32_t flag = index < cap ? flags[row * cap + index] : 0;
    int32_t prefix = 0;
    int32_t block_total = 0;
    BlockScan(scan_storage).ExclusiveSum(flag, prefix, block_total);
    if (index < cap) positions[row * cap + index] = carry + prefix;
    __syncthreads();
    if (threadIdx.x == 0) carry += block_total;
    __syncthreads();
  }
}

// The three phase planes have identical geometry and are consumed by the
// same scatter. The optimized path scans them in one grid launch while
// retaining one independent CUB state/carry per plane. The barriers between
// planes are intentional:
// BlockScan's temporary storage is shared and may be reused only after every
// thread has finished the previous plane.
template <int Threads>
__global__ void segmented_exclusive_scan_three(
    const int32_t* flags, int32_t* positions, int64_t rows, int64_t cap) {
  const int64_t row = static_cast<int64_t>(blockIdx.x);
  if (row >= rows) return;
  using BlockScan = cub::BlockScan<int32_t, Threads>;
  __shared__ typename BlockScan::TempStorage scan_storage[3];
  __shared__ int32_t carry[3];
  if (threadIdx.x < 3) carry[threadIdx.x] = 0;
  __syncthreads();
  const int64_t plane = rows * cap;
  for (int64_t base = 0; base < cap; base += Threads) {
    const int64_t index = base + threadIdx.x;
    for (int phase = 0; phase < 3; ++phase) {
      const int32_t flag = index < cap
          ? flags[phase * plane + row * cap + index] : 0;
      int32_t prefix = 0;
      int32_t block_total = 0;
      BlockScan(scan_storage[phase]).ExclusiveSum(flag, prefix, block_total);
      if (index < cap) {
        positions[phase * plane + row * cap + index] = carry[phase] + prefix;
      }
      __syncthreads();
      if (threadIdx.x == 0) carry[phase] += block_total;
      __syncthreads();
    }
  }
}

}  // namespace

static std::tuple<torch::Tensor, torch::Tensor, torch::Tensor, torch::Tensor> phase_assign_impl(
    torch::Tensor ids, torch::Tensor counts, torch::Tensor scores,
    std::vector<double> ratios, bool optimize_metadata) {
  TORCH_CHECK(ids.is_cuda() && counts.is_cuda() && scores.is_cuda(),
              "phase assignment requires CUDA tensors");
  TORCH_CHECK(ids.scalar_type() == at::kInt && counts.scalar_type() == at::kInt,
              "phase routes and counts must be int32");
  TORCH_CHECK(scores.scalar_type() == at::kFloat && ids.dim() == 4 && counts.dim() == 3 &&
              scores.dim() == 4, "invalid phase assignment tensor shapes");
  TORCH_CHECK(ids.is_contiguous() && counts.is_contiguous() && scores.is_contiguous(),
              "phase assignment tensors must be contiguous");
  TORCH_CHECK(ratios.size() == 3 && std::isfinite(ratios[0]) && std::isfinite(ratios[1]) &&
              std::isfinite(ratios[2]) && ratios[0] >= 0 && ratios[1] >= 0 && ratios[2] >= 0 &&
              std::abs(ratios[0] + ratios[1] + ratios[2] - 1.0) <= 1e-12,
              "phase ratios must be finite nonnegative values summing to one");
  const auto b = ids.size(0), h = ids.size(1), q = ids.size(2), cap = ids.size(3);
  TORCH_CHECK(counts.sizes() == c10::IntArrayRef({b, h, q}),
              "phase counts shape mismatch");
  TORCH_CHECK(scores.size(0) == b && scores.size(1) == h && scores.size(2) == q,
              "phase score shape mismatch");
  TORCH_CHECK(scores.size(3) >= cap, "phase score width is smaller than route capacity");
  c10::cuda::CUDAGuard guard(ids.device());
  const auto stream = at::cuda::getCurrentCUDAStream(ids.get_device());
  const int64_t bh = b * h;
  const int64_t items = bh * q * cap;
  auto opts_i = ids.options();
  auto phase_counts = optimize_metadata ? torch::zeros({3, bh, q}, opts_i)
                                       : torch::zeros({bh, q, 3}, opts_i);
  auto count_view = [&](int phase) {
    return optimize_metadata ? phase_counts.select(0, phase).view({b,h,q})
        : phase_counts.select(2, phase).view({b,h,q}).contiguous();
  };
  auto compact = torch::full({bh, q, cap}, -1, opts_i);
  if (items == 0) {
    return {compact.view({b, h, q, cap}), count_view(2), count_view(1), count_view(0)};
  }
  const int64_t items_per_head = q * cap;
  // The small kernel computes quotas in shared/local state; its old allocation
  // was unused. Keep legacy behavior unless the explicit option is enabled.
  auto quotas = optimize_metadata && items_per_head<=256 ? torch::Tensor()
      : torch::empty({bh, 3}, opts_i);
  if (items_per_head <= 256) {
    int32_t padded = 1;
    while (padded < items_per_head) padded <<= 1;
    const int threads = 256;
    phase_assign_small<<<bh, threads, 0, stream.stream()>>>(
        ids.data_ptr<int32_t>(), counts.data_ptr<int32_t>(), scores.data_ptr<float>(),
        compact.data_ptr<int32_t>(), phase_counts.data_ptr<int32_t>(), bh, q, cap,
        scores.size(3), ratios[0], ratios[1], ratios[2], padded, optimize_metadata);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
    return {compact.view({b, h, q, cap}), count_view(2), count_view(1), count_view(0)};
  }
  auto opts_l = torch::TensorOptions().device(ids.device()).dtype(at::kUInt64);
  auto keys = torch::empty({items}, opts_l);
  auto sorted_keys = torch::empty_like(keys);
  auto values = torch::empty({items}, opts_i);
  auto sorted_values = torch::empty_like(values);
  auto phase_flags = torch::zeros({3 * items}, opts_i);
  auto phase_positions = torch::empty_like(phase_flags);
  auto labels = torch::empty({items}, torch::TensorOptions().device(ids.device()).dtype(at::kChar));
  auto begin = torch::empty({bh}, opts_i);
  auto end = torch::empty({bh}, opts_i);
  if (!optimize_metadata) {
    auto host_begin = torch::empty({bh}, torch::TensorOptions().device(at::kCPU).dtype(at::kInt));
    auto host_end = torch::empty_like(host_begin);
    auto begin_ptr = host_begin.data_ptr<int32_t>();
    auto end_ptr = host_end.data_ptr<int32_t>();
    for (int64_t i = 0; i < bh; ++i) {
      begin_ptr[i] = static_cast<int32_t>(i * q * cap);
      end_ptr[i] = static_cast<int32_t>((i + 1) * q * cap);
    }
    begin.copy_(host_begin);
    end.copy_(host_end);
  }
  const int threads = 256;
  build_sort_pairs<<<(items + threads - 1) / threads, threads, 0, stream.stream()>>>(
      ids.data_ptr<int32_t>(), counts.data_ptr<int32_t>(), scores.data_ptr<float>(),
      keys.data_ptr<uint64_t>(), values.data_ptr<int32_t>(), bh, q, cap, scores.size(3));
  make_quotas<<<(bh + threads - 1) / threads, threads, 0, stream.stream()>>>(
      counts.data_ptr<int32_t>(), quotas.data_ptr<int32_t>(), bh, q,
      ratios[0], ratios[1], ratios[2],
      optimize_metadata ? begin.data_ptr<int32_t>() : nullptr,
      optimize_metadata ? end.data_ptr<int32_t>() : nullptr, cap);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  size_t temporary_bytes = 0;
  C10_CUDA_CHECK(cub::DeviceSegmentedRadixSort::SortPairsDescending(
      nullptr, temporary_bytes, keys.data_ptr<uint64_t>(), sorted_keys.data_ptr<uint64_t>(),
      values.data_ptr<int32_t>(), sorted_values.data_ptr<int32_t>(), items, bh,
      begin.data_ptr<int32_t>(), end.data_ptr<int32_t>(), 0, 64, stream.stream()));
  auto temporary = torch::empty({static_cast<int64_t>(temporary_bytes)},
                                torch::TensorOptions().device(ids.device()).dtype(at::kByte));
  C10_CUDA_CHECK(cub::DeviceSegmentedRadixSort::SortPairsDescending(
      temporary.data_ptr(), temporary_bytes, keys.data_ptr<uint64_t>(), sorted_keys.data_ptr<uint64_t>(),
      values.data_ptr<int32_t>(), sorted_values.data_ptr<int32_t>(), items, bh,
      begin.data_ptr<int32_t>(), end.data_ptr<int32_t>(), 0, 64, stream.stream()));
  assign_phase_flags<<<(items + threads - 1) / threads, threads, 0, stream.stream()>>>(
      counts.data_ptr<int32_t>(), sorted_values.data_ptr<int32_t>(), quotas.data_ptr<int32_t>(),
      labels.data_ptr<int8_t>(), phase_flags.data_ptr<int32_t>(), phase_counts.data_ptr<int32_t>(),
      bh, q, cap, optimize_metadata);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  if (optimize_metadata) {
    segmented_exclusive_scan_three<256><<<bh * q, 256, 0, stream.stream()>>>(
        phase_flags.data_ptr<int32_t>(), phase_positions.data_ptr<int32_t>(),
        bh * q, cap);
  } else {
    for (int phase = 0; phase < 3; ++phase) {
      segmented_exclusive_scan<256><<<bh * q, 256, 0, stream.stream()>>>(
          phase_flags.data_ptr<int32_t>() + phase * items,
          phase_positions.data_ptr<int32_t>() + phase * items,
          bh * q, cap);
      C10_CUDA_KERNEL_LAUNCH_CHECK();
    }
  }
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  scatter_phases<<<(items + threads - 1) / threads, threads, 0, stream.stream()>>>(
      ids.data_ptr<int32_t>(), counts.data_ptr<int32_t>(), labels.data_ptr<int8_t>(),
      phase_positions.data_ptr<int32_t>(), compact.data_ptr<int32_t>(),
      phase_counts.data_ptr<int32_t>(), bh, q, cap, optimize_metadata);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  return {compact.view({b, h, q, cap}), count_view(2), count_view(1), count_view(0)};
}

std::tuple<PhaseTensor,PhaseTensor,PhaseTensor,PhaseTensor> phase_assign(
    PhaseTensor ids,PhaseTensor counts,PhaseTensor scores,std::vector<double> ratios) {
  return phase_assign_impl(ids,counts,scores,ratios,false);
}
std::tuple<PhaseTensor,PhaseTensor,PhaseTensor,PhaseTensor> phase_assign_optimized(
    PhaseTensor ids,PhaseTensor counts,PhaseTensor scores,std::vector<double> ratios) {
  return phase_assign_impl(ids,counts,scores,ratios,true);
}

std::tuple<torch::Tensor, torch::Tensor, torch::Tensor, torch::Tensor, torch::Tensor>
mixed_attention_with_phase_impl(
    PhaseTensorList i8, PhaseTensorList nv, PhaseTensorList fp, PhaseTensor means,
    PhaseTensor ids, PhaseTensor counts, PhaseTensor valid, PhaseTensorList global,
    double scale, bool trusted, PhaseTensor prefix_mask, PhaseTensor stock_prefix,
    std::vector<double> ratios, PhaseTensor scores, bool combined, bool groups4,
    bool optimize_metadata) {
  auto assigned = phase_assign_impl(ids, counts, scores, ratios, optimize_metadata);
  auto compact = std::get<0>(assigned);
  auto nv_counts = std::get<1>(assigned);
  auto int8_counts = std::get<2>(assigned);
  auto fp16_counts = std::get<3>(assigned);
  auto output = groups4
      ? combined_mixed_g4_attention(
          i8, nv, fp, means, compact, nv_counts, int8_counts, fp16_counts,
          valid, global, scale, trusted, prefix_mask, stock_prefix)
      : (combined
          ? combined_mixed_attention(
              i8, nv, fp, means, compact, nv_counts, int8_counts, fp16_counts,
              valid, global, scale, trusted, prefix_mask, stock_prefix)
          : mixed_attention(
              i8, nv, fp, means, compact, nv_counts, int8_counts, fp16_counts,
              valid, global, scale, trusted, prefix_mask, stock_prefix));
  return {std::get<0>(output), std::get<1>(output), nv_counts, int8_counts, fp16_counts};
}

std::tuple<PhaseTensor,PhaseTensor,PhaseTensor,PhaseTensor,PhaseTensor>
mixed_attention_with_phase(
    PhaseTensorList i8,PhaseTensorList nv,PhaseTensorList fp,PhaseTensor means,
    PhaseTensor ids,PhaseTensor counts,PhaseTensor valid,PhaseTensorList global,
    double scale,bool trusted,PhaseTensor prefix_mask,PhaseTensor stock_prefix,
    std::vector<double> ratios,PhaseTensor scores,bool combined,bool groups4) {
  return mixed_attention_with_phase_impl(i8,nv,fp,means,ids,counts,valid,global,
      scale,trusted,prefix_mask,stock_prefix,ratios,scores,combined,groups4,false);
}
std::tuple<PhaseTensor,PhaseTensor,PhaseTensor,PhaseTensor,PhaseTensor>
mixed_attention_with_phase_optimized(
    PhaseTensorList i8,PhaseTensorList nv,PhaseTensorList fp,PhaseTensor means,
    PhaseTensor ids,PhaseTensor counts,PhaseTensor valid,PhaseTensorList global,
    double scale,bool trusted,PhaseTensor prefix_mask,PhaseTensor stock_prefix,
    std::vector<double> ratios,PhaseTensor scores,bool combined,bool groups4) {
  return mixed_attention_with_phase_impl(i8,nv,fp,means,ids,counts,valid,global,
      scale,trusted,prefix_mask,stock_prefix,ratios,scores,combined,groups4,true);
}
