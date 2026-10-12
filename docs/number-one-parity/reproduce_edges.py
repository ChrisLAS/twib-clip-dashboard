#!/usr/bin/env python3
"""Synthetic local-only producer/receiver edge cases. Never uses source media or network.

Usage: PYTHONDONTWRITEBYTECODE=1 python3 reproduce_edges.py --producer DIR --receiver DIR --output-dir NEW_DIR
DIR inputs are read-only. All writes, including intentional overlap-test writes,
are confined to --output-dir and temporary synthetic directories inside it.
Requires the receiver's already-installed node, esbuild and dependencies.
"""
import argparse
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--producer', type=Path, required=True)
p.add_argument('--receiver', type=Path, required=True)
p.add_argument('--output-dir', type=Path, required=True)
a = p.parse_args()
producer, receiver, output = a.producer.resolve(), a.receiver.resolve(), a.output_dir.resolve()
if output == producer or output.is_relative_to(producer) or output == receiver or output.is_relative_to(receiver):
    raise SystemExit('Output must be outside source trees.')
output.mkdir(mode=0o700, parents=False, exist_ok=False)
sys.dont_write_bytecode = True
sys.path.insert(0, str(producer))
from collector import Scan
from bridge_contract import manifest_digest, validate_manifest
from outbox import initialize, Outbox
from fake_receiver import FakeReceiver

cases = ['percent_filename', 'encoded_secret_filename', 'reserved_origin', 'malformed_percent_origin', 'warning_limit',
         'prepare_candidate_status', 'prepare_media_evidence', 'prepare_warning_text', 'prepare_coverage_limit']
summary = []
for kind in cases:
    with tempfile.TemporaryDirectory(prefix=kind + '-', dir=output) as f:
        work = Path(f); root = work / 'source'; ep = root / '127'; ep.mkdir(parents=True)
        if kind == 'percent_filename': (ep / 'clip%25.mp4').write_bytes(b'synthetic media')
        if kind == 'encoded_secret_filename': (ep / 'token%3DSYNTHETIC.mp4').write_bytes(b'synthetic media')
        if kind in ('reserved_origin', 'malformed_percent_origin'):
            (ep / 'transcripts').mkdir()
            url = 'https://media.home/path' if kind == 'reserved_origin' else 'https://example.com/clip%zz'
            (ep / 'transcripts/supporting-clip-candidates.json').write_text(json.dumps({'candidates': [{'url': url, 'title': 'Synthetic'}]}))
        if kind == 'warning_limit':
            for i in range(2001): (ep / f'link-{i:04}').symlink_to('nonexistent')
        if kind.startswith('prepare_'):
            manifest = json.loads((producer / 'example.manifest.json').read_text())
            if kind == 'prepare_candidate_status': manifest['items'][0]['processing_status'] = 'quarantined'
            if kind == 'prepare_media_evidence':
                item = manifest['items'][0]
                item.update(kind='media', processing_status='captured_observed', media={
                    'ref': 'clip.mp4', 'present': True, 'size_bytes': 10, 'modified_at': None, 'duration_seconds': None})
                item.pop('capture_evidence', None)
            if kind == 'prepare_warning_text': manifest['warnings'] = ['SYNTHETIC diagnostic text']
            if kind == 'prepare_coverage_limit': manifest['coverage'] = [{'artifact': None, 'status': 'absent'}] * 2001
            manifest['idempotency_digest'] = manifest_digest(manifest)
        else:
            manifest = Scan(root, 127).run()
        validate_manifest(manifest)
        state = work / 'state'; initialize(state, root, 127, confirm_new_stream=True)
        envelope = Outbox(state, root, 127).prepare(manifest)
        (output / f'{kind}.json').write_text(json.dumps(envelope))
        summary.append({'case': kind, 'local_prepared_sequence': envelope['sequence'], 'complete': manifest['snapshot']['complete'],
                        'items': len(manifest['items']), 'warnings': len(manifest['warnings']), 'coverage': len(manifest['coverage'])})

with tempfile.TemporaryDirectory(prefix='overlap-', dir=output) as f:
    root = Path(f) / 'source'; root.mkdir()
    state = '/' + str(root / 'state')
    initialize(state, root, 127, confirm_new_stream=True)
    summary.append({'case': 'double_slash_state_overlap', 'lexical_overlap': Path(state).is_relative_to(root),
                    'resolved_overlap': Path(state).resolve().is_relative_to(root.resolve()),
                    'database_written_inside_synthetic_source': (root / 'state' / 'outbox.sqlite3').is_file()})

with tempfile.TemporaryDirectory(prefix='receipt-', dir=output) as f:
    work = Path(f); root = work / 'source'; root.mkdir(); state = work / 'state'
    initialize(state, root, 127, confirm_new_stream=True)
    box = Outbox(state, root, 127)
    manifest = json.loads((producer / 'example.manifest.json').read_text())
    first, second = box.prepare(manifest), box.prepare(manifest)
    fake = FakeReceiver()
    try:
        receipt = fake.accept(second)
        box.acknowledge_offline(receipt); box.acknowledge_offline(receipt)
        wrong = {**receipt, 'scan_id': first['scan_id']}
        try: box.acknowledge_offline(wrong)
        except Exception as exc: rejected = type(exc).__name__
        else: rejected = False
        summary.append({'case': 'receipt_reuse_control', 'acknowledged': [e['offline_acknowledged'] for e in box.status()['entries']],
                        'wrong_entry_receipt_rejected': rejected})
    finally: fake.close()

bundle = output / 'contract.mjs'
subprocess.run([str(receiver / 'node_modules/.bin/esbuild'), str(receiver / 'apps/worker/src/inventory/contract.ts'),
                '--bundle', '--platform=node', '--format=esm', '--outfile=' + str(bundle)], check=True)
node_script = output / 'verify.mjs'
node_script.write_text('''import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??= webcrypto;
const {validateEnvelope} = await import('./contract.mjs');
const cases = JSON.parse(fs.readFileSync(new URL('./local-results.json', import.meta.url), 'utf8'));
for (const entry of cases.filter(e => e.local_prepared_sequence)) {
  const env = JSON.parse(fs.readFileSync(new URL('./' + entry.case + '.json', import.meta.url), 'utf8'));
  const hosts = [...new Set(env.manifest.items.flatMap(i => i.origins.map(o => new URL(o.url).hostname)))];
  const grant = {sourceId: env.manifest.source_id, episodeId: env.manifest.episode.id, episodeNumber: 127,
    expiresAt: Date.now() + 3600000, scope: 'inventory:write', allowEditorialContext: true, originHosts: hosts};
  try { await validateEnvelope(env, env.scan_id, grant); entry.receiver = 'ACCEPTED'; }
  catch (e) { entry.receiver = {status: e.status, code: e.code}; }
}
fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(cases, null, 2));
console.log(JSON.stringify(cases, null, 2));
''')
(output / 'local-results.json').write_text(json.dumps(summary, indent=2))
subprocess.run(['node', str(node_script)], check=True)
