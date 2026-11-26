"""Build resumable, verified speaker ZIPs without copying the WAV tree."""
from __future__ import annotations
import argparse
import collections
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import unicodedata
from urllib.parse import quote
import zipfile

def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def fnv(value):
    h=0xcbf29ce484222325
    for byte in value.encode('utf8'):h=((h*0x100000001b3)&0xffffffffffffffff)^byte
    return f'{h:016x}'[:8]

def safe_name(value):
    name=unicodedata.normalize('NFKC',value).strip()
    name=re.sub(r'[<>:"/\\|?*\x00-\x1f]','_',name)
    name=re.sub(r'\s+','_',name).rstrip(' ._') or 'Unknown'
    if name.upper() in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(1,10)],*[f'LPT{i}' for i in range(1,10)]}:name='_'+name
    if len(name)>120:name=name[:100]+'--'+fnv(value)
    return name

def tier(count):return '1-10' if count<=10 else '11-500' if count<=500 else '501-plus'

def write_json(path,value):
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    temporary.replace(path)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata',type=Path,default=Path('result/metadata.jsonl'))
    parser.add_argument('--output',type=Path,default=Path('result/speaker-archives'))
    parser.add_argument('--receipts',type=Path,required=True)
    parser.add_argument('--workers',type=int,default=4)
    args=parser.parse_args()
    if not 1<=args.workers<=16:raise ValueError('workers must be 1..16')
    metadata_sha=sha(args.metadata)
    groups=collections.defaultdict(list)
    source_count=0
    with args.metadata.open(encoding='utf8') as stream:
        for line in stream:
            row=json.loads(line);source_count+=1
            if row['speaker'].strip():groups[(row['language'].strip() or 'Unknown',row['speaker'].strip())].append(row)
    args.output.mkdir(parents=True,exist_ok=True);args.receipts.mkdir(parents=True,exist_ok=True)
    owner_by_path={};plans=[]
    for (language,speaker),rows in sorted(groups.items(),key=lambda item:(-len(item[1]),item[0])):
        owner=language+'\0'+speaker
        relative=f'{safe_name(language)}/{tier(len(rows))}/{safe_name(speaker)}.zip'
        if relative.casefold() in owner_by_path:
            relative=relative[:-4]+'--'+fnv(owner)+'.zip'
        if relative.casefold() in owner_by_path:raise ValueError('Archive path collision')
        owner_by_path[relative.casefold()]=owner
        plans.append((language,speaker,rows,relative))
    print(json.dumps({'archives':len(plans),'includedWavs':sum(len(x[2]) for x in plans),'allRows':source_count,'metadataSha256':metadata_sha}),flush=True)
    lock=args.receipts/'.build.lock'
    with lock.open('x') as stream:stream.write(str(os.getpid()))
    print_lock=threading.Lock()
    def build(plan):
        language,speaker,rows,relative=plan
        output=args.output/relative
        receipt_path=args.receipts/(hashlib.sha256((language+'\0'+speaker).encode()).hexdigest()+'.json')
        rows=sorted(rows,key=lambda row:row['filename'])
        source_state=[(row['filename'],Path(row['filename']).stat().st_size,Path(row['filename']).stat().st_mtime_ns) for row in rows]
        input_digest=hashlib.sha256(json.dumps([metadata_sha,source_state],ensure_ascii=False).encode()).hexdigest()
        if output.exists() and receipt_path.exists():
            receipt=json.loads(receipt_path.read_text(encoding='utf8'))
            if receipt['inputSha256']==input_digest and sha(output)==receipt['sha256'] and receipt['verified']:
                return receipt
            raise ValueError(f'Existing archive no longer matches its source: {relative}')
        if output.exists():raise ValueError(f'Unreceipted archive already exists: {relative}')
        output.parent.mkdir(parents=True,exist_ok=True)
        temporary=output.with_suffix('.zip.tmp')
        used=set();members=[]
        with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as archive:
            for index,row in enumerate(rows,1):
                source=Path(row['filename']);name=source.name
                if name.casefold() in used:name=source.stem+'--'+fnv(row['filename'])+source.suffix
                if name.casefold() in used:raise ValueError('WAV member collision')
                used.add(name.casefold())
                digest=hashlib.sha256();size=0
                info=zipfile.ZipInfo(name,date_time=(2026,9,17,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info._compresslevel=6
                with source.open('rb') as src,archive.open(info,'w',force_zip64=True) as dst:
                    while data:=src.read(1024*1024):digest.update(data);size+=len(data);dst.write(data)
                metadata={k:v for k,v in row.items() if k!='filename'}
                metadata_name=Path(name).stem+'.json'
                encoded=(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n').encode('utf8')
                info=zipfile.ZipInfo(metadata_name,date_time=(2026,9,17,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info._compresslevel=6
                archive.writestr(info,encoded)
                members.append({'wav':name,'json':metadata_name,'source':row['filename'],'bytes':size,'sha256':digest.hexdigest(),'metadataSha256':hashlib.sha256(encoded).hexdigest()})
                if len(rows)>=2000 and index%2000==0:
                    with print_lock:print(json.dumps({'phase':'packing','archive':relative,'done':index,'total':len(rows)}),flush=True)
        # Read every member back: CRC checks and SHA-256 prove both ZIP content
        # and its exact match to the source bytes/metadata consumed above.
        with zipfile.ZipFile(temporary) as archive:
            if len(archive.infolist())!=2*len(rows):raise ValueError('Unexpected ZIP member count')
            for member in members:
                with archive.open(member['wav']) as stream:
                    digest=hashlib.file_digest(stream,'sha256').hexdigest()
                if digest!=member['sha256']:raise ValueError('ZIP WAV content mismatch')
                if hashlib.sha256(archive.read(member['json'])).hexdigest()!=member['metadataSha256']:raise ValueError('ZIP metadata mismatch')
        # Check the source state after reading, so concurrent replacement fails.
        if source_state!=[(r['filename'],Path(r['filename']).stat().st_size,Path(r['filename']).stat().st_mtime_ns) for r in rows]:raise ValueError('WAV source changed while archiving')
        temporary.replace(output)
        receipt={'path':relative,'language':language,'speaker':speaker,'wavs':len(rows),'bytes':output.stat().st_size,
                 'sha256':sha(output),'inputSha256':input_digest,'metadataSha256':metadata_sha,'verified':True,'members':members}
        write_json(receipt_path,receipt)
        return receipt
    receipts=[]
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures=[pool.submit(build,plan) for plan in plans]
            for future in as_completed(futures):
                receipt=future.result();receipts.append(receipt)
                if len(receipts)%50==0 or len(receipts)==len(plans):
                    print(json.dumps({'phase':'verified-archives','done':len(receipts),'total':len(plans),'bytes':sum(r['bytes'] for r in receipts)}),flush=True)
        if sha(args.metadata)!=metadata_sha:raise ValueError('Metadata changed during archive generation')
        receipts.sort(key=lambda row:row['path'])
        summaries=[{k:v for k,v in row.items() if k!='members'} for row in receipts]
        actual={p.relative_to(args.output).as_posix() for p in args.output.rglob('*.zip')}
        if actual!={r['path'] for r in receipts}:raise ValueError('ZIP file set mismatch')
        write_json(args.output/'manifest.json',{'version':'3.2.0','metadataSha256':metadata_sha,'archives':summaries,'wavCount':sum(r['wavs'] for r in receipts),'excludedWithoutSpeaker':source_count-sum(r['wavs'] for r in receipts)})
        def index(small):
            selected=[r for r in summaries if (r['wavs']<50)==small]
            lines=['# '+('Small speaker archives' if small else 'Per-speaker ZIP archives'),'','Each ZIP contains WAVs and matching JSON metadata. Groups retain exact language and trimmed speaker labels; no aliases are merged.','',
                   '[Main index](README.md) · [Small archives](README-small.md)','','| Language | Speaker | WAVs | ZIP |','|---|---|---:|---|']
            for row in sorted(selected,key=lambda x:(x['language'],-x['wavs'],x['speaker'])):
                label=row['speaker'].replace('|','\\|').replace('\n',' ')
                lines.append(f'| {row["language"]} | {label} | {row["wavs"]:,} | [Download]({quote(row["path"],safe="/")}) |')
            return '\n'.join(lines)+'\n'
        (args.output/'README.md').write_text(index(False),encoding='utf8')
        (args.output/'README-small.md').write_text(index(True),encoding='utf8')
        result={'archives':len(receipts),'wavs':sum(r['wavs'] for r in receipts),'bytes':sum(r['bytes'] for r in receipts),'metadataSha256':metadata_sha,'verified':True}
        write_json(args.receipts/'summary.json',result)
        print(json.dumps(result),flush=True)
    finally:lock.unlink()

if __name__=='__main__':main()
