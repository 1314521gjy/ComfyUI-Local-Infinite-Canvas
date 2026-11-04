#include "check.h"
#define MPA_CTA_Q 64
#define MPA_WARP_Q 16
#define MPA_K64_BLOCK_MODE 1
#define MPA_ATTENTION_KERNEL_ENTRY fasth3_anemoi_fp16_kernel
#define MPA_ATTENTION_LAUNCH_ENTRY fasth3_anemoi_fp16_launch
#include "../vendor/csrc/attention/cuda/sm120/q64_attention.cuh"

std::tuple<torch::Tensor,torch::Tensor> fp16_attention(
    torch::Tensor q,torch::Tensor k,torch::Tensor v,
    torch::Tensor ids,torch::Tensor counts,torch::Tensor valid,double scale,bool trusted) {
  TORCH_CHECK(q.dim()==4 && k.dim()==4,"Q/K must be [B,H,S,128]");
  const auto b=q.size(0),h=q.size(1),nq=q.size(2),nk=k.size(2);
  TORCH_CHECK(b>0 && h>0 && nq>0 && nk>0 && nq%64==0 && nk%64==0,"Q64/K64 required");
  check_tensor(q,q,at::kHalf,{b,h,nq,128});
  check_tensor(k,q,at::kHalf,{b,h,nk,128});
  check_tensor(v,q,at::kHalf,{b,h,nk,128});
  TORCH_CHECK(ids.device()==q.device(),"route device mismatch");
  TORCH_CHECK(std::isfinite(scale) && std::isfinite(static_cast<float>(scale)) &&
              static_cast<float>(scale)>0,"invalid softmax scale");
  c10::cuda::CUDAGuard guard(q.device());
  check_sm120(q);
  check_routes(ids,counts,valid,b,h,nq/64,nk/64,trusted);
  auto out=torch::zeros_like(q);
  auto lse=torch::full({b,h,nq},-INFINITY,q.options().dtype(at::kFloat));
  fasth3_anemoi_fp16_launch<128,false,true,false>(
      nullptr,nullptr,nullptr,reinterpret_cast<half*>(q.data_ptr<at::Half>()),
      reinterpret_cast<half*>(k.data_ptr<at::Half>()),reinterpret_cast<half*>(v.data_ptr<at::Half>()),
      nullptr,reinterpret_cast<half*>(out.data_ptr<at::Half>()),nullptr,nullptr,
      ids.data_ptr<int32_t>(),counts.data_ptr<int32_t>(),nullptr,nullptr,nullptr,
      valid.data_ptr<int32_t>(),lse.data_ptr<float>(),0,b,nq,nk,0,h,h,scale,
      at::cuda::getCurrentCUDAStream(q.get_device()));
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  return {out,lse};
}

std::vector<int64_t> fp16_resources() {
  constexpr int bytes=(64+64)*128*sizeof(half);
  auto kernel=mpa::attention::fasth3_anemoi_fp16_kernel<128,false,true,false>;
  cudaFuncAttributes a{};
  C10_CUDA_CHECK(cudaFuncGetAttributes(&a,kernel));
  int active=0;
  C10_CUDA_CHECK(cudaOccupancyMaxActiveBlocksPerMultiprocessor(&active,kernel,128,bytes));
  return {a.numRegs,static_cast<int64_t>(a.sharedSizeBytes),bytes,active};
}
