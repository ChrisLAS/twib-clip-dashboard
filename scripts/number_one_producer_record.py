"""Pure existing-record adapter. No scans, media reads, writes or transmission."""
from pathlib import PurePosixPath
from datetime import datetime
import re
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
def identifier(value):
    return value if isinstance(value,str) and ID.fullmatch(value) else None
def relative_ref(value,root):
    if not isinstance(value,str) or not value or '\\' in value or '\x00' in value or '//' in value or any(x in ('.','..') for x in value.split('/')):return None
    path=PurePosixPath(value)
    try:ref=str(path.relative_to(PurePosixPath(root))) if path.is_absolute() else value
    except ValueError:return None
    return ref if not ref.startswith('/') and all(x and x not in ('.','..') for x in ref.split('/')) else None
def adapt(record,kind,episode_root,expected_ref):
    if not isinstance(record,dict) or kind not in ('manual-layout','processing-history','capture-job'):return None
    fields = ('relative_path','path') if kind=='manual-layout' else ('ref',) if kind=='capture-job' else ('current_path',) if record.get('current_path') else ('file',)
    paths=[record[k] for k in fields if record.get(k)]
    refs={relative_ref(p,episode_root) for p in paths}
    if not refs or None in refs or refs!={expected_ref}:return None
    uid=identifier(record.get('clip_uid') or record.get('manual_layout_clip_uid'))
    clip=identifier(record.get('clip_id')) or uid
    if kind=='capture-job':
        job=identifier(record.get('job_id'));attempt=record.get('attempt')
        if not job or type(attempt) is not int or not 1<=attempt<=9007199254740991:return None
        clip=f'{job}:a{attempt}'
    if not clip:return None
    first=record.get('first_seen_at')
    if first is not None:
        try:
            if not isinstance(first,str) or datetime.fromisoformat(first.replace('Z','+00:00')).tzinfo is None:return None
        except ValueError:return None
    signature=record.get('source_signature')
    if signature is None and isinstance(record.get('fingerprint'),dict):
        fp=record['fingerprint'];size=fp.get('size_bytes');mtime=fp.get('mtime_ns')
        if type(size) is int and type(mtime) is int and size>=0 and mtime>=0:signature=f'{size}:{mtime}'
    if signature is not None and (not isinstance(signature,str) or len(signature)>128 or not re.fullmatch(r'\d+:\d+',signature)):return None
    return dict(clip_id=clip,clip_uid=uid,record_kind=kind,first_seen_at=first,source_signature=signature,parent_clip_id=identifier(record.get('source_long_clip_id')))
