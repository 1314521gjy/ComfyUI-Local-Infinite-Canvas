// SPDX-License-Identifier: Apache-2.0
// NVFP4 instruction wrapper adapted from Copyright 2026 Anemoi Project Contributors.
// Kitchen QK score layout -> grouped PV. NVFP4 instruction form follows Anemoi's
// SM120 primitive (Anemoi Project Contributors, Apache-2.0; see G4.md).
#pragma once
#include <assert.h>
#include <cuda_fp4.h>
#include <cuda_fp8.h>
#include "sol_layout.cuh"

namespace vc {
__device__ __forceinline__ float e2_positive(uint32_t bits) {
    constexpr float values[8]={0.f,.5f,1.f,1.5f,2.f,3.f,4.f,6.f};
    return values[bits&7u];
}

// Every lane's scores are Kitchen's perm_key C-fragment. Shuffle both possible
// tiles before selecting: selecting the tile before shfl would use SOURCE qd
// and silently scramble keys. Output is natural key 32*half+8*qd+i.
template<int Half,int Row,int I>
__device__ __forceinline__ float natural_probability(const float (&p)[8][4],int qd) {
    constexpr int tile=4*Half+((I>>1)&1), e=2*Row+(I&1);
    const int source=(threadIdx.x&28)+2*(qd&1)+(I>>2);
    const float low=__shfl_sync(0xffffffffu,p[tile][e],source);
    const float high=__shfl_sync(0xffffffffu,p[tile+2][e],source);
    return qd<2 ? low : high;
}

__device__ __forceinline__ void mma_nvfp4(float (&d)[4],const uint32_t (&a)[4],
    const uint32_t (&b)[2],uint32_t sa,uint32_t sb) {
#if defined(__CUDA_ARCH__) && __CUDA_ARCH__ >= 1200
    const uint16_t byte_id=0,thread_id=0;
    asm volatile(
        "mma.sync.aligned.m16n8k64.row.col.kind::mxf4nvf4"
        ".block_scale.scale_vec::4X.f32.e2m1.e2m1.f32.ue4m3 "
        "{%0,%1,%2,%3}, {%4,%5,%6,%7}, {%8,%9}, "
        "{%10,%11,%12,%13}, {%14}, {%15,%16}, {%17}, {%18,%19};"
        : "=f"(d[0]),"=f"(d[1]),"=f"(d[2]),"=f"(d[3])
        : "r"(a[0]),"r"(a[1]),"r"(a[2]),"r"(a[3]),"r"(b[0]),"r"(b[1]),
          "f"(d[0]),"f"(d[1]),"f"(d[2]),"f"(d[3]),
          "r"(sa),"h"(byte_id),"h"(thread_id),"r"(sb),"h"(byte_id),"h"(thread_id));
#else
    asm volatile("trap;"); // host policy gate rejects NVFP4 on non-SM120 devices
#endif
}

template<int Half,int Row>
__device__ __forceinline__ uint32_t pack_probability(const float (&p)[8][4],int qd,
    uint32_t& scales,float (&mass)[4]) {
    float x[8]={
        natural_probability<Half,Row,0>(p,qd),natural_probability<Half,Row,1>(p,qd),
        natural_probability<Half,Row,2>(p,qd),natural_probability<Half,Row,3>(p,qd),
        natural_probability<Half,Row,4>(p,qd),natural_probability<Half,Row,5>(p,qd),
        natural_probability<Half,Row,6>(p,qd),natural_probability<Half,Row,7>(p,qd)};
    float maximum=0.f;
    #pragma unroll
    for(int i=0;i<8;++i) maximum=fmaxf(maximum,x[i]);
    maximum=fmaxf(maximum,__shfl_xor_sync(0xffffffffu,maximum,1));
    __nv_fp8_e4m3 encoded;
    encoded.__x=__nv_cvt_float_to_fp8(448.f*maximum,__NV_SATFINITE,__NV_E4M3);
    const float sp=(float)encoded;
    const float inv=sp>0.f ? 2688.f/sp : 0.f;
    uint32_t packed=0;
    #pragma unroll
    for(int pair=0;pair<4;++pair)
        packed|=(uint32_t)__nv_cvt_float2_to_fp4x2(
            make_float2(x[pair*2]*inv,x[pair*2+1]*inv),__NV_E2M1,cudaRoundNearest)<<(pair*8);
    float decoded=0.f;
    #pragma unroll
    for(int i=0;i<8;++i) decoded+=e2_positive(packed>>(4*i));
    // Same represented-P domain for PV, mean and denominator: U8-equivalent x255.
    decoded*=sp*(255.f/2688.f);
    decoded+=__shfl_xor_sync(0xffffffffu,decoded,1);
    const int quad=threadIdx.x&28;
    mass[2*Half]=__shfl_sync(0xffffffffu,decoded,quad);
    mass[2*Half+1]=__shfl_sync(0xffffffffu,decoded,quad+2);
    const uint32_t byte=(uint32_t)encoded.__x;
    scales|=__shfl_sync(0xffffffffu,byte,quad)<<(16*Half);
    scales|=__shfl_sync(0xffffffffu,byte,quad+2)<<(16*Half+8);
    return packed;
}

template<bool FP4>
__device__ __forceinline__ void group_pv(float (&p)[8][4],float (&maximum)[2],
    const int8_t* values,int g,int qd,float (&m)[2],float (&l)[2],float (&carried)[2],
    float (&out)[16][4],const float* scales,const __nv_bfloat16* means,
    const uint8_t* scale_codes,const float* global_scale) {
    #pragma unroll
    for(int off=1;off<=2;off<<=1) {
        maximum[0]=fmaxf(maximum[0],__shfl_xor_sync(0xffffffffu,maximum[0],off));
        maximum[1]=fmaxf(maximum[1],__shfl_xor_sync(0xffffffffu,maximum[1],off));
    }
    const float alpha[2]={exp2f(carried[0]-maximum[0]),exp2f(carried[1]-maximum[1])};
    #pragma unroll
    for(int r=0;r<2;++r) { carried[r]=maximum[r]; m[r]=fmaxf(m[r],maximum[r]); l[r]*=alpha[r]; }
    #pragma unroll
    for(int nt=0;nt<16;++nt)
        #pragma unroll
        for(int e=0;e<4;++e) out[nt][e]*=alpha[e>>1];
    #pragma unroll
    for(int nt=0;nt<8;++nt)
        #pragma unroll
        for(int e=0;e<4;++e)
            p[nt][e]=exp2f(p[nt][e]-(maximum[e>>1]-(FP4 ? 0.f : 7.99435344f)));
    if constexpr(FP4) {
        uint32_t ps[2]={0,0};
        float mass[2][4];
        uint32_t a[4]={
            pack_probability<0,0>(p,qd,ps[0],mass[0]),
            pack_probability<0,1>(p,qd,ps[1],mass[1]),
            pack_probability<1,0>(p,qd,ps[0],mass[0]),
            pack_probability<1,1>(p,qd,ps[1],mass[1])};
        const uint32_t sa=qd==0 ? ps[0] : ps[1];
        for(int r=0;r<2;++r) for(int group=0;group<4;++group) l[r]+=mass[r][group];
        #pragma unroll
        for(int nt=0;nt<16;++nt) {
            const int col=nt*8+g;
            const uint32_t* v=(const uint32_t*)(values+col*32);
            uint32_t b[2]={v[qd],v[qd+4]};
            const uint32_t sb=*(const uint32_t*)(scale_codes+col*4);
            float product[4]={0,0,0,0};
            mma_nvfp4(product,a,b,sa,sb);
            #pragma unroll
            for(int e=0;e<4;++e) {
                const int c=nt*8+qd*2+(e&1),row=e>>1;
                float contribution=product[e]*global_scale[c]*(255.f/2688.f);
                #pragma unroll
                for(int group=0;group<4;++group)
                    contribution=fmaf(mass[row][group],__bfloat162float(means[group*128+c]),contribution);
                out[nt][e]+=contribution;
            }
        }
    } else {
        uint32_t pa[2][4];
        #pragma unroll
        for(int kk=0;kk<2;++kk) {
            const int b=kk*4;
            pa[kk][0]=mma::pack_u8x4(p[b][0],p[b][1],p[b+1][0],p[b+1][1]);
            pa[kk][1]=mma::pack_u8x4(p[b][2],p[b][3],p[b+1][2],p[b+1][3]);
            pa[kk][2]=mma::pack_u8x4(p[b+2][0],p[b+2][1],p[b+3][0],p[b+3][1]);
            pa[kk][3]=mma::pack_u8x4(p[b+2][2],p[b+2][3],p[b+3][2],p[b+3][3]);
        }
        #pragma unroll
        for(int group=0;group<4;++group) {
            const int kk=group/2,half=group%2;
            uint32_t a[4]={0,0,0,0};
            a[half*2]=pa[kk][half*2]; a[half*2+1]=pa[kk][half*2+1];
            uint32_t mass[2]={__dp4a(a[half*2],0x01010101u,0u),
                              __dp4a(a[half*2+1],0x01010101u,0u)};
            for(int off=1;off<=2;off<<=1) {
                mass[0]+=__shfl_xor_sync(0xffffffffu,mass[0],off);
                mass[1]+=__shfl_xor_sync(0xffffffffu,mass[1],off);
            }
            l[0]+=(float)mass[0]; l[1]+=(float)mass[1];
            #pragma unroll
            for(int nt=0;nt<16;++nt) {
                const int col=nt*8+g;
                const int8_t* v=values+col*64+((qd&1)<<3)+(((kk*2+(qd>>1))^sol::swz_v(col))<<4);
                const uint2 vb=*(const uint2*)v;
                uint32_t b[2]={vb.x,vb.y}; int32_t product[4]={0,0,0,0};
                sol::mma_u8s8(product,a,b);
                for(int e=0;e<4;++e) {
                    const int c=nt*8+qd*2+(e&1);
                    float contribution=(float)product[e]*scales[group*128+c];
                    out[nt][e]+=fmaf((float)mass[e>>1],__bfloat162float(means[group*128+c]),contribution);
                }
            }
        }
    }
}
}
