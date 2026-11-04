// Copyright 2026 Anemoi Project Contributors. Apache-2.0; see vendor/LICENSE.
// Modified for this project from the pinned attention preparation source.
// Bounded Q64/K64/D128 preparation for the native SM120 INT8 attention path.
// Layout/quantization donor: anemoi-review.PqNiN4, SM120
// q128_microscaling_preparation.cu (prepare_h3_qk_microscaling_kernel and
// prepare_h3_int8_v_from_partials_kernel). Centered V scales are local to
// K64 blocks, so that consumer must accumulate in common real units. Plain
// production mode uses caller-calibrated global channel scales.
#include <ATen/cuda/CUDAContext.h>
#include <c10/cuda/CUDAException.h>
#include <c10/cuda/CUDAGuard.h>
#include <c10/macros/Macros.h>
#include <torch/extension.h>

#include <cuda_bf16.h>
#include <cuda_fp16.h>
#include <cuda_fp8.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <vector>

namespace {
constexpr int kRows = 64;
constexpr int kChannels = 128;
constexpr float kVRange = 2.25f;

// Logical token -> physical token, independently within every K64 block.
// This is the donor's INT8-V permutation, not the MXFP8 scale permutation.
__host__ __device__ constexpr int v_physical_row(int row) {
  const int local = row % 16;
  return (row / 16) * 16 + (local / 8) * 2 +
      ((local / 2) % 4) * 4 + local % 2;
}

template <typename T>
__device__ __forceinline__ float load_operand(const T* input, int64_t index);

template <>
__device__ __forceinline__ float load_operand<half>(
    const half* input, int64_t index) {
  return __half2float(input[index]);
}

template <>
__device__ __forceinline__ float load_operand<nv_bfloat16>(
    const nv_bfloat16* input, int64_t index) {
  // Preserve the upstream BF16 -> FP16 preparation boundary.
  return __half2float(__float2half_rn(__bfloat162float(input[index])));
}

__device__ __forceinline__ int8_t quantize_qk(float value, float scale) {
  float scaled = __fdiv_rn(value, scale);
  scaled += scaled >= 0.0f ? 0.5f : -0.5f;
  return static_cast<int8_t>(__float2int_rz(scaled));
}

template <typename T>
__global__ void prepare_int8_chunk_kernel(
    const T* q, const T* k, const T* v, const int32_t* valid_counts,
    int8_t* q8, int8_t* k8, uint8_t* v8, float* qs, float* ks,
    float* vs, nv_bfloat16* means, int64_t heads, int64_t chunk_blocks,
    int64_t output_blocks, int64_t block_offset, bool centered,
    int64_t prefix_blocks, const float* global_vscale, int64_t prefix_start,
    int64_t groups, const nv_bfloat16* external_means, int64_t input_rows) {
  __shared__ float q_max[kChannels];
  __shared__ float k_max[kChannels];
  __shared__ float q_scale;
  __shared__ float k_scale;

  const int channel = threadIdx.x;
  const int64_t chunk_block = blockIdx.x % chunk_blocks;
  const int64_t bh = blockIdx.x / chunk_blocks;
  const int64_t batch = bh / heads;
  const int valid = valid_counts[batch * chunk_blocks + chunk_block];
  const int capacity = min(kRows, max(0, int(input_rows - chunk_block * kRows)));
  // Validate on the current stream without copying counts to the host or
  // synchronizing. Invalid metadata raises an asynchronous CUDA assertion.
  CUDA_KERNEL_ASSERT(valid >= 0 && valid <= capacity);
  if (valid < 0 || valid > capacity) return;

  const int64_t absolute_block = block_offset + chunk_block;
  const int64_t input_base =
      (bh * input_rows + chunk_block * kRows) * kChannels + channel;
  const int64_t output_base =
      (bh * output_blocks + absolute_block) * kRows * kChannels + channel;
  const int64_t scale_index = bh * output_blocks + absolute_block;
  const bool subtract_mean = centered &&
      !(absolute_block >= prefix_start && absolute_block < prefix_blocks);

  float qa = 0.0f;
  float ka = 0.0f;
  for (int row = 0; row < valid; ++row) {
    const int64_t index = input_base + row * kChannels;
    qa = fmaxf(qa, fabsf(load_operand(q, index)));
    ka = fmaxf(ka, fabsf(load_operand(k, index)));
  }
  q_max[channel] = qa;
  k_max[channel] = ka;
  __syncthreads();
  for (int stride = kChannels / 2; stride > 0; stride >>= 1) {
    if (channel < stride) {
      q_max[channel] = fmaxf(q_max[channel], q_max[channel + stride]);
      k_max[channel] = fmaxf(k_max[channel], k_max[channel + stride]);
    }
    __syncthreads();
  }
  if (channel == 0) {
    // Separate division/addition keeps the upstream epsilon convention even
    // when the extension enables fast math / fused multiply-add.
    q_scale = __fadd_rn(__fdiv_rn(q_max[0], 127.0f), 1.0e-7f);
    k_scale = __fadd_rn(__fdiv_rn(k_max[0], 127.0f), 1.0e-7f);
    qs[scale_index] = q_scale;
    ks[scale_index] = k_scale;
  }
  __syncthreads();

  const int group_rows = kRows / groups;
  for (int group = 0; group < groups; ++group) {
  const int first = group * group_rows;
  const int last = min(valid, first + group_rows);
  float sum = 0.f;
  for (int row = first; row < last; ++row)
    if (subtract_mean) sum += load_operand(v, input_base + row * kChannels);
  const nv_bfloat16 represented_mean = subtract_mean && external_means
      ? external_means[((bh * chunk_blocks + chunk_block) * groups + group) * kChannels + channel]
      : __float2bfloat16_rn(subtract_mean && last > first
          ? __fdiv_rn(sum, float(last - first)) : 0.0f);
  const float mean = __bfloat162float(represented_mean);
  const int64_t group_index = (scale_index * groups + group) * kChannels + channel;
  means[group_index] = represented_mean;

  float va = 0.0f;
  for (int row = first; row < last; ++row) {
    const float residual = __fsub_rn(load_operand(v, input_base + row * kChannels), mean);
    va = fmaxf(va, fabsf(residual));
  }
  // A zero finite residual channel must have a finite, nonzero scale.
  float v_scale = va == 0.0f ? 1.0f : __fdiv_rn(va, kVRange);
  float multiplier = va == 0.0f ? 0.0f : __fdiv_rn(kVRange, va);
  const bool use_global_scale = !centered && global_vscale != nullptr;
  if (use_global_scale) {
    const float supplied = global_vscale[bh * kChannels + channel];
    CUDA_KERNEL_ASSERT(isfinite(supplied) && supplied >= 0.0f);
    if (!isfinite(supplied) || supplied < 0.0f) return;
    v_scale = supplied == 0.0f ? 1.0f : supplied;
  }
  vs[group_index] = v_scale;
  const int64_t v_base =
      (bh * kChannels + channel) * output_blocks * kRows + absolute_block * kRows;
  for (int row = first; row < first + group_rows; ++row) {
    const int64_t input_index = input_base + row * kChannels;
    const int64_t output_index = output_base + row * kChannels;
    q8[output_index] = row < valid
        ? quantize_qk(load_operand(q, input_index), q_scale) : int8_t(0);
    k8[output_index] = row < valid
        ? quantize_qk(load_operand(k, input_index), k_scale) : int8_t(0);
    // Padding is zero after centering, never -mean. Do not read invalid rows.
    float encoded = 0.0f;
    if (row < valid) {
      const float residual = __fsub_rn(load_operand(v, input_index), mean);
      // Divide directly for supplied scales: a tiny positive scale need not
      // have a finite reciprocal (in particular, 0 * infinity would be NaN).
      encoded = use_global_scale ? __fdiv_rn(residual, v_scale)
          : (multiplier != 0.0f ? residual * multiplier : 0.0f);
    }
    v8[v_base + v_physical_row(row)] =
        __nv_cvt_float_to_fp8(encoded, __NV_SATFINITE, __NV_E4M3);
  }
  }
}

void check_tensor(const torch::Tensor& tensor, const char* name,
                  const c10::Device& device, at::ScalarType dtype) {
  TORCH_CHECK(tensor.defined() && tensor.is_cuda(), name, " must be CUDA");
  TORCH_CHECK(tensor.device() == device, name, " must be on the Q device");
  TORCH_CHECK(tensor.scalar_type() == dtype, name, " has the wrong dtype");
  TORCH_CHECK(tensor.is_contiguous(), name, " must be contiguous");
}

void check_shape(const torch::Tensor& tensor, const char* name,
                 std::initializer_list<int64_t> shape) {
  TORCH_CHECK(tensor.sizes() == c10::IntArrayRef(shape),
              name, " has the wrong shape; expected ", c10::IntArrayRef(shape),
              ", got ", tensor.sizes());
}

bool overlaps(const torch::Tensor& a, const torch::Tensor& b) {
  if (!a.defined() || !b.defined()) return false;
  if (a.numel() == 0 || b.numel() == 0) return false;
  const auto ap = reinterpret_cast<uintptr_t>(a.data_ptr());
  const auto bp = reinterpret_cast<uintptr_t>(b.data_ptr());
  const auto an = static_cast<uint64_t>(a.numel()) * a.element_size();
  const auto bn = static_cast<uint64_t>(b.numel()) * b.element_size();
  return ap <= bp ? bp - ap < an : ap - bp < bn;
}
}  // namespace

