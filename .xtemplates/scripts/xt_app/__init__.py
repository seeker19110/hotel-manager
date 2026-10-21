"""Ứng dụng web cục bộ của `xt.py app` (ADR-0038): `server` (HTTP, bảo mật, định tuyến) + mỗi màn một `api_<màn>`.

Gói chỉ được nạp lười khi chạy `xt.py app`; không import gì ở đây để các lệnh khác không tốn thời gian khởi động.
"""
