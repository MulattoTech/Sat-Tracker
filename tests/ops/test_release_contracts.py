import importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('module_ops',ROOT/'scripts/modules.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ReleaseContracts(unittest.TestCase):
 def test_public_production_and_preview_are_separate(self):
  prod=(ROOT/'compose.yaml').read_text();stage=(ROOT/'application/compose.ocr-staging.yml').read_text()
  self.assertIn('babytracker-sprout-db',prod);self.assertNotIn('babytracker-sprout-db',stage)
  self.assertIn('BABYTRACKER_SYNTHETIC_STAGING',stage)
 def test_promotion_uses_exact_digest_and_ci(self):
  code=(ROOT/'scripts/promote-release.ps1').read_text()
  for required in ['babytracker-ci.yml','ops-contracts.yml','head_sha=$revision','-Image $candidate.Id','git archive','ocr-staging-check.mjs','.local/maintenance.lock']:
   self.assertIn(required,code)
  self.assertNotIn('down -v',code)
 def test_upstream_pin_format(self):
  lock=json.loads((ROOT/'upstreams.lock.json').read_text())
  for up in lock['upstreams']:self.assertRegex(up['observedHead'],r'^[a-f0-9]{40}$')
  self.assertIsNone(lock['upstreams'][1]['integrationBase'])
 def test_volume_contract_rejects_unknown_mount(self):
  live={'Mounts':[{'Destination':'/db','Name':'some-other-db'}],'State':{'Health':{'Status':'healthy'}}}
  with patch.object(m,'run',return_value=json.dumps([live])):
   with self.assertRaises(RuntimeError):m.inspect_live()
 def test_same_image_toggle_apply_is_data_preserving(self):
  row=next(x for x in m.registry() if x['id']=='ocr')
  live={'Image':'sha256:known','Config':{'Env':['BABYTRACKER_OCR_ENABLED=false']}}
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'.env').write_text('BABYTRACKER_OCR_ENABLED=true\nUNRELATED=retain\n')
   with patch.object(m,'ROOT',root),patch.object(m,'inspect_live',return_value=live),patch.object(m,'run',return_value='') as run:
    m.apply_change(row,False)
    self.assertIn('UNRELATED=retain',(root/'.env').read_text())
    self.assertIn('BABYTRACKER_OCR_ENABLED=false',(root/'.env').read_text())
    self.assertEqual(run.call_args.kwargs['env']['BABYTRACKER_IMAGE'],'sha256:known')
    self.assertIn('backup.ps1',run.call_args_list[0].args[0][-1]);self.assertIn('test-restore.ps1',run.call_args_list[1].args[0][-1])
   self.assertFalse((root/'.local/maintenance.lock').exists())
 def test_failed_toggle_restores_old_env(self):
  row=next(x for x in m.registry() if x['id']=='ocr');calls=[]
  def command(args,**kwargs):
   calls.append(args)
   if len(calls)==3:raise RuntimeError('synthetic health failure')
   return ''
  live={'Image':'sha256:known'}
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);original=b'BABYTRACKER_OCR_ENABLED=true\nUNRELATED=retain\n';(root/'.env').write_bytes(original)
   with patch.object(m,'ROOT',root),patch.object(m,'inspect_live',return_value=live),patch.object(m,'run',side_effect=command):
    with self.assertRaises(RuntimeError):m.apply_change(row,False)
   self.assertEqual((root/'.env').read_bytes(),original);self.assertEqual(len(calls),4)
   self.assertFalse((root/'.local/maintenance.lock').exists())
if __name__=='__main__':unittest.main()
