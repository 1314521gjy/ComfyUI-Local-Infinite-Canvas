// Native output boundary for the isolated Anemoi attention kernels.
// Converts contiguous BHSD FP16 attention output to BSHD BF16 and, when
// supplied, applies Kitchen's already-computed coarse gated correction in the
// same store.  The Python fallback keeps the original rounding/order when an
// older artifact is loaded.
#include <torch/extension.h>
#include <ATen/cuda/CUDAContext.h>
#include <c10/cuda/CUDAException.h>
#include <c10/cuda/CUDAGuard.h>

#include <cuda_bf16.h>
#include <cuda_fp16.h>

#include <cstdint>

namespace {

template <typename Gate>
__global__ void output_epilogue_kernel(
    const half* __restrict__ fine,
    const float* __restrict__ coarse,
    const Gate* __restrict__ gate,
    nv_bfloat16* __restrict__ output,
    uint32_t batch,
    uint32_t heads,
    uint32_t source_tokens,
    uint32_t output_tokens,
    uint32_t blocks,
    bool has_coarse, const nv_bfloat16* stock_prefix,
    uint32_t prefix_start, uint32_t prefix_end) {
  const uint64_t index = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  const uint64_t elements = static_cast<uint64_t>(batch) * output_tokens * heads * 128;
  if (index >= elements) return;

  const uint32_t d = index % 128;
  const uint64_t output_row = index / 128;
  const uint32_t head = output_row % heads;
  const uint64_t token_row = output_row / heads;
  const uint32_t token = token_row % output_tokens;
  const uint32_t sample = token_row / output_tokens;

  const uint64_t fine_index =
      ((static_cast<uint64_t>(sample) * heads + head) * source_tokens + token) * 128 + d;
  const bool protected_row = stock_prefix && token >= prefix_start && token < prefix_end;
  float value = protected_row ? __bfloat162float(stock_prefix[index])
      : __bfloat162float(__float2bfloat16_rn(__half2float(fine[fine_index])));
  if (has_coarse) {
    const uint64_t coarse_index =
        ((static_cast<uint64_t>(sample) * heads + head) * blocks + token / 64) * 128 + d;
    const uint64_t gate_index =
        ((static_cast<uint64_t>(sample) * output_tokens + token) * heads + head) * 128 + d;
    value += static_cast<float>(gate[gate_index]) * coarse[coarse_index];
  }
  output[index] = __float2bfloat16_rn(value);
}

template <typename Gate>
void launch_output_epilogue(
    const torch::Tensor& fine,
    const torch::Tensor& coarse,
    const torch::Tensor& gate,
    torch::Tensor& output,
    bool has_coarse,
    int64_t output_tokens, const torch::Tensor& prefix,
    int64_t prefix_start, int64_t prefix_end) {
  const auto stream = at::cuda::getCurrentCUDAStream(fine.get_device());
  const auto elements = static_cast<uint64_t>(fine.size(0)) * output_tokens * fine.size(1) * 128;
  output_epilogue_kernel<Gate><<<(elements + 255) / 256, 256, 0, stream.stream()>>>(
      reinterpret_cast<const half*>(fine.data_ptr<at::Half>()),
      has_coarse ? coarse.data_ptr<float>() : nullptr,
      has_coarse ? reinterpret_cast<const Gate*>(gate.data_ptr()) : nullptr,
      reinterpret_cast<nv_bfloat16*>(output.data_ptr<at::BFloat16>()),
      fine.size(0), fine.size(1), fine.size(2), output_tokens,
      has_coarse ? coarse.size(2) : (output_tokens + 63) / 64, has_coarse,
      prefix.numel() ? reinterpret_cast<const nv_bfloat16*>(prefix.data_ptr()) : nullptr,
      prefix_start * 64, prefix_end * 64);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
}

}  // namespace

