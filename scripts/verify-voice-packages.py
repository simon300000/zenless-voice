"""Verify official package size/MD5 and compare the native export's package inputs."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--manifests', type=Path, required=True)
parser.add_argument('--native-manifests', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
rows = []
packages = []
for language in ['zh-cn', 'en-us', 'ja-jp', 'ko-kr']:
    manifest_path = args.manifests / f'manifest-{language}.json'
    raw = manifest_path.read_bytes()
    current = json.loads(raw.decode('utf-8-sig'))
    native = json.loads((args.native_manifests / f'{language}-files.json').read_text(encoding='utf-8-sig'))
    assert current['version'] == '3.2.0' and current['region'] == 'global'
    signature = lambda manifest: sorted((r['name'], r['size'], r['md5'].lower()) for r in manifest['files'])
    identical = signature(current) == signature(native)
    if not identical:
        raise ValueError(f'Native export package input differs from downloaded manifest: {language}')
    packages.append({'language': language, 'files': len(current['files']),
                     'bytes': current['total_size'], 'manifestSha256': hashlib.sha256(raw).hexdigest(),
                     'matchesNativeExportPackage': identical})
    rows.extend(current['files'])

def verify(row):
    path = (args.source / row['name']).resolve()
    if not path.is_relative_to(args.source.resolve()):
        raise ValueError(f'Unsafe package path: {path}')
    if path.stat().st_size != row['size']:
        raise ValueError(f'Size mismatch: {path}')
    md5 = hashlib.md5()
    with path.open('rb') as stream:
        while block := stream.read(4 * 1024 * 1024):
            md5.update(block)
    if md5.hexdigest() != row['md5'].lower():
        raise ValueError(f'MD5 mismatch: {path}')
    return {'path': row['name'], 'bytes': row['size'], 'md5': md5.hexdigest()}

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    verified = list(pool.map(verify, rows))
expected = {row['name'] for row in rows}
actual = {path.relative_to(args.source).as_posix() for path in args.source.rglob('*') if path.is_file() and path.name != '.gitignore'}
if actual != expected:
    raise ValueError(f'Package file set differs: extra={sorted(actual-expected)}, missing={sorted(expected-actual)}')
result = {'version': '3.2.0', 'region': 'global', 'files': len(verified),
          'bytes': sum(row['bytes'] for row in verified), 'errors': 0, 'packages': packages,
          'verifiedFiles': verified}
args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'verifiedFiles'}, indent=2))