// Inputs are already normalized / RoPE-applied, with valid rows packed first
// in each K64 block. Only [block_offset, block_offset + C) is written.
// G=1 or G=4; optional external represented means are bounded to this chunk.
// global_vscale may be undefined/empty for centered mode or explicit diagnostic
// block-scaled plain mode. The production Python API must require it for plain
// mode. Supplied plain scales are repeated in vs_out for common-unit consumers.
void prepare_int8_chunk_impl(
    torch::Tensor q, torch::Tensor k, torch::Tensor v,
    torch::Tensor valid_counts, torch::Tensor q8_out, torch::Tensor k8_out,
    torch::Tensor v8_out, torch::Tensor qs_out, torch::Tensor ks_out,
    torch::Tensor vs_out, torch::Tensor means_out, int64_t block_offset,
    bool centered, int64_t prefix_blocks, torch::Tensor global_vscale,
    int64_t prefix_start, torch::Tensor external_means, int64_t input_rows) {
  TORCH_CHECK(q.defined() && q.is_cuda(), "q must be CUDA");
  TORCH_CHECK(q.scalar_type() == at::kHalf || q.scalar_type() == at::kBFloat16,
              "q/k/v must be float16 or bfloat16");
  const c10::cuda::CUDAGuard guard(q.device());
  check_tensor(q, "q", q.device(), q.scalar_type());
  check_tensor(k, "k", q.device(), q.scalar_type());
  check_tensor(v, "v", q.device(), q.scalar_type());
  TORCH_CHECK(q.dim() == 4 && q.size(3) == kChannels && input_rows == q.size(2),
              "q/k/v must have shape [B,H,C,128]");
  TORCH_CHECK(k.sizes() == q.sizes() && v.sizes() == q.sizes(),
              "q/k/v chunk shapes must match");
  const int64_t batch = q.size(0);
  const int64_t heads = q.size(1);
  const int64_t chunks = (q.size(2) + kRows - 1) / kRows;
  check_tensor(valid_counts, "valid_counts", q.device(), at::kInt);
  check_shape(valid_counts, "valid_counts", {batch, chunks});
  check_tensor(q8_out, "q8_out", q.device(), at::kChar);
  check_tensor(k8_out, "k8_out", q.device(), at::kChar);
  check_tensor(v8_out, "v8_out", q.device(), at::kByte);
  check_tensor(qs_out, "qs_out", q.device(), at::kFloat);
  check_tensor(ks_out, "ks_out", q.device(), at::kFloat);
  check_tensor(vs_out, "vs_out", q.device(), at::kFloat);
  check_tensor(means_out, "means_out", q.device(), at::kBFloat16);
  TORCH_CHECK(q8_out.dim() == 4 && q8_out.size(2) % kRows == 0,
              "q8_out must have shape [B,H,S,128], S divisible by 64");
  const int64_t tokens = q8_out.size(2);
  const int64_t blocks = tokens / kRows;
  check_shape(q8_out, "q8_out", {batch, heads, tokens, kChannels});
  check_shape(k8_out, "k8_out", {batch, heads, tokens, kChannels});
  check_shape(v8_out, "v8_out", {batch, heads, kChannels, tokens});
  check_shape(qs_out, "qs_out", {batch, heads, blocks});
  check_shape(ks_out, "ks_out", {batch, heads, blocks});
  TORCH_CHECK(means_out.dim()==5,"means must be B,H,blocks,G,128");
  const int64_t groups = means_out.size(3);
  TORCH_CHECK(groups==1 || groups==4,"value groups must be 1 or 4");
  check_shape(vs_out, "vs_out", {batch, heads, blocks, groups, kChannels});
  check_shape(means_out, "means_out", {batch, heads, blocks, groups, kChannels});
  const bool has_external_means = external_means.defined() && external_means.numel()!=0;
  if (has_external_means) {
    check_tensor(external_means,"external_means",q.device(),at::kBFloat16);
    check_shape(external_means,"external_means",{batch,heads,chunks,groups,kChannels});
  }
  TORCH_CHECK(block_offset >= 0 && block_offset <= blocks &&
                  chunks <= blocks - block_offset,
              "chunk write range exceeds output capacity");
  TORCH_CHECK(prefix_start >= 0 && prefix_start <= prefix_blocks && prefix_blocks <= blocks,
              "prefix_blocks must be within output capacity");
  const bool has_global_scale = global_vscale.defined() && global_vscale.numel() != 0;
  if (has_global_scale) {
    check_tensor(global_vscale, "global_vscale", q.device(), at::kFloat);
    check_shape(global_vscale, "global_vscale", {batch, heads, kChannels});
  }

  // Preallocated buffers must not alias inputs or each other. Otherwise
  // independent CTAs can race even when all individual shapes are valid.
  const std::array<torch::Tensor, 6> inputs = {q, k, v, valid_counts, global_vscale, external_means};
  const std::array<torch::Tensor, 7> outputs = {
      q8_out, k8_out, v8_out, qs_out, ks_out, vs_out, means_out};
  for (size_t i = 0; i < outputs.size(); ++i) {
    for (const auto& input : inputs) {
      TORCH_CHECK(!overlaps(outputs[i], input), "outputs must not overlap inputs");
    }
    for (size_t j = 0; j < i; ++j) {
      TORCH_CHECK(!overlaps(outputs[i], outputs[j]), "outputs must not overlap");
    }
  }
  if (batch == 0 || heads == 0 || chunks == 0) return;
  // q.numel() already bounds this product to int64_t.
  const int64_t ctas = batch * heads * chunks;
  TORCH_CHECK(ctas <= std::numeric_limits<int32_t>::max(),
              "chunk exceeds CUDA grid.x capacity");
  const auto stream = at::cuda::getCurrentCUDAStream(q.get_device());
  const auto launch = [&](auto* input_q, auto* input_k, auto* input_v) {
    prepare_int8_chunk_kernel<<<static_cast<unsigned int>(ctas), kChannels, 0, stream>>>(
        input_q, input_k, input_v, valid_counts.data_ptr<int32_t>(),
        q8_out.data_ptr<int8_t>(), k8_out.data_ptr<int8_t>(),
        v8_out.data_ptr<uint8_t>(), qs_out.data_ptr<float>(), ks_out.data_ptr<float>(),
        vs_out.data_ptr<float>(), reinterpret_cast<nv_bfloat16*>(means_out.data_ptr()),
        heads, chunks, blocks, block_offset, centered, prefix_blocks,
        has_global_scale && !centered ? global_vscale.data_ptr<float>() : nullptr, prefix_start,
        groups,has_external_means?reinterpret_cast<const nv_bfloat16*>(external_means.data_ptr()):nullptr,
        input_rows);
  };
  if (q.scalar_type() == at::kHalf) {
    launch(reinterpret_cast<const half*>(q.data_ptr()),
           reinterpret_cast<const half*>(k.data_ptr()),
           reinterpret_cast<const half*>(v.data_ptr()));
  } else {
    launch(reinterpret_cast<const nv_bfloat16*>(q.data_ptr()),
           reinterpret_cast<const nv_bfloat16*>(k.data_ptr()),
           reinterpret_cast<const nv_bfloat16*>(v.data_ptr()));
  }
  C10_CUDA_KERNEL_LAUNCH_CHECK();
}