static torch::Tensor output_epilogue_impl(
    torch::Tensor fine, torch::Tensor coarse, torch::Tensor gate,
    int64_t output_tokens, torch::Tensor prefix, int64_t prefix_start, int64_t prefix_end) {
  TORCH_CHECK(fine.is_cuda() && fine.is_contiguous() && fine.scalar_type() == at::kHalf,
              "fine output must be contiguous CUDA FP16 [B,H,T,128]");
  TORCH_CHECK(fine.dim() == 4 && fine.size(0) > 0 && fine.size(1) > 0 &&
              fine.size(2) > 0 && fine.size(3) == 128 && output_tokens > 0 &&
              output_tokens <= fine.size(2),
              "fine output must have shape [B,H,T,128]");
  const bool has_coarse = coarse.numel() != 0 || gate.numel() != 0;
  TORCH_CHECK(prefix_start >= 0 && prefix_start <= prefix_end &&
              prefix_end <= (output_tokens + 63) / 64, "invalid direct prefix interval");
  if (prefix.numel()) {
    TORCH_CHECK(prefix.is_contiguous() && prefix.scalar_type() == at::kBFloat16 &&
                prefix.device() == fine.device() && prefix.dim() == 4 &&
                prefix.size(0) == fine.size(0) && prefix.size(1) == output_tokens &&
                prefix.size(2) == fine.size(1) && prefix.size(3) == 128,
                "direct prefix must be contiguous BSHD BF16 on output device");
  } else {
    TORCH_CHECK(prefix_start == prefix_end, "nonempty prefix interval requires original output");
  }
  if (has_coarse) {
    TORCH_CHECK(coarse.is_cuda() && coarse.is_contiguous() &&
                coarse.scalar_type() == at::kFloat && coarse.dim() == 4 &&
                coarse.size(0) == fine.size(0) && coarse.size(1) == fine.size(1) &&
                coarse.size(2) >= (output_tokens + 63) / 64 && coarse.size(3) == 128,
                "coarse must be contiguous CUDA FP32 [B,H,blocks,128]");
    TORCH_CHECK(gate.is_cuda() && gate.is_contiguous() && gate.dim() == 4 &&
                gate.size(0) == fine.size(0) && gate.size(1) == output_tokens &&
                gate.size(2) == fine.size(1) && gate.size(3) == 128 &&
                (gate.scalar_type() == at::kBFloat16 || gate.scalar_type() == at::kFloat),
                "coarse gate must be contiguous CUDA BF16/FP32 [B,T,H,128]");
    TORCH_CHECK(coarse.device() == fine.device() && gate.device() == fine.device(),
                "output epilogue tensors must share a CUDA device");
  } else {
    TORCH_CHECK(coarse.numel() == 0 && gate.numel() == 0,
                "coarse and gate must be both empty or both populated");
  }
  c10::cuda::CUDAGuard guard(fine.device());
  auto output = torch::empty(
      {fine.size(0), output_tokens, fine.size(1), 128},
      fine.options().dtype(at::kBFloat16));
  if (has_coarse && gate.scalar_type() == at::kFloat) {
    launch_output_epilogue<float>(fine, coarse, gate, output, true, output_tokens,
                                 prefix, prefix_start, prefix_end);
  } else {
    launch_output_epilogue<nv_bfloat16>(fine, coarse, gate, output, has_coarse, output_tokens,
                                       prefix, prefix_start, prefix_end);
  }
  return output;
}

// Existing symbol/signature retained; optional export requires explicit feature probing.
torch::Tensor output_epilogue(torch::Tensor fine, torch::Tensor coarse,
                             torch::Tensor gate, int64_t tokens) {
  return output_epilogue_impl(fine, coarse, gate, tokens, fine.new_empty({0}), 0, 0);
}
torch::Tensor output_epilogue_prefix(torch::Tensor fine, torch::Tensor coarse,
    torch::Tensor gate, int64_t tokens, torch::Tensor prefix, int64_t start, int64_t end) {
  return output_epilogue_impl(fine, coarse, gate, tokens, prefix, start, end);
}
