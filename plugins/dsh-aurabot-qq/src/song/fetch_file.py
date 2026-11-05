"""下载一个文件：断点续传、走系统代理（Windows 上 urllib 会读系统代理设置）、卡住或太慢就换下一个地址接着下。

用法：python fetch_file.py [--sha256 <校验值>] <保存路径> <地址1> [地址2 ...]
成功退出码 0；每次进度打印一行 "progress <已下载> <总大小>"。
给了 --sha256 就在下完后核对，对不上（镜像传了坏文件）就删掉、换下一个地址从头下。
"""
import hashlib
import os
import socket
import sys
import time
import urllib.request

STALL = 30  # 秒：这么久没收到数据就算卡住
ROUNDS = 6  # 所有地址轮流试几轮
SLOW_BPS = 150 * 1024  # 低于这个速度……
SLOW_SECS = 45  # ……持续这么久，就换下一个地址（已下载的部分保留）


class TooSlow(Exception):
    pass


def total_size(opener, url):
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'aurabot'})
    with opener.open(req, timeout=STALL) as r:
        return int(r.headers.get('Content-Length') or 0)


def fetch(opener, url, part, want, can_switch):
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if want and have >= want:
        return True
    headers = {'User-Agent': 'aurabot'}
    if have:
        headers['Range'] = 'bytes=%d-' % have
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=STALL) as r:
        # 服务器不支持续传就从头来
        mode = 'ab' if have and r.status == 206 else 'wb'
        if mode == 'wb':
            have = 0
        last_print = 0
        window_start, window_bytes = time.time(), 0
        with open(part, mode) as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                have += len(chunk)
                window_bytes += len(chunk)
                now = time.time()
                if now - last_print > 2:
                    print('progress', have, want, flush=True)
                    last_print = now
                # 一段时间内平均速度太慢：还有别的地址可试就换
                if now - window_start >= SLOW_SECS:
                    if can_switch and window_bytes / (now - window_start) < SLOW_BPS:
                        raise TooSlow('%.0f KB/s' % (window_bytes / (now - window_start) / 1024))
                    window_start, window_bytes = now, 0
    return not want or have >= want


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 22), b''):
            h.update(block)
    return h.hexdigest()


def main():
    args = sys.argv[1:]
    expect = ''
    if args[:1] == ['--sha256']:
        expect, args = args[1].lower(), args[2:]
    dest, urls = args[0], args[1:]
    socket.setdefaulttimeout(STALL)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))
    part = dest + '.download'
    os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)
    want = 0
    last_err = None
    for rnd in range(ROUNDS):
        for url in urls:
            try:
                if not want:
                    want = total_size(opener, url)
                # 最后一轮不再嫌慢，慢也下完
                if fetch(opener, url, part, want, can_switch=len(urls) > 1 and rnd < ROUNDS - 1):
                    if expect:
                        got = sha256_of(part)
                        if got != expect:
                            os.remove(part)
                            raise ValueError('校验对不上（%s…），这个源的文件不对' % got[:12])
                    if os.path.exists(dest):
                        os.remove(dest)
                    os.replace(part, dest)
                    print('done', os.path.getsize(dest), flush=True)
                    return 0
            except Exception as e:  # 断了、卡住、太慢、地址不行：换下一个地址，已下载的部分保留
                last_err = e
                print('retry', url.split('/')[2], type(e).__name__, str(e)[:120], flush=True)
    print('failed', last_err, flush=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
