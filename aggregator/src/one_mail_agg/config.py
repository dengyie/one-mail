import json
from dataclasses import dataclass, field


_VALID_PROTOCOLS = {"imap", "pop3", "auto"}


@dataclass
class AccountConfig:
    id: str
    source: str           # imap_gmail | imap_outlook | graph_outlook | imap_qq | imap_163
    host: str
    port: int
    username: str
    password: str         # app-password，或 OAuth2 时的 refresh_token 引用键
    folders: list[str] = field(default_factory=lambda: ["INBOX"])
    use_ssl: bool = True
    oauth: dict | None = None   # gmail/outlook 时填 {"provider": "...", "..."}
    protocol: str = "auto"      # imap | pop3 | auto（imap 优先，失败降级 pop3）
    # POP3 降级连接参数：不填则从 host（去掉 imap. 前缀）推导 + 默认端口
    pop3_host: str = ""
    pop3_port: int = 0
    pop3_ssl: bool | None = None    # None 表示继承 use_ssl
    pop3_use_stls: bool = False
    initial_sync_limit: int = 50  # 首次同步时最多拉取最新 N 封（0 为不限/全量）
    user_managed: bool = False    # True = 用户自助账号（user_mail_accounts），RT 轮换回写 Worker

    def __post_init__(self):
        # Keep protocol semantics identical for local config and Worker payloads.
        if not isinstance(self.protocol, str):
            raise ValueError("protocol must be one of: imap, pop3, auto")
        self.protocol = self.protocol.strip().lower()
        if self.protocol not in _VALID_PROTOCOLS:
            raise ValueError(f"unsupported protocol: {self.protocol!r}")
        for name in ("use_ssl", "pop3_use_stls"):
            if not isinstance(getattr(self, name), bool):
                raise ValueError(f"{name} must be a boolean")
        if self.pop3_ssl is not None and not isinstance(self.pop3_ssl, bool):
            raise ValueError("pop3_ssl must be a boolean or null")
        # STLS starts plaintext and upgrades it; it cannot be combined with
        # POP3S, including the inherited use_ssl=True default.
        if self.pop3_use_stls and self.resolve_pop3_use_ssl():
            raise ValueError("pop3_ssl/use_ssl and pop3_use_stls are contradictory")

    def resolve_pop3_host(self) -> str:
        """POP3 主机推导：host 以 imap. 开头换成 pop.，否则原样。"""
        if self.pop3_host:
            return self.pop3_host
        if self.host.startswith("imap."):
            return "pop." + self.host[len("imap."):]
        return self.host

    def resolve_pop3_port(self) -> int:
        if self.pop3_port:
            return self.pop3_port
        return 995 if self.resolve_pop3_use_ssl() else 110

    def resolve_pop3_use_ssl(self) -> bool:
        if self.pop3_ssl is not None:
            return self.pop3_ssl
        return self.use_ssl


@dataclass
class Config:
    worker_base_url: str
    admin_token: str
    accounts: list[AccountConfig]
    state_path: str = "./sync_state.json"
    config_path: str | None = None   # load_config 回填，供 refresh_token 轮换写回


def load_config(path: str) -> Config:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    accounts = [AccountConfig(**a) for a in raw["accounts"]]
    return Config(
        worker_base_url=raw["worker_base_url"].rstrip("/"),
        admin_token=raw["admin_token"],
        accounts=accounts,
        state_path=raw.get("state_path", "./sync_state.json"),
        config_path=path,
    )
