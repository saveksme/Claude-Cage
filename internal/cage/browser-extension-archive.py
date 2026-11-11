"""Extract a user-selected extension ZIP into a newly created staging directory."""
import json
import pathlib
import stat
import re
import sys
import zipfile

archive, destination = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if len(entries) > 3000 or sum(item.file_size for item in entries) > 128 * 1024 * 1024:
        raise ValueError('Распакованное расширение не может превышать 128 MB или содержать более 3000 файлов')
    for item in entries:
        path = pathlib.PurePosixPath(item.filename)
        if not item.filename or '\\' in item.filename or '\x00' in item.filename or path.is_absolute() or '..' in path.parts or ':' in path.parts[0]:
            raise ValueError('Пакет расширения содержит небезопасные пути к файлам')
        if stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
            raise ValueError('Пакет расширения не может содержать символические ссылки или зашифрованные файлы')
        if item.file_size > 32 * 1024 * 1024:
            raise ValueError('Отдельный файл в пакете расширения не может превышать 32 MB')
    source.extractall(destination)
manifest_path = destination / 'manifest.json'
if not manifest_path.is_file():
    candidates = list(destination.glob('*/manifest.json'))
    if len(candidates) != 1:
            raise ValueError('Пакет расширения должен содержать manifest.json в корне или в одной вложенной папке')
    manifest_path = candidates[0]
if manifest_path.stat().st_size > 1024 * 1024:
    raise ValueError('Конфигурация расширения слишком велика')
manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
if re.fullmatch(r'[A-Za-z0-9_-]{1,32}', str(manifest.get('default_locale', ''))):
    messages_path = manifest_path.parent / '_locales' / manifest['default_locale'] / 'messages.json'
    if messages_path.is_file() and messages_path.stat().st_size < 1024 * 1024:
        messages = json.loads(messages_path.read_text(encoding='utf-8-sig'))
        for field in ('name', 'description'):
            value = manifest.get(field, '')
            if isinstance(value, str) and value.startswith('__MSG_') and value.endswith('__'):
                manifest[field] = messages.get(value[6:-2], {}).get('message', value)
if manifest.get('manifest_version') != 3:
    raise ValueError('Поддерживаются только расширения Chromium с Manifest V3')
if not isinstance(manifest.get('name'), str) or not manifest['name'] or not isinstance(manifest.get('version'), str):
    raise ValueError('В расширении отсутствует имя или версия')
permissions = manifest.get('permissions', [])
hosts = manifest.get('host_permissions', [])
# Content scripts can read matched pages without a separate host_permissions list.
for script in manifest.get('content_scripts', []):
    hosts = hosts + script.get('matches', [])
if not all(isinstance(items, list) and len(items) <= 300 and all(isinstance(value, str) and len(value) <= 2048 for value in items) for items in [permissions, hosts]):
    raise ValueError('Недействительное объявление разрешений расширения')
print(json.dumps({'relative': str(manifest_path.parent.relative_to(destination)),
                  'name': manifest['name'][:200], 'version': manifest['version'][:100],
                  'description': str(manifest.get('description', ''))[:1000],
                  'key': str(manifest.get('key', ''))[:8192],
                  'permissions': list(dict.fromkeys(permissions)), 'hostPermissions': list(dict.fromkeys(hosts))}, ensure_ascii=False))
