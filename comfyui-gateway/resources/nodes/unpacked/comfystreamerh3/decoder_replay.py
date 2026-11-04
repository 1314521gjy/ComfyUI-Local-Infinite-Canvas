"""Capture real decoder inputs/outputs and replay without sampling or encoding."""
import hashlib
import json
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

import torch

SCHEMA = 'fasth3-decoder-fixture/1'


class EngagementError(ValueError):
    pass


class FastH3VerifiedVAELoader:
    RETURN_TYPES = ('VAE',)
    FUNCTION = 'load_vae'
    CATEGORY = 'ComfyStreamerH3/Benchmark'

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        return {'required': {'vae_name': (folder_paths.get_filename_list('vae'),)}}

    def load_vae(self, vae_name):
        import folder_paths
        from nodes import VAELoader
        path = Path(folder_paths.get_full_path_or_raise('vae', vae_name))
        before = _hash(path)
        vae = VAELoader().load_vae(vae_name)[0]
        if _hash(path) != before:
            raise ValueError('VAE checkpoint changed during loading')
        vae._fasth3_checkpoint = {'filename': vae_name, 'sha256': before}
        vae._fasth3_parameter_signature = parameter_signature(vae)
        return (vae,)


def parameter_signature(vae):
    def version(tensor):
        try:
            return tensor._version
        except RuntimeError:
            return None
    return tuple((name, id(p), tuple(p.shape), str(p.dtype), version(p))
                 for name, p in vae.first_stage_model.named_parameters())


def verified_checkpoint(vae):
    value = getattr(vae, '_fasth3_checkpoint', None)
    require_checkpoint(value)
    actual = parameter_signature(vae)
    expected = getattr(vae, '_fasth3_parameter_signature', None)
    if getattr(vae, '_fasth3_controlled_replay', False):
        # Comfy's load/offload cycle legitimately advances Tensor _version.
        # Replay already performed the strict preflight check. Comfy may swap
        # parameter objects and advance versions while loading/offloading, so
        # retain the stable names, shapes and dtypes during controlled calls.
        actual = tuple((row[0], row[2], row[3]) for row in actual)
        expected = tuple((row[0], row[2], row[3]) for row in expected or ())
    if actual != expected:
        raise ValueError('VAE parameters changed after verified load; reload before replay')
    return value


def require_checkpoint(actual, expected=None):
    if not isinstance(actual, dict) or not re.fullmatch('[0-9a-f]{64}', actual.get('sha256', '')):
        raise ValueError('verified VAE checkpoint required; use FastH3VerifiedVAELoader')
    if expected is not None and actual['sha256'] != expected.get('sha256'):
        raise ValueError('replay VAE checkpoint differs from captured reference')


def export_fixture(root, name, archive):
    load_fixture(root, name)  # validate before export
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED) as bundle:
        for suffix in ('.pt', '.json'):
            bundle.write(Path(root) / (name + suffix), name + suffix)


def import_fixture(root, archive):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        tensors = [n for n in names if re.fullmatch('[0-9a-f]{32}\\.pt', n)]
        if len(tensors) != 1:
            raise ValueError('archive needs exactly one fixture')
        name = tensors[0][:-3]
        if sorted(names) != sorted([name + '.pt', name + '.json']):
            raise ValueError('unexpected or unsafe archive member')
        if sum(i.file_size for i in bundle.infolist()) > 16 * 1024**3:
            raise ValueError('fixture archive exceeds 16 GiB')
        with tempfile.TemporaryDirectory(dir=root) as stage:
            for member in names:
                with bundle.open(member) as src, (Path(stage) / member).open('xb') as dst:
                    shutil.copyfileobj(src, dst)
            load_fixture(stage, name)
            for member in names:
                if (root / member).exists():
                    raise ValueError('fixture already exists; refusing overwrite')
            for member in names:
                shutil.move(str(Path(stage) / member), root / member)
    return name


