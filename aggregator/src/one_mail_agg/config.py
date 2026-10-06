import json
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class WorkerDestination:
    id: str
    base_url: str
    token: str = field(repr=False)
    api_prefix: str = "/shard"

    def api_url(self, path: str) -> str:
        return f"{self.base_url}{self.api_prefix}{path}"

    def headers(self) -> dict[str, str]:
        if self.api_prefix == "/admin/unified":
            return {"x-admin-auth": self.token}
        return {"Authorization": f"Bearer {self.token}"}


@dataclass(frozen=True)
class ShardConfig:
    id: str
    base_url: str
    token: str = field(repr=False)
    accounts: list[str] | tuple[str, ...]

    def __post_init__(self):
        if not isinstance(self.id, str) or not self.id.strip() or self.id.strip() == "primary":
            raise ValueError("shard id must be non-empty and cannot be primary")
        if not isinstance(self.base_url, str):
            raise ValueError("shard base_url must be an HTTPS origin")
        base_url = self.base_url.strip().rstrip("/")
        try:
            url = urlsplit(base_url)
            valid = (url.scheme == "https" and url.hostname and url.port != 0
                     and url.username is None and url.password is None
                     and not url.path and "?" not in base_url and "#" not in base_url
                     and not any(c.isspace() or ord(c) < 32 for c in base_url)
                     and "\\" not in base_url)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("shard base_url must be an HTTPS origin without credentials, path, query or fragment")
        if (not isinstance(self.token, str) or len(self.token) < 32
                or any(c.isspace() or ord(c) < 32 for c in self.token)):
            raise ValueError("shard token must contain at least 32 characters without whitespace")
        if not isinstance(self.accounts, (list, tuple)):
            raise ValueError("shard accounts must be an array of non-empty account IDs")
        accounts = []
        seen_accounts = set()
        for account_id in self.accounts:
            if not isinstance(account_id, str) or not account_id.strip():
                raise ValueError("shard accounts must be an array of non-empty account IDs")
            account_id = account_id.strip()
            if account_id in seen_accounts:
                raise ValueError("duplicate account assignment in shard")
            seen_accounts.add(account_id)
            accounts.append(account_id)
        object.__setattr__(self, "id", self.id.strip())
        object.__setattr__(self, "base_url", base_url)
        object.__setattr__(self, "accounts", tuple(accounts))


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
    poll_interval: int | None = None  # 独立增量轮询间隔（秒）；若未配置则按协议使用安全默认值（POP3 600s / IMAP 300s）
    # 外部账号发信（见 docs/send-mail-external-accounts.md §4.3）
    can_send: bool = False        # 凭据从「可读」升级为「可发」的显式开关，默认关闭
    smtp_host: str = ""           # 发信 SMTP 主机（空则按 source 推导默认值）
    smtp_port: int = 0            # 发信 SMTP 端口（0 = 按 source 推导默认值）

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
        if self.poll_interval is not None:
            if not isinstance(self.poll_interval, int) or isinstance(self.poll_interval, bool) or self.poll_interval <= 0:
                raise ValueError("poll_interval must be a positive integer or null")
        if not isinstance(self.can_send, bool):
            raise ValueError("can_send must be a boolean")
        if not isinstance(self.smtp_host, str):
            raise ValueError("smtp_host must be a string")
        if not isinstance(self.smtp_port, int) or isinstance(self.smtp_port, bool) or self.smtp_port < 0 or self.smtp_port > 65535:
            raise ValueError("smtp_port must be an integer between 0 and 65535")
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
    shards: list[ShardConfig] = field(default_factory=list)
    _primary: WorkerDestination = field(init=False, repr=False)
    _destinations: tuple[WorkerDestination, ...] = field(init=False, repr=False)
    _account_destinations: dict[str, WorkerDestination] = field(init=False, repr=False)

    def __post_init__(self):
        if not isinstance(self.shards, list):
            raise ValueError("shards must be an array")
        self._primary = WorkerDestination(
            "primary", self.worker_base_url.rstrip("/"), self.admin_token, "/admin/unified")
        destinations = [self._primary]
        account_destinations = {}
        ids = {"primary"}
        urls = {self._primary.base_url.lower()}
        validated = []
        for shard in self.shards:
            if isinstance(shard, dict):
                try:
                    shard = ShardConfig(**shard)
                except TypeError as error:
                    raise ValueError("each shard requires only id, base_url, token and accounts") from error
            if not isinstance(shard, ShardConfig):
                raise ValueError("each shard must be an object")
            if shard.id in ids:
                raise ValueError("duplicate shard id")
            if shard.base_url.lower() in urls:
                raise ValueError("duplicate shard base_url or primary destination")
            ids.add(shard.id)
            urls.add(shard.base_url.lower())
            destination = WorkerDestination(shard.id, shard.base_url, shard.token)
            destinations.append(destination)
            for account_id in shard.accounts:
                if account_id in account_destinations:
                    raise ValueError("account assigned to multiple shards")
                account_destinations[account_id] = destination
            validated.append(shard)
        self.shards = validated
        self._destinations = tuple(destinations)
        self._account_destinations = account_destinations

    @property
    def destinations(self) -> tuple[WorkerDestination, ...]:
        return self._destinations

    def destination_for(self, row: dict) -> WorkerDestination:
        # Email Routing belongs to the primary regardless of any account mapping.
        if row.get("source") == "cf_routing":
            return self._primary
        return self._account_destinations.get(row.get("account_id"), self._primary)


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
        shards=raw.get("shards", []),
    )