void prepare_int8_chunk(
    torch::Tensor q, torch::Tensor k, torch::Tensor v,
    torch::Tensor valid_counts, torch::Tensor q8_out, torch::Tensor k8_out,
    torch::Tensor v8_out, torch::Tensor qs_out, torch::Tensor ks_out,
    torch::Tensor vs_out, torch::Tensor means_out, int64_t block_offset,
    bool centered, int64_t prefix_blocks, torch::Tensor global_vscale,
    int64_t prefix_start, torch::Tensor external_means) {
  TORCH_CHECK(q.size(2) % kRows == 0, "legacy INT8 preparation requires whole K64 chunks");
  prepare_int8_chunk_impl(q, k, v, valid_counts, q8_out, k8_out, v8_out,
      qs_out, ks_out, vs_out, means_out, block_offset, centered, prefix_blocks,
      global_vscale, prefix_start, external_means, q.size(2));
}

void prepare_int8_chunk_ragged(
    torch::Tensor q, torch::Tensor k, torch::Tensor v,
    torch::Tensor valid_counts, torch::Tensor q8_out, torch::Tensor k8_out,
    torch::Tensor v8_out, torch::Tensor qs_out, torch::Tensor ks_out,
    torch::Tensor vs_out, torch::Tensor means_out, int64_t block_offset,
    bool centered, int64_t prefix_blocks, torch::Tensor global_vscale,
    int64_t prefix_start, torch::Tensor external_means) {
  prepare_int8_chunk_impl(q, k, v, valid_counts, q8_out, k8_out, v8_out,
      qs_out, ks_out, vs_out, means_out, block_offset, centered, prefix_blocks,
      global_vscale, prefix_start, external_means, q.size(2));
}

