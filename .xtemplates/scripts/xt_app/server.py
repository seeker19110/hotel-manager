"""Máy chủ HTTP loopback của `xt.py app` — mô hình bảo mật ADR-0038 §2, hợp đồng `docs/specs/SPEC-app.md` §2.

Bind cứng 127.0.0.1; token mỗi lần chạy cho `/api/*`; kiểm `Host`/`Origin` chống DNS rebinding; file tĩnh tra theo bảng
lập lúc khởi động (không ghép đường từ URL, không theo symlink); header bảo mật cố định trên mọi response.
"""

from __future__ import annotations

import hmac
import importlib
import json
import os
import pkgutil
import secrets
import socketserver
import stat
import sys
import traceback
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Tuple, cast
from urllib.parse import parse_qs, urlsplit

MAX_BODY = 65536
JSON_TYPE = "application/json; charset=utf-8"
STATIC_METHODS: Tuple[str, ...] = ("GET", "HEAD")

CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
PERMISSIONS_POLICY = (
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), "
    "hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), "
    "screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()"
)
SECURITY_HEADERS: Tuple[Tuple[str, str], ...] = (
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", PERMISSIONS_POLICY),
    ("X-Frame-Options", "DENY"),
)
CONTENT_TYPES: Dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}


@dataclass(frozen=True)
class Ctx:
    """Ngữ cảnh một request gửi cho route handler (SPEC-app §2.4)."""

    xt: Any
    base: Path
    framework: Path
    query: Dict[str, List[str]]
    body: Optional[Dict[str, Any]]


Handler = Callable[[Ctx], Tuple[int, Dict[str, Any]]]
Routes = Dict[Tuple[str, str], Handler]
Reply = Tuple[int, Dict[str, Any]]


def _err(message: str) -> Dict[str, Any]:
    return {"error": message}


def _read_version(ctx: Ctx) -> Optional[str]:
    for cand in (ctx.framework.parent / "VERSION", ctx.base / ".xtemplates" / "VERSION"):
        if cand.is_file():
            return cand.read_text(encoding="utf-8").strip()
    return None


def _health(ctx: Ctx) -> Reply:
    return 200, {"ok": True, "version": _read_version(ctx), "project": ctx.base.name}


ROUTES: Routes = {("GET", "/api/health"): _health}


def _merge(into: Routes, extra: Any, origin: str) -> None:
    for key, handler in dict(extra).items():
        if key in into:
            raise ValueError(f"route trùng {key[0]} {key[1]} (module {origin})")
        into[key] = handler


def load_routes(package: str = "xt_app") -> Routes:
    """Gộp `ROUTES` của `server` và mọi module `<package>.api_*`; khoá trùng → `ValueError` nêu khoá."""
    pkg = importlib.import_module(package)
    merged: Routes = dict(ROUTES)
    names = sorted(m.name for m in pkgutil.iter_modules(getattr(pkg, "__path__", [])) if m.name.startswith("api_"))
    for name in names:
        mod = importlib.import_module(f"{package}.{name}")
        _merge(merged, getattr(mod, "ROUTES", None) or {}, name)
    return merged


def load_smoke(package: str = "xt_app") -> Dict[str, str]:
    """Query mẫu cho `xt.py app --smoke`: gộp `SMOKE` (path → query) của mọi module `<package>.api_*` — route có tham số
    bắt buộc khai ở đây để smoke gọi đúng đường chính thay vì nhận 400 (SPEC-app §2.4)."""
    pkg = importlib.import_module(package)
    out: Dict[str, str] = {}
    for m in pkgutil.iter_modules(getattr(pkg, "__path__", [])):
        if m.name.startswith("api_"):
            out.update(getattr(importlib.import_module(f"{package}.{m.name}"), "SMOKE", None) or {})
    return out


