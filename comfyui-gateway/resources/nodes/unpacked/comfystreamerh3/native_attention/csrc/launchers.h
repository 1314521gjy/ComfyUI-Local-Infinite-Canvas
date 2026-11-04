void launch_sol_producer(
    const void* qkv, const void* fab, const void* qw, const void* kw,
    const void* kmean, const void* vscale,
    void* qiP, void* qs, void* kiP, void* ksb, void* vTi, void* vRow, void* vcT,
    void* ksumP, void* cen8, void* cens, void* qmean, void* vamax_next,
    const void* blen, float rope_eps, int rot,
    int t0, int M, int T, int Tp, int H, int NPAD, int NQ,
    void* rTi, void* rmean, void* rscale,
    void* hook_q, void* hook_k, void* hook_v, int center_values, cudaStream_t stream)
;
void launch_sol_exact(
    const void* qi, const void* qs, const void* kiP, const void* ksb,
    const void* vTi, const void* vsc,
    const void* blk_idx, const void* blk_cnt,
    const void* o_part, const void* m_part, const void* l_part,
    const void* vRow, const void* tok_idx, const void* tok_cnt, int n_tok, void* out,
    int B, int T, int Tp, int H, int NQ, int NTB,
    float scale_log2, int elem, const void* rTi, const void* rmean, const void* rscale,
    int sink_s, int sink_e, int sink_qs, int sink_qe, int prefix_only, cudaStream_t stream)
;
void launch_sol_finish(
    void* scratch, void* kciP, void* kcs, void* threshold,
    const void* cen8, const void* cens, void* kmean_next, const void* blen,
    int B, int T, int H, int NTB, int NPAD, int NQ,
    float tau, float scale_log2, bool write_threshold, cudaStream_t stream)
;
size_t sol_preprocess_scratch_bytes(int B, int H, int NPAD) ;
void launch_sol_route(
    const void* cen8, const void* cens, const void* kciP, const void* kcs,
    const void* vcT, const void* vsc, const void* threshold,
    void* blk_idx, void* blk_cnt, void* o_part, void* m_part, void* l_part, void* tok_ref, void* cand_bits,
    // NQ (query blocks) and NTB (key blocks) coincide today; kept separate so
    // a query prefix (LTX-2 guide attention) needs no kernel change
    const void* blen, int tail,
    int B, int T, int H, int NTB, int NPAD, int NQ,
    int sink_s, int sink_e, int sink_qs, int sink_qe, float scale_log2,
    cudaStream_t stream, void* emitted_ids = nullptr, void* emitted_counts = nullptr)
;
void launch_sol_export_routes(
    const void*, const void*, void*, void*, int, int, int, int, cudaStream_t);
