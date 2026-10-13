import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('adapter',pathlib.Path(__file__).parents[1]/'number_one_producer_record.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
ROOT='/synthetic/synced/TWIB/127';REF='01-MACO/café%20literal.mp4'
class Compatibility(unittest.TestCase):
 def test_manual_record(self):
  r=dict(clip_uid='n1-0123456789',relative_path=REF,path=ROOT+'/'+REF,first_seen_at='2026-10-08T16:03:06Z',fingerprint=dict(size_bytes=100,mtime_ns=123));v=a.adapt(r,'manual-layout',ROOT,REF)
  self.assertEqual(v['clip_uid'],r['clip_uid']);self.assertEqual(v['first_seen_at'],r['first_seen_at']);self.assertEqual(v['source_signature'],'100:123')
 def test_history_keeps_both_existing_ids_and_parent(self):
  r=dict(clip_id='src-abcdef123456-123456',manual_layout_clip_uid='src-abcdef123456',current_path=ROOT+'/'+REF,file=ROOT+'/'+REF,source_signature='100:123',source_long_clip_id='long-source-123');v=a.adapt(r,'processing-history',ROOT,REF)
  self.assertEqual(v['clip_id'],r['clip_id']);self.assertEqual(v['clip_uid'],r['manual_layout_clip_uid']);self.assertEqual(v['parent_clip_id'],r['source_long_clip_id'])
 def test_stale_and_conflicting_paths(self):
  for p in ['../outside.mp4',ROOT+'/old.mp4','/private/elsewhere.mp4']:self.assertIsNone(a.adapt(dict(clip_id='src-a',current_path=p),'processing-history',ROOT,REF))
  self.assertIsNotNone(a.adapt(dict(clip_id='src-a',current_path=ROOT+'/'+REF,file=ROOT+'/old.mp4'),'processing-history',ROOT,REF))
 def test_legacy_capture_does_not_invent_id(self):
  self.assertIsNone(a.adapt(dict(file=ROOT+'/'+REF,captured_at='2026-10-08T16:03:06Z'),'processing-history',ROOT,REF))
 def test_job_attempt_identity(self):
  r=dict(job_id='00000000-0000-4000-8000-000000000001',attempt=1,ref=REF);self.assertEqual(a.adapt(r,'capture-job',ROOT,REF)['clip_id'],r['job_id']+':a1')
 def test_literal_paths(self):
  self.assertEqual(a.relative_ref(ROOT+'/'+REF,ROOT),REF)
  self.assertIsNone(a.adapt(dict(clip_id='src-a',path=ROOT+'/'+REF.replace('%20',' ')),'processing-history',ROOT,REF))
if __name__=='__main__':unittest.main()
