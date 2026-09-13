import one_mail_agg.idle_worker as idle_mod
import one_mail_agg.main as main_mod
from one_mail_agg.config import AccountConfig, Config


def _oauth_account() -> AccountConfig:
    return AccountConfig(
        id="oauth-1",
        source="imap_gmail",
        host="imap.gmail.com",
        port=993,
        username="u@gmail.com",
        password="",
        folders=["INBOX"],
        oauth={
            "provider": "gmail",
            "client_id": "cid",
            "client_secret": "secret",
            "refresh_token": "rt",
        },
    )


def test_run_once_passes_config_to_oauth_factory(tmp_path, monkeypatch):
    account = _oauth_account()
    config = Config(
        worker_base_url="https://worker.example",
        admin_token="admin",
        accounts=[account],
        state_path=str(tmp_path / "state.json"),
        config_path=str(tmp_path / "config.json"),
    )
    monkeypatch.setattr(main_mod, "load_config", lambda _path: config)
    monkeypatch.setattr(main_mod, "fetch_user_accounts", lambda *a: [])

    captured = []

    def _oauth_factory(acc, cfg):
        captured.append((acc.id, cfg))
        return lambda _acc: object()

    monkeypatch.setattr(main_mod, "oauth_client_factory", _oauth_factory)
    monkeypatch.setattr(
        main_mod,
        "sync_account",
        lambda factory, cfg, acc, state: {"synced": 0, "dropped": 0, "protocol": "imap"},
    )

    result = main_mod.run_once("ignored.json")
    assert result["oauth-1"]["protocol"] == "imap"
    assert captured == [("oauth-1", config)]


def test_idle_resolver_passes_config_to_oauth_factory(monkeypatch):
    account = _oauth_account()
    config = Config(worker_base_url="https://worker.example", admin_token="admin", accounts=[])
    captured = []
    sentinel = object()

    def _oauth_factory(acc, cfg):
        captured.append((acc.id, cfg))
        return sentinel

    monkeypatch.setattr(idle_mod, "oauth_client_factory", _oauth_factory)
    assert idle_mod._resolve_client_factory(account, config) is sentinel
    assert captured == [("oauth-1", config)]
