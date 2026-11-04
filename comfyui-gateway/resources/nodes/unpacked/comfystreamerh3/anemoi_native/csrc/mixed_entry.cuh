// Explicit mixed-policy ABI; native phases share a single m/d/numerator state.
#include "check.h"
#define MPA_CTA_Q 64
#define MPA_WARP_Q 16
#define MPA_K64_BLOCK_MODE 1
#define MPA_MIDDLE_INT8 1
#define MPA_LOW4_NVFP4 1
#include "../vendor/csrc/attention/cuda/sm120/q64_attention.cuh"

#define MPA_CAT_INNER(a, b) a##b
#define MPA_CAT(a, b) MPA_CAT_INNER(a, b)
#define MPA_MASK_KERNEL_NAME MPA_CAT(mask_mixed_output_, ANEMOI_MIXED_ENTRY)
#define MPA_OVERLAY_KERNEL_NAME MPA_CAT(overlay_prefix_output_, ANEMOI_MIXED_ENTRY)

namespace {

__global__ void MPA_MASK_KERNEL_NAME(
    half* output, float* lse, const int32_t* valid, uint32_t batch_size,
    uint32_t num_heads, uint32_t query_len) {
  const uint64_t row = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const uint64_t rows = static_cast<uint64_t>(batch_size) * num_heads * query_len;
  if (row >= rows) return;
  const uint32_t query = row % query_len;
  const uint32_t block = query / 64;
  const uint32_t offset = query % 64;
  const uint32_t batch = row / (static_cast<uint64_t>(num_heads) * query_len);
  const uint32_t valid_rows = valid[batch * (query_len / 64) + block];
  if (offset < valid_rows) return;
  half* row_output = output + row * 128;
#pragma unroll
  for (uint32_t d = 0; d < 128; ++d) row_output[d] = __float2half(0.0f);
  lse[row] = -INFINITY;
}

__global__ void MPA_OVERLAY_KERNEL_NAME(
    half* output, const nv_bfloat16* stock, const bool* prefix_mask,
    uint32_t batch_size, uint32_t num_heads, uint32_t query_len) {
  const uint64_t row = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const uint64_t rows = static_cast<uint64_t>(batch_size) * num_heads * query_len;
  if (row >= rows) return;
  const uint32_t query = row % query_len;
  const uint32_t block = query / 64;
  const uint32_t batch = row / (static_cast<uint64_t>(num_heads) * query_len);
  if (!prefix_mask[batch * (query_len / 64) + block]) return;
  half* dst = output + row * 128;
  const nv_bfloat16* src = stock + row * 128;
#pragma unroll
  for (uint32_t d = 0; d < 128; ++d) dst[d] = __float2half(__bfloat162float(src[d]));
}

}  // namespace

