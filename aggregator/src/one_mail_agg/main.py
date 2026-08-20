import sys
import time
import logging
import random

from .config import load_config
from .state import SyncState
from .sync import sync_account, default_client_factory
from .oauth import oauth_client_factory

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("one-mail-agg")


def run_once(config_path: str) -> dict:
    config = load_config(config_path)
    state = SyncState(config.state_path)
    results = {}
    for account in config.accounts:
        factory = oauth_client_factory(account) if account.oauth else default_client_factory
        try:
            results[account.id] = sync_account(factory, config, account, state)
            r = results[account.id]
            log.info("synced %s: protocol=%s synced=%d dropped=%d",
                     account.id, r.get("protocol"), r.get("synced", 0), r.get("dropped", 0))
        except Exception as e:
            results[account.id] = {"error": str(e)}
            log.error("sync %s failed: %s", account.id, e)
            # 单账号失败不影响其他；下次运行重试
            time.sleep(min(2 ** 0 + random.random(), 3))
    return results


def main() -> int:
    config_path = sys.argv[1] if len(sys.argv) > 1 else "./config.json"
    run_once(config_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
