#!/usr/bin/env python3
"""卡商 MSA 卡一次性导入探测脚本（one-shot card probe）。

背景（2026-09-11 bmifagjv86138 烧卡事故）
------------------------------------------
MSA/consumers 的 refresh_token 对兑换频率/轮换敏感：同一 RT 被**反复兑换**会触发
吊销（AADSTS70000 invalid_grant），卡即报废。人工手搓 curl/python 验证 scope 是
烧卡的最主要来源——每次「再试一下」都是一次兑换。

本脚本把卡导入收敛为**有且仅有一次**的兑换探测：

1. 解析卡面四段格式 `email----password----client_id----refresh_token`；
2. 检查本地状态文件（默认 `~/.one-mail-msa-cards/<email>.json`）——**已探测过的卡
   直接拒绝再兑换**（除非 `--force`，会二次确认），从缓存输出结论；
3. 仅当首次探测时做一次 token 兑换（不带 scope，取默认授权集），从响应判定通路：
   - `IMAP.AccessAsUser.All` → IMAP/XOAUTH2 通路（`source: imap_outlook` +
     `oauth.provider: msa`）；
   - 仅 Graph `Mail.Read/Mail.ReadWrite` → Graph 通路（`source: graph_outlook` +
     `oauth.provider: graph`）；
   - 两者皆无 → 卡不可用（打印原始 scope）；
4. 响应中的**轮换新 refresh_token 立即持久化**到状态文件，并写进输出的 config
   JSON 块——后续一切配置以状态文件里的最新 RT 为准，卡面原始 RT 作废不再使用；
5. 打开可直接粘贴进 pxed `/opt/one-mail-agg/config.json` 的账号 JSON。

用法
----
    python3 aggregator/scripts/msa_card_probe.py \
        "bmifagjv86138@hotmail.com----ZNqz*53A6c9----<client_id>----<refresh_token>"

    # 输出示例（graph-only 卡）：
    # PATH=graph_outlook
    # {
    #   "id": "bmifagjv86138-hotmail",
    #   "source": "graph_outlook",
    #   ...
    # }

铁律
----
- **兑换次数 = 1**。验证同步是否成功看聚合器日志（`synced ... protocol=...`），
  绝不通过再次兑换 token 来「验证卡还活着」。
- 探测完成后把结论登记进 Obsidian [[one-mail 统一收件箱 账户体系]]。
- 依赖：`requests`（one-mail-agg venv 自带）。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
STATE_DIR = Path.home() / ".one-mail-msa-cards"
SEP = "----"


class CardError(ValueError):
    pass


def parse_card(card: str) -> dict:
    """解析四段卡面；段数不对直接抛错（宁可拒绝导入也不猜）。"""
    parts = card.strip().split(SEP)
    if len(parts) != 4:
        raise CardError(
            f"expect 4 segments joined by '{SEP}' (email----password----client_id----refresh_token), got {len(parts)}")
    email, password, client_id, refresh_token = (p.strip() for p in parts)
    if "@" not in email:
        raise CardError(f"segment 1 does not look like an email: {email!r}")
    if not client_id or not refresh_token:
        raise CardError("client_id / refresh_token segment is empty")
    return {"email": email, "password": password,
            "client_id": client_id, "refresh_token": refresh_token}


def load_state(email: str) -> dict | None:
    path = STATE_DIR / f"{email}.json"
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(email: str, state: dict) -> Path:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = STATE_DIR / f"{email}.json"
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return path


def probe_once(client_id: str, refresh_token: str) -> dict:
    """有且仅有一次的兑换探测：不带 scope，读默认授权集。返回 token 响应全文。"""
    r = requests.post(TOKEN_URL, data={
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, timeout=30)
    data = r.json()
    data["_http_status"] = r.status_code
    return data


def classify(granted_scope: str) -> str:
    s = (granted_scope or "").lower()
    if "imap.accessasuser.all" in s:
        return "imap_outlook"
    if "mail.read" in s:
        return "graph_outlook"
    return "unsupported"


def build_account(card: dict, path: str) -> dict:
    email = card["email"]
    local = email.split("@", 1)[0].lower()
    if path == "imap_outlook":
        return {
            "id": f"{local}-hotmail",
            "source": "imap_outlook",
            "host": "outlook.office365.com",
            "port": 993,
            "username": email,
            "password": card["password"],
            "folders": ["INBOX"],
            "use_ssl": True,
            "protocol": "imap",
            "oauth": {"provider": "msa", "client_id": card["client_id"],
                      "refresh_token": card["refresh_token"]},
        }
    return {
        "id": f"{local}-hotmail",
        "source": "graph_outlook",
        "host": "graph.microsoft.com",
        "port": 443,
        "username": email,
        "password": "",
        "folders": ["INBOX"],
        "use_ssl": True,
        "protocol": "imap",
        "initial_sync_limit": 50,
        "oauth": {"provider": "graph", "tenant": "consumers",
                  "client_id": card["client_id"],
                  "refresh_token": card["refresh_token"]},
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    force = "--force" in argv
    card = parse_card(argv[1])
    email = card["email"]

    state = load_state(email)
    if state and not force:
        print(f"REFUSED: {email} was already probed on {state.get('probed_at')} "
              f"(path={state.get('path')}). Re-redeeming the same card token is how cards get burned.")
        print("Read the cached verdict / rotated refresh_token below instead.")
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 1
    if state and force:
        answer = input(f"WARNING: {email} already probed. Re-redeeming may BURN the card. Type 'burn' to continue: ")
        if answer.strip() != "burn":
            print("aborted")
            return 1

    data = probe_once(card["client_id"], card["refresh_token"])
    if data.get("_http_status") != 200 or "access_token" not in data:
        # 兑换失败：卡面 RT 已不可用（吊销/过期）。**不要重试**——重试只会更快触发风控。
        print(f"PROBE FAILED: HTTP {data.get('_http_status')} {data.get('error')}: "
              f"{(data.get('error_description') or '')[:200]}")
        print("Do NOT retry with the same refresh_token. Get a new card/token from the vendor.")
        return 1

    granted = data.get("scope", "")
    path = classify(granted)
    rotated = data.get("refresh_token")
    if rotated and rotated != card["refresh_token"]:
        # 轮换新 RT 是此后唯一有效的凭据，立即落盘并替换卡面 RT
        card["refresh_token"] = rotated
        print(f"NOTE: refresh_token was rotated by this redemption; "
              f"rotated token persisted to {save_state(email, {'probed_at': data.get('client_info', ''), 'path': path, 'scope': granted, 'refresh_token': rotated, 'client_id': card['client_id'], 'password': card['password']})}")
    else:
        save_state(email, {"probed_at": data.get("client_info", ""), "path": path,
                           "scope": granted, "refresh_token": card["refresh_token"],
                           "client_id": card["client_id"], "password": card["password"]})

    print(f"PATH={path}")
    print(f"SCOPE={granted}")
    if path == "unsupported":
        print("This card grants neither IMAP nor Graph Mail scopes — unusable for one-mail.")
        return 1
    print(json.dumps(build_account(card, path), ensure_ascii=False, indent=2))
    print("\nNext: paste the JSON above into pxed /opt/one-mail-agg/config.json accounts[], "
          "restart one-mail-agg, then verify via agg-loop.log (synced ... protocol=...). "
          "Never verify by redeeming the token again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
