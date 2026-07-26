import os
import sys
import logging
from datetime import datetime, timezone

class UTCFormatter(logging.Formatter):
    """Custom logging formatter producing ISO 8601 UTC timestamps with Z suffix."""
    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created, tz=timezone.utc)
        if datefmt:
            return dt.strftime(datefmt)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

def get_logger(service_name: str) -> logging.Logger:
    """
    Configures and returns a structured logger for the specified service.
    Log level is controlled via the LOG_LEVEL environment variable (default: INFO).
    """
    log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_str, logging.INFO)

    logger = logging.getLogger(service_name)
    logger.setLevel(log_level)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(log_level)
        formatter = UTCFormatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    logger.propagate = False
    return logger
