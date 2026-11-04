"""Diagnostic captures of real H3 attention, MLP and modulation boundaries."""
import json
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import torch

try:
    from .build_identity import node_fingerprint
    from .decoder_replay import _hash
except ImportError:
    from build_identity import node_fingerprint  # type: ignore[import-not-found, no-redef]
    from decoder_replay import _hash  # type: ignore[import-not-found, no-redef]


def snapshot(value, budget, meta, path='input'):
    if isinstance(value, torch.Tensor):
        size = value.numel() * value.element_size()
        budget[0] -= size
        if budget[0] < 0:
            raise ValueError('intermediate capture byte budget exceeded')
        meta[path] = {'shape': list(value.shape), 'stride': list(value.stride()),
                      'dtype': str(value.dtype), 'device': str(value.device)}
        return value.detach().cpu().clone()
    if isinstance(value, (tuple, list)):
        return type(value)(snapshot(v, budget, meta, f'{path}.{i}') for i,v in enumerate(value))
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f'unsupported captured value at {path}')


def context_descriptor(value):
    """Describe non-tensor replay state without serializing live Comfy objects."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return {"kind": type(value).__name__, "value": value}
    if isinstance(value, (tuple, list)):
        return {"kind": type(value).__name__, "length": len(value),
                "items": [context_descriptor(item) for item in value]}
    if isinstance(value, dict):
        return {"kind": "dict", "keys": sorted(str(key) for key in value),
                "values": {str(key): context_descriptor(item)
                           for key, item in value.items()
                           if item is None or isinstance(item, (str, int, float, bool))}}
    return {"kind": type(value).__name__, "replay_required": True}


@contextmanager
def capture_intermediates(patcher, root, *, block_index=0, invocation=0, max_bytes=8*1024**3, provenance=None):
    model = getattr(getattr(patcher, 'model', None), 'diffusion_model', None)
    if model is None or not hasattr(model, 'blocks') or not 0 <= block_index < len(model.blocks):
        raise ValueError('capture requires an existing H3 block')
    if invocation < 0 or max_bytes <= 0:
        raise ValueError('invalid capture invocation or budget')
    block = model.blocks[block_index]
    root = Path(root) / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=False)
    report = {'schema':'fasth3-intermediates/1', 'diagnostic_only':True,
              'node_fingerprint':node_fingerprint(), 'block_index':block_index,
              'invocation':invocation, 'provenance':provenance or {},
              'directory':str(root), 'captures':{}, 'complete':False}
    handles, budget = [], [max_bytes]
    try:
        for label, module in (('attention',block.attn), ('mlp',block.mlp), ('modulation',block.adaln_proj)):
            state = {'calls':0, 'selected':False}
            def before(module,args,kwargs,label=label,state=state):
                index = state['calls']; state['calls'] += 1
                state['selected'] = index == invocation
                if not state['selected']: return
                meta: dict[str, Any] = {}
                # Full model configuration objects remain external to this
                # tensor fixture and must be supplied explicitly when replaying.
                tensor_kwargs = {k:v for k,v in kwargs.items() if isinstance(v,torch.Tensor)}
                required = [k for k,v in kwargs.items() if not isinstance(v,torch.Tensor)]
                payload = {'args':snapshot(args,budget,meta),
                           'kwargs':{k:snapshot(v,budget,meta,k) for k,v in tensor_kwargs.items()}}
                path = root / (label+'-input.pt')
                torch.save(payload,path)
                report['captures'][label] = {'input':path.name,'input_sha256':_hash(path),
                    'input_metadata':meta,'required_context':required,
                    'required_context_descriptor': {key: context_descriptor(kwargs[key]) for key in required},
                    'status':'input_saved'}
            def after(module,args,kwargs,output,label=label,state=state):
                if not state['selected']: return
                meta: dict[str, Any] = {}
                path = root / (label+'-output.pt')
                torch.save(snapshot(output,budget,meta,'output'),path)
                report['captures'][label].update(output=path.name,output_sha256=_hash(path),
                                                 output_metadata=meta,status='complete')
            handles.append(module.register_forward_pre_hook(before,with_kwargs=True))
            handles.append(module.register_forward_hook(after,with_kwargs=True))
        yield report
        report['complete'] = len(report['captures']) == 3 and all(r['status']=='complete' for r in report['captures'].values())
    finally:
        for handle in handles: handle.remove()
        (root/'manifest.json').write_text(json.dumps(report,indent=2))


def load_intermediate(root, label):
    if label not in ('attention','mlp','modulation'):
        raise ValueError('unknown intermediate label')
    root = Path(root)
    report = json.loads((root/'manifest.json').read_text())
    entry = report['captures'][label]
    if entry.get('status') != 'complete': raise ValueError('incomplete intermediate')
    for kind in ('input','output'):
        expected = label+'-'+kind+'.pt'
        if entry[kind] != expected or _hash(root/expected) != entry[kind+'_sha256']:
            raise ValueError('intermediate identity/hash mismatch')
    return (torch.load(root/entry['input'],map_location='cpu',weights_only=True),
            torch.load(root/entry['output'],map_location='cpu',weights_only=True),entry)


def replay_intermediate(root,label,operation,*,context=None,device='cpu'):
    inputs,reference,entry = load_intermediate(root,label)
    context = context or {}
    if set(context) != set(entry['required_context']):
        raise ValueError('supply exactly the recorded non-tensor context')
    def move(x):
        if isinstance(x,torch.Tensor): return x.to(device).clone()
        if isinstance(x,(tuple,list)): return type(x)(move(v) for v in x)
        return x
    with torch.inference_mode():
        output = operation(*move(inputs['args']),**{k:move(v) for k,v in inputs['kwargs'].items()},**context)
    return output,reference