def _hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def save_fixture(root, samples, pixels, provenance):
    latent = samples['samples']
    if latent.is_nested:
        latent = latent.unbind()[0]  # same video selection as native VAEDecode
    if latent.ndim != 5 or latent.shape[1] != 24:
        raise ValueError('expected H3 video latent [B,24,T,H,W]')
    if pixels.ndim != 4 or pixels.shape[-1] != 3:
        raise ValueError('expected decoded NHWC RGB reference pixels')
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex
    path = root / (name + '.pt')
    # New unique files only. Serialization and D2H are outside decode timing.
    with path.open('xb') as handle:
        torch.save({'schema': SCHEMA, 'latent': latent.detach().cpu().clone(),
                    'pixels': pixels.detach().cpu().clone()}, handle)
    metadata = {'schema': SCHEMA, 'sha256': _hash(path),
                'provenance': json.loads(json.dumps(provenance)),
                'latent_shape': list(latent.shape), 'pixel_shape': list(pixels.shape)}
    with (root / (name + '.json')).open('x') as handle:
        json.dump(metadata, handle)
    return name


def load_fixture(root, name):
    if not re.fullmatch('[0-9a-f]{32}', name):
        raise ValueError('fixture must be its 32-character capture ID')
    root = Path(root)
    meta = json.loads((root / (name + '.json')).read_text())
    path = root / (name + '.pt')
    if meta.get('schema') != SCHEMA or _hash(path) != meta.get('sha256'):
        raise ValueError('fixture schema or content hash mismatch')
    data = torch.load(path, map_location='cpu', weights_only=True)
    if data.get('schema') != SCHEMA:
        raise ValueError('fixture tensor schema mismatch')
    if list(data['latent'].shape) != meta['latent_shape'] or list(data['pixels'].shape) != meta['pixel_shape']:
        raise ValueError('fixture shape mismatch')
    return data, meta


def pixel_metrics(reference, actual):
    if reference.shape != actual.shape:
        raise ValueError('decoded pixel shape changed')
    actual = actual.detach().cpu()
    finite = bool(torch.isfinite(reference).all() and torch.isfinite(actual).all())
    diff = actual.float() - reference.float()
    return {'finite': finite, 'bit_exact': finite and torch.equal(reference, actual),
            'max_abs': float(diff.abs().max()) if finite else None,
            'mean_abs': float(diff.abs().mean()) if finite else None,
            'mse': float(diff.square().mean()) if finite else None,
            'per_frame_max_abs': diff.abs().flatten(1).amax(1).tolist() if finite else None}


def replay_pair(
    latent, reference, decode, candidate_options, *,
    control_decoder_mode="fused_ff_qk_rope", candidate_decoder_mode=None,
    control_options=None,
):
    """One warm-up per arm, then one measured control/candidate screen.

    decode returns (pixels, benchmark_report); its synchronized video_decode
    time is authoritative. Input clones, pixel comparisons and capture IO do
    not enter that clock. Return both reports, including feature counters.
    """
    rows = []
    baseline = None
    candidate_decoder_mode = candidate_decoder_mode or control_decoder_mode
    with torch.inference_mode():
        for phase in ('warmup', 'measured'):
            for label, options, mode in (
                ('control', control_options or {}, control_decoder_mode),
                ('candidate', candidate_options, candidate_decoder_mode),
            ):
                try:
                    pixels, report = decode({'samples': latent.clone()}, options, mode)
                except Exception as exc:  # noqa: BLE001 - replay records every failed arm
                    rows.append({'phase': phase, 'arm': label,
                                 'failure': 'failed_to_engage' if isinstance(exc, EngagementError) else 'failed_execution',
                                 'error': str(exc)})
                    return rows
                metrics = pixel_metrics(reference, pixels)
                row = {'phase': phase, 'arm': label, 'metrics_vs_fixture': metrics, 'report': report}
                row['decoder_mode'] = mode
                if phase == 'measured':
                    if label == 'control':
                        baseline = pixels.detach().cpu().clone()
                    else:
                        row['metrics_vs_current_control'] = pixel_metrics(baseline, pixels)
                rows.append(row)
                del pixels
    return rows


