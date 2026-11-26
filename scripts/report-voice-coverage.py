"""Compare historical/new baseline/native annotations and verify every exported WAV."""
import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
import struct
import wave
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--result', type=Path, required=True)
args = parser.parse_args()
result_root = args.result.resolve()
fields = ['transcription', 'speaker', 'inGameFilename', 'voiceType']

def coverage(rows):
    languages = collections.defaultdict(collections.Counter)
    for row in rows:
        for language in ['all', row['language']]:
            languages[language]['total'] += 1
            for field in fields:
                languages[language][field] += bool(row.get(field, '').strip())
    return dict(languages)

def read_jsonl(path):
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            yield json.loads(line)

historical = json.loads((args.run / 'baseline-result.json').read_text(encoding='utf-8'))
history_stats = coverage(historical.values())
del historical
before = {row['filename']: row for row in read_jsonl(args.run / 'before-native-metadata.jsonl')}
before_stats = coverage(before.values())
after = {}
delta = {field: collections.Counter() for field in fields}
changes_path = args.result / 'native-annotation-changes.jsonl'
with changes_path.open('w', encoding='utf-8') as changes:
    for row in read_jsonl(args.result / 'metadata.jsonl'):
        filename = row['filename']
        if filename in after:
            raise ValueError(f'Duplicate metadata filename: {filename}')
        old = before[filename]
        differences = {}
        for field in fields:
            left, right = old.get(field, ''), row.get(field, '')
            if left == right:
                continue
            kind = 'added' if not left else 'removed' if not right else 'changed'
            delta[field][kind] += 1
            differences[field] = {'before': left, 'after': right}
        if differences:
            changes.write(json.dumps({'filename': filename, 'changes': differences}, ensure_ascii=False) + '\n')
        after[filename] = row
assert before.keys() == after.keys(), 'Before/after audio sets differ'
del before

actual = {str(Path(folder, name)) for folder, _, files in os.walk(result_root / 'wav') for name in files if name.endswith('.wav')}
assert actual == set(after), 'WAV/metadata file sets differ'
wav_bytes = 0
durations = collections.Counter()
empty_audio = 0
inventory_digest = hashlib.sha256()
def verify_wav(filename):
    path = Path(filename)
    size = path.stat().st_size
    with path.open('rb') as stream:
        header = stream.read(12)
    if header[:4] != b'RIFF' or header[8:12] != b'WAVE' or struct.unpack('<I', header[4:8])[0] + 8 != size:
        raise ValueError(f'Invalid/truncated WAV: {filename}')
    with wave.open(filename, 'rb') as stream:
        frames = stream.getnframes()
        rate = stream.getframerate()
        channels = stream.getnchannels()
        width = stream.getsampwidth()
        assert rate > 0 and channels > 0 and width == 2, filename
        # Read the final declared frame to detect data-chunk truncation.
        if frames:
            stream.setpos(frames - 1)
            assert len(stream.readframes(1)) == width * channels, filename
    item = {'path': path.relative_to(result_root).as_posix(), 'bytes': size,
            'frames': frames, 'sampleRate': rate, 'channels': channels}
    return filename, item

with (args.result / 'wav-inventory.jsonl').open('w', encoding='utf-8') as inventory, concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    filenames = sorted(after)
    number = 0
    # Keep at most one small batch of futures alive for the 400k-file corpus.
    for start in range(0, len(filenames), 2048):
        for filename, item in pool.map(verify_wav, filenames[start:start + 2048]):
            number += 1
            wav_bytes += item['bytes']
            empty_audio += item['frames'] == 0
            durations[after[filename]['language']] += item['frames'] / item['sampleRate']
            line = json.dumps(item, sort_keys=True) + '\n'
            inventory.write(line)
            inventory_digest.update(line.encode())
            if number % 50000 == 0:
                print(f'Validated {number} WAVs', flush=True)

metadata_sha = hashlib.sha256((args.result / 'metadata.jsonl').read_bytes()).hexdigest()
result = {'historical3_1': history_stats, 'updated3_2BeforeNative': before_stats,
          'updated3_2WithNative': coverage(after.values()), 'nativeDelta': delta,
          'validation': {'wavFiles': len(actual), 'wavBytes': wav_bytes, 'emptyAudio': empty_audio,
                         'durationHoursByLanguage': {k: v / 3600 for k, v in durations.items()},
                         'missingFiles': 0, 'duplicateFilenames': 0, 'invalidWavHeaders': 0,
                         'metadataSha256': metadata_sha, 'wavInventorySha256': inventory_digest.hexdigest()}}
(args.result / 'coverage-report.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
