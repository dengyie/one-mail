"""refresh_token 轮换持久化（单一事实来源）。

根因背景（2026-09-11 烧卡事故）：MSA/consumers 的 refresh_token 兑换时会轮换
（响应携带新 RT，旧 RT 随后失效）。任何通路丢弃新 RT = 下轮兑换 400、账号永久失联。

本模块是所有通路（graph / msa / gmail / outlook）轮换 RT 的唯一落点：

- 静态 config.json 账号：原子写回本地配置文件（os.replace）；
- 用户自助账号（user_mail_accounts，D1 存储）：POST 回写 Worker
  `/admin/unified/mail_accounts/:id/refresh_token`（x-admin-auth，Worker 用
  MAIL_CRED_ENCRYPTION_KEY 重加密后落 D1）。

写回失败只告警不抛错：本轮同步照常，但账号已进入「RT 倒计时」，需人工介入。
"""
import json
import logging
import os

import requests

from .config import Config

log = logging.getLogger("one-mail-agg")


def rewrite_config_refresh_token(config_path: str, account_id: str, new_refresh_token: str) -> bool:
    """把轮换后的 refresh_token 原子写回静态 config.json。返回是否写成功。"""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        for acc in raw.get("accounts", []):
            if acc.get("id") == account_id and isinstance(acc.get("oauth"), dict):
                acc["oauth"]["refresh_token"] = new_refresh_token
                break
        else:
            log.warning("persist refresh_token: account %s not found in %s", account_id, config_path)
            return False
        tmp_path = f"{config_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, config_path)
        log.info("rotated refresh_token persisted to config for account %s", account_id)
        return True
    except Exception as e:
        log.error("persist refresh_token to config failed for account %s: %r", account_id, e)
        return False


def report_refresh_token_to_worker(worker_base_url: str, admin_token: str,
                                   account_id: str, new_refresh_token: str) -> bool:
    """把轮换后的 refresh_token 回写 Worker（重加密落 D1）。返回是否成功。

    404 视为「账号已被删除」，静默放弃；其余非 2xx 仅告警。
    """
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
    """按账号归属选择持久化通道。绝 不抛错（见模块 docstring）。"""
    if not new_refresh_token:
        return
    try:
        if getattr(account, "user_managed", False):
            report_refresh_token_to_worker(config.worker_base_url, config.admin_token,
                                           account.id, new_refresh_token)
        else:
            config_path = getattr(config, "config_path", None)
            if config_path:
                rewrite_config_refresh_token(config_path, account.id, new_refresh_token)
            else:
                log.warning("rotated refresh_token for %s has nowhere to persist "
                            "(no config_path, static account)", account.id)
    except Exception as e:
        log.error("persist_rotated_refresh_token failed for %s: %r", account.id, e)


def make_rotated_callback(config: Config | None, account):
    """给 token 函数用的 on_rotated 回调；config 为 None 时返回 None（不持久化）。"""
    if config is None:
        return None

    def _on_rotated(new_refresh_token: str) -> None:
        persist_rotated_refresh_token(config, account, new_refresh_token)
    return _on_rotated