// Optional first-wave preparation helpers. Existing packing ABI is unchanged.
// Metadata may be strided slices of the request's full validity/permutation
// tables: do not force a host-side contiguous copy for each chunk.
namespace {
struct ChunkMetadata {
  const int32_t* valid;
  const uint8_t* permutation;
  const nv_bfloat16* means;
  int64_t valid_b, valid_c;
  int64_t perm_b, perm_h, perm_c;
  int64_t mean_b, mean_h, mean_c, mean_g;
  int64_t heads, rows, chunks, groups;
};

__device__ float max_propagate_nan(float a, float b) {
  return isnan(a) || isnan(b) ? __int_as_float(0x7fc00000) : fmaxf(a,b);
}

template <typename T>
__global__ void measure_chunk_kernel(const T* q,const T* k,const T* v,
                                    ChunkMetadata p,float* maxima) {
  __shared__ float reduction[3][128];
  const int d=threadIdx.x;
  const int64_t block=blockIdx.x%p.chunks,bh=blockIdx.x/p.chunks;
  const int64_t batch=bh/p.heads,head=bh%p.heads;
  const int count=p.valid[batch*p.valid_b+block*p.valid_c];
  const int64_t remaining=p.rows-block*64;
  const int capacity=remaining<64 ? (int)remaining : 64;
  CUDA_KERNEL_ASSERT(count>=0 && count<=capacity);
  if(count<0 || count>capacity) return;
  float qa=0.f,ka=0.f,va=0.f;
  for(int row=0;row<count;++row) {
    const int64_t input=(bh*p.rows+block*64+row)*128+d;
    qa=max_propagate_nan(qa,fabsf(load_operand(q,input)));
    ka=max_propagate_nan(ka,fabsf(load_operand(k,input)));
    const int source=p.permutation ? p.permutation[
        batch*p.perm_b+head*p.perm_h+block*p.perm_c+row] : row;
    CUDA_KERNEL_ASSERT(source>=0 && source<count);
    if(source<0 || source>=count) return;
    float value=load_operand(v,(bh*p.rows+block*64+source)*128+d);
    if(p.means) value-=__bfloat162float(p.means[
        batch*p.mean_b+head*p.mean_h+block*p.mean_c+(row/(64/p.groups))*p.mean_g+d]);
    va=max_propagate_nan(va,fabsf(value));
  }
  reduction[0][d]=qa;reduction[1][d]=ka;reduction[2][d]=va;
  __syncthreads();
  for(int width=64;width;width>>=1) {
    if(d<width) for(int operand=0;operand<3;++operand)
      reduction[operand][d]=max_propagate_nan(
          reduction[operand][d],reduction[operand][d+width]);
    __syncthreads();
  }
  if(d<3) atomicMax(reinterpret_cast<unsigned int*>(maxima+d),
                    __float_as_uint(reduction[d][0]));
}

__global__ void gather_chunk_kernel(
    const uint16_t* q,const uint16_t* k,const uint16_t* v,
    uint16_t* qp,uint16_t* kp,uint16_t* vp,ChunkMetadata p,int64_t elements) {
  const int64_t i=(int64_t)blockIdx.x*blockDim.x+threadIdx.x;
  if(i>=elements) return;
  const int d=i%128;
  const int64_t row=(i/128)%(p.chunks*64),bh=i/(p.chunks*64*128);
  const int64_t batch=bh/p.heads,head=bh%p.heads;
  const int source=p.permutation[
      batch*p.perm_b+head*p.perm_h+(row/64)*p.perm_c+row%64];
  CUDA_KERNEL_ASSERT(source>=0 && source<64);
  if(source<0 || source>=64) return;
  const int64_t source_row=(row/64)*64+source;
  const int64_t src=(bh*p.rows+source_row)*128+d;
  kp[i]=source_row<p.rows ? k[src] : 0;
  vp[i]=source_row<p.rows ? v[src] : 0;
  if(qp) qp[i]=row<p.rows ? q[(bh*p.rows+row)*128+d] : 0;
}

ChunkMetadata chunk_metadata(torch::Tensor q,torch::Tensor k,torch::Tensor v,
    torch::Tensor permutation) {
  TORCH_CHECK(q.dim()==4 && q.size(0)>0 && q.size(1)>0 && q.size(2)>0 && q.size(3)==128,
              "chunk inputs must be positive BHMD D128");
  TORCH_CHECK(q.scalar_type()==at::kHalf || q.scalar_type()==at::kBFloat16,
              "chunk inputs require FP16/BF16");
  check_tensor(q,"q",q.device(),q.scalar_type());
  check_tensor(k,"k",q.device(),q.scalar_type());
  check_tensor(v,"v",q.device(),q.scalar_type());
  TORCH_CHECK(k.sizes()==q.sizes() && v.sizes()==q.sizes(),"chunk QKV shapes differ");
  ChunkMetadata p{};
  p.heads=q.size(1);p.rows=q.size(2);p.chunks=(p.rows+63)/64;
  if(permutation.numel()) {
    TORCH_CHECK(permutation.device()==q.device() && permutation.scalar_type()==at::kByte &&
        permutation.dim()==4 && permutation.size(0)==q.size(0) &&
        permutation.size(1)==p.heads && permutation.size(2)==p.chunks &&
        permutation.size(3)==64 && permutation.stride(3)==1,"invalid chunk permutation");
    p.permutation=permutation.data_ptr<uint8_t>();
    p.perm_b=permutation.stride(0);p.perm_h=permutation.stride(1);p.perm_c=permutation.stride(2);
  }
  return p;
}
}

