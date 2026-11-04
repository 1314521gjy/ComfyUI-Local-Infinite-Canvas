// Modified further: separate G4 INT8/NVFP4 policies; original source attribution retained below.
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

// Sol-Attn exact branch: each query block walks its routed key-block list,
// resuming the online softmax (o/m/l) from route's handover.
//
// All-INT8 MMA. The PV A operand wants 4 consecutive keys per lane where the
// score C layout gives 2; sol::perm_key (applied host-side to K and its
// scales) makes the repack free: score n-tiles (4kk, 4kk+1) hold lane q's
// logical keys 32kk+4q..+3. sK and the K scales are indexed by PHYSICAL slot,
// sVt by LOGICAL key. K scales/bias are read straight from global ((ks, bias)
// of an adjacent column pair is one aligned 16 B load). Inputs are padded to
// Tp so the cp.async copies run unconditionally. The V scale and the 1/255 P
// scale are constant across key blocks and fold into the epilogue.

#include <cuda_runtime.h>
#include <cuda_bf16.h>
#include <cstdint>

#include "sol_layout.cuh"
#include "vc_group_pv.cuh"

namespace {
using namespace sol;

constexpr int HD = HEAD_DIM, BQ = BLOCK, BK = BLOCK;
constexpr int NWARP = BQ / 16, NTHREADS = NWARP * 32;
constexpr int KC = TILE_KC, NKT = TILE_NKT, NT = TILE_NT;   // tile shapes: sol_layout.cuh
constexpr int LDK = TILE_LDK, LDV = TILE_LDV;               // 128 B / 64 B rows, XOR-swizzled
constexpr int NSTAGE = 2;      // pipeline depth; occupancy beats depth here

// qi:  [B,T,H,D] int8
// qs:  [B,T,H] f32
// kiP: [B*H,Tp,D] int8 (perm_key + perm_d)   ksb: [B*H,Tp] float2 = (ks, bias)
// vTi: [B*H,D,Tp] int8 (transposed; perm_d on keys, no perm_key)   vsc: [B*H,D] f32
// sm_120 fits 3 blocks/SM without spilling; sm_89 would spill, so Ada is unbounded.
#define SOL_EXACT_BOUNDS __launch_bounds__(NTHREADS)

template <bool FP4>
__global__ void SOL_EXACT_BOUNDS vc_group_exact_kernel(
    const int8_t* __restrict__ qi, const float* __restrict__ qs,
    const int8_t* __restrict__ kiP, const float2* __restrict__ ksb,
    const int8_t* __restrict__ vTi, const float* __restrict__ vsc,
    const uint16_t* __restrict__ blk_idx, const int32_t* __restrict__ blk_cnt,
    const __nv_bfloat16* __restrict__ o_part, const float* __restrict__ m_part,
    const float* __restrict__ l_part,
    const int8_t* grouped_k, const float2* grouped_ksb,
    const uint8_t* scale_codes, const float* global_scale,
    __nv_bfloat16* __restrict__ out,
    int T, int Tp, int H, int NTB, float scale_log2,
    const int8_t* rTi, const __nv_bfloat16* rmean, const float* rscale,
    int sink_s, int sink_e, int sink_qs, int sink_qe)
{
#if SOL_SM80
    __shared__ __align__(16) int8_t sK[NSTAGE * BK * LDK];
    __shared__ __align__(16) int8_t sVt[NSTAGE * HD * LDV];
#define SK(b)   (sK   + (size_t)(b) * BK * LDK)
#define SVT(b)  (sVt  + (size_t)(b) * HD * LDV)

    const int tid = threadIdx.x, warp = tid >> 5, lane = tid & 31;
    const int g = lane >> 2, qd = lane & 3;
    const int q_block = blockIdx.x, bh = blockIdx.y;
    const bool protected_q = q_block >= sink_qs && q_block < sink_qe;
    const int batch = bh / H, head = bh % H;
    const int64_t bh_base = (int64_t)batch * T * H * HD + (int64_t)head * HD;
    const int64_t bh_s    = (int64_t)batch * T * H + head;
    const int64_t vT_base = (int64_t)bh * HD * Tp;
    const int64_t vsc_base = (int64_t)bh * HD;
    const int64_t kp_base = (int64_t)bh * Tp;   // pre-permuted K is [B*H, Tp, D]
    const int64_t kd_base = (int64_t)bh * Tp * HD;

    const int q_row0 = q_block * BQ + warp * 16 + g;

    uint32_t qa[KC][4];
    float qsc[2];
    {
        const int r0 = min(q_row0, T - 1), r1 = min(q_row0 + 8, T - 1);
        const int8_t* p0 = qi + bh_base + (int64_t)r0 * H * HD;
        const int8_t* p1 = qi + bh_base + (int64_t)r1 * H * HD;
        #pragma unroll
        for (int kc = 0; kc < KC; ++kc) {
            const int c0 = kc * 32 + qd * 8;      // perm_d put a0 and a2 side by side
            const uint2 a0 = *reinterpret_cast<const uint2*>(p0 + c0);
            const uint2 a1 = *reinterpret_cast<const uint2*>(p1 + c0);
            qa[kc][0] = a0.x; qa[kc][2] = a0.y;
            qa[kc][1] = a1.x; qa[kc][3] = a1.y;
        }
        qsc[0] = qs[bh_s + (int64_t)r0 * H] * scale_log2;
        qsc[1] = qs[bh_s + (int64_t)r1 * H] * scale_log2;
    }

    const uint16_t* my_idx = blk_idx + (int64_t)(bh * gridDim.x + q_block) * NTB;
    const int n_blocks = blk_cnt[bh * gridDim.x + q_block];

    // resume route's state: one (o, m, l) per (b, h, query block)
    float o_acc[NT][4];
    float m_r[2], l_r[2], c_r[2];   // c_r: scale o_acc / l_r are carried in
    {
        const int64_t qb_s = (int64_t)bh * gridDim.x + q_block;
        const __nv_bfloat16* orow = o_part + qb_s * HD;
        #pragma unroll
        for (int nt = 0; nt < NT; ++nt) {
            const int c = nt * 8 + qd * 2;
            const float v0 = __bfloat162float(orow[c]) * (protected_q ? 1.f : vsc[vsc_base + c]);
            const float v1 = __bfloat162float(orow[c + 1]) * (protected_q ? 1.f : vsc[vsc_base + c + 1]);
            o_acc[nt][0] = v0; o_acc[nt][2] = v0;
            o_acc[nt][1] = v1; o_acc[nt][3] = v1;
        }
        m_r[0] = m_r[1] = m_part[qb_s];
        c_r[0] = c_r[1] = m_part[qb_s];
        l_r[0] = l_r[1] = l_part[qb_s];
    }


    auto stage = [&](int kbi,int buf) {
        const bool stock=protected_q || (kbi>=sink_s && kbi<sink_e);
        const int8_t* keys=stock ? kiP : grouped_k;
        const int64_t k0=(int64_t)kbi*64;
        for(int idx=tid;idx<64*8;idx+=NTHREADS) {
            const int p=idx/8,c16=idx%8;
            cp_async16(SK(buf)+p*LDK+((c16^swz_k(p))<<4),
                       keys+kd_base+(k0+p)*HD+c16*16);
        }
        if(FP4 && !stock) {
            for(int idx=tid;idx<HD*2;idx+=NTHREADS) {
                const int c=idx/2,part=idx%2;
                cp_async16(SVT(buf)+c*32+part*16,
                    rTi+((int64_t)bh*HD+c)*(Tp/2)+k0/2+part*16);
            }
        } else {
            const int8_t* values=stock ? vTi : rTi;
            for(int idx=tid;idx<HD*4;idx+=NTHREADS) {
                const int c=idx/4,part=idx%4;
                cp_async16(SVT(buf)+c*LDV+((part^swz_v(c))<<4),
                    values+vT_base+(int64_t)c*Tp+k0+part*16);
            }
        }
    };
    #pragma unroll
    for (int st = 0; st < NSTAGE - 1; ++st) {
        if (st < n_blocks) {
            stage(my_idx[st], st);
        }
        cp_commit();
    }

    auto compute_tile = [&](int cur, const float2* kb_src, int key_block) {
        int32_t s_acc[NKT][4];
        tile_qk(SK(cur), qa, g, qd, s_acc);
        float p_val[NKT][4];
        float bmax[2] = {m_r[0] - 20.f, m_r[1] - 20.f};   // floor: 2^-20 under the running max
        bool has[2] = {true, true};                         // routed blocks always hold live keys
        tile_scores<true>(s_acc, kb_src, qsc, qd, p_val, bmax);

        const bool protected_k = key_block >= sink_s && key_block < sink_e;
        if(protected_q || protected_k) {
            tile_softmax_pv<false>(p_val,bmax,has,SVT(cur),g,qd,m_r,l_r,c_r,o_acc,
                                  protected_q ? nullptr : vsc+vsc_base,nullptr);
        } else {
            const size_t meta=((size_t)bh*NTB+key_block)*4*HD;
            vc::group_pv<FP4>(p_val,bmax,SVT(cur),g,qd,m_r,l_r,c_r,o_acc,
                rscale+meta,rmean+meta,scale_codes+meta,global_scale+vsc_base);
        }
    };

    for (int kb = 0; kb < n_blocks; ++kb) {
        const int cur = kb % NSTAGE;
        const int64_t cur_k0 = (int64_t)my_idx[kb] * BK;
        const int ahead = kb + NSTAGE - 1;
        if (ahead < n_blocks) {
            stage(my_idx[ahead], ahead % NSTAGE);
        }
        cp_commit();
        cp_wait<NSTAGE - 1>();
        __syncthreads();

        const bool stock=protected_q || (my_idx[kb]>=sink_s && my_idx[kb]<sink_e);
        compute_tile(cur, (stock ? ksb : grouped_ksb) + kp_base + cur_k0, my_idx[kb]);
        __syncthreads();   // next iteration refills `cur`
    }


    // l is zero only when a row got no mass from either branch; zeros are right there
    const float inv0 = 1.f / fmaxf(l_r[0], 1e-30f);
    const float inv1 = 1.f / fmaxf(l_r[1], 1e-30f);
    #pragma unroll
    for (int rr = 0; rr < 2; ++rr) {
        const int r = q_row0 + rr * 8;
        if (r >= T) continue;
        const float inv = rr ? inv1 : inv0;
        __nv_bfloat16* orow = out + bh_base + (int64_t)r * H * HD;
        #pragma unroll
        for (int nt = 0; nt < NT; ++nt) {
            const int c = nt * 8 + qd * 2;
            orow[c]     = from_f32<__nv_bfloat16>(o_acc[nt][rr * 2]     * inv * (protected_q ? vsc[vsc_base + c] : 1.f));
            orow[c + 1] = from_f32<__nv_bfloat16>(o_acc[nt][rr * 2 + 1] * inv * (protected_q ? vsc[vsc_base + c + 1] : 1.f));
        }
    }
#endif  // SOL_SM80
}

}  // namespace