std::tuple<torch::Tensor,torch::Tensor> ANEMOI_MIXED_ENTRY(
    std::vector<torch::Tensor> i8, std::vector<torch::Tensor> nv,
    std::vector<torch::Tensor> fp, torch::Tensor means, torch::Tensor ids,
    torch::Tensor nc, torch::Tensor ic, torch::Tensor fc, torch::Tensor valid,
    std::vector<torch::Tensor> global, double scale, bool trusted,
    torch::Tensor prefix_mask, torch::Tensor stock_prefix) {
  TORCH_CHECK(i8.size()==6 && nv.size()==6 && (fp.empty() || fp.size()==3) && global.size()==3,
              "mixed operands require six INT8, six NVFP4, optional three FP16, three globals");
  auto q=i8[0];
  TORCH_CHECK(q.dim()==4 && q.is_cuda(),"mixed Q must be CUDA BHSD");
  const auto b=q.size(0),h=q.size(1),nq=q.size(2),nk=i8[1].size(2);
  TORCH_CHECK(b>0 && h>0 && nq>0 && nk>0 && nq%64==0 && nk%64==0,"Q64/K64 required");
  check_tensor(i8[0],q,at::kChar,{b,h,nq,128});
  check_tensor(i8[1],q,at::kChar,{b,h,nk,128});
  check_tensor(i8[2],q,at::kByte,{b,h,128,nk});
  check_tensor(i8[3],q,at::kFloat,{b,h,nq/64});
  check_tensor(i8[4],q,at::kFloat,{b,h,nk/64});
#if defined(MPA_BLOCK_VALUE_SCALE)
  check_tensor(i8[5],q,at::kFloat,{b,h,nk/64,MPA_VALUE_GROUPS,128});
  check_tensor(means,q,at::kBFloat16,{b,h,nk/64,MPA_VALUE_GROUPS,128});
#else
  check_tensor(i8[5],q,at::kFloat,{b,h,128});
#endif
  check_tensor(nv[0],q,at::kByte,{b,h,nq,64});
  check_tensor(nv[1],q,at::kByte,{b,h,nk,64});
  check_tensor(nv[2],q,at::kByte,{b,h,128,nk/2});
  check_tensor(nv[3],q,at::kByte,{b,h,nq,8});
  check_tensor(nv[4],q,at::kByte,{b,h,nk,8});
  check_tensor(nv[5],q,at::kByte,{b,h,nk/64,128,4});
  check_tensor(nc,q,at::kInt,{b,h,nq/64});
  check_tensor(ic,q,at::kInt,{b,h,nq/64});
  check_tensor(fc,q,at::kInt,{b,h,nq/64});
  TORCH_CHECK(ids.device()==q.device(),"mixed route device mismatch");
  TORCH_CHECK(std::isfinite(scale) && std::isfinite(float(scale)) && float(scale)>0,"invalid scale");
  c10::cuda::CUDAGuard guard(q.device());
  check_sm120(q);
  const bool has_prefix = prefix_mask.numel() != 0;
  if (has_prefix) {
    check_tensor(prefix_mask, q, at::kBool, {b, nq / 64});
    check_tensor(stock_prefix, q, at::kBFloat16, {b, h, nq, 128});
  } else {
    TORCH_CHECK(stock_prefix.numel() == 0, "stock prefix output requires a prefix mask");
  }
  if (!trusted) {
  TORCH_CHECK((nc>=0).all().item<bool>() && (ic>=0).all().item<bool>() &&
              (fc>=0).all().item<bool>(),"negative phase counts");
  auto total=nc.to(at::kLong)+ic.to(at::kLong)+fc.to(at::kLong);
  TORCH_CHECK((total<=nk/64).all().item<bool>(),"mixed counts exceed route capacity");
  check_routes(ids,total.to(at::kInt),valid,b,h,nq/64,nk/64);
  // Finite positive INT8 scales are a boundary contract. Zero residual
  // channels use scale=1 in preparation rather than dividing by zero here.
  TORCH_CHECK((torch::isfinite(i8[5]) & (i8[5]>0)).all().item<bool>(),
              "mixed INT8 V scales must be finite positive (zero channels use 1)");
  } else {
    check_tensor(ids,q,at::kInt,{b,h,nq/64,nk/64});
    check_tensor(valid,q,at::kInt,{b,nk/64});
  }
  for (auto g : global) {
    check_tensor(g,q,at::kFloat,{1});
    if (!trusted) {
    auto value=g.item<float>();
    TORCH_CHECK(std::isfinite(value) && value>0,"NVFP4 tensor scales must be finite positive");
    }
  }
  if (!fp.empty()) {
    check_tensor(fp[0],q,at::kHalf,{b,h,nq,128});
    check_tensor(fp[1],q,at::kHalf,{b,h,nk,128});
    check_tensor(fp[2],q,at::kHalf,{b,h,nk,128});
  } else if (!trusted) {
    TORCH_CHECK((fc==0).all().item<bool>(),"FP16 phase requested without operands");
  }
  auto out=torch::zeros({b,h,nq,128},q.options().dtype(at::kHalf));
  auto lse=torch::full({b,h,nq},-INFINITY,q.options().dtype(at::kFloat));
  auto launcher = fp.empty() ? ANEMOI_MIXED_LAUNCH<128,true,false,false>
                             : ANEMOI_MIXED_LAUNCH<128,true,true,false>;
  launcher(
      i8[0].data_ptr<int8_t>(),i8[1].data_ptr<int8_t>(),
      reinterpret_cast<__nv_fp8_e4m3*>(i8[2].data_ptr<uint8_t>()),
      fp.empty()?nullptr:reinterpret_cast<half*>(fp[0].data_ptr<at::Half>()),
      fp.empty()?nullptr:reinterpret_cast<half*>(fp[1].data_ptr<at::Half>()),
      fp.empty()?nullptr:reinterpret_cast<half*>(fp[2].data_ptr<at::Half>()),
#if defined(MPA_BLOCK_VALUE_SCALE)
      reinterpret_cast<half*>(means.data_ptr<at::BFloat16>()),
#else
      nullptr,
#endif
      reinterpret_cast<half*>(out.data_ptr<at::Half>()),
      ids.data_ptr<int32_t>(),nc.data_ptr<int32_t>(),ids.data_ptr<int32_t>(),fc.data_ptr<int32_t>(),
      i8[3].data_ptr<float>(),i8[4].data_ptr<float>(),i8[5].data_ptr<float>(),
      reinterpret_cast<int8_t*>(nv[0].data_ptr<uint8_t>()),
      reinterpret_cast<int8_t*>(nv[1].data_ptr<uint8_t>()),
      reinterpret_cast<__nv_fp8_e4m3*>(nv[2].data_ptr<uint8_t>()),
      nv[3].data_ptr<uint8_t>(),nv[4].data_ptr<uint8_t>(),nv[5].data_ptr<uint8_t>(),
      ic.data_ptr<int32_t>(),global[0].data_ptr<float>(),global[1].data_ptr<float>(),global[2].data_ptr<float>(),
      valid.data_ptr<int32_t>(),lse.data_ptr<float>(),0,b,nq,nk,nk,h,h,float(scale),
      at::cuda::getCurrentCUDAStream(q.get_device()));
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  const auto stream = at::cuda::getCurrentCUDAStream(q.get_device());
  const uint64_t rows = static_cast<uint64_t>(b) * h * nq;
  MPA_MASK_KERNEL_NAME<<<(rows + 255) / 256, 256, 0, stream.stream()>>>(
      reinterpret_cast<half*>(out.data_ptr<at::Half>()), lse.data_ptr<float>(),
      valid.data_ptr<int32_t>(), b, h, nq);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  if (has_prefix) {
    MPA_OVERLAY_KERNEL_NAME<<<(rows + 255) / 256, 256, 0, stream.stream()>>>(
        reinterpret_cast<half*>(out.data_ptr<at::Half>()),
        reinterpret_cast<const nv_bfloat16*>(stock_prefix.data_ptr<at::BFloat16>()),
        prefix_mask.data_ptr<bool>(), b, h, nq);
    C10_CUDA_KERNEL_LAUNCH_CHECK();
  }
  return {out,lse};
}

std::vector<int64_t> ANEMOI_MIXED_RESOURCES(bool fp16) {
  auto kernel=fp16 ? mpa::attention::ANEMOI_MIXED_KERNEL<128,true,true,false>
                  : mpa::attention::ANEMOI_MIXED_KERNEL<128,true,false,false>;
  const int bytes=fp16?32768:25088;
  cudaFuncAttributes a{};
  C10_CUDA_CHECK(cudaFuncGetAttributes(&a,kernel));
  int active=0;
  C10_CUDA_CHECK(cudaOccupancyMaxActiveBlocksPerMultiprocessor(&active,kernel,128,bytes));
  return {a.numRegs,static_cast<int64_t>(a.sharedSizeBytes),bytes,active};
}
