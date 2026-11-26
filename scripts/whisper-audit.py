"""Reproducible stratified ASR audit; never writes authored voice metadata."""
import argparse
import collections
import hashlib
import json
import re
import time
import unicodedata
from pathlib import Path

LANGUAGES = {'Chinese': 'zh', 'English': 'en', 'Japanese': 'ja', 'Korean': 'ko'}

def jsonl(path):
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)

def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(4 * 1024 * 1024):
            sha.update(block)
    return sha.hexdigest()

def normalized(text):
    text = re.sub(r'<[^>]+>', '', text)
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())

def variants(text):
    # Gender branches are alternatives, not two consecutive spoken sentences.
    return list(dict.fromkeys(normalized(re.sub(r'\{([FM])#([^{}]*)\}',
        lambda match: match[2] if match[1] == gender else '', text)) for gender in ['F', 'M']))

def distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--result', type=Path, default=Path('result'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=20260917)
    args = parser.parse_args()
    args.result = args.result.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    metadata_sha = digest(args.result / 'metadata.jsonl')
    sample_path = args.output / 'sample.jsonl'
    manifest_path = args.output / 'manifest.json'
    if sample_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest['metadataSha256'] != metadata_sha:
            raise ValueError('Metadata changed since sample selection')
        sample = list(jsonl(sample_path))
    else:
        changes = {}
        for row in jsonl(args.result / 'native-annotation-changes.jsonl'):
            text = row['changes'].get('transcription')
            if text:
                changes[row['filename']] = 'added' if not text['before'] else 'changed'
        durations = {str(args.result / row['path']): row['frames'] / row['sampleRate']
                     for row in jsonl(args.result / 'wav-inventory.jsonl')}
        pools = collections.defaultdict(list)
        for row in jsonl(args.result / 'metadata.jsonl'):
            duration = durations.get(row['filename'], 0)
            if row['language'] not in LANGUAGES or not 1 <= duration <= 30:
                continue
            group = changes.get(row['filename'], 'unchanged') if row['transcription'].strip() else 'unannotated'
            row.update(group=group, duration=duration)
            pools[row['language'], group].append(row)
        sample = []
        for language in LANGUAGES:
            changed = min(4, len(pools[language, 'changed']))
            for group, count in [('added', 24 - changed), ('changed', changed), ('unchanged', 4), ('unannotated', 4)]:
                pool = sorted(pools[language, group], key=lambda row: hashlib.sha256(
                    f'{args.seed}:{row["filename"]}'.encode()).digest())
                if len(pool) < count:
                    raise ValueError(f'Insufficient samples for {language}/{group}')
                sample.extend(pool[:count])
        for index, row in enumerate(sample):
            row['sample_index'] = index
            row['audioSha256'] = digest(Path(row['filename']))
        manifest = {'seed': args.seed, 'metadataSha256': metadata_sha,
                    'modelPath': str(args.model), 'modelSha256': digest(args.model),
                    'durationRangeSeconds': [1, 30], 'samples': len(sample),
                    'eligibleByStratum': {f'{k[0]}/{k[1]}': len(v) for k, v in pools.items()},
                    'sampleByStratum': dict(collections.Counter(f'{r["language"]}/{r["group"]}' for r in sample)),
                    'settings': {'temperature': 0, 'condition_on_previous_text': False,
                                 'beam_size': 5, 'initial_prompt': None, 'device': 'cuda'},
                    'scope': 'Diagnostic sample, not an estimate of full-corpus error rate or speaker identity accuracy.'}
        sample_path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in sample), encoding='utf-8')
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Selected {len(sample)} files; {sum(row["duration"] for row in sample):.1f} seconds', flush=True)
    import torch
    import whisper
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable')
    torch.set_num_threads(6)
    print(f'Loading {args.model.name} on {torch.cuda.get_device_name(0)}', flush=True)
    model = whisper.load_model(str(args.model), device='cuda')
    output_path = args.output / 'results.jsonl'
    results = list(jsonl(output_path)) if output_path.exists() else []
    completed = {row['sample_index'] for row in results}
    with output_path.open('a', encoding='utf-8') as output:
        for row in sample:
            if row['sample_index'] in completed:
                continue
            started = time.perf_counter()
            try:
                asr = model.transcribe(row['filename'], language=LANGUAGES[row['language']],
                    temperature=0.0, condition_on_previous_text=False, beam_size=5,
                    initial_prompt=None, task='transcribe', fp16=True, verbose=None)
                hypothesis = normalized(asr['text'])
                references = variants(row['transcription'])
                cer = min(distance(ref, hypothesis) / max(1, len(ref)) for ref in references) if row['transcription'].strip() else None
                category = ('unannotated' if cer is None else 'exact' if cer == 0 else
                            'close' if cer <= .15 else 'review' if cer <= .4 else 'suspect')
                result = {**row, 'whisper': asr['text'].strip(), 'cer': cer, 'classification': category,
                          'segments': [{k: segment[k] for k in ['start', 'end', 'text', 'avg_logprob', 'no_speech_prob']}
                                       for segment in asr['segments']], 'seconds': time.perf_counter() - started}
            except Exception as error:
                result = {**row, 'error': str(error), 'classification': 'error'}
            output.write(json.dumps(result, ensure_ascii=False) + '\n')
            output.flush()
            results.append(result)
            print(f'{len(results)}/{len(sample)} {row["language"]} {row["group"]}: {result["classification"]}', flush=True)
    if digest(args.result / 'metadata.jsonl') != metadata_sha:
        raise ValueError('Metadata changed during audit')
    summary = {'samples': len(sample), 'completed': len(results),
               'classifications': dict(collections.Counter(row['classification'] for row in results)),
               'byLanguage': {language: dict(collections.Counter(row['classification'] for row in results if row['language'] == language)) for language in LANGUAGES},
               'metadataUnchanged': True, 'torch': torch.__version__, 'whisper': whisper.__version__}
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=2), flush=True)

if __name__ == '__main__':
    main()