def migration_control_contract(captured_report):
    """Resolve B1 policy from the captured fixture, never from replay defaults.

    Decoder-only replay keeps sampling policy identity but still excludes output
    packing/host copy/encoding from its clock. Full output equivalence belongs to
    a separate diagnostic capture through the production streaming path.
    """
    from .kitchen_baseline import B1_PRESET, baseline_policy
    if not isinstance(captured_report, dict) or captured_report.get('preset_id') != B1_PRESET:
        raise ValueError('B1 migration requires a captured B1 preset report')
    baseline = captured_report.get('kitchen_baseline')
    if not isinstance(baseline, dict):
        raise ValueError('B1 migration requires a resolved Kitchen policy')  # noqa: TRY004 - invalid fixture contract
    try:
        expected = baseline_policy(token_aug=baseline.get('token_aug'),
                                   vae_precision_policy=baseline.get('vae_precision_policy'))
    except ValueError as exc:
        raise ValueError('B1 migration fixture has an invalid Kitchen policy') from exc
    if baseline != expected:
        raise ValueError('B1 migration fixture has a mismatched Kitchen policy')
    resolved_hash = captured_report.get('preset_hash')
    if not isinstance(resolved_hash, str) or not re.fullmatch('[0-9a-f]{64}', resolved_hash):
        raise ValueError('B1 migration requires the captured resolved preset hash')
    return {
        'control_profile': 'b1_migration',
        'control_options': {'decoder_qk_inplace': True},
        'vae_precision_policy': baseline['vae_precision_policy'],
        'report': {'preset_id': B1_PRESET, 'preset_hash': resolved_hash,
                   'kitchen_baseline': dict(baseline)},
        'scope': 'B1 decoder math/QK policy; output packing and audio require full-path capture',
    }


def require_completed_decoder_execution(profile):
    """Require module work, never confuse installation count with engagement."""
    evidence = profile.get('execution') if isinstance(profile, dict) else None
    if (not isinstance(evidence, dict)
            or evidence.get('instrumentation') != 'forward_completion_hooks'
            or evidence.get('restored') is not True
            or type(evidence.get('module_blocks')) is not int or evidence['module_blocks'] <= 0
            or any(type(evidence.get(name)) is not int or evidence[name] <= 0
                   for name in ('block_calls', 'attention_calls', 'feedforward_calls',
                                'completed_blocks'))
            or evidence['completed_blocks'] != evidence['module_blocks']
            or any(evidence[name] < evidence['module_blocks']
                   for name in ('block_calls', 'attention_calls', 'feedforward_calls'))):
        raise EngagementError('decoder has no restored forward-completion execution evidence')


def _root():
    import folder_paths
    return Path(folder_paths.get_output_directory()) / 'fasth3-decoder-fixtures'


class FastH3CaptureDecoderFixture:
    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('fixture_id',)
    FUNCTION = 'capture'
    CATEGORY = 'ComfyStreamerH3/Benchmark'
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'samples': ('LATENT',), 'pixels': ('IMAGE',),
                             'report': ('H3_RUN_REPORT',), 'case_label': ('STRING', {'default': 'reference'})}}

    def capture(self, samples, pixels, report, case_label):
        from .benchmark import serialize_report
        require_checkpoint(report.get('vae_checkpoint'))
        name = save_fixture(_root(), samples, pixels,
                            {'case_label': case_label, 'checkpoint': report['vae_checkpoint'],
                             'report': serialize_report(report)})
        return {'ui': {'text': [name]}, 'result': (name,)}


