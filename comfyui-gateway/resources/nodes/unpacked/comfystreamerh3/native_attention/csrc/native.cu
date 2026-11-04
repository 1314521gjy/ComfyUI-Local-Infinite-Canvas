// SPDX-License-Identifier: Apache-2.0
// Isolated C ABI; no C++ exceptions cross ctypes. No allocations or default stream.
#include <cuda_runtime.h>
#include <cstdint>
#include <stdexcept>
#include <string>
#include "launchers.h"
#include "vc_grouped.h"

cudaError_t na_producer_attributes(cudaFuncAttributes*);
cudaError_t na_route_attributes(cudaFuncAttributes*);
cudaError_t na_route_emit_attributes(cudaFuncAttributes*);
cudaError_t na_exact_attributes(cudaFuncAttributes*);
extern "C" int na_fine(void*, void*, int, int, float, int, int, int, int, int, cudaStream_t);

namespace {
thread_local std::string error;
void checked(cudaError_t code) {
    if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
}
struct Plan {
    int Tp, NTB, NPAD, NQ;
    size_t qiP, qs, kiP, ksb, vTi, vsc, kciP, kcs, vcT, thr, cen8, cens;
    size_t idx, cnt, oPart, mPart, lPart, statsV, qmean, rTi, rmean, rscale, scratch, total;
    Plan(int T, int H) {
        if (T <= 0 || H <= 0 || H > 65535 || T > 64 * 65535)
            throw std::runtime_error("unsupported T/H for native attention");
        NTB = (T + 63) / 64; Tp = NTB * 64; NPAD = (NTB + 63) / 64 * 64; NQ = NTB;
        size_t o = 0, h = H;
        auto take = [&](size_t n) { size_t s = o; o = (o + n + 15) & ~size_t(15); return s; };
        qiP = take(h*T*128); qs = take(h*T*4); kiP = take(h*Tp*128); ksb = take(h*Tp*8);
        vTi = take(h*128*Tp); vsc = take(h*128*4);
        kciP = take(h*NPAD*128); kcs = take(h*NPAD*4); vcT = take(h*128*NPAD*2);
        thr = take(h*NQ*4); cen8 = take(h*NQ*128); cens = take(h*NQ*4);
        idx = take(h*NQ*NTB*2); cnt = take(h*NQ*4);
        oPart = take(h*NQ*128*2); mPart = take(h*NQ*4); lPart = take(h*NQ*4);
        statsV = take(h*128*4); qmean = take(h*NPAD*128*4);
        rTi = take(h*128*Tp); rmean = take(h*NTB*128*2); rscale = take(h*NTB*128*4);
        scratch = take(sol_preprocess_scratch_bytes(1,H,NPAD)); total = o;
    }
};
#define TRY try {
#define DONE checked(cudaGetLastError()); error.clear(); return 0; } \
    catch (const std::exception& e) { error = e.what(); return -1; }
}