void measure_chunk(torch::Tensor q,torch::Tensor k,torch::Tensor v,torch::Tensor valid,
                   torch::Tensor permutation,torch::Tensor means,torch::Tensor maxima) {
  const auto p0=chunk_metadata(q,k,v,permutation);
  auto p=p0;
  TORCH_CHECK(valid.device()==q.device() && valid.scalar_type()==at::kInt &&
      valid.dim()==2 && valid.size(0)==q.size(0) && valid.size(1)==p.chunks,
      "validity must be int32 [B,chunk_blocks]");
  p.valid=valid.data_ptr<int32_t>();p.valid_b=valid.stride(0);p.valid_c=valid.stride(1);
  if(means.numel()) {
    TORCH_CHECK(means.device()==q.device() && means.scalar_type()==at::kBFloat16 &&
        means.dim()==5 && means.size(0)==q.size(0) && means.size(1)==p.heads &&
        means.size(2)==p.chunks && (means.size(3)==1 || means.size(3)==4) &&
        means.size(4)==128 && means.stride(4)==1,"invalid represented means");
    p.means=reinterpret_cast<const nv_bfloat16*>(means.data_ptr());
    p.groups=means.size(3);p.mean_b=means.stride(0);p.mean_h=means.stride(1);
    p.mean_c=means.stride(2);p.mean_g=means.stride(3);
  }
  check_tensor(maxima,"maxima",q.device(),at::kFloat);
  check_shape(maxima,"maxima",{3});
  for(const auto& input : {q,k,v,valid,permutation,means})
    TORCH_CHECK(!overlaps(maxima,input),"calibration output must not alias inputs");
  const int64_t blocks=q.size(0)*p.heads*p.chunks;
  TORCH_CHECK(blocks<=std::numeric_limits<int32_t>::max(),"calibration grid too large");
  c10::cuda::CUDAGuard guard(q.device());
  const auto stream=at::cuda::getCurrentCUDAStream(q.get_device());
  if(q.scalar_type()==at::kHalf)
    measure_chunk_kernel<<<blocks,128,0,stream>>>(
        reinterpret_cast<const half*>(q.data_ptr()),reinterpret_cast<const half*>(k.data_ptr()),
        reinterpret_cast<const half*>(v.data_ptr()),p,maxima.data_ptr<float>());
  else
    measure_chunk_kernel<<<blocks,128,0,stream>>>(
        reinterpret_cast<const nv_bfloat16*>(q.data_ptr()),reinterpret_cast<const nv_bfloat16*>(k.data_ptr()),
        reinterpret_cast<const nv_bfloat16*>(v.data_ptr()),p,maxima.data_ptr<float>());
  C10_CUDA_KERNEL_LAUNCH_CHECK();
}