cudaError_t vc_group_fine_attributes(cudaFuncAttributes* a,int fp4) {
    return fp4 ? cudaFuncGetAttributes(a,vc_group_exact_kernel<true>)
               : cudaFuncGetAttributes(a,vc_group_exact_kernel<false>);
}
void launch_vc_group_fine(const void* qi,const void* qs,const void* ki,const void* ksb,
    const void* v,const void* vs,const void* ids,const void* counts,
    const void* o,const void* m,const void* l,const void* gk,const void* gksb,
    const void* residual,const void* means,const void* scales,const void* codes,const void* gv,
    void* out,int T,int Tp,int H,int N,float log2s,int ss,int se,int sqs,int sqe,int fp4,cudaStream_t stream) {
#define LAUNCH(FP4) vc_group_exact_kernel<FP4><<<dim3(N,H),NTHREADS,0,stream>>>( \
    (const int8_t*)qi,(const float*)qs,(const int8_t*)ki,(const float2*)ksb, \
    (const int8_t*)v,(const float*)vs,(const uint16_t*)ids,(const int32_t*)counts, \
    (const __nv_bfloat16*)o,(const float*)m,(const float*)l, \
    (const int8_t*)gk,(const float2*)gksb,(const uint8_t*)codes,(const float*)gv, \
    (__nv_bfloat16*)out,T,Tp,H,N,log2s,(const int8_t*)residual, \
    (const __nv_bfloat16*)means,(const float*)scales,ss,se,sqs,sqe)
    if(fp4) LAUNCH(true);
    else LAUNCH(false);
#undef LAUNCH
}