def _read_regular(path: str) -> Optional[bytes]:
    """Đọc file thường, không theo symlink (O_NOFOLLOW nơi có); không phải file thường → None."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return None
    with os.fdopen(fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
            return None
        return fh.read()


def static_table(root: Path) -> Dict[str, Tuple[bytes, str]]:
    """Bảng file tĩnh `/<rel posix>` → (nội dung, content-type), lập một lần; bỏ symlink, file lạ, đuôi lạ."""
    table: Dict[str, Tuple[bytes, str]] = {}
    if root.is_symlink() or not root.is_dir():
        return table
    for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
        for fname in sorted(filenames):
            full = os.path.join(dirpath, fname)
            ctype = CONTENT_TYPES.get(os.path.splitext(fname)[1].lower())
            if ctype is None or os.path.islink(full):
                continue
            data = _read_regular(full)
            if data is not None:
                table["/" + Path(full).relative_to(root).as_posix()] = (data, ctype)
    if "/index.html" in table:
        table["/"] = table["/index.html"]
    return table


def _split(raw: str) -> Tuple[str, str]:
    """(path, query) thô của request-target dạng origin-form; dạng khác hoặc hỏng → ("", "") (không có trong bảng)."""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return "", ""
    if parts.scheme or parts.netloc:
        return "", ""
    return parts.path, parts.query


def _printable(text: str) -> str:
    return "".join(ch if ch.isprintable() else "?" for ch in text)


def _allow_table(static: Dict[str, Tuple[bytes, str]], routes: Routes) -> Dict[str, Tuple[str, ...]]:
    allow: Dict[str, Tuple[str, ...]] = {path: STATIC_METHODS for path in static}
    by_path: Dict[str, set[str]] = {}
    for method, path in routes:
        by_path.setdefault(path, set()).add(method)
    for path, methods in by_path.items():
        if "GET" in methods:
            methods.add("HEAD")
        allow[path] = tuple(sorted(methods))
    return allow


class AppServer(ThreadingHTTPServer):
    """`ThreadingHTTPServer` bind 127.0.0.1 mang cấu hình app (không biến toàn cục)."""

    daemon_threads = True
    quiet = False
    request_timeout = 30.0
    smoke: Dict[str, str] = {}

    def __init__(
        self,
        port: int,
        *,
        xt: Any,
        base: Path,
        framework: Path,
        static: Dict[str, Tuple[bytes, str]],
        routes: Routes,
        token: str,
    ) -> None:
        self.xt = xt
        self.base = base
        self.framework = framework
        self.static = static
        self.routes = routes
        self.route_paths: FrozenSet[str] = frozenset(path for _method, path in routes)
        self.allow = _allow_table(static, routes)
        self.token = token
        super().__init__(("127.0.0.1", port), _RequestHandler)
        real_port = int(self.socket.getsockname()[1])
        self.allowed_hosts: FrozenSet[str] = frozenset({f"127.0.0.1:{real_port}", f"localhost:{real_port}"})
        self.allowed_origins: FrozenSet[str] = frozenset("http://" + host for host in self.allowed_hosts)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Client đóng kết nối giữa chừng (tab đóng, smoke `Connection: close`) không phải lỗi máy chủ — không in traceback.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)

    def server_bind(self) -> None:
        # HTTPServer.server_bind gọi getfqdn (tra DNS ngược, có thể chậm) — không cần cho loopback.
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = int(self.socket.getsockname()[1])


class _RequestHandler(BaseHTTPRequestHandler):
    server_version = "xt-app"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    # Request hỏng/HTTP/0.9 mặc định trả không header (3.11) — ép 1.0 để header bảo mật có trên mọi response.
    default_request_version = "HTTP/1.0"
    _body_read = False
    _api = False

    @property
    def _app(self) -> AppServer:
        return cast(AppServer, self.server)

    def version_string(self) -> str:
        return self.server_version

    def parse_request(self) -> bool:
        raw: bytes = getattr(self, "raw_requestline", b"")  # không có trong typeshed
        if len(raw.split()) == 2:
            # HTTP/0.9 (`GET /` không phiên bản): 3.13 trả `headers = {}` (dict), không có header nào — từ chối.
            self.command, self.request_version = "", self.default_request_version
            self.send_error(HTTPStatus.BAD_REQUEST)
            return False
        return super().parse_request()

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self._app.request_timeout)

    # --- ghi response -------------------------------------------------------------------------------------------
    def _unread_body(self) -> bool:
        has_body = self.headers.get("Content-Length") is not None or self.headers.get("Transfer-Encoding") is not None
        return has_body and not self._body_read

    def _send(self, status: int, data: bytes, ctype: str, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        if self._api:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        if self.close_connection or self._unread_body():
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_json(self, status: int, payload: Dict[str, Any], extra: Optional[Dict[str, str]] = None) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), JSON_TYPE, extra)

    def send_error(self, code: int, message: Optional[str] = None, explain: Optional[str] = None) -> None:
        if code == HTTPStatus.NOT_IMPLEMENTED:
            # Method lạ (không có do_X): đi đúng thứ tự kiểm SPEC §2.2 → 421/403/404/405.
            self._dispatch()
            return
        self.close_connection = True
        self._send_json(code, _err("yêu cầu không hợp lệ"))

    # --- kiểm theo thứ tự SPEC §2.2 ------------------------------------------------------------------------------
    def _check_host(self) -> Optional[Reply]:
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1 or hosts[0] not in self._app.allowed_hosts:
            return 421, _err("Host không hợp lệ")
        return None

    def _check_origin(self) -> Optional[Reply]:
        origins = self.headers.get_all("Origin")
        if origins is not None and (len(origins) != 1 or origins[0] not in self._app.allowed_origins):
            return 403, _err("Origin không được phép")
        return None

    def _check_token(self) -> Optional[Reply]:
        got = self.headers.get_all("X-XT-Token") or []
        if len(got) == 1 and hmac.compare_digest(got[0].encode("utf-8"), self._app.token.encode("utf-8")):
            return None
        return 401, _err("thiếu hoặc sai token")

    def _content_length(self) -> Optional[int]:
        if self.headers.get("Transfer-Encoding") is not None:
            return None
        values = self.headers.get_all("Content-Length") or []
        if len(values) != 1:
            return None
        value = values[0].strip()
        if not (value.isascii() and value.isdigit()) or int(value) > MAX_BODY:
            return None
        return int(value)

    def _read_post(self) -> Tuple[Optional[Reply], Optional[Dict[str, Any]]]:
        ctype = self.headers.get("Content-Type", "")
        if ctype.split(";", 1)[0].strip().lower() != "application/json":
            return (415, _err("Content-Type phải là application/json")), None
        length = self._content_length()
        if length is None:
            return (413, _err(f"thân phải có Content-Length và không quá {MAX_BODY} byte")), None
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site != "same-origin":
            return (403, _err("request ghi phải từ chính app")), None
        raw = self.rfile.read(length)
        self._body_read = True
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, RecursionError):
            body = None
        if not isinstance(body, dict):
            return (400, _err("thân phải là JSON object UTF-8")), None
        return None, body

    # --- điều phối --------------------------------------------------------------------------------------------------
    def _dispatch(self) -> None:
        self._body_read = False
        path, query = _split(self.path)
        self._api = path.startswith("/api/") or path in self._app.route_paths
        err = self._check_host() or self._check_origin()
        if err is not None:
            self._send_json(*err)
            return
        allowed = self._app.allow.get(path)
        if allowed is None:
            self._send_json(404, _err("không tìm thấy"))
        elif self.command not in allowed:
            self._send_json(405, _err("method không được phép"), {"Allow": ", ".join(allowed)})
        elif path in self._app.route_paths:
            self._serve_route(path, query)
        else:
            data, ctype = self._app.static[path]
            self._send(200, data, ctype)

    def _serve_route(self, path: str, query: str) -> None:
        body: Optional[Dict[str, Any]] = None
        err = self._check_token()
        if err is None and self.command == "POST":
            err, body = self._read_post()
        if err is not None:
            self._send_json(*err)
            return
        method = "GET" if self.command == "HEAD" else self.command
        app = self._app
        ctx = Ctx(app.xt, app.base, app.framework, parse_qs(query, keep_blank_values=True), body)
        try:
            status, payload = app.routes[(method, path)](ctx)
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        except Exception:
            traceback.print_exc(file=sys.stderr)
            status, data = 500, json.dumps(_err("lỗi máy chủ"), ensure_ascii=False).encode("utf-8")
        self._send(status, data, JSON_TYPE)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = _dispatch

    # --- log: `method path status`, không query/fragment, không header ---------------------------------------------
    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        path = _printable(_split(str(getattr(self, "path", "")))[0])
        self.log_message("%s %s %s", self.command or "-", path, code)

    def log_message(self, format: str, *args: Any) -> None:
        if not self._app.quiet:
            sys.stderr.write("xt-app: " + (format % args) + "\n")


def make_server(
    xt: Any,
    base: Path,
    framework: Path,
    static_root: Path,
    port: int = 0,
    token: Optional[str] = None,
    routes: Optional[Routes] = None,
) -> Tuple[AppServer, str]:
    """Tạo máy chủ (chưa chạy) bind 127.0.0.1:`port`; trả (server, token). `routes=None` → `load_routes()`."""
    if token is None:
        token = secrets.token_urlsafe(32)
    if not token:
        raise ValueError("token rỗng")
    table = static_table(static_root)
    table_routes = load_routes() if routes is None else dict(routes)
    server = AppServer(port, xt=xt, base=base, framework=framework, static=table, routes=table_routes, token=token)
    server.smoke = load_smoke() if routes is None else {}
    return server, token
