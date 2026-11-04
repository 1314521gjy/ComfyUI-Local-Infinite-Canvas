// Project-isolated host ABI over pinned Anemoi's genuine INT8/FP8 MMA.
#include "check.h"
#define MPA_CTA_Q 64
#define MPA_WARP_Q 16
#define MPA_K64_BLOCK_MODE 1
#define MPA_MIDDLE_INT8 1
#include "../vendor/csrc/attention/cuda/sm120/q64_attention.cuh"

namespace {
__global__ void mask_int8_output(
    half* output, float* lse, const int32_t* valid, const bool* prefix_mask,
    const nv_bfloat16* stock, uint32_t batch_size, uint32_t num_heads,
    uint32_t query_len) {
  const uint64_t row = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const uint64_t rows = static_cast<uint64_t>(batch_size) * num_heads * query_len;
  if (row >= rows) return;
  const uint32_t query = row % query_len;
  const uint32_t block = query / 64;
  const uint32_t batch = row / (static_cast<uint64_t>(num_heads) * query_len);
  half* dst = output + row * 128;
  if (prefix_mask != nullptr && prefix_mask[batch * (query_len / 64) + block]) {
    const nv_bfloat16* src = stock + row * 128;
#pragma unroll
    for (uint32_t d = 0; d < 128; ++d) dst[d] = __float2half(__bfloat162float(src[d]));
    return;
  }
  if (query % 64 < static_cast<uint32_t>(valid[batch * (query_len / 64) + block])) return;
#pragma unroll
  for (uint32_t d = 0; d < 128; ++d) dst[d] = __float2half(0.0f);
  lse[row] = -INFINITY;
}
}  // namespace

std::tuple<torch::Tensor, torch::Tensor> ANEMOI_ENTRY(
    torch::Tensor q, torch::Tensor k, torch::Tensor v,
    torch::Tensor qs, torch::Tensor ks, torch::Tensor vs,
    torch::Tensor means, torch::Tensor ids, torch::Tensor counts,
    torch::Tensor valid, double softmax_scale, bool trusted,
    torch::Tensor prefix_mask, torch::Tensor stock_prefix) {
  TORCH_CHECK(q.dim() == 4 && k.dim() == 4, "Q/K must be [B,H,S,128]");
  const auto b=q.size(0), h=q.size(1), nq=q.size(2), nk=k.size(2);
  TORCH_CHECK(b>0 && h>0 && nq>0 && nk>0 && nq%64==0 && nk%64==0,
              "positive Q64/K64 physical storage required");
  check_tensor(q,q,at::kChar,{b,h,nq,128});
  check_tensor(k,q,at::kChar,{b,h,nk,128});
  check_tensor(v,q,at::kByte,{b,h,128,nk});
  check_tensor(qs,q,at::kFloat,{b,h,nq/64});
  check_tensor(ks,q,at::kFloat,{b,h,nk/64});
#if defined(MPA_BLOCK_VALUE_SCALE)
  check_tensor(vs,q,at::kFloat,{b,h,nk/64,MPA_VALUE_GROUPS,128});
  check_tensor(means,q,at::kBFloat16,{b,h,nk/64,MPA_VALUE_GROUPS,128});
#else
  check_tensor(vs,q,at::kFloat,{b,h,128});
#endif
  TORCH_CHECK(ids.device()==q.device(), "route device mismatch");
  TORCH_CHECK(std::isfinite(softmax_scale) &&
              std::isfinite(static_cast<float>(softmax_scale)) &&
              static_cast<float>(softmax_scale)>0, "invalid softmax scale");
  c10::cuda::CUDAGuard guard(q.device());
  check_sm120(q);
  const bool has_prefix = prefix_mask.numel() != 0;
  if (has_prefix) {
    check_tensor(prefix_mask, q, at::kBool, {b, nq / 64});
    check_tensor(stock_prefix, q, at::kBFloat16, {b, h, nq, 128});
  } else {
    TORCH_CHECK(stock_prefix.numel() == 0, "stock prefix output requires a prefix mask");
  }
  check_routes(ids,counts,valid,b,h,nq/64,nk/64,trusted);
  auto out=torch::zeros({b,h,nq,128},q.options().dtype(at::kHalf));
  auto lse=torch::full({b,h,nq},-INFINITY,q.options().dtype(at::kFloat));
  auto stream=at::cuda::getCurrentCUDAStream(q.get_device());
  // Explicit launcher spelling survives upstream macro cleanup after inclusion.
  ANEMOI_LAUNCH<128,true,false,false>(
      q.data_ptr<int8_t>(),k.data_ptr<int8_t>(),reinterpret_cast<__nv_fp8_e4m3*>(v.data_ptr<uint8_t>()),
      nullptr,nullptr,nullptr,
#if defined(MPA_BLOCK_VALUE_SCALE)
      reinterpret_cast<half*>(means.data_ptr<at::BFloat16>()),
#else
      nullptr,
#endif
      reinterpret_cast<half*>(out.data_ptr<at::Half>()),ids.data_ptr<int32_t>(),counts.data_ptr<int32_t>(),
      nullptr,nullptr,qs.data_ptr<float>(),ks.data_ptr<float>(),vs.data_ptr<float>(),
      valid.data_ptr<int32_t>(),lse.data_ptr<float>(),0,b,nq,nk,nk,h,h,
      static_cast<float>(softmax_scale),stream);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  const auto output_rows = static_cast<uint64_t>(b) * h * nq;
  mask_int8_output<<<(output_rows + 255) / 256, 256, 0, stream.stream()>>>(
      reinterpret_cast<half*>(out.data_ptr<at::Half>()), lse.data_ptr<float>(),
      valid.data_ptr<int32_t>(), has_prefix ? prefix_mask.data_ptr<bool>() : nullptr,
      has_prefix ? reinterpret_cast<const nv_bfloat16*>(stock_prefix.data_ptr<at::BFloat16>()) : nullptr,
      b, h, nq);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  return {out,lse};
}

std::vector<int64_t> ANEMOI_RESOURCES() {
  constexpr int bytes=(64+2*64)*128+64*(128/32)+128*2;
  auto kernel=mpa::attention::ANEMOI_KERNEL<128,true,false,false>;
  cudaFuncAttributes a{};
  C10_CUDA_CHECK(cudaFuncGetAttributes(&a,kernel));
  int active=0;
  C10_CUDA_CHECK(cudaOccupancyMaxActiveBlocksPerMultiprocessor(&active,kernel,128,bytes));
  return {a.numRegs,static_cast<int64_t>(a.sharedSizeBytes),bytes,active};
}