extern "C" const char* na_error() { return error.c_str(); }
extern "C" int na_abi_version() { return 3; }
extern "C" int na_resources(int64_t* out, int capacity) {
    TRY
    if (!out || capacity < 18) throw std::runtime_error("resource buffer too small");
    int device, limit;
    checked(cudaGetDevice(&device));
    checked(cudaDeviceGetAttribute(&limit, cudaDevAttrMaxSharedMemoryPerBlock, device));
    cudaFuncAttributes attrs[3];
    checked(na_producer_attributes(&attrs[0]));
    checked(na_route_attributes(&attrs[1]));
    checked(na_exact_attributes(&attrs[2]));
    for (int i=0;i<3;++i) {
        const auto& a=attrs[i];
        if (a.sharedSizeBytes > (size_t)limit || a.maxThreadsPerBlock < 128)
            throw std::runtime_error("compiled native attention kernel exceeds device resources");
        out[i*6]=a.sharedSizeBytes; out[i*6+1]=a.numRegs; out[i*6+2]=a.localSizeBytes;
        out[i*6+3]=a.maxThreadsPerBlock; out[i*6+4]=a.binaryVersion; out[i*6+5]=limit;
    }
    DONE
}
extern "C" int na_plan(int T, int H, int64_t* out, int capacity) {
    try {
        Plan p(T,H);
        const int64_t values[] = {p.Tp,p.NTB,p.NPAD,p.NQ,
            (int64_t)p.qiP,(int64_t)p.qs,(int64_t)p.kiP,(int64_t)p.ksb,
            (int64_t)p.vTi,(int64_t)p.vsc,(int64_t)p.kciP,(int64_t)p.kcs,
            (int64_t)p.vcT,(int64_t)p.thr,(int64_t)p.cen8,(int64_t)p.cens,
            (int64_t)p.idx,(int64_t)p.cnt,(int64_t)p.oPart,(int64_t)p.mPart,
            (int64_t)p.lPart,(int64_t)p.statsV,(int64_t)p.qmean,(int64_t)p.rTi,
            (int64_t)p.rmean,(int64_t)p.rscale,(int64_t)p.scratch,(int64_t)p.total};
        const int count = sizeof(values)/sizeof(values[0]);
        if (!out || capacity < count) throw std::runtime_error("plan buffer too small");
        for (int i=0;i<count;++i) out[i]=values[i];
        error.clear(); return 0;
    } catch (const std::exception& e) { error=e.what(); return -1; }
}
extern "C" int na_begin(void* workspace, int T, int H, cudaStream_t stream) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    checked(cudaMemsetAsync(w+p.vcT,0,(size_t)H*128*p.NPAD*2,stream));
    checked(cudaMemsetAsync(w+p.statsV,0,(size_t)H*128*4,stream));
    DONE
}
extern "C" int na_chunk(
    void* workspace, const void* qkv, const void* fab, const void* qw, const void* kw,
    const void* km, const void* vs, const void* blen,
    void* hook_q, void* hook_k, void* hook_v,
    float eps, int rot, int t0, int M, int T, int H, int center_values, cudaStream_t stream) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    if (t0 < 0 || M <= 0 || t0 % 64 || M > T-t0 || (t0+M<T && M%64))
        throw std::runtime_error("invalid chunk bounds/alignment");
    if (rot <= 0 || rot > 128 || rot % 8) throw std::runtime_error("invalid rope dimension");
    // ABI-compatible producer flags: bit 0 keeps the existing center_values
    // contract; bit 1 is statistics-only bootstrap; bit 2 retains K carriers
    // for G4 clustering, whose preparation consumes the original quantized K;
    // bit 3 retains residual means/scales for centered combined calibration.
    // bit 4 is the OMEGA direct-carrier contract: the caller has proven that
    // no Python hook consumer exists, so hook_q/k/v must be null. The kernel
    // still writes the requested native carriers and statistics, but never
    // materializes hook tensors. Keep this as a fail-closed ABI check: a
    // caller with a consumer must omit this bit and retain its hooks.
    const bool measurement = (center_values & 2) != 0;
    const bool keep_k = !measurement || (center_values & 4) != 0;
    const bool keep_residual = !measurement || (center_values & 8) != 0;
    const bool direct_carriers = (center_values & 16) != 0;
    if (direct_carriers && (hook_q || hook_k || hook_v))
        throw std::runtime_error("OMEGA direct-carrier mode requires null producer hooks");
    const int center = center_values & 1;
    launch_sol_producer(qkv,fab,qw,kw,km,vs,
        measurement ? nullptr : w+p.qiP, measurement ? nullptr : w+p.qs,
        keep_k ? w+p.kiP : nullptr, keep_k ? w+p.ksb : nullptr,
        measurement ? nullptr : w+p.vTi,nullptr,
        measurement ? nullptr : w+p.vcT,w+p.scratch,
        measurement ? nullptr : w+p.cen8, measurement ? nullptr : w+p.cens,
        measurement ? nullptr : w+p.qmean,w+p.statsV,blen,eps,rot,t0,M,T,p.Tp,H,p.NPAD,p.NQ,
        keep_residual ? w+p.rTi : nullptr, keep_residual ? w+p.rmean : nullptr,
        keep_residual ? w+p.rscale : nullptr,hook_q,hook_k,hook_v,center,stream);
    DONE
}
static int route_impl(
    void* workspace, const void* vs, void* km_next, void* vamax,
    const void* blen, const void* threshold,
    int T, int H, float tau, float scale,
    int sink_s,int sink_e,int sink_qs,int sink_qe,int tail,cudaStream_t stream,
    void* emitted_ids, void* emitted_counts) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    const size_t bytes=(size_t)H*128*4;
    checked(cudaMemcpyAsync(w+p.vsc,vs,bytes,cudaMemcpyDeviceToDevice,stream));
    launch_sol_finish(w+p.scratch,w+p.kciP,w+p.kcs,w+p.thr,w+p.cen8,w+p.cens,km_next,
        blen,1,T,H,p.NTB,p.NPAD,p.NQ,tau,scale*1.4426950408889634f,
        threshold == nullptr,stream);
    launch_sol_route(w+p.cen8,w+p.cens,w+p.kciP,w+p.kcs,w+p.vcT,w+p.vsc,
        threshold ? threshold : w+p.thr,w+p.idx,w+p.cnt,w+p.oPart,w+p.mPart,w+p.lPart,
        nullptr,nullptr,blen,tail,1,T,H,p.NTB,p.NPAD,p.NQ,
        sink_s,sink_e,sink_qs,sink_qe,scale*1.4426950408889634f,stream,
        emitted_ids,emitted_counts);
    checked(cudaMemcpyAsync(vamax,w+p.statsV,bytes,cudaMemcpyDeviceToDevice,stream));
    DONE
}
extern "C" int na_route(
    void* workspace, const void* vs, void* km_next, void* vamax,
    const void* blen, const void* threshold,
    int T, int H, float tau, float scale,
    int sink_s,int sink_e,int sink_qs,int sink_qe,int tail,cudaStream_t stream) {
    return route_impl(workspace,vs,km_next,vamax,blen,threshold,T,H,tau,scale,
        sink_s,sink_e,sink_qs,sink_qe,tail,stream,nullptr,nullptr);
}

