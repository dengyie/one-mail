import json
from dataclasses import dataclass, field


@dataclass
class AccountConfig:
    id: str
    source: str           # imap_gmail | imap_outlook | imap_qq | imap_163
    host: str
    port: int
    username: str
    password: str         # app-password，或 OAuth2 时的 refresh_token 引用键
    folders: list[str] = field(default_factory=lambda: ["INBOX"])
    use_ssl: bool = True
    oauth: dict | None = None   # gmail/outlook 时填 {"provider": "...", ...}


@dataclass
class Config:
    worker_base_url: str
    admin_token: str
    accounts: list[AccountConfig]
    state_path: str = "./sync_state.json"


def load_config(path: str) -> Config:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    accounts = [AccountConfig(**a) for a in raw["accounts"]]
    return Config(
        worker_base_url=raw["worker_base_url"].rstrip("/"),
        admin_token=raw["admin_token"],
        accounts=accounts,
        state_path=raw.get("state_path", "./sync_state.json"),
    )
