import json
import threading
import time

from one_mail_agg import state as state_mod
from one_mail_agg import token_store
from one_mail_agg.state import SyncState


def test_sync_state_serializes_concurrent_saves(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    state = SyncState(str(path))

    original_dump = state_mod.json.dump
    counter_lock = threading.Lock()
    active = 0
    max_active = 0

    def slow_dump(*args, **kwargs):
        nonlocal active, max_active
        with counter_lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.05)
            return original_dump(*args, **kwargs)
        finally:
            with counter_lock:
                active -= 1

    monkeypatch.setattr(state_mod.json, "dump", slow_dump)
    start = threading.Barrier(3)
    errors = []

    def writer(account_id, uid):
        try:
            start.wait()
            state.add_pop3_seen(account_id, "INBOX", uid)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    t1 = threading.Thread(target=writer, args=("a", "uid-a"))
    t2 = threading.Thread(target=writer, args=("b", "uid-b"))
    t1.start()
    t2.start()
    start.wait()
    t1.join()
    t2.join()

    assert errors == []
    assert max_active == 1
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["pop3_seen"]["a|INBOX"] == ["uid-a"]
    assert saved["pop3_seen"]["b|INBOX"] == ["uid-b"]


def test_static_refresh_token_rewrites_preserve_both_concurrent_updates(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({
        "worker_base_url": "https://worker",
        "admin_token": "token",
        "accounts": [
            {"id": "a", "oauth": {"provider": "msa", "refresh_token": "OLD-A"}},
            {"id": "b", "oauth": {"provider": "msa", "refresh_token": "OLD-B"}},
        ],
    }), encoding="utf-8")

    # Force an unlocked implementation to keep both stale snapshots alive long
    # enough to deterministically reproduce the lost-update race. With the
    # read-modify-replace lock, the second load cannot start until the first
    # replacement is durable and therefore observes the first account's NEW RT.
    original_load = token_store.json.load

    def slow_load(fp, *args, **kwargs):
        value = original_load(fp, *args, **kwargs)
        time.sleep(0.05)
        return value

    monkeypatch.setattr(token_store.json, "load", slow_load)
    start = threading.Barrier(3)
    results = []

    def rotate(account_id, value):
        start.wait()
        results.append(token_store.rewrite_config_refresh_token(str(path), account_id, value))

    t1 = threading.Thread(target=rotate, args=("a", "NEW-A"))
    t2 = threading.Thread(target=rotate, args=("b", "NEW-B"))
    t1.start()
    t2.start()
    start.wait()
    t1.join()
    t2.join()

    assert len(results) == 2 and all(results)
    saved = json.loads(path.read_text(encoding="utf-8"))
    by_id = {row["id"]: row for row in saved["accounts"]}
    assert by_id["a"]["oauth"]["refresh_token"] == "NEW-A"
    assert by_id["b"]["oauth"]["refresh_token"] == "NEW-B"