class FastH3DecoderReplay:
    RETURN_TYPES = ('H3_RUN_REPORT',)
    FUNCTION = 'replay'
    CATEGORY = 'ComfyStreamerH3/Benchmark'
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'fixture_id': ('STRING',), 'vae': ('VAE',),
                             'candidate_options': ('STRING', {'default': '{}'}),
                             'run_nonce': ('STRING', {'default': ''})},
                'optional': {'quality_trial': ('BOOLEAN', {'default': False}),
                             'memory_diagnostic': ('BOOLEAN', {'default': False}),
                             'trace_transfers': ('BOOLEAN', {'default': False}),
                             'profile_decoder': ('BOOLEAN', {'default': False}),
                             'decoder_mode': (['fused_ff_qk_rope'],
                                              {'default': 'fused_ff_qk_rope'}),
                             'candidate_decoder_mode': (['fused_ff_qk_rope', 'native_v036'],
                                                        {'default': 'fused_ff_qk_rope'}),
                             'control_profile': (['historical_screen', 'b1_migration'],
                                                 {'default': 'historical_screen'})}}

    def replay(self, fixture_id, vae, candidate_options, run_nonce, quality_trial=False,
               memory_diagnostic=False, trace_transfers=False, profile_decoder=False,
               decoder_mode='fused_ff_qk_rope', candidate_decoder_mode='fused_ff_qk_rope',
               control_profile='historical_screen'):
        if decoder_mode != 'fused_ff_qk_rope':
            raise ValueError('decoder-only migration control must use fused_ff_qk_rope')
        if candidate_decoder_mode not in ('fused_ff_qk_rope', 'native_v036'):
            raise ValueError('candidate_decoder_mode must be fused_ff_qk_rope or native_v036')
        if control_profile not in ('historical_screen', 'b1_migration'):
            raise ValueError('control_profile must be historical_screen or b1_migration')
        if candidate_decoder_mode == 'native_v036' and control_profile != 'b1_migration':
            raise ValueError('native_v036 comparison requires explicit b1_migration control_profile')
        if trace_transfers:
            # Kineto's CUDA trace completed but left the Comfy execution worker
            # uninterruptibly busy on the prepared SM120 host. Keep transfer
            # profiling out of replay until it can export from an isolated,
            # bounded process.
            raise ValueError(
                'trace_transfers is disabled after a worker hang; use CUDA-event '
                'stage diagnostics and a separately bounded transfer profiler'
            )
        from .benchmark import ComfyStreamerH3BenchmarkVAEDecode, _atomic_json, _blank_report
        from .build_identity import node_fingerprint
        from .decoder_optimizations import (
            ensure_omega_decoder_counters,
            omega_decoder_flag_registry,
        )
        options = json.loads(candidate_options)
        decoder_flags = {
            'decoder_qk_inplace', 'reuse_staging', 'reuse_tile_staging',
            'elide_owned_clone', 'cuda_graph',
        }
        scalar_flags = {'staging_capacity'}
        allowed = decoder_flags | scalar_flags
        if not isinstance(options, dict) or set(options) - allowed:
            raise ValueError('candidate_options requires supported decoder flags')
        if any(type(value) is not bool for name, value in options.items()
               if name not in scalar_flags):
            raise ValueError('candidate_options boolean flags must be strict booleans')
        if 'staging_capacity' in options and (
                type(options['staging_capacity']) is not int
                or options['staging_capacity'] not in (1, 2)):
            raise ValueError('staging_capacity must be 1 or 2')
        if options.get('cuda_graph'):
            raise ValueError('CUDA Graph replay is unsupported by decoder-only replay')
        if 'staging_capacity' in options and not (
                options.get('reuse_staging') or options.get('reuse_tile_staging')):
            raise ValueError('staging_capacity requires reuse_staging')
        if candidate_decoder_mode == 'native_v036' and any(
                options.get(name) for name in ('decoder_qk_inplace', 'reuse_staging',
                                              'reuse_tile_staging', 'elide_owned_clone')):
            raise ValueError('native_v036 owns decoder buffers and does not expose legacy tile experiments')
        if candidate_decoder_mode == 'native_v036' and options.get('staging_capacity', 1) != 1:
            raise ValueError('native_v036 does not expose legacy staging experiments')
        data, metadata = load_fixture(_root(), fixture_id)
        captured_report = metadata.get('provenance', {}).get('report', {})
        control_contract = (migration_control_contract(captured_report)
                            if control_profile == 'b1_migration' else None)
        timing_eligible = not bool(
            memory_diagnostic or trace_transfers or profile_decoder or control_contract)
        control_options = control_contract['control_options'] if control_contract else {}
        if control_contract and candidate_decoder_mode == 'fused_ff_qk_rope':
            options = {**control_options, **options}
        # Comfy can reuse the loader node from an earlier replay while dynamic
        # offload swaps parameters/advances tensor versions. Check the stable
        # name/shape/dtype signature during controlled replay; checkpoint hash
        # remains strict and the first control still establishes repeatability.
        vae._fasth3_controlled_replay = True
        try:
            checkpoint = verified_checkpoint(vae)
        finally:
            vae.__dict__.pop('_fasth3_controlled_replay', None)
        require_checkpoint(checkpoint, metadata.get('provenance', {}).get('checkpoint', {}))
        from .model_cache import comfyui_core_revision
        core_commit = comfyui_core_revision()
        captured_profile_id = (captured_report.get('preset_id')
                               if isinstance(captured_report, dict) else None)
        try:
            from .runtime import PRESETS, execution_profile_for_decoder
            control_execution_profile = (
                execution_profile_for_decoder(
                    captured_profile_id, decoder_mode,
                    resolved_preset_hash=captured_report.get('preset_hash'))
                if captured_profile_id in PRESETS else None
            )
            candidate_profile = (
                execution_profile_for_decoder(
                    captured_profile_id, candidate_decoder_mode,
                    resolved_preset_hash=captured_report.get('preset_hash'))
                if captured_profile_id in PRESETS else None
            )
        except (ImportError, ValueError):
            control_execution_profile = candidate_profile = None
        if control_execution_profile is None or candidate_profile is None:
            profile_payload = {
                'schema': 'fasth3-decoder-fixture-profile/1',
                'fixture': fixture_id,
                'vae_checkpoint_sha256': checkpoint['sha256'],
                'comfyui_commit': core_commit,
                'control_decoder_mode': decoder_mode,
                'candidate_decoder_mode': candidate_decoder_mode,
                'candidate_options': options,
                'control_profile': control_profile, 'control_options': control_options,
            }
            execution_profile = {
                **profile_payload,
                'profile_id': f"decoder-fixture::{decoder_mode}-to-{candidate_decoder_mode}/v1",
                'profile_hash': hashlib.sha256(
                    json.dumps(profile_payload, sort_keys=True,
                               separators=(',', ':')).encode()
                ).hexdigest(),
                'promotion_status': 'unqualified_candidate',
            }
        else:
            profile_payload = {
                'schema': 'fasth3-decoder-replay-profile/1',
                'fixture': fixture_id,
                'vae_checkpoint_sha256': checkpoint['sha256'],
                'comfyui_commit': core_commit,
                'control_profile_id': control_execution_profile['profile_id'],
                'candidate_profile_id': candidate_profile['profile_id'],
                'control_profile_hash': control_execution_profile['profile_hash'],
                'candidate_profile_hash': candidate_profile['profile_hash'],
                'control_profile': control_profile, 'control_options': control_options,
                'candidate_options': options,
            }
            execution_profile = {
                **profile_payload,
                'profile_id': f"{control_execution_profile['profile_id']}::candidate={candidate_profile['profile_id']}",
                'profile_hash': hashlib.sha256(
                    json.dumps(profile_payload, sort_keys=True,
                               separators=(',', ':')).encode()
                ).hexdigest(),
                'promotion_status': candidate_profile['promotion_status'],
            }
        decode_calls = 0
        def decode(samples, flags, selected_mode):
            nonlocal decode_calls
            report = _blank_report(run_nonce=run_nonce, seed=0,
                                   profile={'mode': 'diagnostic'} if profile_decoder else {})
            report['profile_memory'] = bool(memory_diagnostic)
            if control_contract:
                report.update(control_contract['report'])
            before = _allocator_metrics()
            vae._fasth3_controlled_replay = True
            try:
                # Replay options use stable experiment names. Translate them
                # to the decode node's ABI here so a candidate never appears
                # engaged merely because an unknown keyword was accepted by a
                # wrapper. ``reuse_tile_staging`` is retained as a historical
                # alias for reports already in the corpus.
                decode_flags = {
                    'decoder_cuda_graph': False,
                    'decoder_qk_inplace': bool(flags.get('decoder_qk_inplace', False)),
                    'reuse_staging': bool(flags.get('reuse_staging', flags.get('reuse_tile_staging', False))),
                    'staging_capacity': int(flags.get('staging_capacity', 1)),
                    'elide_owned_clone': bool(flags.get('elide_owned_clone', False)),
                }
                pixels, report = ComfyStreamerH3BenchmarkVAEDecode().decode(
                    samples, vae, report, decoder_mode=selected_mode, tile_batch=3,
                    _replay=True, _migration_diagnostic=bool(control_contract),
                    vae_precision_policy=(control_contract['vae_precision_policy']
                                          if control_contract else 'established'),
                    **decode_flags)
            finally:
                vae.__dict__.pop('_fasth3_controlled_replay', None)
            report['timing_eligible'] = timing_eligible
            decode_execution = report.get('decoder_optimization')
            if (not isinstance(decode_execution, dict)
                    or decode_execution.get('mode') != selected_mode
                    or not decode_execution.get('enabled')):
                raise EngagementError(f'{selected_mode}: decoder profile was not engaged')
            if selected_mode == 'native_v036' or control_contract:
                require_completed_decoder_execution(decode_execution)
            if decode_calls == 0:
                vae._fasth3_parameter_signature = parameter_signature(vae)
                report['replay_signature_stabilized'] = True
            decode_calls += 1
            ensure_omega_decoder_counters(report)
            after = _allocator_metrics()
            report['decoder_allocator'] = {
                'before': before, 'after': after,
                'allocated_delta_bytes': after['allocated_bytes'] - before['allocated_bytes'],
                'active_allocation_delta': after['active_allocations'] - before['active_allocations'],
                'scope': 'one synchronized decoder call; output tensor remains live',
            }
            counters = {
                'cuda_graph': ('decoder_cuda_graph', 'replays'),
                'decoder_qk_inplace': ('decoder_qk_inplace', 'inplace_calls'),
                'bounded_tiles': ('decoder_tile_execution', 'groups'),
                'reuse_staging': ('decoder_tile_execution', 'staged_groups'),
                'reuse_tile_staging': ('decoder_tile_execution', 'staged_groups'),
                'elide_owned_clone': ('decoder_tile_execution', 'output_clones_avoided'),
            }
            for flag, wanted in flags.items():
                if not wanted:
                    continue
                if flag in counters:
                    section, counter = counters[flag]
                    count = report.get(section, {}).get(counter, 0)
                elif flag == 'staging_capacity':
                    count = report.get('decoder_tile_execution', {}).get('staging_allocations', 0)
                else:
                    count = bool(report.get('decoder_metadata_cache'))
                if not count:
                    raise EngagementError(f'{flag}: replay has no execution evidence')
            return pixels, report
        transfer_events = None
        if trace_transfers:
            # Decoder-only diagnostic: never around sampling/model preparation.
            # Profiler overhead makes this run ineligible for speed decisions.
            activities = [torch.profiler.ProfilerActivity.CPU]
            if torch.cuda.is_available():
                activities.append(torch.profiler.ProfilerActivity.CUDA)
            with torch.profiler.profile(activities=activities, record_shapes=False,
                                        profile_memory=False) as profiler:
                rows = replay_pair(
                    data['latent'], data['pixels'], decode, options,
                    control_decoder_mode=decoder_mode,
                    candidate_decoder_mode=candidate_decoder_mode,
                    control_options=control_options,
                )
            counts: dict[str, int] = {}
            for event in profiler.events():
                if 'memcpy' in event.name.lower():
                    counts[event.name] = counts.get(event.name, 0) + 1
            transfer_events = {'events_by_name': counts,
                               'scope': 'includes replay input and reference comparison transfers',
                               'weight_offload_attribution': 'unresolved; memcpy alone does not identify weight ownership'}
        else:
            rows = replay_pair(
                data['latent'], data['pixels'], decode, options,
                control_decoder_mode=decoder_mode,
                candidate_decoder_mode=candidate_decoder_mode,
                control_options=control_options,
            )
        verdict = screen_replay(rows)
        if not timing_eligible:
            verdict = {'status': 'diagnostic_only', 'promotion': False,
                       'reason': 'diagnostic instrumentation excluded from speed decisions'}
        output = {'schema': 'fasth3-decoder-replay/1', 'fixture': fixture_id,
                  'fixture_metadata': metadata, 'node_fingerprint': node_fingerprint(),
                  'comfyui_commit': core_commit, 'execution_profile': execution_profile,
                  'decoder_omega_registry': omega_decoder_flag_registry(),
                  'rows': rows, 'candidate_options': options,
                  'decoder_mode': decoder_mode,
                  'candidate_decoder_mode': candidate_decoder_mode,
                  'control_profile': control_profile, 'control_contract': control_contract,
                  'timing_eligible': timing_eligible,
                  'quality_trial': bool(quality_trial),
                  'profile_decoder': bool(profile_decoder),
                  'transfer_trace': transfer_events,
                  'screening': verdict,
                  'clock': 'report.timings_ms.video_decode; sampling/encoding excluded',
                  'promotion': 'screen_only; require deployment/weight provenance and quality review'}
        path = _root() / ('replay-' + uuid.uuid4().hex + '.json')
        _atomic_json(path, output)
        return {'ui': {'text': [str(path)]}, 'result': (output,)}


