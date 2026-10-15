#!/usr/bin/env bash
# Gate PLAN T-004.
exec python3 "$(dirname "$0")/check-erd.py"
