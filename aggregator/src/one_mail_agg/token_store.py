"""refresh_token 轮换持久化（单一事实来源）。

根因背景（2026-09-11 烧卡事故）：MSA/consumers 的 refresh_token 兑换时会轮换
（响应携带新 RT，旧 RT 随后失效）。任何通路丢弃新 RT = 下轮兑换 400、账号永久失联。

本模块是所有通路（graph / msa / gmail / outlook）轮换 RT 的唯一落点：

- 静态 config.json 账号：原子写回本地配置文件（os.replace）；
- 用户自助账号（user_mail_accounts，D1 存储）：POST 回写 Worker
  `/admin/unified/mail_accounts/:id/refresh_token`（x-admin-auth，Worker 用
  MAIL_CRED_ENCRYPTION_KEY 重加密后落 D1）。

轮换 RT 一旦出现，持久化就是 OAuth refresh 的一部分：写回失败必须抛错，避免
当前进程继续假装成功、重启后却只剩已经失效的旧 refresh_token。
"""
import contextlib
import json
import logging
import os
import threading

import requests

from .config import Config

log = logging.getLogger("one-mail-agg")


class TokenPersistenceError(RuntimeError):
    """A rotated refresh token could not be durably persisted."""


# 多个 IDLE worker 可能同时刷新不同静态 OAuth 账号。config.json 是一个共享的
# read-modify-write 文档；若不把「读取最新文件 → 修改一个账号 → fsync/replace」
# 整段串行化，后写线程会用自己的旧快照覆盖先写线程的新 refresh_token。
_CONFIG_REWRITE_LOCK = threading.RLock()

# 进程内所有 OAuth/Graph refresh_token 兑换的排他锁（idle / poll / mutation 共用）。
# MSA/Gmail refresh_token 每次兑换都轮换：两个线程并发为同一账号兑换时，后完成的
# 响应带的是与先完成轮换结果冲突的旧 RT，两者之一即刻失效——这正是 2026-09-11
# 烧卡事故的并发版本。锁住「兑换 + 用新 RT 建连」整段（锁内完成，嵌套安全）。
_REDEMPTION_LOCK = threading.RLock()


@contextlib.contextmanager
def redemption_lock():
    """进程内所有 OAuth/Graph token 兑换的排他锁（嵌套安全，RLock）。

    用法：
        with redemption_lock():
            access = token_fn(acc.oauth, on_rotated)
            client = factory(acc)
    """
    with _REDEMPTION_LOCK:
        yield


def refresh_rt_from_config(config: Config | None, account) -> None:
    """锁内把 account 的 refresh_token 刷成 config.json 里的最新值。

    静态账号的轮换结果只落在 config.json；调用方手里的 Config 快照可能已被 IDLE
    线程的轮换甩在后面。拿旧 RT 去兑换就是 400 + 账号失效，所以兑换前必须回读。
    用户自助账号的 RT 存 Worker/D1（每轮 fetch_user_accounts 已是最新），跳过。
    """
    config_path = getattr(config, "config_path", None)
    if not config_path or getattr(account, "user_managed", False):
        return
    if not isinstance(getattr(account, "oauth", None), dict):
        return
    try:
        with open(config_path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return
    for acc in raw.get("accounts", []):
        if acc.get("id") == account.id and isinstance(acc.get("oauth"), dict):
            latest = acc["oauth"].get("refresh_token")
            if latest:
                account.oauth["refresh_token"] = latest
            return


def rewrite_config_refresh_token(config_path: str, account_id: str, new_refresh_token: str) -> bool:
    """把轮换后的 refresh_token 原子写回静态 config.json。返回是否写成功。

    临时文件与最终文件都强制 0600。整个 read-modify-replace 在进程级锁内完成，
    保证多个 OAuth 账号同时轮换时不会发生 lost update。
    """
    with _CONFIG_REWRITE_LOCK:
        tmp_path = f"{config_path}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            # 必须在锁内重新读取最新文件，不能使用调用方早先加载的 Config 快照。
            with open(config_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            for acc in raw.get("accounts", []):
                if acc.get("id") == account_id and isinstance(acc.get("oauth"), dict):
                    acc["oauth"]["refresh_token"] = new_refresh_token
                    break
            else:
                log.warning("persist refresh_token: account %s not found in %s", account_id, config_path)
                return False

            fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(raw, f, ensure_ascii=False, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, config_path)
            os.chmod(config_path, 0o600)
            log.info("rotated refresh_token persisted to config for account %s", account_id)
            return True
        except Exception as e:
            log.error("persist refresh_token to config failed for account %s: %r", account_id, e)
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass
            return False


def report_refresh_token_to_worker(worker_base_url: str, admin_token: str,
                                   account_id: str, new_refresh_token: str) -> bool:
    """把轮换后的 refresh_token 回写 Worker（重加密落 D1）。返回是否成功。"""
    url = f"{worker_base_url}/admin/unified/mail_accounts/{account_id}/refresh_token"
    headers = {"x-admin-auth": admin_token}
    try:
        r = requests.post(url, json={"refresh_token": new_refresh_token},
                          headers=headers, timeout=10)
        if r.status_code == 404:
            log.info("refresh_token write-back skipped, account %s gone from Worker", account_id)
            return False
        if r.status_code != 200:
            log.warning("refresh_token write-back for %s failed: HTTP %s %s",
                        account_id, r.status_code, r.text[:200])
            return False
        log.info("rotated refresh_token written back to Worker for account %s", account_id)
        return True
    except Exception as e:
        log.warning("refresh_token write-back for %s error: %s", account_id, e)
        return False


def persist_rotated_refresh_token(config: Config, account, new_refresh_token: str) -> None:
    """按账号归属选择持久化通道；失败时抛 TokenPersistenceError。"""
    if not new_refresh_token:
        return

    if getattr(account, "user_managed", False):
        ok = report_refresh_token_to_worker(
            config.worker_base_url,
            config.admin_token,
            account.id,
            new_refresh_token,
        )
        if not ok:
            raise TokenPersistenceError(
                f"failed to persist rotated refresh_token for user account {account.id}")
        return

    config_path = getattr(config, "config_path", None)
    if not config_path:
        raise TokenPersistenceError(
            f"rotated refresh_token for static account {account.id} has no config_path")
    if not rewrite_config_refresh_token(config_path, account.id, new_refresh_token):
        raise TokenPersistenceError(
            f"failed to persist rotated refresh_token for static account {account.id}")


def make_rotated_callback(config: Config | None, account):
    """给 token 函数用的 on_rotated 回调；config 为 None 时返回 None。"""
    if config is None:
        return None

    def _on_rotated(new_refresh_token: str) -> None:
        persist_rotated_refresh_token(config, account, new_refresh_token)
    return _on_rotated
