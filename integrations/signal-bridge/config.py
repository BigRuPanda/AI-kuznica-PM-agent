import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.c_void_p)]


def crypt(data, decrypt=False):
    if os.name != 'nt':
        raise ValueError('Для этой ОС задайте ключи через переменные окружения.')
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.c_void_p))
    target = Blob()
    function = (ctypes.windll.crypt32.CryptUnprotectData if decrypt
                else ctypes.windll.crypt32.CryptProtectData)
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ValueError('Windows не смогла открыть или сохранить локальный ключ.')
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.c_void_p(target.data))


ROOT = Path(__file__).resolve().parent
STATE = Path(os.getenv('SIGNAL_BRIDGE_STATE') or ROOT / '.local')


def saved():
    path = STATE / ('access.dpapi' if os.name=='nt' else 'access.json')
    if not path.exists():
        return {}
    if os.name!='nt':
        if path.stat().st_mode & 0o077:
            raise ValueError('Требуются права 0600 для access.json.')
        return json.loads(path.read_bytes())
    return json.loads(crypt(base64.b64decode(path.read_bytes()), True))


def setting(key, default=''):
    return os.environ.get(key) or saved().get(key, default)


def save(values):
    settings = saved()
    settings.update(values)
    STATE.mkdir(mode=0o700,exist_ok=True, parents=True)
    data = json.dumps(settings).encode()
    with tempfile.NamedTemporaryFile(dir=STATE, delete=False) as stream:
        stream.write(base64.b64encode(crypt(data)) if os.name=='nt' else data)
    os.replace(stream.name, STATE / ('access.dpapi' if os.name=='nt' else 'access.json'))
