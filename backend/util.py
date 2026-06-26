"""Shared helpers: package logger + file mtime."""
import os
import logging

log = logging.getLogger("LoraBoxTimur")


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None
