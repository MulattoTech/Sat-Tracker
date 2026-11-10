"""Owner-only local module control. Default is a plan; --apply explicitly recreates the same image.
No HTTP management endpoint, Docker socket exposure, code downloads, or data deletion.
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, re, subprocess, sys, uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
VOLUMES = {'/db':'babytracker-sprout-db','/app/env':'babytracker-sprout-env','/app/Files':'babytracker-sprout-files'}

def registry(root: Path = ROOT) -> list[dict]:
    value = json.loads((root/'modules/registry.json').read_text(encoding='utf-8'))
    if value.get('schemaVersion') != 1: raise ValueError('Unsupported module registry')
    rows = value['modules']; ids = [r['id'] for r in rows]
    if len(ids) != len(set(ids)): raise ValueError('Duplicate module IDs')
    for row in rows:
        if row.get('dataOnDisable') != 'preserve': raise ValueError('Destructive module policy refused')
        if row.get('toggle') and row['toggle']['env'] != 'BABYTRACKER_OCR_ENABLED':
            raise ValueError('Unreviewed environment toggle refused')
    return rows

def replace_env(text: str, key: str, enabled: bool) -> str:
    if key != 'BABYTRACKER_OCR_ENABLED' or not isinstance(enabled, bool):
        raise ValueError('Unsupported module configuration')
    pattern = re.compile(r'^' + re.escape(key) + r'=.*$', re.MULTILINE)
    if len(pattern.findall(text)) > 1: raise ValueError('Duplicate module environment setting')
    line = key + '=' + str(enabled).lower()
    return pattern.sub(line, text) if pattern.search(text) else text.rstrip('\r\n') + '\n' + line + '\n'

def read_enabled(text: str, row: dict) -> bool | None:
    toggle = row.get('toggle')
    if not toggle: return True if row.get('required') else None
    matches = re.findall(r'^' + re.escape(toggle['env']) + r'=(.*)$', text, re.MULTILINE)
    if len(matches)>1: raise ValueError('Duplicate module setting')
    if not matches: return toggle['default']
    val=matches[0].strip().strip('\"\'').lower()
    if val not in ('true','false'): raise ValueError('Ambiguous module setting')
    return val=='true'

def run(args: list[str], *, env: dict | None = None) -> str:
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=300)
    if result.returncode: raise RuntimeError('Command failed: ' + args[0] + ' ' + args[1])
    return result.stdout

def inspect_live() -> dict:
    value=json.loads(run(['docker','inspect','babytracker-sprout']))[0]
    mounts={r['Destination']:r.get('Name') for r in value['Mounts']}
    if mounts != VOLUMES: raise RuntimeError('Production volume contract mismatch')
    if value['State'].get('Health',{}).get('Status')!='healthy': raise RuntimeError('Production is not healthy')
    return value

def atomic(path: Path, data: bytes) -> None:
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temp.open('xb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp,path)
    finally:
        if temp.exists():temp.unlink()

def apply_change(row: dict, enabled: bool) -> None:
    private=ROOT/'.local/modules'; private.mkdir(parents=True,exist_ok=True)
    lock=private.parent/'maintenance.lock'
    with lock.open('x') as f:f.write(str(os.getpid()))
    changed=False; env_path=ROOT/'.env'; old=b''; command=[]; env=None
    try:
        original=inspect_live(); old=env_path.read_bytes()
        new=replace_env(old.decode('utf-8-sig'),row['toggle']['env'],enabled).encode('utf-8')
        # Offline backup and restore rehearsal precede even a same-image module switch.
        run(['pwsh','-NoProfile','-File',str(ROOT/'scripts/backup.ps1')])
        run(['pwsh','-NoProfile','-File',str(ROOT/'scripts/test-restore.ps1')])
        if inspect_live()['Image'] != original['Image']:raise RuntimeError('Image changed concurrently')
        stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        (private/('.env-before-'+stamp)).write_bytes(old)
        env=os.environ.copy(); env['BABYTRACKER_IMAGE']=original['Image']
        env[row['toggle']['env']]=str(enabled).lower()
        command=['docker','compose','--project-directory',str(ROOT),'-f',str(ROOT/'compose.yaml'),'up','-d','--no-build','--pull','never','--wait','--wait-timeout','180','sprout']
        atomic(env_path,new); changed=True; run(command,env=env)
        current=inspect_live()
        if current['Image'] != original['Image']:raise RuntimeError('Unexpected image change')
        settings=dict(x.split('=',1) for x in current['Config']['Env'] if '=' in x)
        if settings.get(row['toggle']['env']) != str(enabled).lower():raise RuntimeError('Toggle not effective')
        receipt={'module':row['id'],'enabled':enabled,'imageId':current['Image'],'verifiedAt':stamp,'dataVolumesPreserved':True}
        atomic(private/'last-action.json',json.dumps(receipt,indent=2).encode())
        print(json.dumps(receipt))
    except BaseException:
        if changed:
            atomic(env_path,old)
            rollback_env=env.copy(); rollback_env.pop(row['toggle']['env'],None)
            run(command,env=rollback_env)
        raise
    finally:
        lock.unlink(missing_ok=True)

def main(argv: list[str] | None = None) -> int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['list','enable','disable']);p.add_argument('module',nargs='?');p.add_argument('--apply',action='store_true')
    a=p.parse_args(argv)
    try:
        rows=registry(); text=(ROOT/'.env').read_text(encoding='utf-8-sig') if (ROOT/'.env').exists() else ''
        if a.action=='list':
            print(json.dumps([dict(r,configuredEnabled=read_enabled(text,r)) for r in rows],indent=2));return 0
        row=next((r for r in rows if r['id']==a.module),None)
        if not row or row['status']!='available' or row.get('required') or not row.get('toggle'):
            raise ValueError('Module has no reviewed runtime toggle; planned modules cannot be installed')
        enabled=a.action=='enable';replace_env(text,row['toggle']['env'],enabled)
        if a.apply:apply_change(row,enabled)
        else:print(json.dumps({'planOnly':True,'module':row['id'],'enabled':enabled,'productionChanged':False,'applyFlagRequired':True}))
        return 0
    except Exception as e:
        print('MODULE_CHANGE_FAILED: '+str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
