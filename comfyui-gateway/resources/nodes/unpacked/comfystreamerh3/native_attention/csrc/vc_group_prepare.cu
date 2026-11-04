// SPDX-License-Identifier: Apache-2.0
// Deterministic cube-local clustering. Original routing/coarse buffers are read-only.
#include <cuda_runtime.h>
#include <cuda_bf16.h>
#include <cuda_fp4.h>
#include <cuda_fp8.h>
#include "sol_layout.cuh"

namespace {
using namespace sol;
__global__ void grouped_prepare(
    const __nv_bfloat16* qkv, const int8_t* original_k, const float2* original_ksb,
    const int32_t* lengths, int8_t* grouped_k, float2* grouped_ksb,
    uint8_t* residual, __nv_bfloat16* means, float* scales, uint8_t* scale_codes,
    uint8_t* permutation, unsigned long long* clipping, const float* global_vscale,
    int t0, int M, int T, int Tp, int H, int sink_s, int sink_e,
    int reuse, int center, int fp4)
{
    __shared__ __nv_bfloat16 values[64][130]; // avoid row-distance shared-bank conflicts
    __shared__ float centers[4][128];
    __shared__ int labels[64], order[64];
    const int d=threadIdx.x, local=blockIdx.x, h=blockIdx.y;
    const int block=t0/64+local, n=(T+63)/64;
    const int count=min(block_len_of(lengths,block,T),M-local*64);
    const bool protected_k=block>=sink_s && block<sink_e;
    const size_t meta=((size_t)h*n+block)*4*128;
    uint8_t* perm=permutation+((size_t)h*n+block)*64;
    for(int r=0;r<64;++r)
        values[r][d]=r<count ? qkv[((size_t)local*64+r)*3*H*128+(2*H+h)*128+d]
                            : __float2bfloat16(0.f);
    __syncthreads();
    if (reuse || protected_k) {
        if(d<64) order[d]=protected_k ? d : (int)perm[d];
    } else {
        // Fixed seeds, fixed iteration count, lowest-cluster tie, stable token tie.
        for(int g=0;g<4;++g)
            centers[g][d]=__bfloat162float(values[g*(count-1)/3][d]);
        __syncthreads();
        for(int iteration=0;iteration<4;++iteration) {
            if(d<64) {
                int best=4;
                // CUDA 13 no longer exposes CUDART_INF_F from the headers
                // used by the builder.  The clustering distance is finite
                // and non-negative, so the IEEE-754 max finite value is a
                // portable device-side initial sentinel.
                float distance=3.402823466e+38F;
                if(d<count) for(int g=0;g<4;++g) {
                    float dist=0.f;
                    for(int c=0;c<128;++c) {
                        float delta=__bfloat162float(values[d][c])-centers[g][c];
                        dist=__fadd_rn(dist,__fmul_rn(delta,delta));
                    }
                    if(dist<distance) {distance=dist;best=g;}
                }
                labels[d]=best;
            }
            __syncthreads();
            for(int g=0;g<4;++g) {
                float sum=0.f; int members=0;
                for(int r=0;r<count;++r) if(labels[r]==g) {
                    sum=__fadd_rn(sum,__bfloat162float(values[r][d])); ++members;
                }
                if(members) centers[g][d]=sum/(float)members; // empty cluster keeps seed
            }
            __syncthreads();
        }
        if(d<64) {
            int rank=0;
            for(int r=0;r<64;++r)
                rank += labels[r]<labels[d] || (labels[r]==labels[d] && r<d);
            order[rank]=d;
        }
    }
    __syncthreads();
    if(d<64) perm[d]=(uint8_t)order[d];
    // K/ksb copies are lossless. Physical Kitchen key permutation is preserved.
    for(int r=0;r<64;++r) {
        const int source=perm_key_inv(order[r]), destination=perm_key_inv(r);
        const size_t src=(size_t)h*Tp+block*64+source;
        const size_t dst=(size_t)h*Tp+block*64+destination;
        grouped_k[dst*128+d]=original_k[src*128+d];
        if(d==0) grouped_ksb[dst]=original_ksb[src];
    }
    const float gv=fp4 ? global_vscale[h*128+d] : 1.f;
    const float global_limit=__fmul_rn(gv,2688.f);
    int clipped_values=0, saturated_scales=0;
    for(int group=0;group<4;++group) {
        const int live=max(0,min(16,count-group*16));
        float sum=0.f;
        for(int i=0;i<live;++i) sum=__fadd_rn(sum,__bfloat162float(values[order[group*16+i]][d]));
        __nv_bfloat16 represented=__float2bfloat16(center && !protected_k && live ? sum/live : 0.f);
        float mean=__bfloat162float(represented), maximum=0.f;
        bool nonfinite_group=false;
        for(int i=0;i<live;++i) {
            const float value=__bfloat162float(values[order[group*16+i]][d])-mean;
            nonfinite_group |= !isfinite(value);
            maximum=fmaxf(maximum,fabsf(value));
        }
        float scale=fmaxf(maximum/127.f,1e-8f);
        if(fp4) {
            saturated_scales += !protected_k && (nonfinite_group || maximum>global_limit);
            __nv_fp8_e4m3 encoded;
            encoded.__x=__nv_cvt_float_to_fp8(maximum/(6.f*gv),__NV_SATFINITE,__NV_E4M3);
            scale_codes[(((size_t)h*n+block)*128+d)*4+group]=encoded.__x;
            scale=(float)encoded*gv;
        }
        means[meta+group*128+d]=represented;
        scales[meta+group*128+d]=scale;
        if(fp4) {
            for(int i=0;i<16;i+=2) {
                float lo=i<live ? __bfloat162float(values[order[group*16+i]][d])-mean : 0.f;
                float hi=i+1<live ? __bfloat162float(values[order[group*16+i+1]][d])-mean : 0.f;
                if(!protected_k) {
                    clipped_values += !isfinite(lo) || fabsf(lo)>global_limit;
                    clipped_values += !isfinite(hi) || fabsf(hi)>global_limit;
                }
                const uint8_t pair=scale>0.f ? __nv_cvt_float2_to_fp4x2(
                    make_float2(lo/scale,hi/scale),__NV_E2M1,cudaRoundNearest) : 0;
                residual[((size_t)h*128+d)*(Tp/2)+block*32+group*8+i/2]=pair;
            }
        } else {
            for(int i=0;i<16;++i) {
                const int row=group*16+i;
                int8_t code=i<live ? q8(__bfloat162float(values[order[row]][d])-mean,1.f/scale) : 0;
                residual[((size_t)h*128+d)*Tp+block*64+perm_d(row)]=(uint8_t)code;
            }
        }
    }
    if(fp4) {
        const float clipped=block_sum128((float)clipped_values,&centers[0][0]);
        __syncthreads();
        const float saturated=block_sum128((float)saturated_scales,&centers[0][0]);
        if(d==0) {
            atomicAdd(clipping,(unsigned long long)clipped);
            atomicAdd(clipping+1,(unsigned long long)saturated);
        }
    }
}

__global__ void original_scores(const int8_t* q, const float* qs,
    const int8_t* k, const float* ks, float* out, int N, int NPAD, float log2s) {
    const int key=blockIdx.x*blockDim.x+threadIdx.x;
    const int query=blockIdx.y, head=blockIdx.z;
    if(key>=N) return;
    int32_t dot=0;
    for(int d=0;d<128;++d)
        dot+=(int32_t)q[((size_t)head*N+query)*128+d] *
             (int32_t)k[((size_t)head*NPAD+key)*128+d];
    const float qscale=__fmul_rn(qs[head*N+query],log2s);
    out[((size_t)head*N+query)*N+key]=__fmul_rn(__fmul_rn((float)dot,qscale),ks[head*NPAD+key]);
}
}

