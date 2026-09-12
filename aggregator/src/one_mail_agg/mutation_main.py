import logging
import sys

from .config import load_config
from .egress_guard import install_egress_guard
from .mutation_jobs import process_mutation_jobs

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("one-mail-agg")


def main() -> int:
    install_egress_guard()
    config_path = sys.argv[1] if len(sys.argv) > 1 else "./config.json"
    config = load_config(config_path)
    result = process_mutation_jobs(config)
    if result.get("claimed", 0):
        log.info(
            "mutation batch claimed=%d succeeded=%d retried=%d failed=%d unsupported=%d",
            result.get("claimed", 0),
            result.get("succeeded", 0),
            result.get("retried", 0),
            result.get("failed", 0),
            result.get("unsupported", 0),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