// Optional ABI3 extension: old entry points and defaults retain their contract.
extern "C" int na_route_emit(
    void* workspace, const void* vs, void* km_next, void* vamax,
    const void* blen, const void* threshold, void* ids, void* counts, void* scores,
    int T, int H, float tau, float scale,
    int sink_s,int sink_e,int sink_qs,int sink_qe,int tail,cudaStream_t stream) {
    TRY
    if (!workspace || !ids || !counts) throw std::runtime_error("route emission needs output buffers");
    const int status = route_impl(workspace,vs,km_next,vamax,blen,threshold,T,H,tau,scale,
        sink_s,sink_e,sink_qs,sink_qe,tail,stream,ids,counts);
    if (status != 0) throw std::runtime_error(na_error());
    if (scores) {
        Plan p(T,H); char* w=static_cast<char*>(workspace);
        launch_original_route_scores(w+p.cen8,w+p.cens,w+p.kciP,w+p.kcs,scores,
            H,p.NTB,p.NPAD,scale*1.4426950408889634f,stream);
    }
    DONE
}

extern "C" int na_route_emit_resources(int64_t* out, int capacity) {
    TRY
    if (!out || capacity < 6) throw std::runtime_error("resource buffer too small");
    int device, limit;
    checked(cudaGetDevice(&device));
    checked(cudaDeviceGetAttribute(&limit,cudaDevAttrMaxSharedMemoryPerBlock,device));
    cudaFuncAttributes a;
    checked(na_route_emit_attributes(&a));
    if (a.sharedSizeBytes > (size_t)limit || a.maxThreadsPerBlock < 128)
        throw std::runtime_error("route emission exceeds device resources");
    out[0]=a.sharedSizeBytes;out[1]=a.numRegs;out[2]=a.localSizeBytes;
    out[3]=a.maxThreadsPerBlock;out[4]=a.binaryVersion;out[5]=limit;
    DONE
}
extern "C" int na_route_export(
    void* workspace, const void* vs, void* km_next, void* vamax,
    const void* blen, const void* threshold, void* ids, void* counts, void* scores,
    int T, int H, float tau, float scale,
    int sink_s,int sink_e,int sink_qs,int sink_qe,int tail,cudaStream_t stream) {
    TRY
    const int status = na_route(
        workspace, vs, km_next, vamax, blen, threshold, T, H, tau, scale,
        sink_s, sink_e, sink_qs, sink_qe, tail, stream);
    if (status != 0) throw std::runtime_error(na_error());
    Plan p(T,H);
    launch_sol_export_routes(workspace ? static_cast<const char*>(workspace) + p.idx : nullptr,
        workspace ? static_cast<const char*>(workspace) + p.cnt : nullptr,
        ids, counts, 1, H, p.NQ, p.NTB, stream);
    if (scores) {
        char* w = static_cast<char*>(workspace);
        launch_original_route_scores(w+p.cen8,w+p.cens,w+p.kciP,w+p.kcs,scores,
            H,p.NTB,p.NPAD,scale*1.4426950408889634f,stream);
    }
    DONE
}
extern "C" int na_route_export_prefix(
    void* workspace, const void* vs, void* km_next, void* vamax,
    const void* blen, const void* threshold, void* ids, void* counts, void* scores,
    void* prefix_out, int T, int H, float tau, float scale,
    int sink_s,int sink_e,int sink_qs,int sink_qe,int tail,cudaStream_t stream) {
    TRY
    const int status = na_route_export(
        workspace, vs, km_next, vamax, blen, threshold, ids, counts, scores,
        T, H, tau, scale, sink_s, sink_e, sink_qs, sink_qe, tail, stream);
    if (status != 0) throw std::runtime_error(na_error());
    const int fine_status = na_fine(
        workspace, prefix_out, T, H, scale, sink_s, sink_e, sink_qs, sink_qe,
        1, stream);
    if (fine_status != 0) throw std::runtime_error(na_error());
    DONE
}
extern "C" int na_fine(void* workspace,void* out,int T,int H,float scale,
    int sink_s,int sink_e,int sink_qs,int sink_qe,int prefix_only,cudaStream_t stream) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    launch_sol_exact(w+p.qiP,w+p.qs,w+p.kiP,w+p.ksb,w+p.vTi,w+p.vsc,w+p.idx,w+p.cnt,
        w+p.oPart,w+p.mPart,w+p.lPart,nullptr,nullptr,nullptr,0,out,
        1,T,p.Tp,H,p.NQ,p.NTB,scale*1.4426950408889634f,0,
        w+p.rTi,w+p.rmean,w+p.rscale,sink_s,sink_e,sink_qs,sink_qe,prefix_only,stream);
    DONE
}

