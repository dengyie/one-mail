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
    oauth: dict | None = None   # gmail/outlook 时填 {"provider": "...", "..."}
    protocol: str = "auto"      # imap | pop3 | auto（imap 优先，失败降级 pop3）
    # POP3 降级连接参数：不填则从 host（去掉 imap. 前缀）推导 + 默认端口
    pop3_host: str = ""
    pop3_port: int = 0
    pop3_ssl: bool | None = None    # None 表示继承 use_ssl
    pop3_use_stls: bool = False

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