def _allocator_metrics():
    if not torch.cuda.is_available():
        return {'allocated_bytes': 0, 'reserved_bytes': 0, 'peak_allocated_bytes': 0,
                'active_allocations': 0, 'num_alloc_retries': 0, 'num_ooms': 0}
    stats = torch.cuda.memory_stats()
    return {
        'allocated_bytes': int(torch.cuda.memory_allocated()),
        'reserved_bytes': int(torch.cuda.memory_reserved()),
        'peak_allocated_bytes': int(torch.cuda.max_memory_allocated()),
        'active_allocations': int(stats.get('active.all.current', 0)),
        'num_alloc_retries': int(stats.get('num_alloc_retries', 0)),
        'num_ooms': int(stats.get('num_ooms', 0)),
    }


def screen_replay(rows):
    """Conservative single-sample screening; never automatic promotion."""
    failures = [r for r in rows if r.get('failure')]
    if failures:
        return {'status': failures[0]['failure'], 'reason': failures[0].get('error'), 'promotion': False}
    if any(row.get('report', {}).get('timing_eligible') is False for row in rows):
        return {'status': 'diagnostic_only', 'promotion': False,
                'reason': 'diagnostic instrumentation excluded from speed decisions'}
    for row in rows:
        if row.get('arm') == 'candidate' and row.get('metrics_vs_fixture', {}).get('finite') is False:
            return {'status': 'output_mismatch', 'reason': 'nonfinite candidate warmup/output', 'promotion': False}
        if row.get('arm') == 'control' and not row.get('metrics_vs_fixture', {}).get('bit_exact'):
            return {'status': 'invalid', 'reason': 'control repeatability/reference check failed', 'promotion': False}
    measured = {r['arm']: r for r in rows if r.get('phase') == 'measured'}
    if set(measured) != {'control', 'candidate'}:
        return {'status': 'invalid', 'reason': 'missing measured arms'}
    control, candidate = measured['control'], measured['candidate']
    if not control.get('metrics_vs_fixture', {}).get('bit_exact'):
        return {'status': 'invalid', 'reason': 'control does not reproduce saved reference'}
    if not candidate.get('metrics_vs_current_control', {}).get('bit_exact'):
        return {'status': 'output_mismatch', 'promotion': False}
    times = [r.get('report', {}).get('timings_ms', {}).get('video_decode') for r in (control, candidate)]
    import math
    if any(not isinstance(t, (int, float)) or not math.isfinite(t) or t <= 0 for t in times):
        return {'status': 'invalid', 'reason': 'missing or invalid decoder timing'}
    saving = 1 - times[1] / times[0]
    return {'status': 'promising_needs_confirmation' if saving >= .03 else 'no_useful_improvement',
            'fraction_saved': saving, 'promotion': False, 'measured_samples_per_arm': 1}
