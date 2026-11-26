"""Stream original WAV bytes into verified HF-compatible Parquet shards."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import pyarrow as pa
import pyarrow.parquet as pq
from datasets import Audio, Features, Value

FIELDS={'inGameFilename':'ingame_filename','transcription':'transcription','language':'language','speaker':'speaker','voiceType':'voice_type'}

def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def save(path,value):
    temporary=path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    temporary.replace(path)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--result',type=Path,default=Path('result'))
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--receipts',type=Path,required=True)
    parser.add_argument('--shard-bytes',type=int,default=4*1024**3)
    args=parser.parse_args();root=args.result.resolve()
    metadata=root/'metadata.jsonl';metadata_sha=sha(metadata)
    sizes={str(root/row['path']):row['bytes'] for row in map(json.loads,(root/'wav-inventory.jsonl').open(encoding='utf8'))}
    voices=[json.loads(line) for line in metadata.open(encoding='utf8')]
    plans=[];current=[];size=0
    for row in voices:
        item_size=sizes[row['filename']]
        if current and size+item_size>args.shard_bytes:plans.append(current);current=[];size=0
        current.append(row);size+=item_size
    if current:plans.append(current)
    if shutil.disk_usage(args.output.parent).free<sum(sizes[row['filename']] for row in voices)+1024**3:
        raise ValueError('Insufficient free space for worst-case Parquet output')
    args.output.mkdir(parents=True,exist_ok=True);args.receipts.mkdir(parents=True,exist_ok=True)
    features=Features({'audio':Audio(),**{field:Value('string') for field in FIELDS.values()}})
    schema=features.arrow_schema
    receipts=[]
    print(json.dumps({'phase':'plan','rows':len(voices),'shards':len(plans),'metadataSha256':metadata_sha}),flush=True)
    for index,rows in enumerate(plans):
        name=f'train-{index:05d}-of-{len(plans):05d}.parquet'
        output=args.output/name;receipt_path=args.receipts/(name+'.json')
        if output.exists() and receipt_path.exists():
            receipt=json.loads(receipt_path.read_text(encoding='utf8'))
            if receipt['metadataSha256']==metadata_sha and receipt['sha256']==sha(output) and receipt['rows']==len(rows) and receipt['verified']:
                receipts.append(receipt);print(json.dumps({'phase':'reuse','shard':name}),flush=True);continue
            raise ValueError(f'Existing shard differs from its source receipt: {name}')
        if output.exists():raise ValueError(f'Unreceipted shard exists: {name}')
        temporary=output.with_suffix('.parquet.tmp')
        expected=[];batch=[];batch_bytes=0;logical_bytes=0
        with pq.ParquetWriter(temporary,schema,compression='zstd',compression_level=3,
                             use_dictionary=['language','speaker','voice_type'],write_statistics=False) as writer:
            for row in rows:
                path=Path(row['filename']);data=path.read_bytes()
                if len(data)!=sizes[row['filename']] or data[:4]!=b'RIFF' or data[8:12]!=b'WAVE':raise ValueError(f'Audio input changed: {path}')
                item={'audio':{'bytes':data,'path':path.name},**{target:row[source] for source,target in FIELDS.items()}}
                expected.append((hashlib.sha256(data).digest(),{k:v for k,v in item.items() if k!='audio'},path.name))
                batch.append(item);batch_bytes+=len(data)
                if len(batch)>=256 or batch_bytes>=96*1024**2:
                    table=pa.Table.from_pylist(batch,schema=schema);logical_bytes+=table.nbytes;writer.write_table(table)
                    batch=[];batch_bytes=0
            if batch:
                table=pa.Table.from_pylist(batch,schema=schema);logical_bytes+=table.nbytes;writer.write_table(table)
        parquet=pq.ParquetFile(temporary)
        if parquet.metadata.num_rows!=len(rows) or Features.from_arrow_schema(parquet.schema_arrow)!=features:
            raise ValueError('Parquet row count or HF feature schema differs')
        number=0
        for batch in parquet.iter_batches(batch_size=64):
            for item in batch.to_pylist():
                audio_sha,expected_metadata,filename=expected[number]
                if hashlib.sha256(item['audio']['bytes']).digest()!=audio_sha or item['audio']['path']!=filename:
                    raise ValueError('Parquet audio round-trip mismatch')
                if {k:v for k,v in item.items() if k!='audio'}!=expected_metadata:raise ValueError('Parquet metadata round-trip mismatch')
                number+=1
        if number!=len(rows):raise ValueError('Parquet stream ended early')
        parquet.close()
        temporary.replace(output)
        receipt={'path':'data/'+name,'rows':len(rows),'bytes':output.stat().st_size,'sha256':sha(output),
                 'arrowLogicalBytes':logical_bytes,'metadataSha256':metadata_sha,'verified':True,
                 'audioCompression':'original WAV bytes, lossless Zstandard Parquet storage'}
        save(receipt_path,receipt);receipts.append(receipt)
        print(json.dumps({'phase':'verified-shard','done':index+1,'total':len(plans),**receipt}),flush=True)
    if sha(metadata)!=metadata_sha:raise ValueError('Metadata changed during Parquet generation')
    if {p.name for p in args.output.glob('*.parquet')}!={Path(r['path']).name for r in receipts}:raise ValueError('Unexpected Parquet file set')
    summary={'rows':len(voices),'shards':len(receipts),'bytes':sum(r['bytes'] for r in receipts),
             'arrowLogicalBytes':sum(r['arrowLogicalBytes'] for r in receipts),'metadataSha256':metadata_sha,
             'features':features.to_dict(),'files':receipts,'verified':True}
    save(args.receipts/'summary.json',summary)
    print(json.dumps({k:v for k,v in summary.items() if k not in ['files','features']}),flush=True)

if __name__=='__main__':main()