std::vector<torch::Tensor> gather_grouped_chunk(
    torch::Tensor q,torch::Tensor k,torch::Tensor v,torch::Tensor permutation) {
  const auto p=chunk_metadata(q,k,v,permutation);
  TORCH_CHECK(p.permutation,"grouped gather requires a permutation");
  c10::cuda::CUDAGuard guard(q.device());
  const auto shape=std::vector<int64_t>{q.size(0),p.heads,p.chunks*64,128};
  auto qo=p.rows==p.chunks*64 ? q : torch::empty(shape,q.options());
  auto ko=torch::empty(shape,q.options()),vo=torch::empty(shape,q.options());
  const auto elements=ko.numel(),blocks=(elements+255)/256;
  TORCH_CHECK(blocks<=std::numeric_limits<int32_t>::max(),"gather grid too large");
  const auto stream=at::cuda::getCurrentCUDAStream(q.get_device());
  gather_chunk_kernel<<<blocks,256,0,stream>>>(
      reinterpret_cast<const uint16_t*>(q.data_ptr()),reinterpret_cast<const uint16_t*>(k.data_ptr()),
      reinterpret_cast<const uint16_t*>(v.data_ptr()),
      p.rows==p.chunks*64 ? nullptr : reinterpret_cast<uint16_t*>(qo.data_ptr()),
      reinterpret_cast<uint16_t*>(ko.data_ptr()),reinterpret_cast<uint16_t*>(vo.data_ptr()),p,elements);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  return {qo,ko,vo};
}
