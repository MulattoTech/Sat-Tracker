import importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('bt_modules',ROOT/'scripts/modules.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ModulesTest(unittest.TestCase):
 def test_registry_known_and_preserving(self):
  rows=m.registry();self.assertEqual(len(rows),5)
  self.assertTrue(all(r['dataOnDisable']=='preserve' for r in rows))
 def test_replace_existing(self):
  self.assertEqual(m.replace_env('OTHER=yes\nBABYTRACKER_OCR_ENABLED=true\n','BABYTRACKER_OCR_ENABLED',False),'OTHER=yes\nBABYTRACKER_OCR_ENABLED=false\n')
 def test_append(self):
  self.assertEqual(m.replace_env('OTHER=yes\n','BABYTRACKER_OCR_ENABLED',True),'OTHER=yes\nBABYTRACKER_OCR_ENABLED=true\n')
 def test_duplicates_rejected(self):
  with self.assertRaises(ValueError):m.replace_env('BABYTRACKER_OCR_ENABLED=true\nBABYTRACKER_OCR_ENABLED=false\n','BABYTRACKER_OCR_ENABLED',False)
 def test_arbitrary_key_rejected(self):
  with self.assertRaises(ValueError):m.replace_env('','DATABASE_URL',True)
 def test_non_boolean_rejected(self):
  with self.assertRaises(ValueError):m.replace_env('','BABYTRACKER_OCR_ENABLED','false')
 def test_planned_is_not_available(self):
  row=next(r for r in m.registry() if r['id']=='advanced-sleep');self.assertEqual(row['status'],'planned');self.assertIsNone(row['toggle'])
 def test_effective_boolean(self):
  row=next(r for r in m.registry() if r['id']=='ocr')
  self.assertFalse(m.read_enabled('BABYTRACKER_OCR_ENABLED=false\n',row))
  self.assertTrue(m.read_enabled('',row))
 def test_invalid_env_is_not_silent(self):
  row=next(r for r in m.registry() if r['id']=='ocr')
  with self.assertRaises(ValueError):m.read_enabled('BABYTRACKER_OCR_ENABLED=maybe',row)
 def test_plan_never_executes(self):
  with patch.object(m,'run',side_effect=AssertionError('must not run Docker')),patch.object(m,'apply_change',side_effect=AssertionError('must not mutate')):
   self.assertEqual(m.main(['disable','ocr']),0)
 def test_reject_planned(self):
  with patch.object(m,'apply_change',side_effect=AssertionError('must not mutate')):self.assertEqual(m.main(['enable','advanced-sleep','--apply']),1)
 def test_atomic_preserves_bytes(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'.env';m.atomic(p,b'OLD=1\n');m.atomic(p,b'NEW=2\n');self.assertEqual(p.read_bytes(),b'NEW=2\n');self.assertEqual(len(list(Path(d).iterdir())),1)
if __name__=='__main__':unittest.main()
