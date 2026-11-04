// Modified for fasth3 native VC: cube residual preparation/real-unit PV, chunk hook, isolated ABI.
/*
 * SPDX-FileCopyrightText: Copyright (c) 2025 Comfy Org. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Sol-Attn chunked QKV producer: a token-major slice of the fused qkv
// projection ([M, 3*H*HD] bf16, B=1) -> the workspace carriers for those
// tokens, with RMSNorm + RoPE applied in-tile, so full bf16 Q/K/V never exist.
//
// K centering and V scaling use LAST step's kmean / V scale (range
// optimisations only: the per-token K scale absorbs any centering vector, the
// V scale carries a clip margin). Next-step statistics come from the pooled
// K sums (launch_sol_finish) and the vamax atomics here.

#include <cuda_runtime.h>
#include <cuda_bf16.h>
#include <cstdint>
#include <cassert>

#include "sol_layout.cuh"

namespace {
using namespace sol;

constexpr int HD = HEAD_DIM, BLK = BLOCK;

// One CTA per (64-token block, head); q, k, v pass through one staged tile.
// qkv row = [q | k | v], each H*HD wide.
__global__ void sol_producer_kernel(
    const __nv_bfloat16* __restrict__ qkv,   // [M, 3*H*HD], chunk at token t0
    const float* __restrict__ fab,           // [T, rot, 2] packed rope coeffs
    const __nv_bfloat16* __restrict__ qw, const __nv_bfloat16* __restrict__ kw,
    const float* __restrict__ kmean,         // [H, HD] stale (may be zeros)
    const float* __restrict__ vscale,        // [H, HD] stale V scale (may be ~0 -> margin)
    int8_t* __restrict__ qiP, float* __restrict__ qs,
    int8_t* __restrict__ kiP, float2* __restrict__ ksb,
    int8_t* __restrict__ vTi, int8_t* __restrict__ vRow, __nv_bfloat16* __restrict__ vcT,
    float* __restrict__ ksumP,               // [H, NPAD, HD] block K sums (post-rope)
    int8_t* __restrict__ cen8, float* __restrict__ cens,
    float* __restrict__ qmean,               // [H, NPAD, HD] f32 block means (post-rope)
    float* __restrict__ vamax_next,          // [H, HD] atomicMax accumulator
    const int32_t* __restrict__ blen,        // [NTB] valid tokens per block, or null
    float rope_eps, int rot,
    int t0, int M, int T, int Tp, int H, int NPAD, int NQ,
    int8_t* rTi, __nv_bfloat16* rmean, float* rscale,
    __nv_bfloat16* hook_q, __nv_bfloat16* hook_k, __nv_bfloat16* hook_v, int center_values)
{
    __shared__ __align__(16) __nv_bfloat16 sT[BLK * LD_TILE];
    __shared__ __align__(16) float sred[HD];
    const int blk_local = blockIdx.x, h = blockIdx.y, tid = threadIdx.x;
    const int tb0 = t0 + blk_local * BLK;              // absolute token start
    if (tb0 >= T) return;
    const int nblk = tb0 / BLK;                        // global 64-block index
    const int nrows = min(BLK, min(M - blk_local * BLK, T - tb0));   // rows that exist
    const int len = min(block_len_of(blen, nblk, T), nrows);         // rows that are live
    if (len <= 0) return;
    const int64_t row_stride = (int64_t)3 * H * HD;
    const __nv_bfloat16* rows = qkv + (int64_t)(blk_local * BLK) * row_stride;
    const float* fab_t0 = fab + (int64_t)tb0 * (rot * 2);

    // ---------------- Q phase ----------------
    stage_tile64(sT, rows + (int64_t)h * HD, row_stride, len);
    __syncthreads();
    norm_rope_rows(sT, LD_TILE, len, fab_t0, qw, rope_eps, rot);
    __syncthreads();
    if (hook_q) {
        for (int r = 0; r < nrows; ++r)
            hook_q[((size_t)h * M + blk_local * BLK + r) * HD + tid] =
                r < len ? sT[r * LD_TILE + tid] : __float2bfloat16(0.f);
    }
    if (qiP && qs) {
        quant_q_rows(sT, len, nrows, qiP + ((size_t)tb0 * H + h) * HD,
                     qs + (size_t)tb0 * H + h, H);
    }
    // The next phase reuses sT.  This barrier is required even for
    // statistics-only passes that skip Q quantization.
    __syncthreads();
    if (cen8 && cens && qmean) {
        const size_t qrow = (size_t)h * NQ + nblk;
        const float c = centroid_quant(sT, len, sred, cen8 + qrow * HD, cens + qrow);
        qmean[((size_t)h * NPAD + nblk) * HD + tid] = c;
    }
    __syncthreads();

    // ---------------- K phase ----------------
    stage_tile64(sT, rows + (int64_t)(H + h) * HD, row_stride, len);
    __syncthreads();
    norm_rope_rows(sT, LD_TILE, len, fab_t0, kw, rope_eps, rot);
    __syncthreads();
    if (hook_k) {
        for (int r = 0; r < nrows; ++r)
            hook_k[((size_t)h * M + blk_local * BLK + r) * HD + tid] =
                r < len ? sT[r * LD_TILE + tid] : __float2bfloat16(0.f);
    }
    {
        // block K sums (post-rope, uncentered) for the pooled tensors
        float sk = 0.f;
        for (int t = 0; t < len; ++t) sk += __bfloat162float(sT[t * LD_TILE + tid]);
        ksumP[((size_t)h * NPAD + nblk) * HD + tid] = sk;
    }
    const size_t dst0 = (size_t)h * Tp + nblk * BLK;
    if (kiP && ksb) {
        quant_k_rows(sT, len, kmean + (size_t)h * HD, nullptr,
                     kiP + dst0 * HD, ksb + dst0);
    }
    // The V stage overwrites sT, so skipped K quantization must still join
    // every producer thread before the shared tile is reused.
    __syncthreads();

    // ---------------- V phase ----------------
    stage_tile64(sT, rows + (int64_t)(2 * H + h) * HD, row_stride, len);
    __syncthreads();
    {
        const int d = tid;
        if (hook_v) {
            for (int r = 0; r < nrows; ++r)
                hook_v[((size_t)h * M + blk_local * BLK + r) * HD + d] =
                    r < len ? sT[r * LD_TILE + d] : __float2bfloat16(0.f);
        }
        const bool write_v = vTi != nullptr;
        const bool write_residual = rTi && rmean && rscale;
        const float inv = write_v ? 1.f / vscale[(size_t)h * HD + d] : 0.f;
        float sv = 0.f, av = 0.f;
        // vTi: raw channel rows, perm_d on the KEY axis per 64-block
        __align__(16) int8_t col[BLK];
        for (int t = 0; t < BLK; ++t) {
            const float x = (t < len) ? __bfloat162float(sT[t * LD_TILE + d]) : 0.f;
            sv += x; av = fmaxf(av, fabsf(x));
            if (write_v) {
                col[perm_d(t)] = q8(x, inv);
                if (vRow) vRow[((size_t)h * Tp + nblk * BLK + t) * HD + d] = col[perm_d(t)];   // row-major copy (token routing)
            }
        }
        if (write_v) {
            const size_t vbase = ((size_t)h * HD + d) * Tp + nblk * BLK;
            #pragma unroll
            for (int c = 0; c < BLK; c += 16)
                *reinterpret_cast<uint4*>(vTi + vbase + c) = *reinterpret_cast<const uint4*>(col + c);
        }
        if (vcT) vcT[((size_t)h * HD + d) * NPAD + nblk] = __float2bfloat16(sv);
        // Original sums/absmax above are independent of the VC carrier.
        if (write_residual) {
            const __nv_bfloat16 mu = __float2bfloat16(center_values ? sv / (float)len : 0.f);
            const float mean = __bfloat162float(mu);
            float residual_max = 0.f;
            for (int t = 0; t < len; ++t)
                residual_max = fmaxf(residual_max, fabsf(__bfloat162float(sT[t * LD_TILE + d]) - mean));
            const float rs = fmaxf(residual_max / 127.f, 1e-8f);
            const size_t meta = ((size_t)h * NQ + nblk) * HD + d;
            rmean[meta] = mu;
            rscale[meta] = rs;
            for (int t = 0; t < BLK; ++t)
                col[perm_d(t)] = t < len ? q8(__bfloat162float(sT[t * LD_TILE + d]) - mean, 1.f / rs) : 0;
            const size_t vbase = ((size_t)h * HD + d) * Tp + nblk * BLK;
            #pragma unroll
            for (int c = 0; c < BLK; c += 16)
                *reinterpret_cast<uint4*>(rTi + vbase + c) = *reinterpret_cast<const uint4*>(col + c);
        }
        atomicMax(reinterpret_cast<unsigned int*>(&vamax_next[(size_t)h * HD + d]),
                  __float_as_uint(av));
    }
}

}  // namespace

cudaError_t na_producer_attributes(cudaFuncAttributes* attributes) {
    return cudaFuncGetAttributes(attributes, sol_producer_kernel);
}

void launch_sol_producer(
    const void* qkv, const void* fab, const void* qw, const void* kw,
    const void* kmean, const void* vscale,
    void* qiP, void* qs, void* kiP, void* ksb, void* vTi, void* vRow, void* vcT,
    void* ksumP, void* cen8, void* cens, void* qmean, void* vamax_next,
    const void* blen, float rope_eps, int rot,
    int t0, int M, int T, int Tp, int H, int NPAD, int NQ,
    void* rTi, void* rmean, void* rscale,
    void* hook_q, void* hook_k, void* hook_v, int center_values, cudaStream_t stream)
{
    const int nblocks = (M + BLK - 1) / BLK;
    sol_producer_kernel<<<dim3(nblocks, H), HD, 0, stream>>>(
        (const __nv_bfloat16*)qkv, (const float*)fab,
        (const __nv_bfloat16*)qw, (const __nv_bfloat16*)kw,
        (const float*)kmean, (const float*)vscale,
        (int8_t*)qiP, (float*)qs, (int8_t*)kiP, (float2*)ksb,
        (int8_t*)vTi, (int8_t*)vRow, (__nv_bfloat16*)vcT, (float*)ksumP,
        (int8_t*)cen8, (float*)cens, (float*)qmean, (float*)vamax_next,
        (const int32_t*)blen, rope_eps, rot, t0, M, T, Tp, H, NPAD, NQ,
        (int8_t*)rTi, (__nv_bfloat16*)rmean, (float*)rscale,
        (__nv_bfloat16*)hook_q, (__nv_bfloat16*)hook_k, (__nv_bfloat16*)hook_v, center_values);
}

// Additive masked-retile ABI v1. Kept in this already-built translation unit;
// source_hashes() therefore binds it to the packaged library automatically.
namespace {
template <typename Bits, typename Index>
__global__ void masked_retile_kernel(
    const Bits* __restrict__ x, const Index* __restrict__ ids,
    Bits* __restrict__ output, int64_t source_n, int64_t width,
    int64_t rows, int64_t start, int64_t ids_stride,
    int64_t x_row_stride, int64_t x_column_stride)
{
    const int64_t total = rows * width;
    for (int64_t linear = int64_t(blockIdx.x) * blockDim.x + threadIdx.x;
         linear < total; linear += int64_t(gridDim.x) * blockDim.x) {
        const int64_t out_row = linear / width;
        const int64_t column = linear % width;
        const int64_t source = int64_t(ids[(start + out_row) * ids_stride]);
        Bits value{};
        if (source >= 0) {
            // Never perform an OOB load even if assertions are disabled. The
            // Python seam queues an async bounds assertion before this launch;
            // keeping the zero value here makes the output deterministic for
            // defensive builds where device assertions are compiled out.
            assert(source < source_n);
            if (source < source_n)
                value = x[source * x_row_stride + column * x_column_stride];
        }
        output[linear] = value;
    }
}

template <typename Bits>
cudaError_t launch_masked_retile(
    const void* x, const void* ids, void* output,
    int64_t source_n, int64_t width, int64_t rows, int64_t start,
    int64_t ids_stride, int64_t x_row_stride, int64_t x_column_stride,
    int index_bytes, cudaStream_t stream)
{
    const int64_t blocks_needed = (rows * width - 1) / 256 + 1;
    const int blocks = int(blocks_needed < 65535 ? blocks_needed : 65535);
    if (index_bytes == 4) {
        masked_retile_kernel<Bits, int32_t><<<blocks, 256, 0, stream>>>(
            static_cast<const Bits*>(x), static_cast<const int32_t*>(ids),
            static_cast<Bits*>(output), source_n, width, rows, start,
            ids_stride, x_row_stride, x_column_stride);
    } else {
        masked_retile_kernel<Bits, int64_t><<<blocks, 256, 0, stream>>>(
            static_cast<const Bits*>(x), static_cast<const int64_t*>(ids),
            static_cast<Bits*>(output), source_n, width, rows, start,
            ids_stride, x_row_stride, x_column_stride);
    }
    return cudaPeekAtLastError();
}
} // namespace

extern "C" int na_masked_retile_version() { return 1; }

extern "C" int na_masked_retile(
    const void* x, const void* ids, void* output,
    int64_t source_n, int64_t width, int64_t rows, int64_t start,
    int64_t ids_stride, int64_t x_row_stride, int64_t x_column_stride,
    int index_bytes, int element_bytes, void* stream_ptr)
{
    if (!x || !ids || !output || source_n <= 0 || width <= 0 || rows <= 0
        || start < 0 || ids_stride < 0 || x_row_stride < 0 || x_column_stride < 0
        || rows > INT64_MAX / width || (index_bytes != 4 && index_bytes != 8)) {
        return int(cudaErrorInvalidValue);
    }
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(stream_ptr);
    #define RETILE_CASE(N, T) case N: return int(launch_masked_retile<T>( \
        x, ids, output, source_n, width, rows, start, ids_stride, \
        x_row_stride, x_column_stride, index_bytes, stream));
    switch (element_bytes) {
        RETILE_CASE(1, uint8_t)
        RETILE_CASE(2, uint16_t)
        RETILE_CASE(4, uint32_t)
        RETILE_CASE(8, uint64_t)
        RETILE_CASE(16, uint4)
        default: return int(cudaErrorInvalidValue);
    }
    #undef RETILE_CASE
}
