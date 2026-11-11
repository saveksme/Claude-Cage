#!/usr/bin/python3
"""Private FileChooser portal and host file ingress for one desktop session."""
import ctypes as C
from ctypes.util import find_library
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import select
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import parse_qs, unquote, urlsplit

LIMIT = 2 * 1024 ** 3
PORTAL = 'org.freedesktop.portal.FileChooser'
ROOT = '/org/freedesktop/portal/desktop'


def image_context():
    result = subprocess.run(['/usr/local/bin/cage-native-input', '--request'],
                            input=b'{"mode":"status"}\n', stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=True, timeout=4)
    value = json.loads(result.stdout)
    context = value.get('context', '')
    if value.get('available') is not True or not re.fullmatch('[a-f0-9]{32}', context):
        raise ValueError('Место приёма изображения не в фокусе. Нажмите на поле ввода и повторите')
    return context


class Broker:
    def __init__(self, directory, deliver=lambda request, paths: None, downloads=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.deliver = deliver
        self.downloads = downloads
        self.requests = {}
        self.lock = threading.RLock()

    def start(self, kind='paste', multiple=True, **metadata):
        if kind not in ('paste', 'drop', 'image', 'chooser', 'save', 'open'):
            raise ValueError('Недопустимый способ передачи файлов')
        if kind == 'image':
            metadata['image_context'] = image_context()
            multiple = False
        with self.lock:
            if len(self.requests) >= 32:
                raise ValueError('Сначала завершите работу с уже открытыми окнами файлов')
            key = str(uuid.uuid4())
            self.requests[key] = dict(id=key, kind=kind, multiple=multiple,
                                      files=[], busy=False, created=time.monotonic(), **metadata)
        return {'id': key}

    def snapshot(self):
        with self.lock:
            for key, request in list(self.requests.items()):
                if request['kind'] == 'open' and time.monotonic() - request['created'] > 60:
                    self.complete_open(key, 'Время операции с файлами компьютера истекло. Откройте заново')
            return {'uploads': [dict(id=r['id'], multiple=r['multiple'],
                                     title=r.get('title', ''), target='desktop',
                                     directory=r.get('directory', False))
                                for r in self.requests.values() if r['kind'] == 'chooser'],
                    'downloads': self.downloads.snapshot() if self.downloads else [],
                    'opens': [{'id': r['id']} for r in self.requests.values()
                              if r['kind'] == 'open' and not r['busy']]}

    def open_path(self, path, action='open', **metadata):
        if action not in ('open', 'reveal') or not isinstance(path, str) or not path or '\x00' in path:
            raise ValueError('Недействительный запрос на открытие файла')
        if path.startswith('file:'):
            uri = urlsplit(path)
            if uri.scheme != 'file' or uri.netloc not in ('', 'localhost') or uri.query or uri.fragment:
                raise ValueError('Выберите файл в проекте на компьютере')
            path = unquote(uri.path, errors='strict')
        if not Path(path).is_absolute():
            raise ValueError('Для запроса открытия файла нужен абсолютный путь')
        path = str(Path(path).resolve(strict=True))
        return self.start('open', False, path=path, action=action, **metadata)

    def claim_open(self, key):
        with self.lock:
            request = self.requests.get(key)
            if not request or request['kind'] != 'open' or request['busy']:
                return {'handled': True}
            if time.monotonic() - request['created'] > 60:
                self.complete_open(key, 'Время операции с файлами компьютера истекло. Откройте заново')
                return {'handled': True}
            request['busy'] = True
            path = request['path']
            if self.downloads:
                try:
                    path = self.downloads.host_visible_path(path)
                except ValueError as error:
                    return {'error': str(error)}
            return {'id': key, 'path': path, 'action': request['action']}

    def complete_open(self, key, error=''):
        with self.lock:
            request = self.requests.get(key)
            if not request or request['kind'] != 'open':
                return {'ok': True}
            del self.requests[key]
        if request.get('handle'):
            self.deliver(request, None if error else [])
        return {'ok': True}

    def get(self, key):
        if key not in self.requests:
            raise ValueError('Окно загрузки закрыто. Выберите файл заново')
        return self.requests[key]

    def receive(self, key, name, chunks):
        if (not isinstance(name, str) or not name or len(name.encode()) > 255
                or name in ('.', '..') or re.search(r'[/\\\x00-\x1f]', name)):
            raise ValueError('Недействительное имя файла')
        with self.lock:
            request = self.get(key)
            if request.get('directory'):
                raise ValueError('Выберите папку проекта')
            if request['busy'] or len(request['files']) >= (100 if request['multiple'] else 1):
                raise ValueError('Выберите допустимое количество файлов')
            request['busy'] = True
        directory = self.directory / key / str(uuid.uuid4())
        accepted = False
        try:
            directory.mkdir(parents=True, mode=0o700)
            path = directory / name
            size = 0
            with path.open('xb') as output:
                os.chmod(path, 0o600)
                for chunk in chunks:
                    size += len(chunk)
                    if size > LIMIT:
                        raise ValueError('Каждый файл не может превышать 2 GB')
                    with self.lock:
                        if self.requests.get(key) is not request:
                            raise ValueError('Загрузка отменена')
                    output.write(chunk)
            with self.lock:
                if self.requests.get(key) is not request:
                    raise ValueError('Загрузка отменена')
                request['files'].append(str(path))
                accepted = True
            return dict(ok=True, name=name, size=size)
        finally:
            with self.lock:
                request['busy'] = False
            if not accepted:
                shutil.rmtree(directory, ignore_errors=True)

    def finish(self, key):
        with self.lock:
            request = self.get(key)
            if request['kind'] == 'image' or request['busy'] or not request['files']:
                raise ValueError('Сначала выберите и передайте файл')
            request['busy'] = True
        try:
            self.deliver(request, request['files'])
            with self.lock:
                if self.requests.get(key) is not request:
                    raise ValueError('Загрузка отменена')
                del self.requests[key]
            # Applications can read files lazily. Keep bytes for this session.
            return {'ok': True}
        except Exception:
            self.cancel(key)
            raise

    def finish_image(self, key):
        with self.lock:
            request = self.get(key)
            if request['kind'] != 'image' or request['busy'] or len(request['files']) != 1:
                raise ValueError('Изображение получено не полностью')
            request['busy'] = True
        try:
            if image_context() != request['image_context']:
                raise ValueError('Место приёма изображения изменилось. Вставьте заново')
            paste_files(request['files'], expected_context=request['image_context'])
            return {'ok': True}
        finally:
            self.cancel(key)

    def cancel(self, key, respond=True):
        with self.lock:
            request = self.requests.pop(key, None)
        if request and respond and request['kind'] in ('chooser', 'save'):
            self.deliver(request, None)
        shutil.rmtree(self.directory / key, ignore_errors=True)
        return {'ok': True}

    def choose_directory(self, key, path):
        with self.lock:
            request = self.get(key)
            if request['kind'] != 'chooser' or not request.get('directory'):
                raise ValueError('Текущее окно не запрашивает папку')
            if request['busy']:
                raise ValueError('Папка передаётся приложению')
            if not isinstance(path, str) or not Path(path).is_absolute() or not Path(path).is_dir():
                raise ValueError('Папка проекта ещё не подключена. Откройте проект заново')
            request['files'] = [path]
        return self.finish(key)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def chunks(self):
        length = self.headers.get('Content-Length')
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            while True:
                line = self.rfile.readline(128)
                if not line.endswith(b'\r\n'):
                    raise ValueError('Передача файла прервана')
                size = int(line.split(b';', 1)[0], 16)
                if size == 0:
                    if self.rfile.readline(128) != b'\r\n':
                        raise ValueError('Недопустимый формат передачи файла')
                    return
                if size < 0 or size > LIMIT:
                    raise ValueError('Каждый файл не может превышать 2 GB')
                while size:
                    data = self.rfile.read(min(65536, size))
                    if not data:
                        raise ValueError('Передача файла прервана')
                    size -= len(data)
                    yield data
                if self.rfile.read(2) != b'\r\n':
                    raise ValueError('Недопустимый формат передачи файла')
        elif length is not None:
            remaining = int(length)
            if remaining < 0 or remaining > LIMIT:
                raise ValueError('Каждый файл не может превышать 2 GB')
            while remaining:
                data = self.rfile.read(min(65536, remaining))
                if not data:
                    raise ValueError('Передача файла прервана')
                remaining -= len(data)
                yield data
        else:
            raise ValueError('Отсутствует длина файла')

    def route(self):
        route = urlsplit(self.path)
        broker = self.server.broker
        try:
            if self.command == 'GET' and route.path == '/requests':
                result = broker.snapshot()
            elif self.command == 'POST' and route.path == '/upload':
                query = parse_qs(route.query)
                result = broker.receive(query.get('id', [''])[0], query.get('name', [''])[0], self.chunks())
            elif self.command == 'POST':
                data = bytearray()
                for chunk in self.chunks():
                    data.extend(chunk)
                    if len(data) > 65536:
                        raise ValueError('Запрос файла слишком велик')
                value = json.loads(data or b'{}')
                if route.path == '/start':
                    result = broker.start(value.get('kind', 'paste'))
                elif route.path == '/finish':
                    result = broker.finish(value.get('id', ''))
                elif route.path == '/finish-image':
                    result = broker.finish_image(value.get('id', ''))
                elif route.path == '/cancel':
                    key = value.get('id', '')
                    if not re.fullmatch(r'[0-9a-f-]{36}', key):
                        raise ValueError('Недействительный запрос файла')
                    result = broker.cancel(key)
                elif route.path == '/directory':
                    result = broker.choose_directory(value.get('id', ''), value.get('path', ''))
                elif route.path == '/open':
                    result = broker.open_path(value.get('path', ''), value.get('action', 'open'))
                elif route.path == '/open-claim':
                    result = broker.claim_open(value.get('id', ''))
                elif route.path == '/open-complete':
                    result = broker.complete_open(value.get('id', ''), value.get('error', ''))
                elif route.path == '/download-retry' and broker.downloads:
                    result = broker.downloads.retry(value.get('id', ''))
                else:
                    raise ValueError('Недействительная операция с файлом')
            else:
                raise ValueError('Недействительная операция с файлом')
            body, status = json.dumps(result).encode(), 200
        except Exception as error:
            body, status = str(error).encode(), 400
        self.send_response(status)
        self.send_header('Content-Type', 'application/json' if status == 200 else 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    do_GET = route
    do_POST = route


class FileServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def bind(lib, name, result, *args):
    function = getattr(lib, name)
    function.restype, function.argtypes = result, list(args)
    return function


class Portal:
    """GIO is already required by the desktop; no Python D-Bus package needed."""
    XML = '''<node><interface name="org.freedesktop.portal.FileChooser">
      <property name="version" type="u" access="read"/>
      <method name="OpenFile"><arg type="s" direction="in"/><arg type="s" direction="in"/>
        <arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      <method name="SaveFile"><arg type="s" direction="in"/><arg type="s" direction="in"/>
        <arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      </interface><interface name="org.freedesktop.portal.OpenURI">
      <property name="version" type="u" access="read"/>
      <method name="OpenDirectory"><arg type="s" direction="in"/><arg type="h" direction="in"/>
        <arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      </interface><interface name="org.freedesktop.FileManager1">
      <method name="ShowItems"><arg type="as" direction="in"/><arg type="s" direction="in"/></method>
      <method name="ShowFolders"><arg type="as" direction="in"/><arg type="s" direction="in"/></method>
      </interface><interface name="org.freedesktop.portal.Request">
      <method name="Close"/><signal name="Response"><arg type="u"/><arg type="a{sv}"/></signal>
      </interface></node>'''

    def __init__(self, broker):
        self.broker, self.objects = broker, {}
        self.glib = C.CDLL(find_library('glib-2.0') or 'libglib-2.0.so.0')
        self.gio = C.CDLL(find_library('gio-2.0') or 'libgio-2.0.so.0')
        p, s, u = C.c_void_p, C.c_char_p, C.c_uint
        self.variant_parse = bind(self.glib, 'g_variant_parse', p, p, s, p, p, p)
        self.variant_print = bind(self.glib, 'g_variant_print', p, p, C.c_int)
        self.free = bind(self.glib, 'g_free', None, p)
        self.child = bind(self.glib, 'g_variant_get_child_value', p, p, C.c_size_t)
        self.string = bind(self.glib, 'g_variant_get_string', s, p, p)
        self.boolean = bind(self.glib, 'g_variant_get_boolean', C.c_int, p)
        self.lookup = bind(self.glib, 'g_variant_lookup_value', p, p, s, p)
        self.unref = bind(self.glib, 'g_variant_unref', None, p)
        self.new_string = bind(self.glib, 'g_variant_new_string', p, s)
        self.new_path = bind(self.glib, 'g_variant_new_object_path', p, s)
        self.new_uint = bind(self.glib, 'g_variant_new_uint32', p, u)
        self.new_variant = bind(self.glib, 'g_variant_new_variant', p, p)
        self.new_entry = bind(self.glib, 'g_variant_new_dict_entry', p, p, p)
        self.new_tuple = bind(self.glib, 'g_variant_new_tuple', p, C.POINTER(p), C.c_size_t)
        self.new_array = bind(self.glib, 'g_variant_new_array', p, p, C.POINTER(p), C.c_size_t)
        self.type_new = bind(self.glib, 'g_variant_type_new', p, s)
        self.type_free = bind(self.glib, 'g_variant_type_free', None, p)
        self.connection = bind(self.gio, 'g_bus_get_sync', p, C.c_int, p, p)(2, None, None)
        if not self.connection:
            raise RuntimeError('Служба выбора файлов рабочего стола не может подключиться к сеансу')
        call = bind(self.gio, 'g_dbus_connection_call_sync', p, p, s, s, s, s, p, p, u, C.c_int, p, p)
        name_reply = call(self.connection, b'org.freedesktop.DBus', b'/org/freedesktop/DBus', b'org.freedesktop.DBus',
                         b'RequestName', self.tuple(self.new_string(b'org.freedesktop.portal.Desktop'), self.new_uint(4)),
                         None, 0, 5000, None, None)
        if not name_reply:
            raise RuntimeError('Служба выбора файлов рабочего стола не может зарегистрироваться')
        code = self.child(name_reply, 0)
        code_value = bind(self.glib, 'g_variant_get_uint32', u, p)(code)
        self.unref(code)
        self.unref(name_reply)
        if code_value != 1:
            raise RuntimeError('Уже работает другая служба выбора файлов рабочего стола')
        name_reply = call(self.connection, b'org.freedesktop.DBus', b'/org/freedesktop/DBus', b'org.freedesktop.DBus',
                         b'RequestName', self.tuple(self.new_string(b'org.freedesktop.FileManager1'), self.new_uint(4)),
                         None, 0, 5000, None, None)
        if not name_reply:
            raise RuntimeError('Служба открытия файлов компьютера не может зарегистрироваться')
        code = self.child(name_reply, 0)
        code_value = bind(self.glib, 'g_variant_get_uint32', u, p)(code)
        self.unref(code)
        self.unref(name_reply)
        if code_value != 1:
            raise RuntimeError('Уже работает другая служба управления файлами')
        self.reply = bind(self.gio, 'g_dbus_method_invocation_return_value', None, p, p)
        self.error = bind(self.gio, 'g_dbus_method_invocation_return_dbus_error', None, p, s, s)
        self.emit = bind(self.gio, 'g_dbus_connection_emit_signal', C.c_int, p, s, s, s, s, p, p)
        self.unregister = bind(self.gio, 'g_dbus_connection_unregister_object', C.c_int, p, u)
        self.register = bind(self.gio, 'g_dbus_connection_register_object', u, p, s, p, p, p, p, p)
        self.node = bind(self.gio, 'g_dbus_node_info_new_for_xml', p, s, p)(self.XML.encode(), None)
        self.interface = bind(self.gio, 'g_dbus_node_info_lookup_interface', p, p, s)
        method_type = C.CFUNCTYPE(None, p, s, s, s, s, p, p, p)
        property_type = C.CFUNCTYPE(p, p, s, s, s, s, p, p)
        self.method_callback = method_type(self.method)
        self.property_callback = property_type(lambda *_: self.new_uint(3))
        class VTable(C.Structure):
            _fields_ = [('method', method_type), ('get', property_type), ('set', p), ('padding', p * 8)]
        self.vtable = VTable(self.method_callback, self.property_callback, None)
        if not self.register(self.connection, ROOT.encode(), self.interface(self.node, PORTAL.encode()), C.byref(self.vtable), None, None, None):
            raise RuntimeError('Интерфейс выбора файлов рабочего стола не может зарегистрироваться')
        for object_path, interface in ((ROOT, 'org.freedesktop.portal.OpenURI'),
                                       ('/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1')):
            if not self.register(self.connection, object_path.encode(), self.interface(self.node, interface.encode()), C.byref(self.vtable), None, None, None):
                raise RuntimeError('Интерфейс открытия файлов компьютера не может зарегистрироваться')
        self.loop = bind(self.glib, 'g_main_loop_new', p, p, C.c_int)(None, False)

    def tuple(self, *values):
        return self.new_tuple((C.c_void_p * len(values))(*values), len(values))

    def array(self, signature, values):
        kind = self.type_new(signature.encode())
        try:
            return self.new_array(kind, (C.c_void_p * len(values))(*values), len(values))
        finally:
            self.type_free(kind)

    def option(self, options, name, default):
        value = self.lookup(options, name.encode(), b'b' if isinstance(default, bool) else b's')
        if not value:
            return default
        try:
            return bool(self.boolean(value)) if isinstance(default, bool) else self.string(value, None).decode()
        finally:
            self.unref(value)

    def method(self, _connection, sender, path, _interface, method, parameters, invocation, _data):
        try:
            if method in (b'ShowItems', b'ShowFolders'):
                uris = self.child(parameters, 0)
                try:
                    count = bind(self.glib, 'g_variant_n_children', C.c_size_t, C.c_void_p)(uris)
                    if count > 32:
                        raise ValueError('За один раз можно открыть не более 32 мест')
                    for index in range(count):
                        uri = self.child(uris, index)
                        try:
                            self.broker.open_path(self.string(uri, None).decode(), 'reveal' if method == b'ShowItems' else 'open')
                        finally:
                            self.unref(uri)
                finally:
                    self.unref(uris)
                self.reply(invocation, self.tuple())
                return
            if method == b'Close':
                request = next((r for r in self.broker.requests.values() if r.get('handle') == path.decode() and r.get('sender') == sender.decode()), None)
                if request:
                    self.broker.cancel(request['id'], respond=False)
                    self.remove(request)
                self.reply(invocation, self.tuple())
                return
            title, options = self.child(parameters, 1), self.child(parameters, 2)
            try:
                directory = self.option(options, 'directory', False)
                token = self.option(options, 'handle_token', 'cage_' + uuid.uuid4().hex)
                if not re.fullmatch(r'[A-Za-z0-9_]+', token):
                    raise ValueError('Недействительный идентификатор окна файла')
                handle = ROOT + '/request/' + sender.decode().lstrip(':').replace('.', '_') + '/' + token
                if handle in self.objects:
                    raise ValueError('Окно файла уже открыто')
                object_id = self.register(self.connection, handle.encode(), self.interface(self.node, b'org.freedesktop.portal.Request'), C.byref(self.vtable), None, None, None)
                if not object_id:
                    raise ValueError('Окно файла не удалось открыть')
                self.objects[handle] = object_id
                key = None
                try:
                    saving = method == b'SaveFile'
                    if method == b'OpenDirectory':
                        # The handle belongs to the caller's D-Bus message, not
                        # to this service's file descriptor table.
                        message = bind(self.gio, 'g_dbus_method_invocation_get_message', C.c_void_p, C.c_void_p)(invocation)
                        descriptors = bind(self.gio, 'g_dbus_message_get_unix_fd_list', C.c_void_p, C.c_void_p)(message)
                        index = bind(self.glib, 'g_variant_get_handle', C.c_int, C.c_void_p)(title)
                        fd = bind(self.gio, 'g_unix_fd_list_get', C.c_int, C.c_void_p, C.c_int, C.c_void_p)(descriptors, index, None) if descriptors else -1
                        if fd < 0:
                            raise ValueError('Местоположение файла не читается')
                        try:
                            key = self.broker.open_path(os.readlink('/proc/self/fd/' + str(fd)), 'reveal',
                                                       handle=handle, sender=sender.decode())['id']
                        finally:
                            os.close(fd)
                    else:
                        key = self.broker.start('save' if saving else 'chooser', self.option(options, 'multiple', False) and not directory,
                                          directory=directory,
                                          handle=handle, sender=sender.decode(), title=self.string(title, None).decode())['id']
                    if saving:
                        if not self.broker.downloads:
                            raise ValueError('Служба загрузки недоступна')
                        destination = self.broker.downloads.begin(self.option(options, 'current_name', 'download'))
                except Exception:
                    self.unregister(self.connection, self.objects.pop(handle))
                    if key:
                        self.broker.cancel(key, respond=False)
                    raise
                self.reply(invocation, self.tuple(self.new_path(handle.encode())))
                if saving:
                    # The user already requested a download. Stage bytes privately;
                    # the host save dialog is offered only after the writer finishes.
                    request = self.broker.get(key)
                    self.deliver(request, [destination])
                    del self.broker.requests[key]
            finally:
                self.unref(title)
                self.unref(options)
        except Exception as error:
            self.error(invocation, b'org.freedesktop.portal.Error.Failed', str(error).encode())

    def remove(self, request):
        object_id = self.objects.pop(request['handle'], None)
        if object_id:
            self.unregister(self.connection, object_id)

    def deliver(self, request, paths):
        if request['kind'] not in ('chooser', 'save', 'open'):
            paste_files(paths)
            return
        entries = []
        if paths is not None and request['kind'] != 'open':
            uris = self.array('s', [self.new_string(Path(path).as_uri().encode()) for path in paths])
            entries.append(self.new_entry(self.new_string(b'uris'), self.new_variant(uris)))
        response = self.tuple(self.new_uint(0 if paths is not None else (2 if request['kind'] == 'open' else 1)), self.array('{sv}', entries))
        if not self.emit(self.connection, request['sender'].encode(), request['handle'].encode(),
                         b'org.freedesktop.portal.Request', b'Response', response, None):
            raise ValueError('Исходное окно файла закрыто')
        self.remove(request)

    def run(self):
        bind(self.glib, 'g_main_loop_run', None, C.c_void_p)(self.loop)


def paste_files(paths, expected_context=None):
    process = subprocess.Popen([sys.executable, __file__, '--clipboard'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    value = paths if expected_context is None else dict(paths=paths, image_context=expected_context)
    process.stdin.write(json.dumps(value).encode())
    process.stdin.close()
    try:
        ready, _, _ = select.select([process.stdout], [], [], 10)
        if not ready or process.stdout.readline() != b'ok\n':
            process.terminate()
            process.wait(timeout=3)
            raise ValueError('Цель не принимает файлы. Нажмите на поле ввода с поддержкой вложений и повторите')
    finally:
        process.stdout.close()


def clipboard(paths, expected_context=None):
    gtk, gdk, glib = (C.CDLL(name) for name in ('libgtk-3.so.0', 'libgdk-3.so.0', 'libglib-2.0.so.0'))
    p = C.c_void_p
    if not bind(gtk, 'gtk_init_check', C.c_int, p, p)(None, None):
        raise RuntimeError('display unavailable')
    atom = bind(gdk, 'gdk_atom_intern_static_string', p, C.c_char_p)
    set_data = bind(gtk, 'gtk_selection_data_set', None, p, p, C.c_int, p, C.c_int)
    flush = bind(gdk, 'gdk_flush', None)
    main = bind(gtk, 'gtk_main', None)
    quit_main = bind(gtk, 'gtk_main_quit', None)
    stop_type = C.CFUNCTYPE(C.c_int, p)
    timeout = bind(glib, 'g_timeout_add', C.c_uint, C.c_uint, stop_type, p)
    class Target(C.Structure):
        _fields_ = [('target', C.c_char_p), ('flags', C.c_uint), ('info', C.c_uint)]
    provide_type = C.CFUNCTYPE(None, p, p, C.c_uint, p)
    clear_type = C.CFUNCTYPE(None, p, p)
    if expected_context is not None:
        if len(paths) != 1 or image_context() != expected_context:
            raise ValueError('Место приёма изображения изменилось. Вставьте заново')
        with open(paths[0], 'rb') as image:
            data = image.read(20 * 1024 * 1024 + 1)
        if len(data) > 20 * 1024 * 1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Недействительное изображение PNG')
        names, payloads = [b'image/png'], [data]
    else:
        names = [b'text/uri-list', b'x-special/gnome-copied-files']
        uris = [Path(path).as_uri() for path in paths]
        payloads = [('\r\n'.join(uris) + '\r\n').encode(), ('copy\n' + '\n'.join(uris)).encode()]
    buffers = [C.create_string_buffer(data) for data in payloads]
    acknowledged = False
    @stop_type
    def stop(_):
        quit_main()
        return 0
    @provide_type
    def provide(_clipboard, selection, info, _data):
        nonlocal acknowledged
        set_data(selection, atom(names[info]), 8, buffers[info], len(payloads[info]))
        flush()
        if not acknowledged:
            print('ok', flush=True)
            acknowledged = True
    @clear_type
    def clear(_clipboard, _data):
        timeout(10000, stop, None)
    targets = (Target * len(names))(*(Target(name, 0, index) for index, name in enumerate(names)))
    get = bind(gtk, 'gtk_clipboard_get', p, p)
    own = bind(gtk, 'gtk_clipboard_set_with_data', C.c_int, p, C.POINTER(Target), C.c_uint, provide_type, clear_type, p)
    if not own(get(atom(b'CLIPBOARD')), targets, len(names), provide, clear, None):
        raise RuntimeError('clipboard unavailable')
    flush()
    if expected_context is not None and image_context() != expected_context:
        raise ValueError('Место приёма изображения изменилось. Вставьте заново')
    subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+v'], check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    timeout(120000, stop, None)
    main()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--open':
        import http.client
        import socket
        class Connection(http.client.HTTPConnection):
            def connect(self):
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(self.timeout)
                self.sock.connect('/run/cage-desktop/files.sock')
        client = Connection('localhost', timeout=5)
        try:
            # Electron's folder fallback invokes `xdg-open .` with the target
            # directory as its cwd. Preserve the caller's cwd across the socket.
            path = sys.argv[2]
            if not path.startswith('file:'):
                path = str(Path(path).resolve(strict=True))
            client.request('POST', '/open', json.dumps({'path': path}), {'Content-Type': 'application/json'})
            response = client.getresponse()
            data = response.read()
            if response.status != 200:
                raise ValueError(data.decode())
        finally:
            client.close()
        return
    if len(sys.argv) == 3 and sys.argv[1] == '--save-file':
        # Terminal attachments are independent of the graphical session.
        root = Path.home() / '.local/share/cage/attachments/files'
        broker = Broker(root)
        key = broker.start()['id']
        try:
            def chunks():
                while data := sys.stdin.buffer.read(65536):
                    yield data
            broker.receive(key, sys.argv[2], chunks())
            print(json.dumps({'ok': True, 'path': broker.get(key)['files'][0]}))
        except BaseException:
            broker.cancel(key)
            raise
        return
    if sys.argv[1:] == ['--clipboard']:
        value = json.load(sys.stdin)
        if isinstance(value, dict):
            clipboard(value['paths'], value['image_context'])
        else:
            clipboard(value)
        return
    runtime = Path(os.environ['XDG_RUNTIME_DIR'])
    directory = runtime / 'uploads'
    shutil.rmtree(directory, ignore_errors=True)
    from importlib.machinery import SourceFileLoader
    downloads = SourceFileLoader('cage_desktop_downloads', '/usr/local/lib/cage-desktop-downloads.py').load_module()
    broker = Broker(directory, downloads=downloads.create_downloads())
    portal = Portal(broker)
    broker.deliver = portal.deliver
    socket = runtime / 'files.sock'
    socket.unlink(missing_ok=True)
    server = FileServer(str(socket), Handler)
    os.chmod(socket, 0o600)
    server.broker = broker
    threading.Thread(target=server.serve_forever, daemon=True).start()
    portal.run()


if __name__ == '__main__':
    main()