void launch_vc_group_prepare(const void* qkv,const void* k,const void* ksb,const void* lengths,
    void* gk,void* gksb,void* residual,void* means,void* scales,void* codes,void* permutation,void* clipping,
    const void* gv,int t0,int M,int T,int Tp,int H,int ss,int se,int reuse,int center,int fp4,cudaStream_t stream) {
    grouped_prepare<<<dim3((M+63)/64,H),128,0,stream>>>(
        (const __nv_bfloat16*)qkv,(const int8_t*)k,(const float2*)ksb,(const int32_t*)lengths,
        (int8_t*)gk,(float2*)gksb,(uint8_t*)residual,(__nv_bfloat16*)means,(float*)scales,
        (uint8_t*)codes,(uint8_t*)permutation,(unsigned long long*)clipping,(const float*)gv,
        t0,M,T,Tp,H,ss,se,reuse,center,fp4);
}
void launch_original_route_scores(const void* q,const void* qs,const void* k,const void* ks,
    void* out,int H,int N,int NPAD,float log2s,cudaStream_t stream) {
    original_scores<<<dim3((N+127)/128,N,H),128,0,stream>>>(
        (const int8_t*)q,(const float*)qs,(const int8_t*)k,(const float*)ks,(float*)out,N,NPAD,log2s);
}
cudaError_t vc_group_prepare_attributes(cudaFuncAttributes* a) {
    return cudaFuncGetAttributes(a,grouped_prepare);
}
