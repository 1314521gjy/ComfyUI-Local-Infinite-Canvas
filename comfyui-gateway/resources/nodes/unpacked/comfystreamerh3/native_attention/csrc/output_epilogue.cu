// Optional VC output epilogue. The fine kernel already writes [1,T,H,128]
// BF16 in source order. This pass applies Kitchen's one coarse correction in
// place, avoiding a separate Python addcmul launch without changing the
// coarse reduction or softmax arithmetic.
#include <cuda_bf16.h>
#include <cuda_runtime.h>

#include <cstdint>

namespace {

template <typename Gate>
__global__ void output_epilogue_kernel(
    const __nv_bfloat16* __restrict__ fine,
    const float* __restrict__ coarse,
    const Gate* __restrict__ gate,
    __nv_bfloat16* __restrict__ out,
    int tokens, int heads, int blocks) {
    constexpr int D = 128;
    const uint64_t index = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const uint64_t elements = static_cast<uint64_t>(tokens) * heads * D;
    if (index >= elements) return;
    const int d = static_cast<int>(index % D);
    const uint64_t row = index / D;
    const int head = static_cast<int>(row % heads);
    const int token = static_cast<int>(row / heads);
    const int block = token / 64;
    const uint64_t coarse_index =
        (static_cast<uint64_t>(head) * blocks + block) * D + d;
    const float value = __bfloat162float(fine[index]) +
        static_cast<float>(gate[index]) * coarse[coarse_index];
    out[index] = __float2bfloat16_rn(value);
}

template <typename Gate>
void launch_output_epilogue(
    const void* fine, const void* coarse, const void* gate, void* out,
    int tokens, int heads, int blocks, cudaStream_t stream) {
    const uint64_t elements = static_cast<uint64_t>(tokens) * heads * 128;
    output_epilogue_kernel<Gate><<<(elements + 255) / 256, 256, 0, stream>>>(
        static_cast<const __nv_bfloat16*>(fine),
        static_cast<const float*>(coarse), static_cast<const Gate*>(gate),
        static_cast<__nv_bfloat16*>(out), tokens, heads, blocks);
}

}  // namespace

extern "C" int na_output_epilogue(
    const void* fine, const void* coarse, const void* gate, void* out,
    int tokens, int heads, int blocks, int gate_float, cudaStream_t stream) {
    if (!fine || !coarse || !gate || !out || tokens <= 0 || heads <= 0 || blocks <= 0 ||
        blocks < (tokens + 63) / 64)
        return 1;
    if (gate_float) {
        launch_output_epilogue<float>(fine, coarse, gate, out, tokens, heads, blocks, stream);
    } else {
        launch_output_epilogue<__nv_bfloat16>(
            fine, coarse, gate, out, tokens, heads, blocks, stream);
    }
    return static_cast<int>(cudaGetLastError());
}