extern "C" int na_original_scores(void* workspace,void* out,int T,int H,float scale,cudaStream_t stream) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    launch_original_route_scores(w+p.cen8,w+p.cens,w+p.kciP,w+p.kcs,out,
        H,p.NTB,p.NPAD,scale*1.4426950408889634f,stream);
    DONE
}
extern "C" int na_group_chunk(void* workspace,const void* qkv,const void* lengths,
    void* gk,void* gksb,void* residual,void* means,void* scales,void* codes,
    void* permutation,void* clipping,const void* gv,
    int t0,int M,int T,int H,int ss,int se,int reuse,int center,int fp4,cudaStream_t stream) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    if(t0<0 || M<=0 || t0%64 || M>T-t0 || (t0+M<T && M%64))
        throw std::runtime_error("invalid grouped chunk coverage");
    launch_vc_group_prepare(qkv,w+p.kiP,w+p.ksb,lengths,gk,gksb,residual,means,scales,codes,
        permutation,clipping,gv,t0,M,T,p.Tp,H,ss,se,reuse,center,fp4,stream);
    DONE
}
extern "C" int na_group_fine(void* workspace,const void* gk,const void* gksb,
    const void* residual,const void* means,const void* scales,const void* codes,const void* gv,
    void* out,int T,int H,float scale,int ss,int se,int sqs,int sqe,int fp4,cudaStream_t stream) {
    TRY
    Plan p(T,H); char* w=(char*)workspace;
    launch_vc_group_fine(w+p.qiP,w+p.qs,w+p.kiP,w+p.ksb,w+p.vTi,w+p.vsc,w+p.idx,w+p.cnt,
        w+p.oPart,w+p.mPart,w+p.lPart,gk,gksb,residual,means,scales,codes,gv,out,T,p.Tp,H,p.NTB,
        scale*1.4426950408889634f,ss,se,sqs,sqe,fp4,stream);
    DONE
}
extern "C" int na_group_resources(int64_t* out,int capacity) {
    TRY
    if(!out || capacity<18) throw std::runtime_error("group resource buffer too small");
    int device,limit;
    checked(cudaGetDevice(&device));
    checked(cudaDeviceGetAttribute(&limit,cudaDevAttrMaxSharedMemoryPerBlock,device));
    cudaFuncAttributes attrs[3];
    checked(vc_group_prepare_attributes(&attrs[0]));
    checked(vc_group_fine_attributes(&attrs[1],0));
    checked(vc_group_fine_attributes(&attrs[2],1));
    for(int i=0;i<3;++i) {
        const auto& a=attrs[i];
        if(a.sharedSizeBytes>(size_t)limit || a.maxThreadsPerBlock<128)
            throw std::runtime_error("grouped kernel exceeds device resources");
        out[i*6]=a.sharedSizeBytes;out[i*6+1]=a.numRegs;out[i*6+2]=a.localSizeBytes;
        out[i*6+3]=a.maxThreadsPerBlock;out[i*6+4]=a.binaryVersion;out[i*6+5]=limit;
    }
    DONE
}
